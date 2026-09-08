/**
 * Value sources and the map index — the two things an atom reads.
 *
 * A ValueSource is one dept × account table held in memory: the scenario's
 * results cache, or a BST import bucket. It is indexed three ways (by combo,
 * by department, by account) so an atom can walk the cheapest side. A MapIndex
 * is the account/department hierarchy from the mapping tables, answering
 * "which codes sit under label X at level N" with a memoised set.
 *
 * Both are built from plain rows, so the main process builds them from SQL
 * and the tests from literals through the same functions. Neither knows
 * about the database.
 */

import { bareAccount, bareDept } from "../positions/comboKey";
import type { ResultEncoding } from "../positions/ipc";
import type { ComboEntry, ReportWarning } from "./types";
import * as vec from "./vec";
import type { Vec13 } from "./vec";

// ---------------------------------------------------------------------------
// Value sources
// ---------------------------------------------------------------------------

export interface ValueSourceInput {
  dept: string;
  account: string;
  months: ArrayLike<number>;
  /** The stored year figure, when the source has one worth keeping (the
   *  cache's total is the sum of its lines' totals). Defaults to Σ months. */
  total?: number;
  encoding?: ResultEncoding;
}

export interface ValueSource {
  id: string;
  entries: readonly ComboEntry[];
  byDept: ReadonlyMap<string, readonly ComboEntry[]>;
  byAccount: ReadonlyMap<string, readonly ComboEntry[]>;
  /** Every department / account code present, bare. */
  deptCodes: ReadonlySet<string>;
  accountCodes: ReadonlySet<string>;
  get(dept: string, account: string): ComboEntry | undefined;
}

/** What a report reads off an entry: the running sum for a level, the series
 *  otherwise. MIXED rows are read as amounts and flagged at summation. */
function reportVecOf(series: Vec13, encoding: ResultEncoding): Vec13 {
  return encoding === "LEVEL" ? vec.cum(series) : series;
}

export function buildValueSource(
  id: string,
  rows: Iterable<ValueSourceInput>
): ValueSource {
  const byKey = new Map<string, ComboEntry>();
  const encodings = new Map<string, Set<ResultEncoding>>();

  for (const row of rows) {
    const dept = bareDept(row.dept);
    const account = bareAccount(row.account);
    const key = `${dept}-${account}`;
    const series = vec.fromMonths(row.months);
    if (row.total !== undefined && Number.isFinite(row.total)) {
      series[vec.TOTAL] = row.total;
    }
    const encoding = row.encoding ?? "AMOUNT";
    const existing = byKey.get(key);
    if (existing) {
      // Two rows for one combo (a source that did not merge spellings): sum
      // them, and let the encodings decide the entry's kind below.
      vec.addInto(existing.vec, series);
      encodings.get(key)!.add(encoding);
    } else {
      byKey.set(key, { dept, account, vec: series, reportVec: series, encoding });
      encodings.set(key, new Set([encoding]));
    }
  }

  const entries: ComboEntry[] = [];
  const byDept = new Map<string, ComboEntry[]>();
  const byAccount = new Map<string, ComboEntry[]>();
  for (const [key, entry] of byKey) {
    const kinds = encodings.get(key)!;
    entry.encoding =
      kinds.size > 1 || kinds.has("MIXED") ? "MIXED" : kinds.has("LEVEL") ? "LEVEL" : "AMOUNT";
    entry.reportVec = reportVecOf(entry.vec, entry.encoding);
    entries.push(entry);
    let d = byDept.get(entry.dept);
    if (!d) byDept.set(entry.dept, (d = []));
    d.push(entry);
    let a = byAccount.get(entry.account);
    if (!a) byAccount.set(entry.account, (a = []));
    a.push(entry);
  }

  return {
    id,
    entries,
    byDept,
    byAccount,
    deptCodes: new Set(byDept.keys()),
    accountCodes: new Set(byAccount.keys()),
    get: (dept, account) => byKey.get(`${bareDept(dept)}-${bareAccount(account)}`),
  };
}

export const EMPTY_VALUE_SOURCE: ValueSource = buildValueSource("empty", []);

// ---------------------------------------------------------------------------
// Map index
// ---------------------------------------------------------------------------

/** One mapping-table row: the base code and its level_0..level_30 labels. */
export interface MapRowInput {
  code: string;
  levels: ReadonlyArray<string | null | undefined>;
}

export interface MapIndex {
  /** The mapping-tables version the index was built from; null = none. */
  version: string | null;
  /** False on an install that has never synced the mapping tables. */
  available: boolean;
  /** Bare codes whose level_N label is one of `values`. Memoised. */
  deptCodes(level: number, values: readonly string[]): ReadonlySet<string>;
  accountCodes(level: number, values: readonly string[]): ReadonlySet<string>;
  hasDept(code: string): boolean;
  hasAccount(code: string): boolean;
  /** Anything worth telling the report about the maps themselves. */
  warnings: readonly ReportWarning[];
}

const EMPTY_SET: ReadonlySet<string> = new Set();

interface SideIndex {
  rows: Map<string, ReadonlyArray<string | null | undefined>>;
  /** level → label → codes, built one level at a time on first use. */
  byLevel: Map<number, Map<string, Set<string>>>;
}

function buildSide(
  rows: Iterable<MapRowInput>,
  bare: (code: string) => string,
  sideName: string,
  warnings: ReportWarning[]
): SideIndex {
  const index: SideIndex = { rows: new Map(), byLevel: new Map() };
  for (const row of rows) {
    const code = bare(row.code);
    if (!code) continue;
    if (index.rows.has(code)) {
      warnings.push({
        code: "DUPLICATE_MAP_CODE",
        message: `The ${sideName} maps hold "${code}" more than once (both spellings?); the last row read wins.`,
      });
    }
    index.rows.set(code, row.levels);
  }
  return index;
}

function levelLookup(side: SideIndex, level: number): Map<string, Set<string>> {
  let byLabel = side.byLevel.get(level);
  if (!byLabel) {
    byLabel = new Map();
    for (const [code, levels] of side.rows) {
      const raw = levels[level];
      if (raw === null || raw === undefined) continue;
      const label = String(raw).trim();
      if (!label) continue;
      let codes = byLabel.get(label);
      if (!codes) byLabel.set(label, (codes = new Set()));
      codes.add(code);
    }
    side.byLevel.set(level, byLabel);
  }
  return byLabel;
}

function codesAtLevel(
  side: SideIndex,
  level: number,
  values: readonly string[]
): ReadonlySet<string> {
  const byLabel = levelLookup(side, level);
  if (values.length === 1) return byLabel.get(values[0].trim()) ?? EMPTY_SET;
  const out = new Set<string>();
  for (const value of values) {
    const codes = byLabel.get(value.trim());
    if (codes) for (const code of codes) out.add(code);
  }
  return out;
}

export function buildMapIndex(
  version: string | null,
  departments: Iterable<MapRowInput>,
  accounts: Iterable<MapRowInput>
): MapIndex {
  const warnings: ReportWarning[] = [];
  const depts = buildSide(departments, bareDept, "department", warnings);
  const accts = buildSide(accounts, bareAccount, "account", warnings);
  return {
    version,
    available: true,
    deptCodes: (level, values) => codesAtLevel(depts, level, values),
    accountCodes: (level, values) => codesAtLevel(accts, level, values),
    hasDept: (code) => depts.rows.has(bareDept(code)),
    hasAccount: (code) => accts.rows.has(bareAccount(code)),
    warnings,
  };
}

/** The index of an install that has never synced: every level query is
 *  empty and every code is unmapped. Atoms that need it warn. */
export const UNAVAILABLE_MAP_INDEX: MapIndex = {
  version: null,
  available: false,
  deptCodes: () => EMPTY_SET,
  accountCodes: () => EMPTY_SET,
  hasDept: () => false,
  hasAccount: () => false,
  warnings: [],
};
