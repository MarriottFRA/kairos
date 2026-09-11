/**
 * The budget submission over real databases: a plan that has never been
 * calculated is calculated first, every table is rectangular under its
 * declared columns, only active positions travel, the calculated columns
 * are the Staffing statistics report's, manual and buyout rows come along,
 * and no name ever appears anywhere in the payload.
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
import { deriveFte } from "../../../shared/positions/engineInput";
import { DEFAULT_CLEAR_RULES } from "../../../shared/bstPush/ipc";
import { applyStructureColumns } from "../../blocks/schema";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { saveRow as saveManualRow } from "../../manualInput/repo";
import { KPI_DRIVERS_SQL } from "../../kpiDrivers/schema";
import { MAPPING_TABLES_SQL } from "../../mappingTables/schema";
import { replaceAllTables } from "../../mappingTables/repo";
import { BUDGET_IMPORT_SQL } from "../../budgetImport/schema";
import { resolveOuScope } from "../../positions/ouScope";
import { batchWrite } from "../../positions/positionsRepo";
import { readRunInfo } from "../../positions/positionBridge";
import { ENGINE_OUTPUTS_SQL, POSITIONS_STRUCTURE_TABLES_SQL, POSITIONS_VALUE_TABLES_SQL } from "../../positions/schema";
import { getFieldCatalog, saveScenario } from "../../positions/structureRepo";
import { readStaffingStatistics } from "../../positions/staffingStatistics";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import {
  SUBMISSION_HEADER_COLUMNS,
  SUBMISSION_POSITION_COLUMNS,
  SUBMISSION_SCHEMA_VERSION,
  SubmissionPayload,
  SubmissionTable,
  submissionHeaderOf,
} from "../../../shared/submission/schema";
import { StaffingStatsNode, hoursOfKind } from "../../../shared/reports/staffingStatistics";
import { buildSubmission } from "../build";

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
    pii: { title, firstName: "Ada", lastName: "Lovelace", empNumber: "E-4711" },
  });
  batchWrite(
    valuesDb,
    SCOPE,
    {
      ou: SCOPE.ou,
      scenarioId,
      creates: [
        create("pos-1", { departmentCode: "D0410", jobTypeCode: "Manager", payType: "SALARIED", headcount: 2, monthlyBaseSalary: 3000, salaryAccountCode: "A511000", workingHoursAccount: "A988308", contractYearlyDays: 365, contractDaysOff: 104, contractPubHolidays: 8 }, "Finance Manager"),
        create("pos-2", { departmentCode: "D0410", jobTypeCode: "Associate", payType: "HOURLY", headcount: 1, hourlyRate: 10, salaryAccountCode: "A512000", workingHoursAccount: "A988699", contractYearlyDays: 365, contractDaysOff: 104, contractPubHolidays: 8, vacationDays: 20 }, "Clerk"),
        create("pos-3", { departmentCode: "D0010", jobTypeCode: "Casual", payType: "HOURLY", headcount: 3, hourlyRate: 8, salaryAccountCode: "A512000", workingHoursAccount: "A988699" }, "Porter"),
        // Retained, not budgeted: must not travel.
        create("pos-4", { departmentCode: "D0010", jobTypeCode: "Supervisor", payType: "SALARIED", headcount: 1, monthlyBaseSalary: 2000, salaryAccountCode: "A511000", workingHoursAccount: "A988699", active: false }, "Night Supervisor"),
      ],
    },
    fieldMap
  );

  saveManualRow(valuesDb, {
    id: "manual-1",
    ou: SCOPE.ou,
    scenarioId,
    description: "Agency cover",
    department: "Rooms",
    departmentCode: "D0010",
    costAccount: "A512000",
    statsAccount: "A988699",
    rate: 12,
    statsKpiDriverId: null,
    statsKpiDivisor: null,
    statsKpiFactor: null,
    stats: new Array(12).fill(100),
    amounts: new Array(12).fill(0),
    spreadMode: null,
    spreadBaseStats: null,
    spreadBaseAmount: null,
    increasePct: 0,
    increaseMonth: 13,
    sortOrder: 1,
    createdBy: "someone@example.com",
    now: "2026-09-01T00:00:00.000Z",
  });

  valuesDb
    .prepare(
      `INSERT INTO buyout_rows (id, ou, scenario_id, department_code, account_code, monthly_values, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run("buyout-1", SCOPE.ou, scenarioId, "D0410", "A512000", JSON.stringify(new Array(12).fill(500)), "2026-09-01T00:00:00.000Z");
});

const dbs = () => ({ localDb: structureDb, secureDb: valuesDb });
const DEPS = {
  getCalendar: async () => CALENDAR,
  getPositionDefaults: async () => DEFAULTS,
  clearRules: DEFAULT_CLEAR_RULES,
  appVersion: "1.0.0-test",
  now: () => "2026-09-11T10:00:00.000Z",
  newId: () => "submission-1",
};

const build = (overrides: Partial<{ slot: string; year: number; scenarioId: string; hotelName: string }> = {}) =>
  buildSubmission(
    dbs(),
    SCOPE,
    { ou: SCOPE.ou, scenarioId, slot: "BUD", year: YEAR, hotelName: "Test Hotel", ...overrides },
    DEPS
  );

function rowsOf(table: SubmissionTable): Array<Record<string, unknown>> {
  return table.rows.map((row) => Object.fromEntries(table.columns.map((c, i) => [c, row[i]])));
}

function positionNodes(node: StaffingStatsNode, out: StaffingStatsNode[] = []): StaffingStatsNode[] {
  if (node.kind === "position") out.push(node);
  node.children.forEach((child) => positionNodes(child, out));
  return out;
}

const expectRectangular = (table: SubmissionTable) => {
  expect(new Set(table.columns).size).toBe(table.columns.length);
  for (const row of table.rows) expect(row.length).toBe(table.columns.length);
};

describe("buildSubmission", () => {
  it("calculates a never-calculated plan first and stamps the run on the header", async () => {
    expect(readRunInfo(dbs(), SCOPE, scenarioId)).toBeNull();
    const built = await build();
    expect(built.run).toEqual({ computedAt: "2026-09-11T10:00:00.000Z", stale: false });
    const header = submissionHeaderOf(built.payload);
    expect(header).toMatchObject({
      submission_id: "submission-1",
      schema_version: SUBMISSION_SCHEMA_VERSION,
      ou: SCOPE.ou,
      hotel_name: "Test Hotel",
      year: YEAR,
      slot: "BUD",
      scenario_id: scenarioId,
      scenario_label: "Planning",
      app_version: "1.0.0-test",
      submitted_at: "2026-09-11T10:00:00.000Z",
      engine_computed_at: "2026-09-11T10:00:00.000Z",
      contract_week: 38,
      position_count: 3,
      manual_row_count: 1,
      buyout_row_count: 1,
    });
    // The effective week travels as derived AND as the run posted it — the same number.
    expect(header.effective_week).toBeGreaterThan(0);
    expect(header.effective_week_posted).toBeCloseTo(header.effective_week as number, 6);
    expect(header.working_days_year).toBe(
      CALENDAR.months.reduce((acc, m) => acc + m.calendarDays - m.publicHolidays - m.weekendDays, 0)
    );
    expect(built.payload.submission.columns).toEqual([...SUBMISSION_HEADER_COLUMNS]);
    expect(built.warnings).toEqual([]);
  });

  it("is rectangular under its declared columns, every table", async () => {
    const { payload } = await build();
    expectRectangular(payload.submission);
    expectRectangular(payload.positions);
    expectRectangular(payload.manualRows);
    expectRectangular(payload.buyoutRows);
    expect(payload.positions.columns).toEqual([...SUBMISSION_POSITION_COLUMNS]);
    expect(payload.submission.rows).toHaveLength(1);
  });

  it("sends only active positions, in department order, titled but never named", async () => {
    const { payload } = await build();
    const positions = rowsOf(payload.positions);
    expect(positions.map((p) => p.position_id)).toEqual(["pos-3", "pos-1", "pos-2"]);
    expect(positions.map((p) => p.title)).toEqual(["Porter", "Finance Manager", "Clerk"]);
    expect(positions.map((p) => p.department_name)).toEqual(["Rooms", "Admin", "Admin"]);
    expect(positions.map((p) => p.classification)).toEqual(["Casual", "Manager", "Associate"]);

    const text = JSON.stringify(payload);
    expect(text).not.toContain("Ada");
    expect(text).not.toContain("Lovelace");
    expect(text).not.toContain("E-4711");
    expect(text).not.toContain("Night Supervisor");
    for (const column of payload.positions.columns) {
      expect(column).not.toMatch(/first_name|last_name|emp_number|hiring_date/);
    }
  });

  it("carries the contract inputs as typed and the grid's derived figures beside them", async () => {
    const { payload } = await build();
    const clerk = rowsOf(payload.positions).find((p) => p.position_id === "pos-2")!;
    expect(clerk).toMatchObject({
      pay_type: "HOURLY",
      headcount: 1,
      hourly_rate: 10,
      monthly_base_salary: 0,
      contract_yearly_days: 365,
      contract_days_off: 104,
      contract_pub_holidays: 8,
      daily_contract_hours: 8,
      vacation_days: 20,
      total_working_months: 12,
      annual_divisor_basis: "TWELVE",
      salary_account: "A512000",
      working_hours_account: "A988699",
      working_01: 1,
      working_12: 1,
    });
    // (365 − 104) × 8 paid; (365 − 104 − 8 − 20) × 8 worked.
    expect(clerk.yearly_manhours_paid).toBe(261 * 8);
    expect(clerk.yearly_hours_worked).toBe(233 * 8);
    // The grid's own FTE: the row's contract against the hotel-year yardstick
    // (8-hour days on a 38-hour week read above 1, which is correct).
    const reference = fullTimeReference(resolvePositionDefaults(DEFAULTS, CALENDAR));
    expect(clerk.fte).toBeCloseTo(
      deriveFte(
        { vacationDays: 20, dailyContractHours: 8, seasonality: contract.seasonality },
        { yearlyDays: 365, daysOff: 104, pubHolidays: 8 },
        reference
      ),
      9
    );
    expect(clerk.accrual_days_per_month).toBeCloseTo(20 / 12, 9);

    const manager = rowsOf(payload.positions).find((p) => p.position_id === "pos-1")!;
    expect(manager.annual_base_salary).toBeNull();
    expect(manager.standard_job_title).toBeNull();
    expect(manager.cluster_name).toBeNull();
    expect(manager.cluster_weight).toBe(1);
  });

  it("takes the calculated heads, FTE and hours from the Staffing statistics report", async () => {
    const built = await build();
    const stats = await readStaffingStatistics(dbs(), SCOPE, scenarioId, DEPS);
    const byId = new Map(positionNodes(stats.hotel).map((n) => [n.id.split(":").slice(2).join(":"), n]));
    for (const row of rowsOf(built.payload.positions)) {
      const node = byId.get(String(row.position_id))!;
      expect(node).toBeDefined();
      expect(row.calc_heads_year).toBeCloseTo(node.values.heads[12], 9);
      expect(row.calc_heads_01).toBeCloseTo(node.values.heads[0], 9);
      expect(row.calc_fte_year).toBeCloseTo(node.values.fte[12], 9);
      expect(row.calc_hours_total_year).toBeCloseTo(node.values.hours[12], 9);
      expect(row.calc_hours_fte_year).toBeCloseTo(hoursOfKind(node.values, stats.accounts, "fte")[12], 9);
    }
    const manager = rowsOf(built.payload.positions).find((p) => p.position_id === "pos-1")!;
    expect(manager.calc_heads_year).toBe(2);
    // Managers are FTE by head; their hours are not FTE-driving.
    expect(manager.calc_fte_year).toBe(2);
    expect(manager.calc_hours_fte_year).toBe(0);
    // Hours-driven staff: FTE-driving hours ÷ one full-timer's hours for the
    // year. It sits beside the grid's contract-derived `fte` on purpose — the
    // two are what head office reconciles.
    const clerk = rowsOf(built.payload.positions).find((p) => p.position_id === "pos-2")!;
    expect(clerk.calc_hours_fte_year).toBeGreaterThan(0);
    expect(clerk.calc_fte_year).toBeCloseTo((clerk.calc_hours_fte_year as number) / stats.fteHours[12], 9);
    expect(Math.abs((clerk.calc_fte_year as number) - (clerk.fte as number))).toBeLessThan(0.1);
  });

  it("carries manual rows at their effective values and buyout rows verbatim", async () => {
    const { payload } = await build();
    const [manual] = rowsOf(payload.manualRows);
    expect(manual).toMatchObject({
      row_id: "manual-1",
      description: "Agency cover",
      department_code: "D0010",
      department_name: "Rooms",
      cost_account: "A512000",
      stats_account: "A988699",
      rate: 12,
      rate_driven: true,
      stats_kpi_driven: false,
      stats_01: 100,
      stats_year: 1200,
      amount_01: 1200,
      amount_year: 14400,
    });
    expect(JSON.stringify(payload.manualRows)).not.toContain("someone@example.com");

    const [buyout] = rowsOf(payload.buyoutRows);
    expect(buyout).toMatchObject({
      row_id: "buyout-1",
      department_code: "D0410",
      department_name: "Admin",
      account: "A512000",
      amount_06: 500,
      amount_year: 6000,
    });
  });

  it("refuses a plan of another year, or one that does not exist", async () => {
    await expect(build({ year: 2028 })).rejects.toThrow('The plan "Planning" is for 2027, not 2028.');
    await expect(build({ scenarioId: "nope" })).rejects.toThrow("does not exist");
  });

  it("warns when a plan has no active positions", async () => {
    const empty = saveScenario(structureDb, SCOPE, { year: YEAR, label: "Empty" }).id;
    const built = await build({ scenarioId: empty });
    expect(built.counts).toEqual({ positions: 0, manualRows: 0, buyoutRows: 0 });
    expect(built.warnings.map((w) => w.code)).toContain("NO_POSITIONS");
    const payload: SubmissionPayload = built.payload;
    expect(payload.positions.rows).toEqual([]);
  });
});
