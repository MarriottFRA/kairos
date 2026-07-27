/**
 * The dynamic-UPDATE primitives for position rows.
 * -----------------------------------------------------------
 * Split out of positionsRepo so that clusterSync can write a SIBLING hotel's
 * row through exactly the same coercion and column-mapping path as an ordinary
 * write, without the two modules importing each other. There is one set of
 * rules for turning catalog-keyed fields into SQL, and it lives here.
 *
 * SQL identifiers come exclusively from the static maps in
 * shared/positions/fields.ts — a field key arriving over IPC is looked up
 * against the OU's catalog, never interpolated. Unknown keys throw.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  ENGINE_SCALAR_COLUMNS,
  FieldDef,
  PII_CORE_COLUMNS,
  VECTOR_COLUMNS,
  VectorName,
} from "../../shared/positions/fields";
import { OuScope } from "./ouScope";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

const MONTHS = 12;

export type FieldLookup = Map<string, FieldDef>;

export interface SplitFields {
  /** SQL column -> coerced value (identifiers only ever from the static maps). */
  columns: Map<string, unknown>;
  /** Keys destined for the extra_values JSON blob. */
  extras: Record<string, unknown>;
}

/**
 * Empty-cell values for engine columns whose schema default is not the type's
 * zero. Clearing "Increase Month" must mean "no increase" (13), not "increase
 * from month 0 onward"; a headcount cleared to 0 would silently zero the
 * position's whole cost rather than fall back to one. A cleared cluster
 * multiplier override MUST persist as NULL ("use the cluster's weight") — the
 * numeric-zero fallback would zero the position's whole cost instead.
 *
 * FTE used to be here for the same reason; it is COMPUTED since seed v24, so it
 * is never written and can no longer be cleared.
 */
export const ENGINE_EMPTY_OVERRIDES: Readonly<Record<string, unknown>> = {
  increaseMonth: 13,
  headcount: 1,
  active: 1,
  clusterMultiplierOverride: null,
};

/**
 * Coerce one engine scalar. Every column this feeds is NOT NULL (see
 * POSITIONS_VALUE_TABLES_SQL) except cluster_multiplier_override (nullable by
 * design, cleared via its ENGINE_EMPTY_OVERRIDES entry), so a cleared or
 * absent cell resolves to the column's default — returning an unmapped null
 * here fails the whole batch transaction.
 */
function coerceScalar(key: string, def: FieldDef | undefined, value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    if (key in ENGINE_EMPTY_OVERRIDES) return ENGINE_EMPTY_OVERRIDES[key];
    switch (def?.dataType) {
      case "NUMBER":
      case "PERCENT":
      case "INTEGER":
        return 0;
      default:
        return "";
    }
  }
  switch (def?.dataType) {
    case "NUMBER":
    case "PERCENT": {
      const num = Number(value);
      return Number.isFinite(num) ? num : 0;
    }
    case "INTEGER": {
      const num = Math.trunc(Number(value));
      return Number.isFinite(num) ? num : 0;
    }
    // SQLite has no boolean type — the column is INTEGER 0/1.
    case "BOOLEAN":
      return value === false || value === 0 || value === "false" ? 0 : 1;
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

export function coerceVector(value: unknown): string {
  const out: number[] = new Array(MONTHS).fill(0);
  if (Array.isArray(value)) {
    for (let m = 0; m < MONTHS; m++) {
      const num = Number(value[m]);
      out[m] = Number.isFinite(num) ? num : 0;
    }
  }
  return JSON.stringify(out);
}

/**
 * Split catalog-keyed fields into typed columns + extras for the positions
 * table. Vector names ("seasonality", ...) are accepted alongside catalog
 * keys. Unknown keys throw — accuracy over silent loss.
 */
export function splitPositionFields(
  fields: Record<string, unknown>,
  lookup: FieldLookup
): SplitFields {
  const columns = new Map<string, unknown>();
  const extras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (key in VECTOR_COLUMNS) {
      columns.set(VECTOR_COLUMNS[key as VectorName], coerceVector(value));
      continue;
    }
    const def = lookup.get(key);
    if (!def) throw new Error(`Unknown position field: ${key}`);

    if (def.storage === "ENGINE") {
      const column = ENGINE_SCALAR_COLUMNS[key];
      if (!column) throw new Error(`Field '${key}' has no engine column mapping`);
      // The pay_type CHECK would reject junk; normalize here instead.
      if (key === "payType") {
        columns.set(column, value === "HOURLY" ? "HOURLY" : "SALARIED");
      } else {
        columns.set(column, coerceScalar(key, def, value));
      }
    } else if (def.storage === "POSITION_EXTRA") {
      extras[key] = value === undefined ? null : value;
    } else {
      throw new Error(`Field '${key}' does not belong on the positions table`);
    }
  }

  return { columns, extras };
}

export function splitPiiFields(
  fields: Record<string, unknown>,
  lookup: FieldLookup
): SplitFields {
  const columns = new Map<string, unknown>();
  const extras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    const def = lookup.get(key);
    if (!def) throw new Error(`Unknown PII field: ${key}`);
    if (def.storage === "PII_CORE") {
      const column = PII_CORE_COLUMNS[key];
      if (!column) throw new Error(`Field '${key}' has no PII column mapping`);
      columns.set(column, value === undefined || value === "" ? null : value);
    } else if (def.storage === "PII_EXTRA") {
      extras[key] = value === undefined ? null : value;
    } else {
      throw new Error(`Field '${key}' does not belong on the PII table`);
    }
  }

  return { columns, extras };
}

/** Dynamic sparse UPDATE with sorted columns for statement-cache reuse.
 *  The scope is bound into the WHERE, so a sibling-hotel write from
 *  clusterSync is exactly as OU-gated as a single-hotel one. */
export function applyUpdate(
  db: Db,
  table: "positions" | "position_pii",
  idColumn: string,
  id: string,
  scope: OuScope,
  split: SplitFields,
  stamp: string
): number {
  const columnNames = [...split.columns.keys()].sort();
  const hasExtras = Object.keys(split.extras).length > 0;
  if (columnNames.length === 0 && !hasExtras) return 0;

  const sets = columnNames.map((name) => `${name} = ?`);
  if (hasExtras) sets.push(`extra_values = json_patch(extra_values, ?)`);
  sets.push(`updated_at = ?`);

  const sql = `UPDATE ${table} SET ${sets.join(", ")}
     WHERE ${idColumn} = ? AND ou = ? AND deleted_at IS NULL`;

  const params: unknown[] = columnNames.map((name) => split.columns.get(name));
  if (hasExtras) params.push(JSON.stringify(split.extras));
  params.push(stamp, id, scope.ou);

  return prepared(db, sql).run(...params).changes;
}
