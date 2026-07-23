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
// Note: the `employee` band's display label is "Position" — it only ever held
// the post's attributes (department, classification, job title), never the
// person's; the person lives under "Employee PII". Band labels come from the
// SECTIONS constant, which getFieldCatalog returns directly (never stored per
// OU), so relabelling a band needs no seed bump — only field changes do.
// v6: `departmentCode`'s dropdownSource gained `nameField: "deptName"`, wiring
// the Department picker to auto-fill the (now read-only) Dept Name column.
// v7: inverted that — the picker moved onto `deptName` (you search departments
// by name), and `departmentCode` became the read-only mirror it auto-fills, via
// `dropdownSource: { kind: "departments", codeField: "departmentCode" }`.
// dropdown_source is stored per OU and only re-applied when seed_version climbs,
// so these attribute changes need the bump to reach catalogs seeded earlier.
// v8: two changes.
//  (a) Classification (jobTypeCode) options no longer include "Hourly" — that was
//      a pay basis masquerading as a grade. Classification is now a clean set of
//      post grades (Manager, Manager (Non Exempt), Supervisor, Associate, Casual,
//      Buyout Labour); the salaried/hourly axis stays on Pay Basis (payType).
//  (b) Pay Basis (payType), Cluster, and headcount (relabelled "Count") moved
//      from the Contract band into Position — they describe the post, not its
//      contract mechanics, and sit next to Classification. "Count" is just the
//      headcount multiplier renamed; the key/column/engine are unchanged.
//      Relocating a field between bands relies on the seed re-applying sort_order
//      on a version bump (see ensureFieldCatalogSeed); without that the moved
//      field's band would draw its header twice.
// v9: Manhours Paid (yearlyManhoursPaid) became a read-only COMPUTED column —
//     paid days (Yearly Days − Days Off) × Daily Hours — instead of a free-entry
//     POSITION_EXTRA field. The bump re-applies storage/editable over catalogs
//     seeded earlier; any value previously typed into extra_values is ignored
//     (COMPUTED columns derive from the row, never read storage).
// v10: Hourly Rate (hourlyRate) added to the Basic Salary band — an alternate,
//     mutually-exclusive input to Monthly Basic that derives the base from
//     rate × hours worked (see engine reference.ts). New engine scalar column
//     hourly_rate on the positions table (migrated in schema.ts).
// v11: Daily Cost (dailyVacationCost) and Accrual Cost (accrualCostPerDay) removed
//     as inputs — a vacation/accrual day is now valued by the engine at the
//     position's derived per-working-day base pay (see engine reference.ts). The
//     bump retires the two fields from catalogs seeded earlier; their columns are
//     dropped from the positions table (schema.ts migration v5). "Estimated Cost"
//     (vacationEstimate) is now the engine-simulated Vacation Cost.
// v12: Accrual Days (accrualDaysPerMonth) stopped being an input — it is now a
//     read-only COMPUTED column, Yearly Days ÷ 12, so the monthly entitlement
//     always shows. Whether accruals are actually *generated* is decided by the
//     Accrual account: the value fed to the engine is zeroed for a position with
//     no accrual account (see loadScenarioInput / rowModel.rowToEnginePosition),
//     and the engine's existing accrualDays===0 guard suppresses the line. The
//     bump re-applies storage/editable over catalogs seeded earlier; the vestigial
//     accrual_days_per_month column is left in place (no longer read or written).
// v13: account columns sit beside the data they book, not bunched in Basic Salary.
//     Working Hours account (workingHoursAccount) moved into Contract, right after
//     Manhours Worked; Headcount account (headCountAccount) moved into Position,
//     right after Count. FTE account (fteAccount) dropped outright — FTE is a ratio
//     with no GL account of its own; ensureFieldCatalogSeed prunes retired keys, so
//     the column and its extra_values are cleaned up on the next seed. Both moves are
//     section + sort_order changes on POSITION_EXTRA fields (keys unchanged), so
//     stored values survive; the bump is what re-applies the new section/order to
//     catalogs seeded earlier (refresh is version-gated).
// v14: account fields gained a dropdown, seeded from the account_maps table and
//     narrowed per field — the picker searches by description (detail level max)
//     but stores the base_account code. The subset each field offers is carried
//     on its dropdownSource.filter: Headcount and Working Hours book to A9…
//     accounts; Salary, Accrual and Benefits book to A5…; the Home page's bank
//     holiday premium account (not a catalog field) uses the same A5… rule. The
//     prefixes are a first, broad pass to be narrowed later (see AccountFilter).
//     Filters are the only change, so stored account values survive; dropdown_source
//     is stored per OU and re-applied only when seed_version climbs, so the bump is
//     what reaches catalogs seeded earlier.
export const SEED_VERSION = 14;

/** base_account prefixes each account field books to — a first, broad pass the
 *  user will narrow later. Kept beside the seed so the A9/A5 split is stated
 *  once and every account field's filter reads from the same place. */
const HEADCOUNT_ACCOUNT_FILTER = { startsWith: ["A9"] };
const HOURS_ACCOUNT_FILTER = { startsWith: ["A9"] };
const SALARY_ACCOUNT_FILTER = { startsWith: ["A5"] };
const VACATION_ACCOUNT_FILTER = { startsWith: ["A5"] };

export const SECTIONS: SectionDef[] = [
  // The row gutter: select / active / row actions. Unlabelled on purpose —
  // it is a control strip, not data, and a band title over it would read as a
  // column heading for the checkboxes.
  { id: "control", label: "", order: 5 },
  { id: "pii", label: "Employee PII", order: 10 },
  { id: "employee", label: "Position", order: 15 },
  { id: "contract", label: "Contract", order: 20 },
  { id: "seasonality", label: "Working Months", order: 30 },
  { id: "basicSalary", label: "Basic Salary", order: 40 },
  { id: "vacation", label: "Vacation", order: 50 },
];

/** Job classification options. These name the *post* (grade/role band) only —
 *  the pay basis (salaried vs hourly) is a separate axis, carried by `payType`.
 *  "Hourly" used to live here, which conflated the two; it now belongs solely to
 *  Pay Basis. Values are free-form strings and double as the merit/stat lookup
 *  key (`cluster|jobTypeCode` in compile.ts), so any new classification needs a
 *  matching stat-table row to price it. */
const JOB_TYPE_OPTIONS = [
  "Manager",
  "Manager (Non Exempt)",
  "Supervisor",
  "Associate",
  "Casual",
  "Buyout Labour",
].map((value) => ({ value, label: value }));

const PAY_TYPE_OPTIONS = [
  { value: "SALARIED", label: "Salaried (30/360)" },
  { value: "HOURLY", label: "Hourly" },
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
  // The user picks a department by NAME (Dept Name is the dropdown); the code is
  // derived. departmentCode therefore holds no dropdown of its own — it is the
  // read-only mirror that `deptName`'s picker auto-fills (see columnFactory).
  sys("employee", "TEXT", "ENGINE", {
    key: "departmentCode",
    defaultLabel: "Department",
    locked: true,
  }),
  sys("employee", "TEXT", "POSITION_EXTRA", {
    key: "deptName",
    defaultLabel: "Dept Name",
    // Picking a name auto-fills `departmentCode` and renders it read-only.
    dropdownSource: { kind: "departments", codeField: "departmentCode" },
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
  // Pay basis and cluster describe the post's shape, not its contract mechanics,
  // so they band with Position. Pay basis (salaried 30/360 vs hourly real days)
  // still drives the engine's day-count; cluster still rolls positions up and
  // pairs with Classification as the merit/stat lookup key.
  sys("employee", "ENUM", "ENGINE", {
    key: "payType",
    defaultLabel: "Pay Basis",
    locked: true,
    dropdownSource: { kind: "static", options: PAY_TYPE_OPTIONS },
    defaultValue: "SALARIED",
  }),
  sys("employee", "TEXT", "ENGINE", {
    key: "cluster",
    defaultLabel: "Cluster",
    locked: true,
  }),
  // "Count" is the engine's headcount multiplier under a name that reads for
  // budgeting: one row with Count = 5 is five identical positions, and every cost
  // the engine derives is scaled by it (posHeadcount in compile.ts). Same `key`
  // and `headcount` column as before — only the label and band moved — so nothing
  // on the engine or write path changes.
  sys("employee", "NUMBER", "ENGINE", {
    key: "headcount",
    defaultLabel: "Count",
    locked: true,
    validation: { min: 0 },
    defaultValue: 1,
  }),
  // The account the headcount books to — sits right beside Count so the number
  // and the account it posts under read as one pair (moved out of Basic Salary
  // in v13). POSITION_EXTRA, so relocating it only changes its band + order.
  sys("employee", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "headCountAccount",
    defaultLabel: "Headcount",
    dropdownSource: { kind: "accounts", filter: HEADCOUNT_ACCOUNT_FILTER },
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
  // Manhours Paid is derived, not entered: paid days (yearly days − days off)
  // × daily contract hours. Read-only computed column (see rowModel COMPUTES).
  sys("contract", "NUMBER", "COMPUTED", {
    key: "yearlyManhoursPaid",
    defaultLabel: "Manhours Paid",
    locked: true,
    computeKey: "yearlyManhoursPaid",
  }),
  sys("contract", "NUMBER", "ENGINE", {
    key: "yearlyHoursWorked",
    defaultLabel: "Manhours Worked",
    locked: true,
    validation: { min: 0 },
  }),
  // The account worked hours book to — sits right beside Manhours Worked so the
  // hours and their posting account read as one pair (moved out of Basic Salary
  // in v13). POSITION_EXTRA, so relocating it only changes its band + order.
  sys("contract", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "workingHoursAccount",
    defaultLabel: "Working Hours",
    dropdownSource: { kind: "accounts", filter: HOURS_ACCOUNT_FILTER },
  }),
  sys("contract", "NUMBER", "ENGINE", {
    key: "fte",
    defaultLabel: "FTE",
    locked: true,
    validation: { min: 0, decimals: 2 },
    defaultValue: 1,
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
  // Two mutually-exclusive inputs: a fixed Monthly Basic, or an Hourly Rate that
  // drives the base from hours worked. Only one holds a value per row; the grid
  // locks the other (see rowModel.sanitizeRow + PositionsGrid.isCellEditable).
  sys("basicSalary", "NUMBER", "ENGINE", {
    key: "monthlyBaseSalary",
    defaultLabel: "Monthly Basic",
    locked: true,
    validation: { min: 0 },
  }),
  sys("basicSalary", "NUMBER", "ENGINE", {
    key: "hourlyRate",
    defaultLabel: "Hourly Rate",
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
  // Working Hours / Headcount accounts moved to sit beside their data columns
  // (Contract / Position) in v13; the FTE account was dropped. Salary is the one
  // account that belongs with the basic-salary figure, so it stays here.
  sys("basicSalary", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "salaryAccountCode",
    defaultLabel: "Salary",
    dropdownSource: { kind: "accounts", filter: SALARY_ACCOUNT_FILTER },
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
  // Auto-calculated, not entered: the monthly entitlement is Yearly Days ÷ 12.
  // Read-only COMPUTED, so it always shows the accrued amount; whether the
  // accrual is actually booked is gated separately by the Accrual account below.
  sys("vacation", "NUMBER", "COMPUTED", {
    key: "accrualDaysPerMonth",
    defaultLabel: "Accrual Days",
    locked: true,
    computeKey: "accrualDaysPerMonth",
  }),
  sys("vacation", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "accrualAccount",
    defaultLabel: "Accrual",
    dropdownSource: { kind: "accounts", filter: VACATION_ACCOUNT_FILTER },
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
    dropdownSource: { kind: "accounts", filter: VACATION_ACCOUNT_FILTER },
  }),
  sys("vacation", "NUMBER", "COMPUTED", {
    key: "vacationEstimate",
    defaultLabel: "Vacation Cost",
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
