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
      -- When set, this SPREAD def is KPI-driven: spread_method is 'DIRECT_ABS'
      -- and the engine loader folds the KPI's precalculated series (× the
      -- per-position multiplier in component_values.rate) into absolute monthly
      -- values before compile. See src/main/kpiDrivers.
      kpi_driver_id TEXT,
      -- NOTE: block_id, base_ref (v12) and count_exempt (v3) are deliberately
      -- NOT declared here — they are added by their column-guarded helpers,
      -- which the baseline calls too. Declaring one here as well would give a
      -- fresh install a different COLUMN ORDER from an upgraded store, since
      -- ALTER TABLE can only append.
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
      -- CUMULATIVE (default, pre-2c behaviour) | PER_PERIOD (each month alone).
      accumulation_mode TEXT NOT NULL DEFAULT 'CUMULATIVE',
      -- Month (1-12) the tax year starts; the cumulative accumulator resets here.
      -- 1 = January = calendar year (identical to the pre-2c engine).
      tax_year_start_month INTEGER NOT NULL DEFAULT 1,
      -- Contributory base membership (see applySocialSecurityBase). Defaults on,
      -- so an unconfigured base reads as gross base salary (net + vacation).
      include_base_salary INTEGER NOT NULL DEFAULT 1,
      include_vacation INTEGER NOT NULL DEFAULT 1,
      -- JSON array of cost-def ids of the custom blocks in this scheme's base.
      base_component_ids TEXT NOT NULL DEFAULT '[]',
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
      -- Hotel-cluster assignment: the id of a hotel_clusters row in the
      -- PLAINTEXT store ('' = none; no cross-file FK possible — dangling ids
      -- resolve to weight 1 at load). Originally held free-text department
      -- groupings; repurposed in secure v11 (legacy values cleared).
      cluster                  TEXT NOT NULL DEFAULT '',
      -- Manual multiplier, honored only while the assigned cluster has
      -- exactly one member hotel. NULL = use the cluster's member weight.
      cluster_multiplier_override REAL,
      -- Cluster-position group. '' = a standalone row. A non-empty id is shared
      -- by every sibling row of ONE shared person across the cluster's member
      -- hotels (and so spans OUs and each hotel's own scenario). Never
      -- user-editable and never a field-catalog key: it is minted when a row is
      -- first assigned to a cluster and only ever set by clusterSync.ts.
      cluster_link_id          TEXT NOT NULL DEFAULT '',
      pay_type                 TEXT NOT NULL DEFAULT 'SALARIED'
                                 CHECK (pay_type IN ('HOURLY','SALARIED')),
      headcount                REAL NOT NULL DEFAULT 1,
      fte                      REAL NOT NULL DEFAULT 1,
      seasonality              TEXT NOT NULL DEFAULT '[1,1,1,1,1,1,1,1,1,1,1,1]',
      monthly_base_salary      REAL NOT NULL DEFAULT 0,
      -- Alternate, mutually-exclusive basic-salary input: when > 0 the engine
      -- derives the base from rate × hours worked (see engine reference.ts).
      hourly_rate              REAL NOT NULL DEFAULT 0,
      additional_monthly_costs TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
      merit_increase_pct       REAL NOT NULL DEFAULT 0,
      manual_yearly_increase   REAL NOT NULL DEFAULT 0,
      increase_month           INTEGER NOT NULL DEFAULT 13,
      daily_contract_hours     REAL NOT NULL DEFAULT 0,
      yearly_hours_worked      REAL NOT NULL DEFAULT 0,
      vacation_days            REAL NOT NULL DEFAULT 0,
      vacation_monthly_weights TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
      accrual_days_per_month   REAL NOT NULL DEFAULT 0,
      -- The effective cluster ratio and name, as last computed by a machine
      -- that HOLDS the cluster definition (secure v5). Cluster definitions are
      -- plaintext reference data that never sync; these travel with the
      -- position through publish/pull so a machine WITHOUT the definition
      -- still shows the right name and computes the right share instead of
      -- silently falling back to ×1. NULL = never stamped (no cluster, or the
      -- row predates the column). Written by the sync pull and by the publish
      -- collector — never by the grid.
      cluster_weight_snapshot  REAL,
      cluster_name_snapshot    TEXT,
      extra_values             TEXT NOT NULL DEFAULT '{}',
      updated_at               TEXT NOT NULL,
      deleted_at               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_positions_scope ON positions (ou, scenario_id);
  CREATE INDEX IF NOT EXISTS idx_positions_lineage ON positions (ou, lineage_id);
  -- The explicit multi-scope reads (hotel-cluster membership view / clear)
  -- filter on the assignment alone, across OUs.
  CREATE INDEX IF NOT EXISTS idx_positions_cluster ON positions (cluster);
  -- Sibling lookup for cluster-position sync — also cross-OU by design.
  CREATE INDEX IF NOT EXISTS idx_positions_cluster_link
    ON positions (cluster_link_id);

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
      -- SOCIAL_SECURITY blocks only: this position's prior-year NI/SS contribution
      -- base carried into a cumulative, non-January tax year (2c). Per (position,
      -- scheme) since each SS block is its own component def. Seeded by the
      -- opening-balance pre-sim; overrideable. NULL = 0 (the engine default).
      ss_opening_base    REAL,
      -- Per-row account overrides for "unlocked" blocks (NULL = the block's
      -- default account). stats_account_code is the dual-block count line's.
      account_code       TEXT,
      stats_account_code TEXT,
      -- Per-row DEPARTMENT override, MULTIPLIER blocks in PER_ROW mode. NULL =
      -- the block's own answer (the position's department, or the block's fixed
      -- one). A department CODE, matching the engine's dept x account key.
      department_code    TEXT,
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
 * Persisted engine output (encrypted store, secure v10). One run per
 * (ou, scenario) — Recalculate clears and rewrites both tables in a single
 * transaction (the budget-import / KPI-cache overwrite idiom). Lines are the
 * per-(position, component) grain from SimulationResult.positionLines();
 * blank-account lines (calculation-only blocks) are never written. The
 * fingerprint captures every input source so staleness is a cheap compare.
 */
export const ENGINE_OUTPUTS_SQL = `
  CREATE TABLE IF NOT EXISTS engine_runs (
      ou             TEXT NOT NULL,
      scenario_id    TEXT NOT NULL,
      fingerprint    TEXT NOT NULL,
      computed_at    TEXT NOT NULL,
      line_count     INTEGER NOT NULL DEFAULT 0,
      position_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ou, scenario_id)
  );

  -- A line is one (source, source row, component) contribution to a dept x
  -- account. position_id/component_def_id stay the primary key, so the
  -- non-position sources use namespaced synthetic ids to keep it unique:
  --   ENGINE      <positionId>       / <componentDefId>
  --   MANUAL      manual:<rowId>     / manual:cost | manual:stats
  --   ALLOCATION  alloc:<allocId>    / alloc:<deptCode>
  --   BUYOUT      buyout:<rowId>     / buyout
  --   SETUP       setup:defaults     / setup:<settingKey>
  -- detail is the small JSON blob the Results inspector renders (rate, spread
  -- base, description...) so a drill-down needs no second lookup.
  CREATE TABLE IF NOT EXISTS engine_output_lines (
      ou               TEXT NOT NULL,
      scenario_id      TEXT NOT NULL,
      position_id      TEXT NOT NULL,
      component_def_id TEXT NOT NULL,
      label            TEXT NOT NULL DEFAULT '',
      dept             TEXT NOT NULL DEFAULT '',
      account          TEXT NOT NULL DEFAULT '',
      monthly_values   TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
      total            REAL NOT NULL DEFAULT 0,
      source           TEXT NOT NULL DEFAULT 'ENGINE',
      source_ref       TEXT NOT NULL DEFAULT '',
      detail           TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (ou, scenario_id, position_id, component_def_id)
  );
  CREATE INDEX IF NOT EXISTS idx_engine_output_scope
    ON engine_output_lines (ou, scenario_id);
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

/**
 * Add the Hourly Rate alternate basic-salary input column (seed v10).
 *
 * Ships as its own migration rather than an addition to applyValueStoreV3:
 * files that already ran v3 (lineage/active) would never re-run it, so folding
 * the column in there left existing stores without it. New installs get the
 * column straight from POSITIONS_VALUE_TABLES_SQL; this backfills the rest.
 * Idempotent — ALTER TABLE ADD COLUMN is not `IF NOT EXISTS`, so guard on the
 * column check.
 */
export function applyValueStoreV4(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(positions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("hourly_rate")) {
    handle.exec(
      `ALTER TABLE positions ADD COLUMN hourly_rate REAL NOT NULL DEFAULT 0`
    );
  }
}

/**
 * Drop the daily_vacation_cost / accrual_cost_per_day inputs (seed v11).
 *
 * A vacation or accrual day is now valued by the engine at the position's
 * derived per-working-day base pay (see engine reference.ts), so these stored
 * rates are gone. New installs never get the columns (removed from the DDL);
 * this drops them from upgraded stores. Idempotent — guard on the column check,
 * as DROP COLUMN throws when the column is already absent.
 */
export function applyValueStoreV5(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(positions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (present.has("daily_vacation_cost")) {
    handle.exec(`ALTER TABLE positions DROP COLUMN daily_vacation_cost`);
  }
  if (present.has("accrual_cost_per_day")) {
    handle.exec(`ALTER TABLE positions DROP COLUMN accrual_cost_per_day`);
  }
}

/**
 * Per-row account overrides on component_values (blocks feature, secure v9).
 * NULL = the block's configured default; a value = this row's own account
 * ("unlocked" blocks). Fresh installs get both columns from the DDL above;
 * this backfills upgraded stores. Idempotent — guard on the column check.
 */
export function applyValueStoreV9(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(component_values)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("account_code")) {
    handle.exec(`ALTER TABLE component_values ADD COLUMN account_code TEXT`);
  }
  if (!present.has("stats_account_code")) {
    handle.exec(`ALTER TABLE component_values ADD COLUMN stats_account_code TEXT`);
  }
}

/**
 * Per-row department overrides on component_values (secure v4).
 *
 * A MULTIPLIER block can be set to "each row picks", giving the grid a
 * department dropdown for that block; NULL = the block's own answer. Same
 * shape as applyValueStoreV9 above — fresh installs get the column from the
 * DDL, this backfills upgraded stores. Idempotent.
 */
export function applyComponentValueDepartment(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(component_values)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("department_code")) {
    handle.exec(`ALTER TABLE component_values ADD COLUMN department_code TEXT`);
  }
}

/**
 * Repurpose positions.cluster for hotel clusters (secure v11).
 *
 * The column now stores a hotel_clusters id from the PLAINTEXT store ('' =
 * no cluster); its old free-text department groupings are dropped (mapping
 * tables replace that use), so an UPGRADED store clears them — otherwise
 * every legacy value would render as a dangling cluster warning. The clear
 * only runs when the override column is genuinely being added (a pre-v11
 * store): on a fresh install the column comes from the DDL above, there is
 * no legacy data, and re-execs must never wipe real assignments.
 * Idempotent — guard on the column check.
 */
export function applyValueStoreV11(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(positions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("cluster_multiplier_override")) {
    handle.exec(
      `ALTER TABLE positions ADD COLUMN cluster_multiplier_override REAL`
    );
    handle.exec(`UPDATE positions SET cluster = ''`);
  }
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_positions_cluster ON positions (cluster)`
  );
}

/**
 * Add positions.cluster_link_id — the cluster-position group (secure v2).
 *
 * Deliberately links NOTHING retroactively: rows that were hand-duplicated
 * across the member hotels before this feature stay standalone ('') and are
 * adopted into a group explicitly from the Clusters screen. Auto-matching live
 * cost data on a title string is the one guess this feature must not make.
 * Fresh installs get the column from the DDL above; this backfills upgraded
 * stores. Idempotent — ALTER TABLE ADD COLUMN is not `IF NOT EXISTS`, so the
 * column check has to be the guard.
 */
export function applyValueStoreV12(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(positions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("cluster_link_id")) {
    handle.exec(
      `ALTER TABLE positions ADD COLUMN cluster_link_id TEXT NOT NULL DEFAULT ''`
    );
  }
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_positions_cluster_link
       ON positions (cluster_link_id)`
  );
}

/**
 * Add positions.cluster_weight_snapshot / cluster_name_snapshot (secure v5).
 *
 * The travelling copy of a position's effective cluster share. Cluster
 * definitions live in the plaintext store of the machine that created them and
 * never sync, so a plan downloaded elsewhere resolved every assignment to
 * DANGLING — weight ×1 and no name — and quietly computed different totals
 * than the owner's machine. These columns carry the owner-resolved name and
 * weight inside the position payload; `resolveHotelClusterWeight` falls back
 * to them when the definition is absent. Fresh installs get the columns from
 * the DDL above; this backfills upgraded stores. No data backfill — values
 * arrive with the next publish/pull. Idempotent — the column check is the
 * guard.
 */
export function applyClusterSnapshotColumns(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(positions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("cluster_weight_snapshot")) {
    handle.exec(`ALTER TABLE positions ADD COLUMN cluster_weight_snapshot REAL`);
  }
  if (!present.has("cluster_name_snapshot")) {
    handle.exec(`ALTER TABLE positions ADD COLUMN cluster_name_snapshot TEXT`);
  }
}

/**
 * Add the provenance columns to engine_output_lines (secure v3).
 *
 * Results stopped being "whatever the engine produced" and became a union of
 * four origins — the engine, manual input, allocations and buyouts — so a line
 * has to say which one it came from, both for the Results inspector and so the
 * BST push can never send a number that can't be traced back on the page.
 *
 * Existing lines are all engine lines, which is exactly what the DEFAULTs say,
 * so no backfill is needed. The stored run is left alone: it will be recomputed
 * on the next Recalculate anyway, and the new sources make it stale immediately
 * (they are fingerprint probes now). Idempotent — the column check is the guard.
 */
export function applyOutputLineProvenance(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(engine_output_lines)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("source")) {
    handle.exec(
      `ALTER TABLE engine_output_lines ADD COLUMN source TEXT NOT NULL DEFAULT 'ENGINE'`
    );
  }
  if (!present.has("source_ref")) {
    handle.exec(
      `ALTER TABLE engine_output_lines ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''`
    );
  }
  if (!present.has("detail")) {
    handle.exec(
      `ALTER TABLE engine_output_lines ADD COLUMN detail TEXT NOT NULL DEFAULT '{}'`
    );
  }
}

/**
 * Add the per-scheme contributory-base columns to ss_schemes (base membership
 * moved off the block flags and onto the scheme itself). Fresh installs get the
 * columns from the DDL above; this backfills stores whose ss_schemes predates
 * them. Defaults keep existing schemes at gross base salary (both flags on, no
 * custom components). Idempotent — guard on the column check.
 */
export function applySsSchemeBaseColumns(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(ss_schemes)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("include_base_salary")) {
    handle.exec(
      `ALTER TABLE ss_schemes ADD COLUMN include_base_salary INTEGER NOT NULL DEFAULT 1`
    );
  }
  if (!present.has("include_vacation")) {
    handle.exec(
      `ALTER TABLE ss_schemes ADD COLUMN include_vacation INTEGER NOT NULL DEFAULT 1`
    );
  }
  if (!present.has("base_component_ids")) {
    handle.exec(
      `ALTER TABLE ss_schemes ADD COLUMN base_component_ids TEXT NOT NULL DEFAULT '[]'`
    );
  }
}
