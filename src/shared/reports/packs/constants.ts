/**
 * The budget pack's fixed vocabulary — PS Loader's Marriott report pack,
 * carried over so a Kairos pack reads the same way.
 */

/** The parent department level: orders the pack's groups (PACK_GROUP_ORDER)
 *  and stands in for a department with no DETAIL_GROUP_LEVEL label. Staffing
 *  overview and FTE reconciliation still group by it directly. */
export const PACK_GROUP_LEVEL = 7;

/** The department level the budget pack (every page) and Staffing statistics
 *  group by since 2026-09-10 (level_10: Rooms, Reservation, Kitchen, Outlets
 *  and Lounge, …), falling back to PACK_GROUP_LEVEL where a department has none. */
export const DETAIL_GROUP_LEVEL = 10;

/** Account map level the ledger sub-groups by inside a category. */
export const PACK_ACCOUNT_GROUP_LEVEL = 12;

/** level_7 labels in the order the pack presents their groups; anything else
 *  follows alphabetically, and unmapped departments last. Order only — which
 *  departments form a group is always the map's say. */
export const PACK_GROUP_ORDER: readonly string[] = [
  "Rooms and Reservation",
  "Total Food & Beverage",
  "Other Operated Departments",
  "Administrative & General",
  "Information & Telecom Systems",
  "Utilities Dept",
  "Property Operation & Maintenance",
  "Sales & Marketing and Convention Service",
  "Other UOE",
  "Payroll Cost Allocation",
];

export const UNMAPPED_GROUP = "Unmapped departments";
export const UNMAPPED_ACCOUNT_GROUP = "Other accounts";

/** Non-operating departments PS Loader leaves out of the pack outright. */
export const EXCLUDED_DEPARTMENTS: ReadonlySet<string> = new Set([
  "1468",
  "3095",
  "0376",
  "0370",
  "3096",
  "0499",
]);

/** The ledger's categories, in order. `Stats` renders flat (no sub-groups). */
export type LedgerCategory =
  | "Revenue"
  | "Cost of Sales"
  | "Payroll"
  | "Controllables"
  | "Other"
  | "Stats";

export const LEDGER_CATEGORY_ORDER: readonly LedgerCategory[] = [
  "Revenue",
  "Cost of Sales",
  "Payroll",
  "Controllables",
  "Other",
  "Stats",
];
