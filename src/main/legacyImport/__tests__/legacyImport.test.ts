/**
 * Legacy Excel import tests — parse, analyse and commit against in-memory
 * workbooks and databases.
 *
 * The fixture is built cell-by-cell in the real sheet layout (row 2 band names,
 * row 3 column names, row 4+ data, formulas on row 4) rather than checked in as
 * a binary, so the expectations read as a description of the workbook contract
 * and a layout change fails loudly instead of silently importing nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import * as XLSX from "xlsx";

import {
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import { applyBlocksStructureV12 } from "../../blocks/schema";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { resolveOuScope } from "../../positions/ouScope";
import {
  ensureFieldCatalogSeed,
  getComponentDefinitions,
  getFieldCatalog,
  saveScenario,
} from "../../positions/structureRepo";
import { listBlocks } from "../../blocks/repo";
import { listAllocations } from "../../allocations/repo";
import { listRows as listManualRows } from "../../manualInput/repo";
import { loadScenarioValues } from "../../positions/positionsRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { DEFAULT_LEGACY_IMPORT_OPTIONS } from "../../../shared/legacyImport/ipc";
import type { CalendarYear } from "../../../shared/calendar";
import type { PositionDefaults } from "../../../shared/positionDefaults";

import {
  NotLegacyWorkbookError,
  parseLegacyWorkbook,
} from "../parseWorkbook";
import {
  analyzeWorkbook,
  columnIndex,
  columnLetter,
  splitPayClass,
  toAccountCode,
  toDepartmentCode,
  toIsoDate,
} from "../analyze";
import { commitImportPlan } from "../commit";

type Db = InstanceType<typeof Database>;

const OU = resolveOuScope("OU12345");
const NOW = "2026-01-01T00:00:00.000Z";
const YEAR = 2026;
const SCENARIO = "scenario-1";

// ---------------------------------------------------------------------------
// Fixture workbook
// ---------------------------------------------------------------------------

type Cell = number | string | boolean | { f: string };

/** Write `{ "BT4": 0.05, ... }` style cells into a fresh sheet. */
function sheet(cells: Record<string, Cell>): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxRow = 0;
  let maxCol = 0;
  for (const [address, value] of Object.entries(cells)) {
    const { r, c } = XLSX.utils.decode_cell(address);
    maxRow = Math.max(maxRow, r);
    maxCol = Math.max(maxCol, c);
    ws[address] =
      typeof value === "object"
        ? { t: "n", v: 0, f: value.f }
        : typeof value === "number"
          ? { t: "n", v: value }
          : typeof value === "boolean"
            ? { t: "b", v: value }
            : { t: "s", v: value };
  }
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: maxRow, c: maxCol },
  });
  return ws;
}

/** Spread twelve values across consecutive columns on one row. */
function months(firstCol: string, row: number, values: number[]) {
  const start = columnIndex(firstCol);
  return Object.fromEntries(
    values.map((value, index) => [`${columnLetter(start + index)}${row}`, value])
  );
}

interface AssociateOptions {
  row: number;
  department?: string;
  payClass?: string;
  salary?: number;
  seasonality?: number[];
  /** Extra raw cells, e.g. a band's inputs. */
  cells?: Record<string, Cell>;
}

function associate(options: AssociateOptions): Record<string, Cell> {
  const { row } = options;
  const seasonality = options.seasonality ?? new Array(12).fill(1);
  return {
    [`A${row}`]: 44607, // 2022-02-15
    [`B${row}`]: 1000 + row,
    [`C${row}`]: `Last${row}`,
    [`D${row}`]: `First${row}`,
    [`E${row}`]: options.department ?? "0400",
    [`G${row}`]: options.payClass ?? "Manager Salaried Pay",
    [`H${row}`]: "IT Manager",
    [`I${row}`]: 365,
    [`J${row}`]: 104,
    [`K${row}`]: 9,
    [`L${row}`]: 8,
    [`O${row}`]: 1,
    [`P${row}`]: 1,
    ...months("R", row, seasonality),
    [`AE${row}`]: options.salary ?? 10000,
    [`AS${row}`]: 0.1,
    [`AT${row}`]: 0,
    [`AU${row}`]: 3,
    [`AV${row}`]: "988308",
    [`AW${row}`]: "988101",
    [`AY${row}`]: "520001",
    [`BA${row}`]: 21,
    [`BD${row}`]: "Blank",
    ...months("BE", row, new Array(12).fill(1 / 12)),
    [`BR${row}`]: "560303",
    ...(options.cells ?? {}),
  };
}

/** Row-2 band names and row-3 column names, as the real sheet carries them. */
const HEADERS: Record<string, Cell> = {
  A2: "Associate Details",
  A3: "Hiring Date",
  BT2: "Pension",
  BW2: "Indemnity / End of Service",
  CA2: "Stock Options",
  CD2: "Airfare / Tickets",
  CH2: "Transportation Allowance",
  CK2: "Housing Allowance",
  CN2: "Food Allowance",
  CQ2: "Hardship Allowance",
  CT2: "Custom Allowance Flat Monthly Spread",
  CW2: "Custom Allowance Flat Daily Spread (based on salaried vs hourly)",
  CZ2: "Custom Allowance Weighted Monthly Spread (on base salary)",
  DC2: "Bonus Percentage",
  DR2: "Overtime - Flat Spread",
  DY2: "Custom Monthly Spread 1",
  EY2: "Social Security/NI",
};

/**
 * Two associates: one on every band, one salaried nine-month starter, so the
 * working-months arithmetic of the daily-spread bands is exercised.
 */
function buildWorkbook(overrides: Record<string, Cell> = {}): Buffer {
  const associateCells: Record<string, Cell> = {
    ...HEADERS,
    ...associate({
      row: 4,
      cells: {
        BT4: 0.0585, // pension %
        BU4: "565003",
        BV4: { f: "BT4*(AZ4+CP4)" }, // salary + food allowance
        BW4: 1500, // indemnity, a full-year amount
        BX4: "560506",
        BZ4: { f: "+BW4" },
        CD4: 4, // airfare: tickets
        CE4: 8600, // × destination cost
        CF4: "560355",
        CG4: { f: "CD4*CE4" },
        CH4: 500,
        CI4: "580112",
        CJ4: { f: "CH4*AD4" },
        CN4: 1207,
        CO4: "569001",
        CP4: { f: "CN4*AD4" },
        CW4: 300, // custom allowance, daily spread
        CX4: "560302",
        CY4: { f: "+CW4*AD4" },
        CZ4: 0.05,
        DA4: "520001",
        DB4: { f: "+CZ4*AZ4" },
        DC4: 0.1, // bonus %
        DD4: "540204",
        DE4: { f: "(AZ4+BV4)*DC4" }, // salary + pension
        EZ4: 0.0455, // SS first-band rate (reported only)
        FO4: "560897",
      },
    }),
    ...associate({
      row: 5,
      department: "0410",
      salary: 5000,
      seasonality: [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1], // nine months
      cells: {
        BT5: 0.039,
        BU5: "560372", // a DIFFERENT account → the block unlocks
        BV5: { f: "BT5*(AZ5+CP5)" },
        BW5: 500,
        BX5: "560506",
        BZ5: { f: "+BW5" },
        CH5: 200,
        CI5: "580112",
        CJ5: { f: "CH5*AD5" },
        CN5: 1207,
        CO5: "569001",
        CP5: { f: "CN5*AD5" },
        CW5: 150,
        CX5: "560302",
        CY5: { f: "+CW5*AD5" },
        EZ5: 0.0055,
        FO5: "560897",
      },
    }),
    ...overrides,
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(associateCells), "Associate Details");
  XLSX.utils.book_append_sheet(
    wb,
    sheet({
      A4: "Entered Year",
      B4: "Yr 2026",
      A9: "Basic Salary",
      B9: true,
      A31: "Full Time Hours (w)",
      B31: 40,
    }),
    "Settings"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet({
      B11: "Calendar Days",
      ...months("C", 11, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]),
      B12: "Public Holidays",
      ...months("C", 12, [1, 0, 0, 2, 1, 2, 0, 1, 0, 0, 0, 2]),
    }),
    "Menu"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet({
      A1: "DO NOT EDIT",
      A2: "Label / Description",
      A3: "Painter ",
      B3: "0430",
      C3: "520201",
      D3: "988000",
      // Twelve months of hours / rate / fixed / total, from E.
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_unused, m) => {
          const base = columnIndex("E") + m * 4;
          return [
            [`${columnLetter(base)}3`, 208],
            [`${columnLetter(base + 1)}3`, 0],
            [`${columnLetter(base + 2)}3`, 6427.52],
          ];
        }).flat()
      ),
      // A second row that IS rate-driven, so both shapes are covered.
      A4: "Casual waiter",
      B4: "0011",
      C4: "520202",
      D4: "988001",
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_unused, m) => {
          const base = columnIndex("E") + m * 4;
          return [
            [`${columnLetter(base)}4`, 100],
            [`${columnLetter(base + 1)}4`, 12.5],
            [`${columnLetter(base + 2)}4`, 0],
          ];
        }).flat()
      ),
    }),
    "Buyout & Manual Input"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet({
      A2: "Allocation Calculator",
      B3: "% of Laundry Cost",
      C6: "0000",
      B7: "Disabled",
      C8: "915010",
      C9: "Head Count",
      D3: "% of Employee Meal Cost",
      E6: "0090",
      D7: "Active",
      E8: "914100",
      E9: "Head Count",
      A9: "DEPARTMENTS",
      A10: "0400",
      D10: 60,
      A11: "0410",
      D11: 40,
      A12: "0430",
      // 0430 left blank in the active column → excluded
    }),
    "Allocations"
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet({
      D4: "OU",
      G4: "Hotel Name",
      D5: "12345",
      G5: "Test Hotel",
    }),
    "Budget_Import"
  );

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function parseFixture(overrides?: Record<string, Cell>) {
  return parseLegacyWorkbook(buildWorkbook(overrides), "fixture.xlsm");
}

function planFixture(overrides?: Record<string, Cell>) {
  return analyzeWorkbook(parseFixture(overrides), {
    filePath: "C:/tmp/fixture.xlsm",
    options: DEFAULT_LEGACY_IMPORT_OPTIONS,
    departmentNameByCode: new Map([
      ["D0400", "Information & Telecom Systems"],
      ["D0430", "Engineering"],
    ]),
  });
}

// ---------------------------------------------------------------------------

describe("column-letter arithmetic", () => {
  it("round-trips single and double letters", () => {
    for (const letter of ["A", "Z", "AA", "AZ", "BA", "CZ", "FP"]) {
      expect(columnLetter(columnIndex(letter))).toBe(letter);
    }
  });
});

describe("cell coercion", () => {
  it("puts the app-standard prefixes on accounts and departments", () => {
    expect(toAccountCode(565003)).toBe("A565003");
    expect(toAccountCode("565003")).toBe("A565003");
    // The old tool writes the literal "Blank" for a line that computes but
    // never posts — Kairos spells that as an empty account.
    expect(toAccountCode("Blank")).toBe("");
    expect(toAccountCode("")).toBe("");
    expect(toDepartmentCode("0400")).toBe("D0400");
    expect(toDepartmentCode("D0400")).toBe("D0400");
  });

  it("reads Excel date serials", () => {
    expect(toIsoDate(44607)).toBe("2022-02-15");
    expect(toIsoDate(null)).toBeNull();
  });

  it("splits the pay class into a classification and a pay basis", () => {
    expect(splitPayClass("Manager Salaried Pay")).toEqual({
      jobTypeCode: "Manager",
      payType: "SALARIED",
      recognised: true,
    });
    expect(splitPayClass("Associate Hourly Pay")).toEqual({
      jobTypeCode: "Associate",
      payType: "HOURLY",
      recognised: true,
    });
    expect(splitPayClass("Manager Salaried Pay (Non Exempt)").jobTypeCode).toBe(
      "Manager (Non Exempt)"
    );
    // Anything unrecognised still lands somewhere sensible, and says so.
    expect(splitPayClass("Something else")).toEqual({
      jobTypeCode: "Associate",
      payType: "SALARIED",
      recognised: false,
    });
  });
});

describe("parseLegacyWorkbook", () => {
  it("reads the sheets, the headers and the row-4 formulas", () => {
    const workbook = parseFixture();
    expect(workbook.associates).toHaveLength(2);
    expect(workbook.bandNames.BT).toBe("Pension");
    expect(workbook.columnNames.A).toBe("Hiring Date");
    // Row numbers are stripped so the formula reads as a column expression.
    expect(workbook.formulas.BV).toBe("BT*(AZ+CP)");
    expect(workbook.fullTimeWeeklyHours).toBe(40);
    expect(workbook.enteredYear).toBe(2026);
    expect(workbook.publicHolidaysByMonth).toEqual([1, 0, 0, 2, 1, 2, 0, 1, 0, 0, 0, 2]);
    expect(workbook.hotelName).toBe("Test Hotel");
    expect(workbook.ou).toBe("12345");
    expect(workbook.ssBaseFlags.CN_A1).toBe(true);
    expect(workbook.ssBaseFlags.CN_A2).toBe(false);
    expect(workbook.manualRows).toHaveLength(2);
    expect(workbook.allocationColumns).toHaveLength(2);
    expect(workbook.allocationDepartments).toEqual(["0400", "0410", "0430"]);
  });

  it("refuses a workbook that is not the Payroll Budget Tool", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet({ A1: "hello" }), "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(() => parseLegacyWorkbook(buffer, "other.xlsx")).toThrow(
      NotLegacyWorkbookError
    );
  });
});

describe("analyzeWorkbook — blocks", () => {
  it("creates a block only for the bands that carry data", () => {
    const plan = planFixture();
    const keys = plan.blocks.map((block) => block.key).sort();
    expect(keys).toEqual(
      [
        "airfare",
        "bonus",
        "customFlatDaily",
        "customWeighted",
        "food",
        "indemnity",
        "pension",
        "transport",
      ].sort()
    );
    // Bands the file leaves blank produce nothing at all.
    expect(plan.preview.skippedBlocks).toContain("Stock Options");
    expect(plan.preview.skippedBlocks).toContain("Hardship Allowance");
    // Skipped bands are named as the workbook names them.
    expect(plan.preview.skippedBlocks).toContain("Overtime - Flat Spread");
  });

  it("maps each band to the block type and spread its VBA section uses", () => {
    const plan = planFixture();
    const byKey = new Map(plan.blocks.map((block) => [block.key, block]));

    expect(byKey.get("transport")!.input.blockType).toBe("FLAT_MONTHLY");
    expect(byKey.get("transport")!.valuesByRow.get(4)).toEqual({ amount: 500 });

    // §4 spreads the yearly indemnity weighted by the salary curve.
    const indemnity = byKey.get("indemnity")!;
    expect(indemnity.input.blockType).toBe("COUNT_RATE");
    expect(indemnity.input.spread).toBe("WEIGHTED_BASE");
    expect(indemnity.valuesByRow.get(4)).toEqual({ qty: 1, unitRate: 1500 });

    // Airfare is genuinely count × rate: tickets × destination cost.
    const airfare = byKey.get("airfare")!;
    expect(airfare.input.spread).toBe("ACTIVE_MONTHS");
    expect(airfare.valuesByRow.get(4)).toEqual({ qty: 4, unitRate: 8600 });

    // The daily-spread band's input is MONTHLY, so qty must be the row's
    // working months for qty × rate to equal the year.
    const daily = byKey.get("customFlatDaily")!;
    expect(daily.input.spread).toBe("DAYS");
    expect(daily.valuesByRow.get(4)).toEqual({ qty: 12, unitRate: 300 });
    expect(daily.valuesByRow.get(5)).toEqual({ qty: 9, unitRate: 150 });
  });

  it("reads a percentage band's base from its total column's formula", () => {
    const plan = planFixture();
    const byKey = new Map(plan.blocks.map((block) => [block.key, block]));

    // BV = BT*(AZ+CP): salary + food allowance, not salary alone.
    const pension = byKey.get("pension")!;
    expect(pension.input.base?.kind).toBe("COMPOSITE");
    expect(pension.baseIncludesSalary).toBe(true);
    expect(pension.baseBlockKeys).toEqual(["food"]);
    expect(pension.preview.baseSummary).toBe("Base Salary + Food Allowance");

    // DE = (AZ+BV)*DC: salary + pension.
    const bonus = byKey.get("bonus")!;
    expect(bonus.baseBlockKeys).toEqual(["pension"]);

    // DB = +CZ*AZ: salary alone stays a plain BASE_SALARY base.
    const weighted = byKey.get("customWeighted")!;
    expect(weighted.input.base).toEqual({ kind: "BASE_SALARY" });
  });

  it("orders blocks so a composite base always exists first", () => {
    const order = planFixture().blocks.map((block) => block.key);
    // food ◀ pension ◀ bonus
    expect(order.indexOf("food")).toBeLessThan(order.indexOf("pension"));
    expect(order.indexOf("pension")).toBeLessThan(order.indexOf("bonus"));
  });

  it("locks the account only where every row agrees", () => {
    const plan = planFixture();
    const byKey = new Map(plan.blocks.map((block) => [block.key, block]));

    const transport = byKey.get("transport")!;
    expect(transport.input.accountLocked).toBe(true);
    expect(transport.input.accountCode).toBe("A580112");
    expect(transport.valuesByRow.get(4)?.accountCode).toBeUndefined();

    // Pension posts to two different accounts, so each row keeps its own.
    const pension = byKey.get("pension")!;
    expect(pension.input.accountLocked).toBe(false);
    expect(pension.valuesByRow.get(4)?.accountCode).toBe("A565003");
    expect(pension.valuesByRow.get(5)?.accountCode).toBe("A560372");
    expect(pension.preview.accountSummary).toContain("per row");
  });

  it("warns rather than guesses when a formula term is unknown", () => {
    const plan = planFixture({ BV4: { f: "BT4*(AZ4+ZZ4)" } });
    expect(plan.warnings.some((w) => /ZZ/.test(w))).toBe(true);
  });

  it("falls back to base salary when the total column has no formula", () => {
    const plan = planFixture({ BV4: 123 });
    const pension = plan.blocks.find((block) => block.key === "pension")!;
    expect(pension.input.base).toEqual({ kind: "BASE_SALARY" });
    expect(plan.warnings.some((w) => /no formula/.test(w))).toBe(true);
  });

  it("names the rows whose total formula was edited by hand", () => {
    // Real workbooks carry these: the reference file has one allowance row
    // rewritten to `+CT*AD*P` (the standard rule times that row's FTE). A block
    // config is hotel-wide, so it cannot be reproduced — but it must be said.
    const plan = planFixture({ CJ5: { f: "CH5*AD5*P5" } });
    const warning = plan.warnings.find((w) =>
      w.startsWith("Transportation Allowance: sheet row")
    );
    expect(warning).toBeDefined();
    expect(warning).toContain("5");
    expect(warning).toContain("CH*AD*P");
    // Singular row → singular verb.
    expect(warning).toContain("calculates this differently");
    // The block is still created, on the majority rule.
    expect(
      plan.blocks.find((block) => block.key === "transport")!.input.blockType
    ).toBe("FLAT_MONTHLY");
  });

  it("reports Social Security instead of importing it", () => {
    const plan = planFixture();
    expect(plan.blocks.some((block) => block.input.blockType === "SOCIAL_SECURITY")).toBe(
      false
    );
    const note = plan.warnings.find((w) => w.startsWith("Social Security"));
    expect(note).toBeDefined();
    // Both per-associate rate sets are described, so nothing is lost silently.
    expect(note).toContain("4.550%");
    expect(note).toContain("0.550%");
    expect(note).toContain("Basic Salary");
  });
});

describe("analyzeWorkbook — positions, manual input and allocations", () => {
  it("maps the associate columns onto catalog fields", () => {
    const plan = planFixture();
    const [first, second] = plan.positions;

    expect(first.fields).toMatchObject({
      active: true,
      departmentCode: "D0400",
      deptName: "Information & Telecom Systems",
      jobTypeCode: "Manager",
      payType: "SALARIED",
      headcount: 1,
      monthlyBaseSalary: 10000,
      meritIncreasePct: 0.1,
      increaseMonth: 3,
      dailyContractHours: 8,
      vacationDays: 21,
      contractYearlyDays: 365,
      salaryAccountCode: "A520001",
      // "Blank" in the sheet means "compute but do not post".
      accrualAccount: "",
      benefitsAccountCode: "A560303",
    });
    expect(first.pii).toEqual({
      hiringDate: "2022-02-15",
      empNumber: "1004",
      lastName: "Last4",
      firstName: "First4",
      title: "IT Manager",
    });
    // Derived columns are not imported — Kairos recomputes them.
    expect(first.fields).not.toHaveProperty("yearlyHoursWorked");
    expect(first.fields).not.toHaveProperty("fullYearWage");
    // Twelve zeros is the default; the family is only sent when it says
    // something.
    expect(first.fields).not.toHaveProperty("additionalMonthlyCosts");

    expect(second.fields.seasonality).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("collapses a manual row's hours/rate/fixed into the monthly total", () => {
    const plan = planFixture();
    const [painter, casual] = plan.manualRows;

    // Fixed amounts with a zero rate: the money is the total, and no rate can
    // be kept alongside it.
    expect(painter.description).toBe("Painter");
    expect(painter.departmentCode).toBe("D0430");
    expect(painter.department).toBe("Engineering");
    expect(painter.costAccount).toBe("A520201");
    expect(painter.rate).toBeNull();
    expect(painter.stats[0]).toBe(208);
    expect(painter.amounts[0]).toBeCloseTo(6427.52);

    // One rate all year with nothing fixed: kept rate-driven, so the row stays
    // editable the way it was.
    expect(casual.rate).toBe(12.5);
    expect(casual.amounts[0]).toBeCloseTo(1250);
  });

  it("imports the active allocations and excludes the blank departments", () => {
    const plan = planFixture();
    expect(plan.allocations).toEqual([
      {
        name: "% of Employee Meal Cost",
        spreadBase: "HEADCOUNT",
        excludedDepartments: ["D0430"],
      },
    ]);
    expect(
      plan.warnings.some((w) => /inject account/.test(w))
    ).toBe(true);
  });

  it("honours the per-sheet options", () => {
    const workbook = parseFixture();
    const plan = analyzeWorkbook(workbook, {
      filePath: "x",
      options: { calendarAndHours: false, manualInput: false, allocations: false },
      departmentNameByCode: new Map(),
    });
    expect(plan.manualRows).toEqual([]);
    expect(plan.allocations).toEqual([]);
    expect(plan.publicHolidaysByMonth).toBeNull();
    expect(plan.weeklyHours).toBeNull();
    // Positions and blocks are not optional — they are the import.
    expect(plan.positions).toHaveLength(2);
    expect(plan.blocks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

describe("commitImportPlan", () => {
  let localDb: Db;
  let secureDb: Db;
  let savedCalendar: CalendarYear | null;
  let savedDefaults: PositionDefaults | null;

  beforeEach(() => {
    localDb = new Database(":memory:");
    localDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
    applyBlocksStructureV12(localDb);
    localDb.exec(ALLOCATIONS_SQL);
    secureDb = new Database(":memory:");
    secureDb.exec(POSITIONS_VALUE_TABLES_SQL);
    secureDb.exec(MANUAL_INPUT_TABLES_SQL);

    ensureFieldCatalogSeed(localDb, OU);
    saveScenario(localDb, OU, { id: SCENARIO, year: YEAR, label: "Budget" });

    savedCalendar = null;
    savedDefaults = null;
  });

  function run(plan = planFixture()) {
    let counter = 0;
    return commitImportPlan(plan, {
      localDb,
      secureDb,
      scope: OU,
      scenarioId: SCENARIO,
      year: YEAR,
      now: NOW,
      newId: () => `id-${++counter}`,
      fieldLookup: buildFieldMap(getFieldCatalog(localDb, OU)),
      getCalendar: async () => savedCalendar,
      saveCalendar: async (calendar) => {
        savedCalendar = calendar;
      },
      getPositionDefaults: async () => ({
        ou: OU.ou,
        year: YEAR,
        weeklyHours: 35,
        fields: {
          yearlyDays: { value: 365, linked: true },
          daysOff: { value: 104, linked: true },
          pubHolidays: { value: 9, linked: true },
          dailyHours: { value: 7, linked: true },
        },
      }),
      savePositionDefaults: async (defaults) => {
        savedDefaults = defaults;
      },
    });
  }

  it("creates the blocks with their composite bases resolved to real ids", async () => {
    await run();

    const blocks = listBlocks(localDb, OU);
    const byLabel = new Map(blocks.map((block) => [block.label, block]));
    const food = byLabel.get("Food Allowance")!;
    const pension = byLabel.get("Pension")!;

    expect(pension.base).toEqual({
      kind: "COMPOSITE",
      includeBaseSalary: true,
      blockIds: [food.id],
    });

    // …and that compiles to the COMPONENTS selector the engine already sums,
    // with the base-salary head leading it.
    const definitions = getComponentDefinitions(localDb, OU);
    const pensionDef = definitions.find((def) => def.id === pension.costDefId)!;
    expect(pensionDef.spreadMethod).toBe("PERCENT_OF");
    expect(pensionDef.baseSelector).toEqual({
      kind: "COMPONENTS",
      componentIds: [`sys-base:${OU.ou}`, food.costDefId],
    });
  });

  it("writes the positions and their block inputs", async () => {
    const report = await run();
    expect(report.positionsCreated).toBe(2);

    const values = loadScenarioValues(secureDb, OU, SCENARIO);
    expect(values.positions).toHaveLength(2);
    const first = values.positions.find((p) => p.departmentCode === "D0400")!;
    expect(first.monthlyBaseSalary).toBe(10000);
    expect(first.payType).toBe("SALARIED");

    const blocks = listBlocks(localDb, OU);
    const transport = blocks.find((b) => b.label === "Transportation Allowance")!;
    const transportValue = values.componentValues.find(
      (value) =>
        value.componentDefId === transport.costDefId &&
        value.positionId === first.id
    )!;
    // FLAT_MONTHLY's per-month amount rides the yearlyValue slot.
    expect(transportValue.yearlyValue).toBe(500);

    const pension = blocks.find((b) => b.label === "Pension")!;
    const pensionValue = values.componentValues.find(
      (value) =>
        value.componentDefId === pension.costDefId && value.positionId === first.id
    )!;
    expect(pensionValue.rate).toBe(0.0585);
    // Unlocked account → the row carries its own.
    expect(pensionValue.accountCode).toBe("A565003");
  });

  it("writes manual input, allocations, holidays and the weekly hours", async () => {
    const report = await run();

    expect(listManualRows(secureDb, OU.ou, SCENARIO)).toHaveLength(2);
    expect(report.manualInputRowsCreated).toBe(2);

    const allocations = listAllocations(localDb, OU);
    expect(allocations.map((a) => a.name)).toEqual(["% of Employee Meal Cost"]);
    expect(allocations[0].excludedDepartments).toEqual(["D0430"]);

    expect(savedCalendar?.months.map((m) => m.publicHolidays)).toEqual([
      1, 0, 0, 2, 1, 2, 0, 1, 0, 0, 0, 2,
    ]);
    // Calendar days stay as the app derives them — the workbook's are ignored.
    expect(savedCalendar?.months[0].calendarDays).toBe(31);
    expect(savedDefaults?.weeklyHours).toBe(40);
    expect(report.weeklyHoursUpdated).toBe(40);
  });

  it("carries every warning through to the report", async () => {
    const plan = planFixture();
    const report = await run(plan);
    expect(report.warnings).toEqual(plan.warnings);
    expect(report.blocksCreated).toHaveLength(plan.blocks.length);
  });

  it("does not fail the whole import when an allocation name is taken", async () => {
    const plan = planFixture();
    // Same name already in this hotel — the repo refuses the duplicate.
    const { saveAllocation } = await import("../../allocations/repo");
    saveAllocation(
      localDb,
      OU,
      {
        name: "% of Employee Meal Cost",
        spreadBase: "FTE",
        excludedDepartments: [],
      },
      { now: NOW }
    );

    const report = await run(plan);
    expect(report.positionsCreated).toBe(2);
    expect(report.allocationsCreated).toEqual([]);
    expect(report.warnings.some((w) => /was not created/.test(w))).toBe(true);
  });
});
