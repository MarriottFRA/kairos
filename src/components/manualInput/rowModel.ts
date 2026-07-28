/**
 * Manual-input row model — conversion between the stored ManualInputRow and the
 * flat grid row the DataGrid edits, plus the derived amounts / totals and the
 * spread math.
 *
 * The grid row explodes the two 12-month vectors into flat keys (`stat_1..stat_12`,
 * `amt_1..amt_12`) so each month cell edits and pastes independently, mirroring
 * the positions `sea_1..12` convention. "Stats" are the operational units (hours,
 * covers, room nights…). Amount is derived (stats * rate) when a rate is present,
 * so the amt cells read-only then; otherwise the stored amt is authoritative and
 * typeable.
 */

import { daysInMonth } from "../../shared/calendar";
import {
  MANUAL_INPUT_NO_INCREASE_MONTH,
  MANUAL_INPUT_PERIOD_COUNT,
  ManualInputRow,
  ManualInputRowId,
  ManualInputRowInput,
  SpreadMode,
} from "../../shared/manualInput/ipc";
import {
  isRateDriven as isRateDrivenRate,
  manualAmountForMonth,
  num,
} from "../../shared/manualInput/rowMath";

export interface ManualGridRow {
  id: string;
  description: string;
  department: string;
  departmentCode: string;
  costAccount: string;
  statsAccount: string;
  rate: number | null;
  /** "" = not configured; drives the Apply-spread action. */
  spreadMode: SpreadMode | "";
  /** Base spread into Stats; null when unset. */
  spreadBaseStats: number | null;
  /** Base spread into Amount; null when unset (ignored while rate-driven). */
  spreadBaseAmount: number | null;
  increasePct: number;
  increaseMonth: number;
  /** stat_1..stat_12 and amt_1..amt_12 live here. */
  [monthKey: string]: unknown;
}

export const statsKey = (month: number) => `stat_${month}`;
export const amountKey = (month: number) => `amt_${month}`;

// The amount rule itself lives in shared/manualInput/rowMath.ts — the main
// process derives the same number when it projects manual rows into the
// persisted results, and two copies would eventually disagree. These are the
// grid-row-shaped wrappers over it.
export { num };

/** Whether a row's monthly amounts are derived from a rate (vs. typed). */
export function isRateDriven(row: ManualGridRow): boolean {
  return isRateDrivenRate(row.rate);
}

/** The amount shown for a month: stats*rate when rate-driven, else the typed amt. */
export function amountForMonth(row: ManualGridRow, month: number): number {
  return manualAmountForMonth(
    row.rate,
    row[statsKey(month)],
    row[amountKey(month)]
  );
}

export function totalStats(row: ManualGridRow): number {
  let sum = 0;
  for (let m = 1; m <= MANUAL_INPUT_PERIOD_COUNT; m++) sum += num(row[statsKey(m)]);
  return sum;
}

export function totalAmount(row: ManualGridRow): number {
  let sum = 0;
  for (let m = 1; m <= MANUAL_INPUT_PERIOD_COUNT; m++) sum += amountForMonth(row, m);
  return sum;
}

/** Storage row -> flat grid row. */
export function toGridRow(row: ManualInputRow): ManualGridRow {
  const grid: ManualGridRow = {
    id: row.id,
    description: row.description,
    department: row.department,
    departmentCode: row.departmentCode,
    costAccount: row.costAccount,
    statsAccount: row.statsAccount,
    rate: row.rate,
    spreadMode: row.spreadMode ?? "",
    spreadBaseStats: row.spreadBaseStats,
    spreadBaseAmount: row.spreadBaseAmount,
    increasePct: row.increasePct,
    increaseMonth: row.increaseMonth,
  };
  for (let m = 1; m <= MANUAL_INPUT_PERIOD_COUNT; m++) {
    grid[statsKey(m)] = row.stats[m - 1] ?? 0;
    grid[amountKey(m)] = row.amounts[m - 1] ?? 0;
  }
  return grid;
}

/** Flat grid row -> save payload. */
export function toInput(row: ManualGridRow): ManualInputRowInput {
  const stats: number[] = [];
  const amounts: number[] = [];
  for (let m = 1; m <= MANUAL_INPUT_PERIOD_COUNT; m++) {
    stats.push(num(row[statsKey(m)]));
    amounts.push(num(row[amountKey(m)]));
  }
  const rate = baseOrNull(row.rate);
  return {
    id: row.id as ManualInputRowId,
    description: String(row.description ?? ""),
    department: String(row.department ?? ""),
    departmentCode: String(row.departmentCode ?? ""),
    costAccount: String(row.costAccount ?? ""),
    statsAccount: String(row.statsAccount ?? ""),
    rate,
    stats,
    amounts,
    spreadMode: row.spreadMode === "" ? null : row.spreadMode,
    spreadBaseStats: baseOrNull(row.spreadBaseStats),
    spreadBaseAmount: baseOrNull(row.spreadBaseAmount),
    increasePct: num(row.increasePct),
    increaseMonth: Number(row.increaseMonth) || MANUAL_INPUT_NO_INCREASE_MONTH,
  };
}

/** A blank/non-finite value becomes null; otherwise the finite number. */
function baseOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A fresh, empty grid row. */
export function emptyGridRow(id: string): ManualGridRow {
  const grid: ManualGridRow = {
    id,
    description: "",
    department: "",
    departmentCode: "",
    costAccount: "",
    statsAccount: "",
    rate: null,
    spreadMode: "",
    spreadBaseStats: null,
    spreadBaseAmount: null,
    increasePct: 0,
    increaseMonth: MANUAL_INPUT_NO_INCREASE_MONTH,
  };
  for (let m = 1; m <= MANUAL_INPUT_PERIOD_COUNT; m++) {
    grid[statsKey(m)] = 0;
    grid[amountKey(m)] = 0;
  }
  return grid;
}

/** Distribution weights (sum 1) for a spread mode across the 12 months. */
function spreadWeights(mode: SpreadMode, year: number): number[] {
  if (mode === "daysInMonth") {
    const days = Array.from({ length: MANUAL_INPUT_PERIOD_COUNT }, (_, i) =>
      daysInMonth(year, i + 1)
    );
    const total = days.reduce((a, b) => a + b, 0) || 1;
    return days.map((d) => d / total);
  }
  // flat
  return new Array<number>(MANUAL_INPUT_PERIOD_COUNT).fill(
    1 / MANUAL_INPUT_PERIOD_COUNT
  );
}

/**
 * Fill a row's month cells from its inline spread config. Fill-once: the values
 * are written into the target vectors, which stay hand-editable afterwards. The
 * Stats base fills the Stats cells and the Amount base fills the Amount cells,
 * both distributed by the shared mode. The Increase % escalates ONLY the Amount
 * side (from its month on) — a dollar escalation, not a units one — so the Stats
 * spread is always flat over the mode's weights. Only a side with a base set
 * (non-null) is touched, so an unused base leaves that vector alone. The Amount
 * base is skipped for rate-driven rows — a typed monthly Amount would be
 * overwritten by the derived stats*rate value anyway. A no-op when no mode is set.
 */
export function applySpread(row: ManualGridRow, year: number): ManualGridRow {
  const mode = row.spreadMode;
  if (mode !== "flat" && mode !== "daysInMonth") return row;

  const weights = spreadWeights(mode, year);
  const incMonth = Number(row.increaseMonth) || MANUAL_INPUT_NO_INCREASE_MONTH;
  const pct = num(row.increasePct);

  const next: ManualGridRow = { ...row };
  const fill = (
    keyFor: (month: number) => string,
    base: number,
    escalate: boolean
  ) => {
    for (let m = 1; m <= MANUAL_INPUT_PERIOD_COUNT; m++) {
      const mul = escalate && incMonth <= 12 && m >= incMonth ? 1 + pct : 1;
      next[keyFor(m)] = base * weights[m - 1] * mul;
    }
  };

  if (row.spreadBaseStats != null) fill(statsKey, num(row.spreadBaseStats), false);
  if (row.spreadBaseAmount != null && !isRateDriven(row)) {
    fill(amountKey, num(row.spreadBaseAmount), true);
  }
  return next;
}
