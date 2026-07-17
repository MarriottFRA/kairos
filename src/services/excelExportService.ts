/**
 * Excel Export Service
 * ====================
 * Generates formatted Excel reports using ExcelJS.
 * Runs in the Electron main process.
 */

import ExcelJS from 'exceljs';
import * as db from '../local_db';
import { PLCalculationResult } from '../types/plReportTypes';

// ============================================================================
// TYPES
// ============================================================================

export interface ExcelExportConfig {
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
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ============================================================================
// STYLING HELPERS
// ============================================================================

// Tab color scheme for worksheet tabs
const TAB_COLOR_REPORT: Partial<ExcelJS.Color> = { argb: 'FF1E3A5F' };    // Dark blue - F90, Room Segments
const TAB_COLOR_HOTEL_TOTAL: Partial<ExcelJS.Color> = { argb: 'FF4A4A4A' }; // Dark charcoal - Hotel Total
const TAB_COLOR_GROUP_SUMMARY: Partial<ExcelJS.Color> = { argb: 'FF2D5F8A' }; // Medium navy - Group summaries
const TAB_COLOR_DEPARTMENT: Partial<ExcelJS.Color> = { argb: 'FF8899AA' };   // Blue-gray - Individual departments

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E3A5F' }  // Dark blue
};

const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },  // White
  size: 11
};

const SECTION_HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF4A4A4A' }  // Dark charcoal gray
};

const SECTION_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 11,
  color: { argb: 'FFFFFFFF' }  // White
};

const CATEGORY_HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF0F4F8' }  // Very light blue-gray
};

const CATEGORY_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10
};

const SEPARATOR_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF8899AA' }  // Blue-gray separator
};

const SUBTOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFDCE6F0' }  // Light blue for subtotals
};

// level_12 group header - slightly indented, subtle background
const GROUP_HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF5F7FA' }  // Very subtle blue-gray, lighter than category
};

const GROUP_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10,
  color: { argb: 'FF4A5568' }  // Dark gray
};

// level_12 group subtotal - subtle distinction from category subtotal
const GROUP_SUBTOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFEDF2F7' }  // Light blue-gray
};

const GROUP_SUBTOTAL_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10
};

// Category total header - medium navy with white text, strong visual separator
const CATEGORY_TOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF2D5F8A' }  // Medium navy
};

const CATEGORY_TOTAL_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10,
  color: { argb: 'FFFFFFFF' }  // White
};

const CATEGORY_TOTAL_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'medium', color: { argb: 'FF1E3A5F' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FF1E3A5F' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};

const GROUP_SUBTOTAL_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF1E3A5F' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FF1E3A5F' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};

const DATA_FONT: Partial<ExcelJS.Font> = {
  size: 10
};

const TOTAL_ROW_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'medium', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};

const BORDER_STYLE: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};

function applyHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  row.height = 24;
}

function applySectionHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = SECTION_HEADER_FILL;
    cell.font = SECTION_HEADER_FONT;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: 'middle' };
  });
  row.height = 28;
}

function applyCategoryHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = CATEGORY_HEADER_FILL;
    cell.font = CATEGORY_HEADER_FONT;
    cell.border = BORDER_STYLE;
  });
  row.height = 20;
}

function applyDataRowStyle(row: ExcelJS.Row, isHeader: boolean = false): void {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = isHeader ? { ...DATA_FONT, bold: true } : DATA_FONT;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
  });
}

function applyGroupHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = GROUP_HEADER_FILL;
    cell.font = GROUP_HEADER_FONT;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: 'middle' };
  });
  row.height = 18;
}

function applyGroupSubtotalStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.fill = GROUP_SUBTOTAL_FILL;
    cell.font = GROUP_SUBTOTAL_FONT;
    cell.border = GROUP_SUBTOTAL_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
  });
  row.height = 18;
}

function applyCategorySubtotalStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.fill = CATEGORY_TOTAL_FILL;
    cell.font = CATEGORY_TOTAL_FONT;
    cell.border = CATEGORY_TOTAL_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
  });
  row.height = 22;
}

function formatNumber(value: number | null, decimals: number = 0): number | string {
  if (value === null || value === undefined) return '';
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function formatPercentage(value: number | null): string {
  if (value === null || value === undefined) return '';
  // Values from the engine are already in 0-100 scale (e.g. 72.5 for 72.5%)
  return `${value.toFixed(1)}%`;
}

function sanitizeSheetName(name: string): string {
  // Excel sheet names: max 31 chars, no special chars: \ / * ? : [ ]
  // department_description_detail_level_max already contains dept name + ID
  const sanitized = name.replace(/[\\/*?:\[\]]/g, '').trim();
  return sanitized.substring(0, 31) || 'Sheet';
}

function getRangeLabel(
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
// EXCEL EXPORT SERVICE CLASS
// ============================================================================

const EXCEL_EXCLUDED_DEPARTMENTS = db.NON_OPERATING_EXCLUDED_DEPARTMENTS;

class ExcelExportService {
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
  async generateReport(config: ExcelExportConfig, savePath: string): Promise<void> {
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

    // 1. Create F90 Report worksheet
    await this.createF90Worksheet(workbook, config);
    this.sheetRegistry.push({ type: 'sheet', sheetName: 'F90 Report', indent: false });

    // 2. Create Room Segments worksheet
    await this.createRoomSegmentWorksheet(workbook, config);
    this.sheetRegistry.push({ type: 'sheet', sheetName: 'Room Segments', indent: false });

    // 3. Fetch departments once -- used by department tabs
    const departments = (await db.getDepartmentsWithDataForOU(config.ou, config.version))
      .filter(d => !EXCEL_EXCLUDED_DEPARTMENTS.has(d.baseDepartment));

    // 4. Create Hotel Total worksheet (queries all Lodging Operations departments directly)
    await this.createHotelTotalWorksheet(workbook, config);
    this.sheetRegistry.push({ type: 'sheet', sheetName: 'HOTEL TOTAL', indent: false });

    // 5. Create Department worksheets (using pre-fetched departments)
    await this.createDepartmentWorksheets(workbook, config, departments);

    // 6. Create Cover Page (last to build, positioned first via orderNo)
    this.createCoverPageWorksheet(workbook, config);

    // Save the workbook
    await workbook.xlsx.writeFile(savePath);
  }

  /**
   * Adds a title header block (report name, hotel name + month, generation timestamp) to the top of a sheet.
   * Inserts 3 rows before the existing column headers.
   */
  private addSheetTitleHeader(sheet: ExcelJS.Worksheet, config: ExcelExportConfig, totalCols: number, reportName: string): void {
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
    config: ExcelExportConfig
  ): Promise<void> {
    const sheet = workbook.addWorksheet('F90 Report', { properties: { tabColor: TAB_COLOR_REPORT } });

    // Set column widths
    sheet.columns = [
      { key: 'label', width: 45 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mVsBudPct', width: 12 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLy', width: 14 },
      { key: 'mVsLyPct', width: 12 },
      { key: 'sep', width: 2 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rVsBudPct', width: 12 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLy', width: 14 },
      { key: 'rVsLyPct', width: 12 },
      { key: 'comments', width: 35 },
    ];

    const TOTAL_COLS = 17;

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, TOTAL_COLS, 'F90 Report');

    // Period group headers
    const groupRow = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(10).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 8);
    sheet.mergeCells(groupRow.number, 10, groupRow.number, 16);
    applyHeaderStyle(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'P&L Line',
      'Actuals', 'Budget', 'vs Bud', 'vs Bud %', 'LY', 'vs LY', 'vs LY %',
      '',
      'Actuals', 'Budget', 'vs Bud', 'vs Bud %', 'LY', 'vs LY', 'vs LY %',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);

    // Fetch Selected Month data
    const monthDataJson = await db.getF90PLData(
      config.selectedMonth,
      config.selectedYear,
      config.selectedMonth,
      config.selectedYear,
      config.ou,
      config.version
    );
    const monthData: PLCalculationResult[] = JSON.parse(monthDataJson);

    // Fetch YTD data
    const ytdDataJson = await db.getF90PLData(
      config.ytdStartMonth,
      config.ytdStartYear,
      config.ytdEndMonth,
      config.ytdEndYear,
      config.ou,
      config.version
    );
    const ytdData: PLCalculationResult[] = JSON.parse(ytdDataJson);

    // Add data rows with month and range side by side
    this.addF90DataRows(sheet, monthData, ytdData);

    // Freeze panes (2 title rows + 2 header rows)
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];
  }

  /**
   * Helper to add F90 data rows with month and range data side by side
   */
  private addF90DataRows(sheet: ExcelJS.Worksheet, monthData: PLCalculationResult[], rangeData: PLCalculationResult[]): void {
    // Build lookup maps keyed by label so that rows align correctly even when
    // filterZeroRows removes different rows from each array.
    const monthByLabel = new Map<string, PLCalculationResult>();
    for (const m of monthData) {
      if (m.label) monthByLabel.set(m.label, m);
    }

    // Use rangeData order as the primary driver — the range period is always a
    // superset of the month period, so its filtered row list preserves config
    // order for every row that has data in either dataset.
    const allRows: { mRow: PLCalculationResult | null; rRow: PLCalculationResult | null; primary: PLCalculationResult }[] = [];

    for (const rRow of rangeData) {
      const mRow = rRow.label ? monthByLabel.get(rRow.label) || null : null;
      allRows.push({ mRow, rRow, primary: rRow });
    }

    for (const { mRow, rRow, primary } of allRows) {
      // Skip empty spacing rows
      if (primary.type === 'header' && !primary.label) continue;

      const indent = '  '.repeat(primary.indentLevel || 0);
      const isPercentage = primary.formatting === 'percentage';

      const excelRow = sheet.addRow({
        label: indent + primary.label,
        mAct: mRow ? (isPercentage ? formatPercentage(mRow.actuals) : formatNumber(mRow.actuals)) : '',
        mBud: mRow ? (isPercentage ? formatPercentage(mRow.budget) : formatNumber(mRow.budget)) : '',
        mVsBud: mRow ? (isPercentage
          ? `${((mRow.actuals ?? 0) - (mRow.budget ?? 0)).toFixed(1)} pts`
          : formatNumber(mRow.vs_bud)) : '',
        mVsBudPct: mRow ? (isPercentage ? '' : formatPercentage(mRow.vs_bud_pct)) : '',
        mLy: mRow ? (isPercentage ? formatPercentage(mRow.ly) : formatNumber(mRow.ly)) : '',
        mVsLy: mRow ? (isPercentage
          ? `${((mRow.actuals ?? 0) - (mRow.ly ?? 0)).toFixed(1)} pts`
          : formatNumber(mRow.vs_ly)) : '',
        mVsLyPct: mRow ? (isPercentage ? '' : formatPercentage(mRow.vs_ly_pct)) : '',
        sep: '',
        rAct: rRow ? (isPercentage ? formatPercentage(rRow.actuals) : formatNumber(rRow.actuals)) : '',
        rBud: rRow ? (isPercentage ? formatPercentage(rRow.budget) : formatNumber(rRow.budget)) : '',
        rVsBud: rRow ? (isPercentage
          ? `${((rRow.actuals ?? 0) - (rRow.budget ?? 0)).toFixed(1)} pts`
          : formatNumber(rRow.vs_bud)) : '',
        rVsBudPct: rRow ? (isPercentage ? '' : formatPercentage(rRow.vs_bud_pct)) : '',
        rLy: rRow ? (isPercentage ? formatPercentage(rRow.ly) : formatNumber(rRow.ly)) : '',
        rVsLy: rRow ? (isPercentage
          ? `${((rRow.actuals ?? 0) - (rRow.ly ?? 0)).toFixed(1)} pts`
          : formatNumber(rRow.vs_ly)) : '',
        rVsLyPct: rRow ? (isPercentage ? '' : formatPercentage(rRow.vs_ly_pct)) : '',
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
      const sepCell = excelRow.getCell(9);
      sepCell.fill = SEPARATOR_FILL;
      sepCell.value = '';

      // Apply number formatting to both sides
      if (!isPercentage) {
        [2, 3, 4, 6, 7, 10, 11, 12, 14, 15].forEach(col => {
          const cell = excelRow.getCell(col);
          if (typeof cell.value === 'number') {
            cell.numFmt = '#,##0';
          }
        });
      }
    }
  }

  /**
   * Creates the Hotel Total worksheet aggregating all lodging operations departments.
   * Appears before individual department sheets as a hotel-wide summary.
   */
  private async createHotelTotalWorksheet(
    workbook: ExcelJS.Workbook,
    config: ExcelExportConfig
  ): Promise<void> {
    // Fetch hotel-wide totals across all Lodging Operations departments (excluding non-reportable depts)
    const excludedDepts = [...EXCEL_EXCLUDED_DEPARTMENTS];
    let [monthDetailData, rangeDetailData] = await Promise.all([
      db.getAllDepartmentDetailData(
        config.ou,
        config.selectedMonth, config.selectedYear,
        config.selectedMonth, config.selectedYear,
        config.version,
        excludedDepts
      ),
      db.getAllDepartmentDetailData(
        config.ou,
        config.ytdStartMonth, config.ytdStartYear,
        config.ytdEndMonth, config.ytdEndYear,
        config.version,
        excludedDepts
      )
    ]);

    if (rangeDetailData.length === 0 && monthDetailData.length === 0) return;

    // Suppress accounts that are zero across actuals/budget/ly in BOTH month AND range
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

    const sheet = workbook.addWorksheet('HOTEL TOTAL', { properties: { tabColor: TAB_COLOR_HOTEL_TOTAL } });
    const totalCols = 13;

    sheet.columns = [
      { key: 'account', width: 45 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLy', width: 14 },
      { key: 'sep', width: 2 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLy', width: 14 },
      { key: 'comments', width: 35 },
    ];

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, totalCols, 'Hotel Total');

    // Period group headers
    const groupRow = sheet.addRow(new Array(totalCols).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(8).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 6);
    sheet.mergeCells(groupRow.number, 8, groupRow.number, 12);
    applyHeaderStyle(groupRow);
    this.styleDeptSeparator(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'Account',
      'Actuals', 'Budget', 'vs Bud', 'LY', 'vs LY',
      '',
      'Actuals', 'Budget', 'vs Bud', 'LY', 'vs LY',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);
    this.styleDeptSeparator(headerRow);

    // Combined month + range data (side by side)
    this.addDepartmentDataSection(sheet, monthDetailData, rangeDetailData, totalCols);

    // Freeze panes (2 title rows + 2 header rows)
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];
  }

  /**
   * Creates department worksheets grouped by level_7.
   * Multi-department groups get a summary sheet followed by individual detail sheets.
   * Single-department groups get only their detail sheet.
   */
  private async createDepartmentWorksheets(
    workbook: ExcelJS.Workbook,
    config: ExcelExportConfig,
    departments: Array<{ baseDepartment: string; departmentName: string; level7Group: string | null }>
  ): Promise<void> {
    // Group departments by level_7
    const groupMap = new Map<string, typeof departments>();
    for (const dept of departments) {
      const groupKey = dept.level7Group || dept.baseDepartment;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, []);
      }
      groupMap.get(groupKey)!.push(dept);
    }

    // Track used sheet names to avoid duplicates
    const usedSheetNames = new Set<string>();

    // Iterate groups: summary sheet first (if multi-dept), then individual sheets
    for (const [groupName, groupDepts] of groupMap) {
      const isMultiDeptGroup = groupDepts.length > 1;

      // Register group header in TOC for every group (including singletons)
      this.sheetRegistry.push({ type: 'groupHeader', sheetName: '', groupName, indent: false });

      if (isMultiDeptGroup) {
        // Create group summary sheet for multi-department groups
        const summaryName = await this.createGroupSummaryWorksheet(
          workbook, config, groupName, groupDepts, usedSheetNames
        );
        if (summaryName) {
          this.sheetRegistry.push({ type: 'sheet', sheetName: summaryName, indent: true });
        }

        // Create individual department detail sheets (only when detail tabs enabled)
        if (config.generateDetailTabs) {
          for (const dept of groupDepts) {
            const deptSheetName = await this.createSingleDepartmentWorksheet(
              workbook, config, dept, usedSheetNames
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
        const summaryName = await this.createGroupSummaryWorksheet(
          workbook, config, groupName, groupDepts, usedSheetNames
        );
        if (summaryName) {
          this.sheetRegistry.push({ type: 'sheet', sheetName: summaryName, indent: true });
        }

        // Individual department detail sheet (only when detail tabs enabled)
        if (config.generateDetailTabs) {
          const deptSheetName = await this.createSingleDepartmentWorksheet(
            workbook, config, dept, usedSheetNames
          );
          if (deptSheetName) {
            this.sheetRegistry.push({ type: 'sheet', sheetName: deptSheetName, indent: true });
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
    config: ExcelExportConfig,
    groupName: string,
    groupDepts: Array<{ baseDepartment: string; departmentName: string; level7Group: string | null }>,
    usedSheetNames: Set<string>
  ): Promise<string | null> {
    const deptIds = groupDepts.map(d => d.baseDepartment);

    // Fetch aggregated data for the group (month + range in parallel)
    let [monthDetailData, rangeDetailData] = await Promise.all([
      db.getGroupDepartmentDetailData(
        config.ou,
        deptIds,
        config.selectedMonth,
        config.selectedYear,
        config.selectedMonth,
        config.selectedYear,
        config.version
      ),
      db.getGroupDepartmentDetailData(
        config.ou,
        deptIds,
        config.ytdStartMonth,
        config.ytdStartYear,
        config.ytdEndMonth,
        config.ytdEndYear,
        config.version
      )
    ]);

    if (rangeDetailData.length === 0 && monthDetailData.length === 0) {
      return null;
    }

    // Suppress accounts that are zero across actuals/budget/ly in BOTH month AND range
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

    let sheetName = sanitizeSheetName(`${groupName} Summary`.toUpperCase());
    let finalName = sheetName;
    let counter = 1;
    while (usedSheetNames.has(finalName.toLowerCase())) {
      const suffix = ` (${counter})`;
      finalName = sheetName.substring(0, 31 - suffix.length) + suffix;
      counter++;
    }
    usedSheetNames.add(finalName.toLowerCase());

    const sheet = workbook.addWorksheet(finalName, { properties: { tabColor: TAB_COLOR_GROUP_SUMMARY } });
    const totalCols = 13;

    sheet.columns = [
      { key: 'account', width: 45 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLy', width: 14 },
      { key: 'sep', width: 2 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLy', width: 14 },
      { key: 'comments', width: 35 },
    ];

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, totalCols, groupName);

    // Period group headers
    const groupRow = sheet.addRow(new Array(totalCols).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(8).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 6);
    sheet.mergeCells(groupRow.number, 8, groupRow.number, 12);
    applyHeaderStyle(groupRow);
    this.styleDeptSeparator(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'Account',
      'Actuals', 'Budget', 'vs Bud', 'LY', 'vs LY',
      '',
      'Actuals', 'Budget', 'vs Bud', 'LY', 'vs LY',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);
    this.styleDeptSeparator(headerRow);

    // Combined month + range data (side by side)
    this.addDepartmentDataSection(sheet, monthDetailData, rangeDetailData, totalCols, {
      collapseRevenueDetail: !config.generateDetailTabs && groupName === 'Rooms and Reservation'
    });

    // Freeze panes (2 title rows + 2 header rows)
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];

    return finalName;
  }

  /**
   * Creates a single department detail worksheet with account-level data
   */
  private async createSingleDepartmentWorksheet(
    workbook: ExcelJS.Workbook,
    config: ExcelExportConfig,
    dept: { baseDepartment: string; departmentName: string; level7Group: string | null },
    usedSheetNames: Set<string>,
    nameOverride?: string
  ): Promise<string | null> {
    let [monthDetailData, rangeDetailData] = await Promise.all([
      db.getDepartmentDetailData(
        config.ou,
        dept.baseDepartment,
        config.selectedMonth,
        config.selectedYear,
        config.selectedMonth,
        config.selectedYear,
        config.version
      ),
      db.getDepartmentDetailData(
        config.ou,
        dept.baseDepartment,
        config.ytdStartMonth,
        config.ytdStartYear,
        config.ytdEndMonth,
        config.ytdEndYear,
        config.version
      )
    ]);

    if (rangeDetailData.length === 0 && monthDetailData.length === 0) {
      return null;
    }

    // Suppress accounts that are zero across actuals/budget/ly in BOTH month AND range
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

    let sheetName = sanitizeSheetName(nameOverride || dept.departmentName || dept.baseDepartment);
    let finalName = sheetName;
    let counter = 1;
    while (usedSheetNames.has(finalName.toLowerCase())) {
      const suffix = ` (${counter})`;
      finalName = sheetName.substring(0, 31 - suffix.length) + suffix;
      counter++;
    }
    usedSheetNames.add(finalName.toLowerCase());

    const sheet = workbook.addWorksheet(finalName, { properties: { tabColor: TAB_COLOR_DEPARTMENT } });
    const totalCols = 13;

    sheet.columns = [
      { key: 'account', width: 45 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLy', width: 14 },
      { key: 'sep', width: 2 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLy', width: 14 },
      { key: 'comments', width: 35 },
    ];

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, totalCols, nameOverride || dept.departmentName);

    // Period group headers
    const groupRow = sheet.addRow(new Array(totalCols).fill(''));
    groupRow.getCell(2).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(8).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 2, groupRow.number, 6);
    sheet.mergeCells(groupRow.number, 8, groupRow.number, 12);
    applyHeaderStyle(groupRow);
    this.styleDeptSeparator(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'Account',
      'Actuals', 'Budget', 'vs Bud', 'LY', 'vs LY',
      '',
      'Actuals', 'Budget', 'vs Bud', 'LY', 'vs LY',
      'Comments'
    ]);
    applyHeaderStyle(headerRow);
    this.styleDeptSeparator(headerRow);

    // Combined month + range data (side by side)
    this.addDepartmentDataSection(sheet, monthDetailData, rangeDetailData, totalCols);

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
    config: ExcelExportConfig
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
        row.getCell(1).value = (entry.groupName || '').toUpperCase();
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
    options?: { collapseRevenueDetail?: boolean }
  ): void {
    const categories = ['Revenue', 'Cost of Sales', 'Payroll', 'Controllables', 'Other', 'Stats'];
    const ABS_COLS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]; // absolute value column indices (both sides)

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
        mAct: formatNumber(mTotActuals),
        mBud: formatNumber(mTotBudget),
        mVsBud: formatNumber(mTotVsBud),
        mLy: formatNumber(mTotLy),
        mVsLy: formatNumber(mTotVsLy),
        sep: '',
        rAct: formatNumber(rTotActuals),
        rBud: formatNumber(rTotBudget),
        rVsBud: formatNumber(rTotVsBud),
        rLy: formatNumber(rTotLy),
        rVsLy: formatNumber(rTotVsLy),
        comments: ''
      });
      styleFn(headerRow);
      this.styleDeptSeparator(headerRow);
      applyNumberFormats(headerRow);
    };

    for (const category of categories) {
      const mCategoryRows = monthData.filter(r => r.category === category);
      const rCategoryRows = rangeData.filter(r => r.category === category);
      if (mCategoryRows.length === 0 && rCategoryRows.length === 0) continue;

      const isStats = category === 'Stats';
      const isRevenue = category === 'Revenue';
      const sign = isRevenue ? -1 : 1;

      // Category header row WITH totals
      addHeaderWithTotals(`Total ${category}`, mCategoryRows, rCategoryRows, applyCategorySubtotalStyle, isStats, sign);

      // When collapsing revenue detail, show only the total line
      if (isRevenue && options?.collapseRevenueDetail) {
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
            mAct: formatNumber(mRow.actuals * sign),
            mBud: formatNumber(mRow.budget * sign),
            mVsBud: formatNumber(mRow.vsBud * sign),
            mLy: formatNumber(mRow.ly * sign),
            mVsLy: formatNumber(mRow.vsLy * sign),
            sep: '',
            rAct: formatNumber(rRow.actuals * sign),
            rBud: formatNumber(rRow.budget * sign),
            rVsBud: formatNumber(rRow.vsBud * sign),
            rLy: formatNumber(rRow.ly * sign),
            rVsLy: formatNumber(rRow.vsLy * sign),
            comments: ''
          });

          applyDataRowStyle(excelRow);
          this.styleDeptSeparator(excelRow);
          applyNumberFormats(excelRow);
        }
      } else {
        // Non-stats: group accounts by level_12
        const mLevel12Map = new Map<string, any[]>();
        for (const row of mCategoryRows) {
          const groupKey = row.level12Group || `Other ${category}`;
          if (!mLevel12Map.has(groupKey)) mLevel12Map.set(groupKey, []);
          mLevel12Map.get(groupKey)!.push(row);
        }
        const rLevel12Map = new Map<string, any[]>();
        for (const row of rCategoryRows) {
          const groupKey = row.level12Group || `Other ${category}`;
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

          // level_12 group header WITH totals (indented 2 spaces)
          addHeaderWithTotals(`  Total ${groupName}`, mGroupRows, rGroupRows, applyGroupSubtotalStyle, false, sign);

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
              mAct: formatNumber(mRow.actuals * sign),
              mBud: formatNumber(mRow.budget * sign),
              mVsBud: formatNumber(mRow.vsBud * sign),
              mLy: formatNumber(mRow.ly * sign),
              mVsLy: formatNumber(mRow.vsLy * sign),
              sep: '',
              rAct: formatNumber(rRow.actuals * sign),
              rBud: formatNumber(rRow.budget * sign),
              rVsBud: formatNumber(rRow.vsBud * sign),
              rLy: formatNumber(rRow.ly * sign),
              rVsLy: formatNumber(rRow.vsLy * sign),
              comments: ''
            });

            applyDataRowStyle(excelRow);
            this.styleDeptSeparator(excelRow);
            applyNumberFormats(excelRow);
          }

          // Blank row separator after each level_12 sub-group
          this.addBlankSeparatorRow(sheet, totalCols);
        }
      }

      // Blank row separator after category
      this.addBlankSeparatorRow(sheet, totalCols);
    }

    // --- Department Profit & GOP% ---
    // Revenue is stored as negative (credit-balance), expenses as positive (debit-balance)
    // Profit = -(Revenue + Expenses), displayed as positive when profitable
    const mRevenueRows = monthData.filter(r => r.category === 'Revenue');
    const rRevenueRows = rangeData.filter(r => r.category === 'Revenue');
    const expenseCategories = ['Cost of Sales', 'Payroll', 'Controllables', 'Other'];
    const mExpenseRows = monthData.filter(r => expenseCategories.includes(r.category));
    const rExpenseRows = rangeData.filter(r => expenseCategories.includes(r.category));

    if (mRevenueRows.length > 0 || rRevenueRows.length > 0) {
      // Month profit
      const mRevAct = sumField(mRevenueRows, 'actuals');
      const mRevBud = sumField(mRevenueRows, 'budget');
      const mRevLy = sumField(mRevenueRows, 'ly');
      const mExpAct = sumField(mExpenseRows, 'actuals');
      const mExpBud = sumField(mExpenseRows, 'budget');
      const mExpLy = sumField(mExpenseRows, 'ly');
      const mProfitAct = -(mRevAct + mExpAct);
      const mProfitBud = -(mRevBud + mExpBud);
      const mProfitLy = -(mRevLy + mExpLy);

      // Range profit
      const rRevAct = sumField(rRevenueRows, 'actuals');
      const rRevBud = sumField(rRevenueRows, 'budget');
      const rRevLy = sumField(rRevenueRows, 'ly');
      const rExpAct = sumField(rExpenseRows, 'actuals');
      const rExpBud = sumField(rExpenseRows, 'budget');
      const rExpLy = sumField(rExpenseRows, 'ly');
      const rProfitAct = -(rRevAct + rExpAct);
      const rProfitBud = -(rRevBud + rExpBud);
      const rProfitLy = -(rRevLy + rExpLy);

      // Department Profit row (subtotal style)
      const profitRow = sheet.addRow({
        account: 'Department Profit',
        mAct: formatNumber(mProfitAct),
        mBud: formatNumber(mProfitBud),
        mVsBud: formatNumber(mProfitAct - mProfitBud),
        mLy: formatNumber(mProfitLy),
        mVsLy: formatNumber(mProfitAct - mProfitLy),
        sep: '',
        rAct: formatNumber(rProfitAct),
        rBud: formatNumber(rProfitBud),
        rVsBud: formatNumber(rProfitAct - rProfitBud),
        rLy: formatNumber(rProfitLy),
        rVsLy: formatNumber(rProfitAct - rProfitLy),
        comments: ''
      });
      profitRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = SUBTOTAL_FILL;
        cell.font = { ...DATA_FONT, bold: true };
        cell.border = TOTAL_ROW_BORDER;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(profitRow);
      ABS_COLS.forEach(col => {
        const cell = profitRow.getCell(col);
        if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      });

      // GOP% row
      const mRevTotal = -mRevAct;
      const mGopAct = mRevTotal !== 0 ? (mProfitAct / mRevTotal) * 100 : 0;
      const mGopBud = -mRevBud !== 0 ? (mProfitBud / -mRevBud) * 100 : 0;
      const mGopLy = -mRevLy !== 0 ? (mProfitLy / -mRevLy) * 100 : 0;

      const rRevTotal = -rRevAct;
      const rGopAct = rRevTotal !== 0 ? (rProfitAct / rRevTotal) * 100 : 0;
      const rGopBud = -rRevBud !== 0 ? (rProfitBud / -rRevBud) * 100 : 0;
      const rGopLy = -rRevLy !== 0 ? (rProfitLy / -rRevLy) * 100 : 0;

      const gopRow = sheet.addRow({
        account: 'GOP %',
        mAct: formatPercentage(mGopAct),
        mBud: formatPercentage(mGopBud),
        mVsBud: `${(mGopAct - mGopBud).toFixed(1)} pts`,
        mLy: formatPercentage(mGopLy),
        mVsLy: `${(mGopAct - mGopLy).toFixed(1)} pts`,
        sep: '',
        rAct: formatPercentage(rGopAct),
        rBud: formatPercentage(rGopBud),
        rVsBud: `${(rGopAct - rGopBud).toFixed(1)} pts`,
        rLy: formatPercentage(rGopLy),
        rVsLy: `${(rGopAct - rGopLy).toFixed(1)} pts`,
        comments: ''
      });
      gopRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = SUBTOTAL_FILL;
        cell.font = { ...DATA_FONT, bold: true };
        cell.border = TOTAL_ROW_BORDER;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(gopRow);
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

      const totalRow = sheet.addRow({
        account: 'Total',
        mAct: formatNumber(mTotAct),
        mBud: formatNumber(mTotBud),
        mVsBud: formatNumber(mTotAct - mTotBud),
        mLy: formatNumber(mTotLy),
        mVsLy: formatNumber(mTotAct - mTotLy),
        sep: '',
        rAct: formatNumber(rTotAct),
        rBud: formatNumber(rTotBud),
        rVsBud: formatNumber(rTotAct - rTotBud),
        rLy: formatNumber(rTotLy),
        rVsLy: formatNumber(rTotAct - rTotLy),
        comments: ''
      });
      totalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = SUBTOTAL_FILL;
        cell.font = { ...DATA_FONT, bold: true };
        cell.border = TOTAL_ROW_BORDER;
        cell.alignment = { vertical: 'middle', horizontal: colNumber > 1 ? 'right' : undefined };
      });
      this.styleDeptSeparator(totalRow);
      ABS_COLS.forEach(col => {
        const cell = totalRow.getCell(col);
        if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      });
    }
  }

  /**
   * Creates the Room Segments worksheet with Month/Range side by side, Revenue/Nights/ADR as row sections
   */
  private async createRoomSegmentWorksheet(
    workbook: ExcelJS.Workbook,
    config: ExcelExportConfig
  ): Promise<void> {
    const sheet = workbook.addWorksheet('Room Segments', { properties: { tabColor: TAB_COLOR_REPORT } });
    const TOTAL_COLS = 18;

    // 18 columns: Segment, Category, Month(7), Sep, Range(7), Comments
    sheet.columns = [
      { key: 'segment', width: 35 },
      { key: 'category', width: 15 },
      { key: 'mAct', width: 14 },
      { key: 'mBud', width: 14 },
      { key: 'mVsBud', width: 14 },
      { key: 'mVsBudPct', width: 12 },
      { key: 'mLy', width: 14 },
      { key: 'mVsLy', width: 14 },
      { key: 'mVsLyPct', width: 12 },
      { key: 'sep', width: 2 },
      { key: 'rAct', width: 14 },
      { key: 'rBud', width: 14 },
      { key: 'rVsBud', width: 14 },
      { key: 'rVsBudPct', width: 12 },
      { key: 'rLy', width: 14 },
      { key: 'rVsLy', width: 14 },
      { key: 'rVsLyPct', width: 12 },
      { key: 'comments', width: 35 },
    ];

    // Title header rows (report name, hotel name + timestamp)
    this.addSheetTitleHeader(sheet, config, TOTAL_COLS, 'Room Segments');

    // Period group headers
    const groupRow = sheet.addRow(new Array(TOTAL_COLS).fill(''));
    groupRow.getCell(3).value = `Selected Month: ${MONTH_NAMES[config.selectedMonth - 1]} ${config.selectedYear}`;
    groupRow.getCell(11).value = getRangeLabel(config.ytdStartMonth, config.ytdStartYear, config.ytdEndMonth, config.ytdEndYear);
    sheet.mergeCells(groupRow.number, 3, groupRow.number, 9);
    sheet.mergeCells(groupRow.number, 11, groupRow.number, 17);
    applyHeaderStyle(groupRow);
    this.styleRoomSegSeparators(groupRow);

    // Column sub-headers
    const headerRow = sheet.addRow([
      'Segment', 'Category',
      'Actuals', 'Budget', 'vs Bud', 'vs Bud %', 'LY', 'vs LY', 'vs LY %',
      '',
      'Actuals', 'Budget', 'vs Bud', 'vs Bud %', 'LY', 'vs LY', 'vs LY %',
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

    this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'revenue', 'consolidated', TOTAL_COLS, { hideZeroRows: true });

    if (config.generateDetailTabs) {
      this.addBlankSeparatorRow(sheet, TOTAL_COLS, 'roomSeg');

      const revDetailHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
      revDetailHeader.getCell(1).value = 'Detail by Day Type';
      applySectionHeaderStyle(revDetailHeader);
      sheet.mergeCells(revDetailHeader.number, 1, revDetailHeader.number, TOTAL_COLS);

      this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'revenue', 'detail', TOTAL_COLS, { hideZeroRows: true });
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

    this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'nights', 'consolidated', TOTAL_COLS, { hideZeroRows: true });

    if (config.generateDetailTabs) {
      this.addBlankSeparatorRow(sheet, TOTAL_COLS, 'roomSeg');

      const nightsDetailHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
      nightsDetailHeader.getCell(1).value = 'Detail by Day Type';
      applySectionHeaderStyle(nightsDetailHeader);
      sheet.mergeCells(nightsDetailHeader.number, 1, nightsDetailHeader.number, TOTAL_COLS);

      this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'nights', 'detail', TOTAL_COLS, { hideZeroRows: true });
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

    this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'adr', 'consolidated', TOTAL_COLS, { hideZeroRows: true });

    if (config.generateDetailTabs) {
      this.addBlankSeparatorRow(sheet, TOTAL_COLS, 'roomSeg');

      const adrDetailHeader = sheet.addRow(new Array(TOTAL_COLS).fill(''));
      adrDetailHeader.getCell(1).value = 'Detail by Day Type';
      applySectionHeaderStyle(adrDetailHeader);
      sheet.mergeCells(adrDetailHeader.number, 1, adrDetailHeader.number, TOTAL_COLS);

      this.addRoomSegMetricSection(sheet, monthSegmentData, rangeSegmentData, 'adr', 'detail', TOTAL_COLS, { hideZeroRows: true });
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
   * Check if both month and range aggregated rows are entirely zero across all metrics.
   * Used to hide zero rows in consolidated mode.
   */
  private isSegmentAllZeros(
    mRow: { revAct: number; revBud: number; revLy: number; nightsAct: number; nightsBud: number; nightsLy: number },
    rRow: { revAct: number; revBud: number; revLy: number; nightsAct: number; nightsBud: number; nightsLy: number }
  ): boolean {
    return mRow.revAct === 0 && mRow.revBud === 0 && mRow.revLy === 0
        && mRow.nightsAct === 0 && mRow.nightsBud === 0 && mRow.nightsLy === 0
        && rRow.revAct === 0 && rRow.revBud === 0 && rRow.revLy === 0
        && rRow.nightsAct === 0 && rRow.nightsBud === 0 && rRow.nightsLy === 0;
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
      formatNumber(monthVals.actuals, decimals), formatNumber(monthVals.budget, decimals),
      formatNumber(mVar.vsBud, decimals), formatPercentage(mVar.vsBudPct),
      formatNumber(monthVals.ly, decimals), formatNumber(mVar.vsLy, decimals),
      formatPercentage(mVar.vsLyPct),
      '',
      formatNumber(rangeVals.actuals, decimals), formatNumber(rangeVals.budget, decimals),
      formatNumber(rVar.vsBud, decimals), formatPercentage(rVar.vsBudPct),
      formatNumber(rangeVals.ly, decimals), formatNumber(rVar.vsLy, decimals),
      formatPercentage(rVar.vsLyPct),
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
    totalCols: number,
    options?: { hideZeroRows?: boolean }
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

      const zeroRow = { revAct: 0, revBud: 0, revLy: 0, nightsAct: 0, nightsBud: 0, nightsLy: 0 };

      // Skip entire category if all segments are zero on both sides
      if (options?.hideZeroRows) {
        const hasNonZero = [...segmentNames].some(segName => {
          const m = monthRows.find(r => r.name === segName) || zeroRow;
          const r = rangeRows.find(r => r.name === segName) || zeroRow;
          return !this.isSegmentAllZeros(m, r);
        });
        if (!hasNonZero) continue;
      }

      // Category header
      const catHeader = sheet.addRow(new Array(totalCols).fill(''));
      catHeader.getCell(1).value = category;
      applyCategoryHeaderStyle(catHeader);
      sheet.mergeCells(catHeader.number, 1, catHeader.number, totalCols);

      const subMonthTotals = { revAct: 0, revBud: 0, revLy: 0, nightsAct: 0, nightsBud: 0, nightsLy: 0 };
      const subRangeTotals = { revAct: 0, revBud: 0, revLy: 0, nightsAct: 0, nightsBud: 0, nightsLy: 0 };

      for (const segName of segmentNames) {
        const mRow = monthRows.find(r => r.name === segName) || zeroRow;
        const rRow = rangeRows.find(r => r.name === segName) || zeroRow;

        if (options?.hideZeroRows && this.isSegmentAllZeros(mRow, rRow)) continue;

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
   * Style the separator column (col 7) on department sheets
   */
  private styleDeptSeparator(row: ExcelJS.Row): void {
    const cell = row.getCell(7);
    cell.fill = SEPARATOR_FILL;
    cell.value = '';
  }

  /**
   * Style separator column (10) with blue-gray fill
   */
  private styleRoomSegSeparators(row: ExcelJS.Row): void {
    const cell = row.getCell(10);
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
    // Month side: cols 3-5, 7-8 (actuals, budget, vsBud, ly, vsLy)
    [3, 4, 5, 7, 8].forEach(col => {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') cell.numFmt = fmt;
    });
    // Range side: cols 11-13, 15-16 (actuals, budget, vsBud, ly, vsLy)
    [11, 12, 13, 15, 16].forEach(col => {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') cell.numFmt = fmt;
    });
  }
}

export default new ExcelExportService();
