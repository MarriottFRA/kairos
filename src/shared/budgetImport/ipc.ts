/**
 * Budget import — shared types + IPC channel names.
 *
 * The renderer drives a one-shot "pull": pick a hotel's Excel BGT Spread File;
 * main parses it, OU-gates it, and (on a match) writes it straight to the
 * plaintext local store — overwriting the hotel's previous data — then returns
 * the stored rows. There is no separate preview/commit step: reading the file
 * is the expensive part, so we persist in the same pass.
 */

/** Number of month periods per bucket (Jan..Dec). */
export const PERIODS_PER_BUCKET = 12;
/** Number of year-buckets a spread file carries (BUDGET / ACT-FCST / ACTUAL). */
export const BUCKET_COUNT = 3;
/** Flattened cell count on a wide row: 3 buckets × 12 months. */
export const WIDE_CELL_COUNT = BUCKET_COUNT * PERIODS_PER_BUCKET;

/** One year-bucket as declared by the workbook's Setup Fields header. */
export interface BucketMeta {
  /** 1-based position in the file (1 = first/left block, typically BUDGET). */
  index: number;
  /** Type label as-read, e.g. "BUDGET", "ACT/FCST", "ACTUAL". */
  type: string;
  /** Four-digit year the block covers, or null if the header was unreadable. */
  year: number | null;
}

/**
 * Human name for a bucket ("BUDGET 2026"), or null when the bucket is unknown
 * (no import yet) or its header was unreadable. Callers format the "Bucket N"
 * prefix themselves so the same lookup serves both a select label and a chip.
 */
export function bucketName(
  buckets: BucketMeta[],
  index: number
): string | null {
  const b = buckets.find((x) => x.index === index);
  if (!b) return null;
  const parts = [b.type?.trim() || "", b.year ? String(b.year) : ""].filter(
    Boolean
  );
  return parts.length ? parts.join(" ") : null;
}

/** File-level metadata pulled from the Setup Fields sheet. */
export interface ImportMeta {
  /** OU as the file declares it (Setup Fields D5), canonicalized to "OU"+5. */
  ou: string;
  sourceFileName: string;
  hotelName: string | null;
  bu: string | null;
  currency: string | null;
  asOfPeriod: string | null;
}

/** A combo row pivoted wide for grid display. cells is length WIDE_CELL_COUNT. */
export interface WideBudgetRow {
  /** Stable row id for the grid (the combo). */
  id: string;
  combo: string;
  dept: string;
  account: string;
  description: string | null;
  /** [b1m1..b1m12, b2m1..b2m12, b3m1..b3m12]; missing months read as 0. */
  cells: number[];
}

/** pull outcomes. Only "ok" carries the stored data. */
export type PullResult =
  | { outcome: "cancelled" }
  | { outcome: "no_data"; sourceFileName: string }
  | { outcome: "ou_mismatch"; fileOu: string; selectedOu: string; sourceFileName: string }
  | { outcome: "ok"; result: ImportRowsResult };

/** The current import's metadata for a hotel (no values). */
export interface ImportSummary {
  id: string;
  ou: string;
  sourceFileName: string;
  hotelName: string | null;
  bu: string | null;
  currency: string | null;
  asOfPeriod: string | null;
  buckets: BucketMeta[];
  rowCount: number;
  /** When this pull was committed (ISO). */
  importedAt: string;
  /** Who committed it (signed-in user), or null if unknown. */
  importedBy: string | null;
}

/** getCurrent response: the stored import's metadata + its wide rows. */
export interface ImportRowsResult {
  summary: ImportSummary;
  rows: WideBudgetRow[];
}

export const BUDGET_IMPORT_CHANNELS = {
  /** Open a file dialog, parse + OU-gate, persist (overwrite), return the data. */
  pull: "budgetImport:pull",
  /** The current stored import (metadata + rows) for the selected OU, or null. */
  getCurrent: "budgetImport:getCurrent",
} as const;
