/**
 * Flat grid row model for the Positions grid.
 * -----------------------------------------------------------
 * The DataGrid wants one flat object per row; storage wants engine records +
 * a PII sidecar. This module is the mapping layer between the two:
 *
 *   PositionRecord + PiiRecord  --toRow-->  PositionRow (flat)
 *   PositionRow + changed keys  --toPatch-->  { positionFields, piiFields }
 *
 * Month vectors are exploded to sea_1..sea_12 / addc_* / vacw_* for the grid
 * and promoted back to whole number[12] arrays on the way out (the storage
 * layer writes vectors as a unit).
 *
 * Computed columns (Full Year Wage etc.) are UI conveniences derived here —
 * they approximate the workbook columns without the calendar day-weighting;
 * authoritative results come from the engine (src/shared/engine/reference.ts).
 */

import { uuidv7 } from "../engine/ids";
import {
  ENGINE_SCALAR_COLUMNS,
  FieldCatalog,
  FieldDef,
  PII_CORE_COLUMNS,
  VECTOR_COLUMNS,
  VectorName,
  vectorKey,
} from "./fields";
import { PiiRecord, PositionCreate, PositionRecord } from "./ipc";

export interface PositionRow {
  id: string;
  [fieldKey: string]: unknown;
}

export interface RowPatch {
  /** Catalog-keyed fields destined for the `positions` table (scalars,
   *  whole vectors, POSITION_EXTRA keys). */
  positionFields: Record<string, unknown>;
  /** Catalog-keyed fields destined for the `position_pii` table. */
  piiFields: Record<string, unknown>;
}

const MONTHS = 12;

export function buildFieldMap(catalog: FieldCatalog): Map<string, FieldDef> {
  return new Map(catalog.fields.map((field) => [field.key, field]));
}

// ---------------------------------------------------------------------------
// Storage -> row
// ---------------------------------------------------------------------------

export function toRow(position: PositionRecord, pii?: PiiRecord | null): PositionRow {
  const row: PositionRow = {
    id: position.id,
    ...position.extraValues,
  };

  for (const key of Object.keys(ENGINE_SCALAR_COLUMNS)) {
    row[key] = (position as unknown as Record<string, unknown>)[key];
  }
  for (const vector of Object.keys(VECTOR_COLUMNS) as VectorName[]) {
    const values = position[vector] ?? [];
    for (let m = 1; m <= MONTHS; m++) {
      row[vectorKey(vector, m)] = values[m - 1] ?? 0;
    }
  }

  if (pii) {
    row.hiringDate = pii.hiringDate;
    row.empNumber = pii.empNumber;
    row.lastName = pii.lastName;
    row.firstName = pii.firstName;
    row.title = pii.title;
    Object.assign(row, pii.extraValues);
  }

  return row;
}

/** Rebuild one number[12] from the row's exploded month keys. */
export function rowVector(row: PositionRow, vector: VectorName): number[] {
  const out: number[] = [];
  for (let m = 1; m <= MONTHS; m++) {
    out.push(toNumber(row[vectorKey(vector, m)], 0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row -> storage patch
// ---------------------------------------------------------------------------

export function toPatch(
  row: PositionRow,
  changedKeys: string[],
  catalog: FieldCatalog
): RowPatch {
  const fields = buildFieldMap(catalog);
  const positionFields: Record<string, unknown> = {};
  const piiFields: Record<string, unknown> = {};
  const touchedVectors = new Set<VectorName>();

  for (const key of changedKeys) {
    const def = fields.get(key);
    if (!def || def.storage === "COMPUTED") continue;

    if (def.vector) {
      touchedVectors.add(def.vector);
      continue;
    }
    if (def.storage === "PII_CORE" || def.storage === "PII_EXTRA") {
      piiFields[key] = row[key] ?? null;
    } else {
      positionFields[key] = row[key] ?? null;
    }
  }

  // Vector members promote to the whole rebuilt vector — idempotent and
  // matching the storage granularity (one JSON column per vector).
  for (const vector of touchedVectors) {
    positionFields[vector] = rowVector(row, vector);
  }

  return { positionFields, piiFields };
}

/** Diff two rows over the catalog's editable fields. */
export function changedFieldKeys(
  oldRow: PositionRow,
  newRow: PositionRow,
  catalog: FieldCatalog
): string[] {
  const changed: string[] = [];
  for (const def of catalog.fields) {
    if (def.storage === "COMPUTED") continue;
    if (!Object.is(oldRow[def.key], newRow[def.key])) changed.push(def.key);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Sanitization (applied in processRowUpdate before anything is persisted)
// ---------------------------------------------------------------------------

const NUMERIC_TYPES = new Set(["NUMBER", "INTEGER", "PERCENT"]);

export function sanitizeRow(
  row: PositionRow,
  oldRow: PositionRow,
  catalog: FieldCatalog
): PositionRow {
  const out: PositionRow = { ...row };

  for (const def of catalog.fields) {
    if (def.storage === "COMPUTED" || !def.editable) continue;
    const value = out[def.key];
    if (value === undefined) continue;

    if (NUMERIC_TYPES.has(def.dataType)) {
      let num = toNumber(value, Number.NaN);
      if (Number.isNaN(num)) {
        out[def.key] = oldRow[def.key];
        continue;
      }
      const { min, max, decimals } = def.validation ?? {};
      if (min !== undefined) num = Math.max(min, num);
      if (max !== undefined) num = Math.min(max, num);
      if (def.dataType === "INTEGER") num = Math.trunc(num);
      if (decimals !== undefined) {
        const factor = 10 ** decimals;
        num = Math.round(num * factor) / factor;
      }
      out[def.key] = num;
    } else if (def.dataType === "BOOLEAN") {
      // Pasted cells arrive as text ("TRUE", "0", ...); normalize so the grid's
      // boolean renderer and the is-true filter both see a real boolean.
      out[def.key] = !(
        value === false ||
        value === 0 ||
        value === null ||
        value === "" ||
        String(value).trim().toLowerCase() === "false" ||
        String(value).trim() === "0"
      );
    } else if (value === "") {
      out[def.key] = null;
    }
  }

  // increaseMonth: 1..12 or 13 = "no increase this year" (engine contract).
  const rawMonth = toNumber(out.increaseMonth, 13);
  out.increaseMonth =
    rawMonth >= 1 && rawMonth <= 12 ? Math.trunc(rawMonth) : 13;

  if (out.payType !== "HOURLY" && out.payType !== "SALARIED") {
    out.payType = "SALARIED";
  }

  return out;
}

// ---------------------------------------------------------------------------
// Draft rows
// ---------------------------------------------------------------------------

export function newDraftRow(
  catalog: FieldCatalog,
  init: Partial<PositionRow> = {}
): PositionRow {
  const row: PositionRow = { id: uuidv7() };

  for (const def of catalog.fields) {
    if (def.storage === "COMPUTED") continue;
    if (def.defaultValue !== undefined) {
      row[def.key] = def.defaultValue;
    } else if (NUMERIC_TYPES.has(def.dataType)) {
      row[def.key] = 0;
    } else {
      row[def.key] = null;
    }
  }

  // Vacation weights default to an even spread (the workbook's 1/12 pattern).
  for (let m = 1; m <= MONTHS; m++) {
    row[vectorKey("vacationMonthlyWeights", m)] = 1 / 12;
  }

  return { ...row, ...init };
}

/** Package a draft row as a create payload (whole row, catalog-keyed). */
export function toCreate(row: PositionRow, catalog: FieldCatalog): PositionCreate {
  const allKeys = catalog.fields
    .filter((def) => def.storage !== "COMPUTED")
    .map((def) => def.key);
  const { positionFields, piiFields } = toPatch(row, allKeys, catalog);
  return { id: row.id, fields: positionFields, pii: piiFields };
}

// ---------------------------------------------------------------------------
// Computed columns
// ---------------------------------------------------------------------------

export type ComputeFn = (row: PositionRow) => number;

function sumVector(row: PositionRow, vector: VectorName): number {
  let total = 0;
  for (let m = 1; m <= MONTHS; m++) {
    total += toNumber(row[vectorKey(vector, m)], 0);
  }
  return total;
}

export const COMPUTES: Record<string, ComputeFn> = {
  totalWorkingMonths: (row) => sumVector(row, "seasonality"),

  vacationWeightsTotal: (row) => sumVector(row, "vacationMonthlyWeights"),

  /** Gross yearly wage before increases: base × working months + seasonal
   *  additional costs (matches Σ grossBase with no increase applied). */
  fullYearWage: (row) => {
    const base = toNumber(row.monthlyBaseSalary, 0);
    let total = base * sumVector(row, "seasonality");
    for (let m = 1; m <= MONTHS; m++) {
      total +=
        toNumber(row[vectorKey("additionalMonthlyCosts", m)], 0) *
        toNumber(row[vectorKey("seasonality", m)], 0);
    }
    return total;
  },

  /** Full year wage with the merit % applied from increaseMonth onward plus
   *  the manual yearly increase (flat-month approximation of the engine). */
  budgetYearBasicSalary: (row) => {
    const base = toNumber(row.monthlyBaseSalary, 0);
    const merit = toNumber(row.meritIncreasePct, 0);
    const rawMonth = toNumber(row.increaseMonth, 13);
    const incFrom = rawMonth >= 1 && rawMonth <= 12 ? rawMonth : 13;

    let total = 0;
    let activeFromIncrease = 0;
    for (let m = 1; m <= MONTHS; m++) {
      const seas = toNumber(row[vectorKey("seasonality", m)], 0);
      const mul = m >= incFrom ? 1 + merit : 1;
      total += base * seas * mul;
      total += toNumber(row[vectorKey("additionalMonthlyCosts", m)], 0) * seas;
      if (m >= incFrom) activeFromIncrease += seas;
    }
    if (activeFromIncrease > 0) {
      total += toNumber(row.manualYearlyIncrease, 0);
    }
    return total;
  },

  vacationEstimate: (row) =>
    toNumber(row.vacationDays, 0) * toNumber(row.dailyVacationCost, 0),
};

// ---------------------------------------------------------------------------

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  return fallback;
}

/** Keys of the PII core columns (used by the page to merge/strip PII). */
export const PII_ROW_KEYS = Object.keys(PII_CORE_COLUMNS);
