/**
 * BST Push — shared types + IPC channel names.
 *
 * The mirror of the BST Pull: instead of reading a hotel's Excel "BGT Spread
 * File" (universally called the BST), this writes the Results page's numbers
 * back into it. The app-native successor to the old `ExportData2BST` /
 * `ExportZero2BST` macros.
 *
 * Explicit by design — never an auto-sync. The user may have a different year
 * or a different revision of the file open, so every push is a deliberate act
 * against a file they pick, guarded on the OU and budget year the file itself
 * declares.
 *
 * The flow is two round-trips on purpose, matching legacyImport: `preview`
 * recalculates, reads the target and builds the plan but WRITES NOTHING;
 * `commit` re-reads the same path and rebuilds the plan through the same
 * builder before applying. The preview holds no server-side session state, so a
 * stale token can never write the wrong file.
 *
 * What gets pushed is exactly what the Results page shows — the persisted
 * dept×account×month engine output, nothing else. Anything that should reach
 * the BST must first become a Results row, so every number in the workbook can
 * be traced back in the app.
 *
 * The unit of user choice is the MONTH COLUMN (see MonthAction): each of the
 * twelve is independently skipped, replaced, added to or cleared. That subsumes
 * what used to be three separate global options, and it is the only shape that
 * expresses the real workflow — protect the actualized head of the year, rework
 * the tail. The standalone `ExportZero2BST` equivalent is gone with it: "clear
 * and write nothing" is simply every month set to `clear`, which means it goes
 * through the same preview, the same rules and the same row-level report.
 */

import {
  MAX_RECENT_FILES,
  RecentFile,
  baseName,
  findRecentFile,
  forgetRecentFile,
  normalizeRecentFiles,
  parentPath,
  recentFilesForOu,
  rememberRecentFile,
} from "../files/recentFiles";

/** Months per row, Jan..Dec. */
export const PUSH_MONTHS = 12;

/**
 * 0-based column index of January in the BST's budget block (column I).
 * Same constant the pull reads from — `BUCKET_STARTS[0]` in
 * main/budgetImport/parseWorkbook.ts. Jan..Dec occupy I..T.
 */
export const BUDGET_COL_START = 8;

/**
 * What a push does to one month's column.
 *
 * The unit of choice is the MONTH, not the push, because that is how a BST is
 * actually used through the year: by autumn the early columns hold actuals that
 * must survive untouched while the tail is still being re-forecast. A single
 * "from month N" gate could protect the head but could not clear the tail
 * without clearing everything, so each column carries its own verb.
 *
 *   skip     Never touched. The column keeps exactly what the BST already holds.
 *   replace  Clear every in-scope row for this column, then write Kairos values.
 *            The BST ends up equal to Kairos. The safe default.
 *   add      Add Kairos values onto what is there. No clearing — so pushing
 *            twice double-counts.
 *   clear    Zero the in-scope rows and write nothing back.
 *
 * "In-scope" means the clear rules (see BstPushConfig.clearPrefixes), not the
 * whole sheet — a BST column holds far more than payroll.
 */
export type MonthAction = "skip" | "replace" | "add" | "clear";

export const MONTH_ACTIONS: readonly MonthAction[] = [
  "skip",
  "replace",
  "add",
  "clear",
] as const;

/** Actions that write Kairos values into the column. */
export function writesValues(action: MonthAction): boolean {
  return action === "replace" || action === "add";
}

/** Actions that run the clear pass over the column. */
export function clearsColumn(action: MonthAction): boolean {
  return action === "replace" || action === "clear";
}

/**
 * What the push does to a guarded category of cells — the BST's allocation
 * rows and its protection-locked cells.
 *
 * The OOXML writer bypasses Excel's sheet protection entirely (protection
 * binds the Excel UI, not the file format), so without a guard the push
 * happily replaces an allocation formula with a constant. These modes give
 * the user that decision:
 *
 *   skip       Never touched — excluded from the value pass AND the clear
 *              pass, clear rules notwithstanding. The safe default.
 *   overwrite  No guard: the cell is treated like any other.
 *   clear      Zeroed in replaced/cleared months, whether or not a clear
 *              rule matches the row. Values are never written on top.
 */
export type GuardMode = "skip" | "overwrite" | "clear";

export const GUARD_MODES: readonly GuardMode[] = [
  "skip",
  "overwrite",
  "clear",
] as const;

/** Absent or garbage input falls back to `skip` — the safe default. */
export function normalizeGuardMode(raw: unknown): GuardMode {
  return raw === "overwrite" || raw === "clear" ? raw : "skip";
}

/** Options the user sets before pushing. */
export interface BstPushOptions {
  /** Jan..Dec, one action each. Always exactly PUSH_MONTHS long. */
  months: MonthAction[];
  /**
   * Rows whose column C marks them as allocations ("Allocated from 0363",
   * "Alloc from 0090", …). Applies to the whole row.
   */
  allocationRows: GuardMode;
  /**
   * Cells locked under the sheet's protection. Applies per cell — a row can
   * mix locked and unlocked month cells. Where a cell falls under both
   * guards with different modes, the most conservative wins:
   * skip > clear > overwrite.
   */
  protectedCells: GuardMode;
  /** Copy the workbook next to itself before touching it. */
  backup: boolean;
  /**
   * Write no values to a BST row when Kairos holds only zeroes for the combo —
   * the combos that exist purely because departments × accounts matrixes them
   * out. Off by default: a genuine zero is a value the BST should hold, and
   * overwriting is what the tool always did.
   *
   * Independent of the clear rules ON PURPOSE. This option governs value
   * writes only; the clear pass still zeroes every rule-matched row, skipped
   * or not. Where they overlap the plan warns rather than silently deciding —
   * a user who wants skipped rows preserved from clearing too edits the rules.
   */
  skipUnusedCombos: boolean;
}

/** Every month replaced — the same thing the old mode/zeroFirst/firstMonth
 *  defaults did, so a first-time user gets identical behaviour. */
export const DEFAULT_MONTH_PLAN: MonthAction[] = Array.from(
  { length: PUSH_MONTHS },
  () => "replace" as MonthAction
);

export const DEFAULT_BST_PUSH_OPTIONS: BstPushOptions = {
  months: [...DEFAULT_MONTH_PLAN],
  allocationRows: "skip",
  protectedCells: "skip",
  backup: true,
  skipUnusedCombos: false,
};

function isMonthAction(value: unknown): value is MonthAction {
  return (
    value === "skip" ||
    value === "replace" ||
    value === "add" ||
    value === "clear"
  );
}

/**
 * Coerce anything into a 12-entry month plan.
 *
 * Also understands the pre-per-month shape (`mode` / `zeroFirst` /
 * `firstMonth`), which is what a renderer left running across an update would
 * still be sending. `overwrite` maps to `replace` whether or not `zeroFirst`
 * was set: both intended "the BST should end up equal to Kairos", and clearing
 * a column we are about to overwrite anyway changes nothing except stale rows,
 * which is the outcome the old option existed to produce.
 */
export function normalizeMonthPlan(raw: unknown): MonthAction[] {
  if (Array.isArray(raw)) {
    return Array.from({ length: PUSH_MONTHS }, (_unused, index) =>
      isMonthAction(raw[index]) ? raw[index] : DEFAULT_MONTH_PLAN[index]
    );
  }

  const legacy = (raw ?? {}) as {
    mode?: unknown;
    zeroFirst?: unknown;
    firstMonth?: unknown;
  };
  const hasLegacy =
    legacy.mode !== undefined ||
    legacy.zeroFirst !== undefined ||
    legacy.firstMonth !== undefined;
  if (!hasLegacy) return [...DEFAULT_MONTH_PLAN];

  const firstMonth = Math.trunc(Number(legacy.firstMonth));
  const from =
    Number.isFinite(firstMonth) && firstMonth >= 1 && firstMonth <= PUSH_MONTHS
      ? firstMonth
      : 1;
  // Additive over a cleared column is just a replace.
  const written: MonthAction =
    legacy.mode === "add" && legacy.zeroFirst !== true ? "add" : "replace";

  return Array.from({ length: PUSH_MONTHS }, (_unused, index) =>
    index + 1 < from ? "skip" : written
  );
}

/** Defensive normalizer — the renderer's payload is untrusted. */
export function normalizeBstPushOptions(raw: unknown): BstPushOptions {
  const source = (raw ?? {}) as {
    months?: unknown;
    allocationRows?: unknown;
    protectedCells?: unknown;
    backup?: unknown;
    skipUnusedCombos?: unknown;
  };
  return {
    months: normalizeMonthPlan(
      source.months !== undefined ? source.months : source
    ),
    allocationRows: normalizeGuardMode(source.allocationRows),
    protectedCells: normalizeGuardMode(source.protectedCells),
    backup:
      typeof source.backup === "boolean"
        ? source.backup
        : DEFAULT_BST_PUSH_OPTIONS.backup,
    skipUnusedCombos:
      typeof source.skipUnusedCombos === "boolean"
        ? source.skipUnusedCombos
        : DEFAULT_BST_PUSH_OPTIONS.skipUnusedCombos,
  };
}

/** True when nothing at all would happen — every column left alone. */
export function isEmptyMonthPlan(months: MonthAction[]): boolean {
  return months.every((action) => action === "skip");
}

// ── Clear rules ────────────────────────────────────────────────────────────

/**
 * Accounts the clear pass zeroes, as account-code prefixes.
 *
 * The default is what the tool always did, unconfigurably: wages and benefits
 * (5xxxxx), hours (988xxx) and headcount (97254x). The macro
 * (`ExportZero2BST`, OLD VBA Engine.txt:1605) claimed the same three but two of
 * its tests read the LEFT of the combo — the department, not the account — so
 * only 5xxxxx was ever really cleared. We implement the evident intent.
 *
 * It is a default rather than a rule because it is an ASSUMPTION about which
 * accounts this tool generates, and no one knows every hotel's chart. The user
 * can see exactly what it matches and extend it.
 */
export const DEFAULT_CLEAR_PREFIXES: string[] = ["5", "988", "97254"];

/**
 * The whole rule set: what to clear, and what to keep out of it.
 *
 * `prefixes` say which accounts the clear pass owns; `excludes` carve accounts
 * back out of that, and ALWAYS win. Without them, "clear every 5xxxxx account
 * except 510001" needed the user to spell out every other 5xxxxx family as its
 * own rule; with them it is one rule and one exception. Both lists hold
 * account-code prefixes, so an exception can be one account (`510001`) or a
 * whole family (`5100`).
 *
 * "Always win" rather than longest-match is deliberate: an exception is a
 * promise that the account is not this tool's to wipe, and a promise that a
 * more specific clear rule could quietly override is not one the user can
 * rely on.
 */
export interface ClearRuleSet {
  prefixes: string[];
  excludes: string[];
}

export const DEFAULT_CLEAR_RULES: ClearRuleSet = {
  prefixes: [...DEFAULT_CLEAR_PREFIXES],
  excludes: [],
};

/**
 * Accept a prefix in any form the user might type — "A512400", "512400", "5",
 * with stray spaces — and return the bare digits, or null when it is not a
 * usable prefix.
 */
export function normalizeClearPrefix(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const trimmed = String(raw).trim().replace(/^[Aa]/, "");
  return /^\d{1,6}$/.test(trimmed) ? trimmed : null;
}

/** Clean a whole rule set: normalize each, drop junk, dedupe, sort. */
export function normalizeClearPrefixes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CLEAR_PREFIXES];
  const seen = new Set<string>();
  for (const entry of raw) {
    const prefix = normalizeClearPrefix(entry);
    if (prefix) seen.add(prefix);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Clean an exception list. Unlike the clear rules, garbage lands on EMPTY, not
 * on a default: there is no sensible default exception, and inventing one
 * would silently stop something from being cleared.
 */
export function normalizeClearExcludes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return normalizeClearPrefixes(raw);
}

export function normalizeClearRules(raw: unknown): ClearRuleSet {
  const source = (raw ?? {}) as Partial<ClearRuleSet>;
  return {
    prefixes: normalizeClearPrefixes(source.prefixes),
    excludes: normalizeClearExcludes(source.excludes),
  };
}

/** The longest prefix in `prefixes` that `bareAccount` starts with, or null. */
function longestPrefixMatch(
  bareAccount: string,
  prefixes: readonly string[]
): string | null {
  let best: string | null = null;
  for (const prefix of prefixes) {
    if (!bareAccount.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best;
}

/**
 * Which rule covers this account, or null when none does. Returns the LONGEST
 * match so the UI can attribute a row to the most specific rule the user wrote
 * rather than to a broad one that happens to also cover it.
 *
 * Exceptions are NOT consulted here — this answers "does a clear rule reach
 * it?", which the scope table needs on its own. Use `resolveClearRules` (or a
 * compiled matcher) for the real verdict.
 *
 * @param bareAccount 6-digit account code, no "A" prefix.
 */
export function matchesClearRules(
  bareAccount: string,
  prefixes: readonly string[]
): string | null {
  return longestPrefixMatch(bareAccount, prefixes);
}

/** What the rule set says about one account. */
export interface ClearDecision {
  /** The clear rule that reaches the account, or null. */
  matchedBy: string | null;
  /** The exception that shields it, or null. Set whether or not a rule reaches it. */
  keptBy: string | null;
  /** The verdict: a rule reaches it and no exception shields it. */
  clears: boolean;
}

export function resolveClearRules(
  bareAccount: string,
  rules: ClearRuleSet
): ClearDecision {
  const matchedBy = longestPrefixMatch(bareAccount, rules.prefixes);
  const keptBy = longestPrefixMatch(bareAccount, rules.excludes);
  return { matchedBy, keptBy, clears: matchedBy !== null && keptBy === null };
}

/**
 * A rule set compiled for one pass over a workbook.
 *
 * A BST holds a few thousand addressable rows but only a hundred-odd distinct
 * accounts, so every verdict is memoised on the bare account code: the prefix
 * scans run once per account, and the zero pass — the hot loop of the whole
 * push — pays a Map lookup per row. Build one per plan and hand it to every
 * pass that needs a verdict, so the scope table and the writer can only ever
 * agree.
 */
export interface ClearMatcher {
  readonly rules: ClearRuleSet;
  resolve(bareAccount: string): ClearDecision;
  clears(bareAccount: string): boolean;
}

export function compileClearRules(rules: ClearRuleSet): ClearMatcher {
  const frozen: ClearRuleSet = {
    prefixes: [...rules.prefixes],
    excludes: [...rules.excludes],
  };
  // No rules at all — the verdict is the same for every account.
  const inert = frozen.prefixes.length === 0;
  const memo = new Map<string, ClearDecision>();
  const resolve = (bareAccount: string): ClearDecision => {
    if (inert) return { matchedBy: null, keptBy: null, clears: false };
    let decision = memo.get(bareAccount);
    if (decision === undefined) {
      decision = resolveClearRules(bareAccount, frozen);
      memo.set(bareAccount, decision);
    }
    return decision;
  };
  return {
    rules: frozen,
    resolve,
    clears: (bareAccount) => resolve(bareAccount).clears,
  };
}

export function isClearMatcher(value: unknown): value is ClearMatcher {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ClearMatcher).resolve === "function" &&
    typeof (value as ClearMatcher).clears === "function"
  );
}

// ── Recently used files ────────────────────────────────────────────────────

/**
 * The BST this hotel was last pushed into, so the routine monthly push is one
 * click rather than a walk through the file dialog.
 *
 * The mechanics are shared with the BST Pull (see shared/files/recentFiles) —
 * only the matching rule differs: a push is guarded on the workbook's own
 * budget YEAR as well as its OU, so `findRecentFile` is always called with the
 * selected year here and a file that would be refused is never offered.
 */
export type RecentBstFile = RecentFile;

export {
  MAX_RECENT_FILES as MAX_RECENT_BST_FILES,
  baseName,
  findRecentFile,
  forgetRecentFile,
  normalizeRecentFiles,
  parentPath,
  recentFilesForOu,
  rememberRecentFile,
};

/** The persisted, install-wide push configuration. */
export interface BstPushConfig {
  /** Account prefixes the clear pass zeroes. */
  clearPrefixes: string[];
  /** Account prefixes the clear pass must leave alone, whatever `clearPrefixes` say. */
  clearExcludes: string[];
  /** BSTs this install has pushed into before, newest first. */
  recentFiles: RecentBstFile[];
  /** The month plan the user last used — the same selection tends to repeat. */
  months: MonthAction[];
  allocationRows: GuardMode;
  protectedCells: GuardMode;
  backup: boolean;
  skipUnusedCombos: boolean;
}

export const DEFAULT_BST_PUSH_CONFIG: BstPushConfig = {
  clearPrefixes: [...DEFAULT_CLEAR_PREFIXES],
  clearExcludes: [],
  recentFiles: [],
  months: [...DEFAULT_MONTH_PLAN],
  allocationRows: "skip",
  protectedCells: "skip",
  backup: true,
  skipUnusedCombos: false,
};

export function normalizeBstPushConfig(raw: unknown): BstPushConfig {
  const source = (raw ?? {}) as Partial<BstPushConfig>;
  return {
    clearPrefixes: normalizeClearPrefixes(source.clearPrefixes),
    clearExcludes: normalizeClearExcludes(source.clearExcludes),
    recentFiles: normalizeRecentFiles(source.recentFiles),
    months: normalizeMonthPlan(source.months),
    allocationRows: normalizeGuardMode(source.allocationRows),
    protectedCells: normalizeGuardMode(source.protectedCells),
    backup:
      typeof source.backup === "boolean"
        ? source.backup
        : DEFAULT_BST_PUSH_CONFIG.backup,
    skipUnusedCombos:
      typeof source.skipUnusedCombos === "boolean"
        ? source.skipUnusedCombos
        : DEFAULT_BST_PUSH_CONFIG.skipUnusedCombos,
  };
}

/**
 * What will happen (preview) or did happen (report) to one dept×account combo.
 *
 * `no_sheet` / `no_row` are reported, never repaired: the old macro auto-created
 * missing rows by calling the BST's own `AddNewRow` macro, which an OOXML writer
 * cannot invoke, and the workbook's structure is password-protected anyway. The
 * report names the department and account so the user can add them in the BST
 * and push again.
 *
 * `no_data` is the quiet cousin of those two: the combo is missing from the BST
 * *and* Kairos holds only zeroes for it, so adding the row would change nothing.
 * It is informational, not a problem — it never counts toward `problemCount`.
 *
 * `skipped` is `no_data`'s counterpart for a combo that IS in the BST: Kairos
 * holds only zeroes and the user switched `skipUnusedCombos` on, so no values
 * are written to the row. The clear rules operate independently — a skipped
 * row they match is still zeroed in replaced/cleared months.
 *
 * `guarded` is a row Kairos had values for, every one of which a `skip` guard
 * suppressed (see GuardMode) — the BST row is left exactly as it is.
 * `zeroed` is its `clear`-mode counterpart: no values written, but the row's
 * guard-cleared cells receive zeroes.
 */
export type ComboStatus =
  | "write"
  | "no_sheet"
  | "no_row"
  | "no_data"
  | "skipped"
  | "duplicate_row"
  | "guarded"
  | "zeroed";

/** One planned (or completed) combo write. */
export interface PushComboRow {
  /** Stable grid id — the combo. */
  id: string;
  /** `dddd-dddddd` as the BST spells it (no D/A prefixes). */
  combo: string;
  /** Kairos form, "D0410". */
  dept: string;
  /** Kairos form, "A988112". */
  account: string;
  /** Bare 4-digit code = the BST sheet name. */
  sheet: string;
  departmentName: string;
  accountName: string;
  status: ComboStatus;
  /** True for A9… accounts: written in raw units, not thousands. */
  isStats: boolean;
  /** True when the BST row's column C marks it as an allocation row. */
  isAllocation: boolean;
  /** Column C's text, for the allocation chip's tooltip. */
  allocationText: string | null;
  /** Jan..Dec: the BST cell is locked under sheet protection. */
  lockedMonths: boolean[];
  /** Jan..Dec: the push would have touched this cell but a guard stopped it. */
  guardedMonths: boolean[];
  /** The 12 values exactly as they will land in the file (already scaled). */
  months: number[];
  /** Sum of `months`. */
  total: number;
  /** 1-based row in the target sheet, when matched. */
  targetRow: number | null;
}

/** Identity the target workbook declares about itself. */
export interface BstFileMeta {
  filePath: string;
  sourceFileName: string;
  /** Setup Fields D5, canonicalized to "OU"+5. */
  ou: string;
  /** Setup Fields B1 (defined name Budgeted_year). */
  year: number | null;
  hotelName: string | null;
  currency: string | null;
  /** Setup Fields I46 — must be BUDGET for column I to be the write target. */
  budgetBucketType: string | null;
  /** Number of 4-digit department sheets found. */
  departmentSheetCount: number;
}

/**
 * One column of the push, as the month strip renders it. Present on both the
 * plan and the report, so "what will happen" and "what happened" are the same
 * shape and the same component draws both.
 */
export interface MonthPlanEntry {
  /** 1-based. */
  month: number;
  action: MonthAction;
  /** Kairos total for this month across writable rows, already scaled. */
  writeTotal: number;
  /** Cells this month receives a value in. */
  writeCells: number;
  /** Cells this month is zeroed in. */
  clearCells: number;
}

/**
 * One account the clear pass is or is not responsible for.
 *
 * The union of two questions the user needs answered together: what will the
 * rules wipe, and what will they leave behind that Kairos writes.
 */
export interface ClearScopeAccount {
  /** Kairos form, "A512400". */
  account: string;
  name: string;
  /** Rows this account occupies across the target's department sheets. */
  bstRows: number;
  /** True when Kairos produces a row for it — a zero row included. */
  written: boolean;
  /**
   * True when at least one of those rows holds a non-zero value. Matters for a
   * kept account: an exception stops the clearing, not the value pass, so a
   * written account is still overwritten in every Replace/Add month — with
   * zeroes, when this is false, unless `skipUnusedCombos` is on.
   */
  hasData: boolean;
  /**
   * The clear rule reaching it, or null when none does. Reaching is not
   * clearing: the account is zeroed only when `keptBy` is also null.
   */
  matchedBy: string | null;
  /** The exception shielding it from the rules, or null. */
  keptBy: string | null;
}

/** What the configured clear rules mean for THIS target workbook. */
export interface ClearScope {
  prefixes: string[];
  excludes: string[];
  /**
   * Reached-by-a-rule ∪ shielded-by-an-exception ∪ written-by-Kairos, sorted
   * by account code.
   */
  accounts: ClearScopeAccount[];
  /**
   * Prefix → BST rows it actually clears, NET of the exceptions, for the rule
   * chips. Sums to `cellsPerClearedMonth`.
   */
  ruleMatches: Record<string, number>;
  /**
   * Exception → BST rows it shields — rows a rule reached and this exception
   * kept. An exception no rule reaches shows 0, which is the cue that it is
   * either a typo or redundant.
   */
  excludeMatches: Record<string, number>;
  /** Rows the rules clear — one cell each, per cleared month. */
  cellsPerClearedMonth: number;
  /** Rows a rule reached but an exception kept — per cleared month. */
  rowsKept: number;
  /**
   * Kairos writes it, no rule covers it. Worth calling out: an overwrite lands
   * fine, but a value left by an EARLIER push into a row Kairos no longer
   * produces can never be cleaned up.
   */
  uncoveredWritten: string[];
  /** The rules clear it, Kairos never writes it — so it is left at zero. */
  clearedNotWritten: string[];
}

/** The full preview: what a commit with these options would do. */
export interface BstPushPlan {
  file: BstFileMeta;
  options: BstPushOptions;
  rows: PushComboRow[];
  /** Per-column summary, Jan..Dec. */
  monthPlan: MonthPlanEntry[];
  /** What the clear rules cover in this file. */
  clearScope: ClearScope;
  /** Distinct departments with at least one writable row. */
  departmentCount: number;
  /** Rows that will be written. */
  writeCount: number;
  /** Rows that cannot be written (no_sheet + no_row). */
  problemCount: number;
  /** BST rows left untouched because `skipUnusedCombos` is on. */
  skippedCount: number;
  /** Individual month cells that will be written. */
  cellCount: number;
  /** Cells the clear pass will zero, summed over the cleared months. */
  zeroCellCount: number;
  /** Plan rows sitting on a BST allocation row. */
  allocationRowCount: number;
  /** Plan rows with at least one protection-locked month cell. */
  protectedRowCount: number;
  /** Rows with status `guarded` — held data, fully suppressed by skip guards. */
  guardedRowCount: number;
  /** Individual month cells a skip guard kept the push away from. */
  guardedCellCount: number;
  warnings: string[];
}

/** What a commit actually did. */
export interface BstPushReport {
  file: BstFileMeta;
  options: BstPushOptions;
  rows: PushComboRow[];
  monthPlan: MonthPlanEntry[];
  clearScope: ClearScope;
  writeCount: number;
  problemCount: number;
  skippedCount: number;
  cellCount: number;
  zeroCellCount: number;
  allocationRowCount: number;
  protectedRowCount: number;
  guardedRowCount: number;
  guardedCellCount: number;
  /** Department sheets the writer actually changed. */
  sheetsTouched: number;
  /** Absolute path of the backup copy, when one was made. */
  backupPath: string | null;
  warnings: string[];
}

/**
 * Why a push could not proceed. These are expected user situations, returned
 * inside a successful envelope — exceptions stay reserved for real failures.
 */
export type BstPushRefusal =
  | { outcome: "cancelled" }
  | { outcome: "not_bst_file"; sourceFileName: string; reason: string }
  | {
      outcome: "ou_mismatch";
      fileOu: string;
      selectedOu: string;
      sourceFileName: string;
    }
  | {
      outcome: "year_mismatch";
      fileYear: number | null;
      selectedYear: number;
      sourceFileName: string;
    }
  | { outcome: "file_locked"; sourceFileName: string }
  | { outcome: "file_missing"; sourceFileName: string; filePath: string }
  | { outcome: "no_outputs" }
  | { outcome: "no_months" }
  | { outcome: "unsupported_layout"; sourceFileName: string; reason: string };

export type BstPushPreviewResult =
  | BstPushRefusal
  | { outcome: "ready"; plan: BstPushPlan };

export type BstPushCommitResult =
  | BstPushRefusal
  | { outcome: "ok"; report: BstPushReport };

/** True when the outcome is a refusal rather than a usable result. */
export function isPushRefusal(
  result: BstPushPreviewResult | BstPushCommitResult
): result is BstPushRefusal {
  return result.outcome !== "ready" && result.outcome !== "ok";
}

export const BST_PUSH_CHANNELS = {
  /** Pick a file, recalculate, build the plan. Writes nothing. */
  preview: "bstPush:preview",
  /** Re-read the previewed path, rebuild the plan, apply it. */
  commit: "bstPush:commit",
  /** Read the persisted clear rules (and exceptions) and last-used month plan. */
  config: "bstPush:config",
  /** Persist a changed rule set / exception list / month plan. */
  setConfig: "bstPush:setConfig",
  /** Show a written file (or its backup) in the OS file manager. */
  reveal: "bstPush:reveal",
} as const;
