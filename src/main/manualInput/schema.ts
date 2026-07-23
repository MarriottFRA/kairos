/**
 * Manual-input DDL for the encrypted secure store (secure_db.ts migration v6).
 *
 * A manual-input row is a hand-entered cost line that does not come from the
 * budget pull or the payroll engine: a description, a department, a cost account
 * (dollar side) + a stats account (statistical side), an optional rate, and 12
 * months of Stats + Amount. "Stats" are operational units (hours, covers, room
 * nights…). When a rate is set the monthly Amount is derived (stats * rate) in the
 * renderer and `amounts_json` is ignored; with no rate the user types the monthly
 * Amount directly, and `amounts_json` is authoritative.
 *
 * The 12-month vectors are stored as JSON text arrays (length 12, Jan..Dec),
 * mirroring the positions `seasonality` convention. The spread_* / increase_*
 * columns persist the inline "fill 12 months from a base value" helper so it
 * round-trips — a separate Stats base and Amount base; the increase escalates only
 * the Amount side. They drive an explicit Apply action and never live-lock the
 * cells.
 *
 * This is planning data the user chose to keep encrypted-at-rest, so it lives in
 * the secure store alongside positions/PII — reachable only after sign-in unlocks
 * the database. Kept free of Electron imports so tests can exec it in-memory.
 */

export const MANUAL_INPUT_TABLES_SQL = `
  -- One row per hand-entered cost line, scoped to a hotel (OU).
  CREATE TABLE IF NOT EXISTS manual_input_rows (
      id                 TEXT PRIMARY KEY,
      ou                 TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      department         TEXT NOT NULL DEFAULT '',   -- department NAME (like positions)
      department_code    TEXT NOT NULL DEFAULT '',   -- mirror of the picked dept's code
      cost_account       TEXT NOT NULL DEFAULT '',   -- base_account code (dollar side)
      stats_account      TEXT NOT NULL DEFAULT '',   -- base_account code (statistical side)
      rate               REAL,                       -- NULL => amounts typed; set => amounts derived
      stats_json         TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
      amounts_json       TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]', -- authoritative only when rate IS NULL
      spread_mode        TEXT,                       -- NULL | 'flat' | 'daysInMonth'
      spread_base_stats  REAL,                       -- base distributed across the 12 Stats cells
      spread_base_amount REAL,                       -- base distributed across the 12 Amount cells
      increase_pct       REAL NOT NULL DEFAULT 0,    -- e.g. 0.05 for +5%
      increase_month     INTEGER NOT NULL DEFAULT 13 CHECK (increase_month BETWEEN 1 AND 13), -- 13 = none
      sort_order         INTEGER NOT NULL DEFAULT 0,
      created_by         TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      deleted_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_manual_input_rows_ou
    ON manual_input_rows (ou, deleted_at, sort_order);
`;
