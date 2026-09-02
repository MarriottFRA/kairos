/**
 * System-owned account codes and the stat-vs-cost rule.
 * -----------------------------------------------------------
 * These are shared because both sides of the app need them and neither can
 * import the other: the field seed and the grid live in the renderer, the
 * definition seeding and the output projection live in main. Stating them once
 * here is what stops the two from forking (which is exactly how
 * `isStatsAccount` came to test an unprefixed "9" while every stored code
 * carries the "A").
 */

import { AccountFilter } from "./fields";

/**
 * The account the universal position-count head books to — VBA Engine §21
 * "Stats Position Count". Pinned, not user-selectable: every scenario books its
 * heads here so a hotel can never silently fail to report headcount, whatever
 * the per-row Headcount account is set to. Surfaced read-only on the Positions
 * grid as the "HC Stats" column so the A972540 rows in Results are traceable.
 * The one Classification exempt from the pin is Buyout Labour — see
 * positionCountAccountForJobType.
 */
export const POSITION_COUNT_ACCOUNT = "A972540";

/**
 * The Classification whose rows are bought in rather than staffed. Its Count is
 * a quantity of purchased labour, not heads, so it must not inflate A972540.
 */
export const BUYOUT_JOB_TYPE = "Buyout Labour";

/**
 * The account the pinned position-count head posts for a row's Classification —
 * POSITION_COUNT_ACCOUNT for every grade (a blank/unknown grade included: an
 * unclassified row must still report its heads), and "" for Buyout Labour,
 * whose Count is not a headcount. "" carries the usual blank-account contract
 * (calculate, don't post), and is also what the read-only HC Stats cell shows
 * for the row, so the grid and Results agree on where the count went.
 */
export function positionCountAccountForJobType(jobTypeCode: unknown): string {
  if (typeof jobTypeCode === "string" && jobTypeCode.trim() === BUYOUT_JOB_TYPE) {
    return "";
  }
  return POSITION_COUNT_ACCOUNT;
}

/**
 * Where the hotel's Weekly Hours setting reports — the standard full-time
 * contract, posted as a statistic rather than kept as a private yardstick.
 *
 * Weekly Hours is entered once per hotel-year on the Home page and until now
 * only ever fed the FTE denominator (see positionDefaults.fullTimeReference).
 * It is also a number the budget has to REPORT, and it reports to one fixed
 * place, so both codes are pinned here rather than made selectable: there is no
 * per-hotel judgement to make, and a picker would only create a way to get it
 * wrong.
 *
 * A988112 is inside STATS_ACCOUNT_FILTER (and STAFFING_ACCOUNT_FILTER), which
 * is what makes the row land under the Results page's Statistics toggle and
 * push to the BST in actual units rather than thousands.
 */
export const WEEKLY_HOURS_STAT_DEPARTMENT = "D0410";
export const WEEKLY_HOURS_STAT_ACCOUNT = "A988112";

/**
 * Statistics accounts: counts, hours, FTE — non-currency lines. Everything else
 * is a cost. Carried over from the workbook, where the leading 9 marked a stats
 * account; codes are stored with the "A" prefix this app normalizes to (see
 * budgetImport/parseWorkbook), so the prefix is "A9", not "9".
 *
 * The single source for the split: the Results page's Costs/Statistics toggle,
 * and the headcount/hours account pickers, all resolve membership through
 * `accountAllowed` against this filter.
 */
export const STATS_ACCOUNT_FILTER: AccountFilter = { startsWith: ["A9"] };

/**
 * Staffing statistics: the A988… family the per-grade heads and hours book to.
 *
 * A narrowing of the stats range, not a second definition of it — everything
 * here is still a statistics account by STATS_ACCOUNT_FILTER. It scopes the
 * Working Hours picker (the one staffing account a user may still choose) and is
 * the range the two per-grade tables below must stay inside.
 */
export const STAFFING_ACCOUNT_FILTER: AccountFilter = { startsWith: ["A988"] };

/**
 * The headcount statistics account each Classification books to.
 *
 * The per-row Headcount account used to be a free pick over every A9… account,
 * which made it a data-entry question with one right answer: the grade decides
 * the account, always. So it is derived instead — the grid shows it as a
 * calculated column and nothing stores it (seed v26).
 *
 * A grade that is ABSENT here has no headcount account, deliberately: Associate
 * and Casual report their heads only through the pinned POSITION_COUNT_ACCOUNT
 * head, and Buyout Labour reports no heads at all (its position-count posting is
 * suppressed too — see positionCountAccountForJobType). A blank account makes
 * the per-row headcount line
 * compile with the (equally blank) account its definition carries, and the
 * output projection drops blank-account lines — so nothing is posted, which is
 * the intent. Keys must be values of JOB_TYPE_OPTIONS (fieldSeed); a test pins
 * the two together.
 */
export const HEADCOUNT_ACCOUNT_BY_JOB_TYPE: Readonly<Record<string, string>> = {
  Manager: "A988101",
  "Manager (Non Exempt)": "A988113",
  Supervisor: "A988102",
};

/**
 * The headcount account for a Classification — "" for a grade that books none
 * (and for a blank/unknown grade, which must never invent an account).
 */
export function headcountAccountForJobType(jobTypeCode: unknown): string {
  if (typeof jobTypeCode !== "string") return "";
  return HEADCOUNT_ACCOUNT_BY_JOB_TYPE[jobTypeCode.trim()] ?? "";
}

/**
 * The worked-hours account each Classification DEFAULTS to — managers on their
 * own head, everyone else pooled, and nothing for Buyout Labour (whose hours are
 * bought in, not staffed).
 *
 * Unlike the headcount account, this is a starting point rather than a rule: the
 * column stays a normal editable pick (narrowed to STAFFING_ACCOUNT_FILTER), and
 * a post that books somewhere special keeps whatever the user chose. The default
 * is (re)applied when the Classification changes — see rowModel.sanitizeRow.
 */
export const WORKING_HOURS_ACCOUNT_BY_JOB_TYPE: Readonly<Record<string, string>> = {
  Manager: "A988308",
  "Manager (Non Exempt)": "A988308",
  Supervisor: "A988699",
  Associate: "A988699",
  Casual: "A988699",
};

/**
 * The default worked-hours account for a Classification — "" for a grade that
 * defaults to none (Buyout Labour) and for a blank/unknown one.
 */
export function workingHoursAccountForJobType(jobTypeCode: unknown): string {
  if (typeof jobTypeCode !== "string") return "";
  return WORKING_HOURS_ACCOUNT_BY_JOB_TYPE[jobTypeCode.trim()] ?? "";
}
