/**
 * Oracle report import tests — parse, analyse and commit against in-memory
 * workbooks and databases.
 *
 * The fixture is built cell-by-cell in the real report layout (headings on row
 * 7, data from row 8, columns at the macro's fixed positions) rather than
 * checked in as a binary, so the expectations read as a description of the
 * report contract and a layout change fails loudly instead of silently
 * importing nonsense.
 *
 * The arithmetic cases each assert a number the old `Add_New_Rows_Oracle` macro
 * would have produced — they are the port-fidelity tests, and the reason to
 * trust the import at all.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import * as XLSX from "xlsx";

import {
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import { applyStructureColumns } from "../../blocks/schema";
import { resolveOuScope } from "../../positions/ouScope";
import {
  ensureFieldCatalogSeed,
  getFieldCatalog,
  saveScenario,
} from "../../positions/structureRepo";
import { listBlocks, saveBlock } from "../../blocks/repo";
import { batchWrite, loadScenarioValues } from "../../positions/positionsRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import type { BlockDto } from "../../../shared/blocks/ipc";
import {
  DEFAULT_ORACLE_IMPORT_OPTIONS,
  OracleImportOptions,
} from "../../../shared/oracleImport/ipc";

import { NotOracleReportError, parseOracleReport } from "../parseOracleReport";
import {
  analyzeOracleReport,
  buildAccountTemplates,
  deriveAnnualSalary,
  derivePublicHolidays,
  OracleAnalyzeContext,
  OracleStandards,
  toOracleDepartmentCode,
  toOracleIsoDate,
} from "../analyze";
import { commitOraclePlan } from "../commit";

type Db = InstanceType<typeof Database>;

const OU = resolveOuScope("OU12345");
const NOW = "2026-01-01T00:00:00.000Z";
const YEAR = 2026;
const SCENARIO = "scenario-1";

/** The reference hotel-year: exactly what Menu!O11/O12/O13 hold in the real
 *  Payroll Budget Tool 3.6.3 workbook. */
const STANDARDS: OracleStandards = {
  yearlyDays: 365,
  pubHolidays: 9,
  daysOff: 104,
  dailyHours: 8,
};

// ---------------------------------------------------------------------------
// Fixture report
// ---------------------------------------------------------------------------

type Cell = number | string;

function sheet(cells: Record<string, Cell>): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxRow = 0;
  let maxCol = 0;
  for (const [address, value] of Object.entries(cells)) {
    const { r, c } = XLSX.utils.decode_cell(address);
    maxRow = Math.max(maxRow, r);
    maxCol = Math.max(maxCol, c);
    ws[address] =
      typeof value === "number" ? { t: "n", v: value } : { t: "s", v: value };
  }
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: maxRow, c: maxCol },
  });
  return ws;
}

interface RowOptions {
  row: number;
  last?: string;
  first?: string;
  empNumber?: string;
  hireDate?: number | string;
  department?: string;
  contractHours?: number;
  daysPerWeek?: number;
  salary?: number;
  entitlement?: number;
}

/** One data row at the macro's column positions. */
function oracleRow(options: RowOptions): Record<string, Cell> {
  const {
    row,
    last = "Smith",
    first = "Ada",
    empNumber = `E${row}`,
    hireDate = 44607,
    department = "400",
    contractHours = 40,
    daysPerWeek = 5,
    salary = 30000,
    entitlement = 21,
  } = options;
  const cells: Record<string, Cell> = {
    [`A${row}`]: last,
    [`B${row}`]: first,
    [`AK${row}`]: contractHours,
    [`AL${row}`]: daysPerWeek,
    [`AN${row}`]: salary,
    [`AS${row}`]: entitlement,
  };
  if (empNumber !== "") cells[`E${row}`] = empNumber;
  if (hireDate !== "") cells[`Y${row}`] = hireDate;
  if (department !== "") cells[`AB${row}`] = department;
  return cells;
}

const DEFAULT_HEADERS: Record<string, Cell> = {
  A7: "EMPLOYEE LAST NAME",
  B7: "EMPLOYEE FIRST NAME",
  E7: "EMPLOYEE NUMBER",
  Y7: "HIRE DATE",
  AB7: "DEPARTMENT",
  AK7: "CONTRACT HOURS",
  AL7: "DAYS PER WEEK",
  AN7: "SALARY",
  AS7: "ANNUAL ENTITLEMENT",
};

/** A whole workbook: the report as the first sheet, plus a decoy second one so
 *  "worksheet 1" is genuinely exercised. */
function buildReport(
  rows: RowOptions[] = [{ row: 8 }],
  headerOverrides: Record<string, Cell> = {},
  headerRow = 7
): Buffer {
  const headers: Record<string, Cell> = {};
  for (const [address, value] of Object.entries(DEFAULT_HEADERS)) {
    const column = address.replace(/\d+$/, "");
    headers[`${column}${headerRow}`] = value;
  }
  const cells: Record<string, Cell> = { ...headers, ...headerOverrides };
  for (const row of rows) Object.assign(cells, oracleRow(row));

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet(cells), "Report");
  XLSX.utils.book_append_sheet(
    book,
    sheet({ A1: "EMPLOYEE LAST NAME", A2: "decoy" }),
    "Employee Data"
  );
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ---------------------------------------------------------------------------
// Analyze context
// ---------------------------------------------------------------------------

function context(
  overrides: Partial<OracleAnalyzeContext> = {}
): OracleAnalyzeContext {
  return {
    filePath: "C:/reports/oracle.xlsx",
    options: DEFAULT_ORACLE_IMPORT_OPTIONS,
    departmentNameByCode: new Map([["D0400", "Housekeeping"]]),
    standards: STANDARDS,
    existingEmpNumbers: new Map(),
    existingPositionCount: 0,
    accountTemplateByDepartment: new Map(),
    existingBlocks: [],
    ...overrides,
  };
}

function analyze(
  buffer: Buffer,
  overrides: Partial<OracleAnalyzeContext> = {}
) {
  return analyzeOracleReport(
    parseOracleReport(buffer, "oracle.xlsx"),
    context(overrides)
  );
}

/** A MULTIPLIER BlockDto as listBlocks would return it. */
function block(overrides: Partial<BlockDto> = {}): BlockDto {
  return {
    id: "block-1",
    ou: OU.ou,
    blockType: "MULTIPLIER",
    label: "Incentive 1",
    accountCode: "A560401",
    accountLocked: true,
    statsAccountCode: "",
    statsAccountLocked: true,
    base: { kind: "BASE_SALARY" },
    spread: "ACTIVE_MONTHS",
    increaseAware: false,
    departmentMode: "POSITION",
    sortOrder: 10,
    updatedAt: NOW,
    costDefId: "block-1:cost",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("cell coercion", () => {
  it("pads a department code to four digits and prefixes D", () => {
    expect(toOracleDepartmentCode("400")).toBe("D0400");
    expect(toOracleDepartmentCode("1120")).toBe("D1120");
    expect(toOracleDepartmentCode(400)).toBe("D0400");
    expect(toOracleDepartmentCode("D0400")).toBe("D0400");
    expect(toOracleDepartmentCode("")).toBe("");
  });

  it("reads Excel serials and DD-MON-YYYY, and refuses ambiguous slash dates", () => {
    expect(toOracleIsoDate(44607)).toBe("2022-02-15");
    expect(toOracleIsoDate("15-FEB-2022")).toBe("2022-02-15");
    expect(toOracleIsoDate("15 Feb 2022")).toBe("2022-02-15");
    expect(toOracleIsoDate("2022-02-15")).toBe("2022-02-15");
    // Slash dates are month-first to `new Date`, so a European export would
    // land ~every row on the wrong day. Refused rather than guessed.
    expect(toOracleIsoDate("15/02/2022")).toBeNull();
    expect(toOracleIsoDate("")).toBeNull();
  });
});

describe("the macro's derivations", () => {
  it("prorates the hotel's public holidays onto the row's working pattern", () => {
    // A standard five-day contract has the hotel's own 104 days off, so it takes
    // the hotel's public holidays unchanged.
    expect(derivePublicHolidays(104, STANDARDS)).toBeCloseTo(9, 10);
    // A four-day week: (365 - 156) / (365 - 104) * 9.
    expect(derivePublicHolidays(156, STANDARDS)).toBeCloseTo((209 / 261) * 9, 10);
  });

  it("falls back to the hotel's own figure when there is nothing to prorate", () => {
    const broken = { ...STANDARDS, yearlyDays: 104 };
    expect(derivePublicHolidays(104, broken)).toBe(9);
  });

  it("treats a salary over 100 as annual and anything else as an hourly rate", () => {
    expect(deriveAnnualSalary(30000, 40)).toBe(30000);
    expect(deriveAnnualSalary(12.5, 40)).toBe(26000);
    // Strictly greater than, exactly as the VBA — 100 takes the hourly branch.
    expect(deriveAnnualSalary(100, 40)).toBe(208000);
  });
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseOracleReport", () => {
  it("reads the first worksheet, the headings and every data row", () => {
    const report = parseOracleReport(
      buildReport([{ row: 8 }, { row: 9 }, { row: 10 }]),
      "oracle.xlsx"
    );
    expect(report.sheetName).toBe("Report");
    expect(report.headerRow).toBe(7);
    expect(report.rows).toHaveLength(3);
    expect(report.rows[0].sheetRow).toBe(8);
    expect(report.rows[0].cells[0]).toBe("Smith");
    expect(report.rows[0].cells[44]).toBe(21);
    expect(report.warnings).toEqual([]);
  });

  it("finds a shifted heading row and says so", () => {
    const report = parseOracleReport(
      buildReport([{ row: 9 }], {}, 8),
      "oracle.xlsx"
    );
    expect(report.headerRow).toBe(8);
    expect(report.rows).toHaveLength(1);
    expect(report.warnings.join(" ")).toContain("row 8");
  });

  it.each([
    ["A7", "EMPLOYEE LAST NAME"],
    ["AK7", "CONTRACT HOURS"],
    ["AN7", "SALARY"],
    ["AS7", "ANNUAL ENTITLEMENT"],
  ])("refuses a report whose %s does not say %s", (address) => {
    // A7 is the marker used to FIND the header row, so breaking it means the
    // header is never found; the other three fail their own assertion.
    expect(() =>
      parseOracleReport(buildReport([{ row: 8 }], { [address]: "SOMETHING ELSE" }), "x.xlsx")
    ).toThrow(NotOracleReportError);
  });

  it("accepts headings decorated with a unit or an asterisk", () => {
    const report = parseOracleReport(
      buildReport([{ row: 8 }], { AK7: "  contract hours (weekly)* " }),
      "oracle.xlsx"
    );
    expect(report.headers[36]).toBe("CONTRACT HOURS");
  });

  it("stops at the last populated column A and ignores a stray cell far below", () => {
    const buffer = buildReport([{ row: 8 }, { row: 9 }]);
    const book = XLSX.read(buffer, { type: "buffer" });
    const ws = book.Sheets["Report"];
    ws["C60"] = { t: "s", v: "stray" };
    ws["!ref"] = "A1:AS60";
    const rewritten = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(parseOracleReport(rewritten, "oracle.xlsx").rows).toHaveLength(2);
  });

  it("refuses a workbook with no associate rows", () => {
    expect(() => parseOracleReport(buildReport([]), "oracle.xlsx")).toThrow(
      NotOracleReportError
    );
  });
});

// ---------------------------------------------------------------------------
// Analyze — arithmetic
// ---------------------------------------------------------------------------

describe("analyzeOracleReport — the macro's arithmetic", () => {
  it("derives daily hours, days off and public holidays from the contract", () => {
    const plan = analyze(buildReport([{ row: 8, contractHours: 40, daysPerWeek: 5 }]));
    const fields = plan.positions[0].fields;
    expect(fields.dailyContractHours).toBe(8);
    expect(fields.contractDaysOff).toBe(104);
    expect(fields.contractPubHolidays).toBeCloseTo(9, 10);
    expect(fields.contractYearlyDays).toBe(365);
  });

  it("carries a part-time contract across as hours, not as a ratio", () => {
    const plan = analyze(
      buildReport([{ row: 8, contractHours: 13.5, daysPerWeek: 3 }])
    );
    const fields = plan.positions[0].fields;
    expect(fields.dailyContractHours).toBeCloseTo(4.5, 10);
    expect(fields.contractDaysOff).toBe(208);
    // FTE is COMPUTED since seed v24 — writing it would throw.
    expect(fields).not.toHaveProperty("fte");
    expect(fields).not.toHaveProperty("accrualDaysPerMonth");
    expect(fields).not.toHaveProperty("yearlyManhoursPaid");
  });

  it("writes an annual salary and the monthly figure the macro computed", () => {
    const plan = analyze(buildReport([{ row: 8, salary: 30000 }]));
    const fields = plan.positions[0].fields;
    expect(fields.salaryEntryMode).toBe("ANNUAL");
    expect(fields.annualBaseSalary).toBe(30000);
    expect(fields.monthlyBaseSalary).toBe(2500);
    expect(fields.payType).toBe("SALARIED");
  });

  it("annualises an hourly rate at rate x hours x 52 and warns", () => {
    const plan = analyze(
      buildReport([{ row: 8, salary: 12.5, contractHours: 40 }])
    );
    const fields = plan.positions[0].fields;
    expect(fields.annualBaseSalary).toBe(26000);
    expect(fields.monthlyBaseSalary).toBeCloseTo(26000 / 12, 10);
    expect(plan.warnings.join(" ")).toContain("hourly rate");
  });

  it("maps the department and reports codes the mapping tables do not know", () => {
    const plan = analyze(
      buildReport([
        { row: 8, department: "400" },
        { row: 9, department: "9999" },
      ])
    );
    expect(plan.positions[0].fields.departmentCode).toBe("D0400");
    expect(plan.positions[0].fields.deptName).toBe("Housekeeping");
    expect(plan.positions[1].fields.departmentCode).toBe("D9999");
    expect(plan.preview.unknownDepartments).toEqual(["D9999"]);
  });

  it("fills the fields the report does not supply", () => {
    const plan = analyze(buildReport([{ row: 8 }]));
    const fields = plan.positions[0].fields;
    expect(fields.jobTypeCode).toBe("Associate");
    expect(fields.headcount).toBe(1);
    expect(fields.active).toBe(true);
    expect(fields.seasonality).toEqual(Array(12).fill(1));
    expect(fields.increaseMonth).toBe(13);
    expect(plan.positions[0].pii).toMatchObject({
      lastName: "Smith",
      firstName: "Ada",
      hiringDate: "2022-02-15",
      title: "",
    });
  });
});

// ---------------------------------------------------------------------------
// Analyze — rows that do not come across
// ---------------------------------------------------------------------------

describe("analyzeOracleReport — skipped rows", () => {
  it("accounts for every row in the file", () => {
    const plan = analyze(
      buildReport([{ row: 8 }, { row: 9, daysPerWeek: 0 }, { row: 10, empNumber: "" }])
    );
    expect(plan.preview.fileRowCount).toBe(3);
    expect(plan.preview.positionCount + plan.preview.skipped.length).toBe(3);
  });

  it("skips a zero days-per-week rather than dividing by it", () => {
    // The VBA's On Error Resume Next left TempValue holding the PREVIOUS row's
    // daily hours here, and its `If Not IsNumeric` fallback to 8 was dead code.
    const plan = analyze(buildReport([{ row: 8, daysPerWeek: 0 }]));
    expect(plan.positions).toHaveLength(0);
    expect(plan.preview.skipped[0]).toMatchObject({
      sheetRow: 8,
      reason: "bad_days_per_week",
    });
  });

  it("skips unusable contract hours and salaries", () => {
    const plan = analyze(
      buildReport([
        { row: 8, contractHours: 0 },
        { row: 9, salary: "" as unknown as number },
      ])
    );
    expect(plan.preview.skipped.map((row) => row.reason)).toEqual([
      "bad_contract_hours",
      "bad_salary",
    ]);
  });

  it("skips anyone already in the plan and names the row they clash with", () => {
    const plan = analyze(buildReport([{ row: 8, empNumber: "00123" }]), {
      existingEmpNumbers: new Map([["00123", "Jones, Mary"]]),
    });
    expect(plan.positions).toHaveLength(0);
    expect(plan.preview.skipped[0]).toMatchObject({
      reason: "duplicate_in_plan",
      empNumber: "00123",
    });
    expect(plan.preview.skipped[0].detail).toContain("Jones, Mary");
  });

  it("keeps leading zeros, so 00123 and 123 are different people", () => {
    const plan = analyze(buildReport([{ row: 8, empNumber: "123" }]), {
      existingEmpNumbers: new Map([["00123", "Jones, Mary"]]),
    });
    expect(plan.positions).toHaveLength(1);
  });

  it("imports the first of a repeated employee number and skips the rest", () => {
    const plan = analyze(
      buildReport([
        { row: 8, empNumber: "E1", last: "First" },
        { row: 9, empNumber: "E1", last: "Second" },
      ])
    );
    expect(plan.positions).toHaveLength(1);
    expect(plan.positions[0].pii.lastName).toBe("First");
    expect(plan.preview.skipped[0]).toMatchObject({
      reason: "duplicate_in_file",
      sheetRow: 9,
    });
    expect(plan.preview.skipped[0].detail).toContain("row 8");
  });

  it("skips a row with no employee number, since it could never be de-duplicated", () => {
    const plan = analyze(buildReport([{ row: 8, empNumber: "" }]));
    expect(plan.preview.skipped[0].reason).toBe("no_emp_number");
  });
});

// ---------------------------------------------------------------------------
// Analyze — bands
// ---------------------------------------------------------------------------

describe("analyzeOracleReport — percentage bands", () => {
  it("creates both blocks on base salary with the account locked", () => {
    const plan = analyze(buildReport([{ row: 8 }]));
    const [levy, sick] = plan.bands;
    expect(levy.input).toMatchObject({
      blockType: "MULTIPLIER",
      label: "Apprenticeship Levy",
      accountCode: "A560401",
      accountLocked: true,
      base: { kind: "BASE_SALARY" },
    });
    expect(levy.rate).toBe(0.005);
    expect(levy.perRowAccountCode).toBeUndefined();
    expect(sick.input?.accountCode).toBe("A560307");
    expect(sick.rate).toBe(0.01);
    expect(plan.preview.bands.map((band) => band.disposition)).toEqual([
      "create",
      "create",
    ]);
  });

  it("reuses a block sitting on the account, whatever it is called", () => {
    // The legacy-migration case: that importer names these blocks after the
    // workbook's own row 2, which reads "Incentive Percentage 1/ Apprentice
    // Levy" — or literally "Incentive 1" when the row was blank.
    const plan = analyze(buildReport([{ row: 8 }]), {
      existingBlocks: [block({ id: "b1", label: "Incentive 1", accountCode: "A560401" })],
    });
    expect(plan.bands[0].existingBlockId).toBe("b1");
    expect(plan.bands[0].input).toBeUndefined();
    expect(plan.bands[0].preview).toMatchObject({
      disposition: "existing",
      label: "Incentive 1",
    });
  });

  it("matches the workbook's own long band label as a substring", () => {
    const plan = analyze(buildReport([{ row: 8 }]), {
      existingBlocks: [
        block({
          id: "b2",
          label: "Incentive Percentage 1/ Apprentice Levy",
          accountCode: "A560302",
        }),
      ],
    });
    expect(plan.bands[0].existingBlockId).toBe("b2");
    // The block's own account wins — we do not rewrite a configured block.
    expect(plan.bands[0].preview.accountCode).toBe("A560302");
  });

  it("calls out a matched block whose base is not base salary alone", () => {
    const plan = analyze(buildReport([{ row: 8 }]), {
      existingBlocks: [
        block({ id: "food", label: "Food Allowance", accountCode: "A1" }),
        block({
          id: "b3",
          label: "Apprentice Levy",
          accountCode: "A560401",
          base: { kind: "COMPOSITE", includeBaseSalary: true, blockIds: ["food"] },
        }),
      ],
    });
    expect(plan.bands[0].preview.baseDiffers).toBe(true);
    expect(plan.bands[0].preview.baseSummary).toBe("Base Salary + Food Allowance");
    expect(plan.warnings.join(" ")).toContain("not base salary alone");
  });

  it("writes a per-row account only when the matched block leaves it unlocked", () => {
    const locked = analyze(buildReport([{ row: 8 }]), {
      existingBlocks: [block({ id: "b4", accountLocked: true })],
    });
    expect(locked.bands[0].perRowAccountCode).toBeUndefined();

    const unlocked = analyze(buildReport([{ row: 8 }]), {
      existingBlocks: [block({ id: "b5", accountLocked: false })],
    });
    expect(unlocked.bands[0].perRowAccountCode).toBe("A560401");
  });

  it("does not match a block of another type on the same account", () => {
    const plan = analyze(buildReport([{ row: 8 }]), {
      existingBlocks: [
        block({ id: "b6", blockType: "FLAT_MONTHLY", label: "Sundry", accountCode: "A560401" }),
      ],
    });
    expect(plan.bands[0].existingBlockId).toBeUndefined();
    expect(plan.bands[0].input).toBeDefined();
    expect(plan.warnings.join(" ")).toContain("Sundry");
  });

  it("honours an explicit choice from the dialog, including off", () => {
    const options: OracleImportOptions = {
      inheritAccounts: true,
      bands: {
        apprenticeshipLevy: { mode: "existing", blockId: "b7", rate: 0.02 },
        paidSickEstimate: { mode: "off" },
      },
    };
    const plan = analyze(buildReport([{ row: 8 }]), {
      options,
      existingBlocks: [block({ id: "b7", label: "Chosen", accountCode: "A999" })],
    });
    expect(plan.bands[0]).toMatchObject({ existingBlockId: "b7", rate: 0.02 });
    expect(plan.bands[1].preview.disposition).toBe("off");
    expect(plan.bands[1].input).toBeUndefined();
    expect(plan.bands[1].existingBlockId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Analyze — account inheritance
// ---------------------------------------------------------------------------

describe("account inheritance", () => {
  const rows = [
    {
      departmentCode: "D0400",
      updatedAt: "2026-01-01",
      extraValues: { salaryAccountCode: "A520001", headCountAccount: "A972540" },
    },
    {
      departmentCode: "D0400",
      updatedAt: "2026-01-02",
      extraValues: { salaryAccountCode: "A520001" },
    },
    {
      departmentCode: "D0410",
      updatedAt: "2026-01-03",
      extraValues: { salaryAccountCode: "A520002" },
    },
  ];

  it("takes the modal account per department, and a plan-wide fallback", () => {
    const templates = buildAccountTemplates(rows);
    expect(templates.get("D0400")?.salaryAccountCode).toBe("A520001");
    expect(templates.get("D0410")?.salaryAccountCode).toBe("A520002");
    expect(templates.get("")?.salaryAccountCode).toBe("A520001");
  });

  it("gives a new row its own department's accounts", () => {
    const plan = analyze(buildReport([{ row: 8, department: "400" }]), {
      accountTemplateByDepartment: buildAccountTemplates(rows),
    });
    expect(plan.positions[0].fields.salaryAccountCode).toBe("A520001");
    expect(plan.positions[0].fields.headCountAccount).toBe("A972540");
    expect(
      plan.preview.sourcedFields.find((f) => f.label === "Posting accounts")?.source
    ).toBe("department");
  });

  it("falls back to the plan-wide pattern for a department with no rows yet", () => {
    const plan = analyze(buildReport([{ row: 8, department: "0777" }]), {
      accountTemplateByDepartment: buildAccountTemplates(rows),
    });
    expect(plan.positions[0].fields.salaryAccountCode).toBe("A520001");
  });

  it("leaves the accounts blank when inheriting is turned off", () => {
    const plan = analyze(buildReport([{ row: 8, department: "400" }]), {
      options: { ...DEFAULT_ORACLE_IMPORT_OPTIONS, inheritAccounts: false },
      accountTemplateByDepartment: buildAccountTemplates(rows),
    });
    expect(plan.positions[0].fields.salaryAccountCode).toBe("");
    expect(plan.positions[0].fields.accrualAccount).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

describe("commitOraclePlan", () => {
  let localDb: Db;
  let secureDb: Db;

  beforeEach(() => {
    localDb = new Database(":memory:");
    localDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
    applyStructureColumns(localDb);
    secureDb = new Database(":memory:");
    secureDb.exec(POSITIONS_VALUE_TABLES_SQL);

    ensureFieldCatalogSeed(localDb, OU);
    saveScenario(localDb, OU, { id: SCENARIO, year: YEAR, label: "Planning" });

    // Two positions already in the plan, so the append path is real.
    batchWrite(
      secureDb,
      OU,
      {
        ou: OU.ou,
        scenarioId: SCENARIO,
        creates: [
          {
            id: "existing-1",
            fields: { departmentCode: "D0400", monthlyBaseSalary: 1000 },
            pii: { empNumber: "OLD-1", lastName: "Jones", firstName: "Mary" },
          },
          {
            id: "existing-2",
            fields: { departmentCode: "D0400", monthlyBaseSalary: 2000 },
            pii: { empNumber: "OLD-2", lastName: "Patel", firstName: "Sam" },
          },
        ],
      },
      buildFieldMap(getFieldCatalog(localDb, OU))
    );
  });

  function run(plan = analyze(buildReport([{ row: 8 }, { row: 9 }]))) {
    let counter = 0;
    return commitOraclePlan(plan, {
      localDb,
      secureDb,
      scope: OU,
      scenarioId: SCENARIO,
      now: NOW,
      newId: () => `new-${++counter}`,
      fieldLookup: buildFieldMap(getFieldCatalog(localDb, OU)),
    });
  }

  it("appends the positions and leaves the existing ones untouched", () => {
    const before = loadScenarioValues(secureDb, OU, SCENARIO).positions;
    const report = run();

    expect(report.positionsCreated).toBe(2);
    const after = loadScenarioValues(secureDb, OU, SCENARIO).positions;
    expect(after).toHaveLength(4);

    for (const original of before) {
      const still = after.find((position) => position.id === original.id)!;
      expect(still).toEqual(original);
    }
  });

  it("creates the two blocks and puts the rates on their cost definitions only", () => {
    const report = run();
    expect(report.blocksCreated).toEqual([
      "Apprenticeship Levy",
      "Paid Sick Estimate",
    ]);
    expect(report.blocksReused).toEqual([]);

    const blocks = listBlocks(localDb, OU);
    const levy = blocks.find((b) => b.label === "Apprenticeship Levy")!;
    const values = loadScenarioValues(secureDb, OU, SCENARIO).componentValues;

    const levyValues = values.filter((v) => v.componentDefId === levy.costDefId);
    expect(levyValues).toHaveLength(2);
    expect(levyValues.every((v) => v.rate === 0.005)).toBe(true);
    // A locked block discards a per-row account, so none is written.
    expect(levyValues.every((v) => v.accountCode === null)).toBe(true);
    // The pre-existing rows are not given a rate.
    expect(levyValues.some((v) => v.positionId.startsWith("existing"))).toBe(false);
    // And nothing lands on the stat definition.
    expect(values.some((v) => v.componentDefId.endsWith(":stat"))).toBe(false);
  });

  it("writes a per-row account when the matched block leaves it unlocked", () => {
    const blockId = saveBlock(
      localDb,
      OU,
      {
        blockType: "MULTIPLIER",
        label: "Apprentice Levy",
        accountCode: "A560401",
        accountLocked: false,
        base: { kind: "BASE_SALARY" },
      },
      { now: NOW }
    );
    const plan = analyze(buildReport([{ row: 8 }]), {
      existingBlocks: listBlocks(localDb, OU),
    });
    run(plan);

    const costDefId = listBlocks(localDb, OU).find((b) => b.id === blockId)!.costDefId;
    const values = loadScenarioValues(secureDb, OU, SCENARIO).componentValues.filter(
      (v) => v.componentDefId === costDefId
    );
    expect(values).toHaveLength(1);
    expect(values[0].accountCode).toBe("A560401");
  });

  it("reuses blocks it already created rather than duplicating them", () => {
    run();
    const plan = analyze(buildReport([{ row: 20, empNumber: "LATER" }]), {
      existingBlocks: listBlocks(localDb, OU),
    });
    const report = commitOraclePlan(plan, {
      localDb,
      secureDb,
      scope: OU,
      scenarioId: SCENARIO,
      now: NOW,
      newId: () => "later-1",
      fieldLookup: buildFieldMap(getFieldCatalog(localDb, OU)),
    });

    expect(report.blocksCreated).toEqual([]);
    expect(report.blocksReused).toEqual([
      "Apprenticeship Levy",
      "Paid Sick Estimate",
    ]);
    expect(listBlocks(localDb, OU)).toHaveLength(2);
  });

  it("is a no-op on a second run of the same file", () => {
    run();

    // The handler rebuilds the plan against live PII, so the second pass sees
    // everyone it just wrote.
    const pii = loadScenarioValues(secureDb, OU, SCENARIO);
    expect(pii.positions).toHaveLength(4);
    const secondPlan = analyze(buildReport([{ row: 8 }, { row: 9 }]), {
      existingEmpNumbers: new Map([
        ["E8", "Smith, Ada"],
        ["E9", "Smith, Ada"],
      ]),
      existingBlocks: listBlocks(localDb, OU),
    });
    const report = commitOraclePlan(secondPlan, {
      localDb,
      secureDb,
      scope: OU,
      scenarioId: SCENARIO,
      now: NOW,
      newId: () => "should-not-be-used",
      fieldLookup: buildFieldMap(getFieldCatalog(localDb, OU)),
    });

    expect(report.positionsCreated).toBe(0);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped.every((row) => row.reason === "duplicate_in_plan")).toBe(true);
    expect(loadScenarioValues(secureDb, OU, SCENARIO).positions).toHaveLength(4);
  });

  it("rolls the positions back as one when the write fails", () => {
    const plan = analyze(buildReport([{ row: 8 }, { row: 9 }]));
    // Any unknown field key makes batchWrite throw partway through the batch.
    plan.positions[1].fields.notAFieldKey = 1;

    expect(() => run(plan)).toThrow();
    // Both blocks exist, and a MULTIPLIER with no per-row rate contributes
    // nothing to a budget — that leftover is the whole blast radius.
    expect(listBlocks(localDb, OU)).toHaveLength(2);
    expect(loadScenarioValues(secureDb, OU, SCENARIO).positions).toHaveLength(2);
  });

  it("carries the skipped rows and warnings through to the report", () => {
    const plan = analyze(buildReport([{ row: 8 }, { row: 9, daysPerWeek: 0 }]));
    const report = run(plan);
    expect(report.skipped).toEqual(plan.preview.skipped);
    expect(report.warnings).toEqual(plan.warnings);
  });
});
