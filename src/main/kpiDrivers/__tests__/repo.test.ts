/**
 * KPI-driver repo tests — aggregation (EXPLICIT / POSITION), GLOB wildcards
 * (? and *), account filtering, zero-fill, staleness, and CRUD against an
 * in-memory SQLite database. Budget rows are seeded directly so each scenario
 * controls dept/account/bucket, matching the budgetImport repo tests.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { BUDGET_IMPORT_SQL } from "../../budgetImport/schema";
import { KPI_DRIVERS_SQL } from "../schema";
import {
  deleteDriver,
  getSeries,
  listDrivers,
  nextSortOrder,
  recomputeAllForOu,
  recomputeDriver,
  saveDriver,
} from "../repo";
import { KPI_EXPLICIT_DEPT_KEY, KpiDriverId } from "../../../shared/kpiDrivers/ipc";

type Db = InstanceType<typeof Database>;

const NOW = "2026-07-23T00:00:00.000Z";
const OU = "OU1LWX4";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(BUDGET_IMPORT_SQL);
  db.exec(KPI_DRIVERS_SQL);
});

function seedImport(id: string): void {
  db.prepare(
    `INSERT INTO budget_imports (id, ou, source_filename, imported_at, row_count)
     VALUES (?, ?, 'f.xlsm', ?, 0)`
  ).run(id, OU, NOW);
}

function seedValue(
  importId: string,
  dept: string,
  account: string,
  bucket: number,
  period: number,
  value: number
): void {
  db.prepare(
    `INSERT INTO budget_values
       (import_id, ou, dept, account, combo, bucket_index, period, value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(importId, OU, dept, account, `${dept}-${account}`, bucket, period, value);
}

/** A budget where several depts carry A3 revenue in bucket 1 (+ noise). */
function seedRevenueBudget(): void {
  seedImport("imp-1");
  seedValue("imp-1", "D0010", "A3001", 1, 1, 10);
  seedValue("imp-1", "D0010", "A3001", 1, 2, 20);
  seedValue("imp-1", "D0020", "A3001", 1, 1, 5);
  seedValue("imp-1", "D0100", "A3001", 1, 1, 7);
  seedValue("imp-1", "D0010", "A5999", 1, 1, 1000); // wrong account (excluded)
  seedValue("imp-1", "D0010", "A3001", 2, 1, 999); // wrong bucket (excluded)
}

function makeExplicit(
  id: string,
  deptPatterns: string[],
  accountPrefixes: string[]
): void {
  saveDriver(db, {
    id,
    ou: OU,
    label: id,
    deptMode: "EXPLICIT",
    deptPatterns,
    accountPrefixes,
    bucketIndex: 1,
    sortOrder: nextSortOrder(db, OU),
    createdBy: null,
    now: NOW,
  });
}

function explicitSeries(id: string): number[] {
  recomputeDriver(db, OU, id, { computedAt: NOW });
  const series = getSeries(db, OU, id);
  expect(series).toHaveLength(1);
  expect(series[0].deptKey).toBe(KPI_EXPLICIT_DEPT_KEY);
  return series[0].values;
}

describe("kpiDrivers repo — aggregation", () => {
  it("EXPLICIT '*' sums all departments' matching accounts per period", () => {
    seedRevenueBudget();
    makeExplicit("d-all", ["*"], ["A3"]);
    const v = explicitSeries("d-all");
    expect(v[0]).toBe(22); // 10 + 5 + 7
    expect(v[1]).toBe(20);
    expect(v.slice(2)).toEqual(new Array(10).fill(0)); // zero-filled
  });

  it("EXPLICIT '?' wildcard matches a single char (D00?? excludes D0100)", () => {
    seedRevenueBudget();
    makeExplicit("d-q", ["D00??"], ["A3"]);
    const v = explicitSeries("d-q");
    expect(v[0]).toBe(15); // D0010 (10) + D0020 (5); D0100 excluded
    expect(v[1]).toBe(20);
  });

  it("EXPLICIT '*' wildcard spans a run (D01* matches only D0100)", () => {
    seedRevenueBudget();
    makeExplicit("d-star", ["D01*"], ["A3"]);
    const v = explicitSeries("d-star");
    expect(v[0]).toBe(7); // only D0100
    expect(v[1]).toBe(0);
  });

  it("excludes non-matching accounts and other buckets", () => {
    seedRevenueBudget();
    makeExplicit("d-acc", ["*"], ["A3"]);
    const v = explicitSeries("d-acc");
    // A5999 (1000) and the bucket-2 row (999) never appear.
    expect(v.reduce((a, b) => a + b, 0)).toBe(42); // 10+20+5+7
  });

  it("POSITION mode yields one zero-filled series per department present", () => {
    seedRevenueBudget();
    saveDriver(db, {
      id: "d-pos",
      ou: OU,
      label: "By dept",
      deptMode: "POSITION",
      deptPatterns: [],
      accountPrefixes: ["A3"],
      bucketIndex: 1,
      sortOrder: 0,
      createdBy: null,
      now: NOW,
    });
    recomputeDriver(db, OU, "d-pos", { computedAt: NOW });
    const series = getSeries(db, OU, "d-pos");
    const byDept = Object.fromEntries(series.map((s) => [s.deptKey, s.values]));
    expect(Object.keys(byDept).sort()).toEqual(["D0010", "D0020", "D0100"]);
    expect(byDept["D0010"][0]).toBe(10);
    expect(byDept["D0010"][1]).toBe(20);
    expect(byDept["D0020"][0]).toBe(5);
    expect(byDept["D0100"][0]).toBe(7);
  });

  it("multiple account prefixes are OR-ed together", () => {
    seedImport("imp-1");
    seedValue("imp-1", "D0010", "A3001", 1, 1, 3);
    seedValue("imp-1", "D0010", "A4001", 1, 1, 4);
    seedValue("imp-1", "D0010", "A5001", 1, 1, 5); // excluded
    makeExplicit("d-multi", ["*"], ["A3", "A4"]);
    const v = explicitSeries("d-multi");
    expect(v[0]).toBe(7); // 3 + 4, not 5
  });

  it("writes a zero series when there is no budget data", () => {
    makeExplicit("d-empty", ["*"], ["A3"]);
    const v = explicitSeries("d-empty");
    expect(v).toEqual(new Array(12).fill(0));
  });
});

describe("kpiDrivers repo — built-ins & CRUD", () => {
  it("lists the Total Revenue built-in for every OU", () => {
    const drivers = listDrivers(db, OU);
    const builtin = drivers.find((d) => d.id === "kpi:builtin:total-revenue");
    expect(builtin).toBeTruthy();
    expect(builtin!.isBuiltin).toBe(true);
    expect(builtin!.deptPatterns).toEqual(["*"]);
    expect(builtin!.accountPrefixes).toEqual(["A3"]);
  });

  it("recomputeAllForOu computes the built-in against seeded revenue", () => {
    seedRevenueBudget();
    recomputeAllForOu(db, OU, { computedAt: NOW });
    const series = getSeries(db, OU, "kpi:builtin:total-revenue");
    expect(series).toHaveLength(1);
    expect(series[0].values[0]).toBe(22);
  });

  it("saves, lists (upper-cased), and soft-deletes a user driver", () => {
    saveDriver(db, {
      id: "u-1",
      ou: OU,
      label: "  Rooms  ",
      deptMode: "EXPLICIT",
      deptPatterns: ["d00??"], // lower-case in → upper-cased for GLOB
      accountPrefixes: ["a3"],
      bucketIndex: 1,
      sortOrder: 0,
      createdBy: "rp@x.com",
      now: NOW,
    });
    let drivers = listDrivers(db, OU);
    const saved = drivers.find((d) => d.id === "u-1");
    expect(saved).toMatchObject({
      label: "Rooms",
      deptPatterns: ["D00??"],
      accountPrefixes: ["A3"],
      isBuiltin: false,
    });

    deleteDriver(db, OU, "u-1", { now: NOW });
    drivers = listDrivers(db, OU);
    expect(drivers.find((d) => d.id === "u-1")).toBeUndefined();
  });

  it("rejects editing or deleting a built-in", () => {
    expect(() =>
      saveDriver(db, {
        id: "kpi:builtin:total-revenue",
        ou: OU,
        label: "hax",
        deptMode: "EXPLICIT",
        deptPatterns: ["*"],
        accountPrefixes: ["A3"],
        bucketIndex: 1,
        sortOrder: 0,
        createdBy: null,
        now: NOW,
      })
    ).toThrow();
    expect(() =>
      deleteDriver(db, OU, "kpi:builtin:total-revenue", { now: NOW })
    ).toThrow();
  });

  it("requires a label, an account, and (for EXPLICIT) a pattern", () => {
    const base = {
      id: "u-x",
      ou: OU,
      deptMode: "EXPLICIT" as const,
      deptPatterns: ["*"],
      accountPrefixes: ["A3"],
      bucketIndex: 1,
      sortOrder: 0,
      createdBy: null as string | null,
      now: NOW,
    };
    expect(() => saveDriver(db, { ...base, label: "   " })).toThrow();
    expect(() =>
      saveDriver(db, { ...base, label: "ok", accountPrefixes: [] })
    ).toThrow();
    expect(() =>
      saveDriver(db, { ...base, label: "ok", deptPatterns: [] })
    ).toThrow();
  });
});

describe("kpiDrivers repo — staleness", () => {
  it("is not stale right after a recompute against the current import", () => {
    seedRevenueBudget();
    makeExplicit("d-stale", ["*"], ["A3"]);
    recomputeDriver(db, OU, "d-stale", { computedAt: NOW });
    const driver = listDrivers(db, OU).find((d) => d.id === "d-stale");
    expect(driver!.isStale).toBe(false);
  });

  it("becomes stale when the budget import is superseded", () => {
    seedRevenueBudget();
    makeExplicit("d-stale", ["*"], ["A3"]);
    recomputeDriver(db, OU, "d-stale", { computedAt: NOW });

    // Replace the import (new id) without recomputing the driver.
    db.prepare("DELETE FROM budget_imports WHERE ou = ?").run(OU);
    seedImport("imp-2");

    const driver = listDrivers(db, OU).find((d) => d.id === "d-stale");
    expect(driver!.isStale).toBe(true);
  });

  it("is stale when there is budget data but no cache yet", () => {
    seedRevenueBudget();
    makeExplicit("d-fresh", ["*"], ["A3"]); // saved but never recomputed
    const driver = listDrivers(db, OU).find((d) => d.id === "d-fresh");
    expect(driver!.isStale).toBe(true);
  });
});
