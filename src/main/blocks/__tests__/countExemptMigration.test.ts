/**
 * Migration v3 (count_exempt) — the "upgrade, never wipe" guard.
 *
 * The tool is published, so an update has to carry an existing store forward
 * rather than rebuild it. Two things have to hold, and both are easy to break
 * by touching only one side:
 *
 *   1. Applying the migration to a PRE-v3 store adds the column in place and
 *      leaves every existing row's data intact.
 *   2. A migrated store and a freshly-created one end up with the SAME schema.
 *      The column has to be written twice — once in the baseline DDL, once in
 *      the migration — and a half-done dual-write silently produces two
 *      different shapes in the wild.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { POSITIONS_STRUCTURE_TABLES_SQL } from "../../positions/schema";
import {
  applyBlocksStructureV12,
  applyCountExemptV3,
  applyStructureColumns,
} from "../schema";

type Db = InstanceType<typeof Database>;

/**
 * cost_component_definitions exactly as it stood before v3 — i.e. the shipped
 * baseline with the count_exempt column removed. Frozen on purpose: it models a
 * real installed store, so it must NOT be rebuilt from the current constant.
 */
const PRE_V3_DEFINITIONS_SQL = `
  CREATE TABLE cost_component_definitions (
      id TEXT PRIMARY KEY,
      ou TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN
        ('BASE_SALARY','HOLIDAY_ACCRUAL','SPREAD','SOCIAL_SECURITY','STAT')),
      spread_method TEXT,
      stat_kind TEXT,
      label TEXT NOT NULL,
      account_code TEXT NOT NULL DEFAULT '',
      department_mode TEXT NOT NULL DEFAULT 'POSITION'
        CHECK (department_mode IN ('POSITION','FIXED')),
      fixed_department TEXT,
      increase_aware INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      base_selector_kind TEXT
        CHECK (base_selector_kind IN ('BASE_SALARY','COMPONENTS')),
      ss_scheme_id TEXT,
      kpi_driver_id TEXT,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
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
  // A store that predates v3: the old table shape, then the v12 block columns.
  legacy = new Database(":memory:");
  legacy.exec(PRE_V3_DEFINITIONS_SQL);
  applyBlocksStructureV12(legacy);

  // A store created today, the way applyBaselineSchema does it.
  fresh = new Database(":memory:");
  fresh.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(fresh);
});

describe("migration v3 — count_exempt", () => {
  it("adds the column to a pre-v3 store without touching existing rows", () => {
    legacy
      .prepare(
        `INSERT INTO cost_component_definitions
           (id, ou, kind, spread_method, label, account_code, increase_aware,
            sort_order, updated_at)
         VALUES ('def-1', 'OU1', 'SPREAD', 'PERCENT_OF', 'Pension', '620000', 1, 5, 'then')`
      )
      .run();

    expect(columns(legacy, "cost_component_definitions").map((c) => c.name)).not.toContain(
      "count_exempt"
    );

    applyCountExemptV3(legacy);

    const row = legacy
      .prepare(`SELECT * FROM cost_component_definitions WHERE id = 'def-1'`)
      .get() as Record<string, unknown>;
    // Data carried forward untouched, and the new flag defaults to "off" so the
    // definition keeps behaving exactly as it did before the update.
    expect(row.label).toBe("Pension");
    expect(row.account_code).toBe("620000");
    expect(row.increase_aware).toBe(1);
    expect(row.sort_order).toBe(5);
    expect(row.updated_at).toBe("then");
    expect(row.count_exempt).toBe(0);
  });

  it("is idempotent — re-running it is a no-op", () => {
    applyCountExemptV3(legacy);
    const after = columns(legacy, "cost_component_definitions");
    expect(() => applyCountExemptV3(legacy)).not.toThrow();
    expect(columns(legacy, "cost_component_definitions")).toEqual(after);
  });

  it("leaves a migrated store schema-identical to a fresh one", () => {
    applyCountExemptV3(legacy);
    // A real upgraded store runs EVERY guarded helper through the baseline,
    // so columns added after v3 (collapse_months) land on it too.
    applyStructureColumns(legacy);

    const describeColumn = (c: ColumnInfo) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
    });

    // Compared as an ORDERED list, not a set: this is what caught the column
    // landing in a different position on fresh installs than on upgraded ones.
    expect(columns(legacy, "cost_component_definitions").map(describeColumn)).toEqual(
      columns(fresh, "cost_component_definitions").map(describeColumn)
    );
  });

  it("reaches a fresh install through the baseline, not just the migration", () => {
    // A rebuilt database must not lose the column — Danger Zone → Rebuild
    // database re-runs the baseline, which is why it calls the helper too.
    const column = columns(fresh, "cost_component_definitions").find(
      (c) => c.name === "count_exempt"
    );
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("0");
  });

  it("does nothing when the structure tables do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(() => applyCountExemptV3(empty)).not.toThrow();
  });
});
