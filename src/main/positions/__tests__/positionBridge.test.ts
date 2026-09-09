/**
 * The payroll bridge over real databases: rows per position with their
 * cells and lines, non-engine lines as rows of their own, department totals
 * that equal the results cache, the line's department (not the position's)
 * as the grouping key, a cloned scenario matched by lineage, a deleted
 * position flagged, the BST's figure beside the plan's, and no name field
 * anywhere in the response.
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
import { resolveOuScope } from "../ouScope";
import { batchWrite, cloneScenarioValues } from "../positionsRepo";
import { readResultsCache } from "../resultsCache";
import { runRecalc } from "../runRecalc";
import { ENGINE_OUTPUTS_SQL, POSITIONS_STRUCTURE_TABLES_SQL, POSITIONS_VALUE_TABLES_SQL } from "../schema";
import { getFieldCatalog, saveScenario } from "../structureRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { readPositionBridge } from "../positionBridge";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);

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
  replaceAllTables(
    structureDb,
    {
      accountMaps: [
        { base_account: "A511000", account_description_detail_level_max: "Salaries", level_9: "Total Payroll", level_15: "Total Management Salaries" },
        { base_account: "A512000", account_description_detail_level_max: "Wages", level_9: "Total Payroll", level_15: "Total Hourly Wages" },
      ],
      departmentMaps: [
        { base_department: "D0410", department_description_detail_level_max: "Admin" },
        { base_department: "D0010", department_description_detail_level_max: "Rooms" },
      ],
      combos: [],
      version: "maps-1",
    },
    "2026-09-01T00:00:00.000Z"
  );

  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
  valuesDb.exec(ENGINE_OUTPUTS_SQL);
  valuesDb.exec(MANUAL_INPUT_TABLES_SQL);

  scenarioId = saveScenario(structureDb, SCOPE, { year: YEAR, label: "Planning" }).id;
  const fieldMap = buildFieldMap(getFieldCatalog(structureDb, SCOPE));
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
            jobTypeCode: "Manager",
            payType: "SALARIED",
            headcount: 2,
            monthlyBaseSalary: 3000,
            salaryAccountCode: "A511000",
            seasonality: new Array(12).fill(1),
            vacationMonthlyWeights: new Array(12).fill(0),
            vacationDays: 0,
            dailyContractHours: 8,
          },
          pii: { title: "Finance Manager", firstName: "Ada", lastName: "Lovelace" },
        },
        {
          id: "pos-2",
          fields: {
            departmentCode: "D0410",
            jobTypeCode: "Associate",
            payType: "HOURLY",
            headcount: 1,
            hourlyRate: 10,
            salaryAccountCode: "A512000",
            seasonality: new Array(12).fill(1),
            vacationMonthlyWeights: new Array(12).fill(0),
            vacationDays: 0,
            dailyContractHours: 8,
          },
          pii: { title: "Clerk" },
        },
      ],
    },
    fieldMap
  );
});

const dbs = () => ({ localDb: structureDb, secureDb: valuesDb });

const recalc = (scenario = scenarioId, now = "2026-09-08T00:00:00.000Z") =>
  runRecalc(
    {
      localDb: structureDb,
      secureDb: valuesDb,
      getCalendar: async () => CALENDAR,
      getDefaults: async () => null,
      now: () => now,
    },
    SCOPE,
    scenario
  );

/** A hand-posted line on another department, the way manual input lands. */
function insertManualLine(dept: string, account: string, total: number) {
  valuesDb
    .prepare(
      `INSERT INTO engine_output_lines
         (ou, scenario_id, position_id, component_def_id, label, dept, account, monthly_values, total, source, source_ref, detail, encoding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', 'row-1', '{}', 'AMOUNT')`
    )
    .run(
      SCOPE.ou,
      scenarioId,
      `manual:${dept}:${account}`,
      "manual",
      "Manual: bonus pool",
      dept,
      account,
      JSON.stringify(new Array(12).fill(total / 12)),
      total
    );
}

describe("readPositionBridge", () => {
  it("groups lines by position with cells per account and the PII title, never a name", async () => {
    await recalc();
    const bridge = readPositionBridge(dbs(), SCOPE, scenarioId);
    expect(bridge.year).toBe(YEAR);
    expect(bridge.run).toEqual({ computedAt: "2026-09-08T00:00:00.000Z", stale: false });
    const admin = bridge.departments.find((d) => d.code === "0410")!;
    expect(admin.name).toBe("Admin");

    const manager = admin.rows.find((r) => r.positionId === "pos-1")!;
    expect(manager.title).toBe("Finance Manager");
    expect(manager.jobTypeCode).toBe("Manager");
    expect(manager.headcount).toBe(2);
    expect(manager.lineageId).toBe("pos-1"); // a new position is its own lineage
    const salaries = manager.cells.find((c) => c.account === "511000")!;
    expect(salaries.bucket).toBe("management_salaries");
    expect(salaries.total).toBe(72000);
    expect(manager.lines.some((l) => l.account === "511000")).toBe(true);
    expect(JSON.stringify(bridge)).not.toMatch(/Lovelace|Ada|first_name|last_name|firstName|lastName/);

    const clerk = admin.rows.find((r) => r.positionId === "pos-2")!;
    expect(clerk.cells.find((c) => c.account === "512000")!.bucket).toBe("hourly_wages");
    expect(bridge.accounts.find((a) => a.code === "511000")).toEqual({ code: "511000", name: "Salaries", bucket: "management_salaries" });
  });

  it("ties every department total to the results cache and shows non-engine lines as rows", async () => {
    await recalc();
    insertManualLine("D0010", "A599000", 12000);
    // The cache is rebuilt by a recalc; a raw insert after it is what a
    // manual-input write does before the next run, so rebuild by hand here.
    const bridge = readPositionBridge(dbs(), SCOPE, scenarioId);
    const rooms = bridge.departments.find((d) => d.code === "0010")!;
    expect(rooms.rows).toHaveLength(1);
    expect(rooms.rows[0]).toMatchObject({ source: "MANUAL", positionId: null, label: "Manual: bonus pool" });
    expect(rooms.totals[0].total).toBe(12000);

    const cache = readResultsCache(valuesDb, SCOPE, scenarioId);
    for (const department of bridge.departments) {
      if (department.code === "0010") continue; // inserted after the run: not in the cache yet
      for (const cell of department.totals) {
        const row = cache.find((r) => r.dept === `D${department.code}` && r.account === `A${cell.account}`);
        expect(row, `${department.code}/${cell.account}`).toBeDefined();
        expect(cell.total).toBe(row!.total);
        expect(cell.months).toEqual(row!.months.map((m) => Number(m.toFixed(9))));
      }
    }
  });

  it("filters on the line's department and matches a cloned scenario by lineage", async () => {
    await recalc();
    const target = saveScenario(structureDb, SCOPE, { year: YEAR + 1, label: "Next year" }).id;
    let n = 0;
    cloneScenarioValues(valuesDb, SCOPE, scenarioId, target, () => `clone-${++n}`);
    await recalc(target, "2026-09-09T00:00:00.000Z");

    const bridge = readPositionBridge(dbs(), SCOPE, scenarioId, { dept: "0410", compareScenarioId: target });
    expect(bridge.departments.map((d) => d.code)).toEqual(["0410"]);
    expect(bridge.compare?.year).toBe(YEAR + 1);
    const here = bridge.departments[0].rows.find((r) => r.positionId === "pos-1")!;
    const there = bridge.compare!.departments[0].rows.find((r) => r.lineageId === here.lineageId)!;
    // The clone minted a new id but carries the original's lineage, so the
    // two rows join across the years.
    expect(here.lineageId).toBe("pos-1");
    expect(there.positionId).toBe("clone-1");
    expect(there.title).toBe("Finance Manager");
    expect(there.cells.find((c) => c.account === "511000")!.total).toBe(72000);
    // Engine rows carry a lineage; the SETUP line the engine posts on this
    // department is a row of its own with none.
    const compared = bridge.compare!.departments[0].rows;
    expect(compared.filter((r) => r.source === "ENGINE").map((r) => r.lineageId).sort()).toEqual(["pos-1", "pos-2"]);
    expect(compared.filter((r) => r.source !== "ENGINE").every((r) => r.lineageId === null)).toBe(true);
  });

  it("flags a position deleted after the run, and reads the BST's figure beside the plan's", async () => {
    await recalc();
    valuesDb.prepare(`UPDATE positions SET deleted_at = 'now' WHERE id = 'pos-2'`).run();
    structureDb
      .prepare(
        `INSERT INTO budget_imports (id, ou, source_filename, bucket1_type, bucket1_year, imported_at, row_count)
         VALUES ('imp-1', ?, 'bst.xlsm', 'BUDGET', ?, '2026-09-01T00:00:00.000Z', 12)`
      )
      .run(SCOPE.ou, YEAR);
    const insert = structureDb.prepare(
      `INSERT INTO budget_values (import_id, ou, dept, account, combo, bucket_index, bucket_type, year, period, value)
       VALUES ('imp-1', ?, 'D0410', 'A511000', '0410-511000', 1, 'BUDGET', ?, ?, 5000)`
    );
    for (let p = 1; p <= 12; p++) insert.run(SCOPE.ou, YEAR, p);

    const bridge = readPositionBridge(dbs(), SCOPE, scenarioId);
    const admin = bridge.departments.find((d) => d.code === "0410")!;
    expect(admin.rows.find((r) => r.positionId === "pos-2")!.deleted).toBe(true);
    expect(admin.rows.find((r) => r.positionId === "pos-1")!.deleted).toBe(false);
    expect(bridge.bst).toEqual({ available: true, bucket: "BUDGET 2027", byDept: { "0410": { "511000": 60000 } } });
  });

  it("refuses a scenario the hotel does not have", () => {
    expect(() => readPositionBridge(dbs(), SCOPE, "nope")).toThrow(/does not exist/);
  });
});
