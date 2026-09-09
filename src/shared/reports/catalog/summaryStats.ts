/**
 * Summary statistics — the hotel-level lines of the user's "Summary
 * Reporting" page that the other groups do not carry: rooms in the hotel,
 * guests, covers in the outlets and in catering, arrivals and departures,
 * the F&B and Other Sales sub-lines by department node, payroll per
 * available and per occupied room, and sales per FTE.
 *
 * Covers are the account map's "Department Volume" family under the two
 * cover headings, less "Cover Other Segments" — that level_9 node files
 * allocation bases and transport counts with the covers, and a covers line
 * must not count them. Outlets are department level_10 "Outlets and Lounge"
 * (restaurants, room service, lounges), catering is level_10 "Catering"
 * (banquets and audio visual).
 *
 * No. of Rooms is rooms available ÷ the days in the period: the BST posts
 * room-nights available per day, so the year's figure is rooms × days. The
 * divisor is the built-in param `days_in_month` (main/reports/params.ts),
 * whose Total is the year's days, so the Total slot reads as the hotel's
 * rooms and not as a sum of twelve.
 */

import {
  ACC,
  CODES,
  CatalogGroup,
  DEPT,
  accBase,
  accLevel,
  accNotLevel,
  atom,
  costMeasure,
  deptLevel,
  measure,
} from "./helpers";
import { PAYROLL } from "./payroll";
import { REVENUE } from "./revenue";
import { ROOMS_STATS } from "./roomsStats";
import { STAFFING } from "./staffing";

const revenue = accLevel(6, ACC.revenue);
const covers = [
  accLevel(4, ACC.departmentVolume),
  accLevel(6, ACC.coverBbld, ACC.coverOtherMealPeriods),
  accNotLevel(9, ACC.coverOtherSegments),
];

export const SUMMARY_STATS: CatalogGroup = {
  id: "summary_stats",
  requires: [REVENUE, ROOMS_STATS, PAYROLL, STAFFING],
  params: [
    {
      id: "days_in_month",
      label: "Days in the month",
      default: { months: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], total: 365 },
      builtin: "days_in_month",
      unit: "days",
    },
  ],
  atoms: [
    atom("covers_outlets", "Covers in the outlets (Outlets and Lounge × cover accounts)", deptLevel(10, DEPT.outletsAndLounge10), ...covers),
    atom("covers_catering", "Covers in catering (Catering × cover accounts)", deptLevel(10, DEPT.catering10), ...covers),
    atom("arrivals", "Arrivals (A968801)", accBase(CODES.arrivals)),
    atom("departures", "Departures (A968802)", accBase(CODES.departures)),
    atom(
      "fb_restaurants_revenue",
      "Restaurants and room service revenue (F&B × Restaurants and Room Service × Revenue)",
      deptLevel(5, DEPT.totalFoodAndBeverage),
      deptLevel(11, DEPT.restaurantsAndRoomService11),
      revenue
    ),
    atom("fb_catering_revenue", "Catering revenue (Catering × Revenue)", deptLevel(10, DEPT.catering10), revenue),
    atom("spa_fitness_revenue", "Spa and fitness revenue (Spa, Recreation Center × Revenue)", deptLevel(10, DEPT.spa10, DEPT.recreationCenter10), revenue),
    atom("golf_revenue", "Golf revenue (Golf × Revenue)", deptLevel(10, DEPT.golf10), revenue),
    atom("casino_revenue", "Casino revenue (Casino × Revenue)", deptLevel(10, DEPT.casino10), revenue),
    atom("misc_income_revenue", "Miscellaneous income (Miscellaneous Income × Revenue)", deptLevel(10, DEPT.miscIncome10), revenue),
    atom("guest_comms_revenue", "Guest communications revenue (Guest Communications × Revenue)", deptLevel(12, DEPT.guestCommunications12), revenue),
    atom("staff_dining_revenue", "Staff dining revenue (Staff Dining Dept × Revenue)", deptLevel(12, DEPT.staffDining12), revenue),
  ],
  measures: [
    measure("no_of_rooms", "div(rooms_available, days_in_month)", "number", "No. of Rooms"),
    measure("guests_line", "bed_nights_sold", "number", "Guests"),
    measure("covers_outlets_line", "covers_outlets", "number", "Customers Outlets"),
    measure("covers_catering_line", "covers_catering", "number", "Customers Catering"),
    measure("arrivals_departures", "arrivals + departures", "number", "Arrivals & Departures"),
    measure("fb_restaurants_sales", "fb_restaurants_revenue", "currency", "F&B Outlets Restaurants / Room Service / Minibar"),
    measure("fb_lounges_other_sales", "fb_revenue - fb_restaurants_revenue - fb_catering_revenue", "currency", "F&B Outlets Lounges and Other"),
    measure("fb_catering_sales", "fb_catering_revenue", "currency", "F&B Catering/AV"),
    measure("spa_fitness_sales", "spa_fitness_revenue", "currency", "Spa and Fitness"),
    measure("golf_sales", "golf_revenue", "currency", "Golf"),
    measure(
      "minor_operated_sales",
      "other_revenue - spa_fitness_revenue - golf_revenue - casino_revenue - misc_income_revenue - guest_comms_revenue - staff_dining_revenue",
      "currency",
      "Minor Operated Departments"
    ),
    measure("casino_sales", "casino_revenue", "currency", "Casino"),
    measure("guest_comms_sales", "guest_comms_revenue", "currency", "Guest Communications"),
    measure("misc_income_sales", "misc_income_revenue", "currency", "Miscellaneous Income"),
    measure("staff_dining_sales", "staff_dining_revenue", "currency", "Staff Dining"),
    costMeasure("total_payroll_par", "div(total_payroll, rooms_available)", "rate", "Total Payroll PAR"),
    costMeasure("total_payroll_por", "div(total_payroll, rooms_sold)", "rate", "Total Payroll POR"),
    measure("sales_per_fte", "div(total_revenue, total_fte) * annualise", "rate", "Total Sales per FTE"),
  ],
};
