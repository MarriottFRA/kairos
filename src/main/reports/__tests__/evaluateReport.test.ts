/**
 * The report engine end to end, over real databases: a scenario is written,
 * recalculated, and a built-in report evaluated against its results cache,
 * the mapping tables and a budget import — the whole path a renderer call
 * takes, minus IPC. Pins staleness, memo invalidation on recalculation and
 * on a mapping-tables sync, and the never-synced / no-import degradations.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { buildDefaultCalendar, DEFAULT_WEEKEND_MASK } from "../../../shared/calendar";
import { applyStructureColumns } from "../../blocks/schema";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { KPI_DRIVERS_SQL } from "../../kpiDrivers/schema";
import { MAPPING_TABLES_SQL } from "../../mappingTables/schema";
import { replaceAllTables } from "../../mappingTables/repo";
import { BUDGET_IMPORT_SQL } from "../../budgetImport/schema";
import { resolveOuScope } from "../../positions/ouScope";
import { batchWrite } from "../../positions/positionsRepo";
import { runRecalc } from "../../positions/runRecalc";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import { getFieldCatalog, saveScenario } from "../../positions/structureRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { POSITION_COUNT_ACCOUNT } from "../../../shared/positions/systemAccounts";
import { compileDefinition } from "../../../shared/reports/compile";
import { MAPS_FREE_STAFFING } from "../../../shared/reports/__tests__/fixtures/mapsFreeStaffingDefinition";
import { evaluateReportForScenario, listReportDefinitionSummaries } from "../evaluate";
import { getResultsSource } from "../resultsSource";
import { getMapIndex } from "../mapsIndex";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);
const SALARY_ACCOUNT = "A511000";
const STAFFING = compileDefinition(MAPS_FREE_STAFFING);

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
  structureDb.exec(MAPPING_TABLES_SQL);
  structureDb.exec(BUDGET_IMPORT_SQL);

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

const dbs = () => ({ localDb: structureDb, secureDb: valuesDb });

const recalc = (now = "2026-09-08T00:00:00.000Z") =>
  runRecalc(
    {
      localDb: structureDb,
      secureDb: valuesDb,
      getCalendar: async () => CALENDAR,
      getDefaults: async () => null,
      now: () => now,
    },
    SCOPE,
    scenarioId
  );

function seedMaps(version = "maps-1") {
  const levels = (entries: Record<string, string>) => entries;
  replaceAllTables(
    structureDb,
    {
      accountMaps: [
        { base_account: "A400100", account_description_detail_level_max: "Room revenue", ...levels({ level_6: "Revenue" }) },
        { base_account: "A420100", account_description_detail_level_max: "F&B revenue", ...levels({ level_6: "Revenue" }) },
        { base_account: SALARY_ACCOUNT, account_description_detail_level_max: "Salaries", ...levels({ level_9: "Total Payroll" }) },
      ],
      departmentMaps: [
        { base_department: "D0410", department_description_detail_level_max: "Admin", level_2: "Lodging Operations" },
        { base_department: "D0100", department_description_detail_level_max: "Rooms", level_2: "Lodging Operations" },
        { base_department: "D0200", department_description_detail_level_max: "Restaurant", level_2: "Lodging Operations" },
      ],
      combos: [],
      version,
    },
    "2026-09-01T00:00:00.000Z"
  );
}

function seedBudgetImport() {
  structureDb
    .prepare(
      `INSERT INTO budget_imports
         (id, ou, source_filename, bucket1_type, bucket1_year, bucket2_type, bucket2_year,
          imported_at, row_count)
       VALUES ('imp-1', ?, 'bst.xlsm', 'BUDGET', ?, 'ACT/FCST', ?, '2026-09-01T00:00:00.000Z', 24)`
    )
    .run(SCOPE.ou, YEAR, YEAR - 1);
  const insert = structureDb.prepare(
    `INSERT INTO budget_values
       (import_id, ou, dept, account, combo, bucket_index, bucket_type, year, period, value)
     VALUES ('imp-1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let period = 1; period <= 12; period++) {
    insert.run(SCOPE.ou, "D0100", "A400100", "0100-400100", 1, "BUDGET", YEAR, period, 40000);
    insert.run(SCOPE.ou, "D0200", "A420100", "0200-420100", 1, "BUDGET", YEAR, period, 10000);
    insert.run(SCOPE.ou, "D0100", "A400100", "0100-400100", 2, "ACT/FCST", YEAR - 1, period, 1);
  }
}

describe("evaluateReportForScenario", () => {
  it("evaluates a maps-free report straight off the results cache", async () => {
    await recalc();
    const report = evaluateReportForScenario(dbs(), SCOPE, scenarioId, STAFFING);

    expect(report.year).toBe(YEAR);
    expect(report.run).toEqual({ computedAt: "2026-09-08T00:00:00.000Z", stale: false });
    expect(report.warnings).toEqual([]);
    expect(report.bst).toEqual([]);
    const byLabel = new Map(report.rows.map((r) => [r.label, r.values]));
    // Two heads, posted as a January level and read back as a level all year.
    expect(byLabel.get("Position count")).toEqual([...new Array(12).fill(2), 2]);
    expect(report.atoms.position_count[12]).toBe(2);
    expect(report.timings.loadMs).toBeGreaterThanOrEqual(0);
  });

  it("joins the results cache, the mapping tables and the budget import", async () => {
    seedMaps();
    seedBudgetImport();
    await recalc();

    // The single-scenario reading: every unpinned atom reads the results
    // cache, so the Summary P&L's revenue (a BST figure) is zero here and
    // payroll comes from the engine run. Column evaluation is what joins the
    // BST in — see evaluateColumns.test.ts.
    const report = evaluateReportForScenario(dbs(), SCOPE, scenarioId, "summary_pl");
    expect(report.warnings).toEqual([]);
    expect(report.mappingVersion).toBe("maps-1");
    expect(report.bst).toEqual([]);

    const byLabel = new Map(report.rows.map((r) => [r.label, r.values]));
    const payroll = byLabel.get("Total Payroll")!;
    expect(payroll[0]).toBe(6000); // 2 heads × 3000
    expect(payroll[12]).toBe(72000);
    expect(byLabel.get("Total Sales")![12]).toBe(0);
    expect(report.atoms.total_payroll[12]).toBe(72000);
  });

  it("degrades with warnings when the maps were never synced", async () => {
    await recalc();
    const report = evaluateReportForScenario(dbs(), SCOPE, scenarioId, "summary_pl");
    // One warning per level atom, all the same code.
    expect([...new Set(report.warnings.map((w) => w.code))]).toEqual(["MAPS_UNAVAILABLE"]);
    expect(report.mappingVersion).toBeNull();
    const byLabel = new Map(report.rows.map((r) => [r.label, r.values]));
    expect(byLabel.get("Total Payroll")!.every((v) => v === 0)).toBe(true);
  });

  it("reports stale exactly when the Results page would", async () => {
    await recalc();
    expect(evaluateReportForScenario(dbs(), SCOPE, scenarioId, STAFFING).run?.stale).toBe(false);
    valuesDb
      .prepare(`INSERT INTO buyout_rows (id, ou, scenario_id, updated_at) VALUES ('b1', ?, ?, 'now')`)
      .run(SCOPE.ou, scenarioId);
    expect(evaluateReportForScenario(dbs(), SCOPE, scenarioId, STAFFING).run?.stale).toBe(true);
  });

  it("answers from an empty source, with a warning, for a scenario never calculated", () => {
    const report = evaluateReportForScenario(dbs(), SCOPE, scenarioId, STAFFING);
    expect(report.run).toBeNull();
    expect(report.warnings.map((w) => w.code)).toEqual(["NO_RESULTS"]);
    expect(report.rows.find((r) => r.label === "Position count")!.values!.every((v) => v === 0)).toBe(true);
  });

  it("rebuilds its in-memory source after a recalculation, and reuses it otherwise", async () => {
    await recalc("2026-09-08T00:00:00.000Z");
    const first = getResultsSource(valuesDb, SCOPE, scenarioId).source;
    expect(getResultsSource(valuesDb, SCOPE, scenarioId).source).toBe(first);

    batchWrite(
      valuesDb,
      SCOPE,
      { ou: SCOPE.ou, scenarioId, positionPatches: [{ id: "pos-1", fields: { headcount: 3 } }] },
      buildFieldMap(getFieldCatalog(structureDb, SCOPE))
    );
    await recalc("2026-09-09T00:00:00.000Z");
    const second = getResultsSource(valuesDb, SCOPE, scenarioId).source;
    expect(second).not.toBe(first);
    expect(second.get("D0410", POSITION_COUNT_ACCOUNT)!.reportVec[12]).toBe(3);
  });

  it("rebuilds the map index when the mapping tables sync a new version", () => {
    seedMaps("maps-1");
    const first = getMapIndex(structureDb);
    expect(getMapIndex(structureDb)).toBe(first);
    expect(first.version).toBe("maps-1");
    seedMaps("maps-2");
    const second = getMapIndex(structureDb);
    expect(second).not.toBe(first);
    expect(second.version).toBe("maps-2");
  });

  it("refuses an unknown report or a scenario the hotel does not have", async () => {
    await recalc();
    expect(() => evaluateReportForScenario(dbs(), SCOPE, scenarioId, "nope")).toThrow(/Unknown report/);
    expect(() => evaluateReportForScenario(dbs(), SCOPE, "not-a-scenario", STAFFING)).toThrow(
      /does not exist/
    );
  });

  it("lists the built-in definitions with the sources they read", () => {
    expect(listReportDefinitionSummaries()).toEqual([
      expect.objectContaining({ id: "summary_pl", sources: ["kairos"], params: [] }),
      expect.objectContaining({
        id: "payroll_fte_summary",
        params: expect.arrayContaining([expect.objectContaining({ id: "weekly_hours", builtin: "weekly_hours" })]),
      }),
    ]);
  });
});
