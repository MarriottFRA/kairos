/**
 * The catalog — reusable atoms, measures and params the report definitions
 * are assembled from, grouped so a definition pulls in a whole subject
 * ("payroll", "rooms stats") with `defineReport({ use: [...] })`.
 *
 * Every atom here is one row of the user's "Payroll FTE report definitions"
 * workbook or of PS Loader's measure book, restated as map-level filters
 * (the labels are the ones held in account_maps / department_maps at those
 * levels), with base codes only where the source used them. Levels rather
 * than code lists because the maps are synced from the server: a department
 * added under "Rooms and Reservation" joins the line without a release.
 *
 * A group is CLOSED: every id its measures reference is in the group or in a
 * group it `requires`, because compile validates every measure, reached or
 * not. `defineReport` walks `requires`.
 */

export * from "./helpers";
export { REVENUE } from "./revenue";
export { ROOMS_STATS } from "./roomsStats";
export { EXPENSES } from "./expenses";
export { PAYROLL } from "./payroll";
export { STAFFING } from "./staffing";
export { ROOMS_KPI } from "./roomsKpi";
export { SUMMARY_STATS } from "./summaryStats";

import { EXPENSES } from "./expenses";
import type { CatalogGroup } from "./helpers";
import { PAYROLL } from "./payroll";
import { REVENUE } from "./revenue";
import { ROOMS_KPI } from "./roomsKpi";
import { ROOMS_STATS } from "./roomsStats";
import { STAFFING } from "./staffing";
import { SUMMARY_STATS } from "./summaryStats";

export const CATALOG_GROUPS: readonly CatalogGroup[] = [
  REVENUE,
  ROOMS_STATS,
  EXPENSES,
  PAYROLL,
  STAFFING,
  ROOMS_KPI,
  SUMMARY_STATS,
];
