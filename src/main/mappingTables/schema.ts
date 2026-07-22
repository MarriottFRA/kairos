/**
 * Mapping-tables DDL for the plaintext local store (local_db.ts migration v5).
 *
 * Three reference tables downloaded whole from the backend, plus a tiny KV that
 * holds the server version string and the last-sync timestamp so sync can be
 * version-gated. Kept free of Electron imports so tests can exec it against an
 * in-memory database.
 *
 * The two map tables mirror the API payload exactly: a base_* primary key, a
 * *_description_detail_level_max column, and the wide level_0 … level_30 hierarchy
 * (all nullable TEXT). Combos keep the server-assigned integer id as the PK.
 */

import { MAP_LEVEL_KEYS } from "../../shared/mappingTables/types";

/** `level_0 TEXT, level_1 TEXT, … level_30 TEXT` — shared by both map tables. */
const LEVEL_COLUMNS_SQL = MAP_LEVEL_KEYS.map((key) => `      ${key} TEXT`).join(
  ",\n"
);

export const MAPPING_TABLES_SQL = `
  -- Account hierarchy map, one row per base account. level_0..level_30 roll the
  -- account up through the reporting hierarchy; all levels are nullable.
  CREATE TABLE IF NOT EXISTS account_maps (
      base_account TEXT PRIMARY KEY,
      account_description_detail_level_max TEXT,
${LEVEL_COLUMNS_SQL}
  );

  -- Department hierarchy map, one row per base department (same shape).
  CREATE TABLE IF NOT EXISTS department_maps (
      base_department TEXT PRIMARY KEY,
      department_description_detail_level_max TEXT,
${LEVEL_COLUMNS_SQL}
  );

  -- Valid account/department pairings. id is the server-assigned identifier.
  CREATE TABLE IF NOT EXISTS account_department_combos (
      id INTEGER PRIMARY KEY,
      account TEXT NOT NULL,
      department TEXT NOT NULL,
      description TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_combos_account
      ON account_department_combos (account);
  CREATE INDEX IF NOT EXISTS idx_combos_department
      ON account_department_combos (department);

  -- Sync bookkeeping: the cached server version string and last-sync timestamp.
  CREATE TABLE IF NOT EXISTS mapping_tables_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;
