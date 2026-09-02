/**
 * collapse_months — the "upgrade, never wipe" guard for the column that lets a
 * MULTIPLIER land its yearly result in chosen months.
 *
 * Same contract as the count_exempt migration it is modeled on:
 *
 *   1. Applying the helper to an existing store adds the column in place and
 *      leaves every existing row's data intact (NULL = spread with the base,
 *      the pre-column behaviour, so every definition keeps behaving as it did).
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
  applyStructureColumns,
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
  // A store as it stood before collapse_months existed: today's baseline plus
  // the earlier guarded columns, but NOT the new helper.
  legacy = new Database(":memory:");
  legacy.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyBlocksStructureV12(legacy);
  applyCountExemptV3(legacy);

  // A store created today, the way applyBaselineSchema does it.
  fresh = new Database(":memory:");
  fresh.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(fresh);
});

describe("collapse_months column", () => {
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
      "collapse_months"
    );

    applyCollapseMonthsColumn(legacy);

    const row = legacy
      .prepare(`SELECT * FROM cost_component_definitions WHERE id = 'def-1'`)
      .get() as Record<string, unknown>;
    // Data carried forward untouched; NULL means the definition keeps
    // spreading with its base exactly as it did before the update.
    expect(row.label).toBe("Pension");
    expect(row.account_code).toBe("620000");
    expect(row.sort_order).toBe(5);
    expect(row.updated_at).toBe("then");
    expect(row.collapse_months).toBeNull();
  });

  it("is idempotent — re-running it is a no-op", () => {
    applyCollapseMonthsColumn(legacy);
    const after = columns(legacy, "cost_component_definitions");
    expect(() => applyCollapseMonthsColumn(legacy)).not.toThrow();
    expect(columns(legacy, "cost_component_definitions")).toEqual(after);
  });

  it("leaves a migrated store schema-identical to a fresh one", () => {
    applyCollapseMonthsColumn(legacy);
    // A real upgraded store runs EVERY guarded helper through the baseline,
    // so columns added after this one (weekday_mask) land on it too.
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
      (c) => c.name === "collapse_months"
    );
    expect(column).toBeDefined();
    expect(column?.type).toBe("TEXT");
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();
  });

  it("does nothing when the structure tables do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(() => applyCollapseMonthsColumn(empty)).not.toThrow();
  });
});
