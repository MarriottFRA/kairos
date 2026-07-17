/**
 * Protea Budget Pack Service
 * ===========================
 * Generates Protea Budget Pack Excel reports.  Shares row structure, department
 * groupings, account movements, and renames with the Protea Report Pack
 * (via proteaShared.ts) but uses a budget-comparison column layout.
 *
 * Column layout (N = number of selected months):
 *   A: Label | B: LY Budget | C: vs Cur % | D: Forecast (LY Actuals data) | E: vs For %
 *   F: Current Budget Total | G..G+N-1: Budget per month | last: Comments
 *
 * Runs in the Electron main process.
 */

import ExcelJS from 'exceljs';
import * as db from '../local_db';
import { PLCalculationResult } from '../types/plReportTypes';
import { PROTEA_F90_PL_ROW_CONFIG, PROTEA_F90_PL_ROW_CONFIG_WITH_BANQUETING } from './reports/proteaF90PLRowConfig';
import { INVEST_CUSTOM_SUBGROUPS, InvestSubgroupDef } from './reports/investSubgroupConfig';
import {
  ROOMS_KPI_CONFIG,
  FB_KPI_CONFIG,
  PCT_OF_REVENUE_KPI_GROUPS,
  MONTH_NAMES,
  TAB_COLOR_REPORT,
  TAB_COLOR_GROUP_SUMMARY,
  TAB_COLOR_DEPARTMENT,
  HEADER_FILL,
  HEADER_FONT,
  SECTION_HEADER_FILL,
  SECTION_HEADER_FONT,
  CATEGORY_HEADER_FILL,
  CATEGORY_HEADER_FONT,
  SEPARATOR_FILL,
  SUBTOTAL_FILL,
  GROUP_HEADER_FILL,
  GROUP_HEADER_FONT,
  GROUP_SUBTOTAL_FILL,
  GROUP_SUBTOTAL_FONT,
  CATEGORY_TOTAL_FILL,
  CATEGORY_TOTAL_FONT,
  CATEGORY_TOTAL_BORDER,
  GROUP_SUBTOTAL_BORDER,
  DATA_FONT,
  TOTAL_ROW_BORDER,
  BORDER_STYLE,
  applyHeaderStyle,
  applySectionHeaderStyle,
  applyCategoryHeaderStyle,
  applyDataRowStyle,
  applyGroupHeaderStyle,
  applyGroupSubtotalStyle,
  applyCategorySubtotalStyle,
  formatNumber,
  formatPercentage,
  sanitizeSheetName,
  getRangeLabel,
  aggregateDuplicateAccounts,
  proteaRenameLabel,
  EXCEL_EXCLUDED_DEPARTMENTS,
  PROTEA_MOVEMENT_SOURCE_DEPTS,
  isMovedAccount,
  isDetailOnlyAccount,
  PROTEA_DEPARTMENT_MOVEMENTS,
  BANQUETING_DEPARTMENTS,
  PROTEA_GROUP_DISPLAY_ORDER,
  MOVED_DEPT_SET,
  MOVED_DEPT_BY_SOURCE,
  MOVEMENT_TARGET_GROUPS,
  classifyAccountsByLevel20,
  computeInvestFactorOwnerSubgroupTotals,
  applyInvestSubgroupOverridesToF90Rows,
  InvestSubgroupTotals,
  LEVIES_SUBGROUP,
  isLeviesAccount,
} from './reports/proteaShared';

// ============================================================================
// TYPES
// ============================================================================

export interface ProteaBudgetPackConfig {
  ou: string;
  hotelName: string;
  startMonth: number;
  startYear: number;
  endMonth: number;
  endYear: number;
  version: string;              // 'MAIN' or 'OWNR'
  generateDetailTabs: boolean;
  includeBanquetingBreakdown: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Generate period strings for a range (reuse from plCalculationEngine at runtime) */
function generatePeriodsSync(startMonth: number, startYear: number, endMonth: number, endYear: number): string[] {
  const periods: string[] = [];
  let m = startMonth, y = startYear;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    periods.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return periods;
}

/** Offset a period string by -12 months */
function offsetPeriodMinusYear(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${y - 1}-${String(m).padStart(2, '0')}`;
}

/** Compute variance percentage: (a - b) / |b| * 100 */
function pct(a: number, b: number): number {
  return b !== 0 ? ((a - b) / Math.abs(b)) * 100 : 0;
}

// Groups that render "Department Profit" ABOVE the Stats block (so the
// bottom-line sits on top of the statistical breakdown, not beneath it).
// Diverges from STATS_KEEP_GROUPS in proteaReportPackService.ts — the budget
// pack also lifts A&G's totals above Stats per stakeholder request; the
// actuals pack keeps the original below-Stats placement for now.
const BUDGET_STATS_KEEP_GROUPS = new Set([
  'Total Food & Beverage',
  'Total Banqueting',
  'Utilities Dept',
  'Administrative & General',
]);

// Groups hidden from the summary-only variant of the pack (adds noise without
// insight when detail tabs are off). When generateDetailTabs is ON the group
// renders normally — summary sheet plus its per-department detail tabs.
const BUDGET_SUMMARY_ONLY_HIDDEN_GROUPS = new Set(['Payroll Cost Allocation']);
const DEPT_PROFIT_EXPENSE_CATEGORIES = ['Cost of Sales', 'Payroll', 'Controllables', 'Other'] as const;

// Budget-pack number/percentage formatters: coalesce null/undefined to 0 so
// cells render as "0" / "0.0%" instead of blank. The shared helpers in
// proteaShared.ts return '' for null (used by the actuals pack); we wrap
// them here so this behaviour is scoped to the budget pack only.
const fmtN0 = (v: number | null | undefined, decimals: number = 0): number | string =>
  formatNumber(v ?? 0, decimals);
const fmtP0 = (v: number | null | undefined): string =>
  formatPercentage(v ?? 0);

/**
 * Filter the budget-pack period datasets to "live" accounts only — i.e. any
 * account whose period totals across the three displayed scenarios (Current
 * Budget, LY Budget, LY Actuals) sum to non-zero.
 *
 * Slot conventions (see comments on addBudgetDepartmentDataSection):
 *   - currentData: budget = CurBud (period total), ly = LYAct (period total)
 *   - lyData:      budget = LYBud (period total)
 *
 * Per-month detail (budgetByPeriod) is intentionally NOT consulted: the
 * period totals are sufficient because per-month values that net to zero
 * across the period make the row visually empty anyway. Filtering once at
 * the data layer (rather than per-row at render) lets level_12 grouping and
 * category-empty handling cascade naturally — all-zero groups disappear
 * with their headers and subtotals, no per-site logic needed.
 *
 * O(n) where n = |currentData| + |lyData|. One sums map, one Set, two
 * filtered arrays — strictly cheaper than iterating per render site.
 */
function filterLiveAccountRows(
  currentData: any[],
  lyData: any[]
): { currentData: any[]; lyData: any[] } {
  const sums = new Map<string, { cur: number; lyB: number; lyA: number }>();
  const accumulate = (acct: string): { cur: number; lyB: number; lyA: number } => {
    let s = sums.get(acct);
    if (!s) { s = { cur: 0, lyB: 0, lyA: 0 }; sums.set(acct, s); }
    return s;
  };
  for (const r of currentData) {
    const s = accumulate(r.account);
    s.cur += Number(r.budget) || 0;
    s.lyA += Number(r.ly) || 0;
  }
  for (const r of lyData) {
    accumulate(r.account).lyB += Number(r.budget) || 0;
  }
  const live = new Set<string>();
  for (const [acct, s] of sums) {
    if (s.cur !== 0 || s.lyB !== 0 || s.lyA !== 0) live.add(acct);
  }
  return {
    currentData: currentData.filter(r => live.has(r.account)),
    lyData:      lyData.filter(r => live.has(r.account)),
  };
}

// ============================================================================
// SERVICE CLASS
// ============================================================================

class ProteaBudgetPackService {
  private generatedAt: string = '';
  private periods: string[] = [];
  private lyPeriods: string[] = [];

  /** Registry of sheets and group headers for the cover page TOC */
  private sheetRegistry: Array<{
    type: 'sheet' | 'groupHeader';
    sheetName: string;
    groupName?: string;
    indent: boolean;
  }> = [];

  // ============================================================================
  // COLUMN HELPERS
  // ============================================================================

  /** Total columns for current period selection */
  private get totalCols(): number { return this.periods.length + 7; }

  /** Build column definitions for budget pack layout */
  private buildColumns(): Partial<ExcelJS.Column>[] {
    const cols: Partial<ExcelJS.Column>[] = [
      { key: 'label', width: 45 },
      { key: 'lyBud', width: 14 },
      { key: 'lyBudVar', width: 12 },
      { key: 'lyAct', width: 14 },
      { key: 'lyActVar', width: 12 },
      { key: 'curBud', width: 14 },
    ];
    for (let i = 0; i < this.periods.length; i++) {
      cols.push({ key: `budM${i}`, width: 12 });
    }
    cols.push({ key: 'comments', width: 35 });
    return cols;
  }

  /** Short month-year label for column headers (e.g. "Jan 27") */
  private periodLabel(period: string): string {
    const [y, m] = period.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${String(y).slice(-2)}`;
  }

  // ============================================================================
  // TITLE & HEADER HELPERS
  // ============================================================================

  private addSheetTitleHeader(sheet: ExcelJS.Worksheet, config: ProteaBudgetPackConfig, reportName: string): void {
    const tc = this.totalCols;

    // Row 1: Report name
    const reportRow = sheet.addRow(new Array(tc).fill(''));
    reportRow.getCell(1).value = reportName;
    reportRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
    reportRow.getCell(1).alignment = { vertical: 'middle' };
    reportRow.height = 28;
    sheet.mergeCells(reportRow.number, 1, reportRow.number, tc);

    // Row 2: Hotel name + range
    const titleRow = sheet.addRow(new Array(tc).fill(''));
    titleRow.getCell(1).value = `${config.hotelName}  —  Budget Review: ${MONTH_NAMES[config.startMonth - 1]} ${config.startYear} - ${MONTH_NAMES[config.endMonth - 1]} ${config.endYear}`;
    titleRow.getCell(1).font = { bold: true, size: 13, color: { argb: 'FF1E3A5F' } };
    titleRow.getCell(1).alignment = { vertical: 'middle' };
    titleRow.height = 26;
    sheet.mergeCells(titleRow.number, 1, titleRow.number, tc);

    // Row 3: Generation timestamp
    const tsRow = sheet.addRow(new Array(tc).fill(''));
    tsRow.getCell(1).value = `Generated: ${this.generatedAt}`;
    tsRow.getCell(1).font = { size: 8, color: { argb: 'FF999999' } };
    tsRow.getCell(1).alignment = { vertical: 'middle' };
    tsRow.height = 16;
    sheet.mergeCells(tsRow.number, 1, tsRow.number, tc);
  }

  /** Add period group + sub-headers for the budget pack column layout */
  private addColumnHeaders(sheet: ExcelJS.Worksheet, config: ProteaBudgetPackConfig): void {
    const tc = this.totalCols;
    const lyLabel = getRangeLabel(config.startMonth, config.startYear - 1, config.endMonth, config.endYear - 1);
    const curLabel = getRangeLabel(config.startMonth, config.startYear, config.endMonth, config.endYear);

    // Group row: Prior Year spanning B-E, Current Budget spanning F onwards
    const groupRow = sheet.addRow(new Array(tc).fill(''));
    groupRow.getCell(2).value = `Prior Year: ${lyLabel.replace(/^[^:]+:\s*/, '')}`;
    groupRow.getCell(6).value = `Current Budget: ${curLabel.replace(/^[^:]+:\s*/, '')}`;
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 5);
    sheet.mergeCells(groupRow.number, 6, groupRow.number, 6 + this.periods.length);
    applyHeaderStyle(groupRow);

    // Sub-header row
    const subHeaders: string[] = [
      'P&L Line',
      'LY Budget', 'vs Cur %',
      'Forecast', 'vs For %',
      'Total',
    ];
    for (const p of this.periods) {
      subHeaders.push(this.periodLabel(p));
    }
    subHeaders.push('Comments');
    const headerRow = sheet.addRow(subHeaders);
    applyHeaderStyle(headerRow);
  }

  // ============================================================================
  // ACCOUNT LABEL HELPER
  // ============================================================================

  private buildAccountLabel(displayName: string, accountCode: string, movedFrom?: string): string | ExcelJS.CellRichTextValue {
    displayName = proteaRenameLabel(displayName);
    if (movedFrom) {
      return {
        richText: [
          { font: { size: 10 }, text: displayName },
          { font: { size: 9, italic: true, color: { argb: 'FFB0B0B0' } }, text: ` [moved from ${movedFrom}]` },
        ],
      };
    }
    return displayName;
  }

  // ============================================================================
  // NUMBER FORMAT HELPERS
  // ============================================================================

  /** Apply #,##0 format to all numeric data cells (cols 2 through totalCols-1) */
  private applyNumberFormats(row: ExcelJS.Row): void {
    for (let c = 2; c < this.totalCols; c++) {
      const cell = row.getCell(c);
      if (typeof cell.value === 'number') cell.numFmt = '#,##0';
    }
  }

  // ============================================================================
  // KPI BLOCKS (Budget Pack column layout) — Rooms, F&B, % of Revenue
  //
  // Slot remapping (per getProteaBudgetF90PLData): the engine's "actuals" slot
  // carries Current Budget, "budget" slot carries LY Budget, and "ly" slot
  // carries LY Actuals. We map them onto the budget pack columns accordingly.
  //
  // Per-month KPI values come from the same getProteaBudgetF90PLData round-
  // trip that produces the totals (the DB layer returns total + monthly in a
  // single call), so wiring them up is a free render-side operation — no
  // extra queries.
  // ============================================================================

  /** Bundle of period totals plus per-month maps from a single F90 engine
   *  call over a KPI rowConfig. Both maps are keyed by row.label. */
  private async fetchBudgetKpiEngineData(
    config: ProteaBudgetPackConfig,
    kpiConfig: any[]
  ): Promise<{
    total: Map<string, PLCalculationResult>;
    monthly: Map<string, Map<string, PLCalculationResult>>;
  }> {
    // skipFilter=true: keep all configured rows so the per-period maps stay
    // aligned with the totals map (KPI configs have no spacers/headers, but
    // a measure that evaluates to zero in some month would otherwise be
    // dropped from that month's payload).
    const { total, monthly } = await db.getProteaBudgetF90PLData(
      config.startMonth, config.startYear,
      config.endMonth, config.endYear,
      config.ou, config.version, kpiConfig, true
    );
    const totalMap = new Map<string, PLCalculationResult>();
    for (const row of JSON.parse(total) as PLCalculationResult[]) {
      if (row.type === 'measure') totalMap.set(row.label, row);
    }
    const monthlyMap = new Map<string, Map<string, PLCalculationResult>>();
    for (const [period, json] of Object.entries(monthly)) {
      const m = new Map<string, PLCalculationResult>();
      for (const row of JSON.parse(json as string) as PLCalculationResult[]) {
        if (row.type === 'measure') m.set(row.label, row);
      }
      monthlyMap.set(period, m);
    }
    return { total: totalMap, monthly: monthlyMap };
  }

  /** Render an arbitrary stack of KPI sections (header + measure rows) on a
   *  budget pack group summary sheet. Tuple format per row:
   *    [displayLabel, isPercentage, decimals?, lookupKey?]
   *  - lookupKey defaults to displayLabel; pass it when the engine label
   *    differs from the user-facing label (e.g. FB '% Food COS' rendered
   *    as 'Food Cost of Sales %').
   *  - decimals only applies when isPercentage=false (default 0).
   *  Section headers with empty rows are skipped so that callers can compose
   *  conditional sections without bookkeeping.
   */
  private renderBudgetKpiSections(
    sheet: ExcelJS.Worksheet,
    kpi: { total: Map<string, PLCalculationResult>; monthly: Map<string, Map<string, PLCalculationResult>> },
    sections: Array<{
      header: string;
      rows: Array<[string, boolean] | [string, boolean, number] | [string, boolean, number, string]>;
    }>
  ): void {
    const tc = this.totalCols;
    const fmtPct = (v: number) => `${v.toFixed(1)}%`;
    const fmtNum = (v: number, decimals: number) =>
      decimals > 0 ? v.toFixed(decimals) : formatNumber(v);

    const addBlank = () => {
      const row = sheet.addRow(new Array(tc).fill(''));
      row.eachCell((cell) => { cell.border = BORDER_STYLE; cell.font = DATA_FONT; });
    };

    const addSectionHeader = (label: string) => {
      const row = sheet.addRow(new Array(tc).fill(''));
      row.getCell(1).value = label;
      applyCategorySubtotalStyle(row);
    };

    const addKpiRow = (displayLabel: string, isPct: boolean, decimals: number, lookupKey: string) => {
      const totalResult = kpi.total.get(lookupKey);
      const curBud = totalResult?.actuals ?? 0;
      const lyBud  = totalResult?.budget  ?? 0;
      const lyAct  = totalResult?.ly      ?? 0;
      const fmt = isPct ? fmtPct : (v: number) => fmtNum(v, decimals);

      // Slot remap (per getProteaBudgetF90PLData): actuals=CurBud, budget=LYBud, ly=LYAct.
      // Render 0 / 0.0% (not blank) when there's no LY divisor or no per-month
      // value, so rows with current-only or LY-only data don't show empty
      // cells (which look like the report is broken to non-technical users).
      const rowData: any = {
        label: `  ${displayLabel}`,
        lyBud: fmt(lyBud),
        lyBudVar: fmtPct(lyBud !== 0 ? ((curBud - lyBud) / Math.abs(lyBud)) * 100 : 0),
        lyAct: fmt(lyAct),
        lyActVar: fmtPct(lyAct !== 0 ? ((curBud - lyAct) / Math.abs(lyAct)) * 100 : 0),
        curBud: fmt(curBud),
        comments: '',
      };

      // Per-month KPI value = that month's CurBud slot from the F90 engine
      // run over the KPI rowConfig (no extra round-trips: monthly was returned
      // alongside total in fetchBudgetKpiEngineData). Missing month → 0.
      for (let i = 0; i < this.periods.length; i++) {
        const monthKpi = kpi.monthly.get(this.periods[i]);
        const monthVal = monthKpi?.get(lookupKey)?.actuals ?? 0;
        rowData[`budM${i}`] = fmt(monthVal);
      }

      const excelRow = sheet.addRow(rowData);
      applyDataRowStyle(excelRow);
    };

    for (const section of sections) {
      if (section.rows.length === 0) continue;
      addBlank();
      addSectionHeader(section.header);
      for (const r of section.rows) {
        const [displayLabel, isPct] = r;
        const decimals = (r[2] as number | undefined) ?? 0;
        const lookupKey = (r[3] as string | undefined) ?? displayLabel;
        addKpiRow(displayLabel, isPct, decimals, lookupKey);
      }
    }
  }

  /** Render the Rooms & Reservation Summary KPI block on a budget pack
   *  group summary sheet (mirror of addRoomsReservationKpiRows in the
   *  actuals pack). */
  private addBudgetRoomsKpiRows(
    sheet: ExcelJS.Worksheet,
    kpi: { total: Map<string, PLCalculationResult>; monthly: Map<string, Map<string, PLCalculationResult>> }
  ): void {
    this.renderBudgetKpiSections(sheet, kpi, [
      {
        header: 'Rooms & Reservation Summary',
        rows: [
          ['Occupancy %',                    true],
          ['ADR',                            false],
          ['RevPAR',                         false],
          ['RevPAR after TAC',               false],
          ['Rooms Available',                false],
          ['Rooms SOLD',                     false, 0, 'Sold Rooms'],
          ['Bed Nights Sold',                false],
          ['Bed Nights Available',           false],
          ['Average Bed Occupancy %',        true],
          ['Average Guest Rate',             false],
          ['Double Occupancy %',             true],
          ['Rooms Available per Day',        false],
          ['Bed Available per Day',          false],
        ],
      },
      {
        header: 'Per Room Night Sold',
        rows: [
          ['Operating Supplies',    false, 2],
          ['Cleaning Supplies',     false, 2],
          ['Guest Supplies',        false, 2],
          ['Paper Supplies',        false, 2],
          ['Printing & Stationery', false, 2],
          ['Laundry',               false, 2],
        ],
      },
      {
        header: 'Operating Equipment Usage per Room Night Sold',
        rows: [
          ['Flatware (Cutlery)', false, 2],
          ['Linen',              false, 2],
          ['Glassware',          false, 2],
          ['Room Smalls',        false, 2],
        ],
      },
      {
        header: 'Percentage of Room Sales',
        rows: [
          ['Payroll as a % of Room Sales',         true],
          ['Other Expenses as a % of Room Sales',  true],
        ],
      },
    ]);
  }

  /** Render the Total Food & Beverage Summary KPI block on a budget pack
   *  group summary sheet (mirror of addFbKpiRows in the actuals pack). */
  private addBudgetFbKpiRows(
    sheet: ExcelJS.Worksheet,
    kpi: { total: Map<string, PLCalculationResult>; monthly: Map<string, Map<string, PLCalculationResult>> }
  ): void {
    this.renderBudgetKpiSections(sheet, kpi, [
      {
        header: 'Covers',
        rows: [
          ['Breakfast Customers',  false],
          ['Lunch Customers',      false],
          ['Dinner Customers',     false],
          ['Late Snack Customers', false],
          ['Banqueting Customer',  false],
        ],
      },
      {
        header: 'Average Food Spend',
        rows: [
          ['Avg Breakfast Spend',  false, 2],
          ['Avg Lunch Spend',      false, 2],
          ['Avg Dinner Spend',     false, 2],
          ['Avg Late Snack Spend', false, 2],
          ['Avg Banqueting Spend', false, 2],
        ],
      },
      {
        header: 'Covers as % of Bed Nights Sold',
        rows: [
          ['Breakfast Customers as % of Bed Nights',  true],
          ['Lunch Customers as % of Bed Nights',      true],
          ['Dinner Customers as % of Bed Nights',     true],
          ['Late Snack Customers as % of Bed Nights', true],
          ['Banqueting Customer as % of Bed Nights',  true],
        ],
      },
      {
        // FB_KPI_CONFIG keys are '% Food COS' / '% Beverage COS'; render under the
        // user-facing labels the actuals pack uses.
        header: 'Cost of Sales',
        rows: [
          ['Food Cost of Sales %',     true, 0, '% Food COS'],
          ['Beverage Cost of Sales %', true, 0, '% Beverage COS'],
        ],
      },
      {
        header: 'Cost Per Cover',
        rows: [
          ['Operating Supplies',    false, 2],
          ['Cleaning Supplies',     false, 2],
          ['Guest Supplies',        false, 2],
          ['Paper Supplies',        false, 2],
          ['Printing & Stationery', false, 2],
          ['Laundry',               false, 2],
        ],
      },
      {
        header: 'Operating Equipment Usage per Cover',
        rows: [
          ['Flatware (Cutlery)',    false, 2],
          ['China (Crockery)',      false, 2],
          ['Kitchen Utensils',      false, 2],
          ['Linen',                 false, 2],
          ['Glassware',             false, 2],
          ['Restaurant/Bar Smalls', false, 2],
        ],
      },
      {
        header: 'Percentage of F&B Sales',
        rows: [
          ['Payroll as a % of F&B Sales',        true],
          ['Other Expenses as a % of F&B Sales', true],
        ],
      },
    ]);
  }

  /** Render the "Percentage of Revenue" KPI block on undistributed-OPEX group
   *  summary sheets (A&G / POM / S&M). Mirror of addPctOfRevenueKpiRows in
   *  the actuals pack. */
  private addBudgetPctOfRevenueKpiRows(
    sheet: ExcelJS.Worksheet,
    kpi: { total: Map<string, PLCalculationResult>; monthly: Map<string, Map<string, PLCalculationResult>> }
  ): void {
    this.renderBudgetKpiSections(sheet, kpi, [
      {
        header: 'Percentage of Revenue',
        rows: [
          ['Payroll as a % of Revenue',        true],
          ['Other Expenses as a % of Revenue', true],
        ],
      },
    ]);
  }

  // ============================================================================
  // F90 WORKSHEET
  // ============================================================================

  private async createBudgetF90Worksheet(workbook: ExcelJS.Workbook, config: ProteaBudgetPackConfig): Promise<void> {
    const sheet = workbook.addWorksheet('F90 Report', { properties: { tabColor: TAB_COLOR_REPORT } });
    sheet.columns = this.buildColumns();

    this.addSheetTitleHeader(sheet, config, 'F90 Budget Report');
    this.addColumnHeaders(sheet, config);

    const f90RowConfig = config.includeBanquetingBreakdown
      ? PROTEA_F90_PL_ROW_CONFIG_WITH_BANQUETING
      : PROTEA_F90_PL_ROW_CONFIG;

    // Fetch budget pack F90 data (totals + monthly breakdown)
    // skipFilter=true: both total and monthly must use original (un-renumbered) rowIds
    // so that the renderer can match monthly values to the correct total row.
    // filterZeroRows renumbers rowIds after removal, which breaks alignment.
    const { total: totalJson, monthly } = await db.getProteaBudgetF90PLData(
      config.startMonth, config.startYear,
      config.endMonth, config.endYear,
      config.ou, config.version,
      f90RowConfig, true
    );

    const totalData: PLCalculationResult[] = JSON.parse(totalJson);
    const monthlyData = new Map<string, PLCalculationResult[]>();
    for (const [period, json] of Object.entries(monthly)) {
      monthlyData.set(period, JSON.parse(json as string));
    }

    // Route F90 below-the-line values through the EXACT SAME function INVEST
    // FACTOR OWNER SUMMARY uses (getProteaGroupDepartmentDetailData +
    // classifyAccountsByLevel20). Budget pack slot remap: F90 row.actuals
    // holds CurBud, row.budget holds LYBud, row.ly holds LYAct — so we pull
    // those from two classifier calls (CY period + LY period) and remap.
    const [cyMap, lyMap, ...monthlyMaps] = await Promise.all([
      computeInvestFactorOwnerSubgroupTotals(
        config.ou, config.startMonth, config.startYear,
        config.endMonth, config.endYear, config.version
      ),
      computeInvestFactorOwnerSubgroupTotals(
        config.ou, config.startMonth, config.startYear - 1,
        config.endMonth, config.endYear - 1, config.version
      ),
      ...this.periods.map(p => {
        const [y, m] = p.split('-').map(Number);
        return computeInvestFactorOwnerSubgroupTotals(config.ou, m, y, m, y, config.version);
      }),
    ]);

    // Total row remap: slot "actuals"=CurBud (CY.budget), "budget"=LYBud (LY.budget), "ly"=LYAct (CY.ly).
    const budgetTotalOverrides = new Map<string, InvestSubgroupTotals>();
    for (const [name, cy] of cyMap) {
      const ly = lyMap.get(name) ?? { actuals: 0, budget: 0, ly: 0 };
      budgetTotalOverrides.set(name, { actuals: cy.budget, budget: ly.budget, ly: cy.ly });
    }
    applyInvestSubgroupOverridesToF90Rows(totalData, budgetTotalOverrides);

    // Per-month override: only the "actuals" slot (= that month's CurBud) is populated.
    this.periods.forEach((period, i) => {
      const monthRows = monthlyData.get(period);
      if (!monthRows) return;
      const monthOverrides = new Map<string, InvestSubgroupTotals>();
      for (const [name, m] of monthlyMaps[i]) {
        monthOverrides.set(name, { actuals: m.budget, budget: 0, ly: 0 });
      }
      applyInvestSubgroupOverridesToF90Rows(monthRows, monthOverrides);
    });

    // F90 must never suppress zero rows: layout parity with the validated
    // actuals Protea pack requires every PROTEA_F90_PL_ROW_CONFIG row to
    // render, even when all columns are zero (Incentive Fee, Base Royalty
    // Fee, Refurbishment Fund, Dividends, etc.). Pass datasets through
    // unfiltered; addBudgetF90DataRows still skips empty spacing rows.
    this.addBudgetF90DataRows(sheet, totalData, monthlyData);

    // Freeze panes (3 title rows + 2 header rows)
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];
  }

  /** Render F90 data rows with budget pack columns */
  private addBudgetF90DataRows(
    sheet: ExcelJS.Worksheet,
    totalData: PLCalculationResult[],
    monthlyData: Map<string, PLCalculationResult[]>
  ): void {
    for (const row of totalData) {
      // Skip empty spacing rows only
      if (row.type === 'header' && !row.label) continue;

      const indent = '  '.repeat(row.indentLevel || 0);
      const isPct = row.formatting === 'percentage';
      // Category headers (REVENUE, DEPARTMENT PROFIT, etc.) carry no data —
      // their numeric cells must stay blank rather than coalescing to 0.
      const isBlankHeader = row.type === 'header' && row.actuals === null;

      // Slot remapping: actuals=CurBud, budget=LYBud, ly=LYAct.
      // For data rows, null/undefined coalesces to 0 / 0.0% (see fmtN0/fmtP0)
      // so one-sided rows don't look broken. Header rows skip this entirely.
      const rowData: any = {
        label: indent + row.label,
        lyBud: isBlankHeader ? '' : isPct ? fmtP0(row.budget) : fmtN0(row.budget),
        lyBudVar: isBlankHeader
          ? ''
          : isPct
            ? `${((row.actuals ?? 0) - (row.budget ?? 0)).toFixed(1)} pts`
            : fmtP0(row.vs_bud_pct),
        lyAct: isBlankHeader ? '' : isPct ? fmtP0(row.ly) : fmtN0(row.ly),
        lyActVar: isBlankHeader
          ? ''
          : isPct
            ? `${((row.actuals ?? 0) - (row.ly ?? 0)).toFixed(1)} pts`
            : fmtP0(row.vs_ly_pct),
        curBud: isBlankHeader ? '' : isPct ? fmtP0(row.actuals) : fmtN0(row.actuals),
      };

      // Monthly budget columns — render 0 (not blank) when a period has no
      // value for this row, for the same reason as above. Headers stay blank.
      for (let i = 0; i < this.periods.length; i++) {
        if (isBlankHeader) {
          rowData[`budM${i}`] = '';
          continue;
        }
        const period = this.periods[i];
        const monthRows = monthlyData.get(period);
        const matchRow = monthRows?.find(r => r.rowId === row.rowId);
        rowData[`budM${i}`] = isPct
          ? fmtP0(matchRow?.actuals)
          : fmtN0(matchRow?.actuals);
      }

      rowData.comments = '';

      const excelRow = sheet.addRow(rowData);

      // Styling
      if (row.type === 'header' && row.label) {
        const hasData = row.actuals !== null;
        excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          cell.font = { size: 10, bold: true };
          if (!hasData) cell.fill = CATEGORY_HEADER_FILL;
          cell.border = row.indentLevel === 0 && hasData
            ? CATEGORY_TOTAL_BORDER
            : row.indentLevel > 0 && hasData
              ? GROUP_SUBTOTAL_BORDER
              : BORDER_STYLE;
          cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
        });
      } else {
        applyDataRowStyle(excelRow, false);
      }

      if (!isPct) this.applyNumberFormats(excelRow);
    }
  }

  // ============================================================================
  // ROOM SEGMENTS WORKSHEET
  // ============================================================================

  private async createBudgetRoomSegmentWorksheet(workbook: ExcelJS.Workbook, config: ProteaBudgetPackConfig): Promise<void> {
    const sheet = workbook.addWorksheet('Room Segments', { properties: { tabColor: TAB_COLOR_REPORT } });

    // Room segments add an extra "Category" column after label
    const segCols: Partial<ExcelJS.Column>[] = [
      { key: 'segment', width: 35 },
      { key: 'category', width: 15 },
      { key: 'lyBud', width: 14 },
      { key: 'lyBudVar', width: 12 },
      { key: 'lyAct', width: 14 },
      { key: 'lyActVar', width: 12 },
      { key: 'curBud', width: 14 },
    ];
    for (let i = 0; i < this.periods.length; i++) {
      segCols.push({ key: `budM${i}`, width: 12 });
    }
    segCols.push({ key: 'comments', width: 35 });
    sheet.columns = segCols;

    const segTotalCols = this.periods.length + 8; // +1 for extra category col

    this.addSheetTitleHeader(sheet, config, 'Room Segments');

    // Column headers for room segments (shifted by 1 for category column)
    const lyLabel = getRangeLabel(config.startMonth, config.startYear - 1, config.endMonth, config.endYear - 1).replace(/^[^:]+:\s*/, '');
    const curLabel = getRangeLabel(config.startMonth, config.startYear, config.endMonth, config.endYear).replace(/^[^:]+:\s*/, '');

    const groupRow = sheet.addRow(new Array(segTotalCols).fill(''));
    groupRow.getCell(3).value = `Prior Year: ${lyLabel}`;
    groupRow.getCell(7).value = `Current Budget: ${curLabel}`;
    sheet.mergeCells(groupRow.number, 3, groupRow.number, 6);
    sheet.mergeCells(groupRow.number, 7, groupRow.number, 7 + this.periods.length);
    applyHeaderStyle(groupRow);

    const subHeaders: string[] = ['Segment', 'Category', 'LY Budget', 'vs Cur %', 'Forecast', 'vs For %', 'Total'];
    for (const p of this.periods) subHeaders.push(this.periodLabel(p));
    subHeaders.push('Comments');
    const headerRow = sheet.addRow(subHeaders);
    applyHeaderStyle(headerRow);

    // Fetch data: current range for budget, LY range for LY budget + LY actuals
    const currentSegData = await db.getRoomSegmentExportData(
      config.ou,
      config.startMonth, config.startYear,
      config.endMonth, config.endYear,
      config.version
    );
    const lySegData = await db.getRoomSegmentExportData(
      config.ou,
      config.startMonth, config.startYear - 1,
      config.endMonth, config.endYear - 1,
      config.version
    );

    // Per-month current-budget values per account (single pivoted query)
    const monthlyBudgetMap = await db.getRoomSegmentBudgetByMonth(
      config.ou, this.periods, config.version
    );

    // Render sections: Revenue, Room Nights, ADR
    for (const metric of ['revenue', 'nights', 'adr'] as const) {
      const metricLabel = metric === 'revenue' ? 'Revenue' : metric === 'nights' ? 'Room Nights' : 'ADR';
      const secHeader = sheet.addRow(new Array(segTotalCols).fill(''));
      secHeader.getCell(1).value = metricLabel;
      applySectionHeaderStyle(secHeader);
      sheet.mergeCells(secHeader.number, 1, secHeader.number, segTotalCols);

      this.addBudgetRoomSegSection(sheet, currentSegData, lySegData, monthlyBudgetMap, metric, 'consolidated', segTotalCols);

      if (config.generateDetailTabs) {
        const detHeader = sheet.addRow(new Array(segTotalCols).fill(''));
        detHeader.getCell(1).value = 'Detail by Day Type';
        applySectionHeaderStyle(detHeader);
        sheet.mergeCells(detHeader.number, 1, detHeader.number, segTotalCols);
        this.addBudgetRoomSegSection(sheet, currentSegData, lySegData, monthlyBudgetMap, metric, 'detail', segTotalCols);
      }

      // Blank separator between metrics
      const blankRow = sheet.addRow(new Array(segTotalCols).fill(''));
      blankRow.eachCell((cell) => { cell.border = BORDER_STYLE; cell.font = DATA_FONT; });
    }

    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];
  }

  /** Render a room segment metric section with budget pack columns */
  private addBudgetRoomSegSection(
    sheet: ExcelJS.Worksheet,
    currentData: any[],
    lyData: any[],
    monthlyBudgetMap: Map<string, number[]>,
    metric: 'revenue' | 'nights' | 'adr',
    mode: 'consolidated' | 'detail',
    segTotalCols: number
  ): void {
    const categories = mode === 'consolidated'
      ? ['Transient', 'Groups', 'Complimentary']
      : ['Sun-Thur', 'Fri-Sat', 'Groups', 'Complimentary'];

    // Fold per-account monthly values into per-segment-row buckets, matching
    // the same (category, name) grouping used by aggregateSegData below
    const monthCount = this.periods.length;
    const monthlyByKey = new Map<string, { revMonthly: number[]; nightsMonthly: number[] }>();
    for (const cfg of db.ROOM_SEGMENTS_CONFIG) {
      const name = mode === 'consolidated' ? cfg.consolidatedName : cfg.description;
      const cat = mode === 'consolidated' ? cfg.consolidatedCategory : cfg.category;
      const key = `${cat}::${name}`;
      let entry = monthlyByKey.get(key);
      if (!entry) {
        entry = { revMonthly: new Array(monthCount).fill(0), nightsMonthly: new Array(monthCount).fill(0) };
        monthlyByKey.set(key, entry);
      }
      const revArr = monthlyBudgetMap.get(cfg.revenueAccount);
      const statArr = cfg.statAccount ? monthlyBudgetMap.get(cfg.statAccount) : undefined;
      if (revArr) for (let i = 0; i < monthCount; i++) entry.revMonthly[i] += revArr[i];
      if (statArr) for (let i = 0; i < monthCount; i++) entry.nightsMonthly[i] += statArr[i];
    }

    const aggregateSegData = (data: any[]) => {
      const map = new Map<string, { name: string; category: string; revAct: number; revBud: number; nightsAct: number; nightsBud: number }>();
      for (const row of data) {
        const name = mode === 'consolidated' ? row.consolidatedName : row.description;
        const cat = mode === 'consolidated' ? row.consolidatedCategory : row.category;
        const key = `${cat}::${name}`;
        if (!map.has(key)) map.set(key, { name, category: cat, revAct: 0, revBud: 0, nightsAct: 0, nightsBud: 0 });
        const agg = map.get(key)!;
        agg.revAct += row.revenueActuals || 0;
        agg.revBud += row.revenueBudget || 0;
        agg.nightsAct += row.nightsActuals || 0;
        agg.nightsBud += row.nightsBudget || 0;
      }
      return map;
    };

    const extractMetric = (row: { revAct: number; revBud: number; nightsAct: number; nightsBud: number }, m: 'revenue' | 'nights' | 'adr') => {
      if (m === 'revenue') return { val: -row.revBud };  // budget (negated for display)
      if (m === 'nights') return { val: row.nightsBud };
      return { val: row.nightsBud !== 0 ? -row.revBud / row.nightsBud : 0 }; // ADR
    };

    const extractMetricActuals = (row: { revAct: number; revBud: number; nightsAct: number; nightsBud: number }, m: 'revenue' | 'nights' | 'adr') => {
      if (m === 'revenue') return { val: -row.revAct };
      if (m === 'nights') return { val: row.nightsAct };
      return { val: row.nightsAct !== 0 ? -row.revAct / row.nightsAct : 0 };
    };

    const curMap = aggregateSegData(currentData);
    const lyMap = aggregateSegData(lyData);
    const decimals = metric === 'adr' ? 2 : 0;

    for (const category of categories) {
      const curRows = Array.from(curMap.values()).filter(r => r.category === category);
      const lyRows = Array.from(lyMap.values()).filter(r => r.category === category);
      const segNames = new Set<string>();
      curRows.forEach(r => segNames.add(r.name));
      lyRows.forEach(r => segNames.add(r.name));
      if (segNames.size === 0) continue;

      // Suppress segments where this metric's CurBud/LYBud/LYAct are all zero;
      // skip the whole category if every segment is suppressed (avoids an
      // orphan category header). Each metric section runs independently, so a
      // segment that's zero in Revenue can still show up in Room Nights.
      const ZERO_AGG = { revAct: 0, revBud: 0, nightsAct: 0, nightsBud: 0 };
      const liveSegs: Array<{ segName: string; curBud: number; lyBud: number; lyAct: number; curRow: any; lyRow: any }> = [];
      for (const segName of segNames) {
        const curRow = curRows.find(r => r.name === segName) || ZERO_AGG;
        const lyRow = lyRows.find(r => r.name === segName) || ZERO_AGG;
        const curBud = extractMetric(curRow, metric).val;
        const lyBud = extractMetric(lyRow, metric).val;
        const lyAct = extractMetricActuals(lyRow, metric).val;
        if (curBud !== 0 || lyBud !== 0 || lyAct !== 0) {
          liveSegs.push({ segName, curBud, lyBud, lyAct, curRow, lyRow });
        }
      }
      if (liveSegs.length === 0) continue;

      // Category header
      const catHeader = sheet.addRow(new Array(segTotalCols).fill(''));
      catHeader.getCell(1).value = category;
      applyCategoryHeaderStyle(catHeader);
      sheet.mergeCells(catHeader.number, 1, catHeader.number, segTotalCols);

      for (const { segName, curBud, lyBud, lyAct } of liveSegs) {
        const rowData: any = {
          segment: segName,
          category: category,
          lyBud: formatNumber(lyBud, decimals),
          lyBudVar: formatPercentage(pct(curBud, lyBud)),
          lyAct: formatNumber(lyAct, decimals),
          lyActVar: formatPercentage(pct(curBud, lyAct)),
          curBud: formatNumber(curBud, decimals),
          comments: '',
        };
        // Missing monthly bucket → render 0 (not blank) so empty cells don't
        // look like broken output. ADR uses 0/0 → 0 by definition.
        const monthly = monthlyByKey.get(`${category}::${segName}`);
        for (let i = 0; i < this.periods.length; i++) {
          if (metric === 'revenue') {
            rowData[`budM${i}`] = fmtN0(monthly ? -monthly.revMonthly[i] : 0, 0);
          } else if (metric === 'nights') {
            rowData[`budM${i}`] = fmtN0(monthly ? monthly.nightsMonthly[i] : 0, 0);
          } else {
            const n = monthly?.nightsMonthly[i] ?? 0;
            const r = monthly?.revMonthly[i] ?? 0;
            rowData[`budM${i}`] = fmtN0(n !== 0 ? -r / n : 0, 2);
          }
        }

        const excelRow = sheet.addRow(rowData);
        applyDataRowStyle(excelRow);
        // Thousands separator on numeric cells; ADR keeps 2dp, others 0dp.
        // Percentage cells are pre-formatted strings (skipped by typeof check).
        const numFmt = metric === 'adr' ? '#,##0.00' : '#,##0';
        for (let c = 3; c < segTotalCols; c++) {
          const cell = excelRow.getCell(c);
          if (typeof cell.value === 'number') cell.numFmt = numFmt;
        }
      }
    }
  }

  // ============================================================================
  // DEPARTMENT WORKSHEETS
  // ============================================================================

  private async createBudgetDepartmentWorksheets(
    workbook: ExcelJS.Workbook,
    config: ProteaBudgetPackConfig,
    departments: Array<{ baseDepartment: string; departmentName: string; level7Group: string | null }>,
    movedCurrent: any[],
    movedLY: any[],
    movedDeptData: Map<string, { current: any[]; ly: any[] }>,
    movedBudgetByPeriod: Map<string, Array<{ account: string; [p: string]: number }>>
  ): Promise<void> {
    // Group departments by level_7
    const groupMap = new Map<string, typeof departments>();
    for (const dept of departments) {
      let groupKey = dept.level7Group || dept.baseDepartment;
      if (config.includeBanquetingBreakdown && BANQUETING_DEPARTMENTS.has(dept.baseDepartment)) {
        groupKey = 'Total Banqueting';
      }
      if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
      groupMap.get(groupKey)!.push(dept);
    }

    // Sort groups per display order
    const sortedGroups = [...groupMap.entries()].sort((a, b) => {
      const idxA = PROTEA_GROUP_DISPLAY_ORDER.indexOf(a[0]);
      const idxB = PROTEA_GROUP_DISPLAY_ORDER.indexOf(b[0]);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a[0].localeCompare(b[0]);
    });

    const usedSheetNames = new Set<string>();

    for (const [groupName, groupDepts] of sortedGroups) {
      const nonMovedDepts = groupDepts.filter(d => !MOVED_DEPT_SET.has(d.baseDepartment));
      if (nonMovedDepts.length === 0 && !MOVEMENT_TARGET_GROUPS.has(groupName)) continue;

      // Hide noisy groups in the summary-only variant of the pack. When
      // detail tabs are on, the group renders in full (summary + dept tabs).
      if (!config.generateDetailTabs && BUDGET_SUMMARY_ONLY_HIDDEN_GROUPS.has(groupName)) continue;

      this.sheetRegistry.push({ type: 'groupHeader', sheetName: '', groupName, indent: false });

      // Group summary sheet — for Invest Factor Owner this returns BOTH the
      // INVEST FACTOR OWNER SUMMARY and the spun-off FIXED EXPENSES tab.
      const summaryNames = await this.createBudgetGroupSummaryWorksheet(
        workbook, config, groupName, groupDepts, usedSheetNames, movedCurrent, movedLY, movedDeptData, movedBudgetByPeriod
      );
      for (const name of summaryNames) {
        this.sheetRegistry.push({ type: 'sheet', sheetName: name, indent: true });
      }

      // Individual department detail sheets (if enabled)
      if (config.generateDetailTabs) {
        for (const dept of groupDepts) {
          if (MOVED_DEPT_SET.has(dept.baseDepartment)) continue;
          const deptSheetName = await this.createBudgetSingleDepartmentWorksheet(
            workbook, config, dept, usedSheetNames, undefined, movedCurrent, movedLY, movedDeptData, movedBudgetByPeriod
          );
          if (deptSheetName) {
            this.sheetRegistry.push({ type: 'sheet', sheetName: deptSheetName, indent: true });
          }
        }
      }
    }
  }

  // ============================================================================
  // GROUP SUMMARY WORKSHEET
  // ============================================================================

  private async createBudgetGroupSummaryWorksheet(
    workbook: ExcelJS.Workbook,
    config: ProteaBudgetPackConfig,
    groupName: string,
    groupDepts: Array<{ baseDepartment: string; departmentName: string; level7Group: string | null }>,
    usedSheetNames: Set<string>,
    movedCurrent: any[],
    movedLY: any[],
    movedDeptData: Map<string, { current: any[]; ly: any[] }>,
    movedBudgetByPeriod: Map<string, Array<{ account: string; [p: string]: number }>>
  ): Promise<string[]> {
    const deptIds = groupDepts.map(d => d.baseDepartment);
    let effectiveDeptIds = deptIds.filter(id => !MOVED_DEPT_SET.has(id));
    if (effectiveDeptIds.length === 0 && !MOVEMENT_TARGET_GROUPS.has(groupName)) return [];

    // Fetch current period data (budget=CurBud, ly=LYAct)
    let [currentData, lyData] = await Promise.all([
      effectiveDeptIds.length > 0
        ? db.getProteaGroupDepartmentDetailData(config.ou, effectiveDeptIds, config.startMonth, config.startYear, config.endMonth, config.endYear, config.version)
        : Promise.resolve([]),
      effectiveDeptIds.length > 0
        ? db.getProteaGroupDepartmentDetailData(config.ou, effectiveDeptIds, config.startMonth, config.startYear - 1, config.endMonth, config.endYear - 1, config.version)
        : Promise.resolve([]),
    ]);

    // Fetch per-period budget data
    let budgetByPeriod = effectiveDeptIds.length > 0
      ? await db.getProteaGroupDepartmentBudgetByPeriod(config.ou, effectiveDeptIds, this.periods, config.version)
      : [];

    // Strip A730/A745 from native group fetch when the group's effective depts
    // include a movement source. D0490 is in PROTEA_MOVEMENT_SOURCE_DEPTS but
    // NOT in MOVED_DEPT_SET, so it stays in effectiveDeptIds for the Invest
    // Factor Owner group — meaning the native fetch carries A730/A745 unless
    // we filter them out here. Mirrors proteaReportPackService.ts:580-586.
    const groupContainsSourceDept = effectiveDeptIds.some(id => PROTEA_MOVEMENT_SOURCE_DEPTS.includes(id));
    if (groupContainsSourceDept) {
      currentData = currentData.filter(r => !isMovedAccount(r.account));
      lyData = lyData.filter(r => !isMovedAccount(r.account));
      budgetByPeriod = budgetByPeriod.filter(r => !isMovedAccount(r.account));
    }

    // Merge moved A730/A745 account data into Administrative & General only.
    // Mirrors proteaReportPackService.ts:589 — moved accounts must NOT land in
    // Invest Factor Owner (they'd duplicate against F90, which strips them).
    if (groupName === 'Administrative & General') {
      const movedAccountsCur = movedCurrent.filter(r => isMovedAccount(r.account));
      const movedAccountsLY = movedLY.filter(r => isMovedAccount(r.account));
      currentData = [...currentData, ...movedAccountsCur];
      lyData = [...lyData, ...movedAccountsLY];
      // Route A730/A745 per-period budget into A&G's monthly columns.
      // Pre-fetched movedBudgetByPeriod is keyed by source dept (D0480/D0690/
      // D0691); only the moved-account rows belong here.
      for (const mvBp of movedBudgetByPeriod.values()) {
        budgetByPeriod = [...budgetByPeriod, ...mvBp.filter(r => isMovedAccount(r.account))];
      }
    }

    // Merge moved department data
    for (const mv of PROTEA_DEPARTMENT_MOVEMENTS) {
      if (mv.targetGroup === groupName) {
        const mvData = movedDeptData.get(mv.sourceDept);
        if (mvData) {
          currentData = [...currentData, ...mvData.current];
          lyData = [...lyData, ...mvData.ly];
        }
        const mvBudByPeriod = movedBudgetByPeriod.get(mv.sourceDept);
        if (mvBudByPeriod) {
          budgetByPeriod = [...budgetByPeriod, ...mvBudByPeriod.filter(r => !isMovedAccount(r.account))];
        }
      }
    }

    currentData = aggregateDuplicateAccounts(currentData);
    lyData = aggregateDuplicateAccounts(lyData);

    if (currentData.length === 0 && lyData.length === 0) return [];

    // Create sheet
    let sheetName = sanitizeSheetName(`${proteaRenameLabel(groupName)} Summary`.toUpperCase());
    let finalName = sheetName;
    let counter = 1;
    while (usedSheetNames.has(finalName.toLowerCase())) {
      const suffix = ` (${counter})`;
      finalName = sheetName.substring(0, 31 - suffix.length) + suffix;
      counter++;
    }
    usedSheetNames.add(finalName.toLowerCase());

    const sheet = workbook.addWorksheet(finalName, { properties: { tabColor: TAB_COLOR_GROUP_SUMMARY } });
    sheet.columns = this.buildColumns();

    this.addSheetTitleHeader(sheet, config, proteaRenameLabel(groupName));
    this.addColumnHeaders(sheet, config);

    // Render data — Invest Factor Owner uses custom subgroup layout. Fixed
    // Expenses is hidden here so it can be rendered on its own tab below
    // (mirrors the actuals pack's INVEST/FIXED EXPENSES split). F90 is
    // unaffected: its "Fixed Expenses" override is sourced from
    // computeInvestFactorOwnerSubgroupTotals() which classifies the same
    // accounts independently of this rendering filter.
    const isInvestGroup = groupName === 'Invest Factor Owner';
    const isRoomsGroup = groupName === 'Rooms and Reservation';
    if (isInvestGroup) {
      this.addBudgetCustomSubgroupDataSection(sheet, currentData, lyData, budgetByPeriod, {
        hideSubgroupNames: ['Fixed Expenses'],
      });
    } else {
      this.addBudgetDepartmentDataSection(sheet, currentData, lyData, budgetByPeriod, {
        collapseRevenueDetail: !config.generateDetailTabs && isRoomsGroup,
        flattenCategories: !isInvestGroup ? ['Payroll', 'Controllables'] : undefined,
        suppressStats: isRoomsGroup,
        showDeptProfit: BUDGET_STATS_KEEP_GROUPS.has(groupName),
        hideDetailOnlyAccounts: !config.generateDetailTabs,
      });
    }

    if (isRoomsGroup) {
      const kpi = await this.fetchBudgetKpiEngineData(config, ROOMS_KPI_CONFIG);
      this.addBudgetRoomsKpiRows(sheet, kpi);
    } else if (groupName === 'Total Food & Beverage') {
      const kpi = await this.fetchBudgetKpiEngineData(config, FB_KPI_CONFIG);
      this.addBudgetFbKpiRows(sheet, kpi);
    } else {
      // % of Hotel Revenue block — A&G, POM, S&M (any group registered
      // in PCT_OF_REVENUE_KPI_GROUPS). Mirrors the actuals pack dispatch.
      const pctRevConfig = PCT_OF_REVENUE_KPI_GROUPS.get(groupName);
      if (pctRevConfig) {
        const kpi = await this.fetchBudgetKpiEngineData(config, pctRevConfig);
        this.addBudgetPctOfRevenueKpiRows(sheet, kpi);
      }
    }

    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];

    // Spawn the FIXED EXPENSES companion tab off the same fetched dataset
    // (no extra DB round-trips). Returns null if the subgroup is empty.
    const sheetNames: string[] = [finalName];
    if (isInvestGroup) {
      const fixedExpName = this.createBudgetFixedExpensesSheet(
        workbook, config, currentData, lyData, budgetByPeriod, usedSheetNames
      );
      if (fixedExpName) sheetNames.push(fixedExpName);
    }
    return sheetNames;
  }

  /**
   * FIXED EXPENSES tab — renders ONLY the level_20 = 'Fixed Expenses' subgroup
   * out of the same INVEST FACTOR OWNER dataset. Mirrors the actuals pack's
   * createInvestFixedExpensesSheet (proteaReportPackService.ts) but uses the
   * budget pack column layout.
   *
   * No extra queries: data is the same currentData / lyData / budgetByPeriod
   * already aggregated for the INVEST FACTOR OWNER SUMMARY.
   *
   * Tie-out: F90's "Fixed Expenses" row, the INVEST sheet (where it's hidden),
   * and this sheet all sum the same accounts (level_20 = 'Fixed Expenses' on
   * D0480/D0490/D0690/D0691). The INVEST sheet hides the subgroup at render
   * time only — accounts remain in the data, so F90's independent classifier
   * call still produces the same total. No double counting, no orphan data.
   */
  private createBudgetFixedExpensesSheet(
    workbook: ExcelJS.Workbook,
    config: ProteaBudgetPackConfig,
    currentData: any[],
    lyData: any[],
    budgetByPeriod: Array<{ account: string; [p: string]: number }>,
    usedSheetNames: Set<string>
  ): string | null {
    let sheetName = sanitizeSheetName('FIXED EXPENSES');
    let finalName = sheetName;
    let counter = 1;
    while (usedSheetNames.has(finalName.toLowerCase())) {
      const suffix = ` (${counter})`;
      finalName = sheetName.substring(0, 31 - suffix.length) + suffix;
      counter++;
    }
    usedSheetNames.add(finalName.toLowerCase());

    const sheet = workbook.addWorksheet(finalName, { properties: { tabColor: TAB_COLOR_GROUP_SUMMARY } });
    sheet.columns = this.buildColumns();

    this.addSheetTitleHeader(sheet, config, 'Fixed Expenses');
    this.addColumnHeaders(sheet, config);

    this.addBudgetCustomSubgroupDataSection(sheet, currentData, lyData, budgetByPeriod, {
      onlySubgroupNames: ['Fixed Expenses'],
    });

    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];
    return finalName;
  }

  // ============================================================================
  // SINGLE DEPARTMENT WORKSHEET
  // ============================================================================

  private async createBudgetSingleDepartmentWorksheet(
    workbook: ExcelJS.Workbook,
    config: ProteaBudgetPackConfig,
    dept: { baseDepartment: string; departmentName: string; level7Group: string | null },
    usedSheetNames: Set<string>,
    nameOverride?: string,
    movedCurrent: any[] = [],
    movedLY: any[] = [],
    movedDeptData: Map<string, { current: any[]; ly: any[] }> = new Map(),
    movedBudgetByPeriod: Map<string, Array<{ account: string; [p: string]: number }>> = new Map()
  ): Promise<string | null> {
    // Fetch data
    let [currentData, lyData] = await Promise.all([
      db.getProteaDepartmentDetailData(config.ou, dept.baseDepartment, config.startMonth, config.startYear, config.endMonth, config.endYear, config.version),
      db.getProteaDepartmentDetailData(config.ou, dept.baseDepartment, config.startMonth, config.startYear - 1, config.endMonth, config.endYear - 1, config.version),
    ]);

    let budgetByPeriod = await db.getProteaDepartmentBudgetByPeriod(config.ou, dept.baseDepartment, this.periods, config.version);

    // Apply account movements
    if (PROTEA_MOVEMENT_SOURCE_DEPTS.includes(dept.baseDepartment)) {
      currentData = currentData.filter(r => !isMovedAccount(r.account));
      lyData = lyData.filter(r => !isMovedAccount(r.account));
      budgetByPeriod = budgetByPeriod.filter(r => !isMovedAccount(r.account));
    }

    // Merge moved accounts into D0410
    if (dept.baseDepartment === 'D0410') {
      currentData = aggregateDuplicateAccounts([...currentData, ...movedCurrent]);
      lyData = aggregateDuplicateAccounts([...lyData, ...movedLY]);
      // Merge moved budget-by-period data
      for (const mvBp of movedBudgetByPeriod.values()) {
        budgetByPeriod = [...budgetByPeriod, ...mvBp.filter(r => isMovedAccount(r.account))];
      }
    }

    // Merge moved department data
    for (const mv of PROTEA_DEPARTMENT_MOVEMENTS) {
      if (mv.detailMergeTarget === dept.baseDepartment && mv.sourceDept !== dept.baseDepartment) {
        const mvData = movedDeptData.get(mv.sourceDept);
        if (mvData) {
          currentData = aggregateDuplicateAccounts([...currentData, ...mvData.current]);
          lyData = aggregateDuplicateAccounts([...lyData, ...mvData.ly]);
        }
        const mvBp = movedBudgetByPeriod.get(mv.sourceDept);
        // A730/A745 belong to A&G only — strip them here so the target detail
        // tab's monthly columns mirror the totals path (movedDeptData was
        // pre-filtered !isMovedAccount at fetch time, line 2017).
        if (mvBp) budgetByPeriod = [...budgetByPeriod, ...mvBp.filter(r => !isMovedAccount(r.account))];
      }
    }

    if (currentData.length === 0 && lyData.length === 0) return null;

    let sheetName = sanitizeSheetName(proteaRenameLabel(nameOverride || dept.departmentName || dept.baseDepartment));
    let finalName = sheetName;
    let counter = 1;
    while (usedSheetNames.has(finalName.toLowerCase())) {
      const suffix = ` (${counter})`;
      finalName = sheetName.substring(0, 31 - suffix.length) + suffix;
      counter++;
    }
    usedSheetNames.add(finalName.toLowerCase());

    const sheet = workbook.addWorksheet(finalName, { properties: { tabColor: TAB_COLOR_DEPARTMENT } });
    sheet.columns = this.buildColumns();

    this.addSheetTitleHeader(sheet, config, proteaRenameLabel(nameOverride || dept.departmentName));
    this.addColumnHeaders(sheet, config);

    // D0490 detail with incoming movements uses custom subgroup layout
    const isInvestDetail = dept.baseDepartment === 'D0490' &&
      PROTEA_DEPARTMENT_MOVEMENTS.some(mv => mv.detailMergeTarget === dept.baseDepartment && mv.sourceDept !== dept.baseDepartment);
    if (isInvestDetail) {
      this.addBudgetCustomSubgroupDataSection(sheet, currentData, lyData, budgetByPeriod);
    } else {
      this.addBudgetDepartmentDataSection(sheet, currentData, lyData, budgetByPeriod);
    }

    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];
    return finalName;
  }

  // ============================================================================
  // DEPARTMENT DATA SECTION RENDERING (Budget Pack Column Layout)
  // ============================================================================

  private addBudgetDepartmentDataSection(
    sheet: ExcelJS.Worksheet,
    currentData: any[],   // budget=CurBud, ly=LYAct
    lyData: any[],        // budget=LYBud
    budgetByPeriod: Array<{ account: string; [p: string]: number }>,
    options?: { collapseRevenueDetail?: boolean; flattenCategories?: readonly string[]; suppressStats?: boolean; showDeptProfit?: boolean; hideDetailOnlyAccounts?: boolean }
  ): void {
    // Drop accounts that are zero across CurBud / LYBud / LYAct period totals.
    // Cascades through level_12 grouping and category totals — no per-site
    // suppression logic needed. F90 deliberately does NOT use this; layout
    // parity with the validated actuals pack requires every config row.
    ({ currentData, lyData } = filterLiveAccountRows(currentData, lyData));

    // Strip allocation-driver / low-signal accounts in summary-only mode.
    // budgetByPeriod is also filtered so monthly columns don't reference
    // accounts that are no longer in currentData/lyData.
    if (options?.hideDetailOnlyAccounts) {
      currentData = currentData.filter(r => !isDetailOnlyAccount(r.account));
      lyData = lyData.filter(r => !isDetailOnlyAccount(r.account));
      budgetByPeriod = budgetByPeriod.filter(r => !isDetailOnlyAccount(r.account));
    }

    const tc = this.totalCols;
    const budgetMap = new Map<string, { [p: string]: number }>();
    for (const row of budgetByPeriod) {
      const existing = budgetMap.get(row.account);
      if (existing) {
        for (const p of this.periods) existing[p] = (existing[p] || 0) + (row[p] || 0);
      } else {
        const entry: any = {};
        for (const p of this.periods) entry[p] = row[p] || 0;
        budgetMap.set(row.account, entry);
      }
    }

    // Build lookup by account for LY data
    const lyMap = new Map<string, any>();
    for (const row of lyData) lyMap.set(row.account, row);

    const categories = ['Revenue', 'Cost of Sales', 'Payroll', 'Controllables', 'Other', 'Stats'];

    const sumField = (rows: any[], field: string) =>
      rows.reduce((sum: number, r: any) => sum + (Number(r[field]) || 0), 0);

    /** Add a row with aggregated totals (category or level_12 subtotal) */
    const addTotalRow = (label: string, curRows: any[], lyRows: any[], styleFn: (row: ExcelJS.Row) => void, sign: number = 1) => {
      const curBud = sumField(curRows, 'budget') * sign;
      const lyBud = sumField(lyRows, 'budget') * sign;
      const lyAct = sumField(curRows, 'ly') * sign; // ly field on current-period query = LY actuals

      const rowData: any = {
        label: label,
        lyBud: formatNumber(lyBud),
        lyBudVar: formatPercentage(pct(curBud, lyBud)),
        lyAct: formatNumber(lyAct),
        lyActVar: formatPercentage(pct(curBud, lyAct)),
        curBud: formatNumber(curBud),
        comments: '',
      };

      // Monthly totals
      const accountsInGroup = new Set(curRows.map((r: any) => r.account));
      for (let i = 0; i < this.periods.length; i++) {
        const p = this.periods[i];
        let monthTotal = 0;
        for (const acct of accountsInGroup) {
          const bpRow = budgetMap.get(acct);
          if (bpRow) monthTotal += (bpRow[p] || 0) * sign;
        }
        rowData[`budM${i}`] = formatNumber(monthTotal);
      }

      const excelRow = sheet.addRow(rowData);
      styleFn(excelRow);
      this.applyNumberFormats(excelRow);
    };

    /** Add a blank separator row */
    const addBlank = () => {
      const blankRow = sheet.addRow(new Array(tc).fill(''));
      blankRow.eachCell((cell) => { cell.border = BORDER_STYLE; cell.font = DATA_FONT; });
    };

    /** Render a single account-detail row (shared by grouped + flat branches). */
    const renderAcct = (acct: string, curAcctMap: Map<string, any>, lyAcctMap: Map<string, any>, sign: number) => {
      const curRow = curAcctMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0, accountName: acct, account: acct };
      const lyRow = lyAcctMap.get(acct) || { budget: 0 };
      const bpRow = budgetMap.get(acct);

      const curBud = curRow.budget * sign;
      const lyBud = lyRow.budget * sign;
      const lyAct = curRow.ly * sign;
      const displayName = curRow.accountName || curRow.account;

      const rowData: any = {
        label: `    ${displayName}`,
        lyBud: formatNumber(lyBud),
        lyBudVar: formatPercentage(pct(curBud, lyBud)),
        lyAct: formatNumber(lyAct),
        lyActVar: formatPercentage(pct(curBud, lyAct)),
        curBud: formatNumber(curBud),
        comments: '',
      };
      for (let i = 0; i < this.periods.length; i++) {
        const p = this.periods[i];
        rowData[`budM${i}`] = fmtN0(bpRow ? (bpRow[p] || 0) * sign : 0);
      }

      const excelRow = sheet.addRow(rowData);

      const accountLabel = this.buildAccountLabel(displayName, curRow.account);
      if (typeof accountLabel !== 'string') {
        excelRow.getCell(1).value = { richText: [{ font: { size: 10 }, text: '    ' }, ...accountLabel.richText] };
      }

      applyDataRowStyle(excelRow);
      this.applyNumberFormats(excelRow);
    };

    /**
     * Render the bottom-line totals — "Department Profit" + "Department Profit %"
     * for revenue-bearing groups, or a single "Total" for non-revenue groups
     * (Admin & General, POM, S&M). Mirrors proteaReportPackService.ts:1046-1182.
     *
     * Sign convention: revenue rows are stored as negative (CR), expense rows
     * as positive (DR). Profit = -(rev + exp) → flip with sign=-1.
     *
     * The Department Profit numeric row is delegated to addTotalRow with sign=-1
     * (DRY — reuses the existing curBud/lyBud/lyAct + monthly aggregation). The
     * GOP% row is hand-rolled because addTotalRow only emits absolute numbers,
     * not percentage cells with "X.X pts" variance markers.
     */
    const renderDeptProfit = () => {
      const curRevRows = currentData.filter(r => r.category === 'Revenue');
      const lyRevRows  = lyData.filter(r => r.category === 'Revenue');
      const isRevenueGroup = curRevRows.length > 0 || lyRevRows.length > 0;

      if (isRevenueGroup) {
        const isProfitable = (cat: string) =>
          cat === 'Revenue' || (DEPT_PROFIT_EXPENSE_CATEGORIES as readonly string[]).includes(cat);
        const curRevExp = currentData.filter(r => isProfitable(r.category));
        const lyRevExp  = lyData.filter(r => isProfitable(r.category));

        // Department Profit (numeric) — sign=-1 flips stored signs into a
        // positive profit. Monthly columns inherit the same flip.
        addTotalRow('Department Profit', curRevExp, lyRevExp, applyCategorySubtotalStyle, -1);

        // Department Profit % — GOP margin = profit / revenue. Variance is
        // expressed in percentage points (pts), matching the actuals pack.
        const curBudRev    = -sumField(curRevRows, 'budget');
        const lyBudRev     = -sumField(lyRevRows,  'budget');
        const lyActRev     = -sumField(curRevRows, 'ly');
        const curBudProfit = -sumField(curRevExp,  'budget');
        const lyBudProfit  = -sumField(lyRevExp,   'budget');
        const lyActProfit  = -sumField(curRevExp,  'ly');

        const gop = (p: number, r: number) => r !== 0 ? (p / r) * 100 : 0;
        const curBudGop = gop(curBudProfit, curBudRev);
        const lyBudGop  = gop(lyBudProfit,  lyBudRev);
        const lyActGop  = gop(lyActProfit,  lyActRev);

        const gopRowData: any = {
          label: 'Department Profit %',
          lyBud: formatPercentage(lyBudGop),
          lyBudVar: `${(curBudGop - lyBudGop).toFixed(1)} pts`,
          lyAct: formatPercentage(lyActGop),
          lyActVar: `${(curBudGop - lyActGop).toFixed(1)} pts`,
          curBud: formatPercentage(curBudGop),
          comments: '',
        };

        // Monthly GOP%: aggregate revenue and rev+exp budgets per period in a
        // single pass over the rev+exp account set, then derive profit = -total
        // and revenue = -revPortion. Keeps it O(periods × accounts) — same cost
        // class as addTotalRow's monthly loop.
        const revAccts = new Set(curRevRows.map(r => r.account));
        const allAccts = new Set(curRevExp.map(r => r.account));
        for (let i = 0; i < this.periods.length; i++) {
          const p = this.periods[i];
          let totalM = 0, revM = 0;
          for (const acct of allAccts) {
            const bp = budgetMap.get(acct);
            if (!bp) continue;
            const v = bp[p] || 0;
            totalM += v;
            if (revAccts.has(acct)) revM += v;
          }
          gopRowData[`budM${i}`] = formatPercentage(gop(-totalM, -revM));
        }

        const gopRow = sheet.addRow(gopRowData);
        applyCategorySubtotalStyle(gopRow);
        this.applyNumberFormats(gopRow);
        addBlank();
      } else if (currentData.length > 0 || lyData.length > 0) {
        // Non-revenue group (A&G, POM, S&M): a single "Total" row over all
        // non-Stats accounts at face value (no sign flip, expenses positive).
        const curAll = currentData.filter(r => r.category !== 'Stats');
        const lyAll  = lyData.filter(r => r.category !== 'Stats');
        if (curAll.length > 0 || lyAll.length > 0) {
          addTotalRow('Total', curAll, lyAll, applyCategorySubtotalStyle, 1);
          addBlank();
        }
      }
    };

    let deptProfitRendered = false;

    for (const category of categories) {
      if (options?.suppressStats && category === 'Stats') continue;
      const curCategoryRows = currentData.filter(r => r.category === category);
      const lyCategoryRows = lyData.filter(r => r.category === category);
      if (curCategoryRows.length === 0 && lyCategoryRows.length === 0) continue;

      const isStats = category === 'Stats';
      const isRevenue = category === 'Revenue';

      // Render Department Profit BEFORE the Stats block for groups that retain
      // Stats (F&B, Banqueting, Utilities). Otherwise it falls through to the
      // post-loop render (suppressed-Stats groups + non-revenue groups).
      if (isStats && options?.showDeptProfit && !deptProfitRendered) {
        renderDeptProfit();
        deptProfitRendered = true;
      }
      const sign = isRevenue ? -1 : 1;

      // When collapsing revenue detail (Rooms & Reservation without dept detail
      // tabs), skip per-account lines — the breakdown lives on Room Segments.
      if (isRevenue && options?.collapseRevenueDetail) {
        addTotalRow(`Total ${category}`, curCategoryRows, lyCategoryRows, applyCategorySubtotalStyle, sign);
        addBlank();
        continue;
      }

      if (isStats) {
        // Stats: flat render, no level_12 grouping
        for (const curRow of curCategoryRows) {
          const lyRow = lyMap.get(curRow.account) || { budget: 0 };
          const bpRow = budgetMap.get(curRow.account);
          const curBud = curRow.budget * sign;
          const lyBud = lyRow.budget * sign;
          const lyAct = curRow.ly * sign;

          const rowData: any = {
            label: `    ${curRow.accountName || curRow.account}`,
            lyBud: formatNumber(lyBud),
            lyBudVar: formatPercentage(pct(curBud, lyBud)),
            lyAct: formatNumber(lyAct),
            lyActVar: formatPercentage(pct(curBud, lyAct)),
            curBud: formatNumber(curBud),
            comments: '',
          };
          for (let i = 0; i < this.periods.length; i++) {
            const p = this.periods[i];
            // No current-budget row → render 0 (not blank) so rows that only
            // have LY data don't look broken across the monthly columns.
            rowData[`budM${i}`] = fmtN0(bpRow ? (bpRow[p] || 0) * sign : 0);
          }

          const excelRow = sheet.addRow(rowData);
          applyDataRowStyle(excelRow);
          this.applyNumberFormats(excelRow);
        }
      } else if (options?.flattenCategories?.includes(category)) {
        // Flattened: render all accounts without level_12 sub-group headers/subtotals.
        // A759* accounts are still collected into a "Levies" sub-group rendered
        // (with header + subtotal) at the bottom of the flat list.
        const allAccounts: string[] = [];
        const curAcctMap = new Map<string, any>();
        const lyAcctMap = new Map<string, any>();
        for (const row of curCategoryRows) { curAcctMap.set(row.account, row); if (!allAccounts.includes(row.account)) allAccounts.push(row.account); }
        for (const row of lyCategoryRows) { lyAcctMap.set(row.account, row); if (!allAccounts.includes(row.account)) allAccounts.push(row.account); }

        const leviesAccounts = allAccounts.filter(a => isLeviesAccount(a));
        const nonLeviesAccounts = allAccounts.filter(a => !isLeviesAccount(a));

        for (const acct of nonLeviesAccounts) renderAcct(acct, curAcctMap, lyAcctMap, sign);

        if (leviesAccounts.length > 0) {
          const sgHeaderRow = sheet.addRow(new Array(tc).fill(''));
          sgHeaderRow.getCell(1).value = LEVIES_SUBGROUP;
          applyGroupHeaderStyle(sgHeaderRow);

          for (const acct of leviesAccounts) renderAcct(acct, curAcctMap, lyAcctMap, sign);

          const curLeviesRows = leviesAccounts.map(a => curAcctMap.get(a)).filter(Boolean);
          const lyLeviesRows = leviesAccounts.map(a => lyAcctMap.get(a)).filter(Boolean);
          addTotalRow(`  Total ${LEVIES_SUBGROUP}`, curLeviesRows, lyLeviesRows, applyGroupSubtotalStyle, sign);
          addBlank();
        }

      } else {
        // Group by level_12
        // A759* accounts are carved out into a "Levies" sub-group.
        const curLevel12Map = new Map<string, any[]>();
        for (const row of curCategoryRows) {
          const groupKey = isLeviesAccount(row.account)
            ? LEVIES_SUBGROUP
            : (row.level12Group || `Other ${category}`);
          if (!curLevel12Map.has(groupKey)) curLevel12Map.set(groupKey, []);
          curLevel12Map.get(groupKey)!.push(row);
        }
        const lyLevel12Map = new Map<string, any[]>();
        for (const row of lyCategoryRows) {
          const groupKey = isLeviesAccount(row.account)
            ? LEVIES_SUBGROUP
            : (row.level12Group || `Other ${category}`);
          if (!lyLevel12Map.has(groupKey)) lyLevel12Map.set(groupKey, []);
          lyLevel12Map.get(groupKey)!.push(row);
        }

        const allGroupNames: string[] = [];
        for (const key of curLevel12Map.keys()) if (!allGroupNames.includes(key)) allGroupNames.push(key);
        for (const key of lyLevel12Map.keys()) if (!allGroupNames.includes(key)) allGroupNames.push(key);

        for (const gName of allGroupNames) {
          const curGroupRows = curLevel12Map.get(gName) || [];
          const lyGroupRows = lyLevel12Map.get(gName) || [];

          // Group header
          const gHeaderRow = sheet.addRow(new Array(tc).fill(''));
          gHeaderRow.getCell(1).value = proteaRenameLabel(gName);
          applyGroupHeaderStyle(gHeaderRow);

          // Account detail rows
          const allAccounts: string[] = [];
          const curAcctMap = new Map<string, any>();
          const lyAcctMap = new Map<string, any>();
          for (const row of curGroupRows) { curAcctMap.set(row.account, row); if (!allAccounts.includes(row.account)) allAccounts.push(row.account); }
          for (const row of lyGroupRows) { lyAcctMap.set(row.account, row); if (!allAccounts.includes(row.account)) allAccounts.push(row.account); }

          for (const acct of allAccounts) renderAcct(acct, curAcctMap, lyAcctMap, sign);

          // Group subtotal
          addTotalRow(`  Total ${proteaRenameLabel(gName)}`, curGroupRows, lyGroupRows, applyGroupSubtotalStyle, sign);
          addBlank();
        }
      }

      // Category total
      addTotalRow(`Total ${category}`, curCategoryRows, lyCategoryRows, applyCategorySubtotalStyle, sign);
      addBlank();
    }

    // Bottom-line totals (Department Profit / Total) — rendered here unless
    // already emitted before the Stats block via showDeptProfit.
    if (!deptProfitRendered) {
      renderDeptProfit();
    }
  }

  // ============================================================================
  // INVEST FACTOR OWNER — CUSTOM SUBGROUP RENDERING (Budget Pack Column Layout)
  // Groups accounts by level_20 mapping table instead of category/level_12.
  // ============================================================================

  /**
   * Render the level_20 / INVEST-classified subgroup layout.
   *
   * The optional `hideSubgroupNames` / `onlySubgroupNames` filters are pure
   * rendering-layer controls — they DO NOT alter classification, the data
   * fetched, or anything F90 depends on. F90's "Fixed Expenses" / "TOTAL
   * MANAGEMENT FEES" / etc. row values come from
   * computeInvestFactorOwnerSubgroupTotals(), which independently re-runs
   * the same OWNER_DEPARTMENTS fetch + classifyAccountsByLevel20 — so
   * suppressing a subgroup here cannot create a tie-out gap with F90.
   *
   * Used by:
   *  - INVEST FACTOR OWNER SUMMARY tab: hideSubgroupNames=['Fixed Expenses']
   *  - FIXED EXPENSES tab:              onlySubgroupNames=['Fixed Expenses']
   *  (mirrors the actuals pack's pattern, see createInvestFixedExpensesSheet
   *   in proteaReportPackService.ts)
   */
  private addBudgetCustomSubgroupDataSection(
    sheet: ExcelJS.Worksheet,
    currentData: any[],
    lyData: any[],
    budgetByPeriod: Array<{ account: string; [p: string]: number }>,
    options?: { hideSubgroupNames?: readonly string[]; onlySubgroupNames?: readonly string[] }
  ): void {
    const tc = this.totalCols;
    const budgetMap = new Map<string, { [p: string]: number }>();
    for (const row of budgetByPeriod) {
      const existing = budgetMap.get(row.account);
      if (existing) {
        for (const p of this.periods) existing[p] = (existing[p] || 0) + (row[p] || 0);
      } else {
        const entry: any = {};
        for (const p of this.periods) entry[p] = row[p] || 0;
        budgetMap.set(row.account, entry);
      }
    }

    const lyMap = new Map<string, any>();
    for (const row of lyData) lyMap.set(row.account, row);

    const sumField = (rows: any[], field: string) =>
      rows.reduce((sum: number, r: any) => sum + (Number(r[field]) || 0), 0);

    const pct = (num: number, base: number) =>
      base !== 0 ? ((num - base) / Math.abs(base)) * 100 : 0;

    // Filter out stats
    currentData = currentData.filter(r => r.category !== 'Stats');
    lyData = lyData.filter(r => r.category !== 'Stats');

    // Drop accounts that are zero across CurBud / LYBud / LYAct period totals.
    // Empty subgroups skip naturally via the length check below.
    ({ currentData, lyData } = filterLiveAccountRows(currentData, lyData));

    // Classify accounts using level_20 mapping table
    const allRows = [...currentData, ...lyData];
    const classification = classifyAccountsByLevel20(allRows, INVEST_CUSTOM_SUBGROUPS);
    const catchAllName = INVEST_CUSTOM_SUBGROUPS.find(sg => sg.isCatchAll)?.name || 'Other';

    // Renderer-local "Levies" carve-out for A759* accounts — does not mutate the
    // shared INVEST_CUSTOM_SUBGROUPS config or the F90 measure scope.
    for (const [acct, c] of classification) {
      if (isLeviesAccount(acct)) {
        c.subgroup = LEVIES_SUBGROUP;
        c.isUnmapped = false;
      }
    }
    const effectiveSubgroups: InvestSubgroupDef[] = [];
    let leviesInserted = false;
    for (const sg of INVEST_CUSTOM_SUBGROUPS) {
      effectiveSubgroups.push(sg);
      if (!leviesInserted && sg.name === 'Owners Expense') {
        effectiveSubgroups.push({ name: LEVIES_SUBGROUP });
        leviesInserted = true;
      }
    }
    if (!leviesInserted) {
      const catchAllIdx = effectiveSubgroups.findIndex(sg => sg.isCatchAll);
      if (catchAllIdx >= 0) effectiveSubgroups.splice(catchAllIdx, 0, { name: LEVIES_SUBGROUP });
      else effectiveSubgroups.push({ name: LEVIES_SUBGROUP });
    }

    // Build per-subgroup data sets
    const curBySubgroup = new Map<string, any[]>();
    const lyBySubgroup = new Map<string, any[]>();
    for (const sg of effectiveSubgroups) {
      curBySubgroup.set(sg.name, []);
      lyBySubgroup.set(sg.name, []);
    }
    for (const row of currentData) {
      const sg = classification.get(row.account)?.subgroup || catchAllName;
      curBySubgroup.get(sg)?.push(row);
    }
    for (const row of lyData) {
      const sg = classification.get(row.account)?.subgroup || catchAllName;
      lyBySubgroup.get(sg)?.push(row);
    }

    /** Add a row with aggregated totals */
    const addTotalRow = (label: string, curRows: any[], lyRows: any[], styleFn: (row: ExcelJS.Row) => void) => {
      const curBud = sumField(curRows, 'budget');
      const lyBud = sumField(lyRows, 'budget');
      const lyAct = sumField(curRows, 'ly');

      const rowData: any = {
        label: label,
        lyBud: formatNumber(lyBud),
        lyBudVar: formatPercentage(pct(curBud, lyBud)),
        lyAct: formatNumber(lyAct),
        lyActVar: formatPercentage(pct(curBud, lyAct)),
        curBud: formatNumber(curBud),
        comments: '',
      };

      const accountsInGroup = new Set(curRows.map((r: any) => r.account));
      for (let i = 0; i < this.periods.length; i++) {
        const p = this.periods[i];
        let monthTotal = 0;
        for (const acct of accountsInGroup) {
          const bpRow = budgetMap.get(acct);
          if (bpRow) monthTotal += bpRow[p] || 0;
        }
        rowData[`budM${i}`] = formatNumber(monthTotal);
      }

      const excelRow = sheet.addRow(rowData);
      styleFn(excelRow);
      this.applyNumberFormats(excelRow);
    };

    const addBlank = () => {
      const blankRow = sheet.addRow(new Array(tc).fill(''));
      blankRow.eachCell((cell) => { cell.border = BORDER_STYLE; cell.font = DATA_FONT; });
    };

    // Pre-resolve the allow/deny predicate once per render — Set lookups are
    // O(1) and avoid repeating includes() inside the hot loop.
    const hideSet = options?.hideSubgroupNames?.length
      ? new Set(options.hideSubgroupNames) : null;
    const onlySet = options?.onlySubgroupNames?.length
      ? new Set(options.onlySubgroupNames) : null;

    // Render each subgroup in config order
    for (const sg of effectiveSubgroups) {
      if (onlySet && !onlySet.has(sg.name)) continue;
      if (hideSet && hideSet.has(sg.name)) continue;
      const curRows = curBySubgroup.get(sg.name) || [];
      const lyRows = lyBySubgroup.get(sg.name) || [];
      if (curRows.length === 0 && lyRows.length === 0) continue;

      // Subgroup header
      const gHeaderRow = sheet.addRow(new Array(tc).fill(''));
      gHeaderRow.getCell(1).value = proteaRenameLabel(sg.name);
      applyGroupHeaderStyle(gHeaderRow);

      // Account detail rows
      const allAccounts: string[] = [];
      const curAcctMap = new Map<string, any>();
      const lyAcctMap = new Map<string, any>();
      for (const row of curRows) { curAcctMap.set(row.account, row); if (!allAccounts.includes(row.account)) allAccounts.push(row.account); }
      for (const row of lyRows) { lyAcctMap.set(row.account, row); if (!allAccounts.includes(row.account)) allAccounts.push(row.account); }

      for (const acct of allAccounts) {
        const curRow = curAcctMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0, accountName: acct, account: acct };
        const lyRow = lyAcctMap.get(acct) || { budget: 0 };
        const bpRow = budgetMap.get(acct);

        const curBud = curRow.budget;
        const lyBud = lyRow.budget;
        const lyAct = curRow.ly;
        const displayName = curRow.accountName || curRow.account;

        const rowData: any = {
          label: `    ${displayName}`,
          lyBud: formatNumber(lyBud),
          lyBudVar: formatPercentage(pct(curBud, lyBud)),
          lyAct: formatNumber(lyAct),
          lyActVar: formatPercentage(pct(curBud, lyAct)),
          curBud: formatNumber(curBud),
          comments: '',
        };
        for (let i = 0; i < this.periods.length; i++) {
          const p = this.periods[i];
          rowData[`budM${i}`] = fmtN0(bpRow ? bpRow[p] || 0 : 0);
        }

        const excelRow = sheet.addRow(rowData);

        // Rich text account label
        const accountLabel = this.buildAccountLabel(displayName, curRow.account);
        if (typeof accountLabel !== 'string') {
          excelRow.getCell(1).value = { richText: [{ font: { size: 10 }, text: '    ' }, ...accountLabel.richText] };
        }

        applyDataRowStyle(excelRow);

        // Highlight unmapped accounts
        const acctClassification = classification.get(acct);
        if (acctClassification?.isUnmapped) {
          excelRow.getCell(1).font = { ...DATA_FONT, italic: true, color: { argb: 'FFCC6600' } };
        }

        this.applyNumberFormats(excelRow);
      }

      // Subgroup subtotal
      addTotalRow(`  Total ${proteaRenameLabel(sg.name)}`, curRows, lyRows, applyGroupSubtotalStyle);
      addBlank();
    }
  }

  // ============================================================================
  // COVER PAGE
  // ============================================================================

  private createBudgetCoverPageWorksheet(workbook: ExcelJS.Workbook, config: ProteaBudgetPackConfig): void {
    const sheet = workbook.addWorksheet('Contents');
    (sheet as any).orderNo = 0;

    sheet.columns = [{ key: 'label', width: 55 }];

    const titleRow = sheet.getRow(1);
    titleRow.getCell(1).value = config.hotelName;
    titleRow.getCell(1).font = { bold: true, size: 18, color: { argb: 'FF1E3A5F' } };
    titleRow.height = 30;

    const reportRow = sheet.getRow(2);
    reportRow.getCell(1).value = 'Protea Budget Pack';
    reportRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF4A4A4A' } };

    const rangeRow = sheet.getRow(3);
    rangeRow.getCell(1).value = `Budget Period: ${MONTH_NAMES[config.startMonth - 1]} ${config.startYear} - ${MONTH_NAMES[config.endMonth - 1]} ${config.endYear}`;
    rangeRow.getCell(1).font = { size: 11, color: { argb: 'FF666666' } };

    const versionRow = sheet.getRow(4);
    versionRow.getCell(1).value = `Version: ${config.version}`;
    versionRow.getCell(1).font = { size: 11, color: { argb: 'FF666666' } };

    const tocHeader = sheet.getRow(6);
    tocHeader.getCell(1).value = 'Table of Contents';
    tocHeader.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
    tocHeader.getCell(1).border = { bottom: { style: 'medium', color: { argb: 'FF1E3A5F' } } };

    let currentRow = 8;
    for (const entry of this.sheetRegistry) {
      const row = sheet.getRow(currentRow);
      if (entry.type === 'groupHeader') {
        row.getCell(1).value = proteaRenameLabel(entry.groupName || '').toUpperCase();
        row.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF1E3A5F' } };
        row.height = 22;
      } else {
        const indent = entry.indent ? '    ' : '';
        row.getCell(1).value = { text: `${indent}${entry.sheetName}`, hyperlink: `#'${entry.sheetName}'!A1` } as any;
        row.getCell(1).font = { size: 10, color: { argb: 'FF0563C1' }, underline: true };
      }
      currentRow++;
    }
  }

  // ============================================================================
  // MAIN ENTRY POINT
  // ============================================================================

  async generateReport(config: ProteaBudgetPackConfig, savePath: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PS Loader';
    workbook.created = new Date();
    workbook.modified = new Date();

    this.sheetRegistry = [];
    this.periods = generatePeriodsSync(config.startMonth, config.startYear, config.endMonth, config.endYear);
    this.lyPeriods = this.periods.map(offsetPeriodMinusYear);

    const now = new Date();
    this.generatedAt = now.toLocaleString('en-ZA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });

    // 1. F90 Report
    await this.createBudgetF90Worksheet(workbook, config);
    this.sheetRegistry.push({ type: 'sheet', sheetName: 'F90 Report', indent: false });

    // 2. Room Segments
    await this.createBudgetRoomSegmentWorksheet(workbook, config);
    this.sheetRegistry.push({ type: 'sheet', sheetName: 'Room Segments', indent: false });

    // 3. Departments
    const departments = (await db.getDepartmentsWithDataForOU(config.ou, config.version))
      .filter(d => !EXCEL_EXCLUDED_DEPARTMENTS.has(d.baseDepartment));

    // Pre-fetch moved account data (current + LY periods)
    const [movedAccountsCurrent, movedAccountsLY] = await Promise.all([
      db.getProteaGroupDepartmentDetailData(config.ou, PROTEA_MOVEMENT_SOURCE_DEPTS, config.startMonth, config.startYear, config.endMonth, config.endYear, config.version),
      db.getProteaGroupDepartmentDetailData(config.ou, PROTEA_MOVEMENT_SOURCE_DEPTS, config.startMonth, config.startYear - 1, config.endMonth, config.endYear - 1, config.version),
    ]);
    const movedCurrent = movedAccountsCurrent.filter(r => isMovedAccount(r.account));
    const movedLY = movedAccountsLY.filter(r => isMovedAccount(r.account));

    // Pre-fetch moved department data
    const movedDeptData = new Map<string, { current: any[]; ly: any[] }>();
    const movedBudgetByPeriod = new Map<string, Array<{ account: string; [p: string]: number }>>();
    await Promise.all(PROTEA_DEPARTMENT_MOVEMENTS.map(async (mv) => {
      const [current, ly, budByPeriod] = await Promise.all([
        db.getProteaDepartmentDetailData(config.ou, mv.sourceDept, config.startMonth, config.startYear, config.endMonth, config.endYear, config.version),
        db.getProteaDepartmentDetailData(config.ou, mv.sourceDept, config.startMonth, config.startYear - 1, config.endMonth, config.endYear - 1, config.version),
        db.getProteaDepartmentBudgetByPeriod(config.ou, mv.sourceDept, this.periods, config.version),
      ]);
      movedDeptData.set(mv.sourceDept, {
        current: current.filter(r => !isMovedAccount(r.account)),
        ly: ly.filter(r => !isMovedAccount(r.account)),
      });
      // Carries BOTH moved and non-moved rows; consumers filter at use site
      // (A&G pulls A730/A745; dept-level target groups exclude them).
      movedBudgetByPeriod.set(mv.sourceDept, budByPeriod);
    }));

    // D0490 is in PROTEA_MOVEMENT_SOURCE_DEPTS but not MOVED_DEPT_SET. Its native
    // group fetch carries A745/A730 rows that are filtered out at render time
    // (line 1107), so they never reach movedBudgetByPeriod. Pre-fetch them here
    // so A&G can pick them up for monthly columns.
    const extraMovedSourceDepts = PROTEA_MOVEMENT_SOURCE_DEPTS.filter(d => !MOVED_DEPT_SET.has(d));
    await Promise.all(extraMovedSourceDepts.map(async (dept) => {
      if (!movedBudgetByPeriod.has(dept)) {
        const budByPeriod = await db.getProteaDepartmentBudgetByPeriod(
          config.ou, dept, this.periods, config.version
        );
        movedBudgetByPeriod.set(dept, budByPeriod);
      }
    }));

    // 4. Department worksheets
    await this.createBudgetDepartmentWorksheets(workbook, config, departments, movedCurrent, movedLY, movedDeptData, movedBudgetByPeriod);

    // 5. Cover page (built last, positioned first)
    this.createBudgetCoverPageWorksheet(workbook, config);

    await workbook.xlsx.writeFile(savePath);
  }
}

// Singleton export
const proteaBudgetPackService = new ProteaBudgetPackService();
export default proteaBudgetPackService;
