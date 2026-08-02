/**
 * Budget-import repository — plaintext local store access for pulled Excel
 * budget data (budget_imports + budget_values).
 *
 * The write path (`commitImport`) is one transaction that first clears the
 * hotel's previous pull, then writes the header row and all ~160k value rows —
 * so there is at most one live import per OU (a new pull overwrites the last).
 * `getImportRows` pivots the tidy/long values back to one wide row per combo
 * (36 month cells) for the grid, summing the rare within-file duplicate combo.
 *
 * Every function takes the Database handle explicitly so tests can inject an
 * in-memory database, matching mappingTables/repo.ts.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { normalizeOu } from "../positions/ouScope";
import { ParsedDataset } from "./parseWorkbook";
import {
  BucketMeta,
  ImportSummary,
  PERIODS_PER_BUCKET,
  WideBudgetRow,
  WIDE_CELL_COUNT,
} from "../../shared/budgetImport/ipc";

type LocalDb = InstanceType<typeof Database>;

/** Periods (months) per bucket — used to lay out the 36 wide cells. */
const MONTHS = PERIODS_PER_BUCKET;

interface ImportRow {
  id: string;
  ou: string;
  source_filename: string;
  hotel_name: string | null;
  bu: string | null;
  currency: string | null;
  as_of_period: string | null;
  bucket1_type: string | null;
  bucket1_year: number | null;
  bucket2_type: string | null;
  bucket2_year: number | null;
  bucket3_type: string | null;
  bucket3_year: number | null;
  row_count: number;
  imported_at: string;
  imported_by: string | null;
}

/** Reassemble the three BucketMeta from an import row's flattened columns. */
function bucketsOf(row: ImportRow): BucketMeta[] {
  return [
    { index: 1, type: row.bucket1_type ?? "", year: row.bucket1_year },
    { index: 2, type: row.bucket2_type ?? "", year: row.bucket2_year },
    { index: 3, type: row.bucket3_type ?? "", year: row.bucket3_year },
  ];
}

function toSummary(row: ImportRow): ImportSummary {
  return {
    id: row.id,
    ou: row.ou,
    sourceFileName: row.source_filename,
    hotelName: row.hotel_name,
    bu: row.bu,
    currency: row.currency,
    asOfPeriod: row.as_of_period,
    buckets: bucketsOf(row),
    rowCount: row.row_count,
    importedAt: row.imported_at,
    importedBy: row.imported_by,
  };
}

/**
 * Persist one parsed dataset under the given OU. One transaction: the header
 * plus every (combo × bucket × month) value row. `id` and `importedAt` are
 * passed in so this module stays free of clock/uuid calls and is deterministic
 * under test.
 */
export function commitImport(
  db: LocalDb,
  params: {
    id: string;
    ou: string;
    importedBy: string | null;
    dataset: ParsedDataset;
    importedAt: string;
  }
): void {
  const { id, ou, importedBy, dataset, importedAt } = params;
  const { meta, buckets, rows } = dataset;
  const scoped = normalizeOu(ou) ?? ou;

  const insertImport = db.prepare(`
    INSERT INTO budget_imports (
      id, ou, source_filename, hotel_name, bu, currency, as_of_period,
      bucket1_type, bucket1_year, bucket2_type, bucket2_year,
      bucket3_type, bucket3_year, imported_at, imported_by, row_count
    ) VALUES (
      @id, @ou, @source_filename, @hotel_name, @bu, @currency, @as_of_period,
      @bucket1_type, @bucket1_year, @bucket2_type, @bucket2_year,
      @bucket3_type, @bucket3_year, @imported_at, @imported_by, @row_count
    )
  `);

  const insertValue = db.prepare(`
    INSERT INTO budget_values (
      import_id, ou, dept, account, combo,
      bucket_index, bucket_type, year, period, value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    // Overwrite: a hotel keeps only its latest pull.
    db.prepare("DELETE FROM budget_values WHERE ou = ?").run(scoped);
    db.prepare("DELETE FROM budget_imports WHERE ou = ?").run(scoped);

    insertImport.run({
      id,
      ou: scoped,
      source_filename: meta.sourceFileName,
      hotel_name: meta.hotelName,
      bu: meta.bu,
      currency: meta.currency,
      as_of_period: meta.asOfPeriod,
      bucket1_type: buckets[0]?.type ?? null,
      bucket1_year: buckets[0]?.year ?? null,
      bucket2_type: buckets[1]?.type ?? null,
      bucket2_year: buckets[1]?.year ?? null,
      bucket3_type: buckets[2]?.type ?? null,
      bucket3_year: buckets[2]?.year ?? null,
      imported_at: importedAt,
      imported_by: importedBy,
      row_count: rows.length,
    });

    for (const row of rows) {
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        for (let m = 0; m < MONTHS; m++) {
          insertValue.run(
            id,
            scoped,
            row.dept,
            row.account,
            row.combo,
            bucket.index,
            bucket.type || null,
            bucket.year,
            m + 1,
            row.cells[b * MONTHS + m] ?? 0
          );
        }
      }
    }
  })();
}

/** The hotel's current import summary, or null if it has never pulled. */
export function getCurrentImport(db: LocalDb, ou: string): ImportSummary | null {
  const scoped = normalizeOu(ou) ?? ou;
  const row = db
    .prepare(`SELECT * FROM budget_imports WHERE ou = ?`)
    .get(scoped) as ImportRow | undefined;
  return row ? toSummary(row) : null;
}

/**
 * The department codes this hotel's budget file actually carries, in GL order.
 *
 * The mapping tables hold every department in the chain — 200-plus — which is
 * useless as a picker for one hotel. The BST pull is the hotel's own chart: a
 * sheet per department it really operates. Codes come out in the app's standard
 * "D"+4-digit form (parseWorkbook normalizes them), so they line up with a
 * position's departmentCode without translation.
 */
export function listImportDepartments(db: LocalDb, ou: string): string[] {
  const scoped = normalizeOu(ou) ?? ou;
  const rows = db
    .prepare(
      `SELECT DISTINCT dept
         FROM budget_values
        WHERE ou = ? AND dept <> ''
        ORDER BY dept`
    )
    .all(scoped) as Array<{ dept: string }>;
  return rows.map((row) => row.dept);
}

/** Build the 36 pivot columns `c_<bucket>_<period>` once. */
const PIVOT_COLUMNS: string = (() => {
  const parts: string[] = [];
  for (let b = 1; b <= 3; b++) {
    for (let p = 1; p <= MONTHS; p++) {
      parts.push(
        `SUM(CASE WHEN bucket_index = ${b} AND period = ${p} THEN value ELSE 0 END) AS c_${b}_${p}`
      );
    }
  }
  return parts.join(",\n           ");
})();

/**
 * Wide rows for a hotel's current import: the tidy values pivoted to one row per
 * combo, with 36 month cells in bucket-major order, ordered by combo (GL order).
 */
export function getImportRows(db: LocalDb, ou: string): WideBudgetRow[] {
  const scoped = normalizeOu(ou) ?? ou;
  const records = db
    .prepare(
      `SELECT combo,
              MAX(dept) AS dept,
              MAX(account) AS account,
              ${PIVOT_COLUMNS}
         FROM budget_values
        WHERE ou = ?
        GROUP BY combo
        ORDER BY combo`
    )
    .all(scoped) as Array<Record<string, string | number>>;

  return records.map((rec): WideBudgetRow => {
    const cells: number[] = new Array(WIDE_CELL_COUNT).fill(0);
    for (let b = 1; b <= 3; b++) {
      for (let p = 1; p <= MONTHS; p++) {
        cells[(b - 1) * MONTHS + (p - 1)] = Number(rec[`c_${b}_${p}`] ?? 0);
      }
    }
    return {
      id: String(rec.combo),
      combo: String(rec.combo),
      dept: String(rec.dept ?? ""),
      account: String(rec.account ?? ""),
      description: null,
      cells,
    };
  });
}
