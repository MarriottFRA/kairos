/**
 * Summary P&L — the "Summary P&L" tab of the user's report-definition
 * workbook, row for row (PS Loader's summaryPLRowConfig is the same list).
 * Flow-through (row 16) needs last year beside this year and is a column
 * variance, not a line; it is left to the columns.
 */

import { EXPENSES, PAYROLL, ROOMS_STATS } from "../catalog";
import { defineReport, header, line, spacer } from "./defineReport";

export const SUMMARY_PL = defineReport({
  id: "summary_pl",
  name: "Summary P&L",
  description:
    "Occupancy, rate and revenue, department profits, undistributed expenses, payroll, and NOI — the hotel on one page.",
  use: [ROOMS_STATS, EXPENSES, PAYROLL],
  rows: [
    header("ROOMS"),
    line("occupancy", "Occupancy", 1),
    line("adr", "ADR Rate", 1),
    line("revpar", "RevPAR", 1),
    spacer(),
    header("SALES & PROFIT"),
    line("total_sales", "Total Sales", 1),
    line("gop", "Gross Operating Profit", 1),
    line("gop_margin", "Gross Operating Profit Margin", 1),
    line("noi", "Net Operating Income", 1),
    spacer(),
    header("DEPARTMENTS"),
    line("rooms_sales", "Rooms Sales", 1),
    line("rooms_profit", "Rooms Dept Profit", 1),
    line("rooms_profit_pct", "Rooms Dept Profit %", 1),
    line("fb_sales", "F&B Sales", 1),
    line("fb_profit", "F&B Dept Profit", 1),
    line("fb_profit_pct", "F&B Dept Profit %", 1),
    line("other_sales", "Other Sales", 1),
    line("other_profit", "Other Dept Profit", 1),
    line("other_profit_pct", "Other Dept Profit %", 1),
    line("department_profit", "Department Profit"),
    line("department_profit_pct", "Department Profit %"),
    spacer(),
    header("UNDISTRIBUTED OPERATING EXPENSES"),
    line("ag_without_cc", "Administrative & General w/o CC", 1),
    line("credit_card", "Credit Card Expense (CC)", 1),
    line("it_and_telecom", "IT & Telephone", 1),
    line("utilities", "Energy, Water & Waste", 1),
    line("pom", "Property Operation & Maintenance", 1),
    line("sales_and_marketing", "Sales & Marketing", 1),
    line("other_uoe", "Other UOE", 1),
    line("total_uoe", "Total UOE"),
    spacer(),
    header("PAYROLL & OTHER"),
    line("total_payroll_line", "Total Payroll", 1),
    line("payroll_pct_revenue", "Payroll % per Total Revenue", 1),
    line("ta_commission_cost", "Travel Agent Commission Cost", 1),
    line("room_cpor", "Room CPOR", 1),
  ],
});
