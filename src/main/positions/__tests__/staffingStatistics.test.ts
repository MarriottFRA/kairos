/**
 * The staffing statistics over real databases, after a run: the hotel's
 * hours are the results cache's, its FTE is the FTE reconciliation's
 * account side, departments group by level 10, positions sit under the
 * department their lines post to, and a department where a supervisor and an
 * associate share the hours account — or a manager's hours drive FTE — is
 * flagged. No name anywhere.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { buildDefaultCalendar, DEFAULT_WEEKEND_MASK } from "../../../shared/calendar";
import { PositionDefaults, buildDefaultPositionDefaults } from "../../../shared/positionDefaults";
import { DEFAULT_CLEAR_PREFIXES } from "../../../shared/bstPush/ipc";
import { applyStructureColumns } from "../../blocks/schema";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { KPI_DRIVERS_SQL } from "../../kpiDrivers/schema";
import { MAPPING_TABLES_SQL } from "../../mappingTables/schema";
import { replaceAllTables } from "../../mappingTables/repo";
import { BUDGET_IMPORT_SQL } from "../../budgetImport/schema";
import { resolveOuScope } from "../ouScope";
import { batchWrite } from "../positionsRepo";
import { runRecalc } from "../runRecalc";
import { ENGINE_OUTPUTS_SQL, POSITIONS_STRUCTURE_TABLES_SQL, POSITIONS_VALUE_TABLES_SQL } from "../schema";
import { getFieldCatalog, saveScenario } from "../structureRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { readStaffingStatistics } from "../staffingStatistics";
import { readFteReconciliation } from "../fteReconciliation";
import { getResultsSource } from "../../reports/resultsSource";
import { UNMAPPED_GROUP } from "../../../shared/reports/packs";
import type { StaffingStatsNode } from "../../../shared/reports/staffingStatistics";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);
const DEFAULTS: PositionDefaults = { ...buildDefaultPositionDefaults(SCOPE.ou, YEAR), weeklyHours: 38 };

let structureDb: Db;
let valuesDb: Db;
let scenarioId: string;

const contract = {
  seasonality: new Array(12).fill(1),
  vacationMonthlyWeights: new Array(12).fill(0),
  vacationDays: 0,
  dailyContractHours: 8,
};

const MAN_HOURS = {
  level_1: "Statistics",
  level_4: "Total Manhours",
  level_6: "Total Manhours excl Overtime and Manager Hours",
  level_9: "Man Hours",
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
        { base_account: "A511000", account_description_detail_level_max: "Salaries", level_9: "Total Payroll" },
        { base_account: "A512000", account_description_detail_level_max: "Wages", level_9: "Total Payroll" },
        { base_account: "A988101", account_description_detail_level_max: "Managers", level_1: "Statistics", level_4: "Number Of Managers" },
        { base_account: "A988699", account_description_detail_level_max: "988699 - Staff hours", ...MAN_HOURS },
        { base_account: "A988308", account_description_detail_level_max: "988308 - Manager Hours", level_1: "Statistics", level_4: "Total Manhours", level_6: "Non Prod Hours" },
      ],
      departmentMaps: [
        { base_department: "D0410", department_description_detail_level_max: "Admin", level_7: "Administrative & General", level_10: "Management Admin" },
        { base_department: "D0010", department_description_detail_level_max: "Rooms", level_7: "Rooms and Reservation", level_10: "Rooms" },
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
  const create = (id: string, fields: Record<string, unknown>, title: string) => ({
    id,
    fields: { ...contract, ...fields },
    pii: { title, firstName: "Ada", lastName: "Lovelace" },
  });
  batchWrite(
    valuesDb,
    SCOPE,
    {
      ou: SCOPE.ou,
      scenarioId,
      creates: [
        create("pos-1", { departmentCode: "D0410", jobTypeCode: "Manager", payType: "SALARIED", headcount: 2, monthlyBaseSalary: 3000, salaryAccountCode: "A511000", workingHoursAccount: "A988308" }, "Finance Manager"),
        create("pos-2", { departmentCode: "D0410", jobTypeCode: "Associate", payType: "HOURLY", headcount: 1, hourlyRate: 10, salaryAccountCode: "A512000", workingHoursAccount: "A988699" }, "Clerk"),
        create("pos-3", { departmentCode: "D0410", jobTypeCode: "Supervisor", payType: "SALARIED", headcount: 1, monthlyBaseSalary: 2000, salaryAccountCode: "A511000", workingHoursAccount: "A988699" }, "Accounts Supervisor"),
        create("pos-4", { departmentCode: "D0010", jobTypeCode: "Casual", payType: "HOURLY", headcount: 3, hourlyRate: 8, salaryAccountCode: "A512000", workingHoursAccount: "A988699" }, "Porter"),
        // A manager whose hours were pointed at the staff account.
        create("pos-5", { departmentCode: "D0010", jobTypeCode: "Manager", payType: "SALARIED", headcount: 1, monthlyBaseSalary: 4000, salaryAccountCode: "A511000", workingHoursAccount: "A988699" }, "Rooms Manager"),
        create("pos-6", { departmentCode: "D0999", jobTypeCode: "Supervisor", payType: "SALARIED", headcount: 1, monthlyBaseSalary: 2000, salaryAccountCode: "A511000", workingHoursAccount: "A988699" }, "Gardener"),
      ],
    },
    fieldMap
  );
});

const dbs = () => ({ localDb: structureDb, secureDb: valuesDb });
const DEPS = {
  getCalendar: async () => CALENDAR,
  getPositionDefaults: async () => DEFAULTS,
  clearPrefixes: DEFAULT_CLEAR_PREFIXES,
};

const recalc = () =>
  runRecalc(
    { localDb: structureDb, secureDb: valuesDb, getCalendar: DEPS.getCalendar, getDefaults: DEPS.getPositionDefaults, now: () => "2026-09-08T00:00:00.000Z" },
    SCOPE,
    scenarioId
  );

const dept = (hotel: StaffingStatsNode, code: string) => hotel.children.flatMap((g) => g.children).find((d) => d.code === code)!;

describe("readStaffingStatistics", () => {
  it("is empty, with a nudge, before the scenario is calculated", async () => {
    const stats = await readStaffingStatistics(dbs(), SCOPE, scenarioId, DEPS);
    expect(stats.year).toBe(YEAR);
    expect(stats.run).toBeNull();
    expect(stats.hotel.children).toEqual([]);
    expect(stats.warnings.map((w) => w.code)).toContain("NO_RESULTS");
  });

  it("ties the hotel to the results cache and its FTE to the reports' FTE", async () => {
    await recalc();
    const stats = await readStaffingStatistics(dbs(), SCOPE, scenarioId, DEPS);
    expect(stats.run).toEqual({ computedAt: "2026-09-08T00:00:00.000Z", stale: false });
    expect(stats.weeklyHours).toMatchObject({ origin: "column" });
    expect(stats.warnings).toEqual([]);
    expect(stats.groupLevel).toBe(10);

    const cache = getResultsSource(valuesDb, SCOPE, scenarioId).source;
    const cacheHours = cache.entries
      .filter((e) => e.account === "988699" || e.account === "988308")
      .reduce((sum, e) => sum + e.reportVec[12], 0);
    expect(stats.hotel.values.hours[12]).toBeCloseTo(cacheHours, 6);
    expect(stats.accounts.map((a) => [a.code, a.kind])).toEqual([
      ["988699", "fte"],
      ["988308", "manager"],
    ]);

    // The same FTE every report reads: the reconciliation's account side.
    const recon = await readFteReconciliation(dbs(), SCOPE, scenarioId, DEPS);
    expect(stats.hotel.values.fte[12]).toBeCloseTo(recon.totals.accounts.total, 6);
    expect(stats.fteHours[12]).toBeCloseTo(recon.fteHoursYear, 6);

    // Heads: every grade, a head each.
    expect(stats.hotel.values.heads[12]).toBe(2 + 1 + 1 + 3 + 1 + 1);

    expect(stats.hotel.children.map((g) => g.label)).toEqual(["Rooms", "Management Admin", UNMAPPED_GROUP]);
    expect(stats.unmappedDepartments).toEqual(["0999"]);

    const admin = dept(stats.hotel, "0410");
    expect(admin.label).toBe("Admin");
    expect(admin.children.map((c) => [c.label, c.tier])).toEqual([
      ["Finance Manager", "mgr"],
      ["Accounts Supervisor", "svsr"],
      ["Clerk", "assoc"],
    ]);
    expect(admin.values.managerHeads[12]).toBe(2);
    const childHours = admin.children.reduce((sum, c) => sum + c.values.hours[12], 0);
    expect(childHours).toBeCloseTo(admin.values.hours[12], 6);

    expect(JSON.stringify(stats)).not.toMatch(/Lovelace|Ada|first_name|last_name|firstName|lastName/);
  });

  it("flags the departments where grades share an hours account", async () => {
    await recalc();
    const stats = await readStaffingStatistics(dbs(), SCOPE, scenarioId, DEPS);
    const flagged = stats.gradeMix.map((entry) => [entry.dept, entry.account, entry.kinds]);
    expect(flagged).toEqual([
      // Rooms: the manager's hours drive FTE beside the porters'.
      ["0010", "988699", ["mixed", "manager_hours_drive_fte"]],
      // Admin: supervisor and clerk on one account; the manager on their own.
      ["0410", "988699", ["mixed"]],
    ]);
    const admin = stats.gradeMix.find((entry) => entry.dept === "0410")!;
    expect(admin.positionsByTier).toEqual({ mgr: 0, svsr: 1, assoc: 1 });
    expect(admin.hoursByTier.svsr).toBeGreaterThan(0);
    expect(stats.hotel.mix["988699"]).toEqual({ kinds: ["mixed", "manager_hours_drive_fte"], departments: 2 });
    const roomsManager = dept(stats.hotel, "0010").children.find((c) => c.label === "Rooms Manager")!;
    expect(roomsManager.mix["988699"].kinds).toEqual(["manager_hours_drive_fte"]);
    // A supervisor alone in a department is not a mix.
    expect(dept(stats.hotel, "0999").mix).toEqual({});
  });

  it("refuses a scenario the hotel does not have", async () => {
    await expect(readStaffingStatistics(dbs(), SCOPE, "nope", DEPS)).rejects.toThrow(/does not exist/);
  });
});
