/**
 * Mapping-tables repository — plaintext local store access for the three
 * reference tables + their sync metadata.
 *
 * The write path (`replaceAllTables`) is a single transaction: it clears all
 * three tables and re-inserts the freshly downloaded rows, then stamps the new
 * version. Either the whole cache flips to the new version or nothing changes —
 * a mid-way failure can never leave maps from one version next to combos from
 * another.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  AccountDepartmentCombo,
  AccountMap,
  DepartmentMap,
  MAP_LEVEL_KEYS,
  MappingTableCounts,
  MappingTablesStatus,
} from "../../shared/mappingTables/types";

type LocalDb = InstanceType<typeof Database>;

const VERSION_KEY = "version";
const LAST_SYNCED_KEY = "last_synced_at";

/** Columns written for each map row: the base key, the description, then levels. */
const ACCOUNT_COLUMNS = [
  "base_account",
  "account_description_detail_level_max",
  ...MAP_LEVEL_KEYS,
];
const DEPARTMENT_COLUMNS = [
  "base_department",
  "department_description_detail_level_max",
  ...MAP_LEVEL_KEYS,
];

/** Build an `INSERT INTO t (cols) VALUES (?,?,…)` statement for a column list. */
function insertSql(table: string, columns: readonly string[]): string {
  const placeholders = columns.map(() => "?").join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
}

/** Coerce a possibly-missing/undefined map cell to `string | null` for SQLite. */
function cell(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

//------------------------------------------------------------------------------
//--- METADATA -----------------------------------------------------------------

function readMeta(db: LocalDb, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM mapping_tables_meta WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function writeMeta(db: LocalDb, key: string, value: string): void {
  db.prepare(
    `INSERT INTO mapping_tables_meta (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`
  ).run(key, value);
}

/** The cached server version string, or null if never synced. */
export function getStoredVersion(db: LocalDb): string | null {
  return readMeta(db, VERSION_KEY);
}

/** Local row counts across the three tables. */
export function getCounts(db: LocalDb): MappingTableCounts {
  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    return row.n;
  };
  return {
    accountMaps: count("account_maps"),
    departmentMaps: count("department_maps"),
    combos: count("account_department_combos"),
  };
}

/** Cache metadata + counts for the settings status line. */
export function getStatus(db: LocalDb): MappingTablesStatus {
  return {
    version: getStoredVersion(db),
    lastSyncedAt: readMeta(db, LAST_SYNCED_KEY),
    counts: getCounts(db),
  };
}

//------------------------------------------------------------------------------
//--- WRITE PATH ---------------------------------------------------------------

/**
 * Replace all three tables with a freshly downloaded set and stamp `version`.
 * One transaction: clear + bulk insert + version/timestamp stamp are atomic.
 *
 * @param nowIso timestamp to record as last_synced_at (passed in so this module
 *               stays free of clock calls and is deterministic under test).
 */
export function replaceAllTables(
  db: LocalDb,
  data: {
    accountMaps: AccountMap[];
    departmentMaps: DepartmentMap[];
    combos: AccountDepartmentCombo[];
    version: string;
  },
  nowIso: string
): void {
  const insertAccount = db.prepare(insertSql("account_maps", ACCOUNT_COLUMNS));
  const insertDepartment = db.prepare(
    insertSql("department_maps", DEPARTMENT_COLUMNS)
  );
  const insertCombo = db.prepare(
    insertSql("account_department_combos", [
      "id",
      "account",
      "department",
      "description",
    ])
  );

  db.transaction(() => {
    db.prepare("DELETE FROM account_maps").run();
    db.prepare("DELETE FROM department_maps").run();
    db.prepare("DELETE FROM account_department_combos").run();

    for (const row of data.accountMaps) {
      insertAccount.run(...ACCOUNT_COLUMNS.map((col) => cell(row[col])));
    }
    for (const row of data.departmentMaps) {
      insertDepartment.run(...DEPARTMENT_COLUMNS.map((col) => cell(row[col])));
    }
    for (const combo of data.combos) {
      insertCombo.run(
        combo.id,
        combo.account,
        combo.department,
        cell(combo.description)
      );
    }

    writeMeta(db, VERSION_KEY, data.version);
    writeMeta(db, LAST_SYNCED_KEY, nowIso);
  })();
}

/**
 * DESTRUCTIVE: empty all three tables and drop the stored version + timestamp.
 * Used by the settings "Rebuild" action before it forces a fresh full pull.
 */
export function clearAllTables(db: LocalDb): void {
  db.transaction(() => {
    db.prepare("DELETE FROM account_maps").run();
    db.prepare("DELETE FROM department_maps").run();
    db.prepare("DELETE FROM account_department_combos").run();
    db.prepare("DELETE FROM mapping_tables_meta").run();
  })();
}
