/**
 * Read the legacy Excel "Payroll Budget Tool" (v3.6.x) into plain data.
 *
 * Strictly a reader: it pulls cells and formulas off the five sheets that carry
 * input, and interprets nothing. All the judgement — which blocks are in use,
 * what a percentage multiplies against, how a column maps to a field — lives in
 * analyze.ts, so this file stays a stable description of the workbook's shape.
 *
 * Layout (verified against "Payroll Budget Tool" 3.6.1 and 3.6.3):
 *   Associate Details  row 2 = block band names, row 3 = column names,
 *                      row 4+ = one row per associate. Columns are fixed WITHIN
 *                      a version — the VBA engine itself indexes them by number
 *                      (see `Base_Single_Month_Column = 31` and friends in OLD
 *                      VBA Engine.txt) — but NOT across versions: 3.6.1 has no
 *                      Overtime band, so its DR..DX are 3.6.3's Custom-1 months
 *                      and everything from DY onward sits seven columns left.
 *                      This reader stays positional and reports the version and
 *                      the header rows; `layout.ts` decides which map applies.
 *   Settings           B31 full-time weekly hours, B4 entered year,
 *                      B29 the tool's own version, B9:B24 + B35:B37 the
 *                      Social-Security base tick boxes.
 *   Menu               B1 the version again, C11:N11 calendar days,
 *                      C12:N12 public holidays.
 *   Buyout & Manual    row 1 machine names, row 2 human names, row 3+ data.
 *   Allocations        five fixed column pairs at B/D/F/H/J.
 *   Budget_Import      G5 hotel name, D5 OU (a BST pull, may be absent).
 *
 * Formulas matter here, unlike the budget-import reader: the total column of a
 * percentage band states what the percentage applies to, and hotels do edit
 * those formulas. Reading them is what lets the importer reproduce a customised
 * pension base instead of guessing.
 *
 * Electron-free (only `xlsx`) so it unit-tests against in-memory workbooks.
 */

import * as XLSX from "xlsx";

/** Sheets we read. Anything else in the workbook is ignored. */
export const ASSOCIATE_SHEET = "Associate Details";
export const SETTINGS_SHEET = "Settings";
export const MENU_SHEET = "Menu";
export const MANUAL_SHEET = "Buyout & Manual Input";
export const ALLOCATIONS_SHEET = "Allocations";
export const BUDGET_IMPORT_SHEET = "Budget_Import";

/** First data row (1-based) of Associate Details / Buyout & Manual Input. */
const ASSOCIATE_FIRST_ROW = 4;
const MANUAL_FIRST_ROW = 3;
/** Guard against a runaway sheet; the old tool caps well below this. */
const MAX_SCAN_ROWS = 20000;

export const MONTHS = 12;

/** One associate row, keyed by column letter exactly as the sheet holds it. */
export interface LegacyAssociateRow {
  /** 1-based sheet row, for error messages that a user can act on. */
  sheetRow: number;
  /** Column letter → raw cell value (numbers stay numbers, text stays text). */
  cells: Record<string, unknown>;
}

/** One Buyout & Manual Input row. */
export interface LegacyManualRow {
  sheetRow: number;
  cells: Record<string, unknown>;
}

/** One of the five allocation columns on the Allocations sheet. */
export interface LegacyAllocationColumn {
  /** The heading, e.g. "% of Employee Meal Cost". */
  title: string;
  /** "Active" / "Disabled". */
  status: string;
  /** The department the cost is injected into (has no home in Kairos). */
  targetDepartment: string;
  /** The GL account the injection posts to (has no home in Kairos). */
  injectAccount: string;
  /** The Excel spread-base label, e.g. "Head Count". */
  spreadBaseLabel: string;
  /** Department code → the percentage the sheet currently shows (may be blank). */
  valuesByDepartment: Record<string, number | null>;
}

export interface LegacyWorkbook {
  sourceFileName: string;
  /** Row 2 of Associate Details: column letter → band name (only where set). */
  bandNames: Record<string, string>;
  /** Row 3 of Associate Details: column letter → column name. */
  columnNames: Record<string, string>;
  /** Column letter → the row-4 formula, normalized to `AZ4` → `AZ`. Absent for
   *  input columns. This is how analyze.ts learns a band's real base. */
  formulas: Record<string, string>;
  /**
   * Columns whose formula is NOT the same on every row: letter → the rows that
   * differ from the majority, and what they say instead.
   *
   * Worth surfacing because it happens in practice and is otherwise invisible:
   * the reference file has one row whose allowance total was hand-edited to
   * `+CT8*AD8*P8` — the standard formula times that row's FTE. A block config is
   * hotel-wide, so a single row's bespoke arithmetic cannot be reproduced; the
   * least bad outcome is to import the standard formula and say which rows will
   * therefore differ.
   */
  formulaOutliers: Record<string, Array<{ formula: string; sheetRows: number[] }>>;
  associates: LegacyAssociateRow[];
  manualRows: LegacyManualRow[];
  allocationColumns: LegacyAllocationColumn[];
  /** All department codes listed down column A of the Allocations sheet. */
  allocationDepartments: string[];
  /** Settings!B31 — the full-time week in hours. */
  fullTimeWeeklyHours: number | null;
  /** Settings!B4, e.g. "Yr 2024" → 2024. */
  enteredYear: number | null;
  /**
   * Settings!B29 ("Version 3.6.3") / C29 ("_V3.6.3"), reduced to "3.6.3".
   *
   * The tool states its own version, which matters because the layout is NOT
   * the same across the 3.6.x line: 3.6.1 has no Overtime band, so every column
   * from DY onward sits seven to the left of where 3.6.3 puts it. Advisory
   * only — `layout.ts` trusts the sheet's own headers first and uses this to
   * corroborate, because a hotel that copied its data into a newer template
   * can leave the version cell saying the old number.
   */
  declaredVersion: string | null;
  /**
   * Settings!C37 === "CN_A20" — the Overtime row of the Social-Security
   * inclusion list, which only exists from the version that added the band.
   * A second, independent signal for the same question.
   */
  hasOvertimeSetting: boolean;
  /** Menu!C12:N12 — public holidays per month, Jan..Dec. */
  publicHolidaysByMonth: number[] | null;
  /** Menu!C11:N11 — calendar days per month, Jan..Dec (the daily-spread basis). */
  calendarDaysByMonth: number[] | null;
  /** Settings!B9:B24 + B35:B37 — which lines are in the Social-Security base,
   *  keyed by the CN_A<n> name the VBA uses. */
  ssBaseFlags: Record<string, boolean>;
  /** Budget_Import!G5 — the hotel this workbook last pulled a budget for. */
  hotelName: string | null;
  /** Budget_Import!D5 — the OU, if the workbook has ever pulled a budget. */
  ou: string | null;
}

/** Thrown when the file is clearly not a legacy Payroll Budget Tool workbook. */
export class NotLegacyWorkbookError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotLegacyWorkbookError";
  }
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

function cellAt(ws: XLSX.WorkSheet, row: number, col: number): XLSX.CellObject | undefined {
  return ws[XLSX.utils.encode_cell({ r: row - 1, c: col })] as
    | XLSX.CellObject
    | undefined;
}

/** Trimmed text at an address, or null for blank/missing. */
function textAt(ws: XLSX.WorkSheet | undefined, address: string): string | null {
  const cell = ws?.[address] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null) return null;
  const value = String(cell.v).trim();
  return value === "" ? null : value;
}

/** Finite number at an address, or null. */
function numberAt(ws: XLSX.WorkSheet | undefined, address: string): number | null {
  const cell = ws?.[address] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null || cell.v === "") return null;
  const value = Number(cell.v);
  return Number.isFinite(value) ? value : null;
}

/** Excel booleans arrive as `true`/`false` or the strings "TRUE"/"true". */
function boolAt(ws: XLSX.WorkSheet | undefined, address: string): boolean {
  const cell = ws?.[address] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null) return false;
  if (typeof cell.v === "boolean") return cell.v;
  return String(cell.v).trim().toLowerCase() === "true";
}

/** The first four-digit run of a header like "Yr 2024" → 2024. */
function parseYear(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(\d{4})/);
  return match ? Number(match[1]) : null;
}

/** "Version 3.6.3" / "_V3.6.3" → "3.6.3". */
function parseVersion(...candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    const match = candidate?.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (match) return match[1];
  }
  return null;
}

/** Read twelve consecutive cells across one row into a Jan..Dec vector. */
function readMonthRow(
  ws: XLSX.WorkSheet | undefined,
  row: number,
  firstCol: number
): number[] | null {
  if (!ws) return null;
  const out: number[] = [];
  let sawValue = false;
  for (let m = 0; m < MONTHS; m++) {
    const cell = cellAt(ws, row, firstCol + m);
    const value = Number(cell?.v ?? 0);
    const usable = Number.isFinite(value) ? value : 0;
    if (cell?.v != null && cell.v !== "") sawValue = true;
    out.push(usable);
  }
  return sawValue ? out : null;
}

/**
 * Strip row numbers off a formula so `BT4*(AZ4+CP4)` reads as `BT*(AZ+CP)` —
 * the shape analyze.ts matches column letters against. Sheet-qualified and
 * absolute references are left alone beyond the same digit strip.
 */
function normalizeFormula(formula: string): string {
  return formula.replace(/\s+/g, "").replace(/(\$?[A-Z]{1,2})\$?\d{1,7}/g, "$1");
}

/** Last 1-based row on `sheet` whose column `col` holds something. */
function lastPopulatedRow(
  ws: XLSX.WorkSheet,
  col: number,
  firstRow: number
): number {
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  const limit = Math.min(range.e.r + 1, firstRow + MAX_SCAN_ROWS);
  let last = firstRow - 1;
  for (let row = firstRow; row <= limit; row++) {
    const cell = cellAt(ws, row, col);
    if (cell && cell.v != null && String(cell.v).trim() !== "") last = row;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Sheet readers
// ---------------------------------------------------------------------------

/** Row 2 (band names), row 3 (column names), row 4 (formulas) as letter maps. */
function readHeaders(ws: XLSX.WorkSheet): {
  bandNames: Record<string, string>;
  columnNames: Record<string, string>;
  formulas: Record<string, string>;
} {
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  const bandNames: Record<string, string> = {};
  const columnNames: Record<string, string> = {};
  const formulas: Record<string, string> = {};

  for (let col = range.s.c; col <= range.e.c; col++) {
    const letter = XLSX.utils.encode_col(col);
    const band = cellAt(ws, 2, col);
    if (band?.v != null) {
      const text = String(band.v).replace(/\s+/g, " ").trim();
      if (text) bandNames[letter] = text;
    }
    const name = cellAt(ws, 3, col);
    if (name?.v != null) {
      const text = String(name.v).replace(/\s+/g, " ").trim();
      if (text) columnNames[letter] = text;
    }
    const first = cellAt(ws, ASSOCIATE_FIRST_ROW, col);
    if (first?.f) formulas[letter] = normalizeFormula(first.f);
  }
  return { bandNames, columnNames, formulas };
}

/**
 * Every associate row. A row counts as present when the Emp Number (column B)
 * is filled — the same "column B, End(xlUp)" test the VBA used to find its last
 * row. Cells that hold a formula are read as their cached VALUE, which is what
 * the account columns (derived from the pay type) need; analyze.ts decides
 * which of those values are worth keeping.
 */
function readAssociates(ws: XLSX.WorkSheet): {
  rows: LegacyAssociateRow[];
  formulaOutliers: LegacyWorkbook["formulaOutliers"];
} {
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  const last = lastPopulatedRow(ws, 1, ASSOCIATE_FIRST_ROW); // column B
  const rows: LegacyAssociateRow[] = [];
  /** column letter → normalized formula → the rows carrying it. */
  const byColumn = new Map<string, Map<string, number[]>>();

  for (let row = ASSOCIATE_FIRST_ROW; row <= last; row++) {
    const cells: Record<string, unknown> = {};
    let any = false;
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = cellAt(ws, row, col);
      if (!cell) continue;
      const letter = XLSX.utils.encode_col(col);
      if (cell.f) {
        const shapes = byColumn.get(letter) ?? new Map<string, number[]>();
        const shape = normalizeFormula(cell.f);
        shapes.set(shape, [...(shapes.get(shape) ?? []), row]);
        byColumn.set(letter, shapes);
      }
      if (cell.v == null || cell.v === "") continue;
      cells[letter] = cell.v;
      any = true;
    }
    if (any) rows.push({ sheetRow: row, cells });
  }

  // A column is only interesting when it disagrees with itself; the majority
  // shape is the one the importer models, so report the rest.
  const formulaOutliers: LegacyWorkbook["formulaOutliers"] = {};
  for (const [letter, shapes] of byColumn) {
    if (shapes.size < 2) continue;
    const ranked = [...shapes.entries()].sort((a, b) => b[1].length - a[1].length);
    formulaOutliers[letter] = ranked
      .slice(1)
      .map(([formula, sheetRows]) => ({ formula, sheetRows }));
  }

  return { rows, formulaOutliers };
}

/** Buyout & Manual Input rows, keyed by column letter. Column B = department. */
function readManualRows(ws: XLSX.WorkSheet | undefined): LegacyManualRow[] {
  if (!ws) return [];
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  const last = lastPopulatedRow(ws, 1, MANUAL_FIRST_ROW); // column B
  const rows: LegacyManualRow[] = [];

  for (let row = MANUAL_FIRST_ROW; row <= last; row++) {
    const cells: Record<string, unknown> = {};
    let any = false;
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = cellAt(ws, row, col);
      if (!cell || cell.v == null || cell.v === "") continue;
      cells[XLSX.utils.encode_col(col)] = cell.v;
      any = true;
    }
    if (any) rows.push({ sheetRow: row, cells });
  }
  return rows;
}

/**
 * The Allocations sheet's five fixed column pairs. Each starts at B/D/F/H/J:
 * row 3 the title, row 6 the target department, row 7 Active/Disabled, row 8
 * the inject account, row 9 the spread base, then rows 10+ the per-department
 * percentages against the codes in column A.
 */
function readAllocations(ws: XLSX.WorkSheet | undefined): {
  columns: LegacyAllocationColumn[];
  departments: string[];
} {
  if (!ws) return { columns: [], departments: [] };
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");

  const departments: string[] = [];
  const departmentRows: number[] = [];
  for (let row = 10; row <= Math.min(range.e.r + 1, 10 + MAX_SCAN_ROWS); row++) {
    const cell = cellAt(ws, row, 0); // column A
    const code = cell?.v == null ? "" : String(cell.v).trim();
    if (!code) continue;
    departments.push(code);
    departmentRows.push(row);
  }

  const columns: LegacyAllocationColumn[] = [];
  for (const startCol of [1, 3, 5, 7, 9]) {
    // B, D, F, H, J
    const title = cellAt(ws, 3, startCol);
    if (!title?.v) continue;
    const valuesByDepartment: Record<string, number | null> = {};
    departmentRows.forEach((row, index) => {
      // The percentage sits under the title (B/D/F/H/J); the column beside it
      // holds the raw basis count the sheet derived it from.
      const cell = cellAt(ws, row, startCol);
      const value = cell?.v == null || cell.v === "" ? null : Number(cell.v);
      valuesByDepartment[departments[index]] =
        value != null && Number.isFinite(value) ? value : null;
    });
    columns.push({
      title: String(title.v).trim(),
      status: String(cellAt(ws, 7, startCol)?.v ?? "").trim(),
      targetDepartment: String(cellAt(ws, 6, startCol + 1)?.v ?? "").trim(),
      injectAccount: String(cellAt(ws, 8, startCol + 1)?.v ?? "").trim(),
      spreadBaseLabel: String(cellAt(ws, 9, startCol + 1)?.v ?? "").trim(),
      valuesByDepartment,
    });
  }
  return { columns, departments };
}

/**
 * The Social-Security base tick boxes. The VBA reads these as the named ranges
 * CN_A1..CN_A20 (Settings B9:B24 for the block bands, B35:B37 for Custom 1 /
 * Custom 2 / Overtime) and multiplies each line by 1 or 0 accordingly.
 */
function readSsBaseFlags(ws: XLSX.WorkSheet | undefined): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  if (!ws) return flags;
  for (let index = 1; index <= 17; index++) {
    flags[`CN_A${index}`] = boolAt(ws, `B${8 + index}`); // B9..B25
  }
  flags.CN_A18 = boolAt(ws, "B35");
  flags.CN_A19 = boolAt(ws, "B36");
  flags.CN_A20 = boolAt(ws, "B37");
  return flags;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse an in-memory workbook. Two passes keep a 2 MB macro-enabled file quick:
 * a names-only read to confirm it is the right tool, then a full parse of only
 * the sheets we read.
 *
 * @throws NotLegacyWorkbookError when the marker sheets are missing.
 */
export function parseLegacyWorkbook(
  buffer: Buffer | Uint8Array,
  sourceFileName: string
): LegacyWorkbook {
  const names = XLSX.read(buffer, { type: "buffer", bookSheets: true }).SheetNames;
  for (const required of [ASSOCIATE_SHEET, SETTINGS_SHEET]) {
    if (!names.includes(required)) {
      throw new NotLegacyWorkbookError(
        `"${sourceFileName}" is not a Payroll Budget Tool file (no "${required}" sheet).`
      );
    }
  }

  const targets = [
    ASSOCIATE_SHEET,
    SETTINGS_SHEET,
    MENU_SHEET,
    MANUAL_SHEET,
    ALLOCATIONS_SHEET,
    BUDGET_IMPORT_SHEET,
  ].filter((name) => names.includes(name));

  const wb = XLSX.read(buffer, {
    type: "buffer",
    sheets: targets,
    // Unlike the budget-import reader, formulas ARE the data here: a band's
    // total column states what its percentage applies to.
    cellFormula: true,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    cellDates: false,
  });

  const associateSheet = wb.Sheets[ASSOCIATE_SHEET];
  if (!associateSheet?.["!ref"]) {
    throw new NotLegacyWorkbookError(
      `"${sourceFileName}" has an empty "${ASSOCIATE_SHEET}" sheet.`
    );
  }

  const settings = wb.Sheets[SETTINGS_SHEET];
  const menu = wb.Sheets[MENU_SHEET];
  const budgetImport = wb.Sheets[BUDGET_IMPORT_SHEET];
  const { bandNames, columnNames, formulas } = readHeaders(associateSheet);
  const allocations = readAllocations(wb.Sheets[ALLOCATIONS_SHEET]);
  const associates = readAssociates(associateSheet);

  return {
    sourceFileName,
    bandNames,
    columnNames,
    formulas,
    formulaOutliers: associates.formulaOutliers,
    associates: associates.rows,
    manualRows: readManualRows(wb.Sheets[MANUAL_SHEET]),
    allocationColumns: allocations.columns,
    allocationDepartments: allocations.departments,
    fullTimeWeeklyHours: numberAt(settings, "B31"),
    enteredYear: parseYear(textAt(settings, "B4")),
    declaredVersion: parseVersion(
      textAt(settings, "B29"),
      textAt(settings, "C29"),
      textAt(menu, "B1")
    ),
    hasOvertimeSetting: textAt(settings, "C37") === "CN_A20",
    publicHolidaysByMonth: readMonthRow(menu, 12, 2), // C12:N12
    calendarDaysByMonth: readMonthRow(menu, 11, 2), // C11:N11
    ssBaseFlags: readSsBaseFlags(settings),
    hotelName: textAt(budgetImport, "G5"),
    ou: textAt(budgetImport, "D5"),
  };
}
