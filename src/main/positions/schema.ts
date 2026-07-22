/**
 * Positions feature DDL, shared between the database modules and the tests.
 * -----------------------------------------------------------
 * local_db.ts (migration v3) executes the STRUCTURE tables; secure_db.ts
 * (migration v2) executes the VALUE tables, then applyValueStoreV3 for the
 * lineage/active columns. Tests execute both against in-memory databases —
 * this module must stay free of Electron imports.
 */

import type Database from "better-sqlite3-multiple-ciphers";

/** Plaintext structure store: scenarios, component definitions, SS schemes,
 *  field catalog, hotels cache. */
export const POSITIONS_STRUCTURE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      ou TEXT NOT NULL,
      year INTEGER NOT NULL,
      label TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scenarios_ou ON scenarios (ou, year);

  CREATE TABLE IF NOT EXISTS cost_component_definitions (
      id TEXT PRIMARY KEY,
      ou TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN
        ('BASE_SALARY','HOLIDAY_ACCRUAL','SPREAD','SOCIAL_SECURITY','STAT')),
      spread_method TEXT,
      stat_kind TEXT,
      label TEXT NOT NULL,
      account_code TEXT NOT NULL DEFAULT '',
      department_mode TEXT NOT NULL DEFAULT 'POSITION'
        CHECK (department_mode IN ('POSITION','FIXED')),
      fixed_department TEXT,
      increase_aware INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      base_selector_kind TEXT
        CHECK (base_selector_kind IN ('BASE_SALARY','COMPONENTS')),
      ss_scheme_id TEXT,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ccd_ou ON cost_component_definitions (ou);

  -- BaseSelector{kind:'COMPONENTS'} inclusion list
  CREATE TABLE IF NOT EXISTS component_base_refs (
      component_def_id TEXT NOT NULL
        REFERENCES cost_component_definitions(id) ON DELETE CASCADE,
      referenced_def_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (component_def_id, referenced_def_id)
  );

  CREATE TABLE IF NOT EXISTS ss_schemes (
      id TEXT PRIMARY KEY,
      ou TEXT NOT NULL,
      label TEXT NOT NULL,
      monthly_cap REAL,
      yearly_cap REAL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS ss_brackets (
      scheme_id TEXT NOT NULL REFERENCES ss_schemes(id) ON DELETE CASCADE,
      bracket_index INTEGER NOT NULL,
      up_to REAL,
      rate REAL NOT NULL,
      PRIMARY KEY (scheme_id, bracket_index)
  );

  -- Dynamic column definitions for the Positions grid. System rows are
  -- seeded from src/shared/positions/fieldSeed.ts; user rows have
  -- origin='USER'. See structureRepo.ts for ownership rules.
  CREATE TABLE IF NOT EXISTS field_catalog (
      ou TEXT NOT NULL,
      field_key TEXT NOT NULL,
      section TEXT NOT NULL,
      data_type TEXT NOT NULL,
      storage TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (origin IN ('SYSTEM','USER')),
      locked INTEGER NOT NULL DEFAULT 0,
      default_label TEXT NOT NULL,
      custom_label TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      visible INTEGER NOT NULL DEFAULT 1,
      editable INTEGER NOT NULL DEFAULT 1,
      maskable INTEGER NOT NULL DEFAULT 0,
      vector TEXT,
      month_index INTEGER,
      compute_key TEXT,
      dropdown_source TEXT,
      validation TEXT,
      default_value TEXT,
      seed_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (ou, field_key)
  );

  -- Last-known hotel names per OU, for display labels while offline.
  CREATE TABLE IF NOT EXISTS hotels_cache (
      ou TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload TEXT,
      fetched_at TEXT NOT NULL
  );
`;

/** Encrypted value store: positions, PII sidecar, component values, buyouts. */
export const POSITIONS_VALUE_TABLES_SQL = `
  -- Engine-relevant position values (NO PII — see position_pii). Typed
  -- columns mirror Position (src/shared/engine/types.ts); the flexible
  -- contractual fields live in extra_values JSON, keyed by field catalog.
  CREATE TABLE IF NOT EXISTS positions (
      id                       TEXT PRIMARY KEY,
      ou                       TEXT NOT NULL,
      scenario_id              TEXT NOT NULL,
      -- Stable across years: a scenario clone mints a new id but carries the
      -- lineage forward, so the same role is traceable year over year.
      lineage_id               TEXT NOT NULL DEFAULT '',
      -- 0 = retained but not budgeted. Kept in the grid and rolled forward;
      -- filtered out of ScenarioInput so the engine never sees it.
      active                   INTEGER NOT NULL DEFAULT 1,
      department_code          TEXT NOT NULL DEFAULT '',
      job_type_code            TEXT NOT NULL DEFAULT '',
      cluster                  TEXT NOT NULL DEFAULT '',
      pay_type                 TEXT NOT NULL DEFAULT 'SALARIED'
                                 CHECK (pay_type IN ('HOURLY','SALARIED')),
      headcount                REAL NOT NULL DEFAULT 1,
      fte                      REAL NOT NULL DEFAULT 1,
      seasonality              TEXT NOT NULL DEFAULT '[1,1,1,1,1,1,1,1,1,1,1,1]',
      monthly_base_salary      REAL NOT NULL DEFAULT 0,
      additional_monthly_costs TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
      merit_increase_pct       REAL NOT NULL DEFAULT 0,
      manual_yearly_increase   REAL NOT NULL DEFAULT 0,
      increase_month           INTEGER NOT NULL DEFAULT 13,
      daily_contract_hours     REAL NOT NULL DEFAULT 0,
      yearly_hours_worked      REAL NOT NULL DEFAULT 0,
      vacation_days            REAL NOT NULL DEFAULT 0,
      daily_vacation_cost      REAL NOT NULL DEFAULT 0,
      vacation_monthly_weights TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
      accrual_days_per_month   REAL NOT NULL DEFAULT 0,
      accrual_cost_per_day     REAL NOT NULL DEFAULT 0,
      extra_values             TEXT NOT NULL DEFAULT '{}',
      updated_at               TEXT NOT NULL,
      deleted_at               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_positions_scope ON positions (ou, scenario_id);
  CREATE INDEX IF NOT EXISTS idx_positions_lineage ON positions (ou, lineage_id);

  -- PII sidecar. Never joined into a ScenarioInput; only the dedicated
  -- positions:pii-get channel reads it.
  CREATE TABLE IF NOT EXISTS position_pii (
      position_id  TEXT PRIMARY KEY REFERENCES positions(id) ON DELETE CASCADE,
      ou           TEXT NOT NULL,
      scenario_id  TEXT NOT NULL,
      hiring_date  TEXT,
      emp_number   TEXT,
      last_name    TEXT,
      first_name   TEXT,
      title        TEXT,
      extra_values TEXT NOT NULL DEFAULT '{}',
      updated_at   TEXT NOT NULL,
      deleted_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_position_pii_scope ON position_pii (ou, scenario_id);
  CREATE INDEX IF NOT EXISTS idx_position_pii_emp ON position_pii (ou, emp_number);

  -- Per-position inputs for SPREAD component definitions (the "lego"
  -- blocks: pension, indemnity, stock options, ...). Definitions live in
  -- the plaintext store; no cross-file FK is possible.
  CREATE TABLE IF NOT EXISTS component_values (
      position_id      TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      component_def_id TEXT NOT NULL,
      ou               TEXT NOT NULL,
      scenario_id      TEXT NOT NULL,
      rate             REAL,
      yearly_value     REAL,
      monthly_values   TEXT,
      qty              REAL,
      unit_rate        REAL,
      updated_at       TEXT NOT NULL,
      deleted_at       TEXT,
      PRIMARY KEY (position_id, component_def_id)
  );
  CREATE INDEX IF NOT EXISTS idx_component_values_scope
    ON component_values (ou, scenario_id);

  -- Manual dept x account overrides that bypass the engine.
  CREATE TABLE IF NOT EXISTS buyout_rows (
      id              TEXT PRIMARY KEY,
      ou              TEXT NOT NULL,
      scenario_id     TEXT NOT NULL,
      department_code TEXT NOT NULL DEFAULT '',
      account_code    TEXT NOT NULL DEFAULT '',
      monthly_values  TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_buyout_scope ON buyout_rows (ou, scenario_id);
`;

/**
 * Bring a pre-lineage `positions` table up to the v3 shape.
 *
 * Fresh installs already get both columns from the DDL above, so this is a
 * no-op there. Idempotent by design — the DDL constant is exec'd more than
 * once in places (and ALTER TABLE ADD COLUMN is not `IF NOT EXISTS`), so the
 * column check has to be the guard rather than the caller.
 */
export function applyValueStoreV3(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(positions)")
    .all() as Array<{ name: string }>;
  const present = new Set(columns.map((column) => column.name));
  if (columns.length === 0) return; // table not created yet — nothing to upgrade

  if (!present.has("lineage_id")) {
    handle.exec(
      `ALTER TABLE positions ADD COLUMN lineage_id TEXT NOT NULL DEFAULT ''`
    );
  }
  if (!present.has("active")) {
    handle.exec(
      `ALTER TABLE positions ADD COLUMN active INTEGER NOT NULL DEFAULT 1`
    );
  }

  // Every pre-existing position is its own lineage root.
  handle.exec(`UPDATE positions SET lineage_id = id WHERE lineage_id = ''`);
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_positions_lineage ON positions (ou, lineage_id)`
  );
}
