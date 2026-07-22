/**
 * Built-in (SYSTEM) field catalog seed.
 * -----------------------------------------------------------
 * The single source of truth for the columns Kairos ships with. The structure
 * repo pushes this into `field_catalog` per OU on first read and re-applies it
 * whenever SEED_VERSION is bumped — updating system-owned attributes while
 * preserving everything the user owns (custom_label, sort_order, visible).
 *
 * Adding/changing a system field = edit this file + bump SEED_VERSION.
 * No SQL migration needed. Array order = default display order.
 */

import { MONTH_LABELS } from "../calendar";
import {
  FieldCatalog,
  FieldDef,
  SectionDef,
  SectionId,
  VectorName,
  vectorKey,
} from "./fields";

// v2: dropped the redundant "CONTRACT - " label prefixes — the column group
// header already names the section, so the prefix only ate the width that
// distinguishes one column from the next.
// v3: split the old "Employee" band in two. `pii` now holds ONLY the four
// identity columns — it is the band the "+" button extends, and every column
// under it is PII (maskable, encrypted store). Everything that merely describes
// the post rather than the person moved to the new `employee` band.
// v4: Job Title stopped being maskable — it names the post, not the person.
// Catalogs seeded at v3 still carry maskable=1 for it, so the bump is what
// re-applies the system-owned attributes over them.
// v5: added `active` at the head of the Employee band. Positions now persist
// across years (a scenario copy rolls them forward), so there has to be a way
// to say "this post isn't budgeted this year" without deleting the row.
export const SEED_VERSION = 5;

export const SECTIONS: SectionDef[] = [
  // The row gutter: select / active / row actions. Unlabelled on purpose —
  // it is a control strip, not data, and a band title over it would read as a
  // column heading for the checkboxes.
  { id: "control", label: "", order: 5 },
  { id: "pii", label: "Employee PII", order: 10 },
  { id: "employee", label: "Employee", order: 15 },
  { id: "contract", label: "Contract", order: 20 },
  { id: "seasonality", label: "Working Months", order: 30 },
  { id: "basicSalary", label: "Basic Salary", order: 40 },
  { id: "vacation", label: "Vacation", order: 50 },
];

/** Job classification options (the workbook's Manager/Hourly/Supervisor/Casual). */
const JOB_TYPE_OPTIONS = ["Manager", "Hourly", "Supervisor", "Casual"].map(
  (value) => ({ value, label: value })
);

const PAY_TYPE_OPTIONS = [
  { value: "SALARIED", label: "Salaried (30/360)" },
  { value: "HOURLY", label: "Hourly (real days)" },
];

type SeedOverrides = Partial<FieldDef> & Pick<FieldDef, "key" | "defaultLabel">;

/** Fill the invariants every system field shares; sortOrder is assigned in a
 *  final pass from array position. */
function sys(
  section: SectionId,
  dataType: FieldDef["dataType"],
  storage: FieldDef["storage"],
  overrides: SeedOverrides
): FieldDef {
  return {
    section,
    dataType,
    storage,
    origin: "SYSTEM",
    locked: false,
    customLabel: null,
    visible: true,
    editable: storage !== "COMPUTED",
    maskable: false,
    sortOrder: 0,
    ...overrides,
  };
}

/** One field per month for an engine vector (sea_1..sea_12 etc). */
function monthFamily(
  section: SectionId,
  vector: VectorName,
  labelFor: (month: string) => string,
  base: Omit<Partial<FieldDef>, "key">
): FieldDef[] {
  return MONTH_LABELS.map((month, index) =>
    sys(section, "NUMBER", "ENGINE", {
      key: vectorKey(vector, index + 1),
      defaultLabel: labelFor(month),
      locked: true,
      vector,
      monthIndex: index + 1,
      ...base,
    })
  );
}

const SEED: FieldDef[] = [
  // ── Employee PII (the four identity columns) ──────────────────────
  sys("pii", "DATE", "PII_CORE", {
    key: "hiringDate",
    defaultLabel: "Hiring Date",
    locked: true,
    maskable: true,
  }),
  sys("pii", "TEXT", "PII_CORE", {
    key: "empNumber",
    defaultLabel: "Emp Number",
    locked: true,
    maskable: true,
  }),
  sys("pii", "TEXT", "PII_CORE", {
    key: "lastName",
    defaultLabel: "Last Name",
    locked: true,
    maskable: true,
  }),
  sys("pii", "TEXT", "PII_CORE", {
    key: "firstName",
    defaultLabel: "First Name",
    locked: true,
    maskable: true,
  }),
  // ── Control gutter ────────────────────────────────────────────────
  // Active is a switch for the whole row rather than a property of it, so it
  // sits in the frozen gutter beside the selection checkbox and the row menu,
  // not inside a data band. Unchecking retains the row across years (it still
  // rolls forward with a scenario copy) while removing it from the budget.
  sys("control", "BOOLEAN", "ENGINE", {
    key: "active",
    defaultLabel: "Active",
    locked: true,
    defaultValue: true,
  }),

  // ── Employee (the post, not the person) ───────────────────────────
  sys("employee", "TEXT", "ENGINE", {
    key: "departmentCode",
    defaultLabel: "Department",
    locked: true,
    dropdownSource: { kind: "departments" },
  }),
  sys("employee", "TEXT", "POSITION_EXTRA", {
    key: "deptName",
    defaultLabel: "Dept Name",
  }),
  sys("employee", "ENUM", "ENGINE", {
    key: "jobTypeCode",
    defaultLabel: "Classification",
    locked: true,
    dropdownSource: { kind: "static", options: JOB_TYPE_OPTIONS },
  }),
  // Job title describes the post, not the person — it bands with Employee and
  // is NOT masked. It keeps its `position_pii` column purely as storage.
  sys("employee", "TEXT", "PII_CORE", {
    key: "title",
    defaultLabel: "Job Title",
  }),

  // ── Contract ──────────────────────────────────────────────────────
  sys("contract", "NUMBER", "POSITION_EXTRA", {
    key: "contractYearlyDays",
    defaultLabel: "Yearly Days",
    validation: { min: 0, max: 366 },
  }),
  sys("contract", "NUMBER", "POSITION_EXTRA", {
    key: "contractDaysOff",
    defaultLabel: "Days Off",
    validation: { min: 0, max: 366 },
  }),
  sys("contract", "NUMBER", "POSITION_EXTRA", {
    key: "contractPubHolidays",
    defaultLabel: "Public Holidays",
    validation: { min: 0, max: 366 },
  }),
  sys("contract", "NUMBER", "ENGINE", {
    key: "dailyContractHours",
    defaultLabel: "Daily Hours",
    locked: true,
    validation: { min: 0, max: 24 },
  }),
  sys("contract", "NUMBER", "POSITION_EXTRA", {
    key: "yearlyManhoursPaid",
    defaultLabel: "Manhours Paid",
    validation: { min: 0 },
  }),
  sys("contract", "NUMBER", "ENGINE", {
    key: "yearlyHoursWorked",
    defaultLabel: "Manhours Worked",
    locked: true,
    validation: { min: 0 },
  }),
  sys("contract", "NUMBER", "ENGINE", {
    key: "headcount",
    defaultLabel: "Headcount",
    locked: true,
    validation: { min: 0 },
    defaultValue: 1,
  }),
  sys("contract", "NUMBER", "ENGINE", {
    key: "fte",
    defaultLabel: "FTE",
    locked: true,
    validation: { min: 0, decimals: 2 },
    defaultValue: 1,
  }),
  sys("contract", "TEXT", "ENGINE", {
    key: "cluster",
    defaultLabel: "Cluster",
    locked: true,
  }),
  sys("contract", "ENUM", "ENGINE", {
    key: "payType",
    defaultLabel: "Pay Basis",
    locked: true,
    dropdownSource: { kind: "static", options: PAY_TYPE_OPTIONS },
    defaultValue: "SALARIED",
  }),

  // ── Seasonality ───────────────────────────────────────────────────
  ...monthFamily("seasonality", "seasonality", (m) => `Working ${m}`, {
    validation: { min: 0, max: 1, decimals: 2 },
    defaultValue: 1,
  }),
  sys("seasonality", "NUMBER", "COMPUTED", {
    key: "totalWorkingMonths",
    defaultLabel: "Total Months",
    locked: true,
    computeKey: "totalWorkingMonths",
  }),

  // ── Basic Salary ──────────────────────────────────────────────────
  sys("basicSalary", "NUMBER", "ENGINE", {
    key: "monthlyBaseSalary",
    defaultLabel: "Monthly Basic",
    locked: true,
    validation: { min: 0 },
  }),
  ...monthFamily(
    "basicSalary",
    "additionalMonthlyCosts",
    (m) => `Additional Cost ${m}`,
    {}
  ),
  sys("basicSalary", "NUMBER", "COMPUTED", {
    key: "fullYearWage",
    defaultLabel: "Full Year Wage",
    locked: true,
    computeKey: "fullYearWage",
  }),
  sys("basicSalary", "PERCENT", "ENGINE", {
    key: "meritIncreasePct",
    defaultLabel: "Merit Increase",
    locked: true,
    validation: { min: 0, max: 10, decimals: 4 },
  }),
  sys("basicSalary", "NUMBER", "ENGINE", {
    key: "manualYearlyIncrease",
    defaultLabel: "Manual Increase",
    locked: true,
  }),
  sys("basicSalary", "ENUM", "ENGINE", {
    key: "increaseMonth",
    defaultLabel: "Increase Month",
    locked: true,
    dropdownSource: { kind: "months" },
    defaultValue: 13,
  }),
  sys("basicSalary", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "workingHoursAccount",
    defaultLabel: "Working Hours",
    dropdownSource: { kind: "accounts" },
  }),
  sys("basicSalary", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "headCountAccount",
    defaultLabel: "Headcount",
    dropdownSource: { kind: "accounts" },
  }),
  sys("basicSalary", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "fteAccount",
    defaultLabel: "FTE",
    dropdownSource: { kind: "accounts" },
  }),
  sys("basicSalary", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "salaryAccountCode",
    defaultLabel: "Salary",
    dropdownSource: { kind: "accounts" },
  }),
  sys("basicSalary", "NUMBER", "COMPUTED", {
    key: "budgetYearBasicSalary",
    defaultLabel: "Budget Year Total",
    locked: true,
    computeKey: "budgetYearBasicSalary",
  }),

  // ── Vacation ──────────────────────────────────────────────────────
  sys("vacation", "NUMBER", "ENGINE", {
    key: "vacationDays",
    defaultLabel: "Yearly Days",
    locked: true,
    validation: { min: 0, max: 366 },
  }),
  sys("vacation", "NUMBER", "ENGINE", {
    key: "dailyVacationCost",
    defaultLabel: "Daily Cost",
    locked: true,
    validation: { min: 0 },
  }),
  sys("vacation", "NUMBER", "ENGINE", {
    key: "accrualDaysPerMonth",
    defaultLabel: "Accrual Days",
    locked: true,
    validation: { min: 0, max: 31 },
  }),
  sys("vacation", "NUMBER", "ENGINE", {
    key: "accrualCostPerDay",
    defaultLabel: "Accrual Cost",
    locked: true,
    validation: { min: 0 },
  }),
  sys("vacation", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "accrualAccount",
    defaultLabel: "Accrual",
    dropdownSource: { kind: "accounts" },
  }),
  ...monthFamily(
    "vacation",
    "vacationMonthlyWeights",
    (m) => `Vacation % ${m}`,
    { validation: { min: 0, max: 1, decimals: 4 } }
  ),
  sys("vacation", "NUMBER", "COMPUTED", {
    key: "vacationWeightsTotal",
    defaultLabel: "Total Weights",
    locked: true,
    computeKey: "vacationWeightsTotal",
  }),
  sys("vacation", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "benefitsAccountCode",
    defaultLabel: "Benefits",
    dropdownSource: { kind: "accounts" },
  }),
  sys("vacation", "NUMBER", "COMPUTED", {
    key: "vacationEstimate",
    defaultLabel: "Estimated Cost",
    locked: true,
    computeKey: "vacationEstimate",
  }),
];

/** Display order = array order. */
export const SYSTEM_FIELD_SEED: FieldDef[] = SEED.map((field, index) => ({
  ...field,
  sortOrder: (index + 1) * 10,
}));

export const BUILTIN_CATALOG: FieldCatalog = {
  sections: SECTIONS,
  fields: SYSTEM_FIELD_SEED,
};
