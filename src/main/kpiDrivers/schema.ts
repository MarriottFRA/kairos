/**
 * KPI-driver DDL for the plaintext local store (local_db.ts migration v9).
 *
 * A KPI driver is a named, reusable value aggregated from the pulled budget
 * (budget_values) that cost-component blocks multiply against a per-position
 * multiplier. Four tables:
 *   - kpi_drivers               — one row per user-defined driver (built-ins are
 *                                 code-defined, not stored; see builtins.ts).
 *   - kpi_driver_dept_patterns  — EXPLICIT mode: 0..N GLOB dept patterns
 *                                 ("D0010", "D00??", "D0*", "*" = all depts).
 *                                 POSITION mode carries none (the department is
 *                                 the position's own, resolved at engine load).
 *   - kpi_driver_accounts       — 1..N account prefixes (account is always
 *                                 explicit — positions carry no account).
 *   - kpi_driver_values         — precalc cache. ONE table for both modes:
 *                                   EXPLICIT -> one dept_key = '*' (12 rows).
 *                                   POSITION -> one dept_key per department
 *                                               present in budget_values.
 *
 * This is non-PII budget-derived reference data, so it lives in the unencrypted
 * store alongside budget_values and the calendar — no sign-in gating. Kept free
 * of Electron imports so tests can exec it in-memory.
 */

export const KPI_DRIVERS_SQL = `
  -- One row per user-defined driver, scoped to a hotel (OU). Built-in drivers
  -- are defined in code and UNIONed at read time, so they never appear here.
  CREATE TABLE IF NOT EXISTS kpi_drivers (
      id           TEXT PRIMARY KEY,
      ou           TEXT NOT NULL,
      label        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      dept_mode    TEXT NOT NULL CHECK (dept_mode IN ('EXPLICIT','POSITION')),
      bucket_index INTEGER NOT NULL DEFAULT 1 CHECK (bucket_index BETWEEN 1 AND 3),
      aggregation  TEXT NOT NULL DEFAULT 'SUM' CHECK (aggregation IN ('SUM')),
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_by   TEXT,
      updated_at   TEXT NOT NULL,
      deleted_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_kpi_drivers_ou ON kpi_drivers (ou);

  -- EXPLICIT mode only: the department GLOB patterns to match. "*" matches all
  -- departments; a bare code ("D0010") is a pattern with no wildcards; "D00??"
  -- matches any two trailing chars. POSITION mode carries zero rows here.
  CREATE TABLE IF NOT EXISTS kpi_driver_dept_patterns (
      driver_id TEXT NOT NULL,
      pattern   TEXT NOT NULL,
      FOREIGN KEY (driver_id) REFERENCES kpi_drivers (id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_kpi_dept_patterns ON kpi_driver_dept_patterns (driver_id);

  -- Always present (account is always explicit): the account prefixes to match.
  -- Matched as (starts_with || '*') via GLOB, mirroring AccountFilter.startsWith.
  CREATE TABLE IF NOT EXISTS kpi_driver_accounts (
      driver_id   TEXT NOT NULL,
      starts_with TEXT NOT NULL,
      FOREIGN KEY (driver_id) REFERENCES kpi_drivers (id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_kpi_accounts ON kpi_driver_accounts (driver_id);

  -- Precalc cache — the resolved 12-month series per driver per OU. dept_key is
  -- '*' for EXPLICIT (one series) or the department code for POSITION (one
  -- series per department present in budget_values). No FK on driver_id: built-in
  -- drivers have no parent row but still cache values here under a stable id.
  -- source_import_id / computed_at drive staleness against budget_imports.
  CREATE TABLE IF NOT EXISTS kpi_driver_values (
      driver_id        TEXT NOT NULL,
      ou               TEXT NOT NULL,
      dept_key         TEXT NOT NULL,
      period           INTEGER NOT NULL CHECK (period BETWEEN 1 AND 12),
      value            REAL NOT NULL DEFAULT 0,
      source_import_id TEXT,
      computed_at      TEXT NOT NULL,
      PRIMARY KEY (driver_id, ou, dept_key, period)
  );
  CREATE INDEX IF NOT EXISTS idx_kpi_values_lookup ON kpi_driver_values (ou, driver_id, dept_key);
`;
