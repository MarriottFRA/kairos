/**
 * Budget-import DDL for the plaintext local store (local_db.ts migration v7).
 *
 * Two tables hold budget data pulled from a hotel's Excel "BGT Spread File":
 *   - budget_imports  — the current pull per hotel (provenance + who/when + the
 *                       three year-buckets). A new pull overwrites the last for
 *                       that OU, so there is at most one live row per hotel.
 *   - budget_values   — the monthly figures in tidy/long form, one row per
 *                       (import, combo, bucket, month). Long form keeps later
 *                       KPI aggregation ("SUM revenue accounts for year X") a
 *                       plain GROUP BY rather than 36 hard-coded columns.
 *
 * This is non-PII budget reference data, so it lives in the unencrypted store
 * alongside the calendar and mapping tables — no sign-in gating. Kept free of
 * Electron imports so tests can exec it in-memory.
 */

export const BUDGET_IMPORT_SQL = `
  -- One row per Excel pull. The three buckets are self-describing (type + year)
  -- because the source file rotates them each cycle (this year's BUDGET becomes
  -- next year's ACT/FCST, etc.), so we never infer years — we store what the
  -- workbook's Setup Fields header declared.
  CREATE TABLE IF NOT EXISTS budget_imports (
      id              TEXT PRIMARY KEY,
      ou              TEXT NOT NULL,
      source_filename TEXT NOT NULL,
      hotel_name      TEXT,
      bu              TEXT,
      currency        TEXT,
      as_of_period    TEXT,
      bucket1_type    TEXT,
      bucket1_year    INTEGER,
      bucket2_type    TEXT,
      bucket2_year    INTEGER,
      bucket3_type    TEXT,
      bucket3_year    INTEGER,
      imported_at     TEXT NOT NULL,
      imported_by     TEXT,
      row_count       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_budget_imports_ou
      ON budget_imports (ou);

  -- Monthly values, tidy/long. bucket_index is 1..3 (1 = the file's first block,
  -- typically BUDGET); period is 1..12 (Jan..Dec of that bucket's year). value
  -- is stored as-read (zeros included) so the wide grid and KPI sums both have a
  -- complete grid without back-filling.
  CREATE TABLE IF NOT EXISTS budget_values (
      import_id    TEXT NOT NULL,
      ou           TEXT NOT NULL,
      dept         TEXT NOT NULL,
      account      TEXT NOT NULL,
      combo        TEXT NOT NULL,
      bucket_index INTEGER NOT NULL CHECK (bucket_index BETWEEN 1 AND 3),
      bucket_type  TEXT,
      year         INTEGER,
      period       INTEGER NOT NULL CHECK (period BETWEEN 1 AND 12),
      value        REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (import_id) REFERENCES budget_imports (id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_budget_values_import
      ON budget_values (import_id, account);
  CREATE INDEX IF NOT EXISTS idx_budget_values_import_year
      ON budget_values (import_id, year, period);
`;
