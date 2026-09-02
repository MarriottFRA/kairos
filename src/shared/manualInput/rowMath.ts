/**
 * The manual-input derivation rules — the ONE definition of what a manual row
 * is worth in a given month, on both sides:
 *
 *   amount rule: rate set   => amount[m] = stats[m] * rate, else typed amount
 *   stats rule:  KPI driver => stats[m]  = series[m] / divisor * factor, else
 *                typed stats
 *
 * This used to live only in the renderer's rowModel.ts, which was fine while
 * manual rows were a page unto themselves. Now they project into the persisted
 * engine output (see main/positions/outputsRepo.ts), so the main process has to
 * derive the same number the grid shows — and two copies of this rule would
 * eventually disagree about what a hotel's budget is.
 *
 * Deliberately just the rules. `applySpread` stays in the renderer: it is a
 * fill-once helper that writes into the stored 12-month vectors (baking
 * increasePct in as it goes), so by the time a row is persisted the vectors are
 * authoritative for every side that is not derived. A KPI-driven Stats side is
 * the exception the same way a rate-driven Amount side always was: the stored
 * vector is only a snapshot, and display/projection re-derive from the KPI
 * cache so a fresh budget pull flows through without touching the row.
 *
 * Electron-free and dependency-free so both sides and the tests can import it.
 */

import { MANUAL_INPUT_PERIOD_COUNT, normalizeMonthVector } from "./ipc";

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

//------------------------------------------------------------------------------
//--- The stats rule: KPI-driven monthly stats ---------------------------------

/**
 * Whether a row's monthly stats are derived from a KPI driver rather than
 * typed. A null/blank driver id means "no driver" — the typed Stats win.
 */
export function isKpiStatsDriven(driverId: unknown): boolean {
  return typeof driverId === "string" && driverId.trim() !== "";
}

/**
 * The slice of a KPI driver's cached series this module needs. Structurally
 * identical to positions/engineInput's KpiSeriesSlice (deptKey '*' = the
 * EXPLICIT-mode series; POSITION mode caches one slice per department) —
 * retyped locally so this file stays dependency-free.
 */
export interface ManualKpiSeriesSlice {
  deptKey: string;
  values: number[];
}

/**
 * Pick the series slice that applies to a row: the EXPLICIT '*' slice when
 * present, else the slice matching the row's department code — the same
 * precedence the engine uses for KPI-driven blocks (engineInput.injectKpiSeries).
 * Returns zeros when slices exist but none match (the driver genuinely has
 * nothing for this department), and null when there is nothing to resolve from
 * at all (driver deleted, or no budget pulled on this machine) so the caller
 * can fall back to the stored stats snapshot.
 */
export function resolveManualStatsSeries(
  slices: ManualKpiSeriesSlice[] | null | undefined,
  departmentCode: string
): number[] | null {
  if (!slices || slices.length === 0) return null;
  const match =
    slices.find((slice) => slice.deptKey === "*") ??
    slices.find((slice) => slice.deptKey === departmentCode);
  if (!match) return new Array<number>(MANUAL_INPUT_PERIOD_COUNT).fill(0);
  return normalizeMonthVector(match.values);
}

/**
 * One derived stat: seriesValue / divisor * factor ("20 hours per 50,000" =>
 * factor 20, divisor 50000). A missing or non-positive divisor yields 0 —
 * deterministic and immediately visible, rather than NaN poisoning the row.
 */
export function manualStatForMonth(
  divisor: unknown,
  factor: unknown,
  seriesValue: unknown
): number {
  const per = num(divisor);
  if (per <= 0) return 0;
  return (num(seriesValue) / per) * num(factor);
}

/** The minimum of a stored manual row the stats rule needs. */
export interface ManualStatsSource {
  statsKpiDriverId: string | null;
  statsKpiDivisor: number | null;
  statsKpiFactor: number | null;
  departmentCode: string;
  /** The stored vector — the fallback snapshot when the driver can't resolve. */
  stats: number[];
}

/** Cached slices for a driver id, or null when the driver is unknown. */
export type ManualStatsSeriesLookup = (
  driverId: string
) => ManualKpiSeriesSlice[] | null;

/**
 * All 12 stats for a stored row, Jan..Dec: derived from the KPI series when
 * the row is KPI-driven and the series resolves, else the stored stats
 * verbatim — the last baked snapshot, so nothing jumps to zero when a driver
 * disappears or this machine has never pulled a budget.
 */
export function manualMonthlyStats(
  row: ManualStatsSource,
  lookup: ManualStatsSeriesLookup | null | undefined
): number[] {
  const stored = normalizeMonthVector(row.stats);
  if (!isKpiStatsDriven(row.statsKpiDriverId) || !lookup) return stored;
  const series = resolveManualStatsSeries(
    lookup(String(row.statsKpiDriverId).trim()),
    row.departmentCode
  );
  if (!series) return stored;
  const out = new Array<number>(MANUAL_INPUT_PERIOD_COUNT);
  for (let m = 0; m < MANUAL_INPUT_PERIOD_COUNT; m++) {
    out[m] = manualStatForMonth(
      row.statsKpiDivisor,
      row.statsKpiFactor,
      series[m]
    );
  }
  return out;
}

/**
 * Rows with `stats` replaced by their derived values — the pre-pass that lets
 * downstream consumers (projectManualLines, manualMonthlyAmounts) stay
 * KPI-unaware. Non-driven rows come back by reference, untouched.
 */
export function resolveManualRowStats<T extends ManualStatsSource>(
  rows: T[],
  lookup: ManualStatsSeriesLookup
): T[] {
  return rows.map((row) =>
    isKpiStatsDriven(row.statsKpiDriverId)
      ? { ...row, stats: manualMonthlyStats(row, lookup) }
      : row
  );
}
