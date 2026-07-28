/**
 * Automatic soft-delete sweep.
 *
 * The manual button in Settings only helps someone who presses it, so this runs
 * the same purge unattended: once a day at most, taking only rows deleted longer
 * ago than the retention window (30 days by default — the window the removed-
 * column sweep has always used). Everything inside the window is left alone, so
 * undo, "Recently removed" columns and block restore keep working exactly as
 * before; the sweep only claims what nobody was going to bring back.
 *
 * Triggered from authController the moment the encrypted store unlocks, because
 * that is the earliest point both databases are readable. Deliberately deferred
 * off the sign-in path and entirely best-effort: a failure here costs disk
 * space, never a session.
 *
 * Config lives in `user_settings` (plaintext store) alongside the app's other
 * preferences, so it survives a secure-store rebuild.
 */

import { getUserSettings, localDbHandle, setUserSettings } from "../../local_db";
import { isSecureDatabaseUnlocked, secureDb } from "../../secure_db";
import {
  AUTO_CLEANUP_CHOICES,
  AutoCleanupConfig,
  CleanupTally,
  DEFAULT_AUTO_CLEANUP_CONFIG,
  DEFAULT_AUTO_CLEANUP_DAYS,
  cleanupTotal,
} from "../../shared/maintenance/ipc";
import { purgeSoftDeleted, vacuumStores } from "./cleanupRepo";

const RETENTION_KEY = "maintenanceAutoCleanupDays";
const LAST_RUN_KEY = "maintenanceAutoCleanupLastRunAt";
const LAST_REMOVED_KEY = "maintenanceAutoCleanupLastRemoved";

/** Don't re-sweep on every unlock — an app restarted ten times a day sweeps once. */
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long after unlock the sweep fires. Long enough to stay off the critical
 *  path of sign-in, short enough that a brief session still gets swept. */
const START_DELAY_MS = 20_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** In-process guard: one sweep per launch, even if several unlocks happen. */
let scheduled = false;

function coerceRetention(value: unknown): number {
  const days = Math.trunc(Number(value));
  return AUTO_CLEANUP_CHOICES.includes(days) ? days : DEFAULT_AUTO_CLEANUP_DAYS;
}

export async function readAutoCleanupConfig(): Promise<AutoCleanupConfig> {
  try {
    const settings = JSON.parse(await getUserSettings()) as Record<string, unknown>;
    const lastRunAt = settings[LAST_RUN_KEY];
    return {
      retentionDays: coerceRetention(settings[RETENTION_KEY]),
      lastRunAt: typeof lastRunAt === "string" ? lastRunAt : null,
      lastRunRemoved: Math.max(0, Math.trunc(Number(settings[LAST_REMOVED_KEY])) || 0),
    };
  } catch (error) {
    console.warn("[Maintenance] Could not read auto-cleanup settings:", error);
    return { ...DEFAULT_AUTO_CLEANUP_CONFIG };
  }
}

/** Persist a new retention window (validated against the offered choices). */
export async function setAutoCleanupRetention(
  value: unknown
): Promise<AutoCleanupConfig> {
  const retentionDays = coerceRetention(value);
  await setUserSettings({ [RETENTION_KEY]: retentionDays });
  return { ...(await readAutoCleanupConfig()), retentionDays };
}

/** The cutoff a sweep would use right now, or null when it is switched off. */
export function retentionCutoff(retentionDays: number): string | null {
  if (retentionDays <= 0) return null;
  return new Date(Date.now() - retentionDays * DAY_MS).toISOString();
}

/**
 * Run the sweep if it is due. Returns what it removed, or null when it was
 * skipped (switched off, ran recently, or the encrypted store is locked).
 * `force` ignores the once-a-day throttle but still honours the window.
 */
export async function runAutoCleanup(
  opts: { force?: boolean } = {}
): Promise<CleanupTally | null> {
  const config = await readAutoCleanupConfig();
  const cutoff = retentionCutoff(config.retentionDays);
  if (!cutoff) return null;

  if (!opts.force && config.lastRunAt) {
    const since = Date.now() - Date.parse(config.lastRunAt);
    // A NaN (corrupt stamp) falls through and sweeps — better than never again.
    if (since >= 0 && since < MIN_INTERVAL_MS) return null;
  }

  if (!isSecureDatabaseUnlocked()) return null;

  const local = localDbHandle();
  const secure = secureDb();
  const tally = purgeSoftDeleted(local, secure, { olderThan: cutoff });
  const removed = cleanupTotal(tally);

  // Stamp first: a VACUUM failure must not make the sweep run again tomorrow
  // thinking it never happened.
  await setUserSettings({
    [LAST_RUN_KEY]: new Date().toISOString(),
    [LAST_REMOVED_KEY]: removed,
  });

  if (removed > 0) {
    try {
      vacuumStores(local, secure);
    } catch (error) {
      console.error("[Maintenance] VACUUM after the automatic sweep failed:", error);
    }
    console.info(
      `[Maintenance] Automatic cleanup removed ${removed} row(s) deleted before ${cutoff}`
    );
  }

  return tally;
}

/**
 * Queue the sweep shortly after unlock. Fire-and-forget by design — call it from
 * the unlock path and never await it.
 */
export function scheduleAutoCleanup(): void {
  if (scheduled) return;
  scheduled = true;
  const timer = setTimeout(() => {
    void runAutoCleanup().catch((error) => {
      console.error("[Maintenance] Automatic cleanup failed:", error);
    });
  }, START_DELAY_MS);
  // Never hold the process open for a cleanup.
  timer.unref?.();
}
