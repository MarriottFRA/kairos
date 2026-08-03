/**
 * Grid value bridge — reading and writing a row through its own columns.
 * -----------------------------------------------------------
 * columnFactory does not merely configure columns; it IS the spec for what a
 * position field means. PERCENT is stored 0..1 and typed as "5"; DATE is stored
 * as an ISO day and edited as a Date; Manhours Worked shows the calendar-derived
 * hours until you override it, and quietly refuses to persist an echo of that
 * derived value; the Cluster Multiplier does the same against its cluster's
 * weight; masked PII formats to dots everywhere, including the clipboard.
 *
 * None of that is in the row, and none of it is in sanitizeRow. It lives in the
 * GridColDef callbacks. So the Edit Position form does not re-derive any of it —
 * it calls the very same callbacks. A field the form can edit is a field the
 * grid could edit, by construction, and the two cannot drift apart because
 * there is only ever one implementation.
 *
 * Verified precondition: every callback columnFactory and blockColumns install
 * reads only (value, row). None touches `column` or `apiRef`, which is why they
 * are safe to invoke outside a mounted grid. Keep the casts confined to this
 * file, and keep that precondition true — a future callback that reaches for
 * apiRef would have to be handled here rather than silently returning undefined.
 *
 * Deliberately a .ts with a type-only MUI import so it stays unit-testable in
 * the node environment (see __tests__/gridValueBridge.test.ts).
 */

import type { GridColDef } from "@mui/x-data-grid-premium";
import { FieldDef } from "../../shared/positions/fields";
import { PositionRow } from "../../shared/positions/rowModel";

type Col = GridColDef<PositionRow>;
/** The colDef callbacks, narrowed to the two arguments any of them actually use. */
type CellFn = (value: unknown, row: PositionRow) => unknown;

interface SelectOption {
  value: unknown;
  label: string;
  /** Section header for the long type-ahead lists (Standard Title). */
  group?: string;
}

/** Section header the grid editor and the form both file a stored-but-retired
 *  value under, so a value the list no longer offers is visibly the row's own
 *  rather than folded into whichever section happens to come first. Lives here
 *  because both editors read their options through optionsOf. */
export const ORPHAN_GROUP = "Current value";

/** A column's static option list, when it has one (singleSelect columns). */
export function optionsOf(column: Col): SelectOption[] | null {
  const options = (column as { valueOptions?: unknown }).valueOptions;
  return Array.isArray(options) ? (options as SelectOption[]) : null;
}

/**
 * The value an editor would be handed — i.e. after the column's valueGetter.
 *
 * For most fields this is just `row[field]`, but for the derived and
 * auto/override columns it is the EFFECTIVE value: the FTE from the ctx map,
 * the calendar-derived manhours, the cluster's own weight. Seeding a form input
 * from here is what makes an untouched field byte-identical on commit, and so
 * incapable of accidentally promoting an auto value into a stored override.
 */
export function editValue(column: Col, row: PositionRow): unknown {
  const getter = column.valueGetter as CellFn | undefined;
  return getter ? getter(row[column.field], row) : row[column.field];
}

/**
 * Exactly what the grid cell displays: dots for masked PII, "5%", "×1.20",
 * thousands separators, an enum's label rather than its stored code.
 */
export function displayValue(column: Col, row: PositionRow): string {
  const value = editValue(column, row);
  const formatter = column.valueFormatter as CellFn | undefined;
  if (formatter) return String(formatter(value, row) ?? "");

  // singleSelect columns carry no valueFormatter: MUI installs the value->label
  // lookup at grid runtime, off the colDef. This is the one piece of grid
  // behaviour the bridge has to restate rather than inherit — and the reason
  // columnFactory must keep leaving ENUM/ACCOUNT_CODE formatters unset, or CSV
  // export would start emitting raw codes.
  const options = optionsOf(column);
  if (options) {
    const hit = options.find((option) => option.value === value);
    if (hit) return hit.label;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toLocaleDateString();
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Apply an edit exactly as a cell commit would: valueParser, then valueSetter.
 *
 * Returns the SAME row object when the column's setter decides the edit is a
 * no-op (the Cluster Multiplier echo case). Callers must compare by identity
 * and skip the write, mirroring how processRowUpdate + changedFieldKeys reach
 * the same conclusion in the grid.
 */
export function commitValue(column: Col, row: PositionRow, raw: unknown): PositionRow {
  const parser = column.valueParser as CellFn | undefined;
  const parsed = parser ? parser(raw, row) : raw;
  const setter = column.valueSetter as
    | ((value: unknown, row: PositionRow) => PositionRow)
    | undefined;
  if (setter) return setter(parsed, row);
  return { ...row, [column.field]: parsed };
}

/**
 * The text to seed an input with when it takes focus: the value as the user
 * would type it, not as the cell renders it — "5" not "5%", "1800" not "1,800",
 * "1.2" not "×1.20".
 *
 * The round trip is guaranteed by the column's own parser: PERCENT stores 0..1
 * and parses "5" back to 0.05, so scaling by 100 here is the exact inverse.
 */
export function rawEditText(
  column: Col,
  def: FieldDef | undefined,
  row: PositionRow
): string {
  const value = editValue(column, row);
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : isoDay(value);
  }
  if (def?.dataType === "PERCENT" && typeof value === "number") {
    // Trim the float noise 0.0833 * 100 leaves behind, without inventing
    // precision the field does not have.
    return String(Number((value * 100).toFixed(decimalsFor(def) + 2)));
  }
  return String(value);
}

/** Display decimals for a PERCENT field, expressed on the shown (×100) scale. */
function decimalsFor(def: FieldDef): number {
  const stored = def.validation?.decimals;
  return typeof stored === "number" ? Math.max(0, stored - 2) : 2;
}

/**
 * A Date as the `YYYY-MM-DD` a native date input expects.
 *
 * UTC parts, not local ones. The column's valueGetter builds its Date with
 * `new Date("2026-03-05")`, which JS parses as UTC midnight; read back with
 * local getters that is still 2026-03-04 anywhere west of UTC, so the form
 * would show — and then store — the day before the one the grid shows.
 */
export function isoDay(value: Date): string {
  const year = String(value.getUTCFullYear()).padStart(4, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * A `YYYY-MM-DD` string as the Date the grid's DATE valueSetter expects.
 *
 * Built from UTC parts on purpose: the setter serializes with
 * `toISOString().slice(0,10)`, so a Date constructed at local midnight would
 * come back a day earlier for anyone east of UTC.
 */
export function dayToDate(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  );
  return Number.isNaN(date.getTime()) ? null : date;
}
