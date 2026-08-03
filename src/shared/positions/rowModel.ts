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
import { referenceVacation } from "../engine/reference";
import { deriveYearlyHoursWorked, resolveFte } from "./engineInput";
import {
  EMPTY_FULL_TIME_REFERENCE,
  FullTimeReference,
} from "../positionDefaults";
import {
  CalendarContext,
  PayType,
  Position,
  PositionId,
  ScenarioId,
} from "../engine/types";
import {
  ACCOUNT_FIELD_KEYS,
  ANNUAL_DIVISOR_KEY,
  AnnualDivisorBasis,
  BASIC_SALARY_ANNUAL_KEY,
  BASIC_SALARY_HOURLY_KEY,
  BASIC_SALARY_MONTHLY_KEY,
  ENGINE_SCALAR_COLUMNS,
  FieldCatalog,
  FieldDef,
  HOTEL_CLUSTER_KEY,
  HOTEL_CLUSTER_MULT_KEY,
  PII_CORE_COLUMNS,
  SALARY_ENTRY_MODE_KEY,
  SalaryEntryMode,
  VECTOR_COLUMNS,
  VectorName,
  vectorKey,
} from "./fields";
import { CLUSTER_LINK_ROW_KEY } from "./clusterSync";
import { workingHoursAccountForJobType } from "./systemAccounts";
import { PiiRecord, PositionCreate, PositionRecord } from "./ipc";

/** The Working Hours account — defaulted from the row's Classification. */
const HOURS_ACCOUNT_KEY = ACCOUNT_FIELD_KEYS.hours;

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
    // Read-only marker: which cluster-position group this row belongs to, so the
    // grid can show that edits here also land in the other member hotels. Not a
    // catalog key, so it never reaches a patch.
    [CLUSTER_LINK_ROW_KEY]: position.clusterLinkId ?? "",
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

  // Settle the Annual/Monthly basic-salary pairing before the row is ever shown
  // or diffed, so a pre-v19 row displays an Annual figure without that counting
  // as an edit (changedFieldKeys compares hydrated rows on both sides).
  hydrateBasicSalary(row);

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

  // Flipping Salary Entry (or Annual Basis) promotes a face that until now was
  // only ever DERIVED into the one the row is typed in. hydrateBasicSalary
  // computes that face at load time precisely so it does not read as an edit —
  // which means on a row whose stored record never carried it (anything written
  // before v19, or imported as monthly) both sides of this diff hold the same
  // hydrated number and the face looks unchanged. The flip would then be saved
  // alone, and the next load would take the STORED figure — 0 — as the typed
  // one and zero the salary. So write the whole group whenever either selector
  // moves: four scalars, and what the user sees is what is stored.
  if (changed.includes(SALARY_ENTRY_MODE_KEY) || changed.includes(ANNUAL_DIVISOR_KEY)) {
    for (const key of [BASIC_SALARY_ANNUAL_KEY, BASIC_SALARY_MONTHLY_KEY]) {
      if (!changed.includes(key)) changed.push(key);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Basic salary: the Annual <-> Monthly pairing
// ---------------------------------------------------------------------------
//
// The engine reads exactly one salary input, monthlyBaseSalary, and that does
// not change here. Annual Basic is the same figure wearing the unit contracts
// are actually written in; Salary Entry says which one the user typed, and the
// other is always recomputed from it. Both are stored, so nothing downstream —
// the engine loaders, the live sim, the allocation spread bases — has to know
// this feature exists.
//
// The divisor is Σ working months, not 12: a nine-month contract states nine
// months' pay, so twelfths would understate every month it is actually paid in.
// A row can opt into a flat 12 via Annual Basis. Because the divisor is part of
// the row, a Working 1..12 edit re-derives too — sanitizeRow sees the whole row,
// so that falls out for free.

/** What Annual Basic divides by on this row. Σ seasonality unless the row opts
 *  into a flat 12; 0 is possible (a position that never works) and callers must
 *  guard, since the engine's own twm/twd normalization would be dividing by 0
 *  in the same situation. */
export function annualDivisorFor(row: PositionRow): number {
  return divisorBasisOf(row) === "TWELVE" ? MONTHS : sumVector(row, "seasonality");
}

/** Which face the user types. Anything unrecognized — including the absent key
 *  on a row written before v19 — is MONTHLY, which is what those rows meant. */
export function salaryEntryModeOf(row: PositionRow): SalaryEntryMode {
  return row[SALARY_ENTRY_MODE_KEY] === "ANNUAL" ? "ANNUAL" : "MONTHLY";
}

function divisorBasisOf(row: PositionRow): AnnualDivisorBasis {
  return row[ANNUAL_DIVISOR_KEY] === "TWELVE" ? "TWELVE" : "WORKING_MONTHS";
}

/**
 * Recompute the derived face of the pair, in place.
 *
 * Deliberately unconditional: it does not look at which cell changed, so a
 * paste into a locked cell, a Working-months edit, or a Pay Basis flip all land
 * on the same consistent result. Hourly rows have no basic salary at all —
 * their base comes from rate × hours — so both faces are zeroed, matching what
 * sanitizeRow already does to Monthly Basic.
 */
function deriveBasicSalary(row: PositionRow): void {
  row[SALARY_ENTRY_MODE_KEY] = salaryEntryModeOf(row);
  row[ANNUAL_DIVISOR_KEY] = divisorBasisOf(row);

  if (row.payType === "HOURLY") {
    row[BASIC_SALARY_MONTHLY_KEY] = 0;
    row[BASIC_SALARY_ANNUAL_KEY] = 0;
    return;
  }

  const divisor = annualDivisorFor(row);
  if (salaryEntryModeOf(row) === "ANNUAL") {
    // No working months = no month to book the salary in. Falls to 0 rather
    // than dividing by zero, which would write Infinity into the engine input.
    const annual = toNumber(row[BASIC_SALARY_ANNUAL_KEY], 0);
    row[BASIC_SALARY_MONTHLY_KEY] = divisor > 0 ? annual / divisor : 0;
  } else {
    row[BASIC_SALARY_ANNUAL_KEY] =
      toNumber(row[BASIC_SALARY_MONTHLY_KEY], 0) * divisor;
  }
}

/**
 * Is this Basic Salary cell read-only on this row? The single answer for both
 * the grid's edit gate (PositionsGrid.isCellEditable) and the muted styling
 * (columnFactory), so the two can never disagree about which cell is live.
 *
 * Pay Basis picks the outer pair (hourly locks both salary figures); Salary
 * Entry picks the inner one (the derived face is locked).
 */
export function basicSalaryCellLocked(
  row: PositionRow | undefined,
  key: string
): boolean {
  if (!row) return false;
  const hourly = row.payType === "HOURLY";
  switch (key) {
    case BASIC_SALARY_HOURLY_KEY:
      return !hourly;
    case BASIC_SALARY_MONTHLY_KEY:
      return hourly || salaryEntryModeOf(row) === "ANNUAL";
    case BASIC_SALARY_ANNUAL_KEY:
      return hourly || salaryEntryModeOf(row) === "MONTHLY";
    default:
      return false;
  }
}

/**
 * Fill in the pairing for a row loaded from storage.
 *
 * A row written before v19 has no Salary Entry, which reads as MONTHLY — the
 * behaviour it was saved under — so its Annual face is derived for display and
 * its stored monthly figure is left strictly alone. Never recomputes the
 * monthly base: that is the engine's input, and loading a page must not move a
 * budget number.
 */
function hydrateBasicSalary(row: PositionRow): void {
  row[SALARY_ENTRY_MODE_KEY] = salaryEntryModeOf(row);
  row[ANNUAL_DIVISOR_KEY] = divisorBasisOf(row);
  row[BASIC_SALARY_ANNUAL_KEY] =
    salaryEntryModeOf(row) === "ANNUAL"
      ? toNumber(row[BASIC_SALARY_ANNUAL_KEY], 0)
      : toNumber(row[BASIC_SALARY_MONTHLY_KEY], 0) * annualDivisorFor(row);
}

// ---------------------------------------------------------------------------
// Sanitization (applied in processRowUpdate before anything is persisted)
// ---------------------------------------------------------------------------

const NUMERIC_TYPES = new Set(["NUMBER", "INTEGER", "PERCENT"]);

/**
 * Normalize a cell to a real boolean. Pasted cells arrive as text ("TRUE",
 * "0", ""), and the grid's boolean renderer and its is-true filter both need
 * an actual boolean to agree with each other. Shared with the block tick-box
 * slots (blockRows.sanitizeBlockInputs) so both obey the same rule.
 */
export function coerceBooleanCell(value: unknown): boolean {
  return !(
    value === false ||
    value === 0 ||
    value === null ||
    value === undefined ||
    value === "" ||
    String(value).trim().toLowerCase() === "false" ||
    String(value).trim() === "0"
  );
}

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
      // Vacation weights are exempt from the decimals clamp. They are relative
      // proportions the engine normalizes by their own total, so rounding them
      // buys no storage tidiness and actively breaks the holiday accrual: an
      // even spread is 1/12 = 8.3333…%, which cannot survive 4 decimals, and the
      // accrual nets to zero only when the months are exactly equal to each
      // other. Rounding here is what put 0.28 in every month. min/max still bite.
      if (decimals !== undefined && def.vector !== "vacationMonthlyWeights") {
        const factor = 10 ** decimals;
        num = Math.round(num * factor) / factor;
      }
      out[def.key] = num;
    } else if (def.dataType === "BOOLEAN") {
      out[def.key] = coerceBooleanCell(value);
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

  // Pay Basis is authoritative over which base input is live. SALARIED keeps
  // the basic salary and zeros Hourly Rate; HOURLY the reverse — so toggling the
  // basis unlocks one field and clears the other, and only one is ever stored.
  // The engine keys off hourlyRate>0, which this keeps consistent with the basis.
  if (out.payType !== "HOURLY") {
    out[BASIC_SALARY_HOURLY_KEY] = 0;
  }
  // Then reconcile the salaried pair: whichever of Annual / Monthly Basic the
  // row does not type is recomputed from the one it does (and both are zeroed
  // for an hourly row). Runs after the numeric clamp above so it works on
  // committed numbers, and after Pay Basis so it sees the settled basis.
  deriveBasicSalary(out);

  // Hotel-cluster pair. The manual multiplier is only meaningful against the
  // row's current assignment — changing (or clearing) the cluster invalidates
  // it. Reads the RAW committed value (the generic numeric pass above cannot
  // represent "cleared"): empty → null ("use the cluster's weight" — NEVER 0,
  // a zero multiplier would zero the row's whole cost); invalid/≤0 → null;
  // >1 clamps to 1.
  if (out[HOTEL_CLUSTER_KEY] !== oldRow[HOTEL_CLUSTER_KEY]) {
    out[HOTEL_CLUSTER_MULT_KEY] = null;
  } else if (row[HOTEL_CLUSTER_MULT_KEY] !== undefined) {
    const num = toNumber(row[HOTEL_CLUSTER_MULT_KEY], Number.NaN);
    out[HOTEL_CLUSTER_MULT_KEY] =
      Number.isFinite(num) && num > 0 ? Math.min(num, 1) : null;
  }

  // Working Hours account follows the grade — a DEFAULT, not a derivation (that
  // is the Headcount account beside it, which is COMPUTED and unarguable). The
  // account a grade normally books to is the answer nine rows in ten, so picking
  // a Classification fills it; a post that books somewhere special is one edit
  // away, and every later edit leaves that choice alone.
  //
  // Skipped when the same commit also moved the account by hand — a paste
  // carrying both a Classification and an account means both, and the default
  // must not overwrite the more specific of the two.
  if (
    out.jobTypeCode !== oldRow.jobTypeCode &&
    out[HOURS_ACCOUNT_KEY] === oldRow[HOURS_ACCOUNT_KEY]
  ) {
    // "" (a grade that books none) stores as null, like any cleared account.
    out[HOURS_ACCOUNT_KEY] = workingHoursAccountForJobType(out.jobTypeCode) || null;
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

  // Vacation weights default to an even year. They are relative weights the
  // engine normalizes by their own sum, so twelve 1s says "even" more plainly
  // than twelve 0.0833s — and unlike 1/12 it is a number a user can retype.
  for (let m = 1; m <= MONTHS; m++) {
    row[vectorKey("vacationMonthlyWeights", m)] = 1;
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
// Engine bridge — feed live grid rows through the real spread math
// ---------------------------------------------------------------------------

/**
 * Map a flat grid row to the engine's Position shape. Only the budgetable
 * fields carry through; identity/sync fields the engine ignores are stubbed.
 * Used to run the same vacation valuation the budget applies against rows the
 * user is still editing, without a round-trip to the store.
 */
export function rowToEnginePosition(
  row: PositionRow,
  scenarioId: string,
  /** The hotel-year full-time yardstick FTE is measured against. Omitted (or
   *  unloaded) leaves FTE at 0 — fine for callers that only value vacation, but
   *  runLiveSim must pass it or an FTE-based pool spread reads zero. */
  fullTime: FullTimeReference = EMPTY_FULL_TIME_REFERENCE
): Position {
  const position: Position = {
    id: row.id as PositionId,
    scenarioId: scenarioId as ScenarioId,
    departmentCode: typeof row.departmentCode === "string" ? row.departmentCode : "",
    jobTypeCode: typeof row.jobTypeCode === "string" ? row.jobTypeCode : "",
    // Raw stored cluster ID and a per-unit weight. The liveSim overlays the
    // resolved cluster NAME + this hotel's weight (see runLiveSim) — kept out
    // of here so vacationCostById stays a per-unit valuation like headcount.
    cluster: typeof row.cluster === "string" ? row.cluster : "",
    hotelClusterWeight: 1,
    payType: (row.payType === "HOURLY" ? "HOURLY" : "SALARIED") as PayType,
    headcount: toNumber(row.headcount, 0),
    // Filled below — deriveFte reads the seasonality/vacation/hours this object
    // is carrying, so it needs the object built first.
    fte: 0,
    seasonality: rowVector(row, "seasonality"),
    monthlyBaseSalary: toNumber(row.monthlyBaseSalary, 0),
    hourlyRate: toNumber(row.hourlyRate, 0),
    additionalMonthlyCosts: rowVector(row, "additionalMonthlyCosts"),
    meritIncreasePct: toNumber(row.meritIncreasePct, 0),
    manualYearlyIncrease: toNumber(row.manualYearlyIncrease, 0),
    increaseMonth: toNumber(row.increaseMonth, 13),
    dailyContractHours: toNumber(row.dailyContractHours, 0),
    yearlyHoursWorked: toNumber(row.yearlyHoursWorked, 0),
    vacationDays: toNumber(row.vacationDays, 0),
    vacationMonthlyWeights: rowVector(row, "vacationMonthlyWeights"),
    // Accrual is ALWAYS computed — the accrual account decides whether the line
    // is POSTED, not whether it is calculated. Mirror in loadScenarioInput.
    // The engine reads this as an on/off guard only (nonzero = accrue): the
    // roll-forward derives its own earning leg from the leave actually taken,
    // so the magnitude here is not the rate. See the ACCRUAL op in opcodes.ts.
    accrualDaysPerMonth: toNumber(row.vacationDays, 0) / 12,
    updatedAt: "",
    deletedAt: null,
  };
  // Derived, never stored — the row's Contract columns measured against the
  // hotel's full-timer. Mirror of loadScenarioInput; the grid's FTE column shows
  // this same number via fteById.
  position.fte = resolveFte(position, row, fullTime);
  return position;
}

/**
 * Full-year simulated vacation cost per row id, using the engine's own
 * valuation (reference.ts, mirrored bit-for-bit by the VM the budget runs).
 * Recompute whenever rows or the calendar change; the grid's Vacation Cost
 * column reads straight from this map. `null` calendar (still loading) yields an
 * empty map, so the column shows blank until the day basis is known.
 */
export function vacationCostById(
  rows: PositionRow[],
  calendar: CalendarContext | null,
  scenarioId: string
): Map<string, number> {
  const out = new Map<string, number>();
  if (!calendar) return out;
  for (const row of rows) {
    const months = referenceVacation(rowToEnginePosition(row, scenarioId), calendar);
    let total = 0;
    for (const value of months) total += value;
    out.set(row.id, total);
  }
  return out;
}

/**
 * Auto-derived Manhours Worked per row id — (Σ net productive days − vacation)
 * × daily hours — for the grid to display when the field carries no manual
 * override. Uses the same helper the engine-input paths use, so the shown
 * number equals what the simulation spreads. Empty map while the calendar
 * loads (the column then falls back to any stored override, else blank).
 */
export function manhoursWorkedById(
  rows: PositionRow[],
  calendar: CalendarContext | null,
  scenarioId: string
): Map<string, number> {
  const out = new Map<string, number>();
  if (!calendar) return out;
  for (const row of rows) {
    out.set(
      row.id,
      deriveYearlyHoursWorked(rowToEnginePosition(row, scenarioId), calendar)
    );
  }
  return out;
}

/**
 * Derived FTE per row id, for the grid's read-only FTE column. Kept out of
 * COMPUTES because the denominator is a hotel-year constant, not a row value —
 * same reason Vacation Cost is a ctx map. A reference that hasn't loaded yet
 * yields 0 for every row, so the column reads blank rather than wrong.
 */
export function fteById(
  rows: PositionRow[],
  fullTime: FullTimeReference | null
): Map<string, number> {
  const out = new Map<string, number>();
  if (!fullTime) return out;
  for (const row of rows) {
    out.set(row.id, rowToEnginePosition(row, "", fullTime).fte);
  }
  return out;
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

/** Hours paid across the year: paid days (yearly days − days off) × daily hours. */
function yearlyManhoursPaidOf(row: PositionRow): number {
  return (
    (toNumber(row.contractYearlyDays, 0) - toNumber(row.contractDaysOff, 0)) *
    toNumber(row.dailyContractHours, 0)
  );
}

/**
 * Effective monthly base used by the preview computes. Fixed Monthly Basic, or —
 * when an Hourly Rate drives the row — an equivalent per-active-month figure
 * (rate × yearly manhours ÷ working months) so Full Year / Budget Year previews
 * don't read 0 in hourly mode. This is a row-only approximation; the engine's
 * realDays-weighted result (reference.ts) is authoritative.
 */
function effectiveMonthlyBase(row: PositionRow, seasTotal: number): number {
  const hourly = toNumber(row[BASIC_SALARY_HOURLY_KEY], 0);
  if (hourly > 0) {
    return seasTotal > 0 ? (hourly * yearlyManhoursPaidOf(row)) / seasTotal : 0;
  }
  return toNumber(row[BASIC_SALARY_MONTHLY_KEY], 0);
}

export const COMPUTES: Record<string, ComputeFn> = {
  totalWorkingMonths: (row) => sumVector(row, "seasonality"),

  vacationWeightsTotal: (row) => sumVector(row, "vacationMonthlyWeights"),

  /** Monthly holiday-accrual entitlement: Yearly Days ÷ WORKING months, not ÷ 12.
   *  The engine earns the provision across the months the position actually works
   *  (a 9-month post earns its entitlement in 9), so dividing by 12 would under-
   *  report the rate for a seasonal row. Identical for a full-year row. Read-only,
   *  and always calculated — the Accrual account decides only whether the
   *  resulting line is POSTED (see rowToEnginePosition / loadScenarioInput). */
  accrualDaysPerMonth: (row) => {
    const workingMonths = sumVector(row, "seasonality");
    return workingMonths > 0 ? toNumber(row.vacationDays, 0) / workingMonths : 0;
  },

  /** Σ of the twelve Additional Cost months — the summary the family collapses
   *  behind (see COLLAPSIBLE_MONTH_FAMILIES). Deliberately the raw sum, NOT the
   *  seasonality-weighted figure Full Year Wage adds: this column stands in for
   *  the twelve cells while they are hidden, so it has to equal what you would
   *  read across them. What those entries actually cost is Full Year Wage's job. */
  additionalCostsTotal: (row) => sumVector(row, "additionalMonthlyCosts"),

  /** Gross yearly wage before increases: base × working months + seasonal
   *  additional costs (matches Σ grossBase with no increase applied). In hourly
   *  mode the base is derived from rate × manhours (see effectiveMonthlyBase). */
  fullYearWage: (row) => {
    const seasTotal = sumVector(row, "seasonality");
    let total = effectiveMonthlyBase(row, seasTotal) * seasTotal;
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
    const base = effectiveMonthlyBase(row, sumVector(row, "seasonality"));
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

  // vacationEstimate is NOT a row-only compute — its value is the engine's
  // simulated vacation cost, supplied per row id via vacationCostById() and
  // wired in columnFactory. Kept out of COMPUTES so no stale approximation can
  // shadow the authoritative number.

  /** Hours paid across the year: paid days (yearly days − days off) × daily
   *  contract hours. Read-only — replaces the old free-entry column. */
  yearlyManhoursPaid: (row) => yearlyManhoursPaidOf(row),
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
