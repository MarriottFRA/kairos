/**
 * The pack's "Summary reporting" page — the user's "Departments Cost HC / FTE
 * & Driver Summary": the hotel's stats and sales first (rooms, guests,
 * covers, arrivals, occupancy, ADR, RevPAR, sales with the F&B and Other
 * Sales sub-lines, total payroll, hours, payroll % / PAR / POR, sales per
 * FTE), then one block per department group with heads, managers, hours,
 * wages, total payroll, payroll % of the HOTEL's sales, payroll per occupied
 * room and hours per occupied room.
 *
 * The groups are whatever the mapping table says at the pack's level
 * (PACK_GROUP_LEVEL) — decided 2026-09-09 so a re-pushed grouping flows
 * through with no release; the workbook's finer hand-drawn groups are not
 * reproduced. As on the summary page, each group is pinned as its department
 * code list (the direct-lookup path) while the accounts stay on the map
 * levels, so a line here means what it means on the Summary P&L.
 */

import { HEADCOUNT_ACCOUNT_BY_JOB_TYPE } from "../../positions/systemAccounts";
import { ACC, CODES, accBase, accLevel, deptBase } from "../catalog/helpers";
import { SUMMARY_STATS } from "../catalog/summaryStats";
import { defineReport, header, line, spacer } from "../definitions/defineReport";
import type { Atom, Measure, ReportDefinition, ReportRow } from "../types";
import type { SummaryGroupSpec } from "./summary";

export interface SummaryReportingSpec {
  id: string;
  name: string;
  description?: string;
  groups: SummaryGroupSpec[];
}

/** "# Managers" counts the manager grades only — the supervisor account is a
 *  separate line on the Staffing overview, not a manager here. */
const MANAGER_ACCOUNTS = [
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE.Manager,
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE["Manager (Non Exempt)"],
];

const HOTEL_ROWS: ReportRow[] = [
  header("FINANCIAL & STATS SUMMARY"),
  line("no_of_rooms", "No. of Rooms", 1),
  line("rooms_available_line", "Rooms Available", 1),
  line("rooms_sold_line", "Rooms Sold", 1),
  line("guests_line", "Guests", 1),
  line("covers_outlets_line", "Customers Outlets", 1),
  line("covers_catering_line", "Customers Catering", 1),
  line("arrivals_departures", "Arrivals & Departures", 1),
  line("occupancy", "Occupancy", 1),
  line("adr", "ADR", 1),
  line("revpar", "RevPAR", 1),
  line("total_sales", "Total Sales", 1),
  line("rooms_sales", "Rooms Sales", 1),
  line("fb_sales", "F&B Sales", 1),
  line("fb_restaurants_sales", "F&B Outlets Restaurants / Room Service / Minibar", 2),
  line("fb_lounges_other_sales", "F&B Outlets Lounges and Other", 2),
  line("fb_catering_sales", "F&B Catering/AV", 2),
  line("other_sales", "Other Sales", 1),
  line("spa_fitness_sales", "Spa and Fitness", 2),
  line("golf_sales", "Golf", 2),
  line("minor_operated_sales", "Minor Operated Departments", 2),
  line("casino_sales", "Casino", 2),
  line("guest_comms_sales", "Guest Communications", 2),
  line("misc_income_sales", "Miscellaneous Income", 2),
  line("staff_dining_sales", "Staff Dining", 2),
  line("total_payroll_line", "Total Payroll Cost", 1),
  line("manhours_line", "Total Hours", 1),
  line("payroll_pct_revenue", "Total Payroll in % to Sales", 1),
  line("total_payroll_par", "Total Payroll PAR", 1),
  line("total_payroll_por", "Total Payroll POR", 1),
  line("sales_per_fte", "Total Sales per FTE", 1),
  spacer(),
];

const GROUP_ROWS: Array<{ key: string; label: string }> = [
  { key: "hc", label: "HC" },
  { key: "managers", label: "# Managers" },
  { key: "hours", label: "Total Hours" },
  { key: "salaries", label: "Salaries only (excl. Benefits)" },
  { key: "payroll", label: "Total Payroll Cost" },
  { key: "payroll_pct_sales", label: "Total Payroll Cost in % to Sales" },
  { key: "payroll_por", label: "Total Payroll POR" },
  { key: "hours_por", label: "Hours POR" },
];

function blockFor(prefix: string, label: string, depts: string[]): { atoms: Atom[]; measures: Measure[]; rows: ReportRow[] } {
  const scope = deptBase(...depts);
  const id = (key: string) => `${prefix}_${key}`;
  const atoms: Atom[] = [
    { id: id("heads_a"), label: `${label}: position count`, filters: [scope, accBase(CODES.positionCount)] },
    { id: id("managers_a"), label: `${label}: managers (manager headcount accounts)`, filters: [scope, accBase(...MANAGER_ACCOUNTS)] },
    {
      id: id("hours_a"),
      label: `${label}: manhours`,
      filters: [scope, accLevel(1, ACC.statistics), accLevel(4, ACC.totalManhours)],
    },
    {
      id: id("salaries_a"),
      label: `${label}: wages (Total Payroll × Associate Wages)`,
      filters: [scope, accLevel(9, ACC.totalPayroll), accLevel(12, ACC.associateWages)],
    },
    { id: id("payroll_a"), label: `${label}: total payroll`, filters: [scope, accLevel(9, ACC.totalPayroll)] },
  ];
  const measures: Measure[] = [
    { id: id("hc"), formula: id("heads_a"), format: "number", polarity: "cost" },
    { id: id("managers"), formula: id("managers_a"), format: "number", polarity: "cost" },
    { id: id("hours"), formula: id("hours_a"), format: "number", polarity: "cost" },
    { id: id("salaries"), formula: id("salaries_a"), format: "currency", polarity: "cost" },
    { id: id("payroll"), formula: id("payroll_a"), format: "currency", polarity: "cost" },
    // The workbook divides every group's payroll by the HOTEL's sales.
    { id: id("payroll_pct_sales"), formula: `pct(${id("payroll")}, total_revenue)`, format: "percent", polarity: "cost" },
    { id: id("payroll_por"), formula: `div(${id("payroll")}, rooms_sold)`, format: "rate", polarity: "cost" },
    { id: id("hours_por"), formula: `div(${id("hours")}, rooms_sold)`, format: "ratio", polarity: "cost" },
  ];
  const rows: ReportRow[] = [header(label.toUpperCase()), ...GROUP_ROWS.map((r) => line(id(r.key), r.label, 1)), spacer()];
  return { atoms, measures, rows };
}

export function buildSummaryReportingDefinition(spec: SummaryReportingSpec): ReportDefinition {
  const atoms: Atom[] = [];
  const measures: Measure[] = [];
  const rows: ReportRow[] = [...HOTEL_ROWS];
  spec.groups.forEach((group, index) => {
    if (group.depts.length === 0) return;
    const block = blockFor(`g${index}`, group.label, group.depts);
    atoms.push(...block.atoms);
    measures.push(...block.measures);
    rows.push(...block.rows);
  });
  const definition = defineReport({
    id: spec.id,
    name: spec.name,
    use: [SUMMARY_STATS],
    atoms,
    measures,
    rows,
  });
  if (spec.description) definition.description = spec.description;
  return definition;
}
