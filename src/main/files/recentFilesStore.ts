/**
 * Remembered file paths — the main-side store.
 * -----------------------------------------------------------
 * One implementation of "read, prune, remember, forget" over a `user_settings`
 * key, shared by the BST Pull and the BST Push. See shared/files/recentFiles
 * for what a remembered path is allowed to mean; this module only persists it.
 *
 * Lives in `user_settings` (the plaintext store) alongside the app's other
 * preferences, so it survives a secure-store rebuild and is readable before
 * unlock. A path is not hotel data — it is where THIS machine keeps a
 * workbook — so the store is install-wide, and each entry carries the OU it
 * belongs to. Callers narrow per hotel on the way out.
 *
 * Reads never throw: a corrupt value costs the user their shortcut, never
 * their ability to pick a file.
 */

import * as fs from "fs";
import * as path from "path";

import { getUserSettings, setUserSettings } from "../../local_db";
import {
  RecentFile,
  forgetRecentFile,
  normalizeRecentFiles,
  rememberRecentFile,
} from "../../shared/files/recentFiles";

/**
 * Recents, minus anything no longer on disk.
 *
 * A path that has been moved, renamed or unmounted is not a shortcut, it is a
 * dead end — offering it would spend the user's click on an error. Checked on
 * every read (a handful of stat calls) rather than on a schedule, so the list
 * a page shows is true at the moment it is shown. A stat that throws for any
 * other reason (a network share still waking up) keeps the entry: absent is
 * not the same as unreachable.
 */
function existingOnly(files: RecentFile[]): RecentFile[] {
  return files.filter((file) => {
    try {
      return fs.existsSync(file.filePath);
    } catch {
      return true;
    }
  });
}

/** Everything remembered under `key`, cleaned and pruned. Never throws. */
export async function readRecentFiles(key: string): Promise<RecentFile[]> {
  try {
    const settings = JSON.parse(await getUserSettings()) as Record<
      string,
      unknown
    >;
    return existingOnly(normalizeRecentFiles(settings[key]));
  } catch (error) {
    console.warn(`[recent files] Could not read "${key}":`, error);
    return [];
  }
}

/** Replace the whole list under `key` and return it as it now stands. */
export async function writeRecentFiles(
  key: string,
  files: unknown
): Promise<RecentFile[]> {
  await setUserSettings({ [key]: normalizeRecentFiles(files) });
  return readRecentFiles(key);
}

/**
 * Record a file this install just opened successfully.
 *
 * Call this only AFTER the flow's own gates have passed, so a remembered entry
 * is always one that was genuinely accepted for the hotel — and, where the
 * flow guards on it, the budget year — it is tagged with.
 */
export async function rememberRecentPath(
  key: string,
  entry: { filePath: string; ou: string; year?: number | null }
): Promise<RecentFile[]> {
  const current = await readRecentFiles(key);
  return writeRecentFiles(
    key,
    rememberRecentFile(current, {
      filePath: entry.filePath,
      fileName: path.basename(entry.filePath),
      ou: entry.ou,
      year: entry.year ?? null,
      usedAt: Date.now(),
    })
  );
}

/** Drop a path — how a moved or deleted file stops being offered. */
export async function forgetRecentPath(
  key: string,
  filePath: string
): Promise<RecentFile[]> {
  const current = await readRecentFiles(key);
  return writeRecentFiles(key, forgetRecentFile(current, filePath));
}
