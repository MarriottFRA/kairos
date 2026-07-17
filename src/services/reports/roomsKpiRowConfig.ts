import { PLRow } from '../../types/plReportTypes';

/**
 * Rooms & Reservation Summary KPI block — shared mapping table.
 *
 * Used by non-Protea reports (Summary P&L, F90 P&L, Marriott Excel Export).
 * Append (or splice) into a report's row config to render the block.
 *
 * The Protea Report / Budget Pack uses ROOMS_KPI_CONFIG (in proteaShared.ts)
 * — same labels, but the percent-of-room-sales rows reference the `_protea`
 * measure variants so the totals match Protea's category repoints. See
 * plMeasureDefinitions.ts comment block "ROOMS & RESERVATION SUMMARY KPIs".
 */
export const ROOMS_KPI_ROW_CONFIG: PLRow[] = [
  { type: 'header',  label: 'Rooms & Reservation Summary', indentLevel: 0 },
  { type: 'measure', label: 'Occupancy %',                 measureId: 'occupancy_rooms',         formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'ADR',                         measureId: 'adr',                     formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'RevPAR',                      measureId: 'rev_par',                 formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'RevPAR after TAC',            measureId: 'rev_par_after_tac',       formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Rooms Available',            measureId: 'total_rooms',             formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Rooms SOLD',                  measureId: 'sold_rooms',              formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Bed Nights Sold',             measureId: 'bed_nights_sold',         formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Bed Nights Available',        measureId: 'bed_nights_avail',        formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Average Bed Occupancy %',     measureId: 'avg_bed_occupancy_pct',   formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Average Guest Rate',          measureId: 'avg_guest_rate',          formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Double Occupancy %',          measureId: 'double_occupancy_pct',    formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Rooms Available per Day',     measureId: 'rooms_available_per_day', formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Bed Available per Day',       measureId: 'bed_available_per_day',   formatting: 'number',     indentLevel: 1 },

  { type: 'header',  label: 'Per Room Night Sold', indentLevel: 0 },
  { type: 'measure', label: 'Operating Supplies',         measureId: 'prns_operating_supplies',   formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Cleaning Supplies',          measureId: 'prns_cleaning_supplies',    formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Guest Supplies',             measureId: 'prns_guest_supplies',       formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Paper Supplies',             measureId: 'prns_paper_supplies',       formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Printing & Stationery',      measureId: 'prns_printing_stationery',  formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Laundry',                    measureId: 'prns_laundry',              formatting: 'number', indentLevel: 1 },

  { type: 'header',  label: 'Operating Equipment Usage per Room Night Sold', indentLevel: 0 },
  { type: 'measure', label: 'Flatware (Cutlery)', measureId: 'prns_flatware',  formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Linen',              measureId: 'prns_linen',     formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Glassware',          measureId: 'prns_glassware', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Room Smalls',        measureId: 'prns_smalls',    formatting: 'number', indentLevel: 1 },

  { type: 'header',  label: 'Percentage of Room Sales', indentLevel: 0 },
  { type: 'measure', label: 'Payroll as a % of Room Sales',         measureId: 'payroll_pct_rooms_sales',   formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Other Expenses as a % of Room Sales',  measureId: 'other_exp_pct_rooms_sales', formatting: 'percentage', indentLevel: 1 },
];
