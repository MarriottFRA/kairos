/**
 * Secure-store migration v4 (component_values.department_code) — the
 * "upgrade, never wipe" guard, in the shape countExemptMigration.test.ts set.
 *
 * The tool is published, so an update has to carry an existing store forward.
 * Two things have to hold:
 *
 *   1. Applying the migration to a PRE-v4 store adds the column in place and
 *      leaves every existing row's data intact.
 *   2. A migrated store and a freshly-created one end up with the same set of
 *      columns — the column is written twice (baseline DDL + migration) and a
 *      half-done dual-write silently produces two shapes in the wild.
 *
 * Unlike the plaintext store, ORDER is deliberately not asserted here. The
 * secure store already declares columns mid-table AND appends them by ALTER
 * (see applyValueStoreV12 / positions.cluster_link_id), so fresh and upgraded
 * stores legitimately differ in column order. The set is what matters.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  POSITIONS_VALUE_TABLES_SQL,
  applyComponentValueDepartment,
} from "../schema";

type Db = InstanceType<typeof Database>;

/**
 * component_values exactly as it stood before v4 — i.e. the shipped baseline
 * with department_code removed. Frozen on purpose: it models a real installed
 * store, so it must NOT be rebuilt from the current constant.
 */
const PRE_V4_COMPONENT_VALUES_SQL = `
  CREATE TABLE component_values (
      position_id      TEXT NOT NULL,
      component_def_id TEXT NOT NULL,
      ou               TEXT NOT NULL,
      scenario_id      TEXT NOT NULL,
      rate             REAL,
      yearly_value     REAL,
      monthly_values   TEXT,
      qty              REAL,
      unit_rate        REAL,
      ss_opening_base    REAL,
      account_code       TEXT,
      stats_account_code TEXT,
      updated_at       TEXT NOT NULL,
      deleted_at       TEXT,
      PRIMARY KEY (position_id, component_def_id)
  );
`;

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columns(db: Db, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

let legacy: Db;
let fresh: Db;

beforeEach(() => {
  legacy = new Database(":memory:");
  legacy.exec(PRE_V4_COMPONENT_VALUES_SQL);

  fresh = new Database(":memory:");
  fresh.exec(POSITIONS_VALUE_TABLES_SQL);
});

describe("secure migration v4 — component_values.department_code", () => {
  it("adds the column to a pre-v4 store without touching existing rows", () => {
    legacy
      .prepare(
        `INSERT INTO component_values
           (position_id, component_def_id, ou, scenario_id, rate, account_code,
            updated_at)
         VALUES ('pos-1', 'blk-1:cost', 'OU1', 'sc-1', 0.08, '620000', 'then')`
      )
      .run();

    expect(columns(legacy, "component_values").map((c) => c.name)).not.toContain(
      "department_code"
    );

    applyComponentValueDepartment(legacy);

    const row = legacy
      .prepare(`SELECT * FROM component_values WHERE position_id = 'pos-1'`)
      .get() as Record<string, unknown>;
    expect(row.rate).toBe(0.08);
    expect(row.account_code).toBe("620000");
    expect(row.updated_at).toBe("then");
    // NULL is "the block's own answer", so an upgraded store behaves exactly
    // as it did before the update.
    expect(row.department_code).toBeNull();
  });

  it("is idempotent — re-running it is a no-op", () => {
    applyComponentValueDepartment(legacy);
    const after = columns(legacy, "component_values");
    expect(() => applyComponentValueDepartment(legacy)).not.toThrow();
    expect(columns(legacy, "component_values")).toEqual(after);
  });

  it("leaves a migrated store with the same columns as a fresh one", () => {
    applyComponentValueDepartment(legacy);

    const describeColumn = (c: ColumnInfo) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
    });
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name);

    expect(columns(legacy, "component_values").map(describeColumn).sort(byName)).toEqual(
      columns(fresh, "component_values").map(describeColumn).sort(byName)
    );
  });

  it("reaches a fresh install through the baseline, not just the migration", () => {
    // Rebuild database re-runs the baseline DDL, which must already carry it.
    const column = columns(fresh, "component_values").find(
      (c) => c.name === "department_code"
    );
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  it("does nothing when the value tables do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(() => applyComponentValueDepartment(empty)).not.toThrow();
  });
});
