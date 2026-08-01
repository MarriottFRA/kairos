/**
 * runRecalc, end to end, over real databases.
 * -----------------------------------------------------------
 * The projectors are unit-tested next door; this pins the WIRING, which is the
 * part that can silently do nothing. runRecalc is where the four sources are
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
import { applyBlocksStructureV12 } from "../../blocks/schema";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { saveAllocation } from "../../allocations/repo";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { saveRow as saveManualRow } from "../../manualInput/repo";
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
  applyBlocksStructureV12(structureDb);
  applyHotelClustersV13(structureDb);
  structureDb.exec(ALLOCATIONS_SQL);

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
