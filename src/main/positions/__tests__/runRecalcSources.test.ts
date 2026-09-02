/**
 * runRecalc, end to end, over real databases.
 * -----------------------------------------------------------
 * The projectors are unit-tested next door; this pins the WIRING, which is the
 * part that can silently do nothing. runRecalc is where the five sources are
 * assembled, and a manual row or an allocation that never gets read produces no
 * error at all — just a budget quietly missing a chunk of itself, and a BST
 * push that agrees with it.
 *
 * It also pins the two invariants the whole design rests on:
 *   - the engine is not involved in the extra sources (they arrive through the
 *     same dept x account rows without a single engine change), and
 *   - buyouts, which the compiler already sums into its in-memory aggregate,
 *     are counted exactly ONCE in the persisted output.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { buildDefaultCalendar, DEFAULT_WEEKEND_MASK } from "../../../shared/calendar";
import { applyStructureColumns } from "../../blocks/schema";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { saveAllocation } from "../../allocations/repo";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { saveRow as saveManualRow } from "../../manualInput/repo";
import { KPI_DRIVERS_SQL } from "../../kpiDrivers/schema";
import { resolveOuScope } from "../ouScope";
import { batchWrite } from "../positionsRepo";
import { runRecalc } from "../runRecalc";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../schema";
import { getFieldCatalog, saveScenario } from "../structureRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import {
  PositionDefaults,
  buildDefaultPositionDefaults,
} from "../../../shared/positionDefaults";
import {
  WEEKLY_HOURS_STAT_ACCOUNT,
  WEEKLY_HOURS_STAT_DEPARTMENT,
} from "../../../shared/positions/systemAccounts";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const NOW = "2026-07-28T00:00:00.000Z";
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);

const SALARY_ACCOUNT = "A511000";
const MANUAL_COST_ACCOUNT = "A500100";
const ALLOC_ACCOUNT = "A975010";

let structureDb: Db;
let valuesDb: Db;
let scenarioId: string;

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(structureDb);
  applyHotelClustersV13(structureDb);
  structureDb.exec(ALLOCATIONS_SQL);
  structureDb.exec(KPI_DRIVERS_SQL);

  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
  valuesDb.exec(ENGINE_OUTPUTS_SQL);
  valuesDb.exec(MANUAL_INPUT_TABLES_SQL);

  scenarioId = saveScenario(structureDb, SCOPE, { year: YEAR, label: "Planning" }).id;

  batchWrite(
    valuesDb,
    SCOPE,
    {
      ou: SCOPE.ou,
      scenarioId,
      creates: [
        {
          id: "pos-1",
          fields: {
            departmentCode: "D0410",
            jobTypeCode: "MGR",
            payType: "SALARIED",
            headcount: 2,
            monthlyBaseSalary: 3000,
            salaryAccountCode: SALARY_ACCOUNT,
            seasonality: new Array(12).fill(1),
            vacationMonthlyWeights: new Array(12).fill(0),
            vacationDays: 0,
            dailyContractHours: 8,
          },
        },
      ],
    },
    buildFieldMap(getFieldCatalog(structureDb, SCOPE))
  );
});

const recalc = () =>
  runRecalc(
    {
      localDb: structureDb,
      secureDb: valuesDb,
      getCalendar: async () => CALENDAR,
      getDefaults: async () => null,
      now: () => NOW,
    },
    SCOPE,
    scenarioId
  );

function addManualRow() {
  saveManualRow(valuesDb, {
    id: "man-1",
    ou: SCOPE.ou,
    scenarioId,
    description: "Agency labour",
    department: "Front Office",
    departmentCode: "D0410",
    costAccount: MANUAL_COST_ACCOUNT,
    statsAccount: "",
    rate: null,
    statsKpiDriverId: null,
    statsKpiDivisor: null,
    statsKpiFactor: null,
    stats: new Array(12).fill(0),
    amounts: new Array(12).fill(250),
    spreadMode: null,
    spreadBaseStats: null,
    spreadBaseAmount: null,
    increasePct: 0,
    increaseMonth: 13,
    sortOrder: 0,
    createdBy: null,
    now: NOW,
  });
}

const MANUAL_STATS_ACCOUNT = "A988150";

/** A manual row whose hours come from kpi-1: 20 units per 50,000, priced at 15.5. */
function addKpiManualRow() {
  saveManualRow(valuesDb, {
    id: "man-kpi",
    ou: SCOPE.ou,
    scenarioId,
    description: "Banqueting casuals",
    department: "Banqueting",
    departmentCode: "D0410",
    costAccount: MANUAL_COST_ACCOUNT,
    statsAccount: MANUAL_STATS_ACCOUNT,
    rate: 15.5,
    statsKpiDriverId: "kpi-1",
    statsKpiDivisor: 50000,
    statsKpiFactor: 20,
    stats: new Array(12).fill(5), // the stored snapshot — distinct from anything derived
    amounts: new Array(12).fill(0),
    spreadMode: null,
    spreadBaseStats: null,
    spreadBaseAmount: null,
    increasePct: 0,
    increaseMonth: 13,
    sortOrder: 0,
    createdBy: null,
    now: NOW,
  });
}

function addKpiDriver(deptMode: "EXPLICIT" | "POSITION" = "EXPLICIT") {
  structureDb
    .prepare(
      `INSERT INTO kpi_drivers (id, ou, label, dept_mode, updated_at)
       VALUES ('kpi-1', ?, 'Banqueting Revenue', ?, ?)`
    )
    .run(SCOPE.ou, deptMode, NOW);
}

function writeKpiSeries(deptKey: string, value: number) {
  const stmt = structureDb.prepare(
    `INSERT INTO kpi_driver_values (driver_id, ou, dept_key, period, value, computed_at)
     VALUES ('kpi-1', ?, ?, ?, ?, ?)
     ON CONFLICT (driver_id, ou, dept_key, period) DO UPDATE SET
       value = excluded.value, computed_at = excluded.computed_at`
  );
  for (let period = 1; period <= 12; period++) {
    stmt.run(SCOPE.ou, deptKey, period, value, NOW);
  }
}

function addAllocation() {
  saveAllocation(
    structureDb,
    SCOPE,
    {
      name: "Laundry",
      spreadBase: "FLAT",
      excludedDepartments: [],
      injectAccount: ALLOC_ACCOUNT,
    },
    { now: NOW }
  );
}

function addBuyout() {
  valuesDb
    .prepare(
      `INSERT INTO buyout_rows (id, ou, scenario_id, department_code, account_code,
         monthly_values, updated_at) VALUES (?, ?, ?, 'D0410', ?, ?, ?)`
    )
    .run(
      "buy-1",
      SCOPE.ou,
      scenarioId,
      MANUAL_COST_ACCOUNT,
      JSON.stringify(new Array(12).fill(40)),
      NOW
    );
}

const rowFor = (
  outputs: Awaited<ReturnType<typeof recalc>>,
  dept: string,
  account: string
) => outputs.rows.find((row) => row.dept === dept && row.account === account);

describe("runRecalc assembles every source", () => {
  it("still produces the engine's own rows when nothing else is configured", async () => {
    const outputs = await recalc();
    const salary = rowFor(outputs, "D0410", SALARY_ACCOUNT)!;
    // 2 heads x 3000, twelve months.
    expect(salary.months[0]).toBe(6000);
    expect(salary.sources).toEqual(["ENGINE"]);
  });

  it("picks up manual input rows for this scenario", async () => {
    addManualRow();
    const outputs = await recalc();
    const manual = rowFor(outputs, "D0410", MANUAL_COST_ACCOUNT)!;
    expect(manual.months).toEqual(new Array(12).fill(250));
    expect(manual.sources).toEqual(["MANUAL"]);
  });

  it("ignores manual rows belonging to another scenario", async () => {
    addManualRow();
    valuesDb
      .prepare(`UPDATE manual_input_rows SET scenario_id = 'other' WHERE id = 'man-1'`)
      .run();
    const outputs = await recalc();
    expect(rowFor(outputs, "D0410", MANUAL_COST_ACCOUNT)).toBeUndefined();
  });

  it("posts allocation splits as percentages, in January only", async () => {
    addAllocation();
    const outputs = await recalc();
    const alloc = rowFor(outputs, "D0410", ALLOC_ACCOUNT)!;
    // One department in the scenario, so it carries the whole share: 100, not
    // 1, and loaded once — the BST reads a split as the running sum.
    expect(alloc.months).toEqual([100, ...new Array(11).fill(0)]);
    expect(alloc.total).toBe(100);
    expect(alloc.sources).toEqual(["ALLOCATION"]);
    expect(alloc.valueKind).toBe("percent");
  });

  it("posts the position count as a January level, without touching the engine", async () => {
    const outputs = await recalc();
    const heads = outputs.rows.find((row) => row.isStats)!;
    // Two heads, active all year — one load in January, nothing after it.
    expect(heads.months).toEqual([2, ...new Array(11).fill(0)]);
    expect(heads.sources).toEqual(["ENGINE"]);
  });

  it("reports the hotel's Weekly Hours as a January statistic", async () => {
    const outputs = await recalc();
    const weekly = rowFor(
      outputs,
      WEEKLY_HOURS_STAT_DEPARTMENT,
      WEEKLY_HOURS_STAT_ACCOUNT
    )!;
    // getDefaults returns null here — an untouched hotel — so this is the
    // built-in 40 the Home page would be showing. The page and the budget must
    // report the same contract, so "never saved" is not "nothing to report".
    expect(weekly.months).toEqual([40, ...new Array(11).fill(0)]);
    expect(weekly.total).toBe(40);
    expect(weekly.sources).toEqual(["SETUP"]);
    // A988… is inside the stats range, so it belongs under the Statistics
    // toggle and pushes to the BST in hours, not thousands of hours.
    expect(weekly.isStats).toBe(true);
    expect(weekly.valueKind).toBe("count");
  });

  it("reports a saved Weekly Hours over the built-in default", async () => {
    const outputs = await runRecalc(
      {
        localDb: structureDb,
        secureDb: valuesDb,
        getCalendar: async () => CALENDAR,
        getDefaults: async () =>
          ({
            ...buildDefaultPositionDefaults(SCOPE.ou, YEAR),
            weeklyHours: 37.5,
          }) as PositionDefaults,
        now: () => NOW,
      },
      SCOPE,
      scenarioId
    );

    expect(
      rowFor(outputs, WEEKLY_HOURS_STAT_DEPARTMENT, WEEKLY_HOURS_STAT_ACCOUNT)!
        .months
    ).toEqual([37.5, ...new Array(11).fill(0)]);
  });

  it("counts a buyout exactly once, despite the compiler also aggregating it", async () => {
    addBuyout();
    const outputs = await recalc();
    const buyout = rowFor(outputs, "D0410", MANUAL_COST_ACCOUNT)!;
    // 40, not 80: the engine's in-memory aggregate is not what gets persisted.
    expect(buyout.months).toEqual(new Array(12).fill(40));
    expect(buyout.sources).toEqual(["BUYOUT"]);
  });

  it("merges sources that land on the same dept x account", async () => {
    addManualRow();
    addBuyout();
    const outputs = await recalc();
    const merged = rowFor(outputs, "D0410", MANUAL_COST_ACCOUNT)!;
    expect(merged.months).toEqual(new Array(12).fill(290));
    expect(merged.sources).toEqual(["MANUAL", "BUYOUT"]);
  });

  it("writes a run whose line count covers every source", async () => {
    addManualRow();
    addAllocation();
    addBuyout();
    const outputs = await recalc();

    const persisted = valuesDb
      .prepare(
        `SELECT source, COUNT(*) AS n FROM engine_output_lines
          WHERE ou = ? AND scenario_id = ? GROUP BY source ORDER BY source`
      )
      .all(SCOPE.ou, scenarioId) as Array<{ source: string; n: number }>;

    expect(persisted.map((row) => row.source)).toEqual([
      "ALLOCATION",
      "BUYOUT",
      "ENGINE",
      "MANUAL",
      "SETUP",
    ]);
    expect(outputs.run?.lineCount).toBe(
      persisted.reduce((sum, row) => sum + row.n, 0)
    );
  });

  it("is repeatable — a second run replaces the first, it does not double it", async () => {
    addManualRow();
    addAllocation();
    addBuyout();
    const first = await recalc();
    const second = await recalc();
    expect(second.rows).toEqual(first.rows);
    expect(second.run?.lineCount).toBe(first.run?.lineCount);
  });

  it("reports itself fresh right after a run, and stale once a source changes", async () => {
    addManualRow();
    expect((await recalc()).stale).toBe(false);

    valuesDb
      .prepare(`UPDATE manual_input_rows SET updated_at = ? WHERE id = 'man-1'`)
      .run("2026-07-29T00:00:00.000Z");

    // Re-read without recalculating: the stored run is now out of date.
    const { readOutputs } = await import("../outputsRepo");
    expect(readOutputs(structureDb, valuesDb, SCOPE, scenarioId).stale).toBe(true);
  });
});

describe("KPI-driven manual stats", () => {
  it("derives hours from the driver's series and prices them through the rate", async () => {
    addKpiDriver();
    writeKpiSeries("*", 100000);
    addKpiManualRow();
    const outputs = await recalc();
    // 100,000 / 50,000 × 20 = 40 hours a month on the stats side…
    const hours = rowFor(outputs, "D0410", MANUAL_STATS_ACCOUNT)!;
    expect(hours.months).toEqual(new Array(12).fill(40));
    expect(hours.sources).toEqual(["MANUAL"]);
    // …and 40 × 15.5 on the cost side — the existing rate rule, fed the
    // derived stats, with no engine involvement.
    const cost = rowFor(outputs, "D0410", MANUAL_COST_ACCOUNT)!;
    expect(cost.months).toEqual(new Array(12).fill(620));
    expect(cost.sources).toEqual(["MANUAL"]);
  });

  it("follows a rewritten series on the next recalc — the budget-pull path", async () => {
    addKpiDriver();
    writeKpiSeries("*", 100000);
    addKpiManualRow();
    await recalc();

    // A fresh budget pull rewrites the cache (recomputeAllForOu); the row
    // itself is untouched, yet the next run must carry the new revenue.
    writeKpiSeries("*", 150000);
    const outputs = await recalc();
    expect(rowFor(outputs, "D0410", MANUAL_STATS_ACCOUNT)!.months).toEqual(
      new Array(12).fill(60)
    );
    expect(rowFor(outputs, "D0410", MANUAL_COST_ACCOUNT)!.months).toEqual(
      new Array(12).fill(930)
    );
  });

  it("falls back to the stored snapshot when the driver no longer exists", async () => {
    addKpiManualRow(); // references kpi-1, which was never created
    const outputs = await recalc();
    expect(rowFor(outputs, "D0410", MANUAL_STATS_ACCOUNT)!.months).toEqual(
      new Array(12).fill(5)
    );
    expect(rowFor(outputs, "D0410", MANUAL_COST_ACCOUNT)!.months).toEqual(
      new Array(12).fill(77.5) // 5 × 15.5 — the snapshot priced through the rate
    );
  });

  it("resolves a POSITION-mode driver to zeros when no series matches the department", async () => {
    addKpiDriver("POSITION");
    writeKpiSeries("D0500", 100000); // another department's series only
    addKpiManualRow(); // departmentCode D0410
    const outputs = await recalc();
    expect(rowFor(outputs, "D0410", MANUAL_STATS_ACCOUNT)!.months).toEqual(
      new Array(12).fill(0)
    );
  });
});
