/**
 * The results cache — dept × account × month rows of a run (encrypted store).
 *
 * `engine_output_lines` keeps the per-(source row, component) grain that the
 * Results inspector drills into; this module owns the aggregated read of it.
 * The aggregation used to live inside readOutputs and ran over every line on
 * every page open. It now runs ONCE, when the run is written (writeRun), and its
 * rows are persisted in `results_cache` beside the lines, in the same
 * transaction — so the Results page, the BST push and the report engine all
 * read one table and can never disagree about what a combo is worth.
 *
 * Everything here takes the Database handle explicitly and stays free of
 * Electron imports; vitest drives it against in-memory databases.
 *
 * The aggregation rules are domain rules about what a RESULT is, carried over
 * unchanged from the read path they replace:
 *   - a combo is keyed canonical (comboKeyOf), so every spelling of a code the
 *     sources wrote lands on one row — the row the BST holds;
 *   - `total` accumulates the lines' own totals in line order (float parity
 *     with the historical read);
 *   - the block chips are the ENGINE labels ordered by summed |contribution|,
 *     name as the tie-break, capped at BLOCK_LABEL_CAP;
 *   - the value kind is "percent" only when the row is nothing but allocation
 *     splits; otherwise count for a statistics account, currency for the rest.
 * Plus one new fact the read path never carried: the row's `encoding`.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { accountAllowed } from "../../shared/positions/fields";
import {
  comboKeyOf,
  displayAccount,
  displayDept,
} from "../../shared/positions/comboKey";
import {
  OutputEncoding,
  OutputSource,
  OutputValueKind,
  ResultEncoding,
} from "../../shared/positions/ipc";
import { STATS_ACCOUNT_FILTER } from "../../shared/positions/systemAccounts";
import { OuScope } from "./ouScope";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

const MONTHS = 12;

/** How many block names one row will carry. A row that names twenty blocks
 *  answers nothing, and the inspector is where the full list belongs. */
export const BLOCK_LABEL_CAP = 12;

/** Display order for a row's source chips — engine first, then the hand-made
 *  sources in the order a user meets them in the app. */
export const SOURCE_ORDER: readonly OutputSource[] = [
  "ENGINE",
  "MANUAL",
  "ALLOCATION",
  "BUYOUT",
  "SETUP",
];

const SOURCE_SET: ReadonlySet<string> = new Set(SOURCE_ORDER);

/** Rows written before the provenance columns existed carry '' — they are all
 *  engine lines, which is what the column DEFAULT says too. */
export function normalizeSource(value: unknown): OutputSource {
  const source = String(value ?? "");
  return SOURCE_SET.has(source) ? (source as OutputSource) : "ENGINE";
}

/** Lines written before `encoding` existed carry '' or the column DEFAULT —
 *  both read as a monthly amount. Only an explicit LEVEL is a level. */
export function normalizeEncoding(value: unknown): OutputEncoding {
  return value === "LEVEL" ? "LEVEL" : "AMOUNT";
}

/** Convention carried from the workbook: stats accounts (counts/hours/FTE) are
 *  the A9… range, everything else is currency. Display-only — it drives the
 *  Results page's Costs/Statistics toggle. Resolved through the shared filter
 *  and matcher, so it cannot drift from what the account pickers offer. */
export function isStatsAccount(account: string): boolean {
  return accountAllowed(account, STATS_ACCOUNT_FILTER);
}

/**
 * How the Results grid should read this row's numbers.
 *
 * An allocation split is a share out of 100, so "percent" tells the grid to
 * render it with a % sign rather than as money. A row is only a percent if EVERY
 * line in it is one: the moment a real statistic shares the account, the numbers
 * are ordinary counts again and pretending otherwise would hide the collision.
 */
export function resolveValueKind(
  isStats: boolean,
  sources: ReadonlySet<OutputSource>
): OutputValueKind {
  if (sources.size === 1 && sources.has("ALLOCATION")) return "percent";
  return isStats ? "count" : "currency";
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** The slice of a line the aggregation reads — what writeRun holds in memory
 *  and what readLinesForAggregation reads back off disk. */
export interface AggregatableLine {
  dept: string;
  account: string;
  months: readonly number[];
  total: number;
  source?: string | null;
  label?: string | null;
  encoding?: string | null;
}

/** One results_cache row, as the page and the report engine read it. Codes
 *  are canonical ("D0410" / "A988112"). */
export interface ResultsCacheRow {
  dept: string;
  account: string;
  months: number[];
  total: number;
  isStats: boolean;
  valueKind: OutputValueKind;
  encoding: ResultEncoding;
  sources: OutputSource[];
  blockLabels: string[];
}

/**
 * Lines → one row per canonical dept × account, sorted by dept then account.
 *
 * Pure: the same function serves the run write, the cache rebuild, the
 * on-the-fly fallback for a run that predates the cache, and the tests that
 * pin all three to one answer.
 */
export function aggregateResultRows(
  lines: Iterable<AggregatableLine>
): ResultsCacheRow[] {
  const byKey = new Map<string, ResultsCacheRow>();
  const sourcesByKey = new Map<string, Set<OutputSource>>();
  const encodingsByKey = new Map<string, Set<OutputEncoding>>();
  /** Per row: block label → summed |contribution|, so the chips can be ordered
   *  by what actually drives the number rather than by insertion. */
  const blocksByKey = new Map<string, Map<string, number>>();

  for (const line of lines) {
    // Keyed on the canonical combo, not the raw strings: "D0410" and a typed
    // "0410" are one row here because they are one row in the BST.
    const key = comboKeyOf(line.dept, line.account);
    let row = byKey.get(key);
    if (!row) {
      const account = displayAccount(line.account);
      row = {
        dept: displayDept(line.dept),
        account,
        months: new Array<number>(MONTHS).fill(0),
        total: 0,
        isStats: isStatsAccount(account),
        valueKind: "currency",
        encoding: "AMOUNT",
        sources: [],
        blockLabels: [],
      };
      byKey.set(key, row);
      sourcesByKey.set(key, new Set());
      encodingsByKey.set(key, new Set());
      blocksByKey.set(key, new Map());
    }
    const source = normalizeSource(line.source);
    sourcesByKey.get(key)!.add(source);
    encodingsByKey.get(key)!.add(normalizeEncoding(line.encoding));
    const label = (line.label ?? "").trim();
    if (source === "ENGINE" && label) {
      const blocks = blocksByKey.get(key)!;
      blocks.set(label, (blocks.get(label) ?? 0) + Math.abs(line.total));
    }
    for (let m = 0; m < MONTHS; m++) {
      row.months[m] += Number(line.months[m]) || 0;
    }
    row.total += line.total;
  }

  for (const [key, row] of byKey) {
    const sources = sourcesByKey.get(key)!;
    row.sources = SOURCE_ORDER.filter((source) => sources.has(source));
    row.blockLabels = [...blocksByKey.get(key)!.entries()]
      // Biggest driver first, name as the tie-break so a row's chips are stable
      // between reads (two blocks contributing zero must not swap places).
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, BLOCK_LABEL_CAP)
      .map(([label]) => label);
    row.valueKind = resolveValueKind(row.isStats, sources);
    const encodings = encodingsByKey.get(key)!;
    row.encoding =
      encodings.size > 1 ? "MIXED" : encodings.has("LEVEL") ? "LEVEL" : "AMOUNT";
  }

  return [...byKey.values()].sort(compareRows);
}

function compareRows(a: ResultsCacheRow, b: ResultsCacheRow): number {
  return a.dept.localeCompare(b.dept) || a.account.localeCompare(b.account);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const MONTH_COLUMNS = Array.from(
  { length: MONTHS },
  (_, m) => `m${String(m + 1).padStart(2, "0")}`
);

// Constant SQL text so the prepared-statement cache hits on every write.
const INSERT_ROW_SQL = `INSERT INTO results_cache
  (ou, scenario_id, dept, account, year, ${MONTH_COLUMNS.join(", ")},
   total, is_stats, value_kind, encoding, sources, block_labels, written_at)
  VALUES (?, ?, ?, ?, ?, ${MONTH_COLUMNS.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_ROWS_SQL = `SELECT dept, account, ${MONTH_COLUMNS.join(", ")},
    total, is_stats, value_kind, encoding, sources, block_labels
  FROM results_cache
  WHERE ou = ? AND scenario_id = ?`;

/** Replace the scenario's cache rows. Atomic on its own; nests as a savepoint
 *  inside writeRun's transaction. */
export function writeResultsCache(
  db: Db,
  scope: OuScope,
  scenarioId: string,
  year: number,
  writtenAt: string,
  rows: readonly ResultsCacheRow[]
): void {
  db.transaction(() => {
    prepared(
      db,
      `DELETE FROM results_cache WHERE ou = ? AND scenario_id = ?`
    ).run(scope.ou, scenarioId);
    const insert = prepared(db, INSERT_ROW_SQL);
    for (const row of rows) {
      insert.run(
        scope.ou,
        scenarioId,
        row.dept,
        row.account,
        year,
        ...row.months,
        row.total,
        row.isStats ? 1 : 0,
        row.valueKind,
        row.encoding,
        JSON.stringify(row.sources),
        JSON.stringify(row.blockLabels),
        writtenAt
      );
    }
  })();
}

function parseStringArray(text: unknown): string[] {
  try {
    const parsed = JSON.parse(String(text ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/** The scenario's cache rows, sorted the way the page shows them. Empty for a
 *  run that predates the cache (see readOutputs for the fallback). */
export function readResultsCache(
  db: Db,
  scope: OuScope,
  scenarioId: string
): ResultsCacheRow[] {
  const records = prepared(db, SELECT_ROWS_SQL).all(scope.ou, scenarioId) as Array<
    Record<string, unknown>
  >;
  const rows = records.map((record): ResultsCacheRow => {
    const sources = parseStringArray(record.sources).map(normalizeSource);
    return {
      dept: String(record.dept),
      account: String(record.account),
      months: MONTH_COLUMNS.map((column) => Number(record[column]) || 0),
      total: Number(record.total) || 0,
      isStats: Number(record.is_stats) === 1,
      valueKind: (record.value_kind as OutputValueKind) ?? "currency",
      encoding:
        record.encoding === "LEVEL" || record.encoding === "MIXED"
          ? (record.encoding as ResultEncoding)
          : "AMOUNT",
      sources: SOURCE_ORDER.filter((source) => sources.includes(source)),
      blockLabels: parseStringArray(record.block_labels),
    };
  });
  return rows.sort(compareRows);
}

/** The cheap identity of what is in the cache — a memo key for anything
 *  holding the rows in memory. Both parts move on a run, the stamp alone on a
 *  rebuild, the count when a purge empties it. */
export function readResultsCacheStamp(
  db: Db,
  scope: OuScope,
  scenarioId: string
): { count: number; writtenAt: string | null } {
  const row = prepared(
    db,
    `SELECT COUNT(*) AS n, MAX(written_at) AS w FROM results_cache
      WHERE ou = ? AND scenario_id = ?`
  ).get(scope.ou, scenarioId) as { n: number; w: string | null } | undefined;
  return { count: row?.n ?? 0, writtenAt: row?.w ?? null };
}

/**
 * The scenario's lines in the shape the aggregation wants, in rowid order —
 * the order they were written, which is the order the historical read summed
 * them in. Float totals are order-sensitive, so a rebuild has to walk them the
 * same way the run did.
 */
export function readLinesForAggregation(
  db: Db,
  scope: OuScope,
  scenarioId: string
): AggregatableLine[] {
  const records = prepared(
    db,
    `SELECT dept, account, monthly_values, total, source, label, encoding
       FROM engine_output_lines
      WHERE ou = ? AND scenario_id = ?
      ORDER BY rowid`
  ).all(scope.ou, scenarioId) as Array<{
    dept: string;
    account: string;
    monthly_values: string;
    total: number;
    source: string | null;
    label: string | null;
    encoding: string | null;
  }>;
  return records.map((record) => {
    let months: number[] = [];
    try {
      months = JSON.parse(record.monthly_values) as number[];
    } catch {
      months = [];
    }
    return {
      dept: record.dept,
      account: record.account,
      months,
      total: record.total,
      source: record.source,
      label: record.label,
      encoding: record.encoding,
    };
  });
}

/**
 * Recompute the cache from whatever lines the scenario still has. The purge
 * path calls this after it removes lines by position or by definition, so the
 * cache keeps saying exactly what the lines say. Returns the row count.
 */
export function rebuildResultsCache(
  db: Db,
  scope: OuScope,
  scenarioId: string,
  year: number,
  writtenAt: string
): number {
  const rows = aggregateResultRows(readLinesForAggregation(db, scope, scenarioId));
  writeResultsCache(db, scope, scenarioId, year, writtenAt, rows);
  return rows.length;
}
