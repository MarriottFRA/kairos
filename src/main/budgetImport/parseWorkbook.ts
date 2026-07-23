/**
 * Parse a hotel's Excel "BGT Spread File" into a flat budget dataset.
 *
 * This is the app-native successor to the old `ImportFromBST` VBA macro. It
 * reads the *saved* workbook bytes (works whether or not Excel has the file
 * open) and pulls, per GL combo, the three 12-month blocks the file carries.
 *
 * Layout (verified against the 2027 example files — identical across the
 * per-department sheets and the "MarketSeg Raw data" sheet):
 *   - Data sheets are the 4-digit department sheets (e.g. "0010") plus
 *     "MarketSeg Raw data". Everything else (rollups, templates, tpl_*) carries
 *     no valid combos and is skipped — same intent as the macro's CheckSheetName.
 *   - Column B holds the combo; only rows matching `dddd-dddddd` are data rows
 *     (named subtotals like "RmRev"/"TotalSW" are skipped — the macro's
 *     CheckCombo). Column A is an optional human description. The combo is split
 *     into dept + account and normalized to the app standard ("D" + 4-digit dept,
 *     "A" + 6-digit account) — the spread file omits those prefixes. Rows whose
 *     every monthly cell is empty/zero are dropped.
 *   - Units: A9 accounts (6-digit account starting with 9 — the stat/segment
 *     lines) are already in actual units and kept as-is; every other account is
 *     stored in thousands in the file, so its values are multiplied by 1000.
 *   - Monthly values sit in three fixed blocks with one gap column between each:
 *       bucket 1  I:T   (cols 8..19)   — typically BUDGET
 *       bucket 2  V:AG  (cols 21..32)  — typically ACT/FCST
 *       bucket 3  AI:AT (cols 34..45)  — typically ACTUAL
 *   - The buckets' type + year are declared authoritatively on "Setup Fields"
 *     (header block rows 46/47) and rotate each budget cycle, so we read them
 *     rather than hard-coding years.
 *
 * Kept dependency-light and Electron-free (only `xlsx` + the pure OU helper) so
 * it is unit-testable and could be moved to a worker/utilityProcess later.
 */

import * as XLSX from "xlsx";
import { normalizeOu } from "../positions/ouScope";
import {
  BucketMeta,
  ImportMeta,
  WIDE_CELL_COUNT,
} from "../../shared/budgetImport/ipc";

/** A single combo row with its 36 monthly values (bucket-major, then month). */
export interface ParsedRow {
  dept: string;
  account: string;
  combo: string;
  description: string | null;
  /** length WIDE_CELL_COUNT: [b1m1..b1m12, b2m1..b2m12, b3m1..b3m12]. */
  cells: number[];
}

export interface ParsedDataset {
  meta: ImportMeta;
  buckets: BucketMeta[];
  rows: ParsedRow[];
}

/** A row is a data row iff column B is a `dddd-dddddd` combo. */
const COMBO_RE = /^\d{4}-\d{6}$/;
/** Sheets that carry combo data: 4-digit dept sheets + the market-segment sheet. */
const DATA_SHEET_RE = /^\d{4}$/;
const MARKET_SEG_SHEET = "MarketSeg Raw data";
const SETUP_SHEET = "Setup Fields";

/** 0-based column index of the first month in each bucket, and the gap layout. */
const BUCKET_STARTS = [8, 21, 34]; // I, V, AI
const MONTHS = 12;

/** Coerce a possibly-missing / string cell to a finite number (0 otherwise). */
function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Read a Setup Fields cell as trimmed text, or null. */
function text(ws: XLSX.WorkSheet, addr: string): string | null {
  const cell = ws[addr] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null) return null;
  const s = String(cell.v).trim();
  return s === "" ? null : s;
}

/** Pull the first 4-digit run from a header like "Yr 2027" → 2027. */
function parseYear(value: string | null): number | null {
  if (!value) return null;
  const m = value.match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** Read file-level metadata + the three bucket declarations from Setup Fields. */
function readSetup(ws: XLSX.WorkSheet, sourceFileName: string): {
  meta: ImportMeta;
  buckets: BucketMeta[];
} {
  const rawOu = text(ws, "D5") ?? "";
  const ou = normalizeOu(rawOu) ?? rawOu.toUpperCase();

  const meta: ImportMeta = {
    ou,
    sourceFileName,
    hotelName: text(ws, "B3"),
    bu: text(ws, "B5"),
    currency: text(ws, "B7"),
    asOfPeriod: text(ws, "B9"),
  };

  // Type on row 46, year on row 47, at each bucket's first column (I/V/AI).
  const typeCells = ["I46", "V46", "AI46"];
  const yearCells = ["I47", "V47", "AI47"];
  const buckets: BucketMeta[] = BUCKET_STARTS.map((_start, i) => ({
    index: i + 1,
    type: text(ws, typeCells[i]) ?? "",
    year: parseYear(text(ws, yearCells[i])),
  }));

  return { meta, buckets };
}

/** True for a sheet whose rows should be scanned for combos. */
export function isDataSheet(name: string): boolean {
  return DATA_SHEET_RE.test(name) || name === MARKET_SEG_SHEET;
}

/** Pull every combo row from one data sheet. */
function readDataSheet(ws: XLSX.WorkSheet): ParsedRow[] {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  });

  const rows: ParsedRow[] = [];
  for (const record of grid) {
    const comboCell = record[1]; // column B
    if (typeof comboCell !== "string" || !COMBO_RE.test(comboCell)) continue;

    const combo = comboCell;
    const descCell = record[0]; // column A
    const accountCode = combo.slice(5); // 6-digit account (no "A" prefix yet)
    // A9 accounts are in actual units; all others are stored in thousands.
    const scale = accountCode.startsWith("9") ? 1 : 1000;

    const cells: number[] = new Array(WIDE_CELL_COUNT).fill(0);
    let hasValue = false;
    for (let b = 0; b < BUCKET_STARTS.length; b++) {
      const start = BUCKET_STARTS[b];
      for (let m = 0; m < MONTHS; m++) {
        const v = num(record[start + m]) * scale;
        cells[b * MONTHS + m] = v;
        if (v !== 0) hasValue = true;
      }
    }
    // Drop rows that carry no data at all — but keep any row with a single value.
    if (!hasValue) continue;

    rows.push({
      // Normalize to the app standard: "D" + dept, "A" + account.
      dept: `D${combo.slice(0, 4)}`,
      account: `A${accountCode}`,
      combo,
      description: typeof descCell === "string" ? descCell.trim() || null : null,
      cells,
    });
  }
  return rows;
}

/**
 * Parse an in-memory workbook buffer. Two passes keep large files fast: first a
 * cheap names-only read, then a full parse of only the sheets we need.
 *
 * @throws if the workbook has no "Setup Fields" sheet (not a BGT Spread File).
 */
export function parseWorkbook(
  buffer: Buffer | Uint8Array,
  sourceFileName: string
): ParsedDataset {
  const names = XLSX.read(buffer, { type: "buffer", bookSheets: true }).SheetNames;
  if (!names.includes(SETUP_SHEET)) {
    throw new Error(
      `"${sourceFileName}" is not a BGT Spread File (no "${SETUP_SHEET}" sheet).`
    );
  }

  const targets = [SETUP_SHEET, ...names.filter(isDataSheet)];
  const wb = XLSX.read(buffer, {
    type: "buffer",
    sheets: targets,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    cellDates: false,
  });

  const setup = wb.Sheets[SETUP_SHEET];
  const { meta, buckets } = readSetup(setup, sourceFileName);

  const rows: ParsedRow[] = [];
  for (const name of names) {
    if (!isDataSheet(name)) continue;
    const ws = wb.Sheets[name];
    if (ws) rows.push(...readDataSheet(ws));
  }

  return { meta, buckets, rows };
}
