/**
 * Protea Shared Module
 * ====================
 * Constants, styling, configs, and utility functions shared between
 * ProteaReportPackService and ProteaBudgetPackService.
 * Single source of truth — changes here affect both reports.
 */

import ExcelJS from 'exceljs';
import { PLRow } from '../../types/plReportTypes';
import * as db from '../../local_db';
import { BANQUETING_DEPARTMENT_CODES } from './departmentScopes';

// ============================================================================
// KPI ROW CONFIGS — used to compute KPIs via the F90 calculation engine
// instead of from raw department detail data (which can miss stats/categories)
// ============================================================================

export const ROOMS_KPI_CONFIG: PLRow[] = [
  { type: 'measure', label: 'Rooms Available', measureId: 'total_rooms', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Sold Rooms', measureId: 'sold_rooms', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Rooms Revenue', measureId: 'rooms_reservations_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Occupancy %', measureId: 'occupancy_rooms', formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'ADR', measureId: 'adr', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'RevPAR', measureId: 'rev_par', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'RevPAR after TAC', measureId: 'rev_par_after_tac', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Rooms Dept Profit %', measureId: 'rooms_dept_profit_pct', formatting: 'percentage', indentLevel: 1 },
  // Bed-night & guest-rate KPIs (engine-computed, period-independent)
  { type: 'measure', label: 'Bed Nights Sold',         measureId: 'bed_nights_sold',         formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Bed Nights Available',    measureId: 'bed_nights_avail',        formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Average Bed Occupancy %', measureId: 'avg_bed_occupancy_pct',   formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Average Guest Rate',      measureId: 'avg_guest_rate',          formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Double Occupancy %',      measureId: 'double_occupancy_pct',    formatting: 'percentage', indentLevel: 1 },
  // Period-aware (engine reads periodDays from getProteaF90PLData)
  { type: 'measure', label: 'Rooms Available per Day', measureId: 'rooms_available_per_day', formatting: 'number',     indentLevel: 1 },
  { type: 'measure', label: 'Bed Available per Day',   measureId: 'bed_available_per_day',   formatting: 'number',     indentLevel: 1 },
  // Per Room Night Sold — engine-driven dollars-per-sold-room. Numerator
  // scoped to Rooms group (dept_level 7); denominator (sold rooms) is hotel-
  // Rooms scope. Operating Supplies is a roll-up of the four Operating
  // Equipment Usage items below.
  { type: 'measure', label: 'Operating Supplies',    measureId: 'prns_operating_supplies',  formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Cleaning Supplies',     measureId: 'prns_cleaning_supplies',   formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Guest Supplies',        measureId: 'prns_guest_supplies',      formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Paper Supplies',        measureId: 'prns_paper_supplies',      formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Printing & Stationery', measureId: 'prns_printing_stationery', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Laundry',               measureId: 'prns_laundry',             formatting: 'number', indentLevel: 1 },
  // Operating Equipment Usage per Room Night Sold (per-item breakdown of the
  // accounts that roll into prns_operating_supplies above).
  { type: 'measure', label: 'Flatware (Cutlery)', measureId: 'prns_flatware',  formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Linen',              measureId: 'prns_linen',     formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Glassware',          measureId: 'prns_glassware', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Room Smalls',        measureId: 'prns_smalls',    formatting: 'number', indentLevel: 1 },
  // Percent-of-room-sales — Protea variants (numerator includes the
  // PROTEA_CATEGORY_REPOINTS-moved accounts so the KPI matches what the
  // Protea report actually displays for Total Payroll / Controllables).
  { type: 'measure', label: 'Payroll as a % of Room Sales',        measureId: 'payroll_pct_rooms_sales_protea',   formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Other Expenses as a % of Room Sales', measureId: 'other_exp_pct_rooms_sales_protea', formatting: 'percentage', indentLevel: 1 },
];

export const FB_KPI_CONFIG: PLRow[] = [
  // Existing % KPIs
  { type: 'measure', label: '% Food COS',         measureId: 'food_cost_pct_sales', formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: '% Beverage COS',     measureId: 'bev_cost_pct_sales',  formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'F&B Dept Profit %',  measureId: 'fb_dept_profit_pct',  formatting: 'percentage', indentLevel: 1 },

  // Covers — counts of customers per meal period. Per spec: Breakfast/Lunch/
  // Dinner are scoped to F&B EXCLUDING banqueting; Banqueting Customer is
  // banqueting depts only. See plMeasureDefinitions.ts for filter details.
  { type: 'measure', label: 'Breakfast Customers',  measureId: 'fb_breakfast_customers',  formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Lunch Customers',      measureId: 'fb_lunch_customers',      formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Dinner Customers',     measureId: 'fb_dinner_customers',     formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Late Snack Customers', measureId: 'fb_late_snack_customers', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Banqueting Customer',  measureId: 'banq_customers',          formatting: 'number', indentLevel: 1 },

  // Average Food Spend — per-meal revenue ÷ per-meal customers (same scoping).
  { type: 'measure', label: 'Avg Breakfast Spend',  measureId: 'avg_breakfast_spend',  formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Avg Lunch Spend',      measureId: 'avg_lunch_spend',      formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Avg Dinner Spend',     measureId: 'avg_dinner_spend',     formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Avg Late Snack Spend', measureId: 'avg_late_snack_spend', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Avg Banqueting Spend', measureId: 'avg_banq_spend',       formatting: 'number', indentLevel: 1 },

  // Covers as % of Bed Nights Sold — per-meal customers ÷ A960005 (Rooms-scope
  // bed nights). Bed nights denominator intentionally hotel-Rooms (not pinned
  // to F&B depts) — matches spec "the bednight would come from rooms departments".
  { type: 'measure', label: 'Breakfast Customers as % of Bed Nights',  measureId: 'breakfast_pct_bed_nights',  formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Lunch Customers as % of Bed Nights',      measureId: 'lunch_pct_bed_nights',      formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Dinner Customers as % of Bed Nights',     measureId: 'dinner_pct_bed_nights',     formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Late Snack Customers as % of Bed Nights', measureId: 'late_snack_pct_bed_nights', formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Banqueting Customer as % of Bed Nights',  measureId: 'banq_pct_bed_nights',       formatting: 'percentage', indentLevel: 1 },

  // Cost Per Cover — denominator is fb_total_covers_act (every A914xxx in
  // F&B INCLUDING banqueting per spec). Operating Supplies is the SUM of
  // the six Operating Equipment Usage atoms below.
  { type: 'measure', label: 'Operating Supplies',    measureId: 'cpc_operating_supplies',  formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Cleaning Supplies',     measureId: 'cpc_cleaning_supplies',   formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Guest Supplies',        measureId: 'cpc_guest_supplies',      formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Paper Supplies',        measureId: 'cpc_paper_supplies',      formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Printing & Stationery', measureId: 'cpc_printing_stationery', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Laundry',               measureId: 'cpc_laundry',             formatting: 'number', indentLevel: 1 },

  // Operating Equipment Usage per Cover — per-item breakdown of the same
  // accounts that roll into cpc_operating_supplies above.
  { type: 'measure', label: 'Flatware (Cutlery)',     measureId: 'cpc_flatware',         formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'China (Crockery)',       measureId: 'cpc_china',            formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Kitchen Utensils',       measureId: 'cpc_kitchen_utensils', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Linen',                  measureId: 'cpc_linen',            formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Glassware',              measureId: 'cpc_glassware',        formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Restaurant/Bar Smalls',  measureId: 'cpc_smalls',           formatting: 'number', indentLevel: 1 },

  // Percentage of F&B Sales — Protea variants used here so totals match what
  // the Protea report displays for Total Payroll / Controllables (which
  // include the PROTEA_CATEGORY_REPOINTS-moved accounts).
  { type: 'measure', label: 'Payroll as a % of F&B Sales',         measureId: 'payroll_pct_fb_sales_protea',   formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Other Expenses as a % of F&B Sales',  measureId: 'other_exp_pct_fb_sales_protea', formatting: 'percentage', indentLevel: 1 },
];

// ============================================================================
// "<group> % of Hotel Revenue" KPI configs — used by Administrative & General,
// Property Operation & Maintenance, and Sales & Marketing & Convention
// Service group summary sheets.
//
// All three configs have identical labels and shape; only the underlying
// measure IDs change per-group (generated by registerPctOfRevenueQuartet in
// plMeasureDefinitions.ts). The renderer uses PCT_OF_REVENUE_KPI_GROUPS
// (below) to dispatch to the right config given the active groupName.
//
// Adding a new group: register a quartet in plMeasureDefinitions.ts, add an
// entry below using the matching key, and add it to the dispatch map.
// ============================================================================

const buildPctOfRevenueConfig = (key: string): PLRow[] => [
  // Protea variants — numerator includes PROTEA_CATEGORY_REPOINTS-moved
  // accounts so totals match what the Protea report displays for Payroll /
  // Controllables. Same naming pattern as the Rooms / F&B equivalents.
  { type: 'measure', label: 'Payroll as a % of Revenue',        measureId: `payroll_pct_revenue_${key}_protea`,   formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Other Expenses as a % of Revenue', measureId: `other_exp_pct_revenue_${key}_protea`, formatting: 'percentage', indentLevel: 1 },
];

export const AG_KPI_CONFIG:  PLRow[] = buildPctOfRevenueConfig('ag');
export const POM_KPI_CONFIG: PLRow[] = buildPctOfRevenueConfig('pom');
export const SM_KPI_CONFIG:  PLRow[] = buildPctOfRevenueConfig('sm');

/** Group summary sheets that should render the "% of Hotel Revenue" KPI block.
 *  Keyed by the renderer's `groupName` value. */
export const PCT_OF_REVENUE_KPI_GROUPS: ReadonlyMap<string, PLRow[]> = new Map([
  ['Administrative & General',                        AG_KPI_CONFIG],
  ['Property Operation & Maintenance',                POM_KPI_CONFIG],
  ['Sales & Marketing and Convention Service',        SM_KPI_CONFIG],
]);

// ============================================================================
// CONSTANTS
// ============================================================================

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Accounts whose code starts with A759 are carved out into their own "Levies"
// sub-group on Protea Pack summary sheets (both Report and Budget). The rule is
// renderer-scoped — it does NOT alter classifyAccountsByLevel20() or the F90
// measure engine, so F90 totals stay unchanged.
export const LEVIES_SUBGROUP = 'Levies';
export const isLeviesAccount = (acct: string | undefined | null): boolean =>
  !!acct && acct.toUpperCase().startsWith('A759');

// ============================================================================
// STYLING CONSTANTS
// ============================================================================

// Tab color scheme for worksheet tabs
export const TAB_COLOR_REPORT: Partial<ExcelJS.Color> = { argb: 'FF1E3A5F' };    // Dark blue - F90, Room Segments
export const TAB_COLOR_GROUP_SUMMARY: Partial<ExcelJS.Color> = { argb: 'FF2D5F8A' }; // Medium navy - Group summaries
export const TAB_COLOR_DEPARTMENT: Partial<ExcelJS.Color> = { argb: 'FF8899AA' };   // Blue-gray - Individual departments

export const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E3A5F' }  // Dark blue
};

export const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },  // White
  size: 11
};

export const SECTION_HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF4A4A4A' }  // Dark charcoal gray
};

export const SECTION_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 11,
  color: { argb: 'FFFFFFFF' }  // White
};

export const CATEGORY_HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF0F4F8' }  // Very light blue-gray
};

export const CATEGORY_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10
};

export const SEPARATOR_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF8899AA' }  // Blue-gray separator
};

export const SUBTOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFDCE6F0' }  // Light blue for subtotals
};

// level_12 group header - slightly indented, subtle background
export const GROUP_HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF5F7FA' }  // Very subtle blue-gray, lighter than category
};

export const GROUP_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10,
  color: { argb: 'FF4A5568' }  // Dark gray
};

// level_12 group subtotal - subtle distinction from category subtotal
export const GROUP_SUBTOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFEDF2F7' }  // Light blue-gray
};

export const GROUP_SUBTOTAL_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10
};

// Category total header - medium navy with white text, strong visual separator
export const CATEGORY_TOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF2D5F8A' }  // Medium navy
};

export const CATEGORY_TOTAL_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10,
  color: { argb: 'FFFFFFFF' }  // White
};

export const CATEGORY_TOTAL_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'medium', color: { argb: 'FF1E3A5F' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FF1E3A5F' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};

export const GROUP_SUBTOTAL_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF1E3A5F' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FF1E3A5F' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};

export const DATA_FONT: Partial<ExcelJS.Font> = {
  size: 10
};

export const TOTAL_ROW_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'medium', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};

export const BORDER_STYLE: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};

// ============================================================================
// STYLING FUNCTIONS
// ============================================================================

export function applyHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  row.height = 24;
}

export function applySectionHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = SECTION_HEADER_FILL;
    cell.font = SECTION_HEADER_FONT;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: 'middle' };
  });
  row.height = 28;
}

export function applyCategoryHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = CATEGORY_HEADER_FILL;
    cell.font = CATEGORY_HEADER_FONT;
    cell.border = BORDER_STYLE;
  });
  row.height = 20;
}

export function applyDataRowStyle(row: ExcelJS.Row, isHeader: boolean = false): void {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = isHeader ? { ...DATA_FONT, bold: true } : DATA_FONT;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
  });
}

export function applyGroupHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = GROUP_HEADER_FILL;
    cell.font = GROUP_HEADER_FONT;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: 'middle' };
  });
  row.height = 18;
}

export function applyGroupSubtotalStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.fill = GROUP_SUBTOTAL_FILL;
    cell.font = GROUP_SUBTOTAL_FONT;
    cell.border = GROUP_SUBTOTAL_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
  });
  row.height = 18;
}

export function applyCategorySubtotalStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.fill = CATEGORY_TOTAL_FILL;
    cell.font = CATEGORY_TOTAL_FONT;
    cell.border = CATEGORY_TOTAL_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
  });
  row.height = 22;
}

// ============================================================================
// FORMATTING UTILITIES
// ============================================================================

export function formatNumber(value: number | null, decimals: number = 0): number | string {
  if (value === null || value === undefined) return '';
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

export function formatPercentage(value: number | null): string {
  if (value === null || value === undefined) return '';
  // Values from the engine are already in 0-100 scale (e.g. 72.5 for 72.5%)
  return `${value.toFixed(1)}%`;
}

export function sanitizeSheetName(name: string): string {
  // Excel sheet names: max 31 chars, no special chars: \ / * ? : [ ]
  // department_description_detail_level_max already contains dept name + ID
  const sanitized = name.replace(/[\\/*?:\[\]]/g, '').trim();
  return sanitized.substring(0, 31) || 'Sheet';
}

export function getRangeLabel(
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number
): string {
  // Single month: start and end are identical
  if (startMonth === endMonth && startYear === endYear) {
    return `Period: ${MONTH_NAMES[startMonth - 1]} ${startYear}`;
  }

  // Jan through Dec of the same year = full year
  if (startMonth === 1 && endMonth === 12 && startYear === endYear) {
    return `Full Year: ${startYear}`;
  }

  // Jan through some month of the same year = year to date
  if (startMonth === 1 && startYear === endYear) {
    return `Year to Date: ${MONTH_NAMES[startMonth - 1]} ${startYear} - ${MONTH_NAMES[endMonth - 1]} ${endYear}`;
  }

  // Everything else is a custom range
  return `Custom Range: ${MONTH_NAMES[startMonth - 1]} ${startYear} - ${MONTH_NAMES[endMonth - 1]} ${endYear}`;
}

// ============================================================================
// DUPLICATE ACCOUNT AGGREGATION
// ============================================================================

/** Aggregate rows that share the same account code by summing their numeric fields.
 *  Keeps the first row's metadata (accountName, category, level12Group, level13Group).
 *  Needed after merging data from moved departments, which may share accounts with
 *  the target group's native departments. */
export function aggregateDuplicateAccounts(rows: any[]): any[] {
  const map = new Map<string, any>();
  for (const row of rows) {
    const existing = map.get(row.account);
    if (existing) {
      existing.actuals = (existing.actuals || 0) + (row.actuals || 0);
      existing.budget = (existing.budget || 0) + (row.budget || 0);
      existing.ly = (existing.ly || 0) + (row.ly || 0);
      existing.vsBud = (existing.vsBud || 0) + (row.vsBud || 0);
      existing.vsLy = (existing.vsLy || 0) + (row.vsLy || 0);
    } else {
      map.set(row.account, { ...row });
    }
  }
  return Array.from(map.values());
}

// ============================================================================
// LABEL RENAME
// ============================================================================

/**
 * Replace "Miscellaneous"/"Misc" with "Sundry" for Protea display labels.
 * Applied at render level only — underlying data is unchanged.
 */
export function proteaRenameLabel(label: string): string {
  return label
    .replace(/\bMiscellaneous\b/gi, 'Sundry')
    .replace(/\bMisc\b/gi, 'Sundry');
}

// ============================================================================
// EXCLUDED DEPARTMENTS
// ============================================================================

export const EXCEL_EXCLUDED_DEPARTMENTS = db.NON_OPERATING_EXCLUDED_DEPARTMENTS;

// ============================================================================
// PROTEA ACCOUNT MOVEMENT CONFIG
// Insurance (A730xxx), audit (A745xxx), and A701603 accounts on D0480/D0490/D0690
// are reported as if they belong to D0410 (Admin & General).  This is a
// report-level-only adjustment — the underlying data is unchanged.
// ============================================================================
export const PROTEA_MOVED_ACCOUNT_PREFIXES = ['A730', 'A745'];
export const PROTEA_MOVEMENT_SOURCE_DEPTS = ['D0480', 'D0490', 'D0690', 'D0691'];
export const isMovedAccount = (acct: string) =>
  PROTEA_MOVED_ACCOUNT_PREFIXES.some(p => acct.startsWith(p));

// ============================================================================
// DETAIL-ONLY ACCOUNTS
// Accounts hidden from summary-only views (detail tabs OFF) but visible when
// detail tabs are ON, so users can audit them. Used for low-signal driver
// /allocation stats that add noise to executive summaries. Mirrors the
// isMovedAccount predicate shape — prefix list + startsWith check.
// ============================================================================
export const PROTEA_DETAIL_ONLY_ACCOUNT_PREFIXES: readonly string[] = ['A9141'];
export const isDetailOnlyAccount = (acct: string): boolean =>
  PROTEA_DETAIL_ONLY_ACCOUNT_PREFIXES.some(p => acct.startsWith(p));

// ============================================================================
// PROTEA DEPARTMENT-LEVEL MOVEMENT CONFIG
// Certain departments report under a different group in the Protea extract.
// Report-level only — underlying data is unchanged.  The F90 is unaffected.
// ============================================================================
export interface DepartmentMovement {
  sourceDept: string;        // Department to move from its native level_7 group
  targetGroup: string;       // level_7 group name it merges into
  detailMergeTarget: string; // Department whose detail tab receives the merged data
}

export const PROTEA_DEPARTMENT_MOVEMENTS: DepartmentMovement[] = [
  { sourceDept: 'D0400', targetGroup: 'Administrative & General', detailMergeTarget: 'D0410' },
  { sourceDept: 'D0480', targetGroup: 'Invest Factor Owner',     detailMergeTarget: 'D0490' },
  { sourceDept: 'D0690', targetGroup: 'Invest Factor Owner',     detailMergeTarget: 'D0490' },
  { sourceDept: 'D0691', targetGroup: 'Invest Factor Owner',     detailMergeTarget: 'D0490' },
];

// Banqueting departments — split out of F&B when banqueting toggle is on
// Derived from BANQUETING_DEPARTMENT_CODES (single source of truth in
// departmentScopes.ts). Set wrapper gives O(1) membership lookup for renderers.
export const BANQUETING_DEPARTMENTS: ReadonlySet<string> = new Set(BANQUETING_DEPARTMENT_CODES);

/** Preferred display order for department groups in the Protea report pack.
 *  Groups not listed here appear after these in their natural (alphabetical) order.
 *  'Total Banqueting' only appears when the banqueting toggle is enabled. */
export const PROTEA_GROUP_DISPLAY_ORDER: string[] = [
  'Rooms and Reservation',
  'Total Food & Beverage',
  'Total Banqueting',
  'Other Operated Departments',
  'Administrative & General',
];

// Derived lookups for fast access
export const MOVED_DEPT_SET = new Set(PROTEA_DEPARTMENT_MOVEMENTS.map(m => m.sourceDept));
export const MOVED_DEPT_BY_SOURCE = new Map(PROTEA_DEPARTMENT_MOVEMENTS.map(m => [m.sourceDept, m]));
export const MOVEMENT_TARGET_GROUPS = new Set(PROTEA_DEPARTMENT_MOVEMENTS.map(m => m.targetGroup));

// ============================================================================
// INVEST FACTOR OWNER — LEVEL 20 ACCOUNT CLASSIFIER
// Shared by both report and budget pack for consistent subgroup assignment.
// ============================================================================

import { InvestSubgroupDef, INVEST_CUSTOM_SUBGROUPS } from './investSubgroupConfig';

export interface AccountClassification {
  subgroup: string;
  isUnmapped: boolean;  // true when account fell to catch-all without a recognized level_20 value
}

/**
 * Classify accounts into invest subgroups using level_20 mapping table lookups.
 * Priority: level_13 match (Management Fees) → level_20 match → catch-all.
 * Returns a map from account code to its classification.
 */
export function classifyAccountsByLevel20(
  rows: any[],
  subgroups: InvestSubgroupDef[]
): Map<string, AccountClassification> {
  const result = new Map<string, AccountClassification>();
  const catchAllName = subgroups.find(sg => sg.isCatchAll)?.name || 'Other';

  for (const row of rows) {
    if (result.has(row.account)) continue;

    // Priority 1: level_13 match (Management Fees)
    const l13Match = subgroups.find(sg => sg.useLevel13 && row.level13Group === sg.useLevel13);
    if (l13Match) {
      result.set(row.account, { subgroup: l13Match.name, isUnmapped: false });
      continue;
    }

    // Priority 2: level_20 match
    const l20Match = subgroups.find(sg => sg.level20Value && row.level20Group === sg.level20Value);
    if (l20Match) {
      result.set(row.account, { subgroup: l20Match.name, isUnmapped: false });
      continue;
    }

    // Priority 3: Catch-all — flag as unmapped if level_20 isn't a recognized value
    result.set(row.account, { subgroup: catchAllName, isUnmapped: true });
  }

  return result;
}

// ============================================================================
// INVEST FACTOR OWNER — SUBGROUP TOTALS (shared with F90 rendering)
//
// This is the SINGLE FUNCTION both INVEST FACTOR OWNER SUMMARY and F90 P&L
// use to derive below-the-line amounts. It calls the exact same data source
// (getProteaGroupDepartmentDetailData) and the exact same classifier
// (classifyAccountsByLevel20) that the INVEST sheet uses, so any account
// the INVEST sheet buckets as Abnormal Items will appear in F90 as exactly
// the same number — divergence is structurally impossible.
//
// F90 rendering calls applyInvestSubgroupOverridesToF90Rows() below AFTER the
// measure engine runs, overwriting the below-the-line rows with these totals
// and recomputing the subtotals arithmetically. The measure-engine formulas
// for those rows become dead code but are kept to avoid engine errors.
// ============================================================================

export interface InvestSubgroupTotals {
  actuals: number;
  budget: number;
  ly: number;
}

/** Native owner department for Invest Factor Owner (fetched as a group). */
const INVEST_NATIVE_DEPT = 'D0490';

/** Source departments merged INTO Invest Factor Owner via PROTEA_DEPARTMENT_MOVEMENTS.
 *  Each is fetched as its own single-dept slice, mirroring the summary tab's path. */
const INVEST_MOVED_SOURCE_DEPTS = PROTEA_DEPARTMENT_MOVEMENTS
  .filter(m => m.targetGroup === 'Invest Factor Owner')
  .map(m => m.sourceDept);

export async function computeInvestFactorOwnerSubgroupTotals(
  ou: string,
  startMonth: number, startYear: number,
  endMonth: number, endYear: number,
  version: string
): Promise<Map<string, InvestSubgroupTotals>> {
  // Dynamic import avoids a circular dependency with local_db.ts.
  const { getProteaGroupDepartmentDetailData, getProteaDepartmentDetailData } = await import('../../local_db');

  // Mirror the INVEST FACTOR OWNER SUMMARY tab's data-fetch flow EXACTLY
  // (proteaReportPackService.ts::createDepartmentGroupSheet for the 'Invest
  // Factor Owner' group). Any deviation here causes F90 vs INVEST drift.
  //
  //   1. Native dept D0490 via the group-fetch (single-element list).
  //   2. Moved-source depts D0480/D0690/D0691 each via the single-dept fetch
  //      and filtered for !isMovedAccount (A730/A745 stay in Admin & General).
  //   3. groupContainsSourceDept is true (D0490 is a movement source dept), so
  //      the summary also strips !isMovedAccount from the native slice.
  //   4. Concatenate, then aggregateDuplicateAccounts.
  const [nativeRows, ...movedSlices] = await Promise.all([
    getProteaGroupDepartmentDetailData(
      ou, [INVEST_NATIVE_DEPT], startMonth, startYear, endMonth, endYear, version
    ),
    ...INVEST_MOVED_SOURCE_DEPTS.map(d => getProteaDepartmentDetailData(
      ou, d, startMonth, startYear, endMonth, endYear, version
    )),
  ]);

  // Match the summary tab's pre-classification filtering exactly:
  //   • !isMovedAccount strips A730/A745 (those go to Admin & General).
  //   • category !== 'Stats' strips offset/control accounts like A960099 that
  //     have a null level_20 and would otherwise dominate the catch-all bucket.
  // The summary applies the Stats filter inside addCustomSubgroupDataSection
  // (proteaReportPackService.ts) and addCustomSubgroupBudgetSection
  // (proteaBudgetPackService.ts). Keep the three filters in lock-step.
  const cleanSlice = (slice: any[]) =>
    slice.filter(r => !isMovedAccount(r.account) && r.category !== 'Stats');

  const nativeFiltered = cleanSlice(nativeRows as any[]);
  const movedFiltered = movedSlices.flatMap(slice => cleanSlice(slice as any[]));

  const rows = aggregateDuplicateAccounts([...nativeFiltered, ...movedFiltered]);

  const classification = classifyAccountsByLevel20(rows, INVEST_CUSTOM_SUBGROUPS);
  const catchAllName = INVEST_CUSTOM_SUBGROUPS.find(sg => sg.isCatchAll)?.name || 'Other';

  const totals = new Map<string, InvestSubgroupTotals>();
  for (const sg of INVEST_CUSTOM_SUBGROUPS) {
    totals.set(sg.name, { actuals: 0, budget: 0, ly: 0 });
  }

  for (const row of rows as any[]) {
    const sgName = classification.get(row.account)?.subgroup || catchAllName;
    const t = totals.get(sgName);
    if (!t) continue;
    t.actuals += Number(row.actuals) || 0;
    t.budget += Number(row.budget) || 0;
    t.ly += Number(row.ly) || 0;
  }

  return totals;
}

/** Maps the F90 P&L row label (as rendered by calculateF90PLRows) to the
 *  INVEST subgroup name whose raw DB sum should populate that row. Raw DB
 *  sums are shown as-is (matching INVEST): DR expenses are positive, CR
 *  gains are negative, net interest is signed by DB convention. */
const F90_BELOW_LINE_LABEL_TO_SUBGROUP: Record<string, string> = {
  'Fixed Expenses': 'Fixed Expenses',
  'TOTAL MANAGEMENT FEES': 'Management Fees',
  'Depreciation': 'Depreciation',
  'Owners Expense': 'Owners Expense',
  'Net Interest (Income) / Expense': 'Net Interest (Income) / Expense',
  'Refurbishment Fund': 'Refurbishment Fund',
  'Abnormal Items': 'Abnormal Items',
  'Tax': 'Tax',
  'Deferred Tax': 'Deferred Tax',
  'Dividends': 'Dividends',
};

/** Recalculates an F90 row's variance fields after an actuals/budget/ly override. */
function recomputeVariances(row: any): void {
  row.vs_bud = (Number(row.actuals) || 0) - (Number(row.budget) || 0);
  row.vs_bud_pct = Number(row.budget) !== 0
    ? ((Number(row.actuals) - Number(row.budget)) / Math.abs(Number(row.budget))) * 100
    : 0;
  row.vs_ly = (Number(row.actuals) || 0) - (Number(row.ly) || 0);
  row.vs_ly_pct = Number(row.ly) !== 0
    ? ((Number(row.actuals) - Number(row.ly)) / Math.abs(Number(row.ly))) * 100
    : 0;
}

/**
 * Overwrites below-the-line F90 rows with INVEST FACTOR OWNER SUMMARY values
 * and recomputes the five subtotal rows arithmetically. This is what
 * guarantees F90 === INVEST (same data, same classifier, same totals).
 *
 * Subtotal math uses raw DB-sign convention (matching what INVEST displays):
 *   HOTEL PROFIT BEFORE MGT FEES             = MCP        − Fixed Expenses
 *   HOTEL PROFIT/(LOSS) BEFORE DEPR,INT,OWN  = prev       − Management Fees
 *   HOTEL PROFIT/(LOSS) BEFORE TAX           = prev       − Depreciation − Owners Expense
 *                                                         − Net Interest − Refurbishment Fund
 *                                                         − Abnormal Items
 *   HOTEL PROFIT/(LOSS) BEFORE DIVIDENDS     = prev       − Tax − Deferred Tax
 *   NET PROFIT/(LOSS)                        = prev       − Dividends
 *
 * Subtracting a negative raw value (e.g. Abnormal Items = -149,309, a net CR
 * gain) correctly adds the gain back into profit. Do NOT reshape these formulas
 * to "residuals" or "sums of display rows" — the current form mirrors INVEST's
 * interpretation of the GL directly.
 */
export function applyInvestSubgroupOverridesToF90Rows(
  rows: any[],
  totals: Map<string, InvestSubgroupTotals>
): void {
  const rowByLabel = new Map<string, any>();
  for (const r of rows) {
    // calculateF90PLRows stores the label WITHOUT any indent prefix.
    if (r && typeof r.label === 'string') rowByLabel.set(r.label, r);
  }

  // 1. Overwrite below-the-line raw rows with INVEST subgroup sums.
  for (const [label, subgroupName] of Object.entries(F90_BELOW_LINE_LABEL_TO_SUBGROUP)) {
    const row = rowByLabel.get(label);
    const t = totals.get(subgroupName);
    if (!row || !t) continue;
    row.actuals = t.actuals;
    row.budget = t.budget;
    row.ly = t.ly;
    recomputeVariances(row);
  }

  // 2. Recompute the five subtotal rows. MCP (Management Controllable Profit)
  // is produced by the measure engine and stays untouched.
  const mcp = rowByLabel.get('MANAGEMENT CONTROLLABLE PROFIT');
  if (!mcp) return;

  const z: InvestSubgroupTotals = { actuals: 0, budget: 0, ly: 0 };
  const fixed    = totals.get('Fixed Expenses')                   ?? z;
  const mgmtFees = totals.get('Management Fees')                  ?? z;
  const depr     = totals.get('Depreciation')                     ?? z;
  const ownerExp = totals.get('Owners Expense')                   ?? z;
  const interest = totals.get('Net Interest (Income) / Expense')  ?? z;
  const refurb   = totals.get('Refurbishment Fund')               ?? z;
  const abnormal = totals.get('Abnormal Items')                   ?? z;
  const tax      = totals.get('Tax')                              ?? z;
  const defTax   = totals.get('Deferred Tax')                     ?? z;
  const divs     = totals.get('Dividends')                        ?? z;

  const computeSubtotals = (mcpVal: number, k: keyof InvestSubgroupTotals) => {
    const beforeMgtFees = mcpVal - fixed[k];
    const beforeNonOp   = beforeMgtFees - mgmtFees[k];
    const beforeTax     = beforeNonOp - depr[k] - ownerExp[k] - interest[k] - refurb[k] - abnormal[k];
    const beforeDiv     = beforeTax - tax[k] - defTax[k];
    const netProfit     = beforeDiv - divs[k];
    return { beforeMgtFees, beforeNonOp, beforeTax, beforeDiv, netProfit };
  };

  const actSub = computeSubtotals(Number(mcp.actuals) || 0, 'actuals');
  const budSub = computeSubtotals(Number(mcp.budget)  || 0, 'budget');
  const lySub  = computeSubtotals(Number(mcp.ly)      || 0, 'ly');

  const applySub = (label: string, actV: number, budV: number, lyV: number) => {
    const row = rowByLabel.get(label);
    if (!row) return;
    row.actuals = actV;
    row.budget = budV;
    row.ly = lyV;
    recomputeVariances(row);
  };

  applySub('HOTEL PROFIT BEFORE MGT FEES',                      actSub.beforeMgtFees, budSub.beforeMgtFees, lySub.beforeMgtFees);
  applySub('HOTEL PROFIT/(LOSS) BEFORE DEPR, INT AND OWNER EXP', actSub.beforeNonOp,   budSub.beforeNonOp,   lySub.beforeNonOp);
  applySub('HOTEL PROFIT/(LOSS) BEFORE TAX',                    actSub.beforeTax,     budSub.beforeTax,     lySub.beforeTax);
  applySub('HOTEL PROFIT/(LOSS) BEFORE DIVIDENDS',              actSub.beforeDiv,     budSub.beforeDiv,     lySub.beforeDiv);
  applySub('NET PROFIT/(LOSS)',                                 actSub.netProfit,     budSub.netProfit,     lySub.netProfit);
}
