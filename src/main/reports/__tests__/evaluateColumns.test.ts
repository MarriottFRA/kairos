/**
 * Column evaluation over real databases: the three series kinds resolve an
 * atom's source as documented (bst → the bucket, plan → the overlay, kairos
 * → the cache), the drift check nudges until the BST holds the plan, pinned
 * atoms follow the scenario, the clear rules decide what the overlay drops,
 * and the built-in FTE param comes from the hotel-year setup.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { buildDefaultCalendar, DEFAULT_WEEKEND_MASK } from "../../../shared/calendar";
import {
  PositionDefaults,
  buildDefaultPositionDefaults,
  fullTimeReference,
  resolvePositionDefaults,
} from "../../../shared/positionDefaults";
import { effectiveWeekOf } from "../../../shared/positions/effectiveWeek";
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
import { readResultsCache } from "../../positions/resultsCache";
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
import type { ReportColumnSpec, SeriesColumnSpec } from "../../../shared/reports/columns";
import { DEFAULT_CLEAR_PREFIXES } from "../../../shared/bstPush/ipc";
import {
  EvaluateColumnsOptions,
  evaluateReportColumns,
  getReportDefinitionDetail,
  listAtomCombos,
} from "../evaluate";
import { evaluatePackPage, listPackPages } from "../packs";
import { getPlanSource } from "../planSource";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);
/** The effective week a contract week posts here: over the default calendar's
 *  261 productive days, with no vacation on the roster to average. */
const effectiveOf = (contractWeek: number) =>
  effectiveWeekOf(
    contractWeek,
    fullTimeReference(resolvePositionDefaults({ ...buildDefaultPositionDefaults(SCOPE.ou, YEAR), weeklyHours: contractWeek }, CALENDAR))
  ).effectiveWeek;
const SALARY_ACCOUNT = "A511000";

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
  seedMaps();
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
  replaceAllTables(
    structureDb,
    {
      accountMaps: [
        { base_account: "A400100", account_description_detail_level_max: "Room revenue", level_6: "Revenue" },
        { base_account: "A420100", account_description_detail_level_max: "F&B revenue", level_6: "Revenue" },
        { base_account: SALARY_ACCOUNT, account_description_detail_level_max: "Salaries", level_9: "Total Payroll" },
        { base_account: "A512000", account_description_detail_level_max: "Wages", level_9: "Total Payroll" },
      ],
      departmentMaps: [
        { base_department: "D0410", department_description_detail_level_max: "Admin", level_2: "Lodging Operations" },
        { base_department: "D0100", department_description_detail_level_max: "Rooms", level_2: "Lodging Operations" },
        { base_department: "D0200", department_description_detail_level_max: "Restaurant", level_2: "Lodging Operations" },
        { base_department: "D0300", department_description_detail_level_max: "Bar", level_2: "Lodging Operations" },
      ],
      combos: [],
      version,
    },
    "2026-09-01T00:00:00.000Z"
  );
}

interface BstRow {
  dept: string;
  account: string;
  bucket: 1 | 2;
  months: number[];
}

function seedBudgetImport(importId: string, extra: BstRow[] = []) {
  structureDb.prepare(`DELETE FROM budget_values`).run();
  structureDb.prepare(`DELETE FROM budget_imports`).run();
  structureDb
    .prepare(
      `INSERT INTO budget_imports
         (id, ou, source_filename, bucket1_type, bucket1_year, bucket2_type, bucket2_year,
          imported_at, row_count)
       VALUES (?, ?, 'bst.xlsm', 'BUDGET', ?, 'ACT/FCST', ?, '2026-09-01T00:00:00.000Z', 24)`
    )
    .run(importId, SCOPE.ou, YEAR, YEAR - 1);
  const insert = structureDb.prepare(
    `INSERT INTO budget_values
       (import_id, ou, dept, account, combo, bucket_index, bucket_type, year, period, value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const rows: BstRow[] = [
    { dept: "D0100", account: "A400100", bucket: 1, months: new Array(12).fill(40000) },
    { dept: "D0200", account: "A420100", bucket: 1, months: new Array(12).fill(10000) },
    { dept: "D0100", account: "A400100", bucket: 2, months: new Array(12).fill(30000) },
    ...extra,
  ];
  for (const row of rows) {
    for (let period = 1; period <= 12; period++) {
      insert.run(
        importId,
        SCOPE.ou,
        row.dept,
        row.account,
        `${row.dept.slice(1)}-${row.account.slice(1)}`,
        row.bucket,
        row.bucket === 1 ? "BUDGET" : "ACT/FCST",
        row.bucket === 1 ? YEAR : YEAR - 1,
        period,
        row.months[period - 1]
      );
    }
  }
}

/** The cache as BST rows, the way a push then a pull would leave them. */
function cacheAsBstRows(): BstRow[] {
  return readResultsCache(valuesDb, SCOPE, scenarioId).map((row) => ({
    dept: row.dept,
    account: row.account,
    bucket: 1,
    months: row.months.map((m) => (row.account.startsWith("A9") ? m : (m / 1000) * 1000)),
  }));
}

const options = (over: Partial<EvaluateColumnsOptions> = {}): EvaluateColumnsOptions => ({
  clearPrefixes: DEFAULT_CLEAR_PREFIXES,
  ...over,
});

const COLUMNS: ReportColumnSpec[] = [
  { id: "budget", series: { kind: "bst", relativeTo: "SCENARIO" } },
  { id: "plan", series: { kind: "plan", scenarioId: "SCENARIO" } },
  { id: "kairos", series: { kind: "kairos", scenarioId: "SCENARIO" } },
  { id: "ly", series: { kind: "bst", relativeTo: "SCENARIO", yearOffset: -1 } },
  { id: "v", variance: { a: "budget", b: "ly", mode: "abs" } },
];
const columns = () =>
  JSON.parse(JSON.stringify(COLUMNS).replaceAll("SCENARIO", scenarioId)) as ReportColumnSpec[];

const rowOf = (grid: { rows: { label: string }[] }, label: string) =>
  grid.rows.findIndex((r) => r.label === label);

describe("evaluateReportColumns", () => {
  it("resolves sources per series: bucket, overlay, cache", async () => {
    seedBudgetImport("imp-1");
    await recalc();
    const grid = await evaluateReportColumns(dbs(), SCOPE, "summary_pl", columns(), options());
    const sales = rowOf(grid, "Total Sales");
    const payroll = rowOf(grid, "Total Payroll");
    const [budget, plan, kairos, ly, variance] = grid.columns;

    expect(budget.values[sales]![12]).toBe(600000);
    expect(plan.values[sales]![12]).toBe(600000); // revenue is not Kairos's to overlay
    expect(kairos.values[sales]![12]).toBe(0);
    expect(ly.values[sales]![12]).toBe(360000);
    expect(variance.values[sales]![12]).toBe(240000);

    expect(budget.values[payroll]![12]).toBe(0); // the BST never received the push
    expect(plan.values[payroll]![12]).toBe(72000); // the overlay adds it
    expect(kairos.values[payroll]![12]).toBe(72000);

    expect(budget.year).toBe(YEAR);
    expect(ly.year).toBe(YEAR - 1);
    expect(budget.bst).toEqual([{ importId: "imp-1", bucketIndex: 1, bucketType: "BUDGET", year: YEAR }]);
    expect(ly.bst[0].bucketIndex).toBe(2);
    expect(budget.run).toEqual({ computedAt: "2026-09-08T00:00:00.000Z", stale: false });
    expect(ly.run?.stale).toBe(false);
    expect(variance.run).toBeNull();
    expect(grid.mappingVersion).toBe("maps-1");
  });

  it("nudges to push while the BST lacks the plan, on the budget and plan columns alike", async () => {
    seedBudgetImport("imp-1");
    await recalc();
    const before = await evaluateReportColumns(dbs(), SCOPE, "summary_pl", columns(), options());
    const [budget, plan, kairos, ly] = before.columns;
    expect(budget.drift?.onlyInPlan).toBeGreaterThan(0);
    expect(budget.drift).toEqual(plan.drift);
    expect(budget.warnings.map((w) => w.code)).toContain("PLAN_NOT_PUSHED");
    expect(plan.warnings.map((w) => w.code)).toContain("PLAN_NOT_PUSHED");
    expect(kairos.drift).toBeNull();
    expect(ly.drift).toBeNull();
    expect(ly.warnings.map((w) => w.code)).not.toContain("PLAN_NOT_PUSHED");

    // Push, pull: the new import holds the cache's rows to the unit.
    seedBudgetImport("imp-2", cacheAsBstRows());
    const after = await evaluateReportColumns(dbs(), SCOPE, "summary_pl", columns(), options());
    expect(after.columns[0].drift).toMatchObject({ differing: 0, onlyInPlan: 0, onlyInBst: 0 });
    expect(after.columns[0].warnings).toEqual([]);
    expect(after.columns[0].values[rowOf(after, "Total Payroll")]![12]).toBe(72000);
    expect(after.columns[1].values[rowOf(after, "Total Payroll")]![12]).toBe(72000);
  });

  it("drops a BST-only row the clear rules cover from the overlay, and keeps it without rules", async () => {
    seedBudgetImport("imp-1", [{ dept: "D0300", account: "A512000", bucket: 1, months: new Array(12).fill(5) }]);
    await recalc();
    const payrollOf = async (clearPrefixes: string[]) => {
      const grid = await evaluateReportColumns(dbs(), SCOPE, "summary_pl", columns(), options({ clearPrefixes }));
      const row = rowOf(grid, "Total Payroll");
      return { plan: grid.columns[1].values[row]![12], drift: grid.columns[1].drift! };
    };
    const withRules = await payrollOf(["5"]);
    expect(withRules.plan).toBe(72000);
    expect(withRules.drift.onlyInBst).toBe(1);
    const withoutRules = await payrollOf([]);
    expect(withoutRules.plan).toBe(72060);
    expect(withoutRules.drift.onlyInBst).toBe(0);
  });

  it("reads a pinned atom off relativeTo's cache, and warns when a bst column names no scenario", async () => {
    seedBudgetImport("imp-1");
    await recalc();
    const grid = await evaluateReportColumns(
      dbs(),
      SCOPE,
      compileDefinition(MAPS_FREE_STAFFING),
      [
        { id: "budget", series: { kind: "bst", relativeTo: scenarioId } },
        { id: "bare", series: { kind: "bst", year: YEAR } },
      ],
      options()
    );
    const heads = rowOf(grid, "Position count");
    expect(grid.columns[0].values[heads]![12]).toBe(2);
    // The nudge is about the scenario, not the report: it shows here too.
    expect(grid.columns[0].warnings.map((w) => w.code)).toEqual(["PLAN_NOT_PUSHED"]);
    expect(grid.columns[1].values[heads]![12]).toBe(0);
    expect(grid.columns[1].warnings.map((w) => w.code)).toEqual(["SCENARIO_MISSING"]);
    expect(grid.columns[1].run).toBeNull();
  });

  it("reads the work week off each column's D0410/A988112 row, a prior year falling back to this year's, then the setup", async () => {
    // The budget bucket reports a 38-hour week in January only; last year's
    // bucket has no such row. Nothing was recalculated, so the cache is empty.
    seedBudgetImport("imp-1", [
      { dept: "D0410", account: "A988112", bucket: 1, months: [38, ...new Array(11).fill(0)] },
    ]);
    const deps = {
      getCalendar: async () => CALENDAR,
      getPositionDefaults: async (): Promise<PositionDefaults | null> => null,
    };
    const grid = await evaluateReportColumns(dbs(), SCOPE, "payroll_fte_summary", columns(), options({ deps }));
    const hours = rowOf(grid, "Hours per FTE");
    const [budget, plan, kairos, ly] = grid.columns;
    expect(budget.weeklyHours).toEqual({ value: 38, origin: "column" });
    expect(budget.values[hours]![12]).toBeCloseTo(38 * 52);
    expect(budget.values[hours]![0]).toBeCloseTo(38 * (52 / 12));
    expect(budget.params.weekly_hours).toEqual([...new Array(12).fill(38), 38]);
    expect(budget.warnings.map((w) => w.code)).not.toContain("PARAM_DEFAULTED");
    // The overlay drops the bucket's row (a push would clear the A988 family
    // and the empty cache writes nothing back): this year's BST stands in.
    expect(plan.weeklyHours).toEqual({ value: 38, origin: "scenario_bst" });
    // A Kairos-only column with no results: this year's BST stands in.
    expect(kairos.weeklyHours).toEqual({ value: 38, origin: "scenario_bst" });
    // Last year has no row: this year's figure is reused.
    expect(ly.weeklyHours).toEqual({ value: 38, origin: "scenario_bst" });
    expect(ly.values[hours]![12]).toBeCloseTo(38 * 52);

    // A recalculation with a 36-hour contract posts the effective week (36h
    // over the calendar's productive days) into the results; the Kairos
    // column now reads its own, the BST columns keep theirs.
    const defaults: PositionDefaults = { ...buildDefaultPositionDefaults(SCOPE.ou, YEAR), weeklyHours: 36 };
    await runRecalc(
      { localDb: structureDb, secureDb: valuesDb, getCalendar: async () => CALENDAR, getDefaults: async () => defaults, now: () => "2026-09-08T00:00:00.000Z" },
      SCOPE,
      scenarioId
    );
    const after = await evaluateReportColumns(dbs(), SCOPE, "payroll_fte_summary", columns(), options({ deps }));
    expect(after.columns[2].weeklyHours).toEqual({ value: effectiveOf(36), origin: "column" });
    expect(after.columns[2].values[hours]![12]).toBeCloseTo(effectiveOf(36) * 52);
    expect(after.columns[0].weeklyHours).toEqual({ value: 38, origin: "column" });
    expect(after.columns[1].weeklyHours).toEqual({ value: effectiveOf(36), origin: "column" }); // the overlay replaces the row

    // No BST row anywhere and no results: the week is derived from the
    // scenario's positions (the same figure a run would post), with a nudge to
    // post it.
    seedBudgetImport("imp-2");
    valuesDb.prepare(`DELETE FROM engine_output_lines`).run();
    valuesDb.prepare(`DELETE FROM results_cache`).run();
    valuesDb.prepare(`DELETE FROM engine_runs`).run();
    const setupDeps = { ...deps, getPositionDefaults: async () => defaults };
    const setup = await evaluateReportColumns(dbs(), SCOPE, "payroll_fte_summary", columns().slice(0, 1), options({ deps: setupDeps }));
    expect(setup.columns[0].weeklyHours).toMatchObject({ value: effectiveOf(36), origin: "derived" });
    expect(setup.columns[0].weeklyHours!.derivation).toMatchObject({ contractWeek: 36, averageVacationDays: 0 });
    expect(setup.columns[0].values[hours]![12]).toBeCloseTo(effectiveOf(36) * 52);
    expect(setup.columns[0].warnings.map((w) => w.code)).toContain("WEEKLY_HOURS_NOT_POSTED");

    // A value typed for the report wins over every source.
    const overridden = await evaluateReportColumns(
      dbs(),
      SCOPE,
      "payroll_fte_summary",
      columns().slice(0, 1),
      options({ deps, params: { weekly_hours: 100 } })
    );
    expect(overridden.columns[0].weeklyHours).toEqual({ value: 100, origin: "override" });
    expect(overridden.columns[0].values[hours]![12]).toBe(100 * 52);
  });

  it("reports staleness per column and rebuilds the overlay after a recalculation or a new pull", async () => {
    seedBudgetImport("imp-1");
    await recalc("2026-09-08T00:00:00.000Z");
    const ref = { source: "bst" as const, bucket: { type: "BUDGET" } };
    const first = getPlanSource(dbs(), SCOPE, scenarioId, YEAR, ref, DEFAULT_CLEAR_PREFIXES).source;
    expect(getPlanSource(dbs(), SCOPE, scenarioId, YEAR, ref, DEFAULT_CLEAR_PREFIXES).source).toBe(first);

    valuesDb
      .prepare(`INSERT INTO buyout_rows (id, ou, scenario_id, updated_at) VALUES ('b1', ?, ?, 'now')`)
      .run(SCOPE.ou, scenarioId);
    const stale = await evaluateReportColumns(dbs(), SCOPE, "summary_pl", columns(), options());
    expect(stale.columns[0].run?.stale).toBe(true);
    expect(stale.columns[1].run?.stale).toBe(true);

    await recalc("2026-09-09T00:00:00.000Z");
    const second = getPlanSource(dbs(), SCOPE, scenarioId, YEAR, ref, DEFAULT_CLEAR_PREFIXES).source;
    expect(second).not.toBe(first);
    expect(second.get("D0410", POSITION_COUNT_ACCOUNT)).toBeDefined();

    seedBudgetImport("imp-2");
    const third = getPlanSource(dbs(), SCOPE, scenarioId, YEAR, ref, DEFAULT_CLEAR_PREFIXES).source;
    expect(third).not.toBe(second);
  });

  it("drills an atom down to the combos it summed under a column, with names", async () => {
    seedBudgetImport("imp-1");
    await recalc();
    const budget = columns()[0] as SeriesColumnSpec;
    const revenue = await listAtomCombos(dbs(), SCOPE, "summary_pl", "total_revenue", budget, options());
    expect(revenue.label).toMatch(/Total revenue/);
    expect(revenue.sourceId).toBe("bst:1");
    expect(revenue.combos.map((c) => [c.dept, c.account, c.deptName, c.accountName, c.values[12]])).toEqual([
      ["0100", "400100", "Rooms", "Room revenue", 480000],
      ["0200", "420100", "Restaurant", "F&B revenue", 120000],
    ]);
    expect(revenue.total[12]).toBe(600000);

    const plan = columns()[1] as SeriesColumnSpec;
    const payroll = await listAtomCombos(dbs(), SCOPE, "summary_pl", "total_payroll", plan, options());
    expect(payroll.combos).toEqual([
      expect.objectContaining({ dept: "0410", account: "511000", deptName: "Admin", accountName: "Salaries", encoding: "AMOUNT" }),
    ]);
    expect(payroll.total[12]).toBe(72000);
    expect(payroll.warnings.map((w) => w.code)).toContain("PLAN_NOT_PUSHED");

    await expect(listAtomCombos(dbs(), SCOPE, "summary_pl", "nope", budget, options())).rejects.toThrow(/Unknown atom/);
  });

  it("describes a definition with each measure's references", () => {
    const detail = getReportDefinitionDetail("summary_pl");
    expect(detail.definition.id).toBe("summary_pl");
    expect(detail.refs.gop).toEqual(["total_revenue", "gop_expenses"]);
    expect(detail.refs.gop_margin).toEqual(["gop", "total_revenue"]);
  });

  it("lays the budget pack out from the union of the columns' sources and evaluates a page", async () => {
    seedBudgetImport("imp-1");
    await recalc();
    const pack = await listPackPages(dbs(), SCOPE, columns(), options());
    // D0100/D0200 live only in the BST, D0410 only in Kairos: all three have
    // pages, by name within their (unmapped) group: Admin, Restaurant, Rooms.
    expect(pack.departments.map((d) => d.code)).toEqual(["0410", "0200", "0100"]);
    expect(pack.pages.map((p) => p.id)).toEqual([
      "summary",
      "summary_reporting",
      "total",
      "group:Unmapped departments",
      "dept:0410",
      "dept:0200",
      "dept:0100",
    ]);

    // The summary reporting page resolves its built-in params (the day
    // counts among them) through the deps, so nothing is defaulted.
    const reporting = await evaluatePackPage(dbs(), SCOPE, "summary_reporting", columns(), options());
    expect(reporting.page.kind).toBe("summary_reporting");
    expect(reporting.detail.definition.id).toBe("pack_summary_reporting");
    expect(reporting.columns.flatMap((c) => c.warnings.map((w) => w.code))).not.toContain("PARAM_DEFAULTED");
    expect(reporting.rows.filter((r) => r.type === "header").map((r) => r.label)).toEqual([
      "FINANCIAL & STATS SUMMARY",
      "UNMAPPED DEPARTMENTS",
    ]);

    const page = await evaluatePackPage(dbs(), SCOPE, "dept:0410", columns(), options());
    expect(page.page.kind).toBe("department");
    expect(page.detail.definition.id).toBe("pack_dept_0410");
    const payroll = rowOf(page, "Total Payroll");
    expect(page.columns[0].values[payroll]![12]).toBe(0); // BST column: never pushed
    expect(page.columns[1].values[payroll]![12]).toBe(72000); // plan column: the overlay
    expect(page.detail.refs.cat_Payroll).toEqual(["m_511000"]);

    const summary = await evaluatePackPage(dbs(), SCOPE, "summary", columns(), options());
    const revenue = rowOf(summary, "Revenue");
    expect(summary.columns[0].values[revenue]![12]).toBe(600000);

    await expect(evaluatePackPage(dbs(), SCOPE, "dept:9999", columns(), options())).rejects.toThrow(/no page/);
  });

  it("refuses an unknown report or a scenario the hotel does not have", async () => {
    await recalc();
    await expect(evaluateReportColumns(dbs(), SCOPE, "nope", columns(), options())).rejects.toThrow(/Unknown report/);
    await expect(
      evaluateReportColumns(dbs(), SCOPE, "summary_pl", [{ id: "x", series: { kind: "plan", scenarioId: "no" } }], options())
    ).rejects.toThrow(/does not exist/);
  });
});
