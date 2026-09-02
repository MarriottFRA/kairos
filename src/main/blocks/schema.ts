/**
 * Blocks feature DDL, shared between local_db.ts (migration v12) and the
 * tests. Must stay free of Electron imports — tests exec this against
 * in-memory databases.
 *
 * A block_configs row is the user-facing configuration; saving it compiles
 * 1..n rows into cost_component_definitions (see src/main/blocks/repo.ts).
 * Both live in the plaintext structure store, OU-wide (all scenarios of a
 * hotel share the block architecture; per-row values stay per-scenario in
 * the encrypted component_values table).
 */

import type Database from "better-sqlite3-multiple-ciphers";

export const BLOCK_CONFIGS_SQL = `
  CREATE TABLE IF NOT EXISTS block_configs (
      id         TEXT PRIMARY KEY,
      ou         TEXT NOT NULL,
      -- Widening this list is a baseline edit while the store is pre-launch
      -- (local_db CURRENT_SCHEMA_VERSION 1) and needs Settings -> Danger Zone ->
      -- Rebuild database on an existing dev store: SQLite cannot ALTER a CHECK,
      -- so post-launch it becomes an append-only table-rebuild migration.
      block_type TEXT NOT NULL CHECK (block_type IN
        ('MULTIPLIER','FLAT_MONTHLY','COUNT_RATE','CUSTOM_MONTHLY','SOCIAL_SECURITY','POOL_SPREAD')),
      label      TEXT NOT NULL,
      -- Everything type-specific (accounts, locks, base ref, spread choice,
      -- increase-aware, department mode) as one JSON blob; the compiled
      -- cost_component_definitions rows are the queryable projection.
      config     TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_block_configs_ou ON block_configs (ou);
`;

/**
 * Local migration v12: the block_configs table plus two columns on
 * cost_component_definitions:
 *   - block_id — which block compiled this definition (NULL for defs that are
 *     not block-owned, e.g. a future standalone BASE_SALARY admin row).
 *   - base_ref — JSON BaseSelector for base kinds beyond the original
 *     BASE_SALARY/COMPONENTS CHECK (STAT / CALENDAR / SERVICE / VACATION); the
 *     legacy base_selector_kind + component_base_refs path keeps serving the
 *     two original kinds. Read preference in structureRepo.getComponentDefinitions.
 *
 * Idempotent — ALTER TABLE ADD COLUMN is not `IF NOT EXISTS`, so guard on the
 * current columns (the applyValueStoreV3 pattern).
 */
export function applyBlocksStructureV12(
  handle: InstanceType<typeof Database>
): void {
  handle.exec(BLOCK_CONFIGS_SQL);

  const columns = handle
    .prepare("PRAGMA table_info(cost_component_definitions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // structure tables not created yet
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("block_id")) {
    handle.exec(
      `ALTER TABLE cost_component_definitions ADD COLUMN block_id TEXT`
    );
  }
  if (!present.has("base_ref")) {
    handle.exec(
      `ALTER TABLE cost_component_definitions ADD COLUMN base_ref TEXT`
    );
  }
}

/**
 * Local migration v3: cost_component_definitions.count_exempt — the ratio flag.
 *
 * A line is normally booked `headcount × clusterWeight` times over by the
 * engine's post-pass. A ratio block (cost ÷ hours) is already the per-person
 * figure and is the SAME figure however many identical people the row stands
 * for, so it opts out. Default 0 → every existing definition keeps its exact
 * behaviour, which is why this upgrades in place rather than needing a rebuild.
 *
 * Additive ALTER only: SQLite applies ADD COLUMN with a DEFAULT without copying
 * the table, so no data is touched. Column-guarded because ADD COLUMN has no
 * IF NOT EXISTS (the applyBlocksStructureV12 pattern above). Must stay in step
 * with the baseline DDL in main/positions/schema.ts — the schema-drift test
 * asserts a migrated store and a fresh one end up identical.
 */
export function applyCountExemptV3(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(cost_component_definitions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // structure tables not created yet
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("count_exempt")) {
    handle.exec(
      `ALTER TABLE cost_component_definitions ADD COLUMN count_exempt INTEGER NOT NULL DEFAULT 0`
    );
  }
}

/**
 * cost_component_definitions.collapse_months — land a MULTIPLIER's whole
 * yearly result in chosen months (the 13th/14th-period-salary shape).
 *
 * JSON array of 1-based months as TEXT; NULL = the def spreads with its base
 * as it always has, which is why this upgrades in place — every existing row
 * keeps its exact behaviour. Additive, column-guarded ALTER like the helpers
 * above; must stay in step with the baseline DDL in main/positions/schema.ts
 * (the schema-drift test asserts a migrated store and a fresh one end up
 * identical).
 */
export function applyCollapseMonthsColumn(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(cost_component_definitions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // structure tables not created yet
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("collapse_months")) {
    handle.exec(
      `ALTER TABLE cost_component_definitions ADD COLUMN collapse_months TEXT`
    );
  }
}

/**
 * cost_component_definitions.weekday_mask — which weekdays a WEEKDAY_COUNT
 * spread books on (7-bit Sunday-first mask, the CalendarYear.weekendMask
 * convention; `1 << 5` = Fridays).
 *
 * NULL = not a weekday def — every existing row keeps its exact behaviour,
 * which is why this upgrades in place. Additive, column-guarded ALTER like the
 * helpers above; must stay in step with the baseline DDL in
 * main/positions/schema.ts (the schema-drift test asserts a migrated store and
 * a fresh one end up identical).
 */
export function applyWeekdayMaskColumn(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(cost_component_definitions)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // structure tables not created yet
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("weekday_mask")) {
    handle.exec(
      `ALTER TABLE cost_component_definitions ADD COLUMN weekday_mask INTEGER`
    );
  }
}

/**
 * Every guarded column cost_component_definitions needs beyond its CREATE
 * TABLE, in the order applyBaselineSchema applies them.
 *
 * Use THIS rather than the individual helpers when standing up the structure
 * schema (including in tests) — the columns are added by ALTER, so the order
 * they are applied in is the column order a store ends up with, and a caller
 * that runs only some of them produces a database subtly unlike a real one.
 * Idempotent, like each helper it calls.
 */
export function applyStructureColumns(
  handle: InstanceType<typeof Database>
): void {
  applyBlocksStructureV12(handle);
  applyCountExemptV3(handle);
  applyCollapseMonthsColumn(handle);
  applyWeekdayMaskColumn(handle);
}
