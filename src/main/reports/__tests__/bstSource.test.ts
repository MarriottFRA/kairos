/**
 * The BST import as a value source: bucket selection by year, type and
 * index; the warnings when there is no import or no such bucket; codes and
 * months; headcount accounts read as levels; and the per-bucket memo.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { BUDGET_IMPORT_SQL } from "../../budgetImport/schema";
import { POSITION_COUNT_ACCOUNT } from "../../../shared/positions/systemAccounts";
import { getBstSource } from "../bstSource";

type Db = InstanceType<typeof Database>;

const OU = "OU12345";
const IMPORT = "imp-1";

let local: Db;

function seedImport(
  buckets: Array<{ type: string; year: number | null }>,
  id = IMPORT
) {
  const [b1, b2, b3] = [buckets[0], buckets[1], buckets[2]];
  local
    .prepare(
      `INSERT INTO budget_imports
         (id, ou, source_filename, bucket1_type, bucket1_year, bucket2_type, bucket2_year,
          bucket3_type, bucket3_year, imported_at, row_count)
       VALUES (?, ?, 'bst.xlsm', ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z', 0)`
    )
    .run(id, OU, b1?.type ?? null, b1?.year ?? null, b2?.type ?? null, b2?.year ?? null, b3?.type ?? null, b3?.year ?? null);
}

function seedValue(bucketIndex: number, dept: string, account: string, period: number, value: number) {
  local
    .prepare(
      `INSERT INTO budget_values
         (import_id, ou, dept, account, combo, bucket_index, bucket_type, year, period, value)
       VALUES (?, ?, ?, ?, ?, ?, 'x', 2027, ?, ?)`
    )
    .run(IMPORT, OU, dept, account, `${dept.slice(1)}-${account.slice(1)}`, bucketIndex, period, value);
}

beforeEach(() => {
  local = new Database(":memory:");
  local.exec(BUDGET_IMPORT_SQL);
});

describe("getBstSource", () => {
  it("warns when the hotel has no import, and when the table is absent altogether", () => {
    expect(getBstSource(local, OU, 2027, { source: "bst" }).warning?.code).toBe("BST_UNAVAILABLE");
    const bare = new Database(":memory:");
    expect(getBstSource(bare, OU, 2027, { source: "bst" }).warning?.code).toBe("BST_UNAVAILABLE");
  });

  it("picks the bucket for the scenario year, narrowed by type when asked", () => {
    seedImport([
      { type: "BUDGET", year: 2027 },
      { type: "ACT/FCST", year: 2026 },
      { type: "BUDGET", year: 2026 },
    ]);
    expect(getBstSource(local, OU, 2027, { source: "bst" }).info).toMatchObject({
      importId: IMPORT,
      bucketIndex: 1,
      bucketType: "BUDGET",
      year: 2027,
    });
    expect(
      getBstSource(local, OU, 2027, { source: "bst", bucket: { type: "act/fcst" }, yearOffset: -1 }).info
    ).toMatchObject({ bucketIndex: 2 });
    expect(getBstSource(local, OU, 2027, { source: "bst", bucket: { index: 3 } }).info).toMatchObject({
      bucketIndex: 3,
      year: 2026,
    });
    // The caller's override wins over the atom's own choice.
    expect(
      getBstSource(local, OU, 2027, { source: "bst", bucket: { type: "BUDGET" } }, { bucketIndex: 2 }).info
    ).toMatchObject({ bucketIndex: 2 });
  });

  it("falls back to the type alone when the year is a cycle off, else warns", () => {
    seedImport([{ type: "BUDGET", year: 2026 }]);
    expect(getBstSource(local, OU, 2027, { source: "bst", bucket: { type: "BUDGET" } }).info).toMatchObject({
      bucketIndex: 1,
      year: 2026,
    });
    const miss = getBstSource(local, OU, 2027, { source: "bst" });
    expect(miss.source).toBeNull();
    expect(miss.warning).toMatchObject({ code: "BST_BUCKET_NOT_FOUND" });
    expect(miss.warning?.message).toContain("1: BUDGET 2026");
  });

  it("reads the bucket into twelve months per combo, headcount accounts as levels", () => {
    seedImport([{ type: "BUDGET", year: 2027 }, { type: "ACT", year: 2026 }]);
    seedValue(1, "D0100", "A400100", 1, 100);
    seedValue(1, "D0100", "A400100", 3, 300);
    seedValue(1, "D0410", POSITION_COUNT_ACCOUNT, 1, 5);
    seedValue(1, "D0410", POSITION_COUNT_ACCOUNT, 7, -1);
    seedValue(2, "D0100", "A400100", 1, 999); // the other bucket

    const { source } = getBstSource(local, OU, 2027, { source: "bst" });
    expect(source!.entries).toHaveLength(2);
    const revenue = source!.get("D0100", "A400100")!;
    expect(Array.from(revenue.vec)).toEqual([100, 0, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 400]);
    expect(revenue.encoding).toBe("AMOUNT");
    const heads = source!.get("0410", POSITION_COUNT_ACCOUNT)!;
    expect(heads.encoding).toBe("LEVEL");
    expect(Array.from(heads.reportVec).slice(0, 8)).toEqual([5, 5, 5, 5, 5, 5, 4, 4]);
    expect(heads.reportVec[12]).toBe(4);
  });

  it("memoises per bucket and rebuilds for a new import", () => {
    seedImport([{ type: "BUDGET", year: 2027 }]);
    seedValue(1, "D0100", "A400100", 1, 1);
    const first = getBstSource(local, OU, 2027, { source: "bst" }).source;
    expect(getBstSource(local, OU, 2027, { source: "bst" }).source).toBe(first);

    local.prepare("DELETE FROM budget_values").run();
    local.prepare("DELETE FROM budget_imports").run();
    seedImport([{ type: "BUDGET", year: 2027 }], "imp-2");
    const second = getBstSource(local, OU, 2027, { source: "bst" }).source;
    expect(second).not.toBe(first);
    expect(second!.entries).toHaveLength(0);
  });
});
