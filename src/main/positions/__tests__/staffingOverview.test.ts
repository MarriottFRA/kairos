/**
 * The staffing overview over real databases: positions rolled up by the
 * mapping table's group and their title, heads and FTE per classification
 * with the FTE the engine derives, an inactive position left out, the
 * Standard Title mode, a cloned scenario compared with zero variance, the
 * run info before and after a calculation, and no name field anywhere.
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
import { runRecalc } from "../runRecalc";
import { ENGINE_OUTPUTS_SQL, POSITIONS_STRUCTURE_TABLES_SQL, POSITIONS_VALUE_TABLES_SQL } from "../schema";
import { getFieldCatalog, saveScenario } from "../structureRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { loadScenarioInput } from "../loadScenarioInput";
import { readStaffingOverview } from "../staffingOverview";
import { UNMAPPED_GROUP } from "../../../shared/reports/packs";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);
const DEPS = { getCalendar: async () => CALENDAR, getPositionDefaults: async (): Promise<null> => null };

let structureDb: Db;
let valuesDb: Db;
let scenarioId: string;

const contract = {
  seasonality: new Array(12).fill(1),
  vacationMonthlyWeights: new Array(12).fill(0),
  vacationDays: 0,
  dailyContractHours: 8,
};

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
        { base_department: "D0410", department_description_detail_level_max: "Admin", level_7: "Administrative & General" },
        { base_department: "D0010", department_description_detail_level_max: "Rooms", level_7: "Rooms and Reservation" },
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
          fields: { departmentCode: "D0410", jobTypeCode: "Manager", payType: "SALARIED", headcount: 2, monthlyBaseSalary: 3000, salaryAccountCode: "A511000", ...contract },
          pii: { title: "Finance Manager", firstName: "Ada", lastName: "Lovelace" },
        },
        {
          id: "pos-2",
          fields: { departmentCode: "D0410", jobTypeCode: "Associate", payType: "HOURLY", headcount: 1, hourlyRate: 10, salaryAccountCode: "A512000", standardJobTitle: "Accounting Clerk", ...contract },
          pii: { title: "Clerk" },
        },
        {
          id: "pos-3",
          fields: { departmentCode: "D0010", jobTypeCode: "Casual", payType: "HOURLY", headcount: 3, hourlyRate: 8, salaryAccountCode: "A512000", ...contract },
          pii: { title: "Porter" },
        },
        {
          id: "pos-4",
          fields: { departmentCode: "D0010", jobTypeCode: "Supervisor", payType: "SALARIED", headcount: 1, monthlyBaseSalary: 2000, salaryAccountCode: "A511000", active: false, ...contract },
          pii: { title: "Night Supervisor" },
        },
        {
          id: "pos-5",
          fields: { departmentCode: "D0999", jobTypeCode: "Supervisor", payType: "SALARIED", headcount: 1, monthlyBaseSalary: 2000, salaryAccountCode: "A511000", ...contract },
          pii: { title: "Gardener" },
        },
      ],
    },
    fieldMap
  );
});

const dbs = () => ({ localDb: structureDb, secureDb: valuesDb });

const recalc = (scenario = scenarioId, now = "2026-09-08T00:00:00.000Z") =>
  runRecalc(
    { localDb: structureDb, secureDb: valuesDb, getCalendar: async () => CALENDAR, getDefaults: async () => null, now: () => now },
    SCOPE,
    scenario
  );

describe("readStaffingOverview", () => {
  it("rolls active positions up by the map's group and their title, heads and the engine's FTE per classification", async () => {
    const overview = await readStaffingOverview(dbs(), SCOPE, scenarioId, {}, DEPS);
    expect(overview.year).toBe(YEAR);
    expect(overview.run).toBeNull();
    expect(overview.titleMode).toBe("title");
    expect(overview.groups.map((g) => g.label)).toEqual(["Rooms and Reservation", "Administrative & General", UNMAPPED_GROUP]);
    expect(overview.unmappedDepartments).toEqual(["0999"]);

    const rooms = overview.groups[0];
    expect(rooms.rows.map((r) => r.title)).toEqual(["Porter"]); // the inactive supervisor is not budgeted
    expect(rooms.rows[0].cells.hc).toEqual({ mgr: 0, svsr: 0, assoc: 0, casual: 3 });

    const admin = overview.groups[1];
    expect(admin.rows.map((r) => r.title)).toEqual(["Clerk", "Finance Manager"]);
    const manager = admin.rows[1];
    expect(manager.cells.hc.mgr).toBe(2);
    const input = await loadScenarioInput(structureDb, valuesDb, SCOPE, scenarioId, DEPS.getCalendar, DEPS.getPositionDefaults);
    const derived = input.positions.find((p) => p.id === "pos-1")!.fte;
    expect(derived).toBeGreaterThan(0);
    expect(manager.cells.fte.mgr).toBeCloseTo(derived * 2);
    expect(admin.totals.hc).toEqual({ mgr: 2, svsr: 0, assoc: 1, casual: 0 });
    expect(overview.totals.hc).toEqual({ mgr: 2, svsr: 1, assoc: 1, casual: 3 });
    expect(manager.compare).toBeNull();
    expect(overview.compare).toBeNull();
    expect(JSON.stringify(overview)).not.toMatch(/Lovelace|Ada|first_name|last_name|firstName|lastName/);
  });

  it("rolls up by the Standard Title when asked, falling back to the typed title", async () => {
    const overview = await readStaffingOverview(dbs(), SCOPE, scenarioId, { titleMode: "standard" }, DEPS);
    const admin = overview.groups.find((g) => g.label === "Administrative & General")!;
    expect(admin.rows.map((r) => r.title)).toEqual(["Accounting Clerk", "Finance Manager"]);
  });

  it("compares a cloned scenario with zero variance and reports the run info once calculated", async () => {
    await recalc();
    const target = saveScenario(structureDb, SCOPE, { year: YEAR + 1, label: "Next year" }).id;
    let n = 0;
    cloneScenarioValues(valuesDb, SCOPE, scenarioId, target, () => `clone-${++n}`);

    const overview = await readStaffingOverview(dbs(), SCOPE, scenarioId, { compareScenarioId: target }, DEPS);
    expect(overview.run).toEqual({ computedAt: "2026-09-08T00:00:00.000Z", stale: false });
    expect(overview.compare).toEqual({ scenarioId: target, year: YEAR + 1, run: null });
    for (const group of overview.groups) {
      for (const row of group.rows) {
        expect(row.compare).toEqual(row.cells);
        expect(row.variance!.hc).toEqual({ mgr: 0, svsr: 0, assoc: 0, casual: 0 });
      }
    }
    expect(overview.varianceTotals!.hc).toEqual({ mgr: 0, svsr: 0, assoc: 0, casual: 0 });
    expect(overview.compareTotals!.hc).toEqual(overview.totals.hc);
  });

  it("refuses a scenario the hotel does not have", async () => {
    await expect(readStaffingOverview(dbs(), SCOPE, "nope", {}, DEPS)).rejects.toThrow(/does not exist/);
  });
});
