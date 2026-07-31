/**
 * Read an Oracle HR export into plain data.
 *
 * Strictly a reader: it pulls cells off the first worksheet and interprets
 * nothing. All the judgement — how a column maps to a field, which rows are
 * duplicates, what the percentages land on — lives in analyze.ts, so this file
 * stays a stable description of the report's shape.
 *
 * Layout, taken from the `Add_New_Rows_Oracle` macro (which is NOT in
 * `OLD VBA Engine.txt`; the macro text the port was written from is the only
 * source, so it is restated here in full):
 *
 *   Worksheet 1, headers on row 7, data from row 8 to the last used row in
 *   column A. The macro reads `A8:AS{last}` — columns A..AS, 45 of them.
 *
 *     A   EMPLOYEE LAST NAME     Y   hiring date
 *     B   first name             AB  department (padded to four digits)
 *     E   employee number        AK  CONTRACT HOURS (weekly)
 *     AL  contract days/week     AN  SALARY
 *     AS  ANNUAL ENTITLEMENT
 *
 * The macro asserts four header cells — A7, AK7, AN7, AS7 — and reads the rest
 * positionally. It records the header wording of no other column, and no sample
 * export exists to learn it from, so those five stay positional here too: see
 * HEADER_EXPECTATIONS, which is shaped to take `accept` lists the day someone
 * supplies a real file. Protection in the meantime is analyze.ts's per-row shape
 * assertions plus the sample table the confirm dialog shows.
 *
 * Electron-free (only `xlsx`) so it unit-tests against in-memory workbooks.
 */

import * as XLSX from "xlsx";

/** Column A of the header row. Also how the header row itself is located. */
export const ORACLE_HEADER_MARKER = "EMPLOYEE LAST NAME";

/** Last column the macro reads: AS. */
export const ORACLE_LAST_COLUMN_INDEX = 44;

/** The header row the macro expects. Found rather than assumed — see below. */
export const ORACLE_EXPECTED_HEADER_ROW = 7;

/** How far down to look for the header row before giving up. */
const HEADER_SCAN_LIMIT = 15;

/** Guard against a runaway sheet. */
const MAX_SCAN_ROWS = 20000;

export interface OracleHeaderExpectation {
  column: string;
  /** 0-based. */
  index: number;
  /** What the column holds, for error messages a user can act on. */
  meaning: string;
  /**
   * Header texts accepted for this column, already normalized. An EMPTY list
   * means "positional only": the macro asserted nothing here, so neither do we.
   * Filling one in is all it takes to harden a column once a real export exists.
   */
  accept: string[];
}

export const HEADER_EXPECTATIONS: OracleHeaderExpectation[] = [
  { column: "A", index: 0, meaning: "Last name", accept: [ORACLE_HEADER_MARKER] },
  { column: "B", index: 1, meaning: "First name", accept: [] },
  { column: "E", index: 4, meaning: "Employee number", accept: [] },
  { column: "Y", index: 24, meaning: "Hiring date", accept: [] },
  { column: "AB", index: 27, meaning: "Department", accept: [] },
  {
    column: "AK",
    index: 36,
    meaning: "Weekly contract hours",
    accept: ["CONTRACT HOURS"],
  },
  { column: "AL", index: 37, meaning: "Contract days per week", accept: [] },
  { column: "AN", index: 39, meaning: "Salary", accept: ["SALARY"] },
  {
    column: "AS",
    index: 44,
    meaning: "Annual leave entitlement",
    accept: ["ANNUAL ENTITLEMENT"],
  },
];

/** One row of the export, cells indexed 0..44 (A..AS). */
export interface OracleRow {
  /** 1-based sheet row, so an error message points at what Excel shows. */
  sheetRow: number;
  cells: unknown[];
}

export interface OracleReport {
  sourceFileName: string;
  sheetName: string;
  /** 1-based, as found. */
  headerRow: number;
  /** Normalized header text by column index; null where the cell was blank. */
  headers: Array<string | null>;
  rows: OracleRow[];
  /** Notes the parser wants the preview to carry (e.g. a shifted header row). */
  warnings: string[];
}

/** Thrown when the file is clearly not an Oracle report in the macro's layout. */
export class NotOracleReportError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotOracleReportError";
  }
}

/**
 * Header text as we compare it: uppercase, whitespace collapsed, and the
 * decoration Oracle report definitions add stripped (a trailing asterisk or
 * colon, and a trailing parenthetical unit).
 */
export function normalizeHeader(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    // Decoration comes off in this order because it arrives in this order:
    // "Contract Hours (weekly)*" — the marker sits outside the parenthetical.
    .replace(/[*:\s]+$/, "")
    .replace(/\s*\([^)]*\)$/, "")
    .replace(/[*:\s]+$/, "")
    .toUpperCase();
}

function cellAt(
  ws: XLSX.WorkSheet,
  row: number,
  col: number
): XLSX.CellObject | undefined {
  return ws[XLSX.utils.encode_cell({ r: row - 1, c: col })] as
    | XLSX.CellObject
    | undefined;
}

/** Raw value at a cell — numbers stay numbers, text stays text. */
function valueAt(ws: XLSX.WorkSheet, row: number, col: number): unknown {
  const cell = cellAt(ws, row, col);
  if (!cell || cell.v == null || cell.v === "") return null;
  return cell.v;
}

/** Last 1-based row whose column `col` holds something. */
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

/**
 * Find the header row by its marker rather than trusting row 7. Oracle report
 * definitions routinely gain a title row, and failing on that would be brittle
 * for no gain — this still fails loudly when the marker is absent entirely,
 * which is the case that actually means "wrong file".
 */
function findHeaderRow(ws: XLSX.WorkSheet): number {
  for (let row = 1; row <= HEADER_SCAN_LIMIT; row++) {
    if (normalizeHeader(valueAt(ws, row, 0)) === ORACLE_HEADER_MARKER) return row;
  }
  throw new NotOracleReportError(
    `No "${ORACLE_HEADER_MARKER}" heading was found in column A of the first ` +
      `${HEADER_SCAN_LIMIT} rows, so this does not look like an Oracle report.`
  );
}

export function parseOracleReport(
  buffer: Buffer | Uint8Array,
  sourceFileName: string
): OracleReport {
  // Two passes, as the legacy reader does: names first so a wrong file is
  // rejected before the expensive full read.
  const names = XLSX.read(buffer, { type: "buffer", bookSheets: true });
  const sheetName = names.SheetNames[0];
  if (!sheetName) {
    throw new NotOracleReportError("The workbook has no worksheets.");
  }

  // `cellFormula: false` on purpose: an Oracle export is values, and unlike the
  // legacy workbook no formula here is data.
  const book = XLSX.read(buffer, {
    type: "buffer",
    sheets: [sheetName],
    cellFormula: false,
  });
  const ws = book.Sheets[sheetName];
  if (!ws || !ws["!ref"]) {
    throw new NotOracleReportError(`Worksheet "${sheetName}" is empty.`);
  }

  const warnings: string[] = [];
  const headerRow = findHeaderRow(ws);
  if (headerRow !== ORACLE_EXPECTED_HEADER_ROW) {
    warnings.push(
      `The column headings are on row ${headerRow}, not row ` +
        `${ORACLE_EXPECTED_HEADER_ROW} as the old macro expected. The data was ` +
        `read from row ${headerRow + 1} down — check the sample rows below.`
    );
  }

  const headers: Array<string | null> = [];
  for (let col = 0; col <= ORACLE_LAST_COLUMN_INDEX; col++) {
    const text = normalizeHeader(valueAt(ws, headerRow, col));
    headers.push(text || null);
  }

  for (const expectation of HEADER_EXPECTATIONS) {
    if (expectation.accept.length === 0) continue;
    const found = headers[expectation.index];
    if (found && expectation.accept.includes(found)) continue;
    throw new NotOracleReportError(
      `Column ${expectation.column} of row ${headerRow} should be ` +
        `"${expectation.accept[0]}" (${expectation.meaning}) but ` +
        `${found ? `says "${found}"` : "is blank"}. The report is not in the ` +
        `expected format.`
    );
  }

  const firstDataRow = headerRow + 1;
  const lastRow = lastPopulatedRow(ws, 0, firstDataRow);
  if (lastRow < firstDataRow) {
    throw new NotOracleReportError(
      `No associate rows were found under the headings on row ${headerRow}.`
    );
  }

  const rows: OracleRow[] = [];
  for (let row = firstDataRow; row <= lastRow; row++) {
    const cells: unknown[] = [];
    for (let col = 0; col <= ORACLE_LAST_COLUMN_INDEX; col++) {
      cells.push(valueAt(ws, row, col));
    }
    rows.push({ sheetRow: row, cells });
  }

  return { sourceFileName, sheetName, headerRow, headers, rows, warnings };
}
