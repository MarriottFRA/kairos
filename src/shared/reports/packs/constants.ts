/**
 * The budget pack's fixed vocabulary — PS Loader's Marriott report pack,
 * carried over so a Kairos pack reads the same way.
 */

/** Department map level the pack groups by (decided 2026-09-09). */
export const PACK_GROUP_LEVEL = 7;

/** Account map level the ledger sub-groups by inside a category. */
export const PACK_ACCOUNT_GROUP_LEVEL = 12;

/** level_7 groups in the order the pack presents them; anything else follows
 *  alphabetically, and unmapped departments last. */
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
