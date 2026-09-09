/**
 * Revenue — Summary P&L rows 11, 21, 24, 29 of the workbook: total sales and
 * the three department sales lines, each "department scope × level_6
 * Revenue". Positive as stored in the BST (see catalog/index.ts).
 */

import { ACC, CatalogGroup, DEPT, accLevel, atom, deptLevel, measure } from "./helpers";

const revenue = accLevel(6, ACC.revenue);

export const REVENUE: CatalogGroup = {
  id: "revenue",
  atoms: [
    atom("total_revenue", "Total revenue (Lodging Operations × Revenue)", deptLevel(2, DEPT.lodgingOperations), revenue),
    atom("rooms_revenue", "Rooms revenue", deptLevel(5, DEPT.roomsAndReservation5), revenue),
    atom("fb_revenue", "F&B revenue", deptLevel(5, DEPT.totalFoodAndBeverage), revenue),
    atom("other_revenue", "Other operated departments revenue", deptLevel(5, DEPT.otherOperatedDepartments), revenue),
  ],
  measures: [
    measure("total_sales", "total_revenue", "currency", "Total Sales"),
    measure("rooms_sales", "rooms_revenue", "currency", "Rooms Sales"),
    measure("fb_sales", "fb_revenue", "currency", "F&B Sales"),
    measure("other_sales", "other_revenue", "currency", "Other Sales"),
  ],
};
