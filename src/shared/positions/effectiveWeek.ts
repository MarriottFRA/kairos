/**
 * The effective week — the ONE figure Kairos posts to the ledger as the
 * hotel's work week (department D0410, account A988112), and the figure every
 * FTE-from-hours calculation divides by, inside Kairos and outside it.
 *
 * Two weeks, deliberately kept apart:
 *
 *   contract week   what a full-time contract says: 40 hours. Typed once per
 *                   hotel-year on the Home page. Seeds Daily Hours (÷ 5) and is
 *                   the Positions grid's FTE yardstick. Never posted.
 *   effective week  the contract week scaled by the share of the year a
 *                   full-timer actually WORKS once vacation and public holidays
 *                   are out: 40h × 234 worked days ÷ 260 = 36.0h. Posted, and
 *                   read back by every report as `weekly_hours`.
 *
 * Why the ledger needs the second one: the company's reports (and the
 * staffing catalog here) read FTE as hours ÷ (A988112 × 52). The hours Kairos
 * posts per position are hours WORKED — net of that position's own vacation
 * and public holidays — so dividing them by a gross 40 × 52 = 2,080 reads a
 * full-timer as 0.90 FTE. The Positions grid never had that problem: it
 * derives FTE as worked hours over a full-timer's worked hours, vacation
 * cancelling on both sides (engineInput.deriveFte). The effective week is the
 * grid's yardstick restated in the ledger's unit: with it, hours ÷ (week × 52)
 * is exactly worked hours ÷ a full-timer's worked hours.
 *
 * "A full-timer's vacation" has no standard — the company adds a day a year,
 * then one per few years — so the yardstick takes the ROSTER'S average: the
 * FTE-weighted mean vacation entitlement of the scenario's hours-driven
 * positions (managers are counted by head on the ledger, so their leave is
 * not in the hours side; Buyout Labour is bought in, not staffed). No
 * positions, or no vacation typed, and the average is 0.
 *
 * Derived, never typed: it moves as positions and entitlements are added, so
 * it is computed at run time from the positions about to be posted, and the
 * Home page shows the same derivation live, with its working.
 *
 * Pure module. Shared by the run (outputsRepo.projectSetupLines), the report
 * fallback (main/reports/evaluate.ts), the Home page and the FTE reconciliation.
 */

import { MONTHS } from "../engine/types";
import type { FullTimeReference } from "../positionDefaults";
import { WORKING_DAYS_PER_WEEK } from "../positionDefaults";
import { BUYOUT_JOB_TYPE, HEADCOUNT_ACCOUNT_BY_JOB_TYPE } from "./systemAccounts";

// A leaf on purpose: the staffing catalog (shared/reports) re-exports
// WEEKS_PER_YEAR from here, so nothing under shared/reports may be imported
// here or the catalog evaluates before the constant exists.

/** The ledger's year: hours ÷ (week × 52) everywhere outside Kairos. */
export const WEEKS_PER_YEAR = 52;

/** The grades the ledger counts by HEAD (their heads post to A988101 /
 *  A988113 — staffing.ts MANAGER_FTE_ACCOUNTS); their hours are not FTE. */
const MANAGER_JOB_TYPES: ReadonlySet<string> = new Set(["Manager", "Manager (Non Exempt)"]);
// Pinned to the account table the catalog reads, so the two lists cannot drift.
for (const jobType of MANAGER_JOB_TYPES) {
  if (!(jobType in HEADCOUNT_ACCOUNT_BY_JOB_TYPE)) throw new Error(`effectiveWeek: unknown manager grade ${jobType}`);
}

/** Decimals the posted figure keeps. Excel holds 15 significant digits; a
 *  two-digit week with ten decimals is twelve, well inside it. */
export const EFFECTIVE_WEEK_DECIMALS = 10;

/** What the derivation needs of one active position — the engine's Position
 *  after applyInputBasis, so `vacationDays` is the leave over the months
 *  worked (see annualizedVacation). */
export interface EffectiveWeekPosition {
  jobTypeCode: string;
  headcount: number;
  /** The derived FTE of ONE post (before Count and cluster share). */
  fte: number;
  hotelClusterWeight: number;
  vacationDays: number;
  seasonality: readonly number[];
}

/** The roster's share of the derivation. */
export interface RosterVacation {
  /** FTE-weighted mean annual vacation entitlement of the hours-driven positions. */
  averageVacationDays: number;
  /** The FTE the average was weighted over (Σ fte × count × cluster share). */
  weightedFte: number;
  /** Hours-driven positions that carried weight. */
  positions: number;
}

export const EMPTY_ROSTER_VACATION: RosterVacation = Object.freeze({
  averageVacationDays: 0,
  weightedFte: 0,
  positions: 0,
});

/** The whole working, so the page, the inspector and the reports can show it. */
export interface EffectiveWeekDerivation extends RosterVacation {
  contractWeek: number;
  /** A full-timer's Yearly Days − Days Off − Public Holidays (the hotel-year defaults). */
  productiveDays: number;
  /** Contract week ÷ 5. */
  dailyHours: number;
  /** Productive days − the average vacation: the days a full-timer works. */
  fullTimeDays: number;
  /** fullTimeDays × dailyHours: the hours of one FTE for the year. */
  fullTimeHoursYear: number;
  /** fullTimeHoursYear ÷ 52, rounded to EFFECTIVE_WEEK_DECIMALS. The posted figure. */
  effectiveWeek: number;
}

const finite = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

/**
 * A position's vacation restated over a full year. After applyInputBasis the
 * engine position holds the leave over the months it WORKS (twm/12 of a
 * full-year entitlement, or the contract-sized figure as typed); the yardstick
 * is a full year, so it comes back up by 12 ÷ twm — the same annualization
 * deriveFte applies to its denominator.
 */
export function annualizedVacation(position: Pick<EffectiveWeekPosition, "vacationDays" | "seasonality">): number {
  const seasonality = position.seasonality;
  let twm = MONTHS;
  if (Array.isArray(seasonality) && seasonality.length > 0) {
    twm = 0;
    for (let m = 0; m < MONTHS; m++) twm += finite(seasonality[m]);
  }
  if (twm <= 0) return 0;
  return (finite(position.vacationDays) * MONTHS) / twm;
}

/** True for the positions whose FTE the ledger reads from hours. */
export function isHoursDriven(jobTypeCode: string | null | undefined): boolean {
  const code = (jobTypeCode ?? "").trim();
  return code !== BUYOUT_JOB_TYPE && !MANAGER_JOB_TYPES.has(code);
}

/** The roster's FTE-weighted mean vacation entitlement. */
export function rosterVacation(positions: readonly EffectiveWeekPosition[]): RosterVacation {
  let weighted = 0;
  let weight = 0;
  let count = 0;
  for (const position of positions) {
    if (!isHoursDriven(position.jobTypeCode)) continue;
    const w = finite(position.fte) * finite(position.headcount) * finite(position.hotelClusterWeight);
    if (w <= 0) continue;
    weighted += w * annualizedVacation(position);
    weight += w;
    count += 1;
  }
  return {
    averageVacationDays: weight > 0 ? weighted / weight : 0,
    weightedFte: weight,
    positions: count,
  };
}

export function roundEffectiveWeek(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(EFFECTIVE_WEEK_DECIMALS));
}

/**
 * The effective week for a contract week, a full-time yardstick and a roster
 * average. Non-positive inputs (a hotel that has not finished its setup, a
 * yardstick with no days) derive 0, which projectSetupLines posts as nothing.
 */
export function effectiveWeekOf(
  contractWeek: number,
  reference: Pick<FullTimeReference, "productiveDays">,
  roster: RosterVacation = EMPTY_ROSTER_VACATION
): EffectiveWeekDerivation {
  const week = finite(contractWeek);
  const productiveDays = Math.max(0, finite(reference?.productiveDays));
  const dailyHours = week > 0 ? week / WORKING_DAYS_PER_WEEK : 0;
  const fullTimeDays = Math.max(0, productiveDays - Math.max(0, finite(roster.averageVacationDays)));
  const fullTimeHoursYear = fullTimeDays * dailyHours;
  return {
    ...roster,
    contractWeek: week,
    productiveDays,
    dailyHours,
    fullTimeDays,
    fullTimeHoursYear,
    effectiveWeek: roundEffectiveWeek(fullTimeHoursYear / WEEKS_PER_YEAR),
  };
}

/** The whole derivation off a scenario's positions. */
export function deriveEffectiveWeek(
  contractWeek: number,
  reference: Pick<FullTimeReference, "productiveDays">,
  positions: readonly EffectiveWeekPosition[]
): EffectiveWeekDerivation {
  return effectiveWeekOf(contractWeek, reference, rosterVacation(positions));
}

const fmt = (value: number, decimals = 1): string =>
  value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });

/** The working in one line, the same everywhere it is shown. */
export function describeEffectiveWeek(d: EffectiveWeekDerivation): string {
  const roster =
    d.positions > 0
      ? `${fmt(d.averageVacationDays)} days' vacation on average across ${d.positions} hours-driven position${d.positions === 1 ? "" : "s"} (FTE-weighted)`
      : "no vacation to average (no hours-driven positions yet)";
  return (
    `(${fmt(d.productiveDays)} productive days − ${fmt(d.averageVacationDays)} vacation) × ${fmt(d.dailyHours, 2)}h a day` +
    ` = ${fmt(d.fullTimeHoursYear)} hours a year ÷ ${WEEKS_PER_YEAR} weeks = ${fmt(d.effectiveWeek, 2)}h. ` +
    `Contract week ${fmt(d.contractWeek, 2)}h; ${roster}.`
  );
}
