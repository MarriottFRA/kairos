import { app } from "electron";
import path from "path";
import fs from "fs";

// Kairos on-disk locations. Both databases resolve their paths through here, so
// there is exactly one answer to "where does our data live".
//
// Windows uses %LOCALAPPDATA%, NOT Electron's default userData (%APPDATA%,
// i.e. Roaming). This is deliberate and load-bearing: the local key half is
// DPAPI-wrapped to this Windows user *on this machine* (see
// main/security/dbKeyMaterial.ts) and is stored inside kairos.db. If that file
// roams to a second machine — via a roaming profile, Enterprise State Roaming,
// or a synced folder — the new machine cannot unwrap the blob, mints a fresh
// local half, and the replacement KEK can no longer unwrap secureDbKeyWrapped.
// That blob is the only copy of the DB key and by design never changes, so the
// encrypted database becomes permanently unreadable. Machine-bound key material
// must sit on machine-local storage.
//
// The databases previously lived in ~/Documents/Kairos, which is worse again:
// commonly OneDrive-redirected, and a live WAL under a sync client is both a
// corruption risk and a source of conflict copies. migrateLegacyDataDir() below
// relocates any such install on first run.
//
// Everything here stays under the user profile, so installs and upgrades never
// need administrator rights.

/** Per-user, machine-local data directory. Created on first access. */
function resolveDataDir(): string {
  if (process.platform === "win32") {
    // Fall back to appData only if the environment is unexpectedly missing
    // LOCALAPPDATA; Roaming is a poor home for this data but beats crashing.
    const localAppData = process.env.LOCALAPPDATA ?? app.getPath("appData");
    return path.join(localAppData, "Kairos");
  }
  // macOS (~/Library/Application Support/Kairos) and Linux (~/.config/Kairos)
  // have no roaming/local split, so the platform convention is already correct.
  return app.getPath("userData");
}

export const DATA_DIR = resolveDataDir();

/** Unencrypted settings/auth store. */
export const LOCAL_DB_PATH = path.join(DATA_DIR, "kairos.db");

/** Encrypted feature store. */
export const SECURE_DB_PATH = path.join(DATA_DIR, "kairos_secure.db");

/** The three files SQLite maintains per database in WAL mode. */
const DB_SUFFIXES = ["", "-wal", "-shm"] as const;

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Move a pre-existing ~/Documents/Kairos install to DATA_DIR.
 *
 * Safe to call exactly where it is called from — at module load of local_db.ts,
 * before any connection is opened — because SQLite files may only be moved when
 * no process holds them open. A database and its WAL are a single unit: the WAL
 * holds committed transactions not yet checkpointed into the main file, so both
 * are copied together and the pair is left for SQLite to recover on next open.
 * The -shm file is pure derived state and is deliberately not carried over.
 *
 * Originals are renamed aside rather than deleted, so a failed migration can be
 * undone by hand. Anything already present at the destination wins; this never
 * overwrites a live database.
 */
export function migrateLegacyDataDir(): void {
  let legacyDir: string;
  try {
    legacyDir = path.join(app.getPath("documents"), "Kairos");
  } catch {
    return; // no documents folder on this platform/profile — nothing to migrate
  }
  if (legacyDir === DATA_DIR || !fs.existsSync(legacyDir)) return;

  for (const name of ["kairos.db", "kairos_secure.db"]) {
    const from = path.join(legacyDir, name);
    const to = path.join(DATA_DIR, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;

    try {
      ensureDataDir();
      // Copy .db then -wal. Copy-then-rename rather than a move, so an
      // interruption leaves the original intact and the next run retries.
      fs.copyFileSync(from, to);
      if (fs.existsSync(`${from}-wal`)) {
        fs.copyFileSync(`${from}-wal`, `${to}-wal`);
      }

      for (const suffix of DB_SUFFIXES) {
        const original = `${from}${suffix}`;
        if (fs.existsSync(original)) {
          fs.renameSync(original, `${original}.migrated`);
        }
      }
      console.log(`[paths] Migrated ${name} to ${DATA_DIR}`);
    } catch (error) {
      // Roll back the partial destination so the legacy copy stays canonical
      // and the next launch can try again from a clean slate.
      for (const suffix of DB_SUFFIXES) {
        try {
          fs.rmSync(`${to}${suffix}`, { force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
      console.error(`[paths] Failed to migrate ${name}:`, error);
    }
  }
}
