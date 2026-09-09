/**
 * Persisted BST Push configuration.
 *
 * Two things survive between sessions:
 *
 *   - The CLEAR RULES. Which accounts the clear pass zeroes used to be a
 *     hardcoded predicate, which meant it was also an unexaminable assumption
 *     about which accounts this tool generates. Nobody knows every hotel's
 *     chart, so it is now a rule set the user can see, extend and correct.
 *   - The MONTH PLAN. A hotel pushing month after month repeats almost the same
 *     selection each time; making them rebuild it every visit would be the
 *     single most annoying thing about the page.
 *   - The RECENT FILES. Same reasoning, applied to the workbook itself: the
 *     target is the same file on the same shared drive every time, so the page
 *     offers it back rather than sending the user through the file dialog. A
 *     remembered path skips the DIALOG, never a guard.
 *
 * Lives in `user_settings` (the plaintext store) alongside the app's other
 * preferences, so it survives a secure-store rebuild and is readable before
 * unlock. Install-wide rather than per-OU: the rules describe what this TOOL
 * writes, not what a particular hotel's chart contains.
 *
 * Read defensively and never throws — a corrupt value costs the user their
 * customization, never their ability to push.
 */

import { getUserSettings, setUserSettings } from "../../local_db";
import {
  forgetRecentPath,
  readRecentFiles,
  rememberRecentPath,
  writeRecentFiles,
} from "../files/recentFilesStore";
import {
  BstPushConfig,
  DEFAULT_BST_PUSH_CONFIG,
  GUARD_MODES,
  GuardMode,
  normalizeClearPrefixes,
  normalizeGuardMode,
  normalizeMonthPlan,
} from "../../shared/bstPush/ipc";

const PREFIX_KEY = "bstPushClearPrefixes";
const MONTHS_KEY = "bstPushMonthPlan";
const BACKUP_KEY = "bstPushBackup";
const SKIP_UNUSED_KEY = "bstPushSkipUnusedCombos";
const ALLOCATION_KEY = "bstPushAllocationRows";
const PROTECTED_KEY = "bstPushProtectedCells";
const RECENT_KEY = "bstPushRecentFiles";

export async function readBstPushConfig(): Promise<BstPushConfig> {
  const recentFiles = await readRecentFiles(RECENT_KEY);
  try {
    const settings = JSON.parse(await getUserSettings()) as Record<
      string,
      unknown
    >;
    const backup = settings[BACKUP_KEY];
    const skipUnusedCombos = settings[SKIP_UNUSED_KEY];
    return {
      // An absent key means "never configured", which must land on the
      // defaults; an empty saved list means "the user deleted every rule" and
      // must stay empty, or clearing could never be switched off.
      clearPrefixes:
        settings[PREFIX_KEY] === undefined
          ? [...DEFAULT_BST_PUSH_CONFIG.clearPrefixes]
          : normalizeClearPrefixes(settings[PREFIX_KEY] ?? []),
      months: normalizeMonthPlan(settings[MONTHS_KEY]),
      recentFiles,
      // Absent lands on "skip" — a deliberate behavior change for existing
      // installs: guarding the BST's allocation rows and locked cells is the
      // safe footing, and overwriting them becomes the explicit choice.
      allocationRows: normalizeGuardMode(settings[ALLOCATION_KEY]),
      protectedCells: normalizeGuardMode(settings[PROTECTED_KEY]),
      backup:
        typeof backup === "boolean" ? backup : DEFAULT_BST_PUSH_CONFIG.backup,
      skipUnusedCombos:
        typeof skipUnusedCombos === "boolean"
          ? skipUnusedCombos
          : DEFAULT_BST_PUSH_CONFIG.skipUnusedCombos,
    };
  } catch (error) {
    console.warn("[BST Push] Could not read the saved configuration:", error);
    return {
      clearPrefixes: [...DEFAULT_BST_PUSH_CONFIG.clearPrefixes],
      months: [...DEFAULT_BST_PUSH_CONFIG.months],
      recentFiles,
      allocationRows: DEFAULT_BST_PUSH_CONFIG.allocationRows,
      protectedCells: DEFAULT_BST_PUSH_CONFIG.protectedCells,
      backup: DEFAULT_BST_PUSH_CONFIG.backup,
      skipUnusedCombos: DEFAULT_BST_PUSH_CONFIG.skipUnusedCombos,
    };
  }
}

/**
 * Persist whichever keys the caller supplied and return the whole config as it
 * now stands. A partial patch is the normal case — the rules card saves rules,
 * the month strip saves months, and neither should clobber the other.
 */
export async function writeBstPushConfig(raw: unknown): Promise<BstPushConfig> {
  const patch = (raw ?? {}) as Partial<BstPushConfig>;
  const updates: Record<string, unknown> = {};

  if (patch.clearPrefixes !== undefined) {
    updates[PREFIX_KEY] = normalizeClearPrefixes(patch.clearPrefixes ?? []);
  }
  if (patch.months !== undefined) {
    updates[MONTHS_KEY] = normalizeMonthPlan(patch.months);
  }

  if (GUARD_MODES.includes(patch.allocationRows as GuardMode)) {
    updates[ALLOCATION_KEY] = normalizeGuardMode(patch.allocationRows);
  }
  if (GUARD_MODES.includes(patch.protectedCells as GuardMode)) {
    updates[PROTECTED_KEY] = normalizeGuardMode(patch.protectedCells);
  }
  if (typeof patch.backup === "boolean") {
    updates[BACKUP_KEY] = patch.backup;
  }
  if (typeof patch.skipUnusedCombos === "boolean") {
    updates[SKIP_UNUSED_KEY] = patch.skipUnusedCombos;
  }

  if (patch.recentFiles !== undefined) {
    await writeRecentFiles(RECENT_KEY, patch.recentFiles ?? []);
  }
  if (Object.keys(updates).length > 0) {
    await setUserSettings(updates);
  }
  return readBstPushConfig();
}

/**
 * Record a BST this install just opened successfully, and return the config as
 * it now stands.
 *
 * Called only AFTER the OU and year guards have passed, so a remembered path is
 * always one that was genuinely accepted for the hotel and year it is tagged
 * with — never one the user merely browsed to.
 */
export async function rememberBstPushFile(
  filePath: string,
  ou: string,
  year: number
): Promise<BstPushConfig> {
  await rememberRecentPath(RECENT_KEY, { filePath, ou, year });
  return readBstPushConfig();
}

/** Drop a path from the recents — how a moved file stops being offered. */
export async function forgetBstPushFile(
  filePath: string
): Promise<BstPushConfig> {
  await forgetRecentPath(RECENT_KEY, filePath);
  return readBstPushConfig();
}
