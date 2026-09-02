/**
 * Manual-input repo tests — against in-memory SQLite (exec of the secure-store
 * DDL). Covers: create → list, JSON month-vector round-trip, update-in-place,
 * OU scoping, sort order, and soft delete.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { MANUAL_INPUT_TABLES_SQL, applyManualInputKpiStats } from "../schema";
import {
  deleteRows,
  healBlankRowIds,
  listRows,
  nextSortOrder,
  saveRow,
} from "../repo";
import type { SpreadMode } from "../../../shared/manualInput/ipc";

type Db = InstanceType<typeof Database>;

const OU_A = "OU12345";
const OU_B = "OU67890";
const NOW = "2026-07-23T00:00:00.000Z";
const SCEN = "scenario-1";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MANUAL_INPUT_TABLES_SQL);
});

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    ou: OU_A,
    scenarioId: SCEN,
    description: "Casual labour",
    department: "Front Office",
    departmentCode: "FO",
    costAccount: "A5001",
    statsAccount: "A9001",
    rate: null as number | null,
    statsKpiDriverId: null as string | null,
    statsKpiDivisor: null as number | null,
    statsKpiFactor: null as number | null,
    stats: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    amounts: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
    spreadMode: null as SpreadMode | null,
    spreadBaseStats: null as number | null,
    spreadBaseAmount: null as number | null,
    increasePct: 0,
    increaseMonth: 13,
    sortOrder: 0,
    createdBy: "tester@example.com",
    now: NOW,
    ...overrides,
  };
}

describe("manual-input repo", () => {
  it("creates a row and reads it back with the month vectors intact", () => {
    saveRow(db, baseRow());
    const rows = listRows(db, OU_A, SCEN);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("Casual labour");
    expect(rows[0].departmentCode).toBe("FO");
    expect(rows[0].costAccount).toBe("A5001");
    expect(rows[0].statsAccount).toBe("A9001");
    expect(rows[0].rate).toBeNull();
    expect(rows[0].stats).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(rows[0].amounts).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  });

  it("persists rate and spread config", () => {
    saveRow(
      db,
      baseRow({
        rate: 25.5,
        spreadMode: "daysInMonth",
        spreadBaseStats: 480,
        spreadBaseAmount: 1200,
        increasePct: 0.05,
        increaseMonth: 6,
      })
    );
    const [row] = listRows(db, OU_A, SCEN);
    expect(row.rate).toBe(25.5);
    expect(row.spreadMode).toBe("daysInMonth");
    expect(row.spreadBaseStats).toBe(480);
    expect(row.spreadBaseAmount).toBe(1200);
    expect(row.increasePct).toBeCloseTo(0.05);
    expect(row.increaseMonth).toBe(6);
  });

  it("persists the KPI-stats rule and round-trips null as null", () => {
    saveRow(
      db,
      baseRow({
        statsKpiDriverId: "kpi-1",
        statsKpiDivisor: 50000,
        statsKpiFactor: 20,
      })
    );
    const [row] = listRows(db, OU_A, SCEN);
    expect(row.statsKpiDriverId).toBe("kpi-1");
    expect(row.statsKpiDivisor).toBe(50000);
    expect(row.statsKpiFactor).toBe(20);

    // Null is the mode switch (stats typed) — it must survive an update.
    saveRow(db, baseRow());
    const [cleared] = listRows(db, OU_A, SCEN);
    expect(cleared.statsKpiDriverId).toBeNull();
    expect(cleared.statsKpiDivisor).toBeNull();
    expect(cleared.statsKpiFactor).toBeNull();
  });

  it("normalizes a blank KPI driver id to NULL", () => {
    saveRow(db, baseRow({ statsKpiDriverId: "   " }));
    expect(listRows(db, OU_A, SCEN)[0].statsKpiDriverId).toBeNull();
  });

  it("normalizes short/ragged month vectors to length 12", () => {
    saveRow(db, baseRow({ stats: [1, 2, 3], amounts: [] }));
    const [row] = listRows(db, OU_A, SCEN);
    expect(row.stats).toHaveLength(12);
    expect(row.amounts).toHaveLength(12);
    expect(row.stats.slice(0, 3)).toEqual([1, 2, 3]);
    expect(row.stats.slice(3)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("clamps an out-of-range increase month to 13 (none)", () => {
    saveRow(db, baseRow({ increaseMonth: 99 }));
    expect(listRows(db, OU_A, SCEN)[0].increaseMonth).toBe(13);
  });

  it("updates a row in place on conflicting id", () => {
    saveRow(db, baseRow());
    saveRow(
      db,
      baseRow({ description: "Updated", rate: 40, now: "2026-07-24T00:00:00.000Z" })
    );
    const rows = listRows(db, OU_A, SCEN);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("Updated");
    expect(rows[0].rate).toBe(40);
    expect(rows[0].updatedAt).toBe("2026-07-24T00:00:00.000Z");
  });

  it("scopes rows to their OU", () => {
    saveRow(db, baseRow({ id: "a", ou: OU_A }));
    saveRow(db, baseRow({ id: "b", ou: OU_B }));
    expect(listRows(db, OU_A, SCEN).map((r) => r.id)).toEqual(["a"]);
    expect(listRows(db, OU_B, SCEN).map((r) => r.id)).toEqual(["b"]);
  });

  it("hands out increasing sort orders per OU", () => {
    expect(nextSortOrder(db, OU_A, SCEN)).toBe(0);
    saveRow(db, baseRow({ id: "a", sortOrder: 0 }));
    expect(nextSortOrder(db, OU_A, SCEN)).toBe(1);
    saveRow(db, baseRow({ id: "b", sortOrder: 1 }));
    expect(nextSortOrder(db, OU_A, SCEN)).toBe(2);
    // A different OU is independent.
    expect(nextSortOrder(db, OU_B, SCEN)).toBe(0);
  });

  it("orders rows by sort order", () => {
    saveRow(db, baseRow({ id: "b", sortOrder: 1, description: "second" }));
    saveRow(db, baseRow({ id: "a", sortOrder: 0, description: "first" }));
    expect(listRows(db, OU_A, SCEN).map((r) => r.description)).toEqual(["first", "second"]);
  });

  it("soft-deletes rows so they drop out of the list", () => {
    saveRow(db, baseRow({ id: "a" }));
    saveRow(db, baseRow({ id: "b" }));
    deleteRows(db, OU_A, ["a"], { now: NOW });
    expect(listRows(db, OU_A, SCEN).map((r) => r.id)).toEqual(["b"]);
  });

  // The rows the `input.id ?? randomUUID()` bug left behind: stored on the ''
  // primary key, so undeletable (the handler drops blank ids) and overwritten by
  // the next add. Renamed, keeping whatever was typed into them.
  it("heals a row stored under the empty id, keeping its content", () => {
    saveRow(db, baseRow({ id: "", description: "Typed into the blank row" }));
    healBlankRowIds(db, OU_A, () => "minted-1");
    const rows = listRows(db, OU_A, SCEN);
    expect(rows.map((r) => r.id)).toEqual(["minted-1"]);
    expect(rows[0].description).toBe("Typed into the blank row");
    // And it is now deletable, which was the symptom.
    deleteRows(db, OU_A, ["minted-1"], { now: NOW });
    expect(listRows(db, OU_A, SCEN)).toHaveLength(0);
  });

  it("leaves well-formed rows alone when healing", () => {
    saveRow(db, baseRow({ id: "a" }));
    healBlankRowIds(db, OU_A, () => "minted-1");
    expect(listRows(db, OU_A, SCEN).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("applyManualInputKpiStats (secure v6)", () => {
  // The table as it stood before v6 — no stats_kpi_* columns.
  const PRE_V6_DDL = `
    CREATE TABLE IF NOT EXISTS manual_input_rows (
        id                 TEXT PRIMARY KEY,
        ou                 TEXT NOT NULL,
        scenario_id        TEXT NOT NULL DEFAULT '',
        description        TEXT NOT NULL DEFAULT '',
        department         TEXT NOT NULL DEFAULT '',
        department_code    TEXT NOT NULL DEFAULT '',
        cost_account       TEXT NOT NULL DEFAULT '',
        stats_account      TEXT NOT NULL DEFAULT '',
        rate               REAL,
        stats_json         TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
        amounts_json       TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
        spread_mode        TEXT,
        spread_base_stats  REAL,
        spread_base_amount REAL,
        increase_pct       REAL NOT NULL DEFAULT 0,
        increase_month     INTEGER NOT NULL DEFAULT 13 CHECK (increase_month BETWEEN 1 AND 13),
        sort_order         INTEGER NOT NULL DEFAULT 0,
        created_by         TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        deleted_at         TEXT
    );
  `;

  it("adds the three columns to a pre-v6 store, idempotently", () => {
    const legacy: Db = new Database(":memory:");
    legacy.exec(PRE_V6_DDL);
    legacy
      .prepare(
        `INSERT INTO manual_input_rows (id, ou, scenario_id, created_at, updated_at)
         VALUES ('old-1', ?, ?, ?, ?)`
      )
      .run(OU_A, SCEN, NOW, NOW);

    applyManualInputKpiStats(legacy);
    applyManualInputKpiStats(legacy); // second run must be a no-op, not an error

    // The pre-existing row survives with the feature off…
    const [oldRow] = listRows(legacy, OU_A, SCEN);
    expect(oldRow.statsKpiDriverId).toBeNull();
    // …and the upgraded table takes the full new shape.
    saveRow(
      legacy,
      baseRow({
        id: "new-1",
        statsKpiDriverId: "kpi-1",
        statsKpiDivisor: 50000,
        statsKpiFactor: 20,
      })
    );
    const saved = listRows(legacy, OU_A, SCEN).find((r) => r.id === "new-1")!;
    expect(saved.statsKpiDriverId).toBe("kpi-1");
    expect(saved.statsKpiDivisor).toBe(50000);
    expect(saved.statsKpiFactor).toBe(20);
  });

  it("is a no-op before the table exists", () => {
    const empty: Db = new Database(":memory:");
    expect(() => applyManualInputKpiStats(empty)).not.toThrow();
  });
});
