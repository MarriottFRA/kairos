/**
 * Remembered file paths, per hotel.
 * -----------------------------------------------------------
 * Both Excel round-trips — the BST Pull and the BST Push — point at the SAME
 * workbook every time: one file, usually several folders deep on a shared
 * drive, re-opened month after month. Walking the file dialog to it on every
 * visit is pure repetition, not a decision, so each page offers back the file
 * it last accepted for the selected hotel.
 *
 * The rule that makes this safe is the same on both pages: a remembered path
 * is a shortcut to the DIALOG, never a shortcut past a check. An offered file
 * is read, gated and handled exactly like one picked by hand, and a path is
 * recorded only AFTER those gates pass — so what is offered is always
 * something that was genuinely accepted for the hotel it is tagged with.
 *
 * Kept in this shared module rather than beside either feature because the two
 * differ in one detail only (the push also matches the budget year) and a
 * second copy of "dedupe, order, cap, prune" is a second place to get it wrong.
 */

/** A file this install has opened successfully. */
export interface RecentFile {
  /** Absolute path, as the OS gave it. */
  filePath: string;
  /** Basename, so the renderer never has to parse a path. */
  fileName: string;
  /** Canonical OU the workbook declared about itself (Setup Fields D5). */
  ou: string;
  /**
   * Budget year the workbook declared, or null when the flow does not care.
   * The push matches on it (a BST for the wrong year would be refused); the
   * pull does not (a spread file carries three year-buckets at once).
   */
  year: number | null;
  /** Epoch ms of the last successful open. */
  usedAt: number;
}

/** How many to keep per store. Small on purpose: a shortcut, not a history. */
export const MAX_RECENT_FILES = 8;

/** Local OU canonicalization — this module stays dependency-free. */
function normalizeRecentOu(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  if (/^OU[A-Z0-9]{5}$/.test(raw)) return raw;
  if (/^[A-Z0-9]{5}$/.test(raw)) return `OU${raw}`;
  return null;
}

/** Last path segment, for either separator — main and renderer both call this. */
export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : filePath;
}

/** Everything before the last separator, or "" when the path has none. */
export function parentPath(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return cut > 0 ? filePath.slice(0, cut) : "";
}

function normalizeRecentFile(raw: unknown): RecentFile | null {
  const entry = (raw ?? {}) as Partial<RecentFile>;
  const filePath =
    typeof entry.filePath === "string" ? entry.filePath.trim() : "";
  const ou = normalizeRecentOu(entry.ou);
  if (!filePath || !ou) return null;
  const year = Math.trunc(Number(entry.year));
  const usedAt = Math.trunc(Number(entry.usedAt));
  return {
    filePath,
    fileName:
      typeof entry.fileName === "string" && entry.fileName.trim()
        ? entry.fileName.trim()
        : baseName(filePath),
    ou,
    year: Number.isFinite(year) && year > 0 ? year : null,
    usedAt: Number.isFinite(usedAt) && usedAt > 0 ? usedAt : 0,
  };
}

/** Clean a persisted list: drop junk, dedupe by path, newest first, cap. */
export function normalizeRecentFiles(raw: unknown): RecentFile[] {
  if (!Array.isArray(raw)) return [];
  const byPath = new Map<string, RecentFile>();
  for (const item of raw) {
    const entry = normalizeRecentFile(item);
    if (!entry) continue;
    const key = entry.filePath.toLowerCase();
    const existing = byPath.get(key);
    if (!existing || entry.usedAt > existing.usedAt) byPath.set(key, entry);
  }
  return [...byPath.values()]
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, MAX_RECENT_FILES);
}

/** The list with `entry` moved to the front, replacing any earlier visit. */
export function rememberRecentFile(
  files: RecentFile[],
  entry: RecentFile
): RecentFile[] {
  return normalizeRecentFiles([entry, ...files]);
}

/** The list without `filePath` — how a moved or deleted file stops being offered. */
export function forgetRecentFile(
  files: RecentFile[],
  filePath: string
): RecentFile[] {
  const key = filePath.trim().toLowerCase();
  return files.filter((file) => file.filePath.toLowerCase() !== key);
}

/**
 * The one file worth offering for this hotel, or null.
 *
 * Pass a `year` where the flow guards on one (the push): the match then
 * requires it, so a file that would be refused on sight is never suggested.
 * Pass null where it does not (the pull), and the newest file for the hotel
 * wins regardless of what year it declared.
 */
export function findRecentFile(
  files: RecentFile[],
  ou: string | null,
  year: number | null = null
): RecentFile | null {
  const wanted = normalizeRecentOu(ou);
  if (!wanted) return null;
  return (
    files.find(
      (file) => file.ou === wanted && (year === null || file.year === year)
    ) ?? null
  );
}

/** Only the files belonging to one hotel — how a store is narrowed per OU. */
export function recentFilesForOu(
  files: RecentFile[],
  ou: string | null
): RecentFile[] {
  const wanted = normalizeRecentOu(ou);
  if (!wanted) return [];
  return files.filter((file) => file.ou === wanted);
}
