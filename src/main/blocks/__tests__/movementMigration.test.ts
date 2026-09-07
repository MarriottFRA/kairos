/**
 * movement — the "upgrade, never wipe" guard for the column that lets a
 * MULTIPLIER book the movement of its result (balance → charge).
 *
 * Same contract as the collapse_months migration it is modeled on:
 *
 *   1. Applying the helper to an existing store adds the column in place and
 *      leaves every existing row's data intact (0 = book the result as is, the
 *      pre-column behaviour, so every definition keeps behaving as it did).
 *   2. A migrated store and a freshly-created one end up with the SAME schema,
 *      column order included — ALTER TABLE can only append.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { POSITIONS_STRUCTURE_TABLES_SQL } from "../../positions/schema";
import {
  applyBlocksStructureV12,
  applyCollapseMonthsColumn,
  applyCountExemptV3,
  applyMovementColumn,
  applyStructureColumns,
  applyWeekdayMaskColumn,
} from "../schema";

type Db = InstanceType<typeof Database>;

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
  // A store as it stood before movement existed: today's baseline plus every
  // earlier guarded column, but NOT the new helper.
  legacy = new Database(":memory:");
  legacy.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyBlocksStructureV12(legacy);
  applyCountExemptV3(legacy);
  applyCollapseMonthsColumn(legacy);
  applyWeekdayMaskColumn(legacy);

  // A store created today, the way applyBaselineSchema does it.
  fresh = new Database(":memory:");
  fresh.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(fresh);
});

describe("movement column", () => {
  it("adds the column to an existing store without touching existing rows", () => {
    legacy
      .prepare(
        `INSERT INTO cost_component_definitions
           (id, ou, kind, spread_method, label, account_code, increase_aware,
            sort_order, updated_at)
         VALUES ('def-1', 'OU1', 'SPREAD', 'PERCENT_OF', 'Pension', '620000', 1, 5, 'then')`
      )
      .run();

    expect(columns(legacy, "cost_component_definitions").map((c) => c.name)).not.toContain(
      "movement"
    );

    applyMovementColumn(legacy);

    const row = legacy
      .prepare(`SELECT * FROM cost_component_definitions WHERE id = 'def-1'`)
      .get() as Record<string, unknown>;
    // Data carried forward untouched; 0 means the definition keeps booking its
    // result as it is, exactly as it did before the update.
    expect(row.label).toBe("Pension");
    expect(row.account_code).toBe("620000");
    expect(row.sort_order).toBe(5);
    expect(row.updated_at).toBe("then");
    expect(row.movement).toBe(0);
  });

  it("is idempotent — re-running it is a no-op", () => {
    applyMovementColumn(legacy);
    const after = columns(legacy, "cost_component_definitions");
    expect(() => applyMovementColumn(legacy)).not.toThrow();
    expect(columns(legacy, "cost_component_definitions")).toEqual(after);
  });

  it("leaves a migrated store schema-identical to a fresh one", () => {
    applyMovementColumn(legacy);
    // A real upgraded store runs EVERY guarded helper through the baseline.
    applyStructureColumns(legacy);

    const describeColumn = (c: ColumnInfo) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
    });

    // Compared as an ORDERED list, not a set — the column must land LAST on
    // both paths, or upgraded and fresh stores diverge invisibly.
    expect(columns(legacy, "cost_component_definitions").map(describeColumn)).toEqual(
      columns(fresh, "cost_component_definitions").map(describeColumn)
    );
  });

  it("reaches a fresh install through the baseline, not just the migration", () => {
    const column = columns(fresh, "cost_component_definitions").find(
      (c) => c.name === "movement"
    );
    expect(column).toBeDefined();
    expect(column?.type).toBe("INTEGER");
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("0");
  });

  it("does nothing when the structure tables do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(() => applyMovementColumn(empty)).not.toThrow();
  });
});
