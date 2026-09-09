/**
 * The mapping tables as a MapIndex, built once per mapping-tables version.
 *
 * This is the first reader of account_maps.level_* / department_maps.level_*
 * in the app: the pickers only ever wanted the code and the name. The whole
 * of both tables (~5,000 rows × 31 labels) is read in two statements and
 * indexed in memory; a level lookup is then a Map hit, and the SQL side has
 * no index on those columns to miss.
 *
 * Fail-soft, like nameLookup in outputsRepo: an install that has never synced
 * has no account_maps table at all, and a report built from base-code atoms
 * must still run there. Level atoms warn instead.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { MAP_LEVEL_KEYS } from "../../shared/mappingTables/types";
import {
  MapIndex,
  MapRowInput,
  UNAVAILABLE_MAP_INDEX,
  buildMapIndex,
} from "../../shared/reports/sources";
import { getStoredVersion } from "../mappingTables/repo";
import { prepared } from "../positions/stmtCache";
import { memo } from "./cache";

type Db = InstanceType<typeof Database>;

const LEVELS = MAP_LEVEL_KEYS.join(", ");

function readRows(db: Db, table: string, codeColumn: string, nameColumn: string): MapRowInput[] {
  const rows = prepared(
    db,
    `SELECT ${codeColumn} AS code, ${nameColumn} AS name, ${LEVELS} FROM ${table}`
  ).all() as Array<Record<string, string | null>>;
  return rows.map((row) => ({
    code: String(row.code ?? ""),
    name: row.name ?? null,
    levels: MAP_LEVEL_KEYS.map((key) => row[key] ?? null),
  }));
}

/** The cheap identity of the cached tables: the synced version plus the row
 *  counts, so a rebuild-in-progress (cleared, not yet re-pulled) reads as a
 *  different index from the one before it. */
function stamp(db: Db): string | null {
  try {
    const version = getStoredVersion(db);
    const counts = prepared(
      db,
      `SELECT (SELECT COUNT(*) FROM account_maps) AS accounts,
              (SELECT COUNT(*) FROM department_maps) AS departments`
    ).get() as { accounts: number; departments: number };
    if (counts.accounts === 0 && counts.departments === 0) return null;
    return `${version ?? ""}|${counts.accounts}|${counts.departments}`;
  } catch {
    return null; // never synced: no tables at all
  }
}

export function getMapIndex(localDb: Db): MapIndex {
  const key = stamp(localDb);
  if (key === null) return UNAVAILABLE_MAP_INDEX;
  return memo(localDb, "reports:maps", key, () =>
    buildMapIndex(
      getStoredVersion(localDb),
      readRows(localDb, "department_maps", "base_department", "department_description_detail_level_max"),
      readRows(localDb, "account_maps", "base_account", "account_description_detail_level_max")
    )
  );
}

/** The synced mapping-tables version, or null — for the report response. */
export function readMappingVersion(localDb: Db): string | null {
  try {
    return getStoredVersion(localDb);
  } catch {
    return null;
  }
}
