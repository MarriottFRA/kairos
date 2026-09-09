/**
 * Payroll & FTE summary — the "Payroll FTE Summary" tab of the user's
 * report-definition workbook, row for row: occupancy, total payroll and its
 * wage / benefit breakdown, FTE and the average annual wage per FTE, then
 * payroll by department node with Rooms payroll POR and F&B payroll as a
 * share of F&B revenue.
 */

import { PAYROLL, ROOMS_STATS, STAFFING } from "../catalog";
import { defineReport, header, line, spacer } from "./defineReport";

export const PAYROLL_FTE_SUMMARY = defineReport({
  id: "payroll_fte_summary",
  name: "Payroll & FTE summary",
  description:
    "Total payroll, wages and benefits by type, FTE and wage per FTE, and payroll by department — the payroll page of the budget.",
  use: [ROOMS_STATS, PAYROLL, STAFFING],
  rows: [
    line("occupancy", "Occupancy"),
    spacer(),
    header("PAYROLL"),
    line("total_payroll_line", "Total Payroll", 1),
    line("total_wages_line", "Total Wages", 1),
    line("total_benefits_line", "Total Benefits", 1),
    line("total_fte", "Total FTE", 1),
    line("manager_fte", "Managers (heads)", 2),
    line("hourly_fte", "Hours-driven", 2),
    line("avg_annual_wage_per_fte", "Total Average Annual Wage by FTE", 1),
    line("payroll_per_fte", "Annual Payroll per FTE", 1),
    spacer(),
    header("WAGES"),
    line("management_wages_line", "Total Management Wages", 1),
    line("hourly_wages_total_line", "Total Hourly Wages", 1),
    line("hourly_wages_line", "Hourly Wages", 2),
    line("buyout_wages_line", "Buyout Wages", 2),
    line("overtime_wages_line", "Overtime Wages", 2),
    line("bonus_line", "Total Bonus", 1),
    spacer(),
    header("BENEFITS"),
    line("paid_time_off_line", "Paid Time Off", 1),
    line("vacation_leave_line", "Vacation Leave", 2),
    line("sick_leave_line", "Sick Leave", 2),
    spacer(),
    header("HOURS"),
    line("manhours_line", "Total Manhours", 1),
    line("fte_hours_worked_line", "Hours driving FTE", 2),
    line("hours_per_fte_line", "Hours per FTE", 1),
    spacer(),
    header("ROOMS"),
    line("rooms_res_payroll_line", "Total Rooms and Reservations", 1),
    line("rooms_payroll_line", "Total Rooms", 1),
    line("rooms_sold_line", "Sold Rooms", 1),
    line("rooms_payroll_por", "Rooms Payroll POR", 1),
    spacer(),
    header("FOOD & BEVERAGE"),
    line("fb_payroll_line", "Total F&B", 1),
    line("fb_payroll_pct_fb_revenue", "F&B Payroll as % of F&B Revenue", 1),
    line("restaurant_payroll_line", "Total Restaurant", 1),
    line("lounge_payroll_line", "Total Lounge", 1),
    line("banquet_payroll_line", "Total Banquet", 1),
    line("room_service_payroll_line", "Total Room Service & Mini Bar", 1),
    line("kitchen_payroll_line", "Total Kitchen", 1),
    spacer(),
    header("OTHER DEPARTMENTS"),
    line("ag_payroll_line", "Total Admin & General", 1),
    line("it_payroll_line", "Total IT & Telephone", 1),
    line("pom_payroll_line", "Total POM", 1),
    line("sm_payroll_line", "Total Sales & Marketing", 1),
    line("other_ops_payroll_line", "Total Other Operations Departments", 1),
  ],
});
