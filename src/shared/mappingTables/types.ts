/**
 * Mapping tables — shared types + IPC channel names.
 *
 * These three reference tables (account maps, department maps, and
 * account/department combos) are downloaded whole from the backend and cached
 * in the plaintext local store. They change extremely infrequently, so sync is
 * version-gated: poll a cheap `/mapping-tables/version`, and only re-pull the
 * bulk payloads when the string differs from the cached one.
 *
 * The renderer never sees the ~5000-row payloads — main fetches and writes them
 * straight into local_db; the renderer only drives sync and reads back status.
 */

/** Number of hierarchy levels on each map row: level_0 … level_30 (inclusive). */
export const MAP_LEVEL_COUNT = 31;

/** `["level_0", "level_1", … "level_30"]` — the wide columns on both map tables. */
export const MAP_LEVEL_KEYS: readonly string[] = Array.from(
  { length: MAP_LEVEL_COUNT },
  (_, i) => `level_${i}`
);

/** One account_maps row as returned by GET /mapping-tables/data. */
export interface AccountMap {
  base_account: string;
  account_description_detail_level_max: string | null;
  // level_0 … level_30, each Optional[str] on the backend.
  [level: string]: string | null;
}

/** One department_maps row as returned by GET /mapping-tables/data. */
export interface DepartmentMap {
  base_department: string;
  department_description_detail_level_max: string | null;
  [level: string]: string | null;
}

/** GET /mapping-tables/data payload. */
export interface MappingTablesData {
  account_maps: AccountMap[];
  department_maps: DepartmentMap[];
  version: string;
}

/**
 * A single department for a picker: the code the user selects (base_department)
 * and its human name (department_description_detail_level_max). Flattened from a
 * DepartmentMap row so the renderer never receives the wide level_* hierarchy.
 */
export interface DepartmentOption {
  code: string;
  name: string;
}

/**
 * A single account for a picker: the code that gets stored (base_account) and
 * its human description (account_description_detail_level_max — the "detail
 * level max" the user browses by). Flattened from an AccountMap row so the
 * renderer never receives the wide level_* hierarchy.
 *
 * Unlike a department (where the NAME is stored), an account picker stores the
 * `code` — a picked account writes its base_account into the cell, while the
 * user searches by the description. Which subset of accounts a given field
 * offers is decided by the field's `AccountFilter` (see fields.ts), applied in
 * the renderer over this full list; the whole account_maps table crosses IPC
 * once and every account field filters the same cache.
 */
export interface AccountOption {
  code: string;
  name: string;
}

/** One account_department_combos row from GET /mapping-tables/combos. */
export interface AccountDepartmentCombo {
  id: number;
  account: string;
  department: string;
  description: string | null;
}

/** GET /mapping-tables/combos payload (note: no version field). */
export interface CombosResponse {
  combos: AccountDepartmentCombo[];
}

/** GET /mapping-tables/version payload. */
export interface MappingVersionResponse {
  version: string;
}

/**
 * Outcome of a sync attempt.
 *   - "synced":      version differed (or a rebuild was forced); tables replaced.
 *   - "up-to-date":  cached version matched the server; nothing pulled.
 *   - "unavailable": server returned 404 (no mapping_configs row yet). The
 *                    existing cache, if any, is left untouched.
 *   - "error":       the sync failed; `message` carries the reason.
 */
export type MappingSyncOutcome = "synced" | "up-to-date" | "unavailable" | "error";

/** Row counts held locally, surfaced in the settings status line. */
export interface MappingTableCounts {
  accountMaps: number;
  departmentMaps: number;
  combos: number;
}

/** Local cache metadata + counts — what the settings card renders. */
export interface MappingTablesStatus {
  version: string | null;
  lastSyncedAt: string | null;
  counts: MappingTableCounts;
}

/** Result returned from a sync/rebuild call. */
export interface MappingSyncResult {
  outcome: MappingSyncOutcome;
  status: MappingTablesStatus;
  message?: string;
}

export const MAPPING_TABLES_CHANNELS = {
  /** Version-gated sync: pull only if the server version differs from the cache. */
  sync: "mapping-tables:sync",
  /** Clear all three tables + the stored version, then force a full re-pull. */
  rebuild: "mapping-tables:rebuild",
  /** Read local cache metadata + row counts (no network). */
  status: "mapping-tables:status",
  /** List departments (code + name) for the positions dropdown. */
  listDepartments: "mapping-tables:list-departments",
  /** List accounts (code + description) for the account dropdowns. */
  listAccounts: "mapping-tables:list-accounts",
} as const;
