/**
 * Protea Report Pack Service
 * ===========================
 * Generates formatted Protea Report Pack Excel reports using ExcelJS.
 * Runs in the Electron main process.
 */

import ExcelJS from 'exceljs';
import * as db from '../local_db';
import { PLCalculationResult } from '../types/plReportTypes';
import { PROTEA_F90_PL_ROW_CONFIG, PROTEA_F90_PL_ROW_CONFIG_WITH_BANQUETING } from './reports/proteaF90PLRowConfig';
import { buildProteaPayrollPLRowConfig } from './reports/proteaPayrollPLRowConfig';
import { registerProteaBurdenLineMeasures } from './reports/proteaPayrollMeasures';
import { PROTEA_PAYROLL_REPOINT_ACCOUNTS } from './reports/proteaMovements';
import { SUB_MEASURES, MEASURES } from './reports/plMeasureDefinitions';
import { PLRow } from '../types/plReportTypes';
import { INVEST_CUSTOM_SUBGROUPS, InvestSubgroupDef } from './reports/investSubgroupConfig';

// Shared constants, styling, configs, and utilities (single source of truth with Budget Pack)
import {
  ROOMS_KPI_CONFIG,
  FB_KPI_CONFIG,
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
  PROTEA_MOVED_ACCOUNT_PREFIXES,
  PROTEA_MOVEMENT_SOURCE_DEPTS,
  isMovedAccount,
  DepartmentMovement,
  PROTEA_DEPARTMENT_MOVEMENTS,
  BANQUETING_DEPARTMENTS,
  PROTEA_GROUP_DISPLAY_ORDER,
  MOVED_DEPT_SET,
  MOVED_DEPT_BY_SOURCE,
  MOVEMENT_TARGET_GROUPS,
  classifyAccountsByLevel20,
  computeInvestFactorOwnerSubgroupTotals,
  applyInvestSubgroupOverridesToF90Rows,
  LEVIES_SUBGROUP,
  isLeviesAccount,
  PCT_OF_REVENUE_KPI_GROUPS,
} from './reports/proteaShared';

// ============================================================================
// TYPES
// ============================================================================

export interface ProteaReportPackConfig {
  ou: string;
  hotelName: string;
  selectedMonth: number;
  selectedYear: number;
  ytdStartMonth: number;
  ytdStartYear: number;
  ytdEndMonth: number;
  ytdEndYear: number;
  version: string;  // 'MAIN' or 'OWNR'
  generateDetailTabs: boolean;  // Include individual department detail sheets (vs summary-only)
  includeBanquetingBreakdown: boolean;  // Split banqueting depts (D0230/D0231/D0232) out of F&B
}

// ============================================================================
// INVEST FACTOR OWNER — CUSTOM SUBGROUP CONFIGURATION
// Shared config imported from investSubgroupConfig.ts (single source of truth).
// See that file for the InvestSubgroupDef interface and INVEST_CUSTOM_SUBGROUPS array.
// ============================================================================

class ProteaReportPackService {
  private generatedAt: string = '';

  /** Registry of sheets and group headers for the cover page TOC */
  private sheetRegistry: Array<{
    type: 'sheet' | 'groupHeader';
    sheetName: string;
    groupName?: string;
    indent: boolean;
  }> = [];

  /**
   * Main entry point - generates the complete Excel report
   * Sheet order: Contents -> F90 Report -> Room Segments -> Hotel Total -> Department tabs
   */
  async generateReport(config: ProteaReportPackConfig, savePath: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'PS Loader';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Reset sheet registry for this report
    this.sheetRegistry = [];

    // Capture generation timestamp once for all sheets
    const now = new Date();
    this.generatedAt = now.toLocaleString('en-ZA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });

    // 1. Create F90 Report worksheet (uses Protea account movement mutation)
    await this.createF90Worksheet(workbook, config);
    this.sheetRegistry.push({ type: 'sheet', sheetName: 'F90 Report', indent: false });

    // 1b. Create Payroll worksheet (sits immediately after F90)
    await this.createPayrollWorksheet(workbook, config);
    this.sheetRegistry.push({ type: 'sheet', sheetName: 'Payroll', indent: false });

    // 2. Create Room Segments worksheet
    await this.createRoomSegmentWorksheet(workbook, config);
    this.sheetRegistry.push({ type: 'sheet', sheetName: 'Room Segments', indent: false });

    // 3. Fetch departments once -- used by department tabs
    const departments = (await db.getDepartmentsWithDataForOU(config.ou, config.version))
      .filter(d => !EXCEL_EXCLUDED_DEPARTMENTS.has(d.baseDepartment));

    // 4. Pre-fetch moved account detail data from D0480/D0490 (insurance/audit accounts
    //    that will be reported under Admin & General) AND all department-level movements.
    //    Fetched once and reused across group summary and individual department sheets.
    const [movedAccountsMonth, movedAccountsRange] = await Promise.all([
      db.getProteaGroupDepartmentDetailData(
        config.ou,
        PROTEA_MOVEMENT_SOURCE_DEPTS,
        config.selectedMonth, config.selectedYear,
        config.selectedMonth, config.selectedYear,
        config.version
      ),
      db.getProteaGroupDepartmentDetailData(
        config.ou,
        PROTEA_MOVEMENT_SOURCE_DEPTS,
        config.ytdStartMonth, config.ytdStartYear,
        config.ytdEndMonth, config.ytdEndYear,
        config.version
      )
    ]);
    const movedMonth = movedAccountsMonth.filter(r => isMovedAccount(r.account));
    const movedRange = movedAccountsRange.filter(r => isMovedAccount(r.account));

    // Pre-fetch all moved department data (D0400, D0690, etc.)
    const movedDeptData = new Map<string, { month: any[]; range: any[] }>();
    await Promise.all(PROTEA_DEPARTMENT_MOVEMENTS.map(async (mv) => {
      const [month, range] = await Promise.all([
        db.getProteaDepartmentDetailData(
          config.ou, mv.sourceDept,
          config.selectedMonth, config.selectedYear,
          config.selectedMonth, config.selectedYear,
          config.version
        ),
        db.getProteaDepartmentDetailData(
          config.ou, mv.sourceDept,
          config.ytdStartMonth, config.ytdStartYear,
          config.ytdEndMonth, config.ytdEndYear,
          config.version
        ),
      ]);
      // Filter out individually-moved accounts from department-level movement data
      // (e.g., A701603 on D0690 goes to D0410, not to D0490 with the rest of D0690)
      const filteredMonth = month.filter(r => !isMovedAccount(r.account));
      const filteredRange = range.filter(r => !isMovedAccount(r.account));
      movedDeptData.set(mv.sourceDept, { month: filteredMonth, range: filteredRange });
    }));

    // 5. Create Department worksheets (using pre-fetched departments + moved account/department data)
    await this.createDepartmentWorksheets(workbook, config, departments, movedMonth, movedRange, movedDeptData);

    // 6. Create Cover Page (last to build, positioned first via orderNo)
    this.createCoverPageWorksheet(workbook, config);

    // Save the workbook
    await workbook.xlsx.writeFile(savePath);
  }

  /**
   * Adds a title header block (report name, hotel name + month, generation timestamp) to the top of a sheet.
   * Inserts 3 rows before the existing column headers.
   */
  private addSheetTitleHeader(sheet: ExcelJS.Worksheet, config: ProteaReportPackConfig, totalCols: number, reportName: string): void {
    // Row 1: Report name
    const reportRow = sheet.addRow(new Array(totalCols).fill(''));
    reportRow.getCell(1).value = reportName;
    reportRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
    reportRow.getCell(1).alignment = { vertical: 'middle' };
    reportRow.height = 28;
    sheet.mergeCells(reportRow.number, 1, reportRow.number, totalCols);

    // Row 2: Hotel name + selected month
    const titleRow = sheet.addRow(new Array(totalCols).fill(''));
    titleRow.getCell(1).value = `${config.hotelName}  —  ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    titleRow.getCell(1).font = { bold: true, size: 13, color: { argb: 'FF1E3A5F' } };
    titleRow.getCell(1).alignment = { vertical: 'middle' };
    titleRow.height = 26;
    sheet.mergeCells(titleRow.number, 1, titleRow.number, totalCols);

    // Row 3: Generation timestamp in small grey font
    const tsRow = sheet.addRow(new Array(totalCols).fill(''));
    tsRow.getCell(1).value = `Generated: ${this.generatedAt}`;
    tsRow.getCell(1).font = { size: 8, color: { argb: 'FF999999' } };
    tsRow.getCell(1).alignment = { vertical: 'middle' };
    tsRow.height = 16;
    sheet.mergeCells(tsRow.number, 1, tsRow.number, totalCols);
  }

  /**
   * Creates the F90 P&L Report worksheet
   */
  private async createF90Worksheet(
    workbook: ExcelJS.Workbook,
    config: ProteaReportPackConfig
  ): Promise<void> {
    const sheet = workbook.addWorksheet('F90 Report', { properties: { tabColor: TAB_COLOR_REPORT } });

    // Set column widths
    sheet.columns = [
      { key: 'label', width: 45 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLyPct', width: 12 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mVsBudPct', width: 12 },
      { key: 'sep', width: 2 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLyPct', width: 12 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rVsBudPct', width: 12 },
      { key: 'comments', width: 35 },
    ];

    const TOTAL_COLS = 15;

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, TOTAL_COLS, 'F90 Report');

    // Period group headers
    const groupRow = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(9).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 7);
    sheet.mergeCells(groupRow.number, 9, groupRow.number, 14);
    applyHeaderStyle(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'P&L Line',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      '',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);

    // Select row config based on banqueting toggle
    const f90RowConfig = config.includeBanquetingBreakdown
      ? PROTEA_F90_PL_ROW_CONFIG_WITH_BANQUETING
      : PROTEA_F90_PL_ROW_CONFIG;

    // Fetch Selected Month data (with Protea account movement applied)
    // skipFilter=true: month data keeps all rows so rowId alignment with range data is preserved
    const monthDataJson = await db.getProteaF90PLData(
      config.selectedMonth,
      config.selectedYear,
      config.selectedMonth,
      config.selectedYear,
      config.ou,
      config.version,
      f90RowConfig,
      true
    );
    const monthData: PLCalculationResult[] = JSON.parse(monthDataJson);

    // Fetch YTD data (with Protea account movement applied)
    const ytdDataJson = await db.getProteaF90PLData(
      config.ytdStartMonth,
      config.ytdStartYear,
      config.ytdEndMonth,
      config.ytdEndYear,
      config.ou,
      config.version,
      f90RowConfig
    );
    const ytdData: PLCalculationResult[] = JSON.parse(ytdDataJson);

    // Route F90 below-the-line values through the EXACT SAME function INVEST
    // FACTOR OWNER SUMMARY uses (getProteaGroupDepartmentDetailData +
    // classifyAccountsByLevel20). The subtotals are then recomputed
    // arithmetically from those values. This guarantees F90 === INVEST.
    const [monthTotals, ytdTotals] = await Promise.all([
      computeInvestFactorOwnerSubgroupTotals(
        config.ou,
        config.selectedMonth, config.selectedYear,
        config.selectedMonth, config.selectedYear,
        config.version
      ),
      computeInvestFactorOwnerSubgroupTotals(
        config.ou,
        config.ytdStartMonth, config.ytdStartYear,
        config.ytdEndMonth, config.ytdEndYear,
        config.version
      ),
    ]);
    applyInvestSubgroupOverridesToF90Rows(monthData, monthTotals);
    applyInvestSubgroupOverridesToF90Rows(ytdData, ytdTotals);

    // Add data rows with month and range side by side
    this.addPLDataRows(sheet, monthData, ytdData);

    // Freeze panes (2 title rows + 2 header rows)
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];
  }

  /**
   * Creates the Payroll worksheet — mirrors F90's column layout (Selected
   * Month | YTD, with LY / vs LY % / Actuals / Budget / vs Bud / vs Bud %
   * inside each side) so users get a consistent reading experience.
   *
   * Skips the F90-specific INVEST FACTOR OWNER override pass — the Payroll
   * tab has no below-the-line section, so engine-evaluated measure values
   * are authoritative.
   */
  private async createPayrollWorksheet(
    workbook: ExcelJS.Workbook,
    config: ProteaReportPackConfig
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Payroll', { properties: { tabColor: TAB_COLOR_REPORT } });

    sheet.columns = [
      { key: 'label', width: 45 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLyPct', width: 12 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mVsBudPct', width: 12 },
      { key: 'sep', width: 2 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLyPct', width: 12 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rVsBudPct', width: 12 },
      { key: 'comments', width: 35 },
    ];

    const TOTAL_COLS = 15;

    this.addSheetTitleHeader(sheet, config, TOTAL_COLS, 'Payroll');

    const groupRow = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(9).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 7);
    sheet.mergeCells(groupRow.number, 9, groupRow.number, 14);
    applyHeaderStyle(groupRow);

    const headerRow = sheet.addRow([
      'Payroll Line',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      '',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);

    // Discover the burden lines that actually have data in this OU/period
    // across ACT/BUD/LY for both the month and the custom range, then
    // register a per-account measure for each so the engine can compute
    // side-by-side values just like the static rows did. The 3 NOT BENEFITS
    // repointed accounts ride through the same discovery — they only show
    // when they have data, exactly like any Associate Benefits account.
    // Result: no more 'Other' catch-all; every account is visible by name.
    const burdenAccounts = await db.getProteaPayrollBurdenAccounts(
      config.ou,
      config.version,
      {
        startMonth: config.selectedMonth, startYear: config.selectedYear,
        endMonth: config.selectedMonth, endYear: config.selectedYear,
      },
      {
        startMonth: config.ytdStartMonth, startYear: config.ytdStartYear,
        endMonth: config.ytdEndMonth, endYear: config.ytdEndYear,
      },
      PROTEA_PAYROLL_REPOINT_ACCOUNTS
    );
    registerProteaBurdenLineMeasures(
      burdenAccounts.map(a => a.account),
      SUB_MEASURES,
      MEASURES
    );
    const payrollRowConfig = buildProteaPayrollPLRowConfig(burdenAccounts);

    // skipFilter=true on the month query keeps rowId alignment with the YTD
    // query (same pattern as F90 — see createF90Worksheet above).
    const monthDataJson = await db.getProteaF90PLData(
      config.selectedMonth,
      config.selectedYear,
      config.selectedMonth,
      config.selectedYear,
      config.ou,
      config.version,
      payrollRowConfig,
      true
    );
    const monthData: PLCalculationResult[] = JSON.parse(monthDataJson);

    const ytdDataJson = await db.getProteaF90PLData(
      config.ytdStartMonth,
      config.ytdStartYear,
      config.ytdEndMonth,
      config.ytdEndYear,
      config.ou,
      config.version,
      payrollRowConfig
    );
    const ytdData: PLCalculationResult[] = JSON.parse(ytdDataJson);

    this.addPLDataRows(sheet, monthData, ytdData);

    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];
  }

  /**
   * Helper to add side-by-side (Selected Month | YTD) PL-style data rows to a sheet.
   * Generic across any PLRow[] config — used by F90 and Payroll worksheets.
   */
  private addPLDataRows(sheet: ExcelJS.Worksheet, monthData: PLCalculationResult[], rangeData: PLCalculationResult[]): void {
    // Build lookup map keyed by rowId so that rows align correctly even when
    // filterZeroRows removes different rows from each array.  rowId is assigned
    // sequentially from the same rowConfig, so matching IDs always refer to the
    // same P&L line.  (Using label would fail for lines like "Rooms and
    // Reservations" that appear in both Revenue and Department Profit sections.)
    const monthByRowId = new Map<number, PLCalculationResult>();
    for (const m of monthData) {
      monthByRowId.set(m.rowId, m);
    }

    // Use rangeData order as the primary driver — the range period is always a
    // superset of the month period, so its filtered row list preserves config
    // order for every row that has data in either dataset.
    const allRows: { mRow: PLCalculationResult | null; rRow: PLCalculationResult | null; primary: PLCalculationResult }[] = [];

    for (const rRow of rangeData) {
      const mRow = monthByRowId.get(rRow.rowId) || null;
      allRows.push({ mRow, rRow, primary: rRow });
    }

    for (const { mRow, rRow, primary } of allRows) {
      // Skip empty spacing rows
      if (primary.type === 'header' && !primary.label) continue;

      const indent = '  '.repeat(primary.indentLevel || 0);
      const isPercentage = primary.formatting === 'percentage';
      // 'ratio' = decimal/per-unit values (per-room-night, headcount-per-room).
      // Renders like 'number' but with 2 dp so small fractional ratios are legible.
      const isRatio = primary.formatting === 'ratio';
      const ratioDp = isRatio ? 2 : 0;

      const excelRow = sheet.addRow({
        label: indent + primary.label,
        mLy: mRow ? (isPercentage ? formatPercentage(mRow.ly) : formatNumber(mRow.ly, ratioDp)) : '',
        mVsLyPct: mRow ? (isPercentage
          ? `${((mRow.actuals ?? 0) - (mRow.ly ?? 0)).toFixed(1)} pts`
          : formatPercentage(mRow.vs_ly_pct)) : '',
        mAct: mRow ? (isPercentage ? formatPercentage(mRow.actuals) : formatNumber(mRow.actuals, ratioDp)) : '',
        mBud: mRow ? (isPercentage ? formatPercentage(mRow.budget) : formatNumber(mRow.budget, ratioDp)) : '',
        mVsBud: mRow ? (isPercentage
          ? `${((mRow.actuals ?? 0) - (mRow.budget ?? 0)).toFixed(1)} pts`
          : formatNumber(mRow.vs_bud, ratioDp)) : '',
        mVsBudPct: mRow ? (isPercentage ? '' : formatPercentage(mRow.vs_bud_pct)) : '',
        sep: '',
        rLy: rRow ? (isPercentage ? formatPercentage(rRow.ly) : formatNumber(rRow.ly, ratioDp)) : '',
        rVsLyPct: rRow ? (isPercentage
          ? `${((rRow.actuals ?? 0) - (rRow.ly ?? 0)).toFixed(1)} pts`
          : formatPercentage(rRow.vs_ly_pct)) : '',
        rAct: rRow ? (isPercentage ? formatPercentage(rRow.actuals) : formatNumber(rRow.actuals, ratioDp)) : '',
        rBud: rRow ? (isPercentage ? formatPercentage(rRow.budget) : formatNumber(rRow.budget, ratioDp)) : '',
        rVsBud: rRow ? (isPercentage
          ? `${((rRow.actuals ?? 0) - (rRow.budget ?? 0)).toFixed(1)} pts`
          : formatNumber(rRow.vs_bud, ratioDp)) : '',
        rVsBudPct: rRow ? (isPercentage ? '' : formatPercentage(rRow.vs_bud_pct)) : '',
        comments: ''
      });

      // Apply styling — borders + bold for totals (no fills), light blue on section headers
      if (primary.type === 'header' && primary.label) {
        const hasData = primary.actuals !== null;
        excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          cell.font = { size: 10, bold: true };
          if (!hasData) cell.fill = CATEGORY_HEADER_FILL;
          cell.border = primary.indentLevel === 0 && hasData
            ? CATEGORY_TOTAL_BORDER
            : primary.indentLevel > 0 && hasData
              ? GROUP_SUBTOTAL_BORDER
              : BORDER_STYLE;
          cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
        });
      } else {
        applyDataRowStyle(excelRow, false);
      }

      // Style separator column
      const sepCell = excelRow.getCell(8);
      sepCell.fill = SEPARATOR_FILL;
      sepCell.value = '';

      // Apply number formatting to both sides
      if (!isPercentage) {
        const numFmt = isRatio ? '#,##0.00' : '#,##0';
        [2, 4, 5, 6, 9, 11, 12, 13].forEach(col => {
          const cell = excelRow.getCell(col);
          if (typeof cell.value === 'number') {
            cell.numFmt = numFmt;
          }
        });
      }
    }
  }

  /**
   * Creates department worksheets grouped by level_7.
   * Multi-department groups get a summary sheet followed by individual detail sheets.
   * Single-department groups get only their detail sheet.
   */
  private async createDepartmentWorksheets(
    workbook: ExcelJS.Workbook,
    config: ProteaReportPackConfig,
    departments: Array<{ baseDepartment: string; departmentName: string; level7Group: string | null }>,
    movedMonth: any[] = [],
    movedRange: any[] = [],
    movedDeptData: Map<string, { month: any[]; range: any[] }> = new Map()
  ): Promise<void> {
    // Group departments by level_7 (banqueting depts reclassified when toggle is on)
    const groupMap = new Map<string, typeof departments>();
    for (const dept of departments) {
      let groupKey = dept.level7Group || dept.baseDepartment;
      if (config.includeBanquetingBreakdown && BANQUETING_DEPARTMENTS.has(dept.baseDepartment)) {
        groupKey = 'Total Banqueting';
      }
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, []);
      }
      groupMap.get(groupKey)!.push(dept);
    }

    // Sort groups: prioritised groups first (in defined order), then remaining alphabetically
    const sortedGroups = [...groupMap.entries()].sort((a, b) => {
      const idxA = PROTEA_GROUP_DISPLAY_ORDER.indexOf(a[0]);
      const idxB = PROTEA_GROUP_DISPLAY_ORDER.indexOf(b[0]);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a[0].localeCompare(b[0]);
    });

    // Track used sheet names to avoid duplicates
    const usedSheetNames = new Set<string>();

    // Iterate groups: summary sheet first (if multi-dept), then individual sheets
    for (const [groupName, groupDepts] of sortedGroups) {
      // Skip group entirely if it only contains moved departments
      const nonMovedDepts = groupDepts.filter(d => !MOVED_DEPT_SET.has(d.baseDepartment));
      if (nonMovedDepts.length === 0 && !MOVEMENT_TARGET_GROUPS.has(groupName)) continue;

      const isMultiDeptGroup = groupDepts.length > 1;

      // Register group header in TOC for every group (including singletons)
      this.sheetRegistry.push({ type: 'groupHeader', sheetName: '', groupName, indent: false });

      if (isMultiDeptGroup) {
        // Create group summary sheet for multi-department groups
        const summaryNames = await this.createGroupSummaryWorksheet(
          workbook, config, groupName, groupDepts, usedSheetNames, movedMonth, movedRange, movedDeptData
        );
        for (const name of summaryNames) {
          this.sheetRegistry.push({ type: 'sheet', sheetName: name, indent: true });
        }

        // Create individual department detail sheets (only when detail tabs enabled)
        if (config.generateDetailTabs) {
          for (const dept of groupDepts) {
            // Suppress moved department detail tabs — their accounts are merged into their target group
            if (MOVED_DEPT_SET.has(dept.baseDepartment)) continue;

            const deptSheetName = await this.createSingleDepartmentWorksheet(
              workbook, config, dept, usedSheetNames, undefined, movedMonth, movedRange, movedDeptData
            );
            if (deptSheetName) {
              this.sheetRegistry.push({ type: 'sheet', sheetName: deptSheetName, indent: true });
            }
          }
        }
      } else {
        // Singleton group: always create summary sheet
        const dept = groupDepts[0];

        // Group summary sheet (uses same data as the single dept)
        const summaryNames = await this.createGroupSummaryWorksheet(
          workbook, config, groupName, groupDepts, usedSheetNames, movedMonth, movedRange, movedDeptData
        );
        for (const name of summaryNames) {
          this.sheetRegistry.push({ type: 'sheet', sheetName: name, indent: true });
        }

        // Individual department detail sheet (only when detail tabs enabled)
        if (config.generateDetailTabs) {
          // Suppress moved department detail tabs — their accounts are merged into their target group
          if (!MOVED_DEPT_SET.has(dept.baseDepartment)) {
            const deptSheetName = await this.createSingleDepartmentWorksheet(
              workbook, config, dept, usedSheetNames, undefined, movedMonth, movedRange, movedDeptData
            );
            if (deptSheetName) {
              this.sheetRegistry.push({ type: 'sheet', sheetName: deptSheetName, indent: true });
            }
          }
        }
      }
    }
  }

  /**
   * Creates a summary worksheet that aggregates data across all departments in a group
   */
  private async createGroupSummaryWorksheet(
    workbook: ExcelJS.Workbook,
    config: ProteaReportPackConfig,
    groupName: string,
    groupDepts: Array<{ baseDepartment: string; departmentName: string; level7Group: string | null }>,
    usedSheetNames: Set<string>,
    movedMonth: any[] = [],
    movedRange: any[] = [],
    movedDeptData: Map<string, { month: any[]; range: any[] }> = new Map()
  ): Promise<string[]> {
    const deptIds = groupDepts.map(d => d.baseDepartment);

    // --- Protea department movement: exclude ALL moved depts from base query ---
    // Moved dept data is pre-fetched separately and merged into their target groups below.
    // Always exclude to prevent duplication when a dept's native group matches its target group.
    let effectiveDeptIds = deptIds.filter(id => !MOVED_DEPT_SET.has(id));
    if (effectiveDeptIds.length === 0 && !MOVEMENT_TARGET_GROUPS.has(groupName)) {
      // All depts were moved out and this isn't a target group — suppress entirely
      return [];
    }

    // Fetch aggregated data for the group (month + range in parallel)
    let [monthDetailData, rangeDetailData] = await Promise.all([
      db.getProteaGroupDepartmentDetailData(
        config.ou,
        effectiveDeptIds,
        config.selectedMonth,
        config.selectedYear,
        config.selectedMonth,
        config.selectedYear,
        config.version
      ),
      db.getProteaGroupDepartmentDetailData(
        config.ou,
        effectiveDeptIds,
        config.ytdStartMonth,
        config.ytdStartYear,
        config.ytdEndMonth,
        config.ytdEndYear,
        config.version
      )
    ]);

    // --- Protea account movement: adjust group summary data ---
    const groupContainsSourceDept = effectiveDeptIds.some(id => PROTEA_MOVEMENT_SOURCE_DEPTS.includes(id));

    if (groupContainsSourceDept) {
      // Remove moved accounts from source department groups (D0480/D0490)
      monthDetailData = monthDetailData.filter(r => !isMovedAccount(r.account));
      rangeDetailData = rangeDetailData.filter(r => !isMovedAccount(r.account));
    }

    // Merge moved account-level data (A730/A745) into Admin & General
    if (groupName === 'Administrative & General') {
      monthDetailData = [...monthDetailData, ...movedMonth];
      rangeDetailData = [...rangeDetailData, ...movedRange];
    }

    // Merge moved department data into their respective target groups
    const isInvestGroup = groupName === 'Invest Factor Owner';

    for (const mv of PROTEA_DEPARTMENT_MOVEMENTS) {
      if (mv.targetGroup === groupName) {
        const data = movedDeptData.get(mv.sourceDept);
        if (data) {
          monthDetailData = [...monthDetailData, ...data.month];
          rangeDetailData = [...rangeDetailData, ...data.range];
        }
      }
    }

    // Aggregate duplicate accounts that may result from merging moved department data
    monthDetailData = aggregateDuplicateAccounts(monthDetailData);
    rangeDetailData = aggregateDuplicateAccounts(rangeDetailData);

    if (rangeDetailData.length === 0 && monthDetailData.length === 0) {
      return [];
    }

    // Suppress accounts that are zero across actuals/budget/ly in BOTH month AND range.
    // Only remove if zero in all datasets so no period column ever loses a row that another keeps.
    { const accountsWithData = new Set<string>();
      for (const row of [...monthDetailData, ...rangeDetailData]) {
        if ((row.actuals !== null && row.actuals !== 0) ||
            (row.budget !== null && row.budget !== 0) ||
            (row.ly !== null && row.ly !== 0)) {
          accountsWithData.add(row.account);
        }
      }
      monthDetailData = monthDetailData.filter((r: any) => accountsWithData.has(r.account));
      rangeDetailData = rangeDetailData.filter((r: any) => accountsWithData.has(r.account));
    }

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
    const totalCols = 15;

    sheet.columns = [
      { key: 'account', width: 45 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLyPct', width: 12 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mVsBudPct', width: 12 },
      { key: 'sep', width: 2 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLyPct', width: 12 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rVsBudPct', width: 12 },
      { key: 'comments', width: 35 },
    ];

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, totalCols, proteaRenameLabel(groupName));

    // Period group headers
    const groupRow = sheet.addRow(new Array(totalCols).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(9).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 7);
    sheet.mergeCells(groupRow.number, 9, groupRow.number, 14);
    applyHeaderStyle(groupRow);
    this.styleDeptSeparator(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'Account',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      '',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);
    this.styleDeptSeparator(headerRow);

    // Combined month + range data (side by side)
    const STATS_KEEP_GROUPS = new Set(['Total Food & Beverage', 'Total Banqueting', 'Utilities Dept']);
    const keepStats = STATS_KEEP_GROUPS.has(groupName);
    const isRoomsGroup = groupName === 'Rooms and Reservation';
    this.addDepartmentDataSection(sheet, monthDetailData, rangeDetailData, totalCols, undefined, {
      collapseRevenueDetail: !config.generateDetailTabs && isRoomsGroup,
      suppressStats: !keepStats,
      showDeptProfit: keepStats,
      flattenCategories: !isInvestGroup ? ['Payroll', 'Controllables'] : undefined,
      customSubgroups: isInvestGroup ? INVEST_CUSTOM_SUBGROUPS : undefined,
      hideSubgroupNames: isInvestGroup ? ['Fixed Expenses'] : undefined,
    });

    // Department-specific KPIs (after department profit) — computed via F90 engine
    if (isRoomsGroup) {
      const [monthKpi, rangeKpi] = await this.fetchKpiEngineData(config, ROOMS_KPI_CONFIG);
      this.addRoomsKpiRows(sheet, monthDetailData, rangeDetailData, totalCols, monthKpi, rangeKpi);
    } else if (groupName === 'Total Food & Beverage') {
      const [monthKpi, rangeKpi] = await this.fetchKpiEngineData(config, FB_KPI_CONFIG);
      this.addFbKpiRows(sheet, monthDetailData, rangeDetailData, totalCols, monthKpi, rangeKpi);
    } else {
      // % of Hotel Revenue block — fires for A&G, POM, S&M (any group
      // registered in PCT_OF_REVENUE_KPI_GROUPS).
      const pctRevConfig = PCT_OF_REVENUE_KPI_GROUPS.get(groupName);
      if (pctRevConfig) {
        const [monthKpi, rangeKpi] = await this.fetchKpiEngineData(config, pctRevConfig);
        this.addPctOfRevenueKpiRows(sheet, totalCols, monthKpi, rangeKpi);
      }
    }

    // Freeze panes (2 title rows + 2 header rows)
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];

    if (isInvestGroup) {
      const fixedExpName = this.createInvestFixedExpensesSheet(workbook, config, monthDetailData, rangeDetailData, usedSheetNames);
      return fixedExpName ? [finalName, fixedExpName] : [finalName];
    }

    return [finalName];
  }

  private createInvestFixedExpensesSheet(
    workbook: ExcelJS.Workbook,
    config: ProteaReportPackConfig,
    monthDetailData: any[],
    rangeDetailData: any[],
    usedSheetNames: Set<string>
  ): string | null {
    const fixedExpSubgroups = INVEST_CUSTOM_SUBGROUPS.filter(sg => sg.name === 'Fixed Expenses');
    const totalCols = 15;

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

    sheet.columns = [
      { key: 'account', width: 45 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLyPct', width: 12 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mVsBudPct', width: 12 },
      { key: 'sep', width: 2 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLyPct', width: 12 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rVsBudPct', width: 12 },
      { key: 'comments', width: 35 },
    ];

    this.addSheetTitleHeader(sheet, config, totalCols, 'Fixed Expenses');

    const groupRow = sheet.addRow(new Array(totalCols).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(9).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 7);
    sheet.mergeCells(groupRow.number, 9, groupRow.number, 14);
    applyHeaderStyle(groupRow);
    this.styleDeptSeparator(groupRow);

    const headerRow = sheet.addRow([
      'Account',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      '',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);
    this.styleDeptSeparator(headerRow);

    this.addDepartmentDataSection(sheet, monthDetailData, rangeDetailData, totalCols, undefined, {
      suppressStats: true,
      customSubgroups: fixedExpSubgroups,
    });

    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];
    return finalName;
  }

  /**
   * Creates a single department detail worksheet with account-level data
   */
  private async createSingleDepartmentWorksheet(
    workbook: ExcelJS.Workbook,
    config: ProteaReportPackConfig,
    dept: { baseDepartment: string; departmentName: string; level7Group: string | null },
    usedSheetNames: Set<string>,
    nameOverride?: string,
    movedMonth: any[] = [],
    movedRange: any[] = [],
    movedDeptData: Map<string, { month: any[]; range: any[] }> = new Map()
  ): Promise<string | null> {
    let [monthDetailData, rangeDetailData] = await Promise.all([
      db.getProteaDepartmentDetailData(
        config.ou,
        dept.baseDepartment,
        config.selectedMonth,
        config.selectedYear,
        config.selectedMonth,
        config.selectedYear,
        config.version
      ),
      db.getProteaDepartmentDetailData(
        config.ou,
        dept.baseDepartment,
        config.ytdStartMonth,
        config.ytdStartYear,
        config.ytdEndMonth,
        config.ytdEndYear,
        config.version
      )
    ]);

    // Protea account movement: filter out moved accounts from D0480/D0490 individual sheets
    if (PROTEA_MOVEMENT_SOURCE_DEPTS.includes(dept.baseDepartment)) {
      monthDetailData = monthDetailData.filter(r => !isMovedAccount(r.account));
      rangeDetailData = rangeDetailData.filter(r => !isMovedAccount(r.account));
    }

    // Protea movement: merge moved accounts (A730/A745/A701603) into D0410 detail sheet
    let movedAccountSources: Map<string, string> | undefined;
    if (dept.baseDepartment === 'D0410') {
      monthDetailData = [...monthDetailData, ...movedMonth];
      rangeDetailData = [...rangeDetailData, ...movedRange];
      movedAccountSources = new Map<string, string>();
      for (const row of movedMonth) movedAccountSources.set(row.account, 'D0480/D0490/D0690');
      for (const row of movedRange) movedAccountSources.set(row.account, 'D0480/D0490/D0690');
    }

    // Protea department movement: merge moved department data into their detail merge targets
    const incomingMovements = PROTEA_DEPARTMENT_MOVEMENTS.filter(
      mv => mv.detailMergeTarget === dept.baseDepartment
    );
    const isInvestDetail = dept.baseDepartment === 'D0490' && incomingMovements.length > 0;

    if (incomingMovements.length > 0) {
      if (!movedAccountSources) movedAccountSources = new Map<string, string>();
      for (const mv of incomingMovements) {
        const data = movedDeptData.get(mv.sourceDept);
        if (data) {
          monthDetailData = [...monthDetailData, ...data.month];
          rangeDetailData = [...rangeDetailData, ...data.range];
          for (const row of data.month) movedAccountSources.set(row.account, mv.sourceDept);
          for (const row of data.range) movedAccountSources.set(row.account, mv.sourceDept);
        }
      }
    }

    // Aggregate duplicate accounts that may result from merging moved department data
    monthDetailData = aggregateDuplicateAccounts(monthDetailData);
    rangeDetailData = aggregateDuplicateAccounts(rangeDetailData);

    if (rangeDetailData.length === 0 && monthDetailData.length === 0) {
      return null;
    }

    // Suppress accounts that are zero across actuals/budget/ly in BOTH month AND range.
    { const accountsWithData = new Set<string>();
      for (const row of [...monthDetailData, ...rangeDetailData]) {
        if ((row.actuals !== null && row.actuals !== 0) ||
            (row.budget !== null && row.budget !== 0) ||
            (row.ly !== null && row.ly !== 0)) {
          accountsWithData.add(row.account);
        }
      }
      monthDetailData = monthDetailData.filter((r: any) => accountsWithData.has(r.account));
      rangeDetailData = rangeDetailData.filter((r: any) => accountsWithData.has(r.account));
    }

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
    const totalCols = 15;

    sheet.columns = [
      { key: 'account', width: 45 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLyPct', width: 12 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mVsBudPct', width: 12 },
      { key: 'sep', width: 2 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLyPct', width: 12 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rVsBudPct', width: 12 },
      { key: 'comments', width: 35 },
    ];

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, totalCols, proteaRenameLabel(nameOverride || dept.departmentName));

    // Period group headers
    const groupRow = sheet.addRow(new Array(totalCols).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(9).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 7);
    sheet.mergeCells(groupRow.number, 9, groupRow.number, 14);
    applyHeaderStyle(groupRow);
    this.styleDeptSeparator(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'Account',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      '',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);
    this.styleDeptSeparator(headerRow);

    // Combined month + range data (side by side), with optional moved-account annotations
    this.addDepartmentDataSection(sheet, monthDetailData, rangeDetailData, totalCols, movedAccountSources, {
      customSubgroups: isInvestDetail ? INVEST_CUSTOM_SUBGROUPS : undefined,
    });

    // Freeze panes (2 title rows + 2 header rows)
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];

    return finalName;
  }

  /**
   * Creates the cover page / table of contents worksheet.
   * Built last (all sheet names are known), repositioned first via orderNo.
   */
  private createCoverPageWorksheet(
    workbook: ExcelJS.Workbook,
    config: ProteaReportPackConfig
  ): void {
    const sheet = workbook.addWorksheet('Contents');

    // Position as the first sheet by setting orderNo to 0
    // (all other sheets have orderNo >= 1 from auto-increment)
    (sheet as any).orderNo = 0;

    sheet.columns = [
      { key: 'label', width: 55 },
    ];

    // --- Header section ---
    const titleRow = sheet.getRow(1);
    titleRow.getCell(1).value = config.hotelName;
    titleRow.getCell(1).font = { bold: true, size: 18, color: { argb: 'FF1E3A5F' } };
    titleRow.height = 30;

    const reportRow = sheet.getRow(2);
    reportRow.getCell(1).value = 'F90 P&L Report';
    reportRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF4A4A4A' } };

    const periodRow = sheet.getRow(3);
    periodRow.getCell(1).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    periodRow.getCell(1).font = { size: 11, color: { argb: 'FF666666' } };

    const rangeRow = sheet.getRow(4);
    rangeRow.getCell(1).value = getRangeLabel(
      config.ytdStartMonth, config.ytdStartYear,
      config.ytdEndMonth, config.ytdEndYear
    );
    rangeRow.getCell(1).font = { size: 11, color: { argb: 'FF666666' } };

    const versionRow = sheet.getRow(5);
    versionRow.getCell(1).value = `Version: ${config.version}`;
    versionRow.getCell(1).font = { size: 11, color: { argb: 'FF666666' } };

    // Row 7: TOC header (row 6 is blank spacer)
    const tocHeader = sheet.getRow(7);
    tocHeader.getCell(1).value = 'Table of Contents';
    tocHeader.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
    tocHeader.getCell(1).border = { bottom: { style: 'medium', color: { argb: 'FF1E3A5F' } } };

    // --- TOC entries ---
    let currentRow = 9; // start after a blank spacer row

    for (const entry of this.sheetRegistry) {
      const row = sheet.getRow(currentRow);

      if (entry.type === 'groupHeader') {
        // Uppercase bold group name (not a hyperlink)
        row.getCell(1).value = proteaRenameLabel(entry.groupName || '').toUpperCase();
        row.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF1E3A5F' } };
        row.height = 22;
      } else {
        // Hyperlinked sheet name (indented for department sheets)
        const indent = entry.indent ? '    ' : '';
        const displayText = `${indent}${entry.sheetName}`;
        row.getCell(1).value = {
          text: displayText,
          hyperlink: `#'${entry.sheetName}'!A1`
        } as any;
        row.getCell(1).font = {
          size: 10,
          color: { argb: 'FF0563C1' },
          underline: true
        };
      }
      currentRow++;
    }
  }

  // proteaRenameLabel is now imported from proteaShared.ts

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

  /**
   * Renders Department Profit and GOP % summary rows.
   * For revenue departments: shows profit and profit margin.
   * For non-revenue departments (e.g. Admin & General): shows a simple total.
   */
  private addDeptProfitRows(
    sheet: ExcelJS.Worksheet,
    monthData: any[],
    rangeData: any[],
    sumField: (rows: any[], field: string) => number,
    ABS_COLS: number[],
    totalCols: number
  ): void {
    const mRevenueRows = monthData.filter(r => r.category === 'Revenue');
    const rRevenueRows = rangeData.filter(r => r.category === 'Revenue');
    const expenseCategories = ['Cost of Sales', 'Payroll', 'Controllables', 'Other'];
    const mExpenseRows = monthData.filter(r => expenseCategories.includes(r.category));
    const rExpenseRows = rangeData.filter(r => expenseCategories.includes(r.category));

    const applySubtotalStyle = (row: ExcelJS.Row) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = SUBTOTAL_FILL;
        cell.font = { ...DATA_FONT, bold: true };
        cell.border = TOTAL_ROW_BORDER;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(row);
    };

    const pct = (num: number, denom: number) => denom !== 0 ? (num / Math.abs(denom)) * 100 : 0;

    if (mRevenueRows.length > 0 || rRevenueRows.length > 0) {
      const mRevAct = sumField(mRevenueRows, 'actuals');
      const mRevBud = sumField(mRevenueRows, 'budget');
      const mRevLy = sumField(mRevenueRows, 'ly');
      const mExpAct = sumField(mExpenseRows, 'actuals');
      const mExpBud = sumField(mExpenseRows, 'budget');
      const mExpLy = sumField(mExpenseRows, 'ly');
      const mProfitAct = -(mRevAct + mExpAct);
      const mProfitBud = -(mRevBud + mExpBud);
      const mProfitLy = -(mRevLy + mExpLy);

      const rRevAct = sumField(rRevenueRows, 'actuals');
      const rRevBud = sumField(rRevenueRows, 'budget');
      const rRevLy = sumField(rRevenueRows, 'ly');
      const rExpAct = sumField(rExpenseRows, 'actuals');
      const rExpBud = sumField(rExpenseRows, 'budget');
      const rExpLy = sumField(rExpenseRows, 'ly');
      const rProfitAct = -(rRevAct + rExpAct);
      const rProfitBud = -(rRevBud + rExpBud);
      const rProfitLy = -(rRevLy + rExpLy);

      const mProfitVsBud = mProfitAct - mProfitBud;
      const mProfitVsLy = mProfitAct - mProfitLy;
      const rProfitVsBud = rProfitAct - rProfitBud;
      const rProfitVsLy = rProfitAct - rProfitLy;

      // Department Profit row
      const profitRow = sheet.addRow({
        account: 'Department Profit',
        mLy: formatNumber(mProfitLy),
        mVsLyPct: formatPercentage(pct(mProfitVsLy, mProfitLy)),
        mAct: formatNumber(mProfitAct), mBud: formatNumber(mProfitBud),
        mVsBud: formatNumber(mProfitVsBud),
        mVsBudPct: formatPercentage(pct(mProfitVsBud, mProfitBud)),
        sep: '',
        rLy: formatNumber(rProfitLy),
        rVsLyPct: formatPercentage(pct(rProfitVsLy, rProfitLy)),
        rAct: formatNumber(rProfitAct), rBud: formatNumber(rProfitBud),
        rVsBud: formatNumber(rProfitVsBud),
        rVsBudPct: formatPercentage(pct(rProfitVsBud, rProfitBud)),
        comments: ''
      });
      applySubtotalStyle(profitRow);
      ABS_COLS.forEach(col => {
        const cell = profitRow.getCell(col);
        if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      });

      // GOP % row
      const mRevTotal = -mRevAct;
      const mGopAct = mRevTotal !== 0 ? (mProfitAct / mRevTotal) * 100 : 0;
      const mGopBud = -mRevBud !== 0 ? (mProfitBud / -mRevBud) * 100 : 0;
      const mGopLy = -mRevLy !== 0 ? (mProfitLy / -mRevLy) * 100 : 0;
      const rRevTotal = -rRevAct;
      const rGopAct = rRevTotal !== 0 ? (rProfitAct / rRevTotal) * 100 : 0;
      const rGopBud = -rRevBud !== 0 ? (rProfitBud / -rRevBud) * 100 : 0;
      const rGopLy = -rRevLy !== 0 ? (rProfitLy / -rRevLy) * 100 : 0;

      const gopRow = sheet.addRow({
        account: 'Department Profit %',
        mLy: formatPercentage(mGopLy),
        mVsLyPct: `${(mGopAct - mGopLy).toFixed(1)} pts`,
        mAct: formatPercentage(mGopAct), mBud: formatPercentage(mGopBud),
        mVsBud: `${(mGopAct - mGopBud).toFixed(1)} pts`,
        mVsBudPct: '',
        sep: '',
        rLy: formatPercentage(rGopLy),
        rVsLyPct: `${(rGopAct - rGopLy).toFixed(1)} pts`,
        rAct: formatPercentage(rGopAct), rBud: formatPercentage(rGopBud),
        rVsBud: `${(rGopAct - rGopBud).toFixed(1)} pts`,
        rVsBudPct: '',
        comments: ''
      });
      applySubtotalStyle(gopRow);
    } else if (monthData.length > 0 || rangeData.length > 0) {
      // Non-revenue departments (e.g. Admin & General): simple Total row
      const mAllRows = monthData.filter(r => r.category !== 'Stats');
      const rAllRows = rangeData.filter(r => r.category !== 'Stats');
      const mTotAct = sumField(mAllRows, 'actuals');
      const mTotBud = sumField(mAllRows, 'budget');
      const mTotLy  = sumField(mAllRows, 'ly');
      const rTotAct = sumField(rAllRows, 'actuals');
      const rTotBud = sumField(rAllRows, 'budget');
      const rTotLy  = sumField(rAllRows, 'ly');

      const mTotVsBud = mTotAct - mTotBud;
      const mTotVsLy = mTotAct - mTotLy;
      const rTotVsBud = rTotAct - rTotBud;
      const rTotVsLy = rTotAct - rTotLy;

      const totalRow = sheet.addRow({
        account: 'Total',
        mLy: formatNumber(mTotLy),
        mVsLyPct: formatPercentage(pct(mTotVsLy, mTotLy)),
        mAct: formatNumber(mTotAct), mBud: formatNumber(mTotBud),
        mVsBud: formatNumber(mTotVsBud),
        mVsBudPct: formatPercentage(pct(mTotVsBud, mTotBud)),
        sep: '',
        rLy: formatNumber(rTotLy),
        rVsLyPct: formatPercentage(pct(rTotVsLy, rTotLy)),
        rAct: formatNumber(rTotAct), rBud: formatNumber(rTotBud),
        rVsBud: formatNumber(rTotVsBud),
        rVsBudPct: formatPercentage(pct(rTotVsBud, rTotBud)),
        comments: ''
      });
      applySubtotalStyle(totalRow);
      ABS_COLS.forEach(col => {
        const cell = totalRow.getCell(col);
        if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      });
    }
  }

  /**
   * Renders Rooms & Reservation KPIs after Department Profit on the group summary sheet.
   * KPIs: Occupancy%, ADR, RevPAR, RevPAR after TAC, then Per Room Night Sold metrics.
   */
  /**
   * Fetches KPI values via the F90 calculation engine for both month and range periods.
   * Returns a Map<label, PLCalculationResult> for each period.
   */
  private async fetchKpiEngineData(
    config: ProteaReportPackConfig,
    kpiConfig: PLRow[]
  ): Promise<[Map<string, PLCalculationResult>, Map<string, PLCalculationResult>]> {
    const [monthJson, rangeJson] = await Promise.all([
      db.getProteaF90PLData(
        config.selectedMonth, config.selectedYear,
        config.selectedMonth, config.selectedYear,
        config.ou, config.version, kpiConfig
      ),
      db.getProteaF90PLData(
        config.ytdStartMonth, config.ytdStartYear,
        config.ytdEndMonth, config.ytdEndYear,
        config.ou, config.version, kpiConfig
      )
    ]);
    const toMap = (json: string) => {
      const rows: PLCalculationResult[] = JSON.parse(json);
      const map = new Map<string, PLCalculationResult>();
      for (const row of rows) if (row.type === 'measure') map.set(row.label, row);
      return map;
    };
    return [toMap(monthJson), toMap(rangeJson)];
  }

  private addRoomsKpiRows(
    sheet: ExcelJS.Worksheet,
    monthData: any[],
    rangeData: any[],
    totalCols: number,
    monthKpi: Map<string, PLCalculationResult> = new Map(),
    rangeKpi: Map<string, PLCalculationResult> = new Map()
  ): void {
    const pct = (num: number, denom: number) => denom !== 0 ? (num / Math.abs(denom)) * 100 : 0;

    // Helper: get engine KPI value (returns actuals/budget/ly from the calculation engine)
    const kv = (kpi: Map<string, PLCalculationResult>, label: string) => kpi.get(label);

    // Helper: get a single account's value from the raw dataset.
    // Retained for the inline RevPAR-after-TAC TAC lookup (A608201) below;
    // the cents-per-room-night and equipment-usage values now flow through the
    // engine measures defined in plMeasureDefinitions.ts.
    const acctVal = (data: any[], account: string, field: string): number => {
      const row = data.find((r: any) => r.account === account);
      return row ? (Number(row[field]) || 0) : 0;
    };

    // Get engine-computed values for key KPIs
    const mOcc = kv(monthKpi, 'Occupancy %');
    const rOcc = kv(rangeKpi, 'Occupancy %');
    const mAdr = kv(monthKpi, 'ADR');
    const rAdr = kv(rangeKpi, 'ADR');
    const mRevpar = kv(monthKpi, 'RevPAR');
    const rRevpar = kv(rangeKpi, 'RevPAR');
    const mTotal = kv(monthKpi, 'Rooms Available');
    const rTotal = kv(rangeKpi, 'Rooms Available');
    const mRev = kv(monthKpi, 'Rooms Revenue');
    const rRev = kv(rangeKpi, 'Rooms Revenue');

    // Safe division
    const div = (num: number, denom: number) => denom !== 0 ? num / denom : 0;

    // Style helpers
    const applyKpiHeaderStyle = (row: ExcelJS.Row) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = SUBTOTAL_FILL;
        cell.font = { ...DATA_FONT, bold: true };
        cell.border = BORDER_STYLE;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(row);
    };

    const applyKpiDataStyle = (row: ExcelJS.Row) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = DATA_FONT;
        cell.border = BORDER_STYLE;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(row);
    };

    // Helper: add a KPI row with percentage format
    const addPctKpiRow = (label: string, mAct: number, mBud: number, mLy: number, rAct: number, rBud: number, rLy: number) => {
      const row = sheet.addRow({
        account: `  ${label}`,
        mLy: formatPercentage(mLy), mVsLyPct: `${(mAct - mLy).toFixed(1)} pts`,
        mAct: formatPercentage(mAct), mBud: formatPercentage(mBud),
        mVsBud: `${(mAct - mBud).toFixed(1)} pts`, mVsBudPct: '',
        sep: '',
        rLy: formatPercentage(rLy), rVsLyPct: `${(rAct - rLy).toFixed(1)} pts`,
        rAct: formatPercentage(rAct), rBud: formatPercentage(rBud),
        rVsBud: `${(rAct - rBud).toFixed(1)} pts`, rVsBudPct: '',
        comments: ''
      });
      applyKpiDataStyle(row);
    };

    // Helper: add a KPI row with number format (ADR, RevPAR, cents-per-room)
    const addNumKpiRow = (label: string, mAct: number, mBud: number, mLy: number, rAct: number, rBud: number, rLy: number, decimals: number = 0) => {
      const mVsBud = mAct - mBud;
      const mVsLy = mAct - mLy;
      const rVsBud = rAct - rBud;
      const rVsLy = rAct - rLy;
      const row = sheet.addRow({
        account: `  ${label}`,
        mLy: formatNumber(mLy, decimals), mVsLyPct: formatPercentage(pct(mVsLy, mLy)),
        mAct: formatNumber(mAct, decimals), mBud: formatNumber(mBud, decimals),
        mVsBud: formatNumber(mVsBud, decimals), mVsBudPct: formatPercentage(pct(mVsBud, mBud)),
        sep: '',
        rLy: formatNumber(rLy, decimals), rVsLyPct: formatPercentage(pct(rVsLy, rLy)),
        rAct: formatNumber(rAct, decimals), rBud: formatNumber(rBud, decimals),
        rVsBud: formatNumber(rVsBud, decimals), rVsBudPct: formatPercentage(pct(rVsBud, rBud)),
        comments: ''
      });
      applyKpiDataStyle(row);
    };

    // Helper: render a KPI from engine-computed PLCalculationResult.
    // `decimals` only applies when isPct=false (pct rows always render as
    // formatted percentages with 1-decimal pts variances).
    const addEngineKpiRow = (label: string, mResult: PLCalculationResult | undefined, rResult: PLCalculationResult | undefined, isPct: boolean, decimals: number = 0) => {
      if (isPct) {
        addPctKpiRow(label,
          mResult?.actuals || 0, mResult?.budget || 0, mResult?.ly || 0,
          rResult?.actuals || 0, rResult?.budget || 0, rResult?.ly || 0);
      } else {
        addNumKpiRow(label,
          mResult?.actuals || 0, mResult?.budget || 0, mResult?.ly || 0,
          rResult?.actuals || 0, rResult?.budget || 0, rResult?.ly || 0, decimals);
      }
    };

    // --- Blank separator ---
    this.addBlankSeparatorRow(sheet, totalCols);

    // --- Occupancy % (from engine) ---
    addEngineKpiRow('Occupancy %', mOcc, rOcc, true);

    // --- ADR (from engine) ---
    addEngineKpiRow('ADR', mAdr, rAdr, false);

    // --- RevPAR (from engine) ---
    addEngineKpiRow('RevPAR', mRevpar, rRevpar, false);

    // --- RevPAR after TAC (computed from engine revenue + raw TAC data) ---
    if (mRev && rRev && mTotal && rTotal) {
      const acctValRaw = (data: any[], account: string, field: string): number => {
        const row = data.find((r: any) => r.account === account);
        return row ? (Number(row[field]) || 0) : 0;
      };
      const mTac = acctValRaw(monthData, 'A608201', 'actuals');
      const mTacBud = acctValRaw(monthData, 'A608201', 'budget');
      const mTacLy = acctValRaw(monthData, 'A608201', 'ly');
      const rTac = acctValRaw(rangeData, 'A608201', 'actuals');
      const rTacBud = acctValRaw(rangeData, 'A608201', 'budget');
      const rTacLy = acctValRaw(rangeData, 'A608201', 'ly');
      addNumKpiRow('RevPAR after TAC',
        div((mRev.actuals || 0) - mTac, mTotal.actuals || 0), div((mRev.budget || 0) - mTacBud, mTotal.budget || 0), div((mRev.ly || 0) - mTacLy, mTotal.ly || 0),
        div((rRev.actuals || 0) - rTac, rTotal.actuals || 0), div((rRev.budget || 0) - rTacBud, rTotal.budget || 0), div((rRev.ly || 0) - rTacLy, rTotal.ly || 0));
    }

    // --- Bed-night & guest-rate KPIs (engine-computed) ---
    addEngineKpiRow('Bed Nights Sold',         kv(monthKpi, 'Bed Nights Sold'),         kv(rangeKpi, 'Bed Nights Sold'),         false);
    addEngineKpiRow('Bed Nights Available',    kv(monthKpi, 'Bed Nights Available'),    kv(rangeKpi, 'Bed Nights Available'),    false);
    addEngineKpiRow('Average Bed Occupancy %', kv(monthKpi, 'Average Bed Occupancy %'), kv(rangeKpi, 'Average Bed Occupancy %'), true);
    addEngineKpiRow('Average Guest Rate',      kv(monthKpi, 'Average Guest Rate'),      kv(rangeKpi, 'Average Guest Rate'),      false);
    addEngineKpiRow('Double Occupancy %',      kv(monthKpi, 'Double Occupancy %'),      kv(rangeKpi, 'Double Occupancy %'),      true);

    // --- Per-day availability (engine-computed; periodDays is plumbed in by
    //     getProteaF90PLData per its month/range call) ---
    addEngineKpiRow('Rooms Available per Day',
      kv(monthKpi, 'Rooms Available per Day'),
      kv(rangeKpi, 'Rooms Available per Day'), false);
    addEngineKpiRow('Bed Available per Day',
      kv(monthKpi, 'Bed Available per Day'),
      kv(rangeKpi, 'Bed Available per Day'), false);

    // --- Per Room Night Sold (engine-driven dollars-per-sold-room — see
    //     prns_* measures in plMeasureDefinitions.ts). 2-decimal display. ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const prnsHeader = sheet.addRow(new Array(totalCols).fill(''));
    prnsHeader.getCell(1).value = 'Per Room Night Sold';
    applyKpiHeaderStyle(prnsHeader);
    addEngineKpiRow('Operating Supplies',    kv(monthKpi, 'Operating Supplies'),    kv(rangeKpi, 'Operating Supplies'),    false, 2);
    addEngineKpiRow('Cleaning Supplies',     kv(monthKpi, 'Cleaning Supplies'),     kv(rangeKpi, 'Cleaning Supplies'),     false, 2);
    addEngineKpiRow('Guest Supplies',        kv(monthKpi, 'Guest Supplies'),        kv(rangeKpi, 'Guest Supplies'),        false, 2);
    addEngineKpiRow('Paper Supplies',        kv(monthKpi, 'Paper Supplies'),        kv(rangeKpi, 'Paper Supplies'),        false, 2);
    addEngineKpiRow('Printing & Stationery', kv(monthKpi, 'Printing & Stationery'), kv(rangeKpi, 'Printing & Stationery'), false, 2);
    addEngineKpiRow('Laundry',               kv(monthKpi, 'Laundry'),               kv(rangeKpi, 'Laundry'),               false, 2);

    // --- Operating Equipment Usage per Room Night Sold (per-item breakdown
    //     of the Operating Supplies roll-up above). 2-decimal display. ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const opEquipHeader = sheet.addRow(new Array(totalCols).fill(''));
    opEquipHeader.getCell(1).value = 'Operating Equipment Usage per Room Night Sold';
    applyKpiHeaderStyle(opEquipHeader);
    addEngineKpiRow('Flatware (Cutlery)', kv(monthKpi, 'Flatware (Cutlery)'), kv(rangeKpi, 'Flatware (Cutlery)'), false, 2);
    addEngineKpiRow('Linen',              kv(monthKpi, 'Linen'),              kv(rangeKpi, 'Linen'),              false, 2);
    addEngineKpiRow('Glassware',          kv(monthKpi, 'Glassware'),          kv(rangeKpi, 'Glassware'),          false, 2);
    addEngineKpiRow('Room Smalls',        kv(monthKpi, 'Room Smalls'),        kv(rangeKpi, 'Room Smalls'),        false, 2);

    // --- Percentage of Room Sales section (Protea-aware: uses _protea variants
    //     so totals match the displayed Payroll/Controllables in this report) ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const pctOfSalesHeader = sheet.addRow(new Array(totalCols).fill(''));
    pctOfSalesHeader.getCell(1).value = 'Percentage of Room Sales';
    applyKpiHeaderStyle(pctOfSalesHeader);
    addEngineKpiRow('Payroll as a % of Room Sales',
      kv(monthKpi, 'Payroll as a % of Room Sales'),
      kv(rangeKpi, 'Payroll as a % of Room Sales'), true);
    addEngineKpiRow('Other Expenses as a % of Room Sales',
      kv(monthKpi, 'Other Expenses as a % of Room Sales'),
      kv(rangeKpi, 'Other Expenses as a % of Room Sales'), true);
  }

  /**
   * Renders the "Percentage of Revenue" KPI block (Payroll % + Other Expenses %)
   * after Department Profit on undistributed-OPEX group summary sheets — currently
   * Administrative & General, Property Operation & Maintenance, and Sales &
   * Marketing & Convention Service. Driven by PCT_OF_REVENUE_KPI_GROUPS, so
   * adding a new group only needs a Map entry + a registerPctOfRevenueQuartet
   * call in plMeasureDefinitions.ts.
   *
   * Numerator (Payroll / Controllables) is group-scoped via the registered
   * dept filter; denominator is hotel-wide Total Revenue. The active config
   * references the _protea variants so values match what the Protea report
   * displays for Total Payroll / Controllables (PROTEA_CATEGORY_REPOINTS
   * accounts moved out of Controllables into Payroll).
   */
  private addPctOfRevenueKpiRows(
    sheet: ExcelJS.Worksheet,
    totalCols: number,
    monthKpi: Map<string, PLCalculationResult>,
    rangeKpi: Map<string, PLCalculationResult>
  ): void {
    const applyKpiHeaderStyle = (row: ExcelJS.Row) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = SUBTOTAL_FILL;
        cell.font = { ...DATA_FONT, bold: true };
        cell.border = BORDER_STYLE;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(row);
    };
    const applyKpiDataStyle = (row: ExcelJS.Row) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = DATA_FONT;
        cell.border = BORDER_STYLE;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(row);
    };

    const addPctRow = (label: string) => {
      const m = monthKpi.get(label);
      const r = rangeKpi.get(label);
      const mAct = m?.actuals || 0, mBud = m?.budget || 0, mLy = m?.ly || 0;
      const rAct = r?.actuals || 0, rBud = r?.budget || 0, rLy = r?.ly || 0;
      const row = sheet.addRow({
        account: `  ${label}`,
        mLy: formatPercentage(mLy), mVsLyPct: `${(mAct - mLy).toFixed(1)} pts`,
        mAct: formatPercentage(mAct), mBud: formatPercentage(mBud),
        mVsBud: `${(mAct - mBud).toFixed(1)} pts`, mVsBudPct: '',
        sep: '',
        rLy: formatPercentage(rLy), rVsLyPct: `${(rAct - rLy).toFixed(1)} pts`,
        rAct: formatPercentage(rAct), rBud: formatPercentage(rBud),
        rVsBud: `${(rAct - rBud).toFixed(1)} pts`, rVsBudPct: '',
        comments: ''
      });
      applyKpiDataStyle(row);
    };

    this.addBlankSeparatorRow(sheet, totalCols);
    const header = sheet.addRow(new Array(totalCols).fill(''));
    header.getCell(1).value = 'Percentage of Revenue';
    applyKpiHeaderStyle(header);
    addPctRow('Payroll as a % of Revenue');
    addPctRow('Other Expenses as a % of Revenue');
  }

  /**
   * Renders Food & Beverage KPIs after Department Profit on the F&B group summary sheet.
   * KPIs: Food COS%, Beverage COS%, Cost per Cover, then per-cover expense metrics.
   */
  private addFbKpiRows(
    sheet: ExcelJS.Worksheet,
    monthData: any[],
    rangeData: any[],
    totalCols: number,
    monthKpi: Map<string, PLCalculationResult> = new Map(),
    rangeKpi: Map<string, PLCalculationResult> = new Map()
  ): void {
    const pct = (num: number, denom: number) => denom !== 0 ? (num / Math.abs(denom)) * 100 : 0;
    const div = (num: number, denom: number) => denom !== 0 ? num / denom : 0;

    // Engine-computed KPIs
    const mFoodCos = monthKpi.get('% Food COS');
    const rFoodCos = rangeKpi.get('% Food COS');
    const mBevCos = monthKpi.get('% Beverage COS');
    const rBevCos = rangeKpi.get('% Beverage COS');
    const mFbProfit = monthKpi.get('F&B Dept Profit %');
    const rFbProfit = rangeKpi.get('F&B Dept Profit %');

    // Style helpers
    const applyKpiHeaderStyle = (row: ExcelJS.Row) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = SUBTOTAL_FILL;
        cell.font = { ...DATA_FONT, bold: true };
        cell.border = BORDER_STYLE;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(row);
    };

    const applyKpiDataStyle = (row: ExcelJS.Row) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = DATA_FONT;
        cell.border = BORDER_STYLE;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(row);
    };

    // Helper: add a KPI row with percentage format (pts variance)
    const addPctKpiRow = (label: string, mAct: number, mBud: number, mLy: number, rAct: number, rBud: number, rLy: number) => {
      const row = sheet.addRow({
        account: `  ${label}`,
        mLy: formatPercentage(mLy), mVsLyPct: `${(mAct - mLy).toFixed(1)} pts`,
        mAct: formatPercentage(mAct), mBud: formatPercentage(mBud),
        mVsBud: `${(mAct - mBud).toFixed(1)} pts`, mVsBudPct: '',
        sep: '',
        rLy: formatPercentage(rLy), rVsLyPct: `${(rAct - rLy).toFixed(1)} pts`,
        rAct: formatPercentage(rAct), rBud: formatPercentage(rBud),
        rVsBud: `${(rAct - rBud).toFixed(1)} pts`, rVsBudPct: '',
        comments: ''
      });
      applyKpiDataStyle(row);
    };

    // Helper: add a KPI row with number format
    const addNumKpiRow = (label: string, mAct: number, mBud: number, mLy: number, rAct: number, rBud: number, rLy: number, decimals: number = 0) => {
      const mVsBud = mAct - mBud;
      const mVsLy = mAct - mLy;
      const rVsBud = rAct - rBud;
      const rVsLy = rAct - rLy;
      const row = sheet.addRow({
        account: `  ${label}`,
        mLy: formatNumber(mLy, decimals), mVsLyPct: formatPercentage(pct(mVsLy, mLy)),
        mAct: formatNumber(mAct, decimals), mBud: formatNumber(mBud, decimals),
        mVsBud: formatNumber(mVsBud, decimals), mVsBudPct: formatPercentage(pct(mVsBud, mBud)),
        sep: '',
        rLy: formatNumber(rLy, decimals), rVsLyPct: formatPercentage(pct(rVsLy, rLy)),
        rAct: formatNumber(rAct, decimals), rBud: formatNumber(rBud, decimals),
        rVsBud: formatNumber(rVsBud, decimals), rVsBudPct: formatPercentage(pct(rVsBud, rBud)),
        comments: ''
      });
      applyKpiDataStyle(row);
    };

    // Helper: render a KPI from engine-computed PLCalculationResult
    const addEngineKpiRow = (label: string, mResult: PLCalculationResult | undefined, rResult: PLCalculationResult | undefined) => {
      addPctKpiRow(label,
        mResult?.actuals || 0, mResult?.budget || 0, mResult?.ly || 0,
        rResult?.actuals || 0, rResult?.budget || 0, rResult?.ly || 0);
    };

    // --- Blank separator ---
    this.addBlankSeparatorRow(sheet, totalCols);

    // --- Covers section ---
    const coversHeader = sheet.addRow(new Array(totalCols).fill(''));
    coversHeader.getCell(1).value = 'Covers';
    applyKpiHeaderStyle(coversHeader);
    const addNumEngineRow = (label: string) => {
      const mr = monthKpi.get(label);
      const rr = rangeKpi.get(label);
      addNumKpiRow(label,
        mr?.actuals || 0, mr?.budget || 0, mr?.ly || 0,
        rr?.actuals || 0, rr?.budget || 0, rr?.ly || 0, 0);
    };
    addNumEngineRow('Breakfast Customers');
    addNumEngineRow('Lunch Customers');
    addNumEngineRow('Dinner Customers');
    addNumEngineRow('Late Snack Customers');
    addNumEngineRow('Banqueting Customer');

    // --- Average Food Spend section ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const spendHeader = sheet.addRow(new Array(totalCols).fill(''));
    spendHeader.getCell(1).value = 'Average Food Spend';
    applyKpiHeaderStyle(spendHeader);
    const addSpendRow = (label: string) => {
      const mr = monthKpi.get(label);
      const rr = rangeKpi.get(label);
      addNumKpiRow(label,
        mr?.actuals || 0, mr?.budget || 0, mr?.ly || 0,
        rr?.actuals || 0, rr?.budget || 0, rr?.ly || 0, 2);
    };
    addSpendRow('Avg Breakfast Spend');
    addSpendRow('Avg Lunch Spend');
    addSpendRow('Avg Dinner Spend');
    addSpendRow('Avg Late Snack Spend');
    addSpendRow('Avg Banqueting Spend');

    // --- Covers as % of Bed Nights Sold ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const coversBedHeader = sheet.addRow(new Array(totalCols).fill(''));
    coversBedHeader.getCell(1).value = 'Covers as % of Bed Nights Sold';
    applyKpiHeaderStyle(coversBedHeader);
    const addPctEngineRow = (label: string) => {
      const mr = monthKpi.get(label);
      const rr = rangeKpi.get(label);
      addPctKpiRow(label,
        mr?.actuals || 0, mr?.budget || 0, mr?.ly || 0,
        rr?.actuals || 0, rr?.budget || 0, rr?.ly || 0);
    };
    addPctEngineRow('Breakfast Customers as % of Bed Nights');
    addPctEngineRow('Lunch Customers as % of Bed Nights');
    addPctEngineRow('Dinner Customers as % of Bed Nights');
    addPctEngineRow('Late Snack Customers as % of Bed Nights');
    addPctEngineRow('Banqueting Customer as % of Bed Nights');

    // --- Cost of Sales section header ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const cosHeader = sheet.addRow(new Array(totalCols).fill(''));
    cosHeader.getCell(1).value = 'Cost of Sales';
    applyKpiHeaderStyle(cosHeader);
    addEngineKpiRow('Food Cost of Sales %', mFoodCos, rFoodCos);
    addEngineKpiRow('Beverage Cost of Sales %', mBevCos, rBevCos);

    // --- Cost Per Cover (engine-driven; numerator atoms divided by
    //     fb_total_covers_act per spec — all A914xxx in F&B incl banq) ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const cpcHeader = sheet.addRow(new Array(totalCols).fill(''));
    cpcHeader.getCell(1).value = 'Cost Per Cover';
    applyKpiHeaderStyle(cpcHeader);
    const addCpcRow = (label: string) => {
      const mr = monthKpi.get(label);
      const rr = rangeKpi.get(label);
      addNumKpiRow(label,
        mr?.actuals || 0, mr?.budget || 0, mr?.ly || 0,
        rr?.actuals || 0, rr?.budget || 0, rr?.ly || 0, 2);
    };
    addCpcRow('Operating Supplies');
    addCpcRow('Cleaning Supplies');
    addCpcRow('Guest Supplies');
    addCpcRow('Paper Supplies');
    addCpcRow('Printing & Stationery');
    addCpcRow('Laundry');

    // --- Operating Equipment Usage per Cover (per-item breakdown of the
    //     Cost Per Cover Operating Supplies roll-up). 2-decimal display. ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const equipHeader = sheet.addRow(new Array(totalCols).fill(''));
    equipHeader.getCell(1).value = 'Operating Equipment Usage per Cover';
    applyKpiHeaderStyle(equipHeader);
    addCpcRow('Flatware (Cutlery)');
    addCpcRow('China (Crockery)');
    addCpcRow('Kitchen Utensils');
    addCpcRow('Linen');
    addCpcRow('Glassware');
    addCpcRow('Restaurant/Bar Smalls');

    // --- Percentage of F&B Sales (Protea-aware: uses _protea variants so
    //     totals match the displayed Payroll/Controllables in this report) ---
    this.addBlankSeparatorRow(sheet, totalCols);
    const pctSalesHeader = sheet.addRow(new Array(totalCols).fill(''));
    pctSalesHeader.getCell(1).value = 'Percentage of F&B Sales';
    applyKpiHeaderStyle(pctSalesHeader);
    addPctEngineRow('Payroll as a % of F&B Sales');
    addPctEngineRow('Other Expenses as a % of F&B Sales');
  }

  /**
   * Adds a blank separator row with consistent formatting (borders, font, separator column).
   * Ensures the grid looks continuous even on empty rows.
   */
  private addBlankSeparatorRow(sheet: ExcelJS.Worksheet, totalCols: number, separatorType: 'dept' | 'roomSeg' | 'f90' = 'dept'): void {
    const blankRow = sheet.addRow(new Array(totalCols).fill(''));
    blankRow.eachCell((cell) => {
      cell.border = BORDER_STYLE;
      cell.font = DATA_FONT;
    });
    if (separatorType === 'dept') {
      this.styleDeptSeparator(blankRow);
    } else if (separatorType === 'roomSeg') {
      this.styleRoomSegSeparators(blankRow);
    }
  }

  /**
   * Helper to add department data rows grouped by category with level_12 sub-grouping.
   * Totals are embedded in the header rows (category and group headers carry the values).
   * Blank rows create visual separation between sub-sections.
   *
   * Layout:
   *   Total Revenue          ACT  BUD  ...   ← category header WITH totals
   *     Total Room Revenue   ACT  BUD  ...   ← level_12 group header WITH totals
   *       Account 1          ACT  BUD  ...   ← detail row
   *       Account 2          ACT  BUD  ...   ← detail row
   *                                          ← blank separator
   *     Total Other Revenue  ACT  BUD  ...   ← next group header
   *       Account 3          ACT  BUD  ...
   *                                          ← blank separator
   *                                          ← blank separator (end of category)
   */
  private addDepartmentDataSection(
    sheet: ExcelJS.Worksheet,
    monthData: any[],
    rangeData: any[],
    totalCols: number,
    movedAccountSources?: Map<string, string>,
    options?: {
      collapseRevenueDetail?: boolean;
      suppressStats?: boolean;
      showDeptProfit?: boolean;
      flattenCategories?: string[];
      customSubgroups?: InvestSubgroupDef[];
      hideSubgroupNames?: string[];
    }
  ): void {
    // Delegate to custom subgroup renderer for Invest-type tabs
    if (options?.customSubgroups) {
      this.addCustomSubgroupDataSection(
        sheet, monthData, rangeData, totalCols,
        options.customSubgroups, movedAccountSources, options.hideSubgroupNames
      );
      return;
    }
    const categories = ['Revenue', 'Cost of Sales', 'Payroll', 'Controllables', 'Other', 'Stats'];
    const ABS_COLS = [2, 4, 5, 6, 9, 11, 12, 13]; // absolute value column indices (both sides, excludes pct cols)

    // Helper: apply number formatting to absolute columns
    const applyNumberFormats = (row: ExcelJS.Row) => {
      ABS_COLS.forEach(col => {
        const cell = row.getCell(col);
        if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      });
    };

    // Helper: sum a numeric field across rows
    const sumField = (rows: any[], field: string) =>
      rows.reduce((sum: number, r: any) => sum + (Number(r[field]) || 0), 0);

    // Helper: compute percentage variance
    const pct = (num: number, denom: number) => denom !== 0 ? (num / Math.abs(denom)) * 100 : 0;

    // Helper: create a header row that carries aggregated totals from both month and range
    // Revenue is stored as negative (credit-balance) in the DB.
    // Flip sign for Revenue category so it displays as positive, consistent with F90.
    const addHeaderWithTotals = (
      label: string,
      mRows: any[],
      rRows: any[],
      styleFn: (row: ExcelJS.Row) => void,
      isStats: boolean = false,
      sign: number = 1
    ) => {
      const mTotActuals = sumField(mRows, 'actuals') * sign;
      const mTotBudget = sumField(mRows, 'budget') * sign;
      const mTotLy = sumField(mRows, 'ly') * sign;
      const mTotVsBud = mTotActuals - mTotBudget;
      const mTotVsLy = mTotActuals - mTotLy;

      const rTotActuals = sumField(rRows, 'actuals') * sign;
      const rTotBudget = sumField(rRows, 'budget') * sign;
      const rTotLy = sumField(rRows, 'ly') * sign;
      const rTotVsBud = rTotActuals - rTotBudget;
      const rTotVsLy = rTotActuals - rTotLy;

      const headerRow = sheet.addRow({
        account: label,
        mLy: formatNumber(mTotLy),
        mVsLyPct: formatPercentage(pct(mTotVsLy, mTotLy)),
        mAct: formatNumber(mTotActuals),
        mBud: formatNumber(mTotBudget),
        mVsBud: formatNumber(mTotVsBud),
        mVsBudPct: formatPercentage(pct(mTotVsBud, mTotBudget)),
        sep: '',
        rLy: formatNumber(rTotLy),
        rVsLyPct: formatPercentage(pct(rTotVsLy, rTotLy)),
        rAct: formatNumber(rTotActuals),
        rBud: formatNumber(rTotBudget),
        rVsBud: formatNumber(rTotVsBud),
        rVsBudPct: formatPercentage(pct(rTotVsBud, rTotBudget)),
        comments: ''
      });
      styleFn(headerRow);
      this.styleDeptSeparator(headerRow);
      applyNumberFormats(headerRow);
    };

    let deptProfitRendered = false;

    for (const category of categories) {
      const mCategoryRows = monthData.filter(r => r.category === category);
      const rCategoryRows = rangeData.filter(r => r.category === category);
      if (mCategoryRows.length === 0 && rCategoryRows.length === 0) continue;

      const isStats = category === 'Stats';
      const isRevenue = category === 'Revenue';
      const sign = isRevenue ? -1 : 1;

      // For groups that show dept profit before stats, render it now
      if (isStats && options?.showDeptProfit) {
        this.addDeptProfitRows(sheet, monthData, rangeData, sumField, ABS_COLS, totalCols);
        deptProfitRendered = true;
      }

      // Suppress Stats category entirely when requested
      if (isStats && options?.suppressStats) {
        continue;
      }

      // When collapsing revenue detail, show only the total line (no detail rows)
      if (isRevenue && options?.collapseRevenueDetail) {
        addHeaderWithTotals(`Total ${category}`, mCategoryRows, rCategoryRows, applyCategorySubtotalStyle, isStats, sign);
        this.addBlankSeparatorRow(sheet, totalCols);
        continue;
      }

      if (isStats) {
        // Stats: render flat without level_12 sub-grouping
        const allAccounts: string[] = [];
        const mMap = new Map<string, any>();
        const rMap = new Map<string, any>();
        for (const row of mCategoryRows) {
          mMap.set(row.account, row);
          if (!allAccounts.includes(row.account)) allAccounts.push(row.account);
        }
        for (const row of rCategoryRows) {
          rMap.set(row.account, row);
          if (!allAccounts.includes(row.account)) allAccounts.push(row.account);
        }

        for (const acct of allAccounts) {
          const mRow = mMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0, accountName: rMap.get(acct)?.accountName || acct, account: acct };
          const rRow = rMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0 };

          const excelRow = sheet.addRow({
            account: `    ${mRow.accountName || mRow.account}`,
            mLy: formatNumber(mRow.ly * sign),
            mVsLyPct: formatPercentage(pct(mRow.vsLy * sign, mRow.ly * sign)),
            mAct: formatNumber(mRow.actuals * sign),
            mBud: formatNumber(mRow.budget * sign),
            mVsBud: formatNumber(mRow.vsBud * sign),
            mVsBudPct: formatPercentage(pct(mRow.vsBud * sign, mRow.budget * sign)),
            sep: '',
            rLy: formatNumber(rRow.ly * sign),
            rVsLyPct: formatPercentage(pct(rRow.vsLy * sign, rRow.ly * sign)),
            rAct: formatNumber(rRow.actuals * sign),
            rBud: formatNumber(rRow.budget * sign),
            rVsBud: formatNumber(rRow.vsBud * sign),
            rVsBudPct: formatPercentage(pct(rRow.vsBud * sign, rRow.budget * sign)),
            comments: ''
          });

          const movedFrom = movedAccountSources?.get(mRow.account);
          const accountLabel = this.buildAccountLabel(mRow.accountName || mRow.account, mRow.account, movedFrom);
          if (typeof accountLabel !== 'string') {
            excelRow.getCell(1).value = { richText: [{ font: { size: 10 }, text: '    ' }, ...accountLabel.richText] };
          }

          applyDataRowStyle(excelRow);
          this.styleDeptSeparator(excelRow);
          applyNumberFormats(excelRow);
        }

      } else if (options?.flattenCategories?.includes(category)) {
        // Flattened: render all accounts without level_12 sub-group headers/subtotals.
        // Exception: A759* accounts are collected into a "Levies" sub-group rendered
        // (with header + subtotal) at the bottom of the flat list.
        const allAccounts: string[] = [];
        const mAcctMap = new Map<string, any>();
        const rAcctMap = new Map<string, any>();
        for (const row of mCategoryRows) {
          mAcctMap.set(row.account, row);
          if (!allAccounts.includes(row.account)) allAccounts.push(row.account);
        }
        for (const row of rCategoryRows) {
          rAcctMap.set(row.account, row);
          if (!allAccounts.includes(row.account)) allAccounts.push(row.account);
        }

        const leviesAccounts = allAccounts.filter(a => isLeviesAccount(a));
        const nonLeviesAccounts = allAccounts.filter(a => !isLeviesAccount(a));

        const renderAcct = (acct: string) => {
          const mRow = mAcctMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0, accountName: rAcctMap.get(acct)?.accountName || acct, account: acct };
          const rRow = rAcctMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0 };
          const displayName = mRow.accountName || mRow.account;

          const excelRow = sheet.addRow({
            account: `    ${displayName}`,
            mLy: formatNumber(mRow.ly * sign),
            mVsLyPct: formatPercentage(pct(mRow.vsLy * sign, mRow.ly * sign)),
            mAct: formatNumber(mRow.actuals * sign),
            mBud: formatNumber(mRow.budget * sign),
            mVsBud: formatNumber(mRow.vsBud * sign),
            mVsBudPct: formatPercentage(pct(mRow.vsBud * sign, mRow.budget * sign)),
            sep: '',
            rLy: formatNumber(rRow.ly * sign),
            rVsLyPct: formatPercentage(pct(rRow.vsLy * sign, rRow.ly * sign)),
            rAct: formatNumber(rRow.actuals * sign),
            rBud: formatNumber(rRow.budget * sign),
            rVsBud: formatNumber(rRow.vsBud * sign),
            rVsBudPct: formatPercentage(pct(rRow.vsBud * sign, rRow.budget * sign)),
            comments: ''
          });

          const movedFrom = movedAccountSources?.get(mRow.account);
          const accountLabel = this.buildAccountLabel(displayName, mRow.account, movedFrom);
          if (typeof accountLabel !== 'string') {
            excelRow.getCell(1).value = { richText: [{ font: { size: 10 }, text: '    ' }, ...accountLabel.richText] };
          }

          applyDataRowStyle(excelRow);
          this.styleDeptSeparator(excelRow);
          applyNumberFormats(excelRow);
        };

        for (const acct of nonLeviesAccounts) renderAcct(acct);

        if (leviesAccounts.length > 0) {
          // Sub-group header
          const sgHeaderRow = sheet.addRow(new Array(totalCols).fill(''));
          sgHeaderRow.getCell(1).value = LEVIES_SUBGROUP;
          applyGroupHeaderStyle(sgHeaderRow);
          this.styleDeptSeparator(sgHeaderRow);

          // Account detail rows
          for (const acct of leviesAccounts) renderAcct(acct);

          // Levies subtotal
          const mLeviesRows = leviesAccounts.map(a => mAcctMap.get(a)).filter(Boolean);
          const rLeviesRows = leviesAccounts.map(a => rAcctMap.get(a)).filter(Boolean);
          addHeaderWithTotals(`  Total ${LEVIES_SUBGROUP}`, mLeviesRows, rLeviesRows, applyGroupSubtotalStyle, false, sign);
          this.addBlankSeparatorRow(sheet, totalCols);
        }

      } else {
        // Non-stats: group accounts by level_12
        // A759* accounts are carved out into a "Levies" sub-group.
        const mLevel12Map = new Map<string, any[]>();
        for (const row of mCategoryRows) {
          const groupKey = isLeviesAccount(row.account)
            ? LEVIES_SUBGROUP
            : (row.level12Group || `Other ${category}`);
          if (!mLevel12Map.has(groupKey)) mLevel12Map.set(groupKey, []);
          mLevel12Map.get(groupKey)!.push(row);
        }
        const rLevel12Map = new Map<string, any[]>();
        for (const row of rCategoryRows) {
          const groupKey = isLeviesAccount(row.account)
            ? LEVIES_SUBGROUP
            : (row.level12Group || `Other ${category}`);
          if (!rLevel12Map.has(groupKey)) rLevel12Map.set(groupKey, []);
          rLevel12Map.get(groupKey)!.push(row);
        }

        // Get all group names preserving order
        const allGroupNames: string[] = [];
        for (const key of mLevel12Map.keys()) {
          if (!allGroupNames.includes(key)) allGroupNames.push(key);
        }
        for (const key of rLevel12Map.keys()) {
          if (!allGroupNames.includes(key)) allGroupNames.push(key);
        }

        for (const groupName of allGroupNames) {
          const mGroupRows = mLevel12Map.get(groupName) || [];
          const rGroupRows = rLevel12Map.get(groupName) || [];

          // Subgroup header row (name only)
          const groupHeaderRow = sheet.addRow(new Array(totalCols).fill(''));
          groupHeaderRow.getCell(1).value = proteaRenameLabel(groupName);
          applyGroupHeaderStyle(groupHeaderRow);
          this.styleDeptSeparator(groupHeaderRow);

          // Account detail rows - merge accounts from both sides
          const allAccounts: string[] = [];
          const mAcctMap = new Map<string, any>();
          const rAcctMap = new Map<string, any>();
          for (const row of mGroupRows) {
            mAcctMap.set(row.account, row);
            if (!allAccounts.includes(row.account)) allAccounts.push(row.account);
          }
          for (const row of rGroupRows) {
            rAcctMap.set(row.account, row);
            if (!allAccounts.includes(row.account)) allAccounts.push(row.account);
          }

          for (const acct of allAccounts) {
            const mRow = mAcctMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0, accountName: rAcctMap.get(acct)?.accountName || acct, account: acct };
            const rRow = rAcctMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0 };
            const displayName = mRow.accountName || mRow.account;

            const excelRow = sheet.addRow({
              account: `    ${displayName}`,
              mLy: formatNumber(mRow.ly * sign),
              mVsLyPct: formatPercentage(pct(mRow.vsLy * sign, mRow.ly * sign)),
              mAct: formatNumber(mRow.actuals * sign),
              mBud: formatNumber(mRow.budget * sign),
              mVsBud: formatNumber(mRow.vsBud * sign),
              mVsBudPct: formatPercentage(pct(mRow.vsBud * sign, mRow.budget * sign)),
              sep: '',
              rLy: formatNumber(rRow.ly * sign),
              rVsLyPct: formatPercentage(pct(rRow.vsLy * sign, rRow.ly * sign)),
              rAct: formatNumber(rRow.actuals * sign),
              rBud: formatNumber(rRow.budget * sign),
              rVsBud: formatNumber(rRow.vsBud * sign),
              rVsBudPct: formatPercentage(pct(rRow.vsBud * sign, rRow.budget * sign)),
              comments: ''
            });

            const movedFrom = movedAccountSources?.get(mRow.account);
            const accountLabel = this.buildAccountLabel(displayName, mRow.account, movedFrom);
            if (typeof accountLabel !== 'string') {
              excelRow.getCell(1).value = { richText: [{ font: { size: 10 }, text: '    ' }, ...accountLabel.richText] };
            }

            applyDataRowStyle(excelRow);
            this.styleDeptSeparator(excelRow);
            applyNumberFormats(excelRow);
          }

          // level_12 group subtotal row (at bottom of sub-group)
          addHeaderWithTotals(`  Total ${proteaRenameLabel(groupName)}`, mGroupRows, rGroupRows, applyGroupSubtotalStyle, false, sign);

          // Blank row separator after each level_12 sub-group
          this.addBlankSeparatorRow(sheet, totalCols);
        }
      }

      // Category total row (at bottom of category)
      addHeaderWithTotals(`Total ${category}`, mCategoryRows, rCategoryRows, applyCategorySubtotalStyle, isStats, sign);

      // Blank row separator after category
      this.addBlankSeparatorRow(sheet, totalCols);
    }

    // --- Department Profit & GOP% ---
    // Rendered before Stats when showDeptProfit (F&B, Utilities), otherwise after all categories
    if (!deptProfitRendered) {
      this.addDeptProfitRows(sheet, monthData, rangeData, sumField, ABS_COLS, totalCols);
    }
  }

  /**
   * Renders department data using custom subgroup definitions instead of level_12 grouping.
   * Used for the Invest Factor Owner tab where accounts are classified via level_20
   * mapping table lookups (with level_13 for Management Fees) and a catch-all for unmapped.
   */
  private addCustomSubgroupDataSection(
    sheet: ExcelJS.Worksheet,
    monthData: any[],
    rangeData: any[],
    totalCols: number,
    subgroups: InvestSubgroupDef[],
    movedAccountSources?: Map<string, string>,
    hideSubgroupNames?: string[]
  ): void {
    const hideSet = new Set(hideSubgroupNames ?? []);
    const ABS_COLS = [2, 4, 5, 6, 9, 11, 12, 13];
    const applyNumberFormats = (row: ExcelJS.Row) => {
      ABS_COLS.forEach(col => {
        const cell = row.getCell(col);
        if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      });
    };
    const sumField = (rows: any[], field: string) =>
      rows.reduce((sum: number, r: any) => sum + (Number(r[field]) || 0), 0);
    const pct = (num: number, denom: number) => denom !== 0 ? (num / Math.abs(denom)) * 100 : 0;

    // --- Filter out stats accounts — not relevant for Invest tab ---
    monthData = monthData.filter(r => r.category !== 'Stats');
    rangeData = rangeData.filter(r => r.category !== 'Stats');

    // --- Aggregate duplicate accounts from merged departments ---
    const aggregateByAccount = (rows: any[]): any[] => {
      const map = new Map<string, any>();
      for (const row of rows) {
        const existing = map.get(row.account);
        if (!existing) {
          map.set(row.account, { ...row });
        } else {
          existing.actuals = (Number(existing.actuals) || 0) + (Number(row.actuals) || 0);
          existing.budget = (Number(existing.budget) || 0) + (Number(row.budget) || 0);
          existing.ly = (Number(existing.ly) || 0) + (Number(row.ly) || 0);
          existing.vsBud = existing.actuals - existing.budget;
          existing.vsLy = existing.actuals - existing.ly;
        }
      }
      return Array.from(map.values());
    };
    const aggMonthData = aggregateByAccount(monthData);
    const aggRangeData = aggregateByAccount(rangeData);

    // --- Classify accounts using level_20 mapping table ---
    const allRows = [...aggMonthData, ...aggRangeData];
    const classification = classifyAccountsByLevel20(allRows, subgroups);
    const catchAllName = subgroups.find(sg => sg.isCatchAll)?.name || 'Other';

    // --- Renderer-local "Levies" carve-out for A759* accounts ---
    // Override the shared classifier's output here only — the classifier itself
    // (and F90, which reuses it) stays untouched.
    for (const [acct, c] of classification) {
      if (isLeviesAccount(acct)) {
        c.subgroup = LEVIES_SUBGROUP;
        c.isUnmapped = false;
      }
    }
    // Insert a synthetic Levies subgroup just after Owners Expense for rendering.
    const effectiveSubgroups: InvestSubgroupDef[] = [];
    let leviesInserted = false;
    for (const sg of subgroups) {
      effectiveSubgroups.push(sg);
      if (!leviesInserted && sg.name === 'Owners Expense') {
        effectiveSubgroups.push({ name: LEVIES_SUBGROUP });
        leviesInserted = true;
      }
    }
    if (!leviesInserted) {
      // Fallback: place before the catch-all if Owners Expense isn't in config
      const catchAllIdx = effectiveSubgroups.findIndex(sg => sg.isCatchAll);
      if (catchAllIdx >= 0) effectiveSubgroups.splice(catchAllIdx, 0, { name: LEVIES_SUBGROUP });
      else effectiveSubgroups.push({ name: LEVIES_SUBGROUP });
    }
    subgroups = effectiveSubgroups;

    // --- Build per-subgroup data sets ---
    const mBySubgroup = new Map<string, any[]>();
    const rBySubgroup = new Map<string, any[]>();
    for (const sg of subgroups) {
      mBySubgroup.set(sg.name, []);
      rBySubgroup.set(sg.name, []);
    }
    for (const row of aggMonthData) {
      const sg = classification.get(row.account)?.subgroup || catchAllName;
      mBySubgroup.get(sg)?.push(row);
    }
    for (const row of aggRangeData) {
      const sg = classification.get(row.account)?.subgroup || catchAllName;
      rBySubgroup.get(sg)?.push(row);
    }

    // Helper: create a header/subtotal row with aggregated totals
    const addHeaderWithTotals = (
      label: string,
      mRows: any[],
      rRows: any[],
      styleFn: (row: ExcelJS.Row) => void
    ) => {
      const mTotActuals = sumField(mRows, 'actuals');
      const mTotBudget = sumField(mRows, 'budget');
      const mTotLy = sumField(mRows, 'ly');
      const mTotVsBud = mTotActuals - mTotBudget;
      const mTotVsLy = mTotActuals - mTotLy;

      const rTotActuals = sumField(rRows, 'actuals');
      const rTotBudget = sumField(rRows, 'budget');
      const rTotLy = sumField(rRows, 'ly');
      const rTotVsBud = rTotActuals - rTotBudget;
      const rTotVsLy = rTotActuals - rTotLy;

      const headerRow = sheet.addRow({
        account: label,
        mLy: formatNumber(mTotLy),
        mVsLyPct: formatPercentage(pct(mTotVsLy, mTotLy)),
        mAct: formatNumber(mTotActuals),
        mBud: formatNumber(mTotBudget),
        mVsBud: formatNumber(mTotVsBud),
        mVsBudPct: formatPercentage(pct(mTotVsBud, mTotBudget)),
        sep: '',
        rLy: formatNumber(rTotLy),
        rVsLyPct: formatPercentage(pct(rTotVsLy, rTotLy)),
        rAct: formatNumber(rTotActuals),
        rBud: formatNumber(rTotBudget),
        rVsBud: formatNumber(rTotVsBud),
        rVsBudPct: formatPercentage(pct(rTotVsBud, rTotBudget)),
        comments: ''
      });
      styleFn(headerRow);
      this.styleDeptSeparator(headerRow);
      applyNumberFormats(headerRow);
    };

    // --- Render each subgroup in config order ---
    for (const sg of subgroups) {
      if (hideSet.has(sg.name)) continue;
      const mRows = mBySubgroup.get(sg.name) || [];
      const rRows = rBySubgroup.get(sg.name) || [];
      if (mRows.length === 0 && rRows.length === 0) continue;

      // Subgroup header row (name only)
      const sgHeaderRow = sheet.addRow(new Array(totalCols).fill(''));
      sgHeaderRow.getCell(1).value = proteaRenameLabel(sg.name);
      applyGroupHeaderStyle(sgHeaderRow);
      this.styleDeptSeparator(sgHeaderRow);

      // Account detail rows - merge accounts from both sides
      const allAccounts: string[] = [];
      const mAcctMap = new Map<string, any>();
      const rAcctMap = new Map<string, any>();
      for (const row of mRows) {
        mAcctMap.set(row.account, row);
        if (!allAccounts.includes(row.account)) allAccounts.push(row.account);
      }
      for (const row of rRows) {
        rAcctMap.set(row.account, row);
        if (!allAccounts.includes(row.account)) allAccounts.push(row.account);
      }

      for (const acct of allAccounts) {
        const mRow = mAcctMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0, accountName: rAcctMap.get(acct)?.accountName || acct, account: acct };
        const rRow = rAcctMap.get(acct) || { actuals: 0, budget: 0, vsBud: 0, ly: 0, vsLy: 0 };
        const displayName = mRow.accountName || mRow.account;

        const excelRow = sheet.addRow({
          account: `    ${displayName}`,
          mLy: formatNumber(mRow.ly),
          mVsLyPct: formatPercentage(pct(mRow.vsLy, mRow.ly)),
          mAct: formatNumber(mRow.actuals),
          mBud: formatNumber(mRow.budget),
          mVsBud: formatNumber(mRow.vsBud),
          mVsBudPct: formatPercentage(pct(mRow.vsBud, mRow.budget)),
          sep: '',
          rLy: formatNumber(rRow.ly),
          rVsLyPct: formatPercentage(pct(rRow.vsLy, rRow.ly)),
          rAct: formatNumber(rRow.actuals),
          rBud: formatNumber(rRow.budget),
          rVsBud: formatNumber(rRow.vsBud),
          rVsBudPct: formatPercentage(pct(rRow.vsBud, rRow.budget)),
          comments: ''
        });

        const movedFrom = movedAccountSources?.get(mRow.account);
        const accountLabel = this.buildAccountLabel(displayName, mRow.account, movedFrom);
        if (typeof accountLabel !== 'string') {
          excelRow.getCell(1).value = { richText: [{ font: { size: 10 }, text: '    ' }, ...accountLabel.richText] };
        }

        applyDataRowStyle(excelRow);

        // Highlight unmapped accounts that fell to catch-all without a recognized level_20 value
        const acctClassification = classification.get(acct);
        if (acctClassification?.isUnmapped) {
          excelRow.getCell(1).font = { ...DATA_FONT, italic: true, color: { argb: 'FFCC6600' } };
        }

        this.styleDeptSeparator(excelRow);
        applyNumberFormats(excelRow);
      }

      // Subgroup subtotal row
      addHeaderWithTotals(`  Total ${proteaRenameLabel(sg.name)}`, mRows, rRows, applyGroupSubtotalStyle);

      // Blank separator after subgroup
      this.addBlankSeparatorRow(sheet, totalCols);
    }

  }

  /**
   * Creates the Room Segments worksheet with Month/Range side by side, Revenue/Nights/ADR as row sections
   */
  private async createRoomSegmentWorksheet(
    workbook: ExcelJS.Workbook,
    config: ProteaReportPackConfig
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Room Segments', { properties: { tabColor: TAB_COLOR_REPORT } });
    const TOTAL_COLS = 16;

    // 16 columns: Segment, Category, Month(6), Sep, Range(6), Comments
    sheet.columns = [
      { key: 'segment', width: 35 },
      { key: 'category', width: 15 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLyPct', width: 12 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mVsBudPct', width: 12 },
      { key: 'sep', width: 2 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLyPct', width: 12 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rVsBudPct', width: 12 },
      { key: 'comments', width: 35 },
    ];

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, TOTAL_COLS, 'Room Segments');

    // Period group headers
    const groupRow = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    groupRow.getCell(3).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(10).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 3, groupRow.number, 8);
    sheet.mergeCells(groupRow.number, 10, groupRow.number, 15);
    applyHeaderStyle(groupRow);
    this.styleRoomSegSeparators(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'Segment', 'Category',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      '',
      'LY', 'vs LY %', 'Actuals', 'Budget', 'vs Bud', 'vs Bud %',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);
    this.styleRoomSegSeparators(headerRow);

    // Fetch single-month data
    const monthSegmentData = await db.getRoomSegmentExportData(
      config.ou,
      config.selectedMonth,
      config.selectedYear,
      config.selectedMonth,
      config.selectedYear,
      config.version
    );

    // Fetch range data
    const rangeSegmentData = await db.getRoomSegmentExportData(
      config.ou,
      config.ytdStartMonth,
      config.ytdStartYear,
      config.ytdEndMonth,
      config.ytdEndYear,
      config.version
    );

    // --- Revenue Section ---
    const revHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    revHeader.getCell(1).value = 'Revenue';
    applySectionHeaderStyle(revHeader);
    sheet.mergeCells(revHeader.number, 1, revHeader.number, TOTAL_COLS);

    const revConsolHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    revConsolHeader.getCell(1).value = 'Consolidated Summary';
    applySectionHeaderStyle(revConsolHeader);
    sheet.mergeCells(revConsolHeader.number, 1, revConsolHeader.number, TOTAL_COLS);

    this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'revenue', 'consolidated', TOTAL_COLS);

    if (config.generateDetailTabs) {
      this.addBlankSeparatorRow(sheet, TOTAL_COLS, 'roomSeg');

      const revDetailHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
      revDetailHeader.getCell(1).value = 'Detail by Day Type';
      applySectionHeaderStyle(revDetailHeader);
      sheet.mergeCells(revDetailHeader.number, 1, revDetailHeader.number, TOTAL_COLS);

      this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'revenue', 'detail', TOTAL_COLS);
    }

    this.addBlankSeparatorRow(sheet, TOTAL_COLS, 'roomSeg');

    // --- Room Nights Section ---
    const nightsHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    nightsHeader.getCell(1).value = 'Room Nights';
    applySectionHeaderStyle(nightsHeader);
    sheet.mergeCells(nightsHeader.number, 1, nightsHeader.number, TOTAL_COLS);

    const nightsConsolHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    nightsConsolHeader.getCell(1).value = 'Consolidated Summary';
    applySectionHeaderStyle(nightsConsolHeader);
    sheet.mergeCells(nightsConsolHeader.number, 1, nightsConsolHeader.number, TOTAL_COLS);

    this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'nights', 'consolidated', TOTAL_COLS);

    if (config.generateDetailTabs) {
      this.addBlankSeparatorRow(sheet, TOTAL_COLS, 'roomSeg');

      const nightsDetailHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
      nightsDetailHeader.getCell(1).value = 'Detail by Day Type';
      applySectionHeaderStyle(nightsDetailHeader);
      sheet.mergeCells(nightsDetailHeader.number, 1, nightsDetailHeader.number, TOTAL_COLS);

      this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'nights', 'detail', TOTAL_COLS);
    }

    this.addBlankSeparatorRow(sheet, TOTAL_COLS, 'roomSeg');

    // --- ADR Section ---
    const adrHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    adrHeader.getCell(1).value = 'ADR';
    applySectionHeaderStyle(adrHeader);
    sheet.mergeCells(adrHeader.number, 1, adrHeader.number, TOTAL_COLS);

    const adrConsolHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    adrConsolHeader.getCell(1).value = 'Consolidated Summary';
    applySectionHeaderStyle(adrConsolHeader);
    sheet.mergeCells(adrConsolHeader.number, 1, adrConsolHeader.number, TOTAL_COLS);

    this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'adr', 'consolidated', TOTAL_COLS);

    if (config.generateDetailTabs) {
      this.addBlankSeparatorRow(sheet, TOTAL_COLS, 'roomSeg');

      const adrDetailHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
      adrDetailHeader.getCell(1).value = 'Detail by Day Type';
      applySectionHeaderStyle(adrDetailHeader);
      sheet.mergeCells(adrDetailHeader.number, 1, adrDetailHeader.number, TOTAL_COLS);

      this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'adr', 'detail', TOTAL_COLS);
    }

    // Freeze panes (2 title rows + 2 header rows)
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];
  }

  /**
   * Extract metric values (actuals, budget, ly) for a single aggregated row given the metric type.
   * For 'adr', computes rate = revenue / nights.
   */
  private extractMetricValues(
    row: { revAct: number; revBud: number; revLy: number; nightsAct: number; nightsBud: number; nightsLy: number },
    metric: 'revenue' | 'nights' | 'adr'
  ): { actuals: number | null; budget: number | null; ly: number | null } {
    if (metric === 'revenue') {
      // Revenue is stored as negative (credit-balance); flip to positive for display
      return { actuals: -row.revAct, budget: -row.revBud, ly: -row.revLy };
    } else if (metric === 'nights') {
      return { actuals: row.nightsAct, budget: row.nightsBud, ly: row.nightsLy };
    } else {
      // ADR = revenue / nights; negate revenue so ADR displays as positive
      return {
        actuals: row.nightsAct !== 0 ? -row.revAct / row.nightsAct : 0,
        budget: row.nightsBud !== 0 ? -row.revBud / row.nightsBud : 0,
        ly: row.nightsLy !== 0 ? -row.revLy / row.nightsLy : 0,
      };
    }
  }

  /**
   * Compute variance columns from actuals/budget/ly values.
   */
  private computeVariances(vals: { actuals: number | null; budget: number | null; ly: number | null }): {
    vsBud: number | null; vsBudPct: number | null; vsLy: number | null; vsLyPct: number | null;
  } {
    const vsBud = vals.actuals !== null && vals.budget !== null ? vals.actuals - vals.budget : null;
    const vsBudPct = vsBud !== null && vals.budget !== null && vals.budget !== 0
      ? (vsBud / Math.abs(vals.budget)) * 100 : 0;
    const vsLy = vals.actuals !== null && vals.ly !== null ? vals.actuals - vals.ly : null;
    const vsLyPct = vsLy !== null && vals.ly !== null && vals.ly !== 0
      ? (vsLy / Math.abs(vals.ly)) * 100 : 0;
    return { vsBud, vsBudPct, vsLy, vsLyPct };
  }

  /**
   * Build a single 18-column row array for the side-by-side month/range layout.
   */
  private buildRoomSegRow(
    description: string,
    category: string,
    monthVals: { actuals: number | null; budget: number | null; ly: number | null },
    rangeVals: { actuals: number | null; budget: number | null; ly: number | null },
    metric: 'revenue' | 'nights' | 'adr'
  ): (string | number)[] {
    const mVar = this.computeVariances(monthVals);
    const rVar = this.computeVariances(rangeVals);
    const decimals = metric === 'adr' ? 2 : 0;

    return [
      description, category,
      formatNumber(monthVals.ly, decimals), formatPercentage(mVar.vsLyPct),
      formatNumber(monthVals.actuals, decimals), formatNumber(monthVals.budget, decimals),
      formatNumber(mVar.vsBud, decimals), formatPercentage(mVar.vsBudPct),
      '',
      formatNumber(rangeVals.ly, decimals), formatPercentage(rVar.vsLyPct),
      formatNumber(rangeVals.actuals, decimals), formatNumber(rangeVals.budget, decimals),
      formatNumber(rVar.vsBud, decimals), formatPercentage(rVar.vsBudPct),
      ''
    ];
  }

  /**
   * Aggregate raw data rows into { revAct, revBud, revLy, nightsAct, nightsBud, nightsLy }
   * keyed by name+category. For 'detail' mode uses description/category directly;
   * for 'consolidated' mode aggregates by consolidatedName/consolidatedCategory.
   */
  private aggregateSegmentData(
    data: any[],
    mode: 'consolidated' | 'detail'
  ): Map<string, { name: string; category: string; revAct: number; revBud: number; revLy: number; nightsAct: number; nightsBud: number; nightsLy: number }> {
    const map = new Map<string, { name: string; category: string; revAct: number; revBud: number; revLy: number; nightsAct: number; nightsBud: number; nightsLy: number }>();

    for (const row of data) {
      const name = mode === 'consolidated' ? row.consolidatedName : row.description;
      const cat = mode === 'consolidated' ? row.consolidatedCategory : row.category;
      const key = `${cat}::${name}`;
      if (!map.has(key)) {
        map.set(key, {
          name, category: cat,
          revAct: 0, revBud: 0, revLy: 0,
          nightsAct: 0, nightsBud: 0, nightsLy: 0
        });
      }
      const agg = map.get(key)!;
      agg.revAct += row.revenueActuals || 0;
      agg.revBud += row.revenueBudget || 0;
      agg.revLy += row.revenueLy || 0;
      agg.nightsAct += row.nightsActuals || 0;
      agg.nightsBud += row.nightsBudget || 0;
      agg.nightsLy += row.nightsLy || 0;
    }

    return map;
  }

  /**
   * Add a metric section (revenue, nights, or adr) with month and range data side by side.
   * Handles both consolidated and detail modes with category subtotals and grand totals.
   */
  private addRoomSegMetricSection(
    sheet: ExcelJS.Worksheet,
    monthData: any[],
    rangeData: any[],
    metric: 'revenue' | 'nights' | 'adr',
    mode: 'consolidated' | 'detail',
    totalCols: number
  ): void {
    const categories = mode === 'consolidated'
      ? ['Transient', 'Groups', 'Complimentary']
      : ['Sun-Thur', 'Fri-Sat', 'Groups', 'Complimentary'];

    const monthMap = this.aggregateSegmentData(monthData, mode);
    const rangeMap = this.aggregateSegmentData(rangeData, mode);

    const grandMonthTotals = { revAct: 0, revBud: 0, revLy: 0, nightsAct: 0, nightsBud: 0, nightsLy: 0 };
    const grandRangeTotals = { revAct: 0, revBud: 0, revLy: 0, nightsAct: 0, nightsBud: 0, nightsLy: 0 };

    for (const category of categories) {
      const monthRows = Array.from(monthMap.values()).filter(r => r.category === category);
      const rangeRows = Array.from(rangeMap.values()).filter(r => r.category === category);

      // Collect all unique segment names in this category
      const segmentNames = new Set<string>();
      monthRows.forEach(r => segmentNames.add(r.name));
      rangeRows.forEach(r => segmentNames.add(r.name));

      if (segmentNames.size === 0) continue;

      const zeroSeg = { revAct: 0, revBud: 0, revLy: 0, nightsAct: 0, nightsBud: 0, nightsLy: 0 };
      const isSegZero = (m: typeof zeroSeg, r: typeof zeroSeg) =>
        m.revAct === 0 && m.revBud === 0 && m.revLy === 0 &&
        m.nightsAct === 0 && m.nightsBud === 0 && m.nightsLy === 0 &&
        r.revAct === 0 && r.revBud === 0 && r.revLy === 0 &&
        r.nightsAct === 0 && r.nightsBud === 0 && r.nightsLy === 0;

      // Skip entire category if all segments are zero in both periods
      const categoryHasData = [...segmentNames].some(segName => {
        const m = monthRows.find(r => r.name === segName) || zeroSeg;
        const r = rangeRows.find(r => r.name === segName) || zeroSeg;
        return !isSegZero(m, r);
      });
      if (!categoryHasData) continue;

      // Category header
      const catHeader = sheet.addRow(new Array(totalCols).fill(''));
      catHeader.getCell(1).value = category;
      applyCategoryHeaderStyle(catHeader);
      sheet.mergeCells(catHeader.number, 1, catHeader.number, totalCols);

      const subMonthTotals = { revAct: 0, revBud: 0, revLy: 0, nightsAct: 0, nightsBud: 0, nightsLy: 0 };
      const subRangeTotals = { revAct: 0, revBud: 0, revLy: 0, nightsAct: 0, nightsBud: 0, nightsLy: 0 };

      for (const segName of segmentNames) {
        const mRow = monthRows.find(r => r.name === segName) || zeroSeg;
        const rRow = rangeRows.find(r => r.name === segName) || zeroSeg;

        if (isSegZero(mRow, rRow)) continue;

        const monthVals = this.extractMetricValues(mRow, metric);
        const rangeVals = this.extractMetricValues(rRow, metric);

        const values = this.buildRoomSegRow(segName, category, monthVals, rangeVals, metric);
        const excelRow = sheet.addRow(values);
        applyDataRowStyle(excelRow);
        this.styleRoomSegSeparators(excelRow);
        this.applyRoomSegNumFormats(excelRow, metric);

        subMonthTotals.revAct += mRow.revAct; subMonthTotals.revBud += mRow.revBud; subMonthTotals.revLy += mRow.revLy;
        subMonthTotals.nightsAct += mRow.nightsAct; subMonthTotals.nightsBud += mRow.nightsBud; subMonthTotals.nightsLy += mRow.nightsLy;
        subRangeTotals.revAct += rRow.revAct; subRangeTotals.revBud += rRow.revBud; subRangeTotals.revLy += rRow.revLy;
        subRangeTotals.nightsAct += rRow.nightsAct; subRangeTotals.nightsBud += rRow.nightsBud; subRangeTotals.nightsLy += rRow.nightsLy;
      }

      // Category subtotal
      const subMonthVals = this.extractMetricValues(subMonthTotals, metric);
      const subRangeVals = this.extractMetricValues(subRangeTotals, metric);
      const subValues = this.buildRoomSegRow(`${category} Total`, '', subMonthVals, subRangeVals, metric);
      const subRow = sheet.addRow(subValues);
      this.applySubtotalRowStyle(subRow, false);
      this.styleRoomSegSeparators(subRow);
      this.applyRoomSegNumFormats(subRow, metric);

      grandMonthTotals.revAct += subMonthTotals.revAct; grandMonthTotals.revBud += subMonthTotals.revBud; grandMonthTotals.revLy += subMonthTotals.revLy;
      grandMonthTotals.nightsAct += subMonthTotals.nightsAct; grandMonthTotals.nightsBud += subMonthTotals.nightsBud; grandMonthTotals.nightsLy += subMonthTotals.nightsLy;
      grandRangeTotals.revAct += subRangeTotals.revAct; grandRangeTotals.revBud += subRangeTotals.revBud; grandRangeTotals.revLy += subRangeTotals.revLy;
      grandRangeTotals.nightsAct += subRangeTotals.nightsAct; grandRangeTotals.nightsBud += subRangeTotals.nightsBud; grandRangeTotals.nightsLy += subRangeTotals.nightsLy;

      this.addBlankSeparatorRow(sheet, totalCols, 'roomSeg');
    }

    // Grand total
    const grandMonthVals = this.extractMetricValues(grandMonthTotals, metric);
    const grandRangeVals = this.extractMetricValues(grandRangeTotals, metric);
    const grandValues = this.buildRoomSegRow('Grand Total', '', grandMonthVals, grandRangeVals, metric);
    const grandRow = sheet.addRow(grandValues);
    this.applySubtotalRowStyle(grandRow, true);
    this.styleRoomSegSeparators(grandRow);
    this.applyRoomSegNumFormats(grandRow, metric);
  }

  /**
   * Style separator column (10) with blue-gray fill
   */
  private styleRoomSegSeparators(row: ExcelJS.Row): void {
    const cell = row.getCell(9);
    cell.fill = SEPARATOR_FILL;
    cell.value = '';
  }

  /**
   * Style the separator column (col 7) on department sheets
   */
  private styleDeptSeparator(row: ExcelJS.Row): void {
    const cell = row.getCell(8);
    cell.fill = SEPARATOR_FILL;
    cell.value = '';
  }

  /**
   * Apply subtotal or grand total row styling
   */
  private applySubtotalRowStyle(row: ExcelJS.Row, isGrandTotal: boolean): void {
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.fill = isGrandTotal ? SECTION_HEADER_FILL : SUBTOTAL_FILL;
      cell.font = isGrandTotal
        ? { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
        : { bold: true, size: 10 };
      cell.border = isGrandTotal ? TOTAL_ROW_BORDER : GROUP_SUBTOTAL_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
    });
    row.height = isGrandTotal ? 22 : 20;
  }

  /**
   * Apply number formatting to room segment data columns (18-col layout).
   * Month values: cols 3-5, 7-8; Range values: cols 11-13, 15-16.
   */
  private applyRoomSegNumFormats(row: ExcelJS.Row, metric?: 'revenue' | 'nights' | 'adr'): void {
    const fmt = metric === 'adr' ? '#,##0.00' : '#,##0';
    // Month side: cols 3, 5-7 (ly, actuals, budget, vsBud)
    [3, 5, 6, 7].forEach(col => {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') cell.numFmt = fmt;
    });
    // Range side: cols 10, 12-14 (ly, actuals, budget, vsBud)
    [10, 12, 13, 14].forEach(col => {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') cell.numFmt = fmt;
    });
  }
}

export default new ProteaReportPackService();
