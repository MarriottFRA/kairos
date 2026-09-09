/**
 * Staffing — hours and FTE, the lines PS Loader never had. Rows 10–11 of
 * the workbook's Payroll FTE tab.
 *
 * Manhours are level_1 "Statistics" × level_4 "Total Manhours" on the maps,
 * the workbook's definition; that covers every hours account Kairos posts
 * (A988xxx) on either source once the maps are synced.
 *
 * FTE (decided 2026-09-09) is driven by HOURS, with one exception:
 *
 *   - a MANAGER counts as their headcount. The two manager grades book
 *     their heads on A988101 / A988113 (systemAccounts) and their hours on
 *     the "Manager Hours" accounts, which the hours line below leaves out;
 *     a manager on the books all year is 1 FTE whatever they work.
 *   - everyone else is their hours ÷ the hours of a full-timer. The hours
 *     are the map's "Total Manhours excl Overtime and Manager Hours" ×
 *     "Man Hours" node: staff hours less overtime, manager hours and
 *     bought-in labour.
 *
 * The full-timer's hours come from the EFFECTIVE week the budget itself
 * reports — department D0410, account A988112, posted in January only — as
 * the built-in param `weekly_hours` (main resolves it per column, falling
 * back to the scenario year's figure, then to a derivation from the
 * scenario's positions, then to the hotel-year setup alone), × `fte_weeks`:
 * 52 ÷ 12 a month, 52 for the year. The effective week is the contract week
 * scaled by the days a full-timer works once vacation and public holidays
 * are out (shared/positions/effectiveWeek.ts), so hours ÷ (week × 52) is
 * worked hours ÷ a full-timer's worked hours — the Positions grid's own
 * FTE, restated in the ledger's unit. A 40-hour contract with 26 days off
 * posts 36.0h, 156 hours a month and 1,872 for the year; FTE reads as FTE
 * in every slot, the Total being the year's average.
 *
 * Both parts are LEVEL-shaped in the Total: a level's year figure is the
 * mean of its months (`mean`), and hours ÷ the year's hours is already an
 * average. The Positions grid derives FTE from each contract instead; the
 * "FTE reconciliation" report sets the two side by side.
 *
 * Annualising: `avg_annual_wage_per_fte` is the workbook's "Total Average
 * Annual Wage by FTE" — a month's wage per FTE × 12, and the year's wage per
 * average FTE in the Total. `annualise` is the param that says so: 12 in
 * every month slot, 1 in the Total.
 */

import { DEFAULT_WEEKLY_HOURS } from "../../positionDefaults";
import { WEEKS_PER_YEAR } from "../../positions/effectiveWeek";
import { HEADCOUNT_ACCOUNT_BY_JOB_TYPE } from "../../positions/systemAccounts";
import type { AtomFilter, Measure, ReportParam } from "../types";
import { ACC, CatalogGroup, accBase, accLevel, atom, costMeasure, measure } from "./helpers";
import { PAYROLL } from "./payroll";

/** The headcount accounts whose heads ARE their FTE: the two manager grades.
 *  The supervisor account (A988102) is not one — supervisors are hours-driven. */
export const MANAGER_FTE_ACCOUNTS: readonly string[] = [
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE.Manager,
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE["Manager (Non Exempt)"],
];

/** The account-side filters of the hours that drive FTE. */
export const FTE_HOURS_FILTERS: readonly AtomFilter[] = [
  accLevel(4, ACC.totalManhours),
  accLevel(6, ACC.manhoursExclOvertimeAndManagers),
  accLevel(9, ACC.manHours),
];

export { WEEKS_PER_YEAR };

export const WEEKLY_HOURS_PARAM: ReportParam = {
  id: "weekly_hours",
  label: "Effective work week (hours)",
  default: { months: new Array<number>(12).fill(DEFAULT_WEEKLY_HOURS), total: DEFAULT_WEEKLY_HOURS },
  builtin: "weekly_hours",
  unit: "hours",
};

export const FTE_WEEKS_PARAM: ReportParam = {
  id: "fte_weeks",
  label: "Weeks a full-timer works (per month, and for the year)",
  default: { months: new Array<number>(12).fill(WEEKS_PER_YEAR / 12), total: WEEKS_PER_YEAR },
  unit: "weeks",
};

/** Hours of one full-time equivalent: a month's in each month, the year's in the Total. */
export const FTE_HOURS_MEASURE: Measure = measure("fte_hours", "weekly_hours * fte_weeks", "number", "Hours per FTE");

/** The FTE formula for a manager-heads atom and an FTE-hours atom. */
export function fteFormula(managerHeadsAtom: string, fteHoursAtom: string): string {
  return `mean(${managerHeadsAtom}) + div(${fteHoursAtom}, ${FTE_HOURS_MEASURE.id})`;
}

export const STAFFING: CatalogGroup = {
  id: "staffing",
  requires: [PAYROLL],
  params: [
    WEEKLY_HOURS_PARAM,
    FTE_WEEKS_PARAM,
    {
      id: "annualise",
      label: "Annualising factor (12 per month, 1 for the year)",
      default: { months: new Array<number>(12).fill(12), total: 1 },
    },
  ],
  atoms: [
    atom("manhours", "Total manhours (Statistics × Total Manhours)", accLevel(1, ACC.statistics), accLevel(4, ACC.totalManhours)),
    atom(
      "fte_hours_worked",
      "Hours that drive FTE (Total Manhours excl Overtime and Manager Hours × Man Hours)",
      ...FTE_HOURS_FILTERS
    ),
    atom("manager_heads", "Manager heads (A988101, A988113)", accBase(...MANAGER_FTE_ACCOUNTS)),
  ],
  measures: [
    measure("manhours_line", "manhours", "number", "Total Manhours"),
    FTE_HOURS_MEASURE,
    measure("manager_fte", "mean(manager_heads)", "ratio", "Manager FTE (heads)"),
    measure("hourly_fte", `div(fte_hours_worked, ${FTE_HOURS_MEASURE.id})`, "ratio", "Hours-driven FTE"),
    measure("total_fte", fteFormula("manager_heads", "fte_hours_worked"), "ratio", "Total FTE"),
    costMeasure("avg_annual_wage_per_fte", "div(total_wages, total_fte) * annualise", "rate", "Total Average Annual Wage by FTE"),
    costMeasure("payroll_per_fte", "div(total_payroll, total_fte) * annualise", "rate", "Annual Payroll per FTE"),
    measure("hours_per_fte_line", FTE_HOURS_MEASURE.id, "number", "Hours per FTE"),
    measure("fte_hours_worked_line", "fte_hours_worked", "number", "Hours driving FTE"),
  ],
};
