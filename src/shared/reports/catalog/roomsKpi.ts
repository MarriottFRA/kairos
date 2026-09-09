/**
 * The Rooms & Reservation KPI block PS Loader appends to its Summary P&L
 * and F90 (roomsKpiRowConfig.ts): supplies per room night sold, operating
 * equipment usage per room night sold, and payroll / other expenses as a
 * share of room sales. Numerators are Rooms and Reservation (level_7) base
 * accounts; the denominator is rooms sold.
 */

import { ACC, CODES, CatalogGroup, DEPT, accBase, accLevel, accNotLevel, atom, costMeasure, deptLevel } from "./helpers";
import { PAYROLL } from "./payroll";
import { ROOMS_STATS } from "./roomsStats";

const roomsRes = deptLevel(7, DEPT.roomsAndReservation);

export const ROOMS_KPI: CatalogGroup = {
  id: "rooms_kpi",
  requires: [ROOMS_STATS, PAYROLL],
  atoms: [
    atom("rooms_flatware", "Flatware (A610102)", roomsRes, accBase(CODES.flatware)),
    atom("rooms_linen", "Linen (A610105)", roomsRes, accBase(CODES.linen)),
    atom("rooms_glassware", "Glassware (A610402)", roomsRes, accBase(CODES.glassware)),
    atom("rooms_smalls", "Room smalls (A610125)", roomsRes, accBase(CODES.roomSmalls)),
    atom("rooms_cleaning_supplies", "Cleaning supplies (A610106)", roomsRes, accBase(CODES.cleaningSupplies)),
    atom("rooms_guest_supplies", "Guest supplies (A610201)", roomsRes, accBase(CODES.guestSupplies)),
    atom("rooms_paper_supplies", "Paper supplies (A610104)", roomsRes, accBase(CODES.paperSupplies)),
    atom("rooms_printing", "Printing & stationery (A606101)", roomsRes, accBase(CODES.printingAndStationery)),
    atom("rooms_laundry", "Laundry (A602406)", roomsRes, accBase(CODES.laundry)),
    atom(
      "rooms_controllables",
      "Rooms controllables (Profit Amount, less Revenue, Total Payroll and Cost Of Sales)",
      roomsRes,
      accLevel(4, ACC.profitAmount),
      accNotLevel(6, ACC.revenue),
      accNotLevel(9, ACC.totalPayroll, "Cost Of Sales")
    ),
  ],
  measures: [
    costMeasure("operating_supplies_prns", "div(rooms_flatware + rooms_linen + rooms_glassware + rooms_smalls, rooms_sold)", "ratio", "Operating Supplies"),
    costMeasure("cleaning_supplies_prns", "div(rooms_cleaning_supplies, rooms_sold)", "ratio", "Cleaning Supplies"),
    costMeasure("guest_supplies_prns", "div(rooms_guest_supplies, rooms_sold)", "ratio", "Guest Supplies"),
    costMeasure("paper_supplies_prns", "div(rooms_paper_supplies, rooms_sold)", "ratio", "Paper Supplies"),
    costMeasure("printing_prns", "div(rooms_printing, rooms_sold)", "ratio", "Printing & Stationery"),
    costMeasure("laundry_prns", "div(rooms_laundry, rooms_sold)", "ratio", "Laundry"),
    costMeasure("flatware_prns", "div(rooms_flatware, rooms_sold)", "ratio", "Flatware"),
    costMeasure("linen_prns", "div(rooms_linen, rooms_sold)", "ratio", "Linen"),
    costMeasure("glassware_prns", "div(rooms_glassware, rooms_sold)", "ratio", "Glassware"),
    costMeasure("room_smalls_prns", "div(rooms_smalls, rooms_sold)", "ratio", "Room Smalls"),
    costMeasure("other_exp_pct_rooms_sales", "pct(rooms_controllables, rooms_revenue)", "percent", "Other Expenses % of Room Sales"),
  ],
};
