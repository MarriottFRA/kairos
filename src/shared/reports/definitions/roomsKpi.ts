/**
 * Rooms & Reservation KPIs — PS Loader's Rooms KPI block: the room
 * statistics and rates, supplies per room night sold, operating equipment
 * usage, and payroll / other expenses as a share of room sales.
 */

import { ROOMS_KPI, ROOMS_STATS } from "../catalog";
import { defineReport, header, line, spacer } from "./defineReport";

export const ROOMS_KPI_REPORT = defineReport({
  id: "rooms_kpi",
  name: "Rooms & Reservation KPIs",
  description:
    "Occupancy, ADR, RevPAR and bed statistics, supplies and equipment per room night sold, and payroll and other expenses as a share of room sales.",
  use: [ROOMS_STATS, ROOMS_KPI],
  rows: [
    header("ROOMS STATISTICS"),
    line("occupancy", "Occupancy %", 1),
    line("adr", "ADR", 1),
    line("revpar", "RevPAR", 1),
    line("revpar_after_tac", "RevPAR after TAC", 1),
    line("rooms_available_line", "Rooms Available", 1),
    line("rooms_sold_line", "Rooms Sold", 1),
    line("bed_nights_sold_line", "Bed Nights Sold", 1),
    line("bed_nights_available_line", "Bed Nights Available", 1),
    line("bed_occupancy", "Average Bed Occupancy %", 1),
    line("average_guest_rate", "Average Guest Rate", 1),
    line("double_occupancy", "Double Occupancy %", 1),
    spacer(),
    header("PER ROOM NIGHT SOLD"),
    line("operating_supplies_prns", "Operating Supplies", 1),
    line("cleaning_supplies_prns", "Cleaning Supplies", 1),
    line("guest_supplies_prns", "Guest Supplies", 1),
    line("paper_supplies_prns", "Paper Supplies", 1),
    line("printing_prns", "Printing & Stationery", 1),
    line("laundry_prns", "Laundry", 1),
    spacer(),
    header("OPERATING EQUIPMENT USAGE PER ROOM NIGHT SOLD"),
    line("flatware_prns", "Flatware", 1),
    line("linen_prns", "Linen", 1),
    line("glassware_prns", "Glassware", 1),
    line("room_smalls_prns", "Room Smalls", 1),
    spacer(),
    header("PERCENTAGE OF ROOM SALES"),
    line("payroll_pct_rooms_revenue", "Payroll", 1),
    line("other_exp_pct_rooms_sales", "Other Expenses", 1),
  ],
});
