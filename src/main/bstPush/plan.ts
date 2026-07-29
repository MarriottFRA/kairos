/**
 * Turn the Results page's rows into a concrete list of BST cell writes.
 *
 * Pure: outputs + a read target + options in, a plan out. The same function
 * backs both `preview` and `commit`, so what the user approved and what gets
 * written can never disagree.
 *
 * The unit and prefix rules are the exact inverse of the pull
 * (main/budgetImport/parseWorkbook.ts):
 *   - Kairos stores "D0410" / "A988112"; the BST holds the bare combo
 *     `0410-988112` and names its sheet `0410`.
 *   - A9… accounts (stats: 988xxx hours, 972540 headcount) are in actual units
 *     on both sides. Everything else is stored in the BST in THOUSANDS, so it
 *     is divided by 1000 on the way out. No rounding — the macro did not round
 *     either, and the BST's number formats handle display.
 */

import {
  BstPushOptions,
  BstPushPlan,
  BUDGET_COL_START,
  ClearScope,
  ClearScopeAccount,
  clearsColumn,
  ComboStatus,
  matchesClearRules,
  MonthAction,
  MonthPlanEntry,
  PUSH_MONTHS,
  PushComboRow,
  writesValues,
} from "../../shared/bstPush/ipc";
import { formatMonthRanges } from "../../shared/calendar";
import {
  bareAccount,
  bareDept,
  comboKeyOf,
} from "../../shared/positions/comboKey";
import type { OutputAggRowDto } from "../../shared/positions/ipc";
import type { BstTarget, ComboLocation } from "./readTarget";

/** Kairos "D0410" → the BST sheet name "0410". */
export const toSheetName = bareDept;

/** Kairos "A988112" → the BST account "988112". */
export const toBareAccount = bareAccount;

/** Kairos codes → the BST's `dddd-dddddd` combo. */
export const toCombo = comboKeyOf;

/** A9… accounts are counts and hours; everything else is money in thousands. */
export function scaleForAccount(account: string): number {
  return account.startsWith("9") ? 1 : 1000;
}

export interface BuildPlanInput {
  target: BstTarget;
  filePath: string;
  /** The Results page's rows, straight from readOutputs(). */
  outputs: OutputAggRowDto[];
  options: BstPushOptions;
  /**
   * Account prefixes the clear pass zeroes — the user's saved rule set, read
   * from settings by the handler. Passed in rather than read here so this stays
   * pure and the preview and the commit provably use the same list.
   */
  clearPrefixes: string[];
  /** Kairos department code ("D0410") → display name. */
  departmentNameByCode: Map<string, string>;
  /** Kairos account code ("A988112") → display name. */
  accountNameByCode: Map<string, string>;
  /** Lines the engine computed but could not post, by block label. */
  unpostedByLabel?: Record<string, number>;
}

/**
 * Values for the columns this push writes; every other month reads 0.
 *
 * `wroteMask` says which months actually carry a value, which is not the same
 * as "months[m] !== 0" — a genuine zero is still a write, and the month strip
 * counts cells, not non-zeroes.
 */
function scaleMonths(
  months: number[],
  account: string,
  actions: MonthAction[]
): { months: number[]; wroteMask: boolean[]; skippedNonFinite: boolean } {
  const scale = scaleForAccount(account);
  const out = new Array<number>(PUSH_MONTHS).fill(0);
  const wroteMask = new Array<boolean>(PUSH_MONTHS).fill(false);
  let skippedNonFinite = false;

  for (let m = 0; m < PUSH_MONTHS; m++) {
    if (!writesValues(actions[m])) continue;
    const raw = Number(months[m]);
    if (!Number.isFinite(raw)) {
      skippedNonFinite = true;
      continue;
    }
    out[m] = raw / scale;
    wroteMask[m] = true;
  }
  return { months: out, wroteMask, skippedNonFinite };
}

/**
 * What the configured rules mean for this workbook.
 *
 * Walks every addressable row of the target once, tallying rows per account,
 * then crosses that with the accounts Kairos produces. The two questions the
 * user has to answer — "what am I about to wipe?" and "what will these rules
 * never clean up?" — are the two halves of the same table, so they are built
 * together and shown together.
 */
export function buildClearScope(
  target: BstTarget,
  outputs: OutputAggRowDto[],
  prefixes: string[],
  accountNameByCode: Map<string, string>
): ClearScope {
  const bstRowsByAccount = new Map<string, number>();
  const descriptionByAccount = new Map<string, string>();

  for (const locations of target.bySheet.values()) {
    for (const location of locations) {
      const bare = location.combo.slice(5);
      bstRowsByAccount.set(bare, (bstRowsByAccount.get(bare) ?? 0) + 1);
      if (location.description && !descriptionByAccount.has(bare)) {
        descriptionByAccount.set(bare, location.description);
      }
    }
  }

  const writtenAccounts = new Set(
    outputs.map((row) => toBareAccount(row.account))
  );

  // Every rule gets an entry even when it matches nothing — "0 rows" is the
  // feedback that tells the user their prefix was a typo.
  const ruleMatches: Record<string, number> = {};
  for (const prefix of prefixes) ruleMatches[prefix] = 0;

  const candidates = new Set<string>([
    ...bstRowsByAccount.keys(),
    ...writtenAccounts,
  ]);

  const accounts: ClearScopeAccount[] = [];
  const uncoveredWritten: string[] = [];
  const clearedNotWritten: string[] = [];
  let cellsPerClearedMonth = 0;

  for (const bare of [...candidates].sort()) {
    const matchedBy = matchesClearRules(bare, prefixes);
    const bstRows = bstRowsByAccount.get(bare) ?? 0;
    const written = writtenAccounts.has(bare);

    if (matchedBy) {
      ruleMatches[matchedBy] += bstRows;
      cellsPerClearedMonth += bstRows;
    }
    // An account nobody clears and nobody writes is just chart-of-accounts
    // noise — the table is about the rules, not the workbook.
    if (!matchedBy && !written) continue;

    const code = `A${bare}`;
    accounts.push({
      account: code,
      name: accountNameByCode.get(code) ?? descriptionByAccount.get(bare) ?? "",
      bstRows,
      written,
      matchedBy,
    });

    if (written && !matchedBy) uncoveredWritten.push(code);
    if (matchedBy && !written) clearedNotWritten.push(code);
  }

  return {
    prefixes: [...prefixes],
    accounts,
    ruleMatches,
    cellsPerClearedMonth,
    uncoveredWritten,
    clearedNotWritten,
  };
}

/**
 * One row per combo, whatever the caller handed us.
 *
 * readOutputs already merges on the canonical combo, so in practice nothing is
 * folded here. It stays because the alternative failure is silent and lands in
 * a real workbook: two rows resolving to one BST row means one write lands on
 * top of the other (or double-counts under "add"), and the number the user
 * approved on the Results page is not the number the workbook ends up holding.
 * Merging is the only outcome that keeps the page and the file agreeing.
 */
function mergeByCombo(outputs: OutputAggRowDto[]): {
  rows: OutputAggRowDto[];
  collisions: string[];
} {
  const byCombo = new Map<string, OutputAggRowDto>();
  const collisions: string[] = [];

  for (const row of outputs) {
    const combo = toCombo(row.dept, row.account);
    const existing = byCombo.get(combo);
    if (!existing) {
      byCombo.set(combo, { ...row, months: [...row.months] });
      continue;
    }
    collisions.push(combo);
    for (let m = 0; m < existing.months.length; m++) {
      existing.months[m] += Number(row.months[m]) || 0;
    }
    existing.total += row.total;
    existing.sources = [...new Set([...existing.sources, ...row.sources])];
  }

  return { rows: [...byCombo.values()], collisions: [...new Set(collisions)] };
}

export function buildPushPlan(input: BuildPlanInput): BstPushPlan {
  const {
    target,
    filePath,
    options,
    clearPrefixes,
    departmentNameByCode,
    accountNameByCode,
  } = input;

  const { rows: outputs, collisions } = mergeByCombo(input.outputs);

  const warnings: string[] = [];
  const rows: PushComboRow[] = [];
  const departments = new Set<string>();
  const missingSheets = new Set<string>();
  const duplicates: string[] = [];

  let writeCount = 0;
  let problemCount = 0;
  let cellCount = 0;

  const writeCellsByMonth = new Array<number>(PUSH_MONTHS).fill(0);
  const writeTotalByMonth = new Array<number>(PUSH_MONTHS).fill(0);
  let nonFiniteRows = 0;

  for (const row of outputs) {
    const sheet = toSheetName(row.dept);
    const bareAccount = toBareAccount(row.account);
    const combo = `${sheet}-${bareAccount}`;

    const location: ComboLocation | undefined = target.combos.get(combo);
    const sheetExists = target.bySheet.has(sheet);

    let status: ComboStatus;
    if (location) status = location.duplicate ? "duplicate_row" : "write";
    else if (sheetExists) status = "no_row";
    else status = "no_sheet";

    const scaled = scaleMonths(row.months, bareAccount, options.months);
    if (scaled.skippedNonFinite) nonFiniteRows++;

    const writable = status === "write" || status === "duplicate_row";
    if (writable) {
      writeCount++;
      departments.add(sheet);
      if (status === "duplicate_row") duplicates.push(combo);
      for (let m = 0; m < PUSH_MONTHS; m++) {
        if (!scaled.wroteMask[m]) continue;
        cellCount++;
        writeCellsByMonth[m]++;
        writeTotalByMonth[m] += scaled.months[m];
      }
    } else {
      problemCount++;
      if (status === "no_sheet") missingSheets.add(sheet);
    }

    rows.push({
      id: combo,
      combo,
      dept: row.dept,
      account: row.account,
      sheet,
      departmentName: departmentNameByCode.get(row.dept) ?? "",
      accountName:
        accountNameByCode.get(row.account) ?? location?.description ?? "",
      status,
      isStats: row.isStats,
      months: scaled.months,
      total: scaled.months.reduce((sum, value) => sum + value, 0),
      targetRow: location?.row ?? null,
    });
  }

  // Rows sort the way the Results page groups them: department, then account.
  rows.sort(
    (a, b) => a.dept.localeCompare(b.dept) || a.account.localeCompare(b.account)
  );

  const clearScope = buildClearScope(
    target,
    outputs,
    clearPrefixes,
    accountNameByCode
  );

  // Tallied from the writer's own list rather than recomputed, so the number on
  // every month tile is by construction the number of cells that will change.
  const zeroWrites = toZeroWrites(target, options, clearPrefixes);
  const clearCellsByMonth = new Array<number>(PUSH_MONTHS).fill(0);
  for (const write of zeroWrites) {
    clearCellsByMonth[write.col - BUDGET_COL_START]++;
  }

  const monthPlan: MonthPlanEntry[] = Array.from(
    { length: PUSH_MONTHS },
    (_unused, m) => ({
      month: m + 1,
      action: options.months[m],
      writeTotal: writeTotalByMonth[m],
      writeCells: writeCellsByMonth[m],
      clearCells: clearCellsByMonth[m],
    })
  );

  const monthsWhere = (test: (action: MonthAction) => boolean): number[] =>
    options.months
      .map((action, index) => (test(action) ? index : -1))
      .filter((index) => index >= 0);

  // ── Warnings: everything the user should know before approving ──
  if (missingSheets.size > 0) {
    const list = [...missingSheets].sort();
    warnings.push(
      `${list.length} department(s) have no sheet in this BST ` +
        `(${list.slice(0, 8).join(", ")}${list.length > 8 ? ", …" : ""}). ` +
        `Add them in the BST's "Dept Settings" sheet and push again — this ` +
        `tool cannot create them, the workbook's structure is protected.`
    );
  }
  if (duplicates.length > 0) {
    warnings.push(
      `${duplicates.length} combo(s) appear on more than one row of their ` +
        `sheet (${duplicates.slice(0, 5).join(", ")}${duplicates.length > 5 ? ", …" : ""}). ` +
        `The first row wins, matching the old macro.`
    );
  }
  if (collisions.length > 0) {
    warnings.push(
      `${collisions.length} combo(s) arrived as more than one Results row ` +
        `(${collisions.slice(0, 5).join(", ")}${collisions.length > 5 ? ", …" : ""}) ` +
        `and were added together, so nothing is lost — but the Results page ` +
        `should be showing them as one row. Please report this.`
    );
  }
  if (nonFiniteRows > 0) {
    warnings.push(
      `${nonFiniteRows} row(s) contained a value that is not a finite number. ` +
        `Those months were skipped rather than written.`
    );
  }
  const skipped = monthsWhere((action) => action === "skip");
  if (skipped.length > 0) {
    warnings.push(
      `${formatMonthRanges(skipped)} ${skipped.length === 1 ? "is" : "are"} ` +
        `not being touched at all — those columns keep whatever the BST ` +
        `already holds.`
    );
  }

  const added = monthsWhere((action) => action === "add");
  if (added.length > 0) {
    warnings.push(
      `${formatMonthRanges(added)} ${added.length === 1 ? "is" : "are"} set to ` +
        `"add", so values pile onto what the BST already holds. Pushing those ` +
        `months twice double-counts them.`
    );
  }

  const clearedOnly = monthsWhere((action) => action === "clear");
  if (clearedOnly.length > 0) {
    warnings.push(
      `${formatMonthRanges(clearedOnly)} will be zeroed and nothing written ` +
        `back, leaving ${clearedOnly.length === 1 ? "that column" : "those columns"} empty.`
    );
  }

  if (clearScope.uncoveredWritten.length > 0) {
    const list = clearScope.uncoveredWritten;
    warnings.push(
      `Kairos writes ${list.length} account(s) no clear rule covers ` +
        `(${list.slice(0, 6).join(", ")}${list.length > 6 ? ", …" : ""}). ` +
        `Overwriting them is fine, but a value an earlier push left in a row ` +
        `Kairos no longer produces will never be cleaned up. Add them to the ` +
        `clear rules if they belong to this tool.`
    );
  }

  if (clearScope.clearedNotWritten.length > 0) {
    const list = clearScope.clearedNotWritten;
    warnings.push(
      `${list.length} account(s) match the clear rules but Kairos writes ` +
        `nothing back to them (${list.slice(0, 6).join(", ")}` +
        `${list.length > 6 ? ", …" : ""}), so they are left at zero in every ` +
        `cleared month.`
    );
  }
  if (target.budgetBucketType && target.budgetBucketType !== "BUDGET") {
    warnings.push(
      `The file labels its first column block "${target.budgetBucketType}" ` +
        `rather than "BUDGET".`
    );
  }
  const unposted = Object.entries(input.unpostedByLabel ?? {}).filter(
    ([, count]) => count > 0
  );
  if (unposted.length > 0) {
    warnings.push(
      `${unposted.length} block(s) compute but post nowhere, so they are not in ` +
        `this push: ${unposted.map(([label]) => label).slice(0, 5).join(", ")}` +
        `${unposted.length > 5 ? ", …" : ""}. Give them an account on the Blocks ` +
        `page if they should reach the BST.`
    );
  }

  return {
    file: {
      filePath,
      sourceFileName: target.sourceFileName,
      ou: target.ou,
      year: target.year,
      hotelName: target.hotelName,
      currency: target.currency,
      budgetBucketType: target.budgetBucketType,
      departmentSheetCount: target.departmentSheets.length,
    },
    options,
    rows,
    monthPlan,
    clearScope,
    departmentCount: departments.size,
    writeCount,
    problemCount,
    cellCount,
    zeroCellCount: zeroWrites.length,
    warnings,
  };
}

/** How many cells the clear pass would zero. Counts the real write list so the
 *  preview's number can never drift from what the writer does. */
export function countZeroableCells(
  target: BstTarget,
  options: BstPushOptions,
  prefixes: string[]
): number {
  return toZeroWrites(target, options, prefixes).length;
}

/** One cell the writer must change: sheet, row, 0-based column, value. */
export interface CellWrite {
  sheet: string;
  row: number;
  col: number;
  value: number;
  /** Add to the cell's current cached value instead of replacing it. */
  add?: boolean;
}

/**
 * The cell writes for the clear pass: every row the rules match, in every
 * column the user marked `replace` or `clear`.
 *
 * Column-scoped on purpose. Clearing used to be all twelve months whatever else
 * the push did, on the reasoning that a partial clear leaves the BST showing a
 * mix of two budgets. That is still true — but it is now the user's explicit
 * choice, made per column against a strip that shows exactly which columns are
 * being cleared and which are being left alone, which is the whole point of
 * protecting a year's actuals.
 */
export function toZeroWrites(
  target: BstTarget,
  options: BstPushOptions,
  prefixes: string[]
): CellWrite[] {
  const columns: number[] = [];
  for (let m = 0; m < PUSH_MONTHS; m++) {
    if (clearsColumn(options.months[m])) columns.push(BUDGET_COL_START + m);
  }
  if (columns.length === 0 || prefixes.length === 0) return [];

  const writes: CellWrite[] = [];
  for (const locations of target.bySheet.values()) {
    for (const location of locations) {
      if (!matchesClearRules(location.combo.slice(5), prefixes)) continue;
      for (const col of columns) {
        writes.push({
          sheet: location.sheet,
          row: location.row,
          col,
          value: 0,
        });
      }
    }
  }
  return writes;
}

/**
 * Flatten a plan into the cell writes the OOXML writer applies — clear pass
 * first, so a value write lands on top of it.
 *
 * Reads its rules from `plan.clearScope.prefixes` rather than taking them as an
 * argument: the plan is what the user approved, so the writes can only ever be
 * the writes that plan described.
 *
 * Note every action indexes months identically. The macro's additive branch
 * read from January while writing at `I + MonthOffset` (OLD VBA
 * Engine.txt:1485), silently shifting a partial-year push by the offset; that
 * bug is not ported.
 */
export function toCellWrites(plan: BstPushPlan, target: BstTarget): CellWrite[] {
  const writes: CellWrite[] = toZeroWrites(
    target,
    plan.options,
    plan.clearScope.prefixes
  );

  for (const row of plan.rows) {
    if (row.targetRow == null) continue;
    for (let m = 0; m < PUSH_MONTHS; m++) {
      const action = plan.options.months[m];
      if (!writesValues(action)) continue;
      writes.push({
        sheet: row.sheet,
        row: row.targetRow,
        col: BUDGET_COL_START + m,
        value: row.months[m],
        // `replace` already cleared this cell, so adding to it would be the
        // same thing — but keep it honest and let the writer decide.
        add: action === "add",
      });
    }
  }

  return writes;
}
