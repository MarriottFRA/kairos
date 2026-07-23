/**
 * Budget-import repo tests — commit + read-back + pivot + soft-delete against an
 * in-memory SQLite database (the schema is exec'd directly, matching the
 * mapping-tables tests).
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { BUDGET_IMPORT_SQL } from "../schema";
import { commitImport, getCurrentImport, getImportRows } from "../repo";
import type { ParsedDataset } from "../parseWorkbook";
import { WIDE_CELL_COUNT } from "../../../shared/budgetImport/ipc";

type Db = InstanceType<typeof Database>;

const NOW = "2026-07-23T00:00:00.000Z";
const OU = "OU1LWX4";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(BUDGET_IMPORT_SQL);
});

/** Build a wide cells array where each cell encodes bucket*100 + month. */
function cells(): number[] {
  const out: number[] = [];
  for (let b = 1; b <= 3; b++) {
    for (let m = 1; m <= 12; m++) out.push(b * 100 + m);
  }
  return out;
}

function sampleDataset(): ParsedDataset {
  return {
    meta: {
      ou: OU,
      sourceFileName: "test.xlsm",
      hotelName: "Aloft Madrid Gran Via",
      bu: "XMWX4",
      currency: "EUR",
      asOfPeriod: "Jun-26",
    },
    buckets: [
      { index: 1, type: "BUDGET", year: 2027 },
      { index: 2, type: "ACT/FCST", year: 2026 },
      { index: 3, type: "ACTUAL", year: 2025 },
    ],
    rows: [
      { dept: "0010", account: "414001", combo: "0010-414001", description: "A", cells: cells() },
      { dept: "0010", account: "961010", combo: "0010-961010", description: "B", cells: cells() },
    ],
  };
}

function commitSample(id = "imp-1", importedBy: string | null = "rp@x.com"): void {
  commitImport(db, {
    id,
    ou: OU,
    importedBy,
    dataset: sampleDataset(),
    importedAt: NOW,
  });
}

describe("budgetImport repo", () => {
  it("commits a dataset and reads it back with buckets + who/when", () => {
    commitSample();
    const summary = getCurrentImport(db, OU);
    expect(summary).toMatchObject({
      id: "imp-1",
      ou: OU,
      hotelName: "Aloft Madrid Gran Via",
      currency: "EUR",
      rowCount: 2,
      importedAt: NOW,
      importedBy: "rp@x.com",
    });
    expect(summary!.buckets).toEqual([
      { index: 1, type: "BUDGET", year: 2027 },
      { index: 2, type: "ACT/FCST", year: 2026 },
      { index: 3, type: "ACTUAL", year: 2025 },
    ]);
  });

  it("writes one value row per combo × bucket × month", () => {
    commitSample();
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM budget_values WHERE import_id = ?")
      .get("imp-1") as { n: number };
    expect(n.n).toBe(2 * 3 * 12);
  });

  it("pivots values back to wide rows in bucket-major order", () => {
    commitSample();
    const rows = getImportRows(db, OU);
    expect(rows.map((r) => r.combo)).toEqual(["0010-414001", "0010-961010"]);
    const row = rows[0];
    expect(row.cells).toHaveLength(WIDE_CELL_COUNT);
    expect(row.cells[0]).toBe(101); // bucket1 Jan
    expect(row.cells[11]).toBe(112); // bucket1 Dec
    expect(row.cells[12]).toBe(201); // bucket2 Jan
    expect(row.cells[35]).toBe(312); // bucket3 Dec
  });

  it("overwrites: a second commit replaces the first for that OU", () => {
    commitSample("imp-1");
    commitSample("imp-2");
    const summary = getCurrentImport(db, OU);
    expect(summary!.id).toBe("imp-2");
    // No orphaned values from the first import remain.
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM budget_values")
      .get() as { n: number };
    expect(n.n).toBe(2 * 3 * 12);
  });

  it("scopes reads by OU (a different OU sees nothing)", () => {
    commitSample();
    expect(getCurrentImport(db, "OU9ZZZZ")).toBeNull();
    expect(getImportRows(db, "OU9ZZZZ")).toHaveLength(0);
  });
});
