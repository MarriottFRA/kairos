/**
 * Turn a parsed Oracle report into a plan: which positions to create, which
 * rows to skip and why, and which block each percentage band lands on.
 *
 * Pure — every database read happens in the IPC handler and arrives through
 * `OracleAnalyzeContext`, so the whole of this file unit-tests without Electron
 * or SQLite. Nothing here writes; `commit.ts` applies what this produces.
 *
 * The arithmetic is the `Add_New_Rows_Oracle` macro's, restated once in
 * `planPosition` so it is greppable against the VBA. Three of the macro's bugs
 * are deliberately NOT ported (see PER-ROW SHAPE ASSERTIONS); one of its
 * inconsistencies deliberately IS.
 */

import {
  BlockBaseRef,
  BlockDto,
  BlockInput,
} from "../../shared/blocks/ipc";
import {
  ORACLE_BAND_KEYS,
  ORACLE_BAND_LABELS,
  OracleBandKey,
  OracleBandPreview,
  OracleBlockOption,
  OracleImportOptions,
  OracleImportPreview,
  OracleSampleRow,
  OracleSkippedRow,
  OracleSourcedField,
} from "../../shared/oracleImport/ipc";
import { OracleReport, OracleRow } from "./parseOracleReport";

const MONTHS = 12;

/** How many parsed rows the confirm dialog shows verbatim. */
const SAMPLE_ROW_COUNT = 5;

/** 0-based cell indices, straight off the macro's column letters. */
const COL = {
  lastName: 0, // A
  firstName: 1, // B
  empNumber: 4, // E
  hiringDate: 24, // Y
  department: 27, // AB
  weeklyHours: 36, // AK
  daysPerWeek: 37, // AL
  salary: 39, // AN
  annualEntitlement: 44, // AS
} as const;

/**
 * A salary at or below this is an hourly rate, not an annual figure — the
 * macro's own test, kept exactly (strictly greater than, so 100 is hourly).
 */
const HOURLY_SALARY_THRESHOLD = 100;

const WEEKS_PER_YEAR = 52;
const DAYS_PER_WEEK = 7;

/**
 * The two hardcoded bands. `labelNeedles` are matched as substrings because a
 * hotel that came through the legacy importer has these blocks labelled from
 * the workbook's own row 2, which reads
 * "Incentive Percentage 1/ Apprentice Levy" — an equality test would miss it
 * and create a duplicate column.
 */
interface BandSpec {
  canonicalLabel: string;
  rate: number;
  accountCode: string;
  labelNeedles: string[];
}

export const BAND_SPECS: Record<OracleBandKey, BandSpec> = {
  apprenticeshipLevy: {
    canonicalLabel: ORACLE_BAND_LABELS.apprenticeshipLevy,
    rate: 0.005,
    accountCode: "A560401",
    labelNeedles: ["apprentice"],
  },
  paidSickEstimate: {
    canonicalLabel: ORACLE_BAND_LABELS.paidSickEstimate,
    rate: 0.01,
    accountCode: "A560307",
    labelNeedles: ["paid sick", "sick estimate", "sick pay"],
  },
};

// ---------------------------------------------------------------------------
// Cell coercion
//
// Mirrors legacyImport/analyze.ts — deliberately duplicated rather than
// imported. That feature's contract says it is deletable once the last hotel
// has migrated (see shared/legacyImport/ipc.ts), and importing from it here
// would silently make it permanent.
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A finite number, or null where the cell says nothing usable. */
function optionalNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** A GL account as Kairos stores it: the app-standard "A" prefix. */
export function toOracleAccountCode(value: unknown): string {
  const raw = text(value);
  if (!raw || raw.toLowerCase() === "blank") return "";
  const digits = raw.replace(/^A/i, "");
  return /^\d+$/.test(digits) ? `A${digits}` : raw.toUpperCase();
}

/**
 * A department as Kairos stores it. The macro left-pads the code to four digits
 * (`Left("0000", 4 - Len(x)) & x`) before writing it, and the Excel sheet holds
 * it as text — "0400". Kairos prefixes "D".
 */
export function toOracleDepartmentCode(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";
  const digits = raw.replace(/^D/i, "");
  if (!/^\d+$/.test(digits)) return raw.toUpperCase();
  return `D${digits.length < 4 ? digits.padStart(4, "0") : digits}`;
}

const MONTH_ABBREVIATIONS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function isoFromParts(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * A hiring date as an ISO day string.
 *
 * Excel serials and the `DD-MON-YYYY` form Oracle emits are accepted; anything
 * else returns null and the row is reported. Notably `15/02/2022` is REFUSED
 * rather than parsed: `new Date` reads slash dates month-first, so a European
 * export would silently land ~5000 rows on the wrong day. A missing hiring date
 * costs nothing in the budget; a wrong one is invisible.
 */
export function toOracleIsoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel's epoch is 1899-12-30 once its 1900 leap-year quirk is absorbed.
    const ms = Date.UTC(1899, 11, 30) + Math.round(value) * 86400000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return isoFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = raw.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/);
  if (dmy) {
    const month = MONTH_ABBREVIATIONS[dmy[2].slice(0, 3).toUpperCase()];
    if (!month) return null;
    const rawYear = Number(dmy[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return isoFromParts(year, month, Number(dmy[1]));
  }
  return null;
}

/** Employee numbers compare case-insensitively but keep their leading zeros —
 *  "00123" and "123" are different people in some HR systems. */
export function normalizeEmpNumber(value: unknown): string {
  return text(value).toUpperCase();
}

// ---------------------------------------------------------------------------
// The macro's derivations
// ---------------------------------------------------------------------------

/** Menu!O11 / O12 / O13, plus the hotel's standard working day. */
export interface OracleStandards {
  /** Menu!O11 — calendar days in the year. */
  yearlyDays: number;
  /** Menu!O12 — public holidays. */
  pubHolidays: number;
  /** Menu!O13 — days off / weekends. */
  daysOff: number;
  /** Weekly hours ÷ 5. The fallback the macro hardcoded as 8. */
  dailyHours: number;
}

/**
 * `(Menu!O11 - rowDaysOff) / (Menu!O11 - Menu!O13) * Menu!O12` — the macro's
 * proration of the hotel's public holidays onto a row's own working pattern.
 *
 * With no usable denominator the hotel's own figure is the least-wrong answer;
 * the caller warns when that happens.
 */
export function derivePublicHolidays(
  daysOffRow: number,
  standards: OracleStandards
): number {
  const denominator = standards.yearlyDays - standards.daysOff;
  if (!(denominator > 0)) return standards.pubHolidays;
  const value =
    ((standards.yearlyDays - daysOffRow) / denominator) * standards.pubHolidays;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The macro's salary branch: over 100 the figure is an annual salary, at or
 * below it an hourly rate to be annualised at `rate × weekly hours × 52`.
 */
export function deriveAnnualSalary(salary: number, weeklyHours: number): number {
  return salary > HOURLY_SALARY_THRESHOLD
    ? salary
    : salary * weeklyHours * WEEKS_PER_YEAR;
}

// ---------------------------------------------------------------------------
// Context and plan
// ---------------------------------------------------------------------------

/**
 * The posting accounts a new row inherits from its department.
 *
 * Four, not five: the headcount account left this template in seed v26, when it
 * became a calculated column fixed by Classification. Copying a department's
 * modal answer for it would be both pointless and impossible to store.
 */
export interface DepartmentAccountTemplate {
  salaryAccountCode: string;
  workingHoursAccount: string;
  accrualAccount: string;
  benefitsAccountCode: string;
}

export const ACCOUNT_TEMPLATE_KEYS: Array<keyof DepartmentAccountTemplate> = [
  "salaryAccountCode",
  "workingHoursAccount",
  "accrualAccount",
  "benefitsAccountCode",
];

export const EMPTY_ACCOUNT_TEMPLATE: DepartmentAccountTemplate = {
  salaryAccountCode: "",
  workingHoursAccount: "",
  accrualAccount: "",
  benefitsAccountCode: "",
};

/** The shape `buildAccountTemplates` needs off an existing position row. */
export interface AccountSourceRow {
  departmentCode: string;
  extraValues: Record<string, unknown>;
  updatedAt: string;
}

/**
 * What each department in this plan already does with its posting accounts.
 *
 * A GL account is genuinely a property of the department — a new hire in
 * Housekeeping should book exactly where every other Housekeeping row books —
 * and the plan already holds the answer, so the modal non-empty value per
 * (department, field) is used, tie-broken by the most recently edited row. The
 * "" key holds the same calculation across the whole plan, as a fallback for a
 * department with no rows yet.
 *
 * Classification is deliberately NOT derived this way: a department holds
 * managers and associates alike, so its modal answer would be confidently wrong.
 */
export function buildAccountTemplates(
  rows: AccountSourceRow[]
): Map<string, DepartmentAccountTemplate> {
  // department → field → value → { count, latest }
  const tally = new Map<
    string,
    Map<string, Map<string, { count: number; latest: string }>>
  >();

  const record = (scope: string, field: string, value: string, updatedAt: string) => {
    let byField = tally.get(scope);
    if (!byField) tally.set(scope, (byField = new Map()));
    let byValue = byField.get(field);
    if (!byValue) byField.set(field, (byValue = new Map()));
    const seen = byValue.get(value);
    if (seen) {
      seen.count += 1;
      if (updatedAt > seen.latest) seen.latest = updatedAt;
    } else {
      byValue.set(value, { count: 1, latest: updatedAt });
    }
  };

  for (const row of rows) {
    for (const field of ACCOUNT_TEMPLATE_KEYS) {
      const value = text(row.extraValues?.[field]);
      if (!value) continue;
      if (row.departmentCode) record(row.departmentCode, field, value, row.updatedAt);
      record("", field, value, row.updatedAt);
    }
  }

  const out = new Map<string, DepartmentAccountTemplate>();
  for (const [scope, byField] of tally) {
    const template: DepartmentAccountTemplate = { ...EMPTY_ACCOUNT_TEMPLATE };
    for (const field of ACCOUNT_TEMPLATE_KEYS) {
      const byValue = byField.get(field);
      if (!byValue) continue;
      let best: { value: string; count: number; latest: string } | undefined;
      for (const [value, stat] of byValue) {
        if (
          !best ||
          stat.count > best.count ||
          (stat.count === best.count && stat.latest > best.latest)
        ) {
          best = { value, count: stat.count, latest: stat.latest };
        }
      }
      if (best) template[field] = best.value;
    }
    out.set(scope, template);
  }
  return out;
}

export interface OracleAnalyzeContext {
  filePath: string;
  options: OracleImportOptions;
  /** Mapping tables: "D0400" → "Housekeeping". */
  departmentNameByCode: Map<string, string>;
  standards: OracleStandards;
  /** Normalized employee number → who already holds it in this plan. */
  existingEmpNumbers: Map<string, string>;
  existingPositionCount: number;
  /** Department code → its modal account set. The "" key is the plan-wide one. */
  accountTemplateByDepartment: Map<string, DepartmentAccountTemplate>;
  /** The OU's blocks, for band resolution. Never mutated. */
  existingBlocks: BlockDto[];
}

/** One band, ready to commit. */
export interface PlannedOracleBand {
  key: OracleBandKey;
  rate: number;
  /** Set when the block has to be created. */
  input?: BlockInput;
  /** Set when an existing block takes the values. */
  existingBlockId?: string;
  /** Only when the resolved block leaves its account unlocked — a locked block
   *  discards per-row accounts (engineInput.resolveBlockValues). */
  perRowAccountCode?: string;
  preview: OracleBandPreview;
}

export interface PlannedOraclePosition {
  sheetRow: number;
  empNumber: string;
  fields: Record<string, unknown>;
  pii: Record<string, unknown>;
}

export interface OracleImportPlan {
  preview: OracleImportPreview;
  bands: PlannedOracleBand[];
  positions: PlannedOraclePosition[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Band resolution
// ---------------------------------------------------------------------------

/** A block's base in plain English, so the dialog can say what a % applies to. */
export function describeBase(
  base: BlockBaseRef | undefined,
  labelById: Map<string, string>
): string {
  if (!base) return "Base Salary";
  switch (base.kind) {
    case "BASE_SALARY":
      return "Base Salary";
    case "BLOCK":
      return labelById.get(base.blockId) ?? "another block";
    case "COMPOSITE": {
      const parts = base.includeBaseSalary ? ["Base Salary"] : [];
      for (const id of base.blockIds) parts.push(labelById.get(id) ?? "another block");
      return parts.join(" + ") || "Base Salary";
    }
    case "KPI":
      return "a KPI driver";
    case "STAT":
      return base.stat === "HOURS"
        ? "Man-hours"
        : base.stat === "FTE"
          ? "FTE"
          : "Headcount";
    case "CALENDAR":
      return base.series === "PAY_DAYS" ? "Pay days" : "Calendar days";
    case "VACATION":
      return "Vacation";
    default:
      return "Base Salary";
  }
}

function isBaseSalaryOnly(base: BlockBaseRef | undefined): boolean {
  if (!base) return true;
  if (base.kind === "BASE_SALARY") return true;
  return (
    base.kind === "COMPOSITE" &&
    base.includeBaseSalary &&
    base.blockIds.length === 0
  );
}

export function toBlockOption(
  block: BlockDto,
  labelById: Map<string, string>
): OracleBlockOption {
  return {
    blockId: block.id,
    label: block.label,
    accountCode: block.accountCode,
    accountLocked: block.accountLocked,
    baseSummary: describeBase(block.base, labelById),
  };
}

/**
 * Which block each band's rate lands on.
 *
 * Account first, label second. The account is the stable key: a hotel that came
 * through the legacy importer already carries these two bands as MULTIPLIER
 * blocks named after the workbook's own row 2 ("Incentive Percentage 1/
 * Apprentice Levy", or literally "Incentive 1" when that row was blank), so
 * matching on our canonical label alone would create a duplicate column.
 */
export function resolveBands(
  existingBlocks: BlockDto[],
  options: OracleImportOptions,
  rowCount: number,
  warnings: string[]
): PlannedOracleBand[] {
  const labelById = new Map(existingBlocks.map((block) => [block.id, block.label]));
  const multipliers = existingBlocks.filter((block) => block.blockType === "MULTIPLIER");
  const out: PlannedOracleBand[] = [];

  for (const key of ORACLE_BAND_KEYS) {
    const spec = BAND_SPECS[key];
    const override = options.bands[key] ?? { mode: "auto" as const };
    const rate = override.rate ?? spec.rate;
    const wantedAccount = toOracleAccountCode(override.accountCode ?? spec.accountCode);

    if (override.mode === "off") {
      out.push({
        key,
        rate,
        preview: {
          key,
          label: spec.canonicalLabel,
          rate,
          accountCode: wantedAccount,
          disposition: "off",
          baseSummary: "—",
          baseDiffers: false,
          rowCount: 0,
        },
      });
      continue;
    }

    let matched: BlockDto | undefined;
    if (override.mode === "existing" && override.blockId) {
      matched = existingBlocks.find((block) => block.id === override.blockId);
      if (!matched) {
        warnings.push(
          `The block chosen for ${spec.canonicalLabel} no longer exists, so a new ` +
            `one was created instead.`
        );
      } else if (matched.blockType !== "MULTIPLIER") {
        warnings.push(
          `"${matched.label}" is not a percentage block, so ${spec.canonicalLabel} ` +
            `could not use it. A new block was created instead.`
        );
        matched = undefined;
      }
    } else if (override.mode !== "create") {
      matched = multipliers.find((block) => block.accountCode === wantedAccount);
      if (!matched) {
        matched = multipliers.find((block) => {
          const label = block.label.toLowerCase();
          return spec.labelNeedles.some((needle) => label.includes(needle));
        });
      }
      // A block of another type sitting on our account is worth saying out loud:
      // the money will post to the same place from two different columns.
      if (!matched) {
        const clash = existingBlocks.find(
          (block) =>
            block.blockType !== "MULTIPLIER" && block.accountCode === wantedAccount
        );
        if (clash) {
          warnings.push(
            `"${clash.label}" already posts to ${wantedAccount} but is not a ` +
              `percentage block, so ${spec.canonicalLabel} was created separately. ` +
              `Both will post to that account.`
          );
        }
      }
    }

    if (matched) {
      const baseSummary = describeBase(matched.base, labelById);
      const baseDiffers = !isBaseSalaryOnly(matched.base);
      if (baseDiffers) {
        warnings.push(
          `${spec.canonicalLabel} will be taken on ${baseSummary}, not base salary ` +
            `alone, because that is how this hotel's "${matched.label}" block is ` +
            `set up.`
        );
      }
      if (matched.increaseAware) {
        warnings.push(
          `"${matched.label}" follows the merit increase, so ${spec.canonicalLabel} ` +
            `will rise from each row's increase month.`
        );
      }
      if (!matched.accountLocked) {
        warnings.push(
          `"${matched.label}" uses a per-row account, so ${wantedAccount} was ` +
            `written onto each imported row.`
        );
      }
      out.push({
        key,
        rate,
        existingBlockId: matched.id,
        perRowAccountCode: matched.accountLocked ? undefined : wantedAccount,
        preview: {
          key,
          label: matched.label,
          rate,
          accountCode: matched.accountLocked ? matched.accountCode : wantedAccount,
          disposition: "existing",
          blockId: matched.id,
          baseSummary,
          baseDiffers,
          rowCount,
        },
      });
      continue;
    }

    out.push({
      key,
      rate,
      input: {
        blockType: "MULTIPLIER",
        label: spec.canonicalLabel,
        accountCode: wantedAccount,
        accountLocked: true,
        base: { kind: "BASE_SALARY" },
        increaseAware: false,
        departmentMode: "POSITION",
      },
      preview: {
        key,
        label: spec.canonicalLabel,
        rate,
        accountCode: wantedAccount,
        disposition: "create",
        baseSummary: "Base Salary",
        baseDiffers: false,
        rowCount,
      },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function displayName(row: OracleRow): string {
  const last = text(row.cells[COL.lastName]);
  const first = text(row.cells[COL.firstName]);
  if (last && first) return `${last}, ${first}`;
  return last || first || "(no name)";
}

interface RowNumbers {
  weeklyHours: number;
  daysPerWeek: number;
  salary: number;
  annualEntitlement: number;
}

/**
 * PER-ROW SHAPE ASSERTIONS.
 *
 * These are the anti-shift protection for the five columns the macro read
 * positionally without asserting a header, and they also make three of its bugs
 * unreachable rather than ported:
 *
 *   1. `AL = 0` divides by zero in `AK/AL`. The VBA's `On Error Resume Next`
 *      then leaves `TempValue` holding the PREVIOUS row's daily hours, and its
 *      `If Not IsNumeric(TempValue)` guard is dead code — `TempValue` is a
 *      `Double`, so it is always numeric and the hardcoded 8 never fires.
 *   2. A blank `AL` also makes `(7 - AL) * 52` come out as 364 days off.
 *   3. A blank `AN` yields a silent zero salary.
 *
 * A row that fails is never dropped quietly: it lands in `skipped` with its
 * sheet row, and the dialog lists every one.
 */
interface CheckedRow {
  /** Set when the row is usable. */
  values: RowNumbers | null;
  /** Set when it is not, and why. Exactly one of the two is ever filled. */
  skip: OracleSkippedRow | null;
}

function checkRow(row: OracleRow): CheckedRow {
  const base = {
    sheetRow: row.sheetRow,
    empNumber: text(row.cells[COL.empNumber]),
    name: displayName(row),
  };

  const daysPerWeek = optionalNum(row.cells[COL.daysPerWeek]);
  if (daysPerWeek == null || daysPerWeek < 1 || daysPerWeek > DAYS_PER_WEEK) {
    return {
      values: null,
      skip: {
        ...base,
        reason: "bad_days_per_week",
        detail: `Contract days per week reads "${text(
          row.cells[COL.daysPerWeek]
        )}" — it has to be between 1 and 7 for the daily hours and days off to mean anything.`,
      },
    };
  }

  const weeklyHours = optionalNum(row.cells[COL.weeklyHours]);
  if (weeklyHours == null || weeklyHours <= 0 || weeklyHours > 100) {
    return {
      values: null,
      skip: {
        ...base,
        reason: "bad_contract_hours",
        detail: `Contract hours reads "${text(
          row.cells[COL.weeklyHours]
        )}" — a weekly figure between 0 and 100 was expected.`,
      },
    };
  }

  const salary = optionalNum(row.cells[COL.salary]);
  if (salary == null || salary < 0) {
    return {
      values: null,
      skip: {
        ...base,
        reason: "bad_salary",
        detail: `Salary reads "${text(row.cells[COL.salary])}".`,
      },
    };
  }

  return {
    skip: null,
    values: {
      weeklyHours,
      daysPerWeek,
      salary,
      annualEntitlement: num(row.cells[COL.annualEntitlement]),
    },
  };
}

interface DerivedRow {
  dailyContractHours: number;
  contractDaysOff: number;
  contractPubHolidays: number;
  annual: number;
  monthly: number;
  vacationDays: number;
  departmentCode: string;
}

function deriveRow(
  values: RowNumbers,
  row: OracleRow,
  standards: OracleStandards
): DerivedRow {
  const dailyContractHours = values.weeklyHours / values.daysPerWeek;
  const contractDaysOff = (DAYS_PER_WEEK - values.daysPerWeek) * WEEKS_PER_YEAR;
  const annual = deriveAnnualSalary(values.salary, values.weeklyHours);
  return {
    dailyContractHours,
    contractDaysOff,
    contractPubHolidays: derivePublicHolidays(contractDaysOff, standards),
    annual,
    monthly: annual / MONTHS,
    vacationDays: values.annualEntitlement,
    departmentCode: toOracleDepartmentCode(row.cells[COL.department]),
  };
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

export function analyzeOracleReport(
  report: OracleReport,
  context: OracleAnalyzeContext
): OracleImportPlan {
  const warnings: string[] = [...report.warnings];
  const skipped: OracleSkippedRow[] = [];
  const positions: PlannedOraclePosition[] = [];
  const sampleRows: OracleSampleRow[] = [];

  const unknownDepartments = new Set<string>();
  const seenInFile = new Map<string, number>();
  let hourlyRows = 0;
  let unparsedDates = 0;
  let prorationFallbacks = 0;
  let suspiciousEntitlements = 0;
  let departmentSourced = 0;
  let planSourced = 0;
  let blankSourced = 0;

  const planWide = context.accountTemplateByDepartment.get("");

  for (const row of report.rows) {
    const empNumber = text(row.cells[COL.empNumber]);
    const normalized = normalizeEmpNumber(empNumber);
    const name = displayName(row);

    // Identity first: the whole re-run-safety story rests on the employee
    // number, so a row without one can never be de-duplicated and would double
    // on the next run.
    if (!normalized) {
      skipped.push({
        sheetRow: row.sheetRow,
        empNumber: "",
        name,
        reason: "no_emp_number",
        detail:
          "No employee number, so this row could not be told apart from one " +
          "already in the plan on a later run.",
      });
      continue;
    }
    const existingHolder = context.existingEmpNumbers.get(normalized);
    if (existingHolder) {
      skipped.push({
        sheetRow: row.sheetRow,
        empNumber,
        name,
        reason: "duplicate_in_plan",
        detail: `Already in this plan as ${existingHolder}.`,
      });
      continue;
    }
    const firstSeen = seenInFile.get(normalized);
    if (firstSeen != null) {
      skipped.push({
        sheetRow: row.sheetRow,
        empNumber,
        name,
        reason: "duplicate_in_file",
        detail: `The same employee number is on row ${firstSeen} of this file, which was imported instead.`,
      });
      continue;
    }

    const checked = checkRow(row);
    if (checked.skip) {
      skipped.push(checked.skip);
      continue;
    }
    const values = checked.values;
    seenInFile.set(normalized, row.sheetRow);

    const derived = deriveRow(values, row, context.standards);
    if (values.salary <= HOURLY_SALARY_THRESHOLD) hourlyRows += 1;
    if (!(context.standards.yearlyDays - context.standards.daysOff > 0)) {
      prorationFallbacks += 1;
    }
    if (derived.vacationDays > 60) suspiciousEntitlements += 1;

    const departmentName = derived.departmentCode
      ? (context.departmentNameByCode.get(derived.departmentCode) ?? "")
      : "";
    if (derived.departmentCode && !departmentName) {
      unknownDepartments.add(derived.departmentCode);
    }

    // Posting accounts: this hotel's own answer for that department, then the
    // plan-wide one, then blank. A blank account computes but never posts, so
    // guessing is worse than saying nothing — but the plan already knows where
    // a new Housekeeping row should book, and 130 blank columns is not a
    // neutral outcome either.
    let template = EMPTY_ACCOUNT_TEMPLATE;
    if (context.options.inheritAccounts) {
      const forDepartment = context.accountTemplateByDepartment.get(
        derived.departmentCode
      );
      if (forDepartment) {
        template = forDepartment;
        departmentSourced += 1;
      } else if (planWide) {
        template = planWide;
        planSourced += 1;
      } else {
        blankSourced += 1;
      }
    } else {
      blankSourced += 1;
    }

    const hiringDate = toOracleIsoDate(row.cells[COL.hiringDate]);
    if (!hiringDate && row.cells[COL.hiringDate] != null) unparsedDates += 1;

    const fields: Record<string, unknown> = {
      active: true,
      departmentCode: derived.departmentCode,
      deptName: departmentName,
      // The report carries no classification, so every row lands as Associate.
      jobTypeCode: "Associate",
      // And no pay class either. SALARIED is both the field default and the
      // right call: HOURLY zeroes the monthly base the moment the row is
      // edited, which would destroy the figure the macro computed.
      payType: "SALARIED",
      headcount: 1,
      seasonality: Array<number>(MONTHS).fill(1),
      // The Oracle figure IS an annual salary, so the row carries it as one and
      // behaves exactly like a hand-added row. With twelve working months the
      // divisor is 12, so the stored monthly is precisely the macro's AE.
      salaryEntryMode: "ANNUAL",
      annualBaseSalary: derived.annual,
      monthlyBaseSalary: derived.monthly,
      meritIncreasePct: 0,
      manualYearlyIncrease: 0,
      increaseMonth: 13,
      dailyContractHours: derived.dailyContractHours,
      contractYearlyDays: context.standards.yearlyDays,
      contractDaysOff: derived.contractDaysOff,
      contractPubHolidays: derived.contractPubHolidays,
      vacationDays: derived.vacationDays,
      vacationMonthlyWeights: Array<number>(MONTHS).fill(1 / MONTHS),
      salaryAccountCode: template.salaryAccountCode,
      workingHoursAccount: template.workingHoursAccount,
      accrualAccount: template.accrualAccount,
      benefitsAccountCode: template.benefitsAccountCode,
      // FTE, yearly man-hours and the accrual are all COMPUTED since seed v24 —
      // Kairos derives them from the contract inputs above, and writing one
      // would throw. `yearlyHoursWorked` is left at its 0 default on purpose:
      // the engine derives it from the contract while stored is 0, and writing
      // a number would pin it.
    };

    const pii: Record<string, unknown> = {
      hiringDate,
      empNumber,
      lastName: text(row.cells[COL.lastName]),
      firstName: text(row.cells[COL.firstName]),
      title: "",
    };

    positions.push({ sheetRow: row.sheetRow, empNumber, fields, pii });

    if (sampleRows.length < SAMPLE_ROW_COUNT) {
      sampleRows.push({
        sheetRow: row.sheetRow,
        lastName: text(row.cells[COL.lastName]),
        firstName: text(row.cells[COL.firstName]),
        empNumber,
        departmentCode: derived.departmentCode,
        departmentName,
        weeklyHours: values.weeklyHours,
        daysPerWeek: values.daysPerWeek,
        salary: values.salary,
        annualEntitlement: values.annualEntitlement,
        dailyContractHours: derived.dailyContractHours,
        monthlyBaseSalary: derived.monthly,
      });
    }
  }

  // ── Fidelity notes.
  if (hourlyRows > 0) {
    warnings.push(
      `${hourlyRows} row(s) carry an hourly rate rather than a salary (100 or ` +
        `less). They came across as Salaried on the monthly equivalent the old ` +
        `macro calculated — rate × contract hours × 52 ÷ 12 — so nothing is lost. ` +
        `Set the Pay Basis to Hourly and enter an Hourly Rate if you want the ` +
        `base derived from hours instead.`
    );
  }
  if (unparsedDates > 0) {
    warnings.push(
      `${unparsedDates} hiring date(s) could not be read and were left blank. ` +
        `Dates written with slashes are ambiguous (15/02 vs 02/15), so they are ` +
        `refused rather than guessed. Hiring dates do not affect the budget.`
    );
  }
  if (prorationFallbacks > 0) {
    warnings.push(
      `This hotel-year's Yearly Days (${context.standards.yearlyDays}) minus Days ` +
        `Off (${context.standards.daysOff}) leaves nothing to prorate against, so ` +
        `every row took the hotel's own ${context.standards.pubHolidays} public ` +
        `holidays unchanged. Check the Home page defaults.`
    );
  }
  if (suspiciousEntitlements > 0) {
    warnings.push(
      `${suspiciousEntitlements} row(s) show more than 60 days of annual ` +
        `entitlement. Kairos holds vacation in DAYS — if your report states it in ` +
        `hours, those figures are roughly eight times too high.`
    );
  }
  if (unknownDepartments.size > 0) {
    warnings.push(
      `${unknownDepartments.size} department code(s) are not in the mapping ` +
        `tables (${[...unknownDepartments].slice(0, 8).join(", ")}${
          unknownDepartments.size > 8 ? "…" : ""
        }). The codes came across; their names will fill in once the mapping ` +
        `tables are rebuilt.`
    );
  }
  if (positions.length > 0) {
    // Preserved on purpose, and worth stating once: the macro's days-off figure
    // is (7 - days per week) × 52 = a 364-day year, while Yearly Days comes from
    // the hotel calendar. Correcting it here would move every public-holiday
    // figure away from what the Excel tool produced.
    warnings.push(
      `Days off are calculated as (7 − contract days per week) × 52, exactly as ` +
        `the old macro did. That implies a 364-day year against Yearly Days of ` +
        `${context.standards.yearlyDays}; the one-day difference is inherited ` +
        `behaviour, kept so the figures match the Excel tool.`
    );
    warnings.push(
      `The report carries no classification or job title, so every row came in as ` +
        `Associate with a blank Job Title.`
    );
  }

  const labelById = new Map(context.existingBlocks.map((b) => [b.id, b.label]));
  const bands = resolveBands(
    context.existingBlocks,
    context.options,
    positions.length,
    warnings
  );

  const sourcedFields: OracleSourcedField[] = [
    {
      label: "Yearly Days",
      source: "hotel_defaults",
      summary: `${context.standards.yearlyDays}, from this hotel-year's defaults`,
    },
    {
      label: "Public Holidays",
      source: "hotel_defaults",
      summary: `${context.standards.pubHolidays} prorated onto each row's working pattern`,
    },
    {
      label: "Posting accounts",
      source: departmentSourced > 0 ? "department" : planSourced > 0 ? "plan" : "blank",
      summary: context.options.inheritAccounts
        ? `${departmentSourced} row(s) from their own department, ${planSourced} from ` +
          `the plan-wide pattern, ${blankSourced} left blank`
        : "left blank — inheriting from existing rows was turned off",
    },
    {
      label: "Classification",
      source: "fixed",
      summary: "Associate, for every row",
    },
    { label: "Job title", source: "blank", summary: "left blank" },
    {
      label: "Working months",
      source: "fixed",
      summary: "all twelve months active",
    },
  ];

  const preview: OracleImportPreview = {
    filePath: context.filePath,
    sourceFileName: report.sourceFileName,
    sheetName: report.sheetName,
    headerRow: report.headerRow,
    fileRowCount: report.rows.length,
    positionCount: positions.length,
    skipped,
    existingPositionCount: context.existingPositionCount,
    sampleRows,
    bands: bands.map((band) => band.preview),
    blockOptions: context.existingBlocks
      .filter((block) => block.blockType === "MULTIPLIER")
      .map((block) => toBlockOption(block, labelById)),
    unknownDepartments: [...unknownDepartments],
    standards: {
      yearlyDays: context.standards.yearlyDays,
      pubHolidays: context.standards.pubHolidays,
      daysOff: context.standards.daysOff,
    },
    sourcedFields,
    warnings,
  };

  return { preview, bands, positions, warnings };
}
