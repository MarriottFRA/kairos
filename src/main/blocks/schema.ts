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
      block_type TEXT NOT NULL CHECK (block_type IN
        ('MULTIPLIER','FLAT_MONTHLY','COUNT_RATE','CUSTOM_MONTHLY','SOCIAL_SECURITY')),
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
 *     BASE_SALARY/COMPONENTS CHECK (STAT / CALENDAR / VACATION); the legacy
 *     base_selector_kind + component_base_refs path keeps serving the two
 *     original kinds. Read preference in structureRepo.getComponentDefinitions.
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
