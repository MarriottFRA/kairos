/**
 * Read a BST (BGT Spread File) as a *push target*.
 *
 * The pull (main/budgetImport/parseWorkbook.ts) reads the same workbook for its
 * values; this reads it for its addresses — where each `dddd-dddddd` combo
 * lives, so the writer knows which row of which sheet to put a number in — plus
 * the identity the push is guarded on.
 *
 * Layout (verified against the 2027 example file):
 *   - Department sheets are named by the bare 4-digit code ("0010", "0410").
 *     Cell E2 repeats the code. Division summaries ("Rooms", "F&B", "Admin") and
 *     the hidden tpl_* templates carry no E2 code and must never be written to.
 *   - Column B holds `=$E$2&"-510600"`, whose cached value is the combo
 *     `0010-510600`. Match on that. Column B is a formula — never write it.
 *   - Jan..Dec of the budget year sit in columns I..T. `Setup Fields!I46` says
 *     which block that is ("BUDGET"); if it does not, we refuse rather than
 *     guess which twelve columns to overwrite.
 *   - Identity: `Setup Fields!D5` = OU (NOT B5, which is the PeopleSoft code),
 *     `Setup Fields!B1` = the budget year as a plain number (defined name
 *     `Budgeted_year`).
 *
 * SheetJS is used here (and only here) because it already parses this exact
 * workbook for the pull. Writing is a different problem — see writeWorkbook.ts.
 *
 * Electron-free and dependency-light so it stays unit-testable.
 */

import * as XLSX from "xlsx";
import { normalizeOu } from "../positions/ouScope";
import { PUSH_MONTHS } from "../../shared/bstPush/ipc";

/** A row is addressable iff column B is a `dddd-dddddd` combo. */
const COMBO_RE = /^\d{4}-\d{6}$/;
/** Department sheets are named by the bare 4-digit code. */
const DEPT_SHEET_RE = /^\d{4}$/;
const SETUP_SHEET = "Setup Fields";

/** Where one combo lives in the workbook. */
export interface ComboLocation {
  /** `dddd-dddddd`, exactly as column B spells it. */
  combo: string;
  /** Sheet name = bare 4-digit department code. */
  sheet: string;
  /** 1-based row number, as Excel counts. */
  row: number;
  /** Column A's description, for the report. */
  description: string | null;
  /** Column C's text — where the BST labels its allocation rows. */
  columnC: string | null;
  /** True when column C marks this row as an allocation. */
  isAllocation: boolean;
  /**
   * Jan..Dec: the month cell is locked under sheet protection. SheetJS cannot
   * see protection, so this starts all-false and is filled in afterwards by
   * readProtection's `annotateProtection`.
   */
  lockedMonths: boolean[];
  /** True when this combo appears on more than one row of the sheet. */
  duplicate: boolean;
}

/**
 * True for the column C labels the BST puts on allocation rows: "Allocated
 * from 0120-759101", "Alloc from 0090", "Allocation from 0363", … A bare
 * substring test on purpose — every observed spelling contains it, and the
 * preview badges each match so a false positive is visible before it matters.
 */
export function isAllocationLabel(text: string | null): boolean {
  return text != null && /allo/i.test(text);
}

export interface BstTarget {
  sourceFileName: string;
  /** Setup Fields D5, canonicalized to "OU"+5. */
  ou: string;
  /** Setup Fields B1. Null when unreadable. */
  year: number | null;
  hotelName: string | null;
  currency: string | null;
  /** Setup Fields I46 — expected to be "BUDGET". */
  budgetBucketType: string | null;
  /** Department sheet names present, in workbook order. */
  departmentSheets: string[];
  /** combo → where to write it. First occurrence wins (the macro did the same). */
  combos: Map<string, ComboLocation>;
  /** Every combo on each sheet, for the zero pass. */
  bySheet: Map<string, ComboLocation[]>;
}

/** Thrown when the file is not a BST at all. */
export class NotBstFileError extends Error {}

/** Thrown when the file is a BST but not one this writer can safely address. */
export class UnsupportedLayoutError extends Error {}

/** Trimmed text of a cell, or null. */
function text(ws: XLSX.WorkSheet, addr: string): string | null {
  const cell = ws[addr] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null) return null;
  const s = String(cell.v).trim();
  return s === "" ? null : s;
}

/** A cell read as a finite number, or null. */
function num(ws: XLSX.WorkSheet, addr: string): number | null {
  const cell = ws[addr] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null) return null;
  const n = Number(cell.v);
  return Number.isFinite(n) ? n : null;
}

/** True for a sheet that carries writable combo rows. */
export function isDepartmentSheet(name: string): boolean {
  return DEPT_SHEET_RE.test(name);
}

/** Index every combo on one department sheet by scanning column B. */
function indexSheet(ws: XLSX.WorkSheet, sheet: string): ComboLocation[] {
  const ref = ws["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const found: ComboLocation[] = [];
  const occurrences = new Map<string, number>();

  // Walk real row numbers (not a compacted grid) — the writer addresses cells
  // by their Excel row, so a dropped blank row would corrupt every write below it.
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 1 })] as
      | XLSX.CellObject
      | undefined;
    // The combo is the CACHED value of a formula (`=$E$2&"-510600"`), which
    // SheetJS exposes as .v regardless of cellFormula.
    const value = cell?.v;
    if (typeof value !== "string" || !COMBO_RE.test(value)) continue;

    const descCell = ws[XLSX.utils.encode_cell({ r, c: 0 })] as
      | XLSX.CellObject
      | undefined;
    const labelCell = ws[XLSX.utils.encode_cell({ r, c: 2 })] as
      | XLSX.CellObject
      | undefined;
    const columnC =
      typeof labelCell?.v === "string" ? labelCell.v.trim() || null : null;

    occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
    found.push({
      combo: value,
      sheet,
      row: r + 1,
      description:
        typeof descCell?.v === "string" ? descCell.v.trim() || null : null,
      columnC,
      isAllocation: isAllocationLabel(columnC),
      lockedMonths: Array.from({ length: PUSH_MONTHS }, () => false),
      duplicate: false,
    });
  }

  // Flag every occurrence, including the first — the first is the one the push
  // will use, and it is the one the report shows.
  for (const entry of found) {
    if ((occurrences.get(entry.combo) ?? 0) > 1) entry.duplicate = true;
  }
  return found;
}

/**
 * Parse a workbook's bytes into a push target.
 *
 * @throws NotBstFileError when the workbook has no "Setup Fields" sheet.
 * @throws UnsupportedLayoutError when it has no department sheets, or the
 *         budget block is not where this writer expects it.
 */
export function readTarget(
  buffer: Buffer | Uint8Array,
  sourceFileName: string
): BstTarget {
  const names = XLSX.read(buffer, { type: "buffer", bookSheets: true }).SheetNames;
  if (!names.includes(SETUP_SHEET)) {
    throw new NotBstFileError(
      `"${sourceFileName}" is not a BGT Spread File (no "${SETUP_SHEET}" sheet).`
    );
  }

  const departmentSheets = names.filter(isDepartmentSheet);
  if (departmentSheets.length === 0) {
    throw new UnsupportedLayoutError(
      `"${sourceFileName}" has no department sheets (none named as a 4-digit code).`
    );
  }

  const wb = XLSX.read(buffer, {
    type: "buffer",
    sheets: [SETUP_SHEET, ...departmentSheets],
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    cellDates: false,
  });

  const setup = wb.Sheets[SETUP_SHEET];
  const rawOu = text(setup, "D5") ?? "";
  const budgetBucketType = text(setup, "I46");

  const combos = new Map<string, ComboLocation>();
  const bySheet = new Map<string, ComboLocation[]>();
  const present: string[] = [];

  for (const sheet of departmentSheets) {
    const ws = wb.Sheets[sheet];
    if (!ws) continue;
    // E2 must echo the sheet name. A 4-digit sheet whose E2 disagrees is not a
    // department detail sheet, and its column B would address the wrong hotel
    // department — skip rather than write into it.
    const code = text(ws, "E2");
    if (code !== sheet) continue;

    const located = indexSheet(ws, sheet);
    if (located.length === 0) continue;
    present.push(sheet);
    bySheet.set(sheet, located);
    // First occurrence wins, exactly as the macro's Application.Match did.
    for (const entry of located) {
      if (!combos.has(entry.combo)) combos.set(entry.combo, entry);
    }
  }

  if (present.length === 0) {
    throw new UnsupportedLayoutError(
      `"${sourceFileName}" has department sheets but none carry addressable ` +
        `account rows (column B holds no "dddd-dddddd" combos).`
    );
  }

  return {
    sourceFileName,
    ou: normalizeOu(rawOu) ?? rawOu.toUpperCase(),
    year: num(setup, "B1"),
    hotelName: text(setup, "B3"),
    currency: text(setup, "B7"),
    budgetBucketType,
    departmentSheets: present,
    combos,
    bySheet,
  };
}
