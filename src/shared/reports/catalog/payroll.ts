/**
 * Payroll — the "Payroll FTE Summary" tab of the workbook, rows 5–9 and
 * 12–38, plus Summary P&L rows 44–46.
 *
 * Total payroll is the HIERARCHY form (level_2 Lodging Operations, level_7
 * not "Payroll Cost Allocation", level_9 Total Payroll) — the workbook's
 * `total_payroll_expenses_act_sy` — and not its 74-code department list,
 * which PS Loader itself flags as the one that goes stale.
 *
 * The wage and benefit breakdown (rows 12–22) carries NO department scope,
 * exactly as the workbook has it; the per-department totals (rows 23–38) are
 * level_9 Total Payroll under each department node. Rooms payroll POR and
 * F&B payroll % of F&B revenue are rows 26 and 28.
 */

import {
  ACC,
  CODES,
  CatalogGroup,
  DEPT,
  accBase,
  accLevel,
  atom,
  deptLevel,
  deptNotLevel,
  costMeasure,
} from "./helpers";
import { REVENUE } from "./revenue";
import { ROOMS_STATS } from "./roomsStats";

const payroll = accLevel(9, ACC.totalPayroll);
const wages = accLevel(12, ACC.associateWages);
const benefits = accLevel(12, ACC.associateBenefits);
const pto = accLevel(14, ACC.paidTimeOff);
const scope = [deptLevel(2, DEPT.lodgingOperations), deptNotLevel(7, DEPT.payrollCostAllocation)] as const;
const fb = deptLevel(5, DEPT.totalFoodAndBeverage);

export const PAYROLL: CatalogGroup = {
  id: "payroll",
  requires: [REVENUE, ROOMS_STATS],
  atoms: [
    atom("total_payroll", "Total payroll (Lodging Operations, less Payroll Cost Allocation)", ...scope, payroll),
    atom("total_wages", "Associate wages", payroll, wages),
    atom("management_wages", "Management salaries", payroll, wages, accLevel(15, ACC.totalManagementSalaries)),
    atom("hourly_wages_total", "Total hourly wages", payroll, wages, accLevel(15, ACC.totalHourlyWages)),
    atom("hourly_wages", "Hourly wages", payroll, wages, accLevel(21, ACC.hourlyWages)),
    atom("buyout_wages", "Contract buyout labour", payroll, wages, accLevel(21, ACC.contractBuyoutLabour)),
    atom("overtime_wages", "Hourly overtime premium", payroll, wages, accLevel(18, ACC.hourlyOvertimePremium)),
    atom("paid_time_off", "Paid time off", payroll, benefits, pto),
    atom("vacation_leave", "Vacation leave (A560303)", payroll, benefits, pto, accBase(CODES.vacationLeave)),
    atom("sick_leave", "Sick leave (A560307)", payroll, benefits, pto, accBase(CODES.sickLeave)),
    atom("total_benefits", "Associate benefits", payroll, benefits),
    atom("bonus", "Bonus payments", payroll, wages, accLevel(15, ACC.bonusPayments)),

    atom("rooms_res_payroll", "Rooms and Reservation payroll", deptLevel(7, DEPT.roomsAndReservation), payroll),
    atom("rooms_payroll", "Rooms payroll", deptLevel(7, DEPT.roomsAndReservation), deptLevel(10, DEPT.rooms), payroll),
    atom("fb_payroll", "F&B payroll", fb, payroll),
    atom("restaurant_payroll", "Restaurant payroll", fb, deptLevel(14, DEPT.restaurant), payroll),
    atom("lounge_payroll", "Lounge payroll", fb, deptLevel(12, DEPT.lounge), payroll),
    atom("banquet_payroll", "Banquet payroll", fb, deptLevel(12, DEPT.banquet), payroll),
    atom("room_service_payroll", "Room service & minibar payroll", fb, deptLevel(14, DEPT.roomServiceAndMinibar), payroll),
    atom("kitchen_payroll", "Kitchen payroll", fb, deptLevel(10, DEPT.kitchen), payroll),
    atom("ag_payroll", "Administrative & General payroll", deptLevel(7, DEPT.administrativeAndGeneral), payroll),
    atom("it_payroll", "IT & Telephone payroll", deptLevel(7, DEPT.informationAndTelecom), payroll),
    atom("pom_payroll", "Property Operation & Maintenance payroll", deptLevel(7, DEPT.propertyOperations), payroll),
    atom("sm_payroll", "Sales & Marketing payroll", deptLevel(7, DEPT.salesAndMarketing), payroll),
    atom("other_ops_payroll", "Other operated departments payroll", deptLevel(5, DEPT.otherOperatedDepartments), payroll),
  ],
  measures: [
    costMeasure("total_payroll_line", "total_payroll", "currency", "Total Payroll"),
    costMeasure("total_wages_line", "total_wages", "currency", "Total Wages"),
    costMeasure("management_wages_line", "management_wages", "currency", "Total Management Wages"),
    costMeasure("hourly_wages_total_line", "hourly_wages_total", "currency", "Total Hourly Wages"),
    costMeasure("hourly_wages_line", "hourly_wages", "currency", "Hourly Wages"),
    costMeasure("buyout_wages_line", "buyout_wages", "currency", "Buyout Wages"),
    costMeasure("overtime_wages_line", "overtime_wages", "currency", "Overtime Wages"),
    costMeasure("paid_time_off_line", "paid_time_off", "currency", "Paid Time Off"),
    costMeasure("vacation_leave_line", "vacation_leave", "currency", "Vacation Leave"),
    costMeasure("sick_leave_line", "sick_leave", "currency", "Sick Leave"),
    costMeasure("total_benefits_line", "total_benefits", "currency", "Total Benefits"),
    costMeasure("bonus_line", "bonus", "currency", "Total Bonus"),

    costMeasure("rooms_res_payroll_line", "rooms_res_payroll", "currency", "Total Rooms and Reservations"),
    costMeasure("rooms_payroll_line", "rooms_payroll", "currency", "Total Rooms"),
    costMeasure("fb_payroll_line", "fb_payroll", "currency", "Total F&B"),
    costMeasure("restaurant_payroll_line", "restaurant_payroll", "currency", "Total Restaurant"),
    costMeasure("lounge_payroll_line", "lounge_payroll", "currency", "Total Lounge"),
    costMeasure("banquet_payroll_line", "banquet_payroll", "currency", "Total Banquet"),
    costMeasure("room_service_payroll_line", "room_service_payroll", "currency", "Total Room Service & Mini Bar"),
    costMeasure("kitchen_payroll_line", "kitchen_payroll", "currency", "Total Kitchen"),
    costMeasure("ag_payroll_line", "ag_payroll", "currency", "Total Admin & General"),
    costMeasure("it_payroll_line", "it_payroll", "currency", "Total IT & Telephone"),
    costMeasure("pom_payroll_line", "pom_payroll", "currency", "Total POM"),
    costMeasure("sm_payroll_line", "sm_payroll", "currency", "Total Sales & Marketing"),
    costMeasure("other_ops_payroll_line", "other_ops_payroll", "currency", "Total Other Operations Departments"),

    costMeasure("payroll_pct_revenue", "pct(total_payroll, total_revenue)", "percent", "Payroll % per Total Revenue"),
    costMeasure("rooms_payroll_por", "div(rooms_payroll, rooms_sold)", "rate", "Rooms Payroll POR"),
    costMeasure("fb_payroll_pct_fb_revenue", "pct(fb_payroll, fb_revenue)", "percent", "F&B Payroll as % of F&B Revenue"),
    costMeasure("payroll_pct_rooms_revenue", "pct(rooms_res_payroll, rooms_revenue)", "percent", "Rooms Payroll % of Rooms Sales"),
  ],
};
