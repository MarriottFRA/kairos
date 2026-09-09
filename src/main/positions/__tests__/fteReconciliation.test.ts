/**
 * The FTE reconciliation over real databases: before a run the account side
 * is empty and the work week comes from the setup; after a run the grid's
 * FTE stands beside the account-derived one per department — manager heads
 * from the headcount account, staff hours from the working-hours account ÷
 * the week Kairos itself posted to D0410 / A988112 — with a department the
 * mapping table has no group for under the unmapped bucket, and no name
 * anywhere.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { buildDefaultCalendar, DEFAULT_WEEKEND_MASK } from "../../../shared/calendar";
import { PositionDefaults, buildDefaultPositionDefaults, fullTimeReference, resolvePositionDefaults } from "../../../shared/positionDefaults";
import { effectiveWeekOf } from "../../../shared/positions/effectiveWeek";
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
import { loadScenarioInput } from "../loadScenarioInput";
import { readFteReconciliation } from "../fteReconciliation";
import { getResultsSource } from "../../reports/resultsSource";
import { UNMAPPED_GROUP } from "../../../shared/reports/packs";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);
const DEFAULTS: PositionDefaults = { ...buildDefaultPositionDefaults(SCOPE.ou, YEAR), weeklyHours: 38 };
/** The effective week this setup derives with no vacation on the roster: 38h
 *  over the calendar's 261 productive days. */
const EFFECTIVE = effectiveWeekOf(38, fullTimeReference(resolvePositionDefaults(DEFAULTS, CALENDAR))).effectiveWeek;

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
        { base_account: "A511000", account_description_detail_level_max: "Salaries", level_9: "Total Payroll" },
        { base_account: "A512000", account_description_detail_level_max: "Wages", level_9: "Total Payroll" },
        { base_account: "A988101", account_description_detail_level_max: "Managers", level_1: "Statistics" },
        {
          base_account: "A988699",
          account_description_detail_level_max: "Staff hours",
          level_1: "Statistics",
          level_4: "Total Manhours",
          level_6: "Total Manhours excl Overtime and Manager Hours",
          level_9: "Man Hours",
        },
        { base_account: "A988308", account_description_detail_level_max: "Manager hours", level_1: "Statistics", level_4: "Total Manhours", level_6: "Non Prod Hours" },
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
          fields: { departmentCode: "D0410", jobTypeCode: "Manager", payType: "SALARIED", headcount: 2, monthlyBaseSalary: 3000, salaryAccountCode: "A511000", workingHoursAccount: "A988308", ...contract },
          pii: { title: "Finance Manager", firstName: "Ada", lastName: "Lovelace" },
        },
        {
          id: "pos-2",
          fields: { departmentCode: "D0410", jobTypeCode: "Associate", payType: "HOURLY", headcount: 1, hourlyRate: 10, salaryAccountCode: "A512000", workingHoursAccount: "A988699", ...contract },
          pii: { title: "Clerk" },
        },
        {
          id: "pos-3",
          fields: { departmentCode: "D0010", jobTypeCode: "Casual", payType: "HOURLY", headcount: 3, hourlyRate: 8, salaryAccountCode: "A512000", workingHoursAccount: "A988699", ...contract },
          pii: { title: "Porter" },
        },
        {
          id: "pos-4",
          fields: { departmentCode: "D0999", jobTypeCode: "Supervisor", payType: "SALARIED", headcount: 1, monthlyBaseSalary: 2000, salaryAccountCode: "A511000", workingHoursAccount: "A988699", ...contract },
          pii: { title: "Gardener" },
        },
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

describe("readFteReconciliation", () => {
  it("shows the grid side alone before a run, with the week derived from the positions and a nudge to post it", async () => {
    const recon = await readFteReconciliation(dbs(), SCOPE, scenarioId, DEPS);
    expect(recon.year).toBe(YEAR);
    expect(recon.run).toBeNull();
    expect(recon.weeklyHours).toMatchObject({ value: EFFECTIVE, origin: "derived" });
    expect(recon.weeklyHours!.derivation).toMatchObject({ contractWeek: 38, averageVacationDays: 0, positions: 3 });
    expect(recon.fteHoursYear).toBeCloseTo(EFFECTIVE * 52);
    expect(recon.warnings.map((w) => w.code)).toContain("WEEKLY_HOURS_NOT_POSTED");
    expect(recon.groups.map((g) => g.label)).toEqual(["Rooms and Reservation", "Administrative & General", UNMAPPED_GROUP]);
    expect(recon.unmappedDepartments).toEqual(["0999"]);
    expect(recon.totals.accounts).toEqual({ managerHeads: 0, hours: 0, hoursFte: 0, total: 0 });
    expect(recon.totals.grid.heads).toBe(7);
    expect(recon.totals.grid.total).toBeGreaterThan(0);
    expect(recon.totals.variance).toBeCloseTo(-recon.totals.grid.total);
    expect(recon.warnings.map((w) => w.code)).toContain("NO_RESULTS");
  });

  it("sets the grid's FTE beside the account-derived one per department after a run", async () => {
    await recalc();
    const recon = await readFteReconciliation(dbs(), SCOPE, scenarioId, DEPS);
    expect(recon.run).toEqual({ computedAt: "2026-09-08T00:00:00.000Z", stale: false });
    // The effective week Kairos posted to D0410 / A988112 from the same setup
    // and the same positions.
    expect(recon.weeklyHours).toEqual({ value: EFFECTIVE, origin: "column" });
    expect(recon.warnings).toEqual([]);

    const input = await loadScenarioInput(structureDb, valuesDb, SCOPE, scenarioId, DEPS.getCalendar, DEPS.getPositionDefaults);
    const fteOf = (id: string) => input.positions.find((p) => p.id === id)!.fte;
    const results = getResultsSource(valuesDb, SCOPE, scenarioId).source;
    const hoursOf = (dept: string) => results.get(dept, "A988699")!.reportVec[12];

    const admin = recon.groups.find((g) => g.label === "Administrative & General")!.rows[0];
    expect(admin).toMatchObject({ dept: "0410", name: "Admin" });
    expect(admin.grid.managers).toBeCloseTo(fteOf("pos-1") * 2);
    expect(admin.grid.others).toBeCloseTo(fteOf("pos-2"));
    expect(admin.grid.heads).toBe(3);
    expect(admin.accounts.managerHeads).toBe(2); // the level's mean: two managers all year
    expect(admin.accounts.hours).toBeCloseTo(hoursOf("D0410")); // the clerk's hours; the manager hours account is not FTE
    expect(admin.accounts.hoursFte).toBeCloseTo(hoursOf("D0410") / (EFFECTIVE * 52));
    // The point of the effective week: with every position on the average
    // entitlement, the ledger's hours ÷ (week × 52) IS the grid's FTE.
    expect(admin.accounts.hoursFte).toBeCloseTo(admin.grid.others, 6);
    expect(admin.accounts.total).toBeCloseTo(2 + admin.accounts.hoursFte);
    expect(admin.variance).toBeCloseTo(admin.accounts.total - admin.grid.total);

    const rooms = recon.groups.find((g) => g.label === "Rooms and Reservation")!.rows[0];
    expect(rooms.grid.managers).toBe(0);
    expect(rooms.grid.others).toBeCloseTo(fteOf("pos-3") * 3);
    expect(rooms.accounts.managerHeads).toBe(0);
    expect(rooms.accounts.hours).toBeCloseTo(hoursOf("D0010"));
    expect(rooms.accounts.hoursFte).toBeCloseTo(rooms.grid.others, 6);
    // Hotel-wide the hours side reconciles exactly; what is left is the
    // manager grade, counted by head on the ledger (2) against the grid's
    // contract reading of the two (8h days on a 38h week: 2 × 1.05).
    expect(recon.totals.accounts.hoursFte).toBeCloseTo(recon.totals.grid.others, 6);
    expect(recon.totals.variance).toBeCloseTo(recon.totals.accounts.managerHeads - recon.totals.grid.managers, 6);

    const unmapped = recon.groups.find((g) => g.label === UNMAPPED_GROUP)!;
    expect(unmapped.rows.map((r) => r.dept)).toEqual(["0999"]);

    expect(recon.totals.grid.total).toBeCloseTo(admin.grid.total + rooms.grid.total + unmapped.totals.grid.total);
    expect(recon.totals.accounts.total).toBeCloseTo(admin.accounts.total + rooms.accounts.total + unmapped.totals.accounts.total);
    expect(JSON.stringify(recon)).not.toMatch(/Lovelace|Ada|first_name|last_name|firstName|lastName/);
  });

  it("refuses a scenario the hotel does not have", async () => {
    await expect(readFteReconciliation(dbs(), SCOPE, "nope", DEPS)).rejects.toThrow(/does not exist/);
  });
});
