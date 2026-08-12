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

/** Options the user sets before pushing. */
export interface BstPushOptions {
  /** Jan..Dec, one action each. Always exactly PUSH_MONTHS long. */
  months: MonthAction[];
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
    backup?: unknown;
    skipUnusedCombos?: unknown;
  };
  return {
    months: normalizeMonthPlan(
      source.months !== undefined ? source.months : source
    ),
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
 * Which rule covers this account, or null when none does. Returns the LONGEST
 * match so the UI can attribute a row to the most specific rule the user wrote
 * rather than to a broad one that happens to also cover it.
 *
 * @param bareAccount 6-digit account code, no "A" prefix.
 */
export function matchesClearRules(
  bareAccount: string,
  prefixes: string[]
): string | null {
  let best: string | null = null;
  for (const prefix of prefixes) {
    if (!bareAccount.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best;
}

/** The persisted, install-wide push configuration. */
export interface BstPushConfig {
  /** Account prefixes the clear pass zeroes. */
  clearPrefixes: string[];
  /** The month plan the user last used — the same selection tends to repeat. */
  months: MonthAction[];
  backup: boolean;
  skipUnusedCombos: boolean;
}

export const DEFAULT_BST_PUSH_CONFIG: BstPushConfig = {
  clearPrefixes: [...DEFAULT_CLEAR_PREFIXES],
  months: [...DEFAULT_MONTH_PLAN],
  backup: true,
  skipUnusedCombos: false,
};

export function normalizeBstPushConfig(raw: unknown): BstPushConfig {
  const source = (raw ?? {}) as Partial<BstPushConfig>;
  return {
    clearPrefixes: normalizeClearPrefixes(source.clearPrefixes),
    months: normalizeMonthPlan(source.months),
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
 */
export type ComboStatus =
  | "write"
  | "no_sheet"
  | "no_row"
  | "no_data"
  | "skipped"
  | "duplicate_row"
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
  /** True when Kairos produces a value for it. */
  written: boolean;
  /** The rule prefix covering it, or null when no rule does. */
  matchedBy: string | null;
}

/** What the configured clear rules mean for THIS target workbook. */
export interface ClearScope {
  prefixes: string[];
  /** Rule-matched-in-the-BST ∪ written-by-Kairos, sorted by account code. */
  accounts: ClearScopeAccount[];
  /** Prefix → BST rows it matches, for the rule chips. */
  ruleMatches: Record<string, number>;
  /** Rows the rules match — one cell each, per cleared month. */
  cellsPerClearedMonth: number;
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
  /** Read the persisted clear rules and last-used month plan. */
  config: "bstPush:config",
  /** Persist a changed rule set / month plan. */
  setConfig: "bstPush:setConfig",
  /** Show a written file (or its backup) in the OS file manager. */
  reveal: "bstPush:reveal",
} as const;
