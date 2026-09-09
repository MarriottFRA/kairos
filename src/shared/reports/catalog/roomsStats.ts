/**
 * Rooms statistics — rooms available / sold (workbook rows 3–4, under
 * department level_10 "Rooms"), bed nights and the rooms-only travel agent
 * commission (PS Loader's Rooms KPI block), and the KPIs over them:
 * occupancy, ADR, RevPAR (rooms and total), RevPAR after TAC, bed occupancy,
 * average guest rate, double occupancy.
 *
 * A stat account is in actual units on both sources. The ratios are
 * column-wise, so a Total is the ratio of the totals — annual occupancy is
 * Σ sold ÷ Σ available, never the mean of twelve monthly figures.
 */

import { CODES, CatalogGroup, DEPT, accBase, atom, deptLevel, measure } from "./helpers";
import { REVENUE } from "./revenue";

const rooms = deptLevel(10, DEPT.rooms);

export const ROOMS_STATS: CatalogGroup = {
  id: "rooms_stats",
  requires: [REVENUE],
  atoms: [
    atom("rooms_available", "Rooms available (A960101)", rooms, accBase(CODES.roomsAvailable)),
    atom("rooms_sold", "Rooms sold (A960103)", rooms, accBase(CODES.roomsSold)),
    atom("bed_nights_available", "Bed nights available (A960004)", rooms, accBase(CODES.bedNightsAvailable)),
    atom("bed_nights_sold", "Bed nights sold (A960005)", rooms, accBase(CODES.bedNightsSold)),
    atom("rooms_tac", "Travel agent commission, Rooms (A608201)", rooms, accBase(CODES.travelAgentCommissionRooms)),
  ],
  measures: [
    measure("rooms_available_line", "rooms_available", "number", "Rooms Available"),
    measure("rooms_sold_line", "rooms_sold", "number", "Rooms Sold"),
    measure("occupancy", "pct(rooms_sold, rooms_available)", "percent", "Occupancy"),
    measure("adr", "div(rooms_revenue, rooms_sold)", "rate", "ADR"),
    measure("revpar", "div(rooms_revenue, rooms_available)", "rate", "RevPAR"),
    measure("total_revpar", "div(total_revenue, rooms_available)", "rate", "Total RevPAR"),
    measure("revpar_after_tac", "div(rooms_revenue - rooms_tac, rooms_available)", "rate", "RevPAR after TAC"),
    measure("bed_nights_available_line", "bed_nights_available", "number", "Bed Nights Available"),
    measure("bed_nights_sold_line", "bed_nights_sold", "number", "Bed Nights Sold"),
    measure("bed_occupancy", "pct(bed_nights_sold, bed_nights_available)", "percent", "Average Bed Occupancy"),
    measure("average_guest_rate", "div(rooms_revenue, bed_nights_sold)", "rate", "Average Guest Rate"),
    measure("double_occupancy", "pct(bed_nights_sold - rooms_sold, rooms_sold)", "percent", "Double Occupancy"),
  ],
};
