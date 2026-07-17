import * as XLSX from 'xlsx';
import api from '../api';
import { SubmissionWindow, deriveWindowMonths } from '../submissionWindowService';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BST extract → Owner-Budget upload (ETL)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Parses a single BST planning extract in the renderer, unpivots its 12 month
 * columns into one row per (department, account, period), and submits them to
 * POST /act-bud-fcst-data/owner-budget.
 *
 * The transform is a faithful port of the source Power Query (M) script, with
 * three deliberate differences:
 *   • scenario / version come from the selected WINDOW (not hardcoded)
 *   • currency comes from the hotel metadata (not hardcoded)
 *   • load_date / load_id are NOT sent (server-managed)
 *
 * Column layout is keyed off fixed POSITIONS, not header names — the export's
 * month headers vary between cycles (e.g. "2026-07" vs "2026 - M 1").
 */

/** 0-based column positions in the BST extract. */
const COL = {
  OU: 7, // H — Operating Unit (bare code, e.g. "25RQ7")
  DEPARTMENT: 8, // I — Department (e.g. "10")
  ACCOUNT: 10, // K — Account (e.g. "961012")
  FIRST_MONTH: 11, // L — first monthly amount; runs through W (index 22)
} as const;

/** The extract carries 12 contiguous month columns (L..W). */
const MONTHS_IN_FILE = 12;

/** Account excluded by the default "Ignore 700304" toggle. */
const IGNORED_ACCOUNT = 'A700304';

/**
 * Reservation-allocation lines excluded by the default toggle: exact
 * account+department pairs, keyed "<account>|<department>" in their final
 * (A-/D-prefixed) form.
 */
const RESERVATION_ALLOCATION_COMBOS = new Set<string>([
  'A660112|D0010',
  'A759101|D0120',
]);

/** Accounts whose code starts with "3" (→ "A3…") are sign-flipped. */
const NEGATE_PREFIX = 'A3';

const PERIOD_RE = /^\d{4}-\d{2}$/;

/** One row in the shape POST /act-bud-fcst-data/owner-budget expects. */
export interface OwnerBudgetRow {
  ou: string; // exactly 7 chars; identical for every row
  period: string; // YYYY-MM, inside the window
  department: string; // exactly 5 chars
  account: string; // exactly 7 chars
  amount: number; // whole number (rounded)
  scenario: string; // == window.scenario
  version: string; // == window.version
  currency: string; // exactly 3 chars
}

export interface BstTransformOptions {
  /** 3-char hotel currency applied to every row. */
  currency: string;
  /** When true (default), rows for account A700304 are dropped. */
  ignore700304: boolean;
  /** When true (default), the reservation-allocation dept+account combos are dropped. */
  ignoreReservationAllocation: boolean;
}

/** Outcome of parsing + transforming, with counts for the review summary. */
export interface BstTransformResult {
  rows: OwnerBudgetRow[];
  sourceRows: number; // data rows read from the file
  emitted: number; // owner-budget rows produced
  skippedZeroBlank: number; // month cells that were empty or rounded to 0
  ignoredCount: number; // source rows dropped by the 700304 toggle
  reservationAllocationIgnored: number; // source rows dropped by the reservation-allocation toggle
  skippedNonNumeric: number; // month cells that were non-numeric
  ouMismatch: number; // source rows whose OU ≠ the window's OU
}

/** 201 response from the owner-budget endpoint. */
export interface OwnerBudgetUploadResponse {
  ou: string;
  scenarios: string[];
  versions: string[];
  periods: string[];
  deleted_count: number;
  inserted_count: number;
  load_id: string;
}

// ── Pure field formatters (exported for unit testing) ───────────────────────

/** Operating unit → "OU" + uppercased code, e.g. "25RQ7" → "OU25RQ7". */
export function formatOu(raw: unknown): string {
  return 'OU' + String(raw ?? '').trim().toUpperCase();
}

/** Department → "D" + last 4 of the zero-padded code, e.g. "10" → "D0010". */
export function formatDepartment(raw: unknown): string {
  return 'D' + ('0000' + String(raw ?? '').trim()).slice(-4);
}

/** Account → "A" + code, e.g. "961012" → "A961012". */
export function formatAccount(raw: unknown): string {
  return 'A' + String(raw ?? '').trim();
}

/**
 * Reduce any OU representation to its bare code for comparison: strips a
 * leading "OU" (only when 5+ chars follow) and surrounding whitespace. Lets us
 * match the file's bare code against the window's OU regardless of whether the
 * canonical form is "OU25RQ7" or a space-padded "25RQ7  ".
 */
function ouCode(x: unknown): string {
  return String(x ?? '').trim().toUpperCase().replace(/^OU(?=.{5,})/, '');
}

// ── Parse ────────────────────────────────────────────────────────────────────

/**
 * Name of the worksheet carrying the GL data. The BST extract (.xlsm) ships two
 * tabs — "Balancing" and "GL" — and the budget rows live on GL. We select by
 * name (case/whitespace-insensitive) rather than position, because "Balancing"
 * sorts first in the workbook.
 */
const GL_SHEET_NAME = 'GL';

/**
 * Read the GL sheet of an xlsx/xlsm/xls File into an array-of-arrays.
 * Mirrors the conventions in services/imports/utils/fileParser.ts.
 */
async function readSheetRows(file: File): Promise<unknown[][]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const workbook = XLSX.read(data, {
    type: 'array',
    cellDates: true,
    cellNF: false,
    cellText: false,
  });
  if (workbook.SheetNames.length === 0) {
    throw new Error('The file contains no worksheets.');
  }
  const sheetName = workbook.SheetNames.find(
    (name) => name.trim().toLowerCase() === GL_SHEET_NAME.toLowerCase(),
  );
  if (!sheetName) {
    throw new Error(
      `Could not find a "${GL_SHEET_NAME}" worksheet. ` +
        `Found: ${workbook.SheetNames.join(', ')}.`,
    );
  }
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
  }) as unknown[][];
}

// ── Transform ─────────────────────────────────────────────────────────────────

/**
 * Unpivot the parsed rows into owner-budget rows for the selected window.
 *
 * Single O(rows × period_count) pass. Periods come from the window (positional:
 * file column FIRST_MONTH+j ↦ window month j), so every emitted period is
 * inside the window by construction. Skips header/blank rows, the 700304
 * account (when toggled on), rows for a different OU, and blank/zero cells.
 */
export function transformToOwnerBudgetRows(
  sheetRows: unknown[][],
  window: SubmissionWindow,
  options: BstTransformOptions,
): BstTransformResult {
  const months = deriveWindowMonths(window.start_period, window.period_count);
  const monthCount = Math.min(months.length, MONTHS_IN_FILE);
  const windowCode = ouCode(window.ou);

  const rows: OwnerBudgetRow[] = [];
  let sourceRows = 0;
  let skippedZeroBlank = 0;
  let ignoredCount = 0;
  let reservationAllocationIgnored = 0;
  let skippedNonNumeric = 0;
  let ouMismatch = 0;

  for (const row of sheetRows) {
    if (!Array.isArray(row)) continue;

    // Drop header / junk rows: the account cell is blank or the literal "Account".
    const rawAccount = String(row[COL.ACCOUNT] ?? '').trim();
    if (rawAccount === '' || rawAccount.toLowerCase() === 'account') continue;
    sourceRows++;

    const account = formatAccount(rawAccount);
    const department = formatDepartment(row[COL.DEPARTMENT]);

    if (options.ignore700304 && account === IGNORED_ACCOUNT) {
      ignoredCount++;
      continue;
    }

    if (
      options.ignoreReservationAllocation &&
      RESERVATION_ALLOCATION_COMBOS.has(`${account}|${department}`)
    ) {
      reservationAllocationIgnored++;
      continue;
    }

    // Guard: the file must belong to the selected window's OU.
    if (ouCode(row[COL.OU]) !== windowCode) {
      ouMismatch++;
      continue;
    }

    const negate = account.startsWith(NEGATE_PREFIX);

    for (let j = 0; j < monthCount; j++) {
      const cell = row[COL.FIRST_MONTH + j];
      if (cell === '' || cell === null || cell === undefined) {
        skippedZeroBlank++;
        continue;
      }
      const value = Number(cell);
      if (!Number.isFinite(value)) {
        skippedNonNumeric++;
        continue;
      }
      const amount = Math.round(negate ? -value : value);
      if (amount === 0) {
        skippedZeroBlank++;
        continue;
      }
      rows.push({
        ou: window.ou,
        period: months[j].period,
        department,
        account,
        amount,
        scenario: window.scenario,
        version: window.version,
        currency: options.currency,
      });
    }
  }

  return {
    rows,
    sourceRows,
    emitted: rows.length,
    skippedZeroBlank,
    ignoredCount,
    reservationAllocationIgnored,
    skippedNonNumeric,
    ouMismatch,
  };
}

/** Read + transform a BST file in one call (used on file selection). */
export async function parseAndTransformBstFile(
  file: File,
  window: SubmissionWindow,
  options: BstTransformOptions,
): Promise<BstTransformResult> {
  const sheetRows = await readSheetRows(file);
  return transformToOwnerBudgetRows(sheetRows, window, options);
}

// ── Validate ──────────────────────────────────────────────────────────────────

/**
 * Pre-flight validation mirroring the server contract, so we surface problems
 * before the (destructive) POST. Returns a capped list of "Row N: …" messages.
 */
export function validateOwnerBudgetRows(
  rows: OwnerBudgetRow[],
  window: SubmissionWindow,
): string[] {
  const errors: string[] = [];
  const MAX_ERRORS = 20;

  for (let i = 0; i < rows.length && errors.length < MAX_ERRORS; i++) {
    const r = rows[i];
    const n = i + 1;
    if (r.ou.length !== 7) errors.push(`Row ${n}: ou "${r.ou}" must be exactly 7 chars`);
    if (!PERIOD_RE.test(r.period)) errors.push(`Row ${n}: period "${r.period}" must be YYYY-MM`);
    if (r.department.length !== 5)
      errors.push(`Row ${n}: department "${r.department}" must be exactly 5 chars`);
    if (r.account.length !== 7)
      errors.push(`Row ${n}: account "${r.account}" must be exactly 7 chars`);
    if (r.currency.length !== 3)
      errors.push(`Row ${n}: currency "${r.currency}" must be exactly 3 chars`);
    if (!Number.isInteger(r.amount))
      errors.push(`Row ${n}: amount ${r.amount} must be a whole number`);
    if (!r.scenario || r.scenario !== window.scenario)
      errors.push(`Row ${n}: scenario must equal the window's "${window.scenario}"`);
    if (!r.version || r.version !== window.version)
      errors.push(`Row ${n}: version must equal the window's "${window.version}"`);
  }

  return errors;
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Submit the owner-budget rows. Body is { data: rows } — no signed_by; the
 * server stamps the submitter from the token. Mirrors the 422/detail error
 * mapping used by submittedDataService.uploadBulk.
 */
export async function uploadOwnerBudget(
  rows: OwnerBudgetRow[],
): Promise<OwnerBudgetUploadResponse> {
  const response = await api.post('/act-bud-fcst-data/owner-budget', { data: rows });

  if (!response.ok) {
    const error = await response.json();

    // 422 — array of {loc, msg, type}
    if (Array.isArray(error.detail)) {
      const messages = error.detail
        .map((e: any) => `${e.loc?.join(' -> ') || 'Field'}: ${e.msg}`)
        .join('\n');
      throw new Error(`Validation errors:\n${messages}`);
    }

    // 400 / 403 — string detail (e.g. "no open window" / "locked" / access)
    throw new Error(error.detail || 'Failed to upload owner-budget data');
  }

  return await response.json();
}
