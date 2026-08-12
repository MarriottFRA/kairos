/**
 * readTarget + plan tests.
 *
 * A tiny synthetic BST: a "Setup Fields" identity sheet, two 4-digit department
 * sheets, a division-summary sheet that must never be written to, and a hidden
 * template. Everything the push decides — which sheet, which row, which scale —
 * is checked against it.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

import {
  NotBstFileError,
  UnsupportedLayoutError,
  isDepartmentSheet,
  readTarget,
} from "../readTarget";
import {
  buildClearScope,
  buildPushPlan,
  countZeroableCells,
  scaleForAccount,
  toBareAccount,
  toCellWrites,
  toCombo,
  toSheetName,
  toZeroWrites,
} from "../plan";
import {
  BUDGET_COL_START,
  DEFAULT_BST_PUSH_OPTIONS,
  DEFAULT_CLEAR_PREFIXES,
  matchesClearRules,
  normalizeBstPushOptions,
  normalizeClearPrefix,
  normalizeClearPrefixes,
} from "../../../shared/bstPush/ipc";
import type { BstPushOptions, MonthAction } from "../../../shared/bstPush/ipc";
import type { OutputAggRowDto } from "../../../shared/positions/ipc";

// ── Fixture ─────────────────────────────────────────────────────────

function setupSheet(): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = { "!ref": "A1:AT50" };
  const put = (addr: string, v: string | number) => {
    (ws as any)[addr] = typeof v === "number" ? { t: "n", v } : { t: "s", v };
  };
  put("B1", 2027); // Budgeted_year
  put("B3", "Bvlgari Hotel Roma");
  put("B5", "XMAZB"); // PeopleSoft code — deliberately NOT the OU
  put("B7", "EUR");
  put("D5", "75AZB"); // the OU
  put("I46", "BUDGET");
  return ws;
}

/** A department sheet: E2 echoes the code, column B carries the combos. */
function deptSheet(code: string, rows: { row: number; combo: string; desc: string }[]) {
  const ws: XLSX.WorkSheet = { "!ref": `A1:T${Math.max(...rows.map((r) => r.row)) + 2}` };
  (ws as any).E2 = { t: "s", v: code };
  for (const entry of rows) {
    (ws as any)[`A${entry.row}`] = { t: "s", v: entry.desc };
    (ws as any)[`B${entry.row}`] = { t: "s", v: entry.combo };
  }
  return ws;
}

function buildWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, setupSheet(), "Setup Fields");

  XLSX.utils.book_append_sheet(
    wb,
    deptSheet("0010", [
      { row: 21, combo: "0010-510000", desc: "Wage Dept 00" },
      { row: 33, combo: "0010-560320", desc: "Retirement Contribution" },
      { row: 226, combo: "0010-988000", desc: "Hours Worked" },
      { row: 250, combo: "0010-972540", desc: "Associate Count" },
      { row: 13, combo: "0010-414001", desc: "Food Cost" },
      // The same combo twice — first row must win.
      { row: 300, combo: "0010-510000", desc: "Wage Dept 00 (again)" },
    ]),
    "0010"
  );
  XLSX.utils.book_append_sheet(
    wb,
    deptSheet("0410", [{ row: 269, combo: "0410-988112", desc: "Standard work week hours" }]),
    "0410"
  );

  // A division summary: 4-digit-looking content but no E2 code, and a combo in
  // column B. Must never be treated as a department sheet.
  const summary: XLSX.WorkSheet = { "!ref": "A1:T20" };
  (summary as any).B7 = { t: "s", v: "0010-510000" };
  XLSX.utils.book_append_sheet(wb, summary, "Rooms");

  // A 4-digit sheet whose E2 disagrees — a trap the reader must refuse.
  XLSX.utils.book_append_sheet(
    wb,
    deptSheet("9999", [{ row: 5, combo: "0011-510000", desc: "wrong sheet" }]),
    "0011"
  );

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const target = readTarget(buildWorkbook(), "test.xlsx");

function outRow(
  dept: string,
  account: string,
  monthly: number,
  isStats = false
): OutputAggRowDto {
  const months = new Array(12).fill(monthly);
  return {
    dept,
    account,
    isStats,
    months,
    total: months.reduce((a, b) => a + b, 0),
    // The push reads dept/account/months/isStats only; these ride along so the
    // factory still satisfies the DTO the Results page now returns.
    accountName: "",
    departmentName: "",
    sources: ["ENGINE"],
    blockLabels: [],
    valueKind: isStats ? "count" : "currency",
  };
}

const NAMES = new Map<string, string>();
const RULES = [...DEFAULT_CLEAR_PREFIXES];

/** Every month doing the same thing. */
const every = (action: MonthAction): BstPushOptions => ({
  months: Array.from({ length: 12 }, () => action),
  backup: true,
  skipUnusedCombos: false,
});

/** `skip` everywhere except the 1-based months listed. */
const only = (action: MonthAction, ...months: number[]): BstPushOptions => ({
  months: Array.from({ length: 12 }, (_unused, index) =>
    months.includes(index + 1) ? action : "skip"
  ),
  backup: true,
  skipUnusedCombos: false,
});

function plan(
  outputs: OutputAggRowDto[],
  options = DEFAULT_BST_PUSH_OPTIONS,
  clearPrefixes: string[] = RULES
) {
  return buildPushPlan({
    target,
    filePath: "C:/tmp/test.xlsx",
    outputs,
    options,
    clearPrefixes,
    departmentNameByCode: NAMES,
    accountNameByCode: NAMES,
  });
}

// ── Code conversion ─────────────────────────────────────────────────

describe("code conversion", () => {
  it("inverts the pull's D/A prefixes", () => {
    expect(toSheetName("D0410")).toBe("0410");
    expect(toBareAccount("A988112")).toBe("988112");
    expect(toCombo("D0410", "A988112")).toBe("0410-988112");
  });

  it("scales currency to thousands and leaves 9-accounts in units", () => {
    expect(scaleForAccount("510000")).toBe(1000);
    expect(scaleForAccount("560320")).toBe(1000);
    expect(scaleForAccount("988000")).toBe(1);
    expect(scaleForAccount("972540")).toBe(1);
  });

  it("clears the accounts the old macro MEANT to clear", () => {
    // The macro tested the left of the combo (the department) for two of its
    // three families, so only 5xxxxx ever cleared. The default rules implement
    // the intent.
    expect(matchesClearRules("510000", RULES)).toBe("5");
    expect(matchesClearRules("560320", RULES)).toBe("5");
    expect(matchesClearRules("988000", RULES)).toBe("988");
    expect(matchesClearRules("988112", RULES)).toBe("988");
    expect(matchesClearRules("972540", RULES)).toBe("97254");
    // Revenue, cost of sales and other stats are left alone.
    expect(matchesClearRules("414001", RULES)).toBeNull();
    expect(matchesClearRules("300000", RULES)).toBeNull();
    expect(matchesClearRules("961010", RULES)).toBeNull();
  });

  it("attributes a row to the most specific rule that covers it", () => {
    // Otherwise the chip counts would credit a broad rule for rows a precise
    // one was added for, and deleting the precise rule would look free.
    expect(matchesClearRules("510000", ["5", "5100", "51"])).toBe("5100");
  });
});

describe("clear rule parsing", () => {
  it("takes a prefix in any form the user might type", () => {
    expect(normalizeClearPrefix("A512400")).toBe("512400");
    expect(normalizeClearPrefix(" 988 ")).toBe("988");
    expect(normalizeClearPrefix("5")).toBe("5");
    expect(normalizeClearPrefix("a97254")).toBe("97254");
    expect(normalizeClearPrefix("")).toBeNull();
    expect(normalizeClearPrefix("5A1")).toBeNull();
    expect(normalizeClearPrefix("1234567")).toBeNull();
  });

  it("dedupes and drops junk from a whole rule set", () => {
    expect(normalizeClearPrefixes(["A5", "5", " 988 ", "oops", null])).toEqual([
      "5",
      "988",
    ]);
  });

  it("keeps an explicitly emptied rule set empty", () => {
    // Falling back to the defaults here would make "clear nothing" impossible.
    expect(normalizeClearPrefixes([])).toEqual([]);
  });
});

describe("option normalization", () => {
  it("translates the pre-per-month option shape", () => {
    const migrated = normalizeBstPushOptions({
      mode: "overwrite",
      zeroFirst: true,
      firstMonth: 4,
      backup: false,
    });
    expect(migrated.months.slice(0, 3)).toEqual(["skip", "skip", "skip"]);
    expect(migrated.months.slice(3)).toEqual(Array(9).fill("replace"));
    expect(migrated.backup).toBe(false);
  });

  it("keeps additive months additive, but not over a cleared column", () => {
    expect(
      normalizeBstPushOptions({ mode: "add", zeroFirst: false }).months[0]
    ).toBe("add");
    // Clearing then adding is arithmetically a replace.
    expect(
      normalizeBstPushOptions({ mode: "add", zeroFirst: true }).months[0]
    ).toBe("replace");
  });

  it("defaults skipUnusedCombos off and passes an explicit choice through", () => {
    // Off is the behaviour the tool always had — a genuine zero row still
    // overwrites — so an absent or garbled flag must land there.
    expect(normalizeBstPushOptions(undefined).skipUnusedCombos).toBe(false);
    expect(normalizeBstPushOptions({ skipUnusedCombos: "yes" }).skipUnusedCombos).toBe(false);
    expect(normalizeBstPushOptions({ skipUnusedCombos: true }).skipUnusedCombos).toBe(true);
  });

  it("defaults anything unrecognisable to a full replace", () => {
    expect(normalizeBstPushOptions(undefined).months).toEqual(
      Array(12).fill("replace")
    );
    expect(normalizeBstPushOptions({ months: ["nonsense", "clear"] }).months[0]).toBe(
      "replace"
    );
    expect(normalizeBstPushOptions({ months: ["skip", "clear"] }).months[1]).toBe(
      "clear"
    );
  });
});

// ── Reading the target ──────────────────────────────────────────────

describe("readTarget", () => {
  it("reads identity from the cells the file states it in", () => {
    expect(target.ou).toBe("OU75AZB"); // D5, not B5
    expect(target.year).toBe(2027); // B1 as a number
    expect(target.hotelName).toBe("Bvlgari Hotel Roma");
    expect(target.currency).toBe("EUR");
    expect(target.budgetBucketType).toBe("BUDGET");
  });

  it("indexes only real department sheets, by their true Excel row", () => {
    expect(target.departmentSheets.sort()).toEqual(["0010", "0410"]);
    expect(target.combos.get("0010-560320")).toMatchObject({
      sheet: "0010",
      row: 33,
    });
    expect(target.combos.get("0410-988112")).toMatchObject({
      sheet: "0410",
      row: 269,
    });
  });

  it("never treats a division summary or a mismatched sheet as a department", () => {
    expect(isDepartmentSheet("Rooms")).toBe(false);
    expect(isDepartmentSheet("tpl_rooms")).toBe(false);
    expect(target.bySheet.has("Rooms")).toBe(false);
    // "0011" is named like a department but its E2 says 9999 — skipped.
    expect(target.bySheet.has("0011")).toBe(false);
    expect(target.combos.has("0011-510000")).toBe(false);
  });

  it("takes the first of a duplicated combo and flags it", () => {
    const location = target.combos.get("0010-510000")!;
    expect(location.row).toBe(21);
    expect(location.duplicate).toBe(true);
  });

  it("refuses a workbook that is not a BST", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1]]), "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(() => readTarget(buf, "bad.xlsx")).toThrow(NotBstFileError);
  });

  it("refuses a BST with no addressable department sheets", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, setupSheet(), "Setup Fields");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1]]), "Rooms");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(() => readTarget(buf, "empty.xlsx")).toThrow(UnsupportedLayoutError);
  });
});

// ── Building the plan ───────────────────────────────────────────────

describe("buildPushPlan", () => {
  it("divides currency by 1000 and leaves stats alone", () => {
    const result = plan([
      outRow("D0010", "A510000", 55_935),
      outRow("D0010", "A988000", 1_234, true),
    ]);
    const wage = result.rows.find((r) => r.combo === "0010-510000")!;
    const hours = result.rows.find((r) => r.combo === "0010-988000")!;
    expect(wage.months[0]).toBe(55.935);
    expect(wage.total).toBeCloseTo(671.22, 6);
    expect(hours.months[0]).toBe(1_234);
  });

  it("never plans two writes for one combo, however the codes were spelled", () => {
    const result = plan([
      outRow("D0010", "A560320", 1000),
      outRow("0010", "560320", 500), // same BST row, unprefixed
    ]);
    const matching = result.rows.filter((r) => r.combo === "0010-560320");
    expect(matching).toHaveLength(1);
    // Added, not overwritten: 1500 / 1000 scale.
    expect(matching[0].months[0]).toBe(1.5);
    expect(result.cellCount).toBe(12);
    expect(result.warnings.join(" ")).toMatch(/more than one Results row/);
  });

  it("classifies every row and counts what will land", () => {
    const result = plan([
      outRow("D0010", "A510000", 1000), // duplicate row on the sheet
      outRow("D0010", "A560320", 1000), // clean match
      outRow("D0010", "A999999", 1000), // sheet exists, account does not
      outRow("D0500", "A510000", 1000), // no sheet at all
    ]);
    const status = Object.fromEntries(
      result.rows.map((row) => [row.combo, row.status])
    );
    expect(status["0010-510000"]).toBe("duplicate_row");
    expect(status["0010-560320"]).toBe("write");
    expect(status["0010-999999"]).toBe("no_row");
    expect(status["0500-510000"]).toBe("no_sheet");

    expect(result.writeCount).toBe(2); // write + duplicate_row both land
    expect(result.problemCount).toBe(2);
    expect(result.cellCount).toBe(24); // 2 rows × 12 months
    expect(result.departmentCount).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/Dept Settings/);
    expect(result.warnings.join(" ")).toMatch(/more than one row/);
  });

  it("demotes missing combos with nothing to push to no_data, not problems", () => {
    const result = plan([
      outRow("D0010", "A999999", 0), // sheet exists, no row, all zeroes
      outRow("D0500", "A510000", 0), // no sheet at all, all zeroes
      outRow("D0010", "A560320", 0), // matched — a genuine zero is still a write
    ]);
    const status = Object.fromEntries(
      result.rows.map((row) => [row.combo, row.status])
    );
    expect(status["0010-999999"]).toBe("no_data");
    expect(status["0500-510000"]).toBe("no_data");
    expect(status["0010-560320"]).toBe("write");

    // Neither the problem count nor the missing-sheet warning should fire for
    // rows the user has no reason to act on.
    expect(result.problemCount).toBe(0);
    expect(result.warnings.join(" ")).not.toMatch(/Dept Settings/);
  });

  it("leaves an unused combo entirely alone when skipUnusedCombos is on", () => {
    const options: BstPushOptions = { ...every("replace"), skipUnusedCombos: true };
    const result = plan(
      [
        outRow("D0010", "A560320", 0), // matched in the BST, all zeroes → skipped
        outRow("D0010", "A510000", 1000), // has data → written as before
      ],
      options
    );
    const status = Object.fromEntries(
      result.rows.map((row) => [row.combo, row.status])
    );
    expect(status["0010-560320"]).toBe("skipped");
    expect(status["0010-510000"]).toBe("duplicate_row");
    expect(result.skippedCount).toBe(1);
    expect(result.writeCount).toBe(1);
    // Skipped is deliberate, not a failure to land.
    expect(result.problemCount).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/skip unused combos/);

    // The whole point: the skipped row (560320, row 33) gets no write at all —
    // not even from the clear pass its "5" prefix would otherwise pull it into.
    const writes = toCellWrites(result, target);
    expect(writes.some((write) => write.sheet === "0010" && write.row === 33)).toBe(false);
    // Rows Kairos never produces still clear — the rules' clean-up job is not
    // narrowed, only the combos the user chose to leave alone are spared.
    expect(writes.some((write) => write.sheet === "0010" && write.row === 226)).toBe(true);
    // The tile arithmetic follows: nothing counted for the skipped row.
    expect(result.zeroCellCount).toBe(toZeroWrites(target, options, RULES).length - 12);
  });

  it("still overwrites an all-zero row when the toggle is off", () => {
    const result = plan([outRow("D0010", "A560320", 0)], every("replace"));
    expect(result.rows[0].status).toBe("write");
    expect(result.skippedCount).toBe(0);
    expect(result.cellCount).toBe(12);
  });

  it("writes only the chosen months, without shifting the data", () => {
    const result = plan(
      [outRow("D0010", "A560320", 12_000)],
      only("replace", 4, 5, 6, 7, 8, 9, 10, 11, 12)
    );
    const row = result.rows[0];
    expect(row.months.slice(0, 3)).toEqual([0, 0, 0]);
    // April still carries April's number — the macro's additive branch shifted
    // it by the offset; that bug is deliberately not ported.
    expect(row.months[3]).toBe(12);
    expect(row.months[11]).toBe(12);
    expect(result.cellCount).toBe(9);
  });

  it("summarises each month independently", () => {
    const options: BstPushOptions = {
      months: [
        "skip", "skip", "add", "clear",
        "replace", "replace", "replace", "replace",
        "replace", "replace", "replace", "replace",
      ],
      backup: true,
      skipUnusedCombos: false,
    };
    const result = plan([outRow("D0010", "A560320", 12_000)], options);
    const byMonth = Object.fromEntries(
      result.monthPlan.map((entry) => [entry.month, entry])
    );

    expect(byMonth[1]).toMatchObject({ action: "skip", writeCells: 0, clearCells: 0 });
    expect(byMonth[3]).toMatchObject({ action: "add", writeCells: 1, clearCells: 0 });
    expect(byMonth[3].writeTotal).toBe(12);
    // A cleared month writes nothing but still changes cells.
    expect(byMonth[4]).toMatchObject({ action: "clear", writeCells: 0 });
    expect(byMonth[4].clearCells).toBeGreaterThan(0);
    expect(byMonth[5]).toMatchObject({ action: "replace", writeCells: 1 });
    expect(byMonth[5].clearCells).toBe(byMonth[4].clearCells);

    // The tiles must add up to the totals the summary tiles show.
    expect(result.cellCount).toBe(
      result.monthPlan.reduce((sum, entry) => sum + entry.writeCells, 0)
    );
    expect(result.zeroCellCount).toBe(
      result.monthPlan.reduce((sum, entry) => sum + entry.clearCells, 0)
    );
    expect(result.warnings.join(" ")).toMatch(/Jan–Feb/);
    expect(result.warnings.join(" ")).toMatch(/Apr will be zeroed/);
  });

  it("skips non-finite values rather than writing them", () => {
    const broken = outRow("D0010", "A560320", 1000);
    broken.months[5] = Number.NaN;
    const result = plan([broken]);
    expect(result.rows[0].months[5]).toBe(0);
    expect(result.cellCount).toBe(11);
    expect(result.warnings.join(" ")).toMatch(/not a finite number/);
  });

  it("surfaces blocks that compute but post nowhere", () => {
    const result = buildPushPlan({
      target,
      filePath: "C:/tmp/test.xlsx",
      outputs: [outRow("D0010", "A560320", 1000)],
      options: DEFAULT_BST_PUSH_OPTIONS,
      clearPrefixes: RULES,
      departmentNameByCode: NAMES,
      accountNameByCode: NAMES,
      unpostedByLabel: { "Meal allowance": 4 },
    });
    expect(result.warnings.join(" ")).toMatch(/Meal allowance/);
  });
});

// ── What the clear rules cover ──────────────────────────────────────

describe("buildClearScope", () => {
  const scope = (prefixes: string[], outputs: OutputAggRowDto[] = []) =>
    buildClearScope(target, outputs, prefixes, NAMES);

  it("counts the BST rows each rule matches, including rules that match none", () => {
    const result = scope(["5", "988", "97254", "4140"]);
    expect(result.ruleMatches["5"]).toBe(3); // 510000 twice + 560320
    expect(result.ruleMatches["988"]).toBe(2); // 988000 on 0010, 988112 on 0410
    expect(result.ruleMatches["97254"]).toBe(1);
    // 414001 exists but a rule that matches it is a mistake worth showing.
    expect(result.ruleMatches["4140"]).toBe(1);
    expect(result.cellsPerClearedMonth).toBe(7);
  });

  it("flags an account Kairos writes that no rule covers", () => {
    const result = scope(RULES, [outRow("D0010", "A414001", 900)]);
    expect(result.uncoveredWritten).toEqual(["A414001"]);
    const row = result.accounts.find((a) => a.account === "A414001")!;
    expect(row).toMatchObject({ written: true, matchedBy: null, bstRows: 1 });
  });

  it("flags a rule-matched account Kairos never writes back to", () => {
    const result = scope(RULES, [outRow("D0010", "A510000", 900)]);
    expect(result.clearedNotWritten).toContain("A560320");
    expect(result.clearedNotWritten).not.toContain("A510000");
  });

  it("leaves out accounts that are neither cleared nor written", () => {
    // 414001 is in the workbook but irrelevant to both questions the card asks.
    expect(scope(RULES).accounts.map((a) => a.account)).not.toContain("A414001");
  });
});

// ── Turning a plan into cell writes ─────────────────────────────────

describe("cell writes", () => {
  it("targets I..T on the matched row", () => {
    const result = plan(
      [outRow("D0410", "A988112", 41.2, true)],
      every("replace"),
      [] // no clear rules, so the value writes are the only writes
    );
    const writes = toCellWrites(result, target);
    expect(writes).toHaveLength(12);
    expect(writes[0]).toMatchObject({
      sheet: "0410",
      row: 269,
      col: BUDGET_COL_START, // column I
      value: 41.2,
    });
    expect(writes[11].col).toBe(BUDGET_COL_START + 11); // column T
  });

  it("zeroes only the rule-matched rows, over the full year", () => {
    const writes = toZeroWrites(target, every("replace"), RULES);
    const cleared = new Set(
      writes.map((write) => `${write.sheet}!${write.row}`)
    );
    // 510000, 560320, 988000, 972540 on 0010 (twice for the duplicated 510000)
    // plus 988112 on 0410 — but never the 414001 cost-of-sales row.
    expect(cleared.has("0010!13")).toBe(false);
    expect(cleared.has("0010!21")).toBe(true);
    expect(cleared.has("0010!300")).toBe(true); // the duplicate row too
    expect(cleared.has("0410!269")).toBe(true);
    expect(writes.every((write) => write.value === 0)).toBe(true);
    expect(writes).toHaveLength(cleared.size * 12);
  });

  it("puts the zero pass before the values so a write lands on top", () => {
    const result = plan([outRow("D0010", "A560320", 12_000)]);
    const writes = toCellWrites(result, target);
    const first = writes.findIndex(
      (w) => w.sheet === "0010" && w.row === 33 && w.col === BUDGET_COL_START
    );
    const last = writes.length - 1;
    expect(writes[last]).toMatchObject({ sheet: "0010", row: 33, value: 12 });
    expect(first).toBeLessThan(last);
  });

  it("marks additive writes so the writer adds instead of replacing", () => {
    const result = plan([outRow("D0010", "A560320", 12_000)], every("add"));
    const writes = toCellWrites(result, target);
    expect(writes).toHaveLength(12);
    // "add" never clears, whatever the rules say.
    expect(writes.every((write) => write.add)).toBe(true);
  });

  // ── Per-month scoping: the point of the whole feature ──

  it("touches nothing at all in a skipped month", () => {
    const result = plan([outRow("D0010", "A560320", 12_000)], every("skip"));
    expect(toCellWrites(result, target)).toHaveLength(0);
    expect(result.cellCount).toBe(0);
    expect(result.zeroCellCount).toBe(0);
  });

  it("clears a column without writing anything back", () => {
    const result = plan([outRow("D0010", "A560320", 12_000)], every("clear"));
    const writes = toCellWrites(result, target);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => write.value === 0)).toBe(true);
    expect(result.cellCount).toBe(0);
  });

  it("leaves the protected columns of the year completely alone", () => {
    // The whole reason this feature exists: Jan–Sep hold actuals, Oct–Dec are
    // re-forecast. Not one write may fall left of column R.
    const result = plan(
      [outRow("D0010", "A560320", 12_000), outRow("D0410", "A988112", 40, true)],
      only("replace", 10, 11, 12)
    );
    const writes = toCellWrites(result, target);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => write.col >= BUDGET_COL_START + 9)).toBe(true);
    expect(new Set(writes.map((write) => write.col))).toEqual(
      new Set([BUDGET_COL_START + 9, BUDGET_COL_START + 10, BUDGET_COL_START + 11])
    );
  });

  it("mixes actions across the same year", () => {
    const options: BstPushOptions = {
      months: [
        "skip", "skip", "skip", "skip", "skip", "skip",
        "clear", "clear", "clear",
        "replace", "replace", "replace",
      ],
      backup: true,
      skipUnusedCombos: false,
    };
    const result = plan([outRow("D0010", "A560320", 12_000)], options);
    const writes = toCellWrites(result, target);
    const valueWrites = writes.filter(
      (write) => write.sheet === "0010" && write.row === 33 && write.value !== 0
    );
    // Values only in Oct–Dec…
    expect(
      valueWrites.map((write) => write.col - BUDGET_COL_START).sort((a, b) => a - b)
    ).toEqual([9, 10, 11]);
    // …and nothing whatsoever in Jan–Jun.
    expect(writes.some((write) => write.col < BUDGET_COL_START + 6)).toBe(false);
  });

  it("counts exactly what the writer will clear", () => {
    // countZeroableCells IS the write list's length — the preview's number can
    // never drift from what lands.
    const options = only("clear", 11, 12);
    expect(countZeroableCells(target, options, RULES)).toBe(
      toZeroWrites(target, options, RULES).length
    );
    expect(countZeroableCells(target, options, RULES)).toBe(
      countZeroableCells(target, every("replace"), RULES) / 6
    );
  });

  it("clears nothing when the rule set is empty", () => {
    expect(toZeroWrites(target, every("clear"), [])).toHaveLength(0);
  });

  it("clears what a custom rule set names, and only that", () => {
    const writes = toZeroWrites(target, every("clear"), ["4140"]);
    expect(new Set(writes.map((write) => `${write.sheet}!${write.row}`))).toEqual(
      new Set(["0010!13"])
    );
  });
});

// ── Opt-in spot check against the real workbook ─────────────────────

const realFile = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "Downloads",
  "2027 BGT_Spread_File - 75AZB Bvlgari Hotel Roma.xlsm"
);
const hasRealFile = (() => {
  try {
    return fs.existsSync(realFile);
  } catch {
    return false;
  }
})();

describe.runIf(hasRealFile)("readTarget (real 75AZB file)", () => {
  it("finds the identity and every department sheet", () => {
    const real = readTarget(fs.readFileSync(realFile), path.basename(realFile));
    expect(real.ou).toBe("OU75AZB");
    expect(real.year).toBe(2027);
    expect(real.budgetBucketType).toBe("BUDGET");
    expect(real.departmentSheets.length).toBeGreaterThan(30);
    // Sheets are bare 4-digit codes; summaries and templates are excluded.
    expect(real.departmentSheets.every((name) => /^\d{4}$/.test(name))).toBe(true);
    // Known rows from the reference workbook.
    expect(real.combos.get("0010-510600")).toMatchObject({ sheet: "0010", row: 178 });
    expect(real.combos.get("0410-988112")).toMatchObject({ sheet: "0410", row: 269 });
  });
});
