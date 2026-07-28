/**
 * The manual-input amount rule — the ONE definition of what a manual row is
 * worth in a given month.
 *
 * This used to live only in the renderer's rowModel.ts, which was fine while
 * manual rows were a page unto themselves. Now they project into the persisted
 * engine output (see main/positions/outputsRepo.ts), so the main process has to
 * derive the same number the grid shows — and two copies of this rule would
 * eventually disagree about what a hotel's budget is.
 *
 * Deliberately just the rule. `applySpread` stays in the renderer: it is a
 * fill-once helper that writes into the stored 12-month vectors (baking
 * increasePct in as it goes), so by the time a row is persisted the vectors are
 * already authoritative and nothing downstream re-derives them.
 *
 * Electron-free and dependency-free so both sides and the tests can import it.
 */

import { MANUAL_INPUT_PERIOD_COUNT } from "./ipc";

/** Coerce anything to a finite number, else 0. */
export function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether a row's monthly amounts are derived from a rate rather than typed.
 * A rate of 0 (or null/blank) means "no rate" — the typed Amount wins.
 */
export function isRateDriven(rate: unknown): boolean {
  return num(rate) > 0;
}

/**
 * The amount for one month: stats × rate when rate-driven, else the typed
 * amount. Takes the three scalars rather than a row so the renderer's flat grid
 * row (`stat_1`…`amt_12`) and the stored row (`stats[]`/`amounts[]`) can both
 * feed it without either shape leaking into the other.
 */
export function manualAmountForMonth(
  rate: unknown,
  statValue: unknown,
  amountValue: unknown
): number {
  return isRateDriven(rate) ? num(statValue) * num(rate) : num(amountValue);
}

/** The minimum of a stored manual row this module needs. */
export interface ManualAmountSource {
  rate: number | null;
  stats: number[];
  amounts: number[];
}

/** All 12 derived amounts for a stored row, Jan..Dec. */
export function manualMonthlyAmounts(row: ManualAmountSource): number[] {
  const out = new Array<number>(MANUAL_INPUT_PERIOD_COUNT);
  for (let m = 0; m < MANUAL_INPUT_PERIOD_COUNT; m++) {
    out[m] = manualAmountForMonth(row.rate, row.stats?.[m], row.amounts?.[m]);
  }
  return out;
}
