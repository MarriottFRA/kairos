/**
 * Catalog helpers — the filter shorthands, the map labels the workbook and
 * PS Loader name, and the base codes they name outright. Its own module so
 * the group files can import it without a cycle through catalog/index.ts.
 *
 * Sign convention (decided 2026-09-09): the BST pull holds revenue POSITIVE,
 * so no atom negates it and every profit is revenue − expenses from two
 * atoms. The workbook's `-CALCULATE(...)` is the DAX model's convention and
 * is not carried over.
 */

import type { Atom, AtomFilter, Measure, ReportParam } from "../types";

export interface CatalogGroup {
  id: string;
  atoms: Atom[];
  measures: Measure[];
  params?: ReportParam[];
  requires?: CatalogGroup[];
}

// ---------------------------------------------------------------------------
// Filter shorthands — the workbook's column headings, as functions
// ---------------------------------------------------------------------------

export const deptLevel = (level: number, ...values: string[]): AtomFilter => ({
  kind: "dept_level",
  level,
  values,
});
export const deptNotLevel = (level: number, ...values: string[]): AtomFilter => ({
  kind: "dept_level_not_in",
  level,
  values,
});
export const deptBase = (...codes: string[]): AtomFilter => ({ kind: "dept_base", codes });
export const accLevel = (level: number, ...values: string[]): AtomFilter => ({
  kind: "acc_level",
  level,
  values,
});
export const accNotLevel = (level: number, ...values: string[]): AtomFilter => ({
  kind: "acc_level_not_in",
  level,
  values,
});
export const accBase = (...codes: string[]): AtomFilter => ({ kind: "acc_base", codes });
export const accPrefix = (...prefixes: string[]): AtomFilter => ({ kind: "acc_prefix", prefixes });

export function atom(id: string, label: string, ...filters: AtomFilter[]): Atom {
  return { id, label, filters };
}

export function measure(id: string, formula: string, format: Measure["format"], label?: string): Measure {
  return label ? { id, formula, format, label } : { id, formula, format };
}

/** A measure whose fall is good news — an expense, a payroll line, a cost per
 *  unit. Colours its variances the other way round. */
export function costMeasure(id: string, formula: string, format: Measure["format"], label?: string): Measure {
  return { ...measure(id, formula, format, label), polarity: "cost" };
}

// ---------------------------------------------------------------------------
// The map labels the workbook and PS Loader name, in one place
// ---------------------------------------------------------------------------

export const DEPT = {
  /** level_2 */
  lodgingOperations: "Lodging Operations",
  noi: "NOI",
  /** level_5 */
  roomsAndReservation5: "ROOMS_and_RESERVATION",
  totalFoodAndBeverage: "Total Food & Beverage",
  otherOperatedDepartments: "Other Operated Departments",
  /** level_7 */
  roomsAndReservation: "Rooms and Reservation",
  payrollCostAllocation: "Payroll Cost Allocation",
  administrativeAndGeneral: "Administrative & General",
  informationAndTelecom: "Information & Telecom Systems",
  utilities: "Utilities Dept",
  propertyOperations: "Property Operation & Maintenance",
  salesAndMarketing: "Sales & Marketing and Convention Service",
  otherUoe: "Other UOE",
  /** level_10 */
  rooms: "Rooms",
  kitchen: "Kitchen",
  outletsAndLounge10: "Outlets and Lounge",
  catering10: "Catering",
  spa10: "Spa",
  recreationCenter10: "Recreation Center",
  golf10: "Golf",
  casino10: "Casino",
  miscIncome10: "Miscellaneous Income",
  /** level_11 */
  restaurantsAndRoomService11: "Restaurants and Room Service",
  /** level_12 */
  lounge: "Lounge",
  banquet: "Banquet",
  guestCommunications12: "Guest Communications",
  staffDining12: "Staff Dining Dept",
  /** level_14 */
  restaurant: "Restaurant",
  roomServiceAndMinibar: "Room Service and Minibar",
} as const;

export const ACC = {
  /** level_1 */
  statistics: "Statistics",
  ebitda: "EBITDA",
  noi: "NOI",
  /** level_4 */
  totalManhours: "Total Manhours",
  profitAmount: "Profit Amount",
  departmentVolume: "Department Volume",
  /** level_6 */
  revenue: "Revenue",
  totalExpenses: "Total Expenses",
  coverBbld: "Cover B/B/L/D",
  coverOtherMealPeriods: "Cover Other Meal Periods",
  /** level_6, under Total Manhours: the hours that drive FTE — worked hours
   *  less overtime (level_6 "Total Manhours - Overtime") and the manager
   *  hours accounts (level_6 "Non Prod Hours"). */
  manhoursExclOvertimeAndManagers: "Total Manhours excl Overtime and Manager Hours",
  /** level_9 */
  totalPayroll: "Total Payroll",
  costOfSales: "Cost Of Sales",
  /** level_9, under the hours above: staff hours as opposed to "Buyout Manhours". */
  manHours: "Man Hours",
  /** level_9, under the cover accounts: allocation bases and other non-cover
   *  statistics filed with the covers — left out of a covers count. */
  coverOtherSegments: "Cover Other Segments",
  /** level_12 */
  associateWages: "Associate Wages",
  associateBenefits: "Associate Benefits",
  /** level_14 */
  paidTimeOff: "Paid Time Off",
  creditCardExpense: "Credit Card Expense",
  /** level_15 */
  totalManagementSalaries: "Total Management Salaries",
  totalHourlyWages: "Total Hourly Wages",
  bonusPayments: "Bonus Payments",
  taCommissions: "TA Commissions",
  /** level_18 */
  hourlyOvertimePremium: "Hrly Overtime Prem",
  /** level_21 */
  hourlyWages: "Hourly Wages",
  contractBuyoutLabour: "Contract Buyout Lbr",
} as const;

/** Base codes the workbook and PS Loader name outright. */
export const CODES = {
  /** The pinned headcount statistic (systemAccounts.POSITION_COUNT_ACCOUNT). */
  positionCount: "A972540",
  roomsAvailable: "A960101",
  roomsSold: "A960103",
  bedNightsAvailable: "A960004",
  bedNightsSold: "A960005",
  arrivals: "A968801",
  departures: "A968802",
  vacationLeave: "A560303",
  sickLeave: "A560307",
  travelAgentCommissionRooms: "A608201",
  replacementReserve: ["A701110", "A701111", "A759372"],
  replacementReserveDept: "D0480",
  /** Rooms operating supplies, per room night sold. */
  flatware: "A610102",
  linen: "A610105",
  glassware: "A610402",
  roomSmalls: "A610125",
  cleaningSupplies: "A610106",
  guestSupplies: "A610201",
  paperSupplies: "A610104",
  printingAndStationery: "A606101",
  laundry: "A602406",
} as const;
