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
 */
export const POSITION_COUNT_ACCOUNT = "A972540";

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
