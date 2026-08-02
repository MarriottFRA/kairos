/**
 * Storage-cleanup tests — the soft-delete purge against in-memory SQLite.
 * Covers: live rows surviving, every soft-deleted category going, a deleted
 * plan taking its still-live contents with it, cross-store cleanup of values
 * whose definition is gone, the extra_values scrub for removed columns, child
 * rows following their parent, and the dry run writing nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import { applyStructureColumns } from "../../blocks/schema";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { KPI_DRIVERS_SQL } from "../../kpiDrivers/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { purgeSoftDeleted, scanSoftDeleted } from "../cleanupRepo";

type Db = InstanceType<typeof Database>;

const OU = "OU12345";
const NOW = "2026-07-27T00:00:00.000Z";
const GONE = "2026-07-20T00:00:00.000Z";

let local: Db;
let secure: Db;

beforeEach(() => {
  local = new Database(":memory:");
  local.pragma("foreign_keys = ON");
  local.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(local);
  applyHotelClustersV13(local);
  local.exec(ALLOCATIONS_SQL);
  local.exec(KPI_DRIVERS_SQL);

  secure = new Database(":memory:");
  secure.pragma("foreign_keys = ON");
  secure.exec(POSITIONS_VALUE_TABLES_SQL);
  secure.exec(ENGINE_OUTPUTS_SQL);
  secure.exec(MANUAL_INPUT_TABLES_SQL);
});

// ── Fixtures (raw inserts: this module is about rows, not write paths) ──

function addScenario(id: string, deletedAt: string | null = null) {
  local
    .prepare(
      `INSERT INTO scenarios (id, ou, year, label, updated_at, deleted_at)
       VALUES (?, ?, 2026, ?, ?, ?)`
    )
    .run(id, OU, id, NOW, deletedAt);
}

function addPosition(
  id: string,
  scenarioId: string,
  deletedAt: string | null = null,
  extraValues = "{}"
) {
  secure
    .prepare(
      `INSERT INTO positions (id, ou, scenario_id, extra_values, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, OU, scenarioId, extraValues, NOW, deletedAt);
  secure
    .prepare(
      `INSERT INTO position_pii (position_id, ou, scenario_id, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, OU, scenarioId, NOW, deletedAt);
}

function addComponentValue(
  positionId: string,
  defId: string,
  scenarioId: string,
  deletedAt: string | null = null
) {
  secure
    .prepare(
      `INSERT INTO component_values
         (position_id, component_def_id, ou, scenario_id, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(positionId, defId, OU, scenarioId, NOW, deletedAt);
}

function addDefinition(id: string, deletedAt: string | null = null) {
  local
    .prepare(
      `INSERT INTO cost_component_definitions (id, ou, kind, label, updated_at, deleted_at)
       VALUES (?, ?, 'SPREAD', ?, ?, ?)`
    )
    .run(id, OU, id, NOW, deletedAt);
}

function addField(key: string, deletedAt: string | null, origin = "USER") {
  local
    .prepare(
      `INSERT INTO field_catalog
         (ou, field_key, section, data_type, storage, origin, default_label,
          updated_at, deleted_at)
       VALUES (?, ?, 'Contract', 'NUMBER', 'EXTRA', ?, ?, ?, ?)`
    )
    .run(OU, key, origin, key, NOW, deletedAt);
}

function count(db: Db, table: string, where = "1=1"): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get() as {
      c: number;
    }
  ).c;
}

describe("purgeSoftDeleted", () => {
  it("removes soft-deleted rows and leaves live ones alone", () => {
    addScenario("plan-live");
    addPosition("pos-live", "plan-live");
    addPosition("pos-gone", "plan-live", GONE);
    addComponentValue("pos-live", "def-live", "plan-live");
    addComponentValue("pos-live", "def-x", "plan-live", GONE);

    addDefinition("def-live");
    addDefinition("def-x", GONE);
    local
      .prepare(
        `INSERT INTO block_configs (id, ou, block_type, label, updated_at, deleted_at)
         VALUES ('blk-x', ?, 'MULTIPLIER', 'Pension', ?, ?)`
      )
      .run(OU, NOW, GONE);
    addField("keepCol", null);
    addField("goneCol", GONE);
    addField("systemCol", GONE, "SYSTEM");

    const tally = purgeSoftDeleted(local, secure);

    expect(tally).toMatchObject({
      positions: 1,
      positionPii: 1,
      // The soft-deleted value, plus both values carried off by pos-gone…
      // (pos-gone has none here) — so just the one.
      componentValues: 1,
      componentDefinitions: 1,
      blocks: 1,
      fields: 1,
    });

    expect(count(secure, "positions")).toBe(1);
    expect(count(secure, "position_pii")).toBe(1);
    expect(count(secure, "component_values")).toBe(1);
    expect(count(local, "cost_component_definitions")).toBe(1);
    expect(count(local, "block_configs")).toBe(0);
    // SYSTEM catalog rows are never eligible, however they got stamped.
    expect(count(local, "field_catalog")).toBe(2);
    expect(count(local, "field_catalog", "field_key = 'systemCol'")).toBe(1);
  });

  it("takes a deleted plan's still-live contents with it", () => {
    addScenario("plan-gone", GONE);
    addScenario("plan-live");
    addPosition("pos-a", "plan-gone");
    addPosition("pos-b", "plan-gone");
    addPosition("pos-keep", "plan-live");
    addComponentValue("pos-a", "def-1", "plan-gone");
    addComponentValue("pos-keep", "def-1", "plan-live");
    secure
      .prepare(
        `INSERT INTO buyout_rows (id, ou, scenario_id, updated_at)
         VALUES ('buy-1', ?, 'plan-gone', ?)`
      )
      .run(OU, NOW);
    secure
      .prepare(
        `INSERT INTO engine_runs (ou, scenario_id, fingerprint, computed_at)
         VALUES (?, 'plan-gone', 'fp', ?)`
      )
      .run(OU, NOW);
    secure
      .prepare(
        `INSERT INTO engine_output_lines (ou, scenario_id, position_id, component_def_id)
         VALUES (?, 'plan-gone', 'pos-a', 'def-1')`
      )
      .run(OU);

    const tally = purgeSoftDeleted(local, secure);

    expect(tally).toMatchObject({
      scenarios: 1,
      positions: 2,
      positionPii: 2,
      componentValues: 1,
      buyoutRows: 1,
      engineOutputLines: 1,
    });
    expect(count(secure, "positions")).toBe(1);
    expect(count(secure, "positions", "id = 'pos-keep'")).toBe(1);
    expect(count(secure, "buyout_rows")).toBe(0);
    expect(count(secure, "engine_runs")).toBe(0);
    expect(count(local, "scenarios")).toBe(1);
  });

  it("counts a position that is both soft-deleted and inside a deleted plan once", () => {
    addScenario("plan-gone", GONE);
    addPosition("pos-both", "plan-gone", GONE);

    expect(purgeSoftDeleted(local, secure).positions).toBe(1);
  });

  it("clears encrypted values whose definition was deleted", () => {
    addScenario("plan-live");
    addPosition("pos-live", "plan-live");
    addDefinition("def-gone", GONE);
    addComponentValue("pos-live", "def-gone", "plan-live");
    addComponentValue("pos-live", "def-live", "plan-live");
    addDefinition("def-live");
    secure
      .prepare(
        `INSERT INTO engine_output_lines (ou, scenario_id, position_id, component_def_id)
         VALUES (?, 'plan-live', 'pos-live', 'def-gone')`
      )
      .run(OU);

    const tally = purgeSoftDeleted(local, secure);

    expect(tally.componentValues).toBe(1);
    expect(tally.engineOutputLines).toBe(1);
    expect(count(secure, "component_values")).toBe(1);
    expect(count(secure, "component_values", "component_def_id = 'def-live'")).toBe(1);
    // The live position itself is untouched.
    expect(count(secure, "positions")).toBe(1);
  });

  it("scrubs removed columns out of live extra_values before dropping them", () => {
    addScenario("plan-live");
    addPosition("pos-live", "plan-live", null, '{"goneCol":7,"keepCol":3}');
    addField("keepCol", null);
    addField("goneCol", GONE);

    purgeSoftDeleted(local, secure);

    const row = secure
      .prepare("SELECT extra_values FROM positions WHERE id = 'pos-live'")
      .get() as { extra_values: string };
    expect(JSON.parse(row.extra_values)).toEqual({ keepCol: 3 });
    expect(count(local, "field_catalog")).toBe(1);
  });

  it("takes child rows with their deleted parent", () => {
    local
      .prepare(
        `INSERT INTO ss_schemes (id, ou, label, updated_at, deleted_at)
         VALUES ('ss-1', ?, 'NI', ?, ?)`
      )
      .run(OU, NOW, GONE);
    local
      .prepare(
        `INSERT INTO ss_brackets (scheme_id, bracket_index, rate) VALUES ('ss-1', 0, 0.1)`
      )
      .run();

    local
      .prepare(
        `INSERT INTO kpi_drivers (id, ou, label, dept_mode, updated_at, deleted_at)
         VALUES ('kpi-1', ?, 'Covers', 'EXPLICIT', ?, ?)`
      )
      .run(OU, NOW, GONE);
    local
      .prepare(
        `INSERT INTO kpi_driver_accounts (driver_id, starts_with) VALUES ('kpi-1', 'A5')`
      )
      .run();
    local
      .prepare(
        `INSERT INTO kpi_driver_values (driver_id, ou, dept_key, period, value, computed_at)
         VALUES ('kpi-1', ?, '*', 1, 10, ?)`
      )
      .run(OU, NOW);

    local
      .prepare(
        `INSERT INTO hotel_clusters (id, name, updated_at, deleted_at)
         VALUES ('cl-1', 'Paris', ?, ?)`
      )
      .run(NOW, GONE);
    local
      .prepare(
        `INSERT INTO hotel_cluster_members (cluster_id, ou, weight) VALUES ('cl-1', ?, 0.5)`
      )
      .run(OU);

    local
      .prepare(
        `INSERT INTO allocations (id, ou, name, spread_base, updated_at, deleted_at)
         VALUES ('al-1', ?, 'Laundry', 'HEADCOUNT', ?, ?)`
      )
      .run(OU, NOW, GONE);

    // A live definition that used the deleted one as its base.
    addDefinition("def-base", GONE);
    addDefinition("def-user");
    local
      .prepare(
        `INSERT INTO component_base_refs (component_def_id, referenced_def_id, sort_order)
         VALUES ('def-user', 'def-base', 0)`
      )
      .run();

    const tally = purgeSoftDeleted(local, secure);

    expect(tally).toMatchObject({
      ssSchemes: 1,
      kpiDrivers: 1,
      hotelClusters: 1,
      allocations: 1,
      componentDefinitions: 1,
    });
    expect(count(local, "ss_brackets")).toBe(0);
    expect(count(local, "kpi_driver_accounts")).toBe(0);
    expect(count(local, "kpi_driver_values")).toBe(0);
    expect(count(local, "hotel_cluster_members")).toBe(0);
    expect(count(local, "component_base_refs")).toBe(0);
    expect(count(local, "cost_component_definitions")).toBe(1);
  });

  it("removes soft-deleted manual input and buyout rows", () => {
    secure
      .prepare(
        `INSERT INTO manual_input_rows (id, ou, created_at, updated_at, deleted_at)
         VALUES ('mi-1', ?, ?, ?, ?)`
      )
      .run(OU, NOW, NOW, GONE);
    secure
      .prepare(
        `INSERT INTO manual_input_rows (id, ou, created_at, updated_at)
         VALUES ('mi-2', ?, ?, ?)`
      )
      .run(OU, NOW, NOW);
    secure
      .prepare(
        `INSERT INTO buyout_rows (id, ou, scenario_id, updated_at, deleted_at)
         VALUES ('buy-1', ?, 'plan-live', ?, ?)`
      )
      .run(OU, NOW, GONE);

    const tally = purgeSoftDeleted(local, secure);

    expect(tally).toMatchObject({ manualInputRows: 1, buyoutRows: 1 });
    expect(count(secure, "manual_input_rows")).toBe(1);
    expect(count(secure, "buyout_rows")).toBe(0);
  });
});

describe("retention window (the automatic sweep)", () => {
  const RECENT = "2026-07-26T00:00:00.000Z"; // inside a 7-day window
  const CUTOFF = "2026-07-20T00:00:00.000Z";

  it("takes only rows deleted before the cutoff", () => {
    addScenario("plan-live");
    addPosition("pos-old", "plan-live", "2026-06-01T00:00:00.000Z");
    addPosition("pos-recent", "plan-live", RECENT);
    addPosition("pos-live", "plan-live");

    const tally = purgeSoftDeleted(local, secure, { olderThan: CUTOFF });

    expect(tally.positions).toBe(1);
    expect(count(secure, "positions", "id = 'pos-old'")).toBe(0);
    // The recent delete stays recoverable — this is the whole point of the window.
    expect(count(secure, "positions", "id = 'pos-recent'")).toBe(1);
    expect(count(secure, "positions", "id = 'pos-live'")).toBe(1);
  });

  it("leaves a recently deleted plan and its contents intact", () => {
    addScenario("plan-recent", RECENT);
    addPosition("pos-a", "plan-recent");
    addComponentValue("pos-a", "def-1", "plan-recent");

    const tally = purgeSoftDeleted(local, secure, { olderThan: CUTOFF });

    expect(tally.scenarios).toBe(0);
    expect(tally.positions).toBe(0);
    expect(count(secure, "positions")).toBe(1);
    expect(count(secure, "component_values")).toBe(1);
    expect(count(local, "scenarios")).toBe(1);
  });

  it("keeps values of a recently deleted block, and clears an old one's", () => {
    addScenario("plan-live");
    addPosition("pos-live", "plan-live");
    addDefinition("def-recent", RECENT);
    addDefinition("def-old", "2026-01-01T00:00:00.000Z");
    addComponentValue("pos-live", "def-recent", "plan-live");
    addComponentValue("pos-live", "def-old", "plan-live");

    const tally = purgeSoftDeleted(local, secure, { olderThan: CUTOFF });

    expect(tally).toMatchObject({ componentDefinitions: 1, componentValues: 1 });
    expect(count(secure, "component_values", "component_def_id = 'def-recent'")).toBe(1);
    expect(count(secure, "component_values", "component_def_id = 'def-old'")).toBe(0);
  });

  it("does not scrub a recently removed column out of live rows", () => {
    addScenario("plan-live");
    addPosition("pos-live", "plan-live", null, '{"recentCol":4,"oldCol":9}');
    addField("recentCol", RECENT);
    addField("oldCol", "2026-01-01T00:00:00.000Z");

    purgeSoftDeleted(local, secure, { olderThan: CUTOFF });

    const row = secure
      .prepare("SELECT extra_values FROM positions WHERE id = 'pos-live'")
      .get() as { extra_values: string };
    // Still restorable, values and all.
    expect(JSON.parse(row.extra_values)).toEqual({ recentCol: 4 });
    expect(count(local, "field_catalog", "field_key = 'recentCol'")).toBe(1);
    expect(count(local, "field_catalog", "field_key = 'oldCol'")).toBe(0);
  });
});

describe("scanSoftDeleted", () => {
  it("reports exactly what a purge removes, without writing anything", () => {
    addScenario("plan-gone", GONE);
    addScenario("plan-live");
    addPosition("pos-a", "plan-gone");
    addPosition("pos-gone", "plan-live", GONE);
    addPosition("pos-live", "plan-live", null, '{"goneCol":1}');
    addComponentValue("pos-live", "def-gone", "plan-live");
    addDefinition("def-gone", GONE);
    addField("goneCol", GONE);

    const scan = scanSoftDeleted(local, secure);

    // Nothing moved.
    expect(count(secure, "positions")).toBe(3);
    expect(count(secure, "component_values")).toBe(1);
    expect(count(local, "scenarios")).toBe(2);
    expect(count(local, "field_catalog")).toBe(1);
    const preserved = secure
      .prepare("SELECT extra_values FROM positions WHERE id = 'pos-live'")
      .get() as { extra_values: string };
    expect(JSON.parse(preserved.extra_values)).toEqual({ goneCol: 1 });

    // …and the preview matches the real thing, row for row.
    expect(purgeSoftDeleted(local, secure)).toEqual(scan);
  });

  it("returns an all-zero tally on a clean install", () => {
    addScenario("plan-live");
    addPosition("pos-live", "plan-live");

    const scan = scanSoftDeleted(local, secure);
    expect(Object.values(scan).every((value) => value === 0)).toBe(true);
  });
});
