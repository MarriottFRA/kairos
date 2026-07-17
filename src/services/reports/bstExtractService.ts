/**
 * BST Extract Service
 * ====================
 * Generates a fixed-format CSV for downstream BST (Budget Submission Tool) ingest.
 *
 * Output columns (27 total):
 *   AcctString, Prod, DeptID, Acct, Acct Descr,
 *   Prior2YR YTD, LY PD1..LY PD12, TY PD1..TY PD12
 *
 * Format quirks of the BST file (deliberately hand-rolled — too specific for a
 * generic CSV library):
 *   - DeptID is written literally as `="0010"` (Excel formula trick that preserves
 *     leading zeros on open). MUST be emitted unquoted.
 *   - Numeric columns are right-padded to 26 chars to match BST's expected layout.
 *   - Prior2YR YTD is always `0.00` (BST consumes monthly periods elsewhere).
 *   - Header strings are quoted; all data fields (including Acct Descr) are
 *     unquoted to match the original BST export format. Any commas in
 *     descriptions are stripped to keep the CSV parseable.
 *
 * Data scope:
 *   - Raw GL values from financial_data (with ACT/MAIN staging reconciliation).
 *   - Balance-sheet accounts (A1xxx / A2xxx) excluded.
 *   - NO Protea repoints/movements applied — this is a raw extract.
 *   - Rows where all 25 mapped period values are 0 are skipped.
 */

import fs from "fs";
import { getBSTExtractData, resolveXAccounts, BSTExtractTuple, XAccountResolution } from "../../local_db";

/** Account ids that end in trailing X(s) — e.g. A610XXX, A6100XX, A61000X. */
const X_ACCOUNT_RE = /^A\d+X+$/;

export type Scenario = 'ACT' | 'BUD';
export type Version = 'MAIN' | 'OWNR';

/** One of the 24 mappable CSV columns (Prior2YR YTD is fixed at 0). */
export interface BSTColumnMapping {
  year: number;
  month: number;
  scenario: Scenario;
  version: Version;
}

/** Full mapping keyed by column id: 'LY_PD1'..'LY_PD12', 'TY_PD1'..'TY_PD12'. */
export type BSTMapping = Record<string, BSTColumnMapping>;

export interface BSTExtractConfig {
  ou: string;
  mapping: BSTMapping;
}

/** Column ids in CSV output order (after Prior2YR YTD which is index 0). */
export const BST_COLUMN_IDS: string[] = [
  ...Array.from({ length: 12 }, (_, i) => `LY_PD${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `TY_PD${i + 1}`),
];

const HEADER = [
  'AcctString', 'Prod', 'DeptID', 'Acct', 'Acct Descr',
  'Prior2YR YTD',
  ...Array.from({ length: 12 }, (_, i) => `LY PD${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `TY PD${i + 1}`),
];

// --- Format helpers (inlined — single use; keeps the file self-contained) ---

/** Right-align to 26 chars, 2 dp. Matches BST's column-aligned layout. */
const padNumeric = (v: number) => v.toFixed(2).padStart(26, ' ');

/** Sanitise description for unquoted CSV emission: strip commas + double-quotes. */
const sanitiseDescr = (s: string) => (s || '').replace(/[",]/g, '');

/** Strip the 'D'/'A' prefix from a stored department/account id. */
const stripPrefix = (id: string) => id && id.length > 1 ? id.slice(1) : id;

/** OU → Prod: take the rightmost 5 chars (strips both 'OU' prefix and trailing 2 digits). */
const ouToProd = (ou: string) => (ou || '').slice(-5);

export class BSTExtractService {
  async generate(config: BSTExtractConfig, filePath: string): Promise<void> {
    const { ou, mapping } = config;

    // Build the distinct tuple list the DB needs.
    // period_combo is stored zero-padded ('YYYY-MM') — matches plCalculationEngine.generatePeriods.
    const tuples: BSTExtractTuple[] = [];
    for (const colId of BST_COLUMN_IDS) {
      const m = mapping[colId];
      if (!m) continue;  // skip unmapped column (validation should prevent this)
      tuples.push({
        period_combo: `${m.year}-${String(m.month).padStart(2, '0')}`,
        scenario: m.scenario,
        version: m.version,
      });
    }

    const rows = await getBSTExtractData(ou, tuples);

    // X-account substitution: any account ending in literal X(s) is a template
    // (e.g. A610XXX) and must be relabelled to a real account from account_maps
    // before reaching BST. Resolution + description fetch is a single batched
    // DB round-trip. Rows that fail to resolve pass through with the original
    // X-id and a warning logged by resolveXAccounts.
    const xAccts = Array.from(new Set(rows.map(r => r.account).filter(a => X_ACCOUNT_RE.test(a))));
    const subs: Map<string, XAccountResolution> = xAccts.length
      ? await resolveXAccounts(xAccts)
      : new Map();

    const prod = ouToProd(ou);
    const lines: string[] = [];
    lines.push(HEADER.map(h => `"${h}"`).join(','));

    // Sort rows for stable, human-scannable output: by (substituted) AcctString
    // ascending — sort key matches what the user actually sees in the CSV.
    const resolvedAcct = (row: { account: string }) => subs.get(row.account)?.account ?? row.account;
    rows.sort((a, b) => {
      const ka = `${stripPrefix(a.department)}-${stripPrefix(resolvedAcct(a))}`;
      const kb = `${stripPrefix(b.department)}-${stripPrefix(resolvedAcct(b))}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    for (const row of rows) {
      const sub = subs.get(row.account);
      const effectiveAcct = sub?.account ?? row.account;
      const effectiveDesc = sub ? (sub.description ?? effectiveAcct) : row.account_desc;
      const deptNum = stripPrefix(row.department);
      const acctNum = stripPrefix(effectiveAcct);

      // Pivot mapped columns; collect numeric values to test for all-zero skip.
      const values: number[] = new Array(25).fill(0);   // index 0 = Prior2YR YTD
      let anyNonZero = false;
      for (let i = 0; i < BST_COLUMN_IDS.length; i++) {
        const m = mapping[BST_COLUMN_IDS[i]];
        if (!m) continue;
        const k = `${m.year}-${String(m.month).padStart(2, '0')}|${m.scenario}|${m.version}`;
        const v = row.amounts.get(k) || 0;
        values[i + 1] = v;                              // +1 because Prior2YR YTD occupies 0
        if (v !== 0) anyNonZero = true;
      }
      if (!anyNonZero) continue;                        // skip all-zero rows

      const fields: string[] = [];
      fields.push(`${deptNum}-${acctNum}`);             // AcctString (unquoted)
      fields.push(prod);                                // Prod (unquoted)
      fields.push(`="${deptNum}"`);                     // DeptID (unquoted, Excel leading-zero trick)
      fields.push(acctNum);                             // Acct (unquoted)
      fields.push(sanitiseDescr(effectiveDesc));        // Acct Descr (unquoted — matches original BST format)
      for (const v of values) fields.push(padNumeric(v));

      lines.push(fields.join(','));
    }

    // LF-only line endings — the VBA importer splits the file on CHAR(10),
    // so a CR would leave a stray \r on the last field of every row.
    const body = lines.join('\n') + '\n';
    await fs.promises.writeFile(filePath, body, { encoding: 'utf8' });
  }
}

const bstExtractService = new BSTExtractService();
export default bstExtractService;
