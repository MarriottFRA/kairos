/**
 * Expenses, profits and the undistributed lines — Summary P&L rows 12–20,
 * 22–23, 25–26, 30–43, 48–49.
 *
 * Profit is revenue − expenses, with "expenses" = the department scope ×
 * level_4 "Profit Amount" minus level_6 "Revenue": every account that feeds
 * the profit line and is not a sale. That is the workbook's
 * `-CALCULATE(level_4 = "Profit Amount")` restated for a source where sales
 * are positive (catalog/index.ts).
 *
 * The undistributed operating expenses are level_7 department groups ×
 * level_6 "Total Expenses", as the workbook has them.
 *
 * NOI mirrors the workbook's variables one for one (EBITDA-level lodging
 * result, the NOI-level department block, the replacement reserve on D0480).
 * The NOI-level block is summed as stored, exactly as the DAX does; whether
 * those items sit in the BST as costs or credits is to be verified against a
 * real pull before the line is trusted.
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
  deptBase,
  deptLevel,
  costMeasure,
  measure,
} from "./helpers";
import { REVENUE } from "./revenue";
import { ROOMS_STATS } from "./roomsStats";

const lodging = deptLevel(2, DEPT.lodgingOperations);
const profitExpenses = [accLevel(4, ACC.profitAmount), accNotLevel(6, ACC.revenue)] as const;
const totalExpenses = accLevel(6, ACC.totalExpenses);

export const EXPENSES: CatalogGroup = {
  id: "expenses",
  requires: [REVENUE, ROOMS_STATS],
  atoms: [
    atom("gop_expenses", "Operating expenses (Lodging Operations × Profit Amount, less Revenue)", lodging, ...profitExpenses),
    atom("rooms_expenses", "Rooms expenses (Rooms and Reservation × Profit Amount, less Revenue)", lodging, deptLevel(7, DEPT.roomsAndReservation), ...profitExpenses),
    atom("fb_expenses", "F&B expenses", deptLevel(5, DEPT.totalFoodAndBeverage), ...profitExpenses),
    atom("other_expenses", "Other operated departments expenses", deptLevel(5, DEPT.otherOperatedDepartments), ...profitExpenses),
    atom("rooms_total_expenses", "Rooms total expenses (level 6)", deptLevel(7, DEPT.roomsAndReservation), totalExpenses),

    atom("ag_expenses", "Administrative & General total expenses", deptLevel(7, DEPT.administrativeAndGeneral), totalExpenses),
    atom("credit_card_expenses", "Credit card expense (level 14)", accLevel(14, ACC.creditCardExpense)),
    atom("it_expenses", "Information & Telecom Systems total expenses", deptLevel(7, DEPT.informationAndTelecom), totalExpenses),
    atom("utilities_expenses", "Utilities total expenses", deptLevel(7, DEPT.utilities), totalExpenses),
    atom("pom_expenses", "Property Operation & Maintenance total expenses", deptLevel(7, DEPT.propertyOperations), totalExpenses),
    atom("sm_expenses", "Sales & Marketing total expenses", deptLevel(7, DEPT.salesAndMarketing), totalExpenses),
    atom("other_uoe_expenses", "Other UOE total expenses", deptLevel(7, DEPT.otherUoe), totalExpenses),
    atom("ta_commissions", "Travel agent commissions (Lodging Operations)", lodging, accLevel(15, ACC.taCommissions)),

    atom("ebitda_revenue", "EBITDA-level revenue (Lodging Operations)", lodging, accLevel(1, ACC.ebitda), accLevel(6, ACC.revenue)),
    atom("ebitda_expenses", "EBITDA-level expenses (Lodging Operations)", lodging, accLevel(1, ACC.ebitda), accNotLevel(6, ACC.revenue)),
    atom("noi_items", "NOI-level items (NOI departments)", deptLevel(2, DEPT.noi), accLevel(1, ACC.noi)),
    atom("replacement_reserve", "Replacement reserve (D0480 × A701110/A701111/A759372)", deptBase(CODES.replacementReserveDept), accBase(...CODES.replacementReserve)),
  ],
  measures: [
    measure("gop", "total_revenue - gop_expenses", "currency", "Gross Operating Profit"),
    measure("gop_margin", "pct(gop, total_revenue)", "percent", "Gross Operating Profit Margin"),
    measure("rooms_profit", "rooms_revenue - rooms_expenses", "currency", "Rooms Dept Profit"),
    measure("rooms_profit_pct", "pct(rooms_profit, rooms_revenue)", "percent", "Rooms Dept Profit %"),
    measure("fb_profit", "fb_revenue - fb_expenses", "currency", "F&B Dept Profit"),
    measure("fb_profit_pct", "pct(fb_profit, fb_revenue)", "percent", "F&B Dept Profit %"),
    measure("other_profit", "other_revenue - other_expenses", "currency", "Other Dept Profit"),
    measure("other_profit_pct", "pct(other_profit, other_revenue)", "percent", "Other Dept Profit %"),
    measure("department_profit", "rooms_profit + fb_profit + other_profit", "currency", "Department Profit"),
    measure("department_revenue", "rooms_revenue + fb_revenue + other_revenue", "currency", "Department Revenue"),
    measure("department_profit_pct", "pct(department_profit, department_revenue)", "percent", "Department Profit %"),

    costMeasure("ag_without_cc", "ag_expenses - credit_card_expenses", "currency", "Administrative & General w/o CC"),
    costMeasure("credit_card", "credit_card_expenses", "currency", "Credit Card Expense (CC)"),
    costMeasure("it_and_telecom", "it_expenses", "currency", "IT & Telephone"),
    costMeasure("utilities", "utilities_expenses", "currency", "Energy, Water & Waste"),
    costMeasure("pom", "pom_expenses", "currency", "Property Operation & Maintenance"),
    costMeasure("sales_and_marketing", "sm_expenses", "currency", "Sales & Marketing"),
    costMeasure("other_uoe", "other_uoe_expenses", "currency", "Other UOE"),
    measure(
      "total_uoe",
      "ag_expenses + it_expenses + utilities_expenses + pom_expenses + sm_expenses + other_uoe_expenses",
      "currency",
      "Total UOE"
    ),
    costMeasure("ta_commission_cost", "ta_commissions", "currency", "Travel Agent Commission Cost"),
    costMeasure("room_cpor", "div(rooms_total_expenses, rooms_sold)", "rate", "Room CPOR"),

    measure("lodging_ebitda", "ebitda_revenue - ebitda_expenses", "currency", "Lodging Operations EBITDA"),
    measure("noi", "lodging_ebitda + noi_items - replacement_reserve", "currency", "Net Operating Income"),
  ],
};
