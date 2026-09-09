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
import type { OutputValueKind, ResultEncoding } from "../positions/ipc";
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
  /** From the results cache: "percent" marks an allocation share. */
  valueKind?: OutputValueKind;
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
      // them, and let the encodings decide the entry's kind below. A kind the
      // rows disagree on reads as an amount.
      vec.addInto(existing.vec, series);
      encodings.get(key)!.add(encoding);
      if (existing.valueKind !== undefined && existing.valueKind !== (row.valueKind ?? existing.valueKind)) {
        existing.valueKind = "currency";
      }
    } else {
      const entry: ComboEntry = { dept, account, vec: series, reportVec: series, encoding };
      if (row.valueKind !== undefined) entry.valueKind = row.valueKind;
      byKey.set(key, entry);
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

/** An entry back into the row shape buildValueSource takes — the stored
 *  series, its total and its kinds, so a rebuilt source recomputes
 *  `reportVec` rather than inheriting one. */
function toInput(entry: ComboEntry): ValueSourceInput {
  const input: ValueSourceInput = {
    dept: entry.dept,
    account: entry.account,
    months: entry.vec.subarray(0, vec.MONTHS),
    total: entry.vec[vec.TOTAL],
    encoding: entry.encoding,
  };
  if (entry.valueKind !== undefined) input.valueKind = entry.valueKind;
  return input;
}

const comboKey = (entry: { dept: string; account: string }) => `${entry.dept}-${entry.account}`;

// ---------------------------------------------------------------------------
// The overlay: the BST as it would read after a push
// ---------------------------------------------------------------------------

/**
 * The BST bucket with the scenario's results laid over it — what a pull would
 * hold after a full replace-push of this scenario, and therefore the one way
 * to read plan and BST together without counting a pushed figure twice.
 *
 * Mirrors the push (bstPush/plan.ts): its value pass writes EVERY Results row,
 * prefix-matched or not, and only its clear pass is scoped by the clear-rule
 * prefixes. So:
 *   (i)   every cache combo `ownsEntry` admits replaces the BST combo — the
 *         caller excludes allocation shares, which the push guards `skip`;
 *   (ii)  a BST combo whose account `clearsAccount` admits and that the cache
 *         does not hold AT ALL is dropped, as the clear pass would zero it —
 *         but a combo the cache holds as an allocation share keeps the BST's
 *         figure, since the push guards those `skip` in the clear pass too;
 *   (iii) everything else is the BST's.
 * Month plans (`skip`/`add`) and cell guards are not modelled: this is the
 * full-replace reading, and the drift check says how far the BST is from it.
 * A BST allocation row is not flagged in the import, so a cache amount landing
 * on one still overlays — the documented gap.
 */
export function overlaySource(
  id: string,
  base: ValueSource,
  overlay: ValueSource,
  ownsEntry: (entry: ComboEntry) => boolean,
  clearsAccount: (bareAccount: string) => boolean
): ValueSource {
  const inputs: ValueSourceInput[] = [];
  const replaced = new Set<string>();
  const known = new Set<string>();
  for (const entry of overlay.entries) {
    known.add(comboKey(entry));
    if (!ownsEntry(entry)) continue;
    replaced.add(comboKey(entry));
    inputs.push(toInput(entry));
  }
  for (const entry of base.entries) {
    const key = comboKey(entry);
    if (replaced.has(key)) continue;
    // A combo the overlay holds but does not own is an allocation share, which
    // the push guards `skip` in both passes — so the BST keeps its own figure
    // rather than losing it to a clear rule that will never reach it.
    if (clearsAccount(entry.account) && !known.has(key)) continue;
    inputs.push(toInput(entry));
  }
  return buildValueSource(id, inputs);
}

export interface DriftTolerance {
  /** Absolute, in real units, for amount accounts. */
  currency: number;
  /** Absolute, for statistic accounts (bare code starting with "9"). */
  stats: number;
}

/** The push divides amounts by 1,000 unrounded and the pull multiplies them
 *  back, so a faithful round trip differs by float noise only; the tolerance
 *  is for figures someone then typed over in Excel. */
export const DEFAULT_DRIFT_TOLERANCE: DriftTolerance = { currency: 0.5, stats: 0.005 };

export type DriftKind = "differs" | "onlyInPlan" | "onlyInBst";

export interface DriftEntry {
  dept: string;
  account: string;
  kind: DriftKind;
  /** plan − bst per month; slot 12 = Σ|months|. */
  delta: number[];
}

export interface PlanDrift {
  /** Combos held by both whose stored months differ beyond tolerance. */
  differing: number;
  /** Combos the plan produces that the BST does not hold. */
  onlyInPlan: number;
  /** BST combos the push would clear (in the clear rules, absent from the plan). */
  onlyInBst: number;
  /** Σ|plan − bst| per month over every combo above; slot 12 = the year's Σ. */
  absDelta: number[];
  /** The largest movers, |Σ months| descending, at most `TOP_DRIFT_ENTRIES`. */
  top: DriftEntry[];
}

export const TOP_DRIFT_ENTRIES = 20;

const isStatsAccount = (bareCode: string) => bareCode.startsWith("9");

/** True when a stored row holds nothing worth clearing — every month zero
 *  within the account's tolerance. */
function isZeroSeries(entry: ComboEntry, tolerance: DriftTolerance): boolean {
  const limit = isStatsAccount(entry.account) ? tolerance.stats : tolerance.currency;
  for (let m = 0; m < vec.MONTHS; m++) {
    if (Math.abs(entry.vec[m]) > limit) return false;
  }
  return true;
}

/**
 * How far the BST is from the overlay — i.e. what a push would change. Reads
 * the STORED months on both sides (`vec`, not `reportVec`): the BST holds a
 * level statistic exactly as Kairos posts it, January plus changes, so stored
 * form is the comparable one. Zero everywhere means "pushed and pulled, nothing
 * moved since" — which only holds if every counted row is one a push can
 * actually change. Three that it cannot are therefore not counted:
 *   - a BST combo the plan holds but does not own (an allocation share:
 *     ownsEntry rejects it because the push guards those `skip`). The plan has
 *     it, so it is not "only in the BST", and no push will clear it;
 *   - a BST row whose months are all zero. Clearing it writes the zero it
 *     already holds. The import keeps a row that is empty in THIS bucket as
 *     long as another bucket carries a value, so a pulled BST is full of them;
 *   - an all-zero plan row the BST does not hold — the push's own `no_data`:
 *     it will not add a row to write zeroes into.
 * Without all three, a faithful push-then-pull leaves the banner standing
 * forever over rows no push can ever reconcile.
 */
export function comparePlanToBst(
  plan: ValueSource,
  bst: ValueSource,
  ownsEntry: (entry: ComboEntry) => boolean,
  clearsAccount: (bareAccount: string) => boolean,
  tolerance: DriftTolerance = DEFAULT_DRIFT_TOLERANCE
): PlanDrift {
  const drift: PlanDrift = { differing: 0, onlyInPlan: 0, onlyInBst: 0, absDelta: new Array(13).fill(0), top: [] };
  const entries: DriftEntry[] = [];
  /** Every combo the plan holds, owned or not — see the note above. */
  const known = new Set<string>();

  const record = (entry: ComboEntry, other: Vec13 | null, kind: DriftKind) => {
    const delta = new Array<number>(13).fill(0);
    let sum = 0;
    for (let m = 0; m < vec.MONTHS; m++) {
      delta[m] = kind === "onlyInBst" ? -entry.vec[m] : entry.vec[m] - (other ? other[m] : 0);
      sum += Math.abs(delta[m]);
      drift.absDelta[m] += Math.abs(delta[m]);
    }
    delta[vec.TOTAL] = sum;
    drift.absDelta[vec.TOTAL] += sum;
    entries.push({ dept: entry.dept, account: entry.account, kind, delta });
  };

  for (const entry of plan.entries) {
    known.add(comboKey(entry));
    if (!ownsEntry(entry)) continue;
    const held = bst.get(entry.dept, entry.account);
    if (!held) {
      // The push's `no_data`: nothing to write, and it will not add the row.
      if (isZeroSeries(entry, tolerance)) continue;
      drift.onlyInPlan++;
      record(entry, null, "onlyInPlan");
      continue;
    }
    const limit = isStatsAccount(entry.account) ? tolerance.stats : tolerance.currency;
    let differs = false;
    for (let m = 0; m < vec.MONTHS; m++) {
      if (Math.abs(entry.vec[m] - held.vec[m]) > limit) {
        differs = true;
        break;
      }
    }
    if (differs) {
      drift.differing++;
      record(entry, held.vec, "differs");
    }
  }

  for (const entry of bst.entries) {
    if (known.has(comboKey(entry)) || !clearsAccount(entry.account)) continue;
    if (isZeroSeries(entry, tolerance)) continue;
    drift.onlyInBst++;
    record(entry, null, "onlyInBst");
  }

  entries.sort(
    (a, b) =>
      b.delta[vec.TOTAL] - a.delta[vec.TOTAL] ||
      a.dept.localeCompare(b.dept) ||
      a.account.localeCompare(b.account)
  );
  drift.top = entries.slice(0, TOP_DRIFT_ENTRIES);
  return drift;
}

export const hasDrift = (drift: PlanDrift | null | undefined): boolean =>
  !!drift && drift.differing + drift.onlyInPlan + drift.onlyInBst > 0;

// ---------------------------------------------------------------------------
// Map index
// ---------------------------------------------------------------------------

/** One mapping-table row: the base code and its level_0..level_30 labels,
 *  plus the row's own description when the reader has it. */
export interface MapRowInput {
  code: string;
  levels: ReadonlyArray<string | null | undefined>;
  name?: string | null;
}

export type MapSide = "dept" | "account";

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
  /** The inverse: a code's label at a level (trimmed), or null when the code
   *  is unmapped or the cell is blank. */
  labelAt(side: MapSide, code: string, level: number): string | null;
  /** The row's own description, or null. */
  name(side: MapSide, code: string): string | null;
  /** Anything worth telling the report about the maps themselves. */
  warnings: readonly ReportWarning[];
}

const EMPTY_SET: ReadonlySet<string> = new Set();

interface SideIndex {
  rows: Map<string, ReadonlyArray<string | null | undefined>>;
  names: Map<string, string>;
  /** level → label → codes, built one level at a time on first use. */
  byLevel: Map<number, Map<string, Set<string>>>;
}

function buildSide(
  rows: Iterable<MapRowInput>,
  bare: (code: string) => string,
  sideName: string,
  warnings: ReportWarning[]
): SideIndex {
  const index: SideIndex = { rows: new Map(), names: new Map(), byLevel: new Map() };
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
    const name = String(row.name ?? "").trim();
    if (name) index.names.set(code, name);
    else index.names.delete(code);
  }
  return index;
}

function labelOf(side: SideIndex, code: string, level: number): string | null {
  const raw = side.rows.get(code)?.[level];
  if (raw === null || raw === undefined) return null;
  const label = String(raw).trim();
  return label || null;
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
  const sideOf = (side: MapSide) => (side === "dept" ? depts : accts);
  const bareOf = (side: MapSide) => (side === "dept" ? bareDept : bareAccount);
  return {
    version,
    available: true,
    deptCodes: (level, values) => codesAtLevel(depts, level, values),
    accountCodes: (level, values) => codesAtLevel(accts, level, values),
    hasDept: (code) => depts.rows.has(bareDept(code)),
    hasAccount: (code) => accts.rows.has(bareAccount(code)),
    labelAt: (side, code, level) => labelOf(sideOf(side), bareOf(side)(code), level),
    name: (side, code) => sideOf(side).names.get(bareOf(side)(code)) ?? null,
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
  labelAt: () => null,
  name: () => null,
  warnings: [],
};
