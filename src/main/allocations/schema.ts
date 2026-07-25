/**
 * Allocations feature DDL, shared between local_db.ts (baseline schema) and the
 * tests. Must stay free of Electron imports — tests exec this against in-memory
 * databases.
 *
 * An allocations row is a per-hotel spread definition (name + spread base +
 * excluded departments). It lives in the plaintext structure store, OU-wide —
 * the grid VALUES are computed on demand from the hotel's active positions, so
 * nothing derived is stored here. Mirrors block_configs (definitions only).
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
