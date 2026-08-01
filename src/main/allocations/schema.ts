/**
 * Allocations feature DDL, shared between local_db.ts (baseline schema) and the
 * tests. Must stay free of Electron imports — tests exec this against in-memory
 * databases.
 *
 * An allocations row is a per-hotel spread definition (name + spread base +
 * excluded departments + the account its split posts to). It lives in the
 * plaintext structure store, OU-wide — the grid VALUES are computed on demand
 * from the hotel's active positions, so nothing derived is stored here. Mirrors
 * block_configs (definitions only).
 */

import type Database from "better-sqlite3-multiple-ciphers";

export const ALLOCATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS allocations (
      id                   TEXT PRIMARY KEY,
      ou                   TEXT NOT NULL,
      name                 TEXT NOT NULL,
      spread_base          TEXT NOT NULL,
      -- JSON array of department_code strings zeroed out before normalizing.
      excluded_departments TEXT NOT NULL DEFAULT '[]',
      -- The account this allocation's split posts to on the Results page, one
      -- stat row per department carrying the PERCENTAGE itself (15.23, not
      -- 0.1523), in January with zeroes after it -- the BST reads a split as a
      -- level. '' = not posted, the same "Blank" contract the engine uses for
      -- calculation-only blocks. The legacy workbook also carried a TARGET
      -- DEPARTMENT (the cost's owner); it is deliberately not modelled here —
      -- posting a row per department has no use for it.
      inject_account       TEXT NOT NULL DEFAULT '',
      sort_order           INTEGER NOT NULL DEFAULT 0,
      updated_at           TEXT NOT NULL,
      deleted_at           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_allocations_ou ON allocations (ou);
`;

/** Create the allocations table (idempotent). Called from applyBaselineSchema. */
export function applyAllocations(handle: InstanceType<typeof Database>): void {
  handle.exec(ALLOCATIONS_SQL);
}

/**
 * Add `inject_account` to a pre-Results-integration allocations table.
 *
 * Fresh installs get it from the DDL above; this backfills stores created
 * before allocations could post to Results. '' preserves today's behaviour
 * (definition only, nothing posted) until a user picks an account. Idempotent —
 * the column check is the guard, ALTER TABLE ADD COLUMN has no IF NOT EXISTS.
 */
export function applyAllocationInjectAccount(
  handle: InstanceType<typeof Database>
): void {
  const columns = handle
    .prepare("PRAGMA table_info(allocations)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table not created yet — nothing to upgrade
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("inject_account")) {
    handle.exec(
      `ALTER TABLE allocations ADD COLUMN inject_account TEXT NOT NULL DEFAULT ''`
    );
  }
}
