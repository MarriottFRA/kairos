/**
 * Turn a parsed legacy workbook into an ImportPlan — the whole judgement of the
 * importer, kept pure so it is testable and so `commit.ts` only ever fails on
 * genuine I/O.
 *
 * Three things make this more than a column rename:
 *
 * 1. Blocks are created only where they are USED. The old tool ships every band
 *    whether or not a hotel fills it in, so a naive import would leave a grid of
 *    twenty empty column groups. A band earns a block when at least one row
 *    carries a non-zero input.
 *
 * 2. A percentage band's base is read from its TOTAL COLUMN'S FORMULA, not
 *    assumed. Hotels edit those formulas — the reference file computes pension
 *    as `BT*(AZ+CP+DB)`, i.e. % of salary + food allowance + custom allowance 3
 *    — and reproducing the workbook's own arithmetic is the difference between
 *    an import that ties out and one that quietly doesn't. Terms that cannot be
 *    resolved are dropped with a warning, never silently.
 *
 * 3. Accounts are locked only where the file agrees. If every used row posts to
 *    the same account the block locks it; where they differ (pension is 124 rows
 *    on one account and 1 on another in the reference file) the block unlocks
 *    and each row keeps its own.
 *
 * Spread choices are taken from the VBA engine's own sections rather than the
 * band names, which are misleading: "Indemnity / End of Service" reads like a
 * flat yearly amount but §4 spreads it weighted by the monthly base-salary
 * curve, and "Stock Options" reads monthly but §5 divides the yearly figure
 * over working months — which is the same thing.
 *
 * Every column below is stated in 3.6.3 terms and mapped through the resolved
 * layout before it is read — 3.6.1 has no Overtime band and sits seven columns
 * to the left from DY on (see layout.ts). Blocks are also OPTIONAL: the
 * importer can read a band but cannot know what a hotel has used it for, so the
 * default is to describe every band it found and let the user build the blocks.
 */

import {
  BlockInput,
  BlockSpread,
  BlockType,
} from "../../shared/blocks/ipc";
import {
  AllocationInput,
  SpreadBase,
  isValidSpreadBase,
} from "../../shared/allocations/ipc";
import {
  MANUAL_INPUT_NO_INCREASE_MONTH,
  ManualInputRowInput,
} from "../../shared/manualInput/ipc";
import {
  LegacyBlockPreview,
  LegacyBlocksOmission,
  LegacyImportOptions,
  LegacyImportPreview,
} from "../../shared/legacyImport/ipc";
import { JOB_TYPE_OPTIONS } from "../../shared/positions/fieldSeed";
import { LegacyLayout, mapColumn, resolveLayout } from "./layout";
import { LegacyAssociateRow, LegacyWorkbook, MONTHS } from "./parseWorkbook";

// ---------------------------------------------------------------------------
// The workbook's fixed column map
// ---------------------------------------------------------------------------

/** Associate Details columns that are not part of a benefit band. */
const COL = {
  hiringDate: "A",
  empNumber: "B",
  lastName: "C",
  firstName: "D",
  department: "E",
  payClass: "G",
  title: "H",
  contractYearlyDays: "I",
  contractDaysOff: "J",
  contractPubHolidays: "K",
  dailyHours: "L",
  headcount: "O",
  // P (FTE) is not read — Kairos derives FTE from the contract columns above.
  seasonalityFirst: "R", // R..AC
  monthlyBasicSalary: "AE",
  additionalCostFirst: "AF", // AF..AQ
  meritIncreasePct: "AS",
  manualYearlyIncrease: "AT",
  increaseMonth: "AU",
  workingHoursAccount: "AV",
  // AW (headcount account) is not read — Kairos derives it from Classification.
  salaryAccount: "AY",
  /** Budget Year Basic Salary — the salary series every percentage band cites. */
  budgetYearSalary: "AZ",
  vacationDays: "BA",
  accrualAccount: "BD",
  vacationWeightFirst: "BE", // BE..BP
  benefitsAccount: "BR",
} as const;

/** Buyout & Manual Input columns. Months repeat in fours from E. */
const MANUAL_COL = {
  description: "A",
  department: "B",
  costAccount: "C",
  statsAccount: "D",
  /** First month block: hours, rate, fixed, total. */
  firstMonth: "E",
} as const;

/** How a band's per-row inputs become a Kairos block. */
type FamilySpec =
  | {
      kind: "MULTIPLIER";
      /** The per-row percentage. */
      rateCol: string;
      accountCol: string;
    }
  | {
      kind: "FLAT_MONTHLY";
      /** A per-month amount, booked each active month. */
      amountCol: string;
      accountCol: string;
    }
  | {
      kind: "COUNT_RATE";
      accountCol: string;
      statsAccountCol?: string;
      spread: BlockSpread;
      /**
       * qty × unitRate must equal the band's YEARLY figure, because every
       * COUNT_RATE spread divides a yearly total.
       *   ONE            a yearly amount sits in unitRateCol (qty = 1)
       *   COLUMN         both sides are real columns
       *   WORKING_MONTHS unitRateCol is monthly; qty is the row's working months
       *   MONTHLY_TIMES_MONTHS  qtyCol is a monthly quantity (hours), scaled to
       *                  the year by the row's working months
       */
      qtyMode: "ONE" | "COLUMN" | "WORKING_MONTHS" | "MONTHLY_TIMES_MONTHS";
      qtyCol?: string;
      unitRateCol: string;
    }
  | {
      kind: "CUSTOM_MONTHLY";
      /** First of twelve consecutive month columns. */
      firstMonthCol: string;
      accountCol: string;
    };

interface Family {
  /** Stable key — also the plan's handle for base references. */
  key: string;
  /** Fallback label when the workbook's own band name is unusable. */
  defaultLabel: string;
  /** Column carrying the band name in row 2. */
  bandCol: string;
  /** Columns that decide whether the band is in use at all. */
  inputCols: string[];
  /**
   * The band's computed yearly total. Stated per family rather than derived
   * from the account column: the bands are NOT uniformly laid out (Indemnity
   * carries a spare "Custom Amount/Formula" column between its account and its
   * total), and this is what a percentage band's formula cites by name.
   */
  totalCol: string;
  spec: FamilySpec;
  /** Which VBA section this reproduces — cited in warnings. */
  vbaSection: number;
}

/**
 * Every benefit band the old tool ships, in sheet order. Columns are fixed: the
 * VBA indexes them numerically ("the file structure will be locked", §Generate_
 * ExportData), so positional reads are the same contract the old engine had.
 */
const FAMILIES: Family[] = [
  {
    key: "pension",
    defaultLabel: "Pension",
    bandCol: "BT",
    inputCols: ["BT"],
    totalCol: "BV",
    vbaSection: 3,
    spec: { kind: "MULTIPLIER", rateCol: "BT", accountCol: "BU" },
  },
  {
    key: "indemnity",
    defaultLabel: "Indemnity / End of Service",
    bandCol: "BW",
    inputCols: ["BW", "BY"],
    totalCol: "BZ",
    vbaSection: 4,
    spec: {
      kind: "COUNT_RATE",
      accountCol: "BX",
      // §4 spreads the yearly figure weighted by the base-salary curve.
      spread: "WEIGHTED_BASE",
      qtyMode: "ONE",
      unitRateCol: "BW",
    },
  },
  {
    key: "stockOptions",
    defaultLabel: "Stock Options",
    bandCol: "CA",
    inputCols: ["CA"],
    totalCol: "CC",
    vbaSection: 5,
    spec: { kind: "FLAT_MONTHLY", amountCol: "CA", accountCol: "CB" },
  },
  {
    key: "airfare",
    defaultLabel: "Airfare / Tickets",
    bandCol: "CD",
    inputCols: ["CD", "CE"],
    totalCol: "CG",
    vbaSection: 6,
    spec: {
      kind: "COUNT_RATE",
      accountCol: "CF",
      spread: "ACTIVE_MONTHS",
      qtyMode: "COLUMN",
      qtyCol: "CD", // tickets
      unitRateCol: "CE", // destination cost
    },
  },
  {
    key: "transport",
    defaultLabel: "Transportation Allowance",
    bandCol: "CH",
    inputCols: ["CH"],
    totalCol: "CJ",
    vbaSection: 7,
    spec: { kind: "FLAT_MONTHLY", amountCol: "CH", accountCol: "CI" },
  },
  {
    key: "housing",
    defaultLabel: "Housing Allowance",
    bandCol: "CK",
    inputCols: ["CK"],
    totalCol: "CM",
    vbaSection: 8,
    spec: { kind: "FLAT_MONTHLY", amountCol: "CK", accountCol: "CL" },
  },
  {
    key: "food",
    defaultLabel: "Food Allowance",
    bandCol: "CN",
    inputCols: ["CN"],
    totalCol: "CP",
    vbaSection: 9,
    spec: { kind: "FLAT_MONTHLY", amountCol: "CN", accountCol: "CO" },
  },
  {
    key: "hardship",
    defaultLabel: "Hardship Allowance",
    bandCol: "CQ",
    inputCols: ["CQ"],
    totalCol: "CS",
    vbaSection: 10,
    spec: { kind: "FLAT_MONTHLY", amountCol: "CQ", accountCol: "CR" },
  },
  {
    key: "customFlatMonthly",
    defaultLabel: "Custom Allowance",
    bandCol: "CT",
    inputCols: ["CT"],
    totalCol: "CV",
    vbaSection: 11,
    spec: { kind: "FLAT_MONTHLY", amountCol: "CT", accountCol: "CU" },
  },
  {
    key: "customFlatDaily",
    defaultLabel: "Custom Allowance (daily spread)",
    bandCol: "CW",
    inputCols: ["CW"],
    totalCol: "CY",
    vbaSection: 12,
    spec: {
      kind: "COUNT_RATE",
      accountCol: "CX",
      spread: "DAYS",
      qtyMode: "WORKING_MONTHS",
      unitRateCol: "CW",
    },
  },
  {
    key: "customWeighted",
    defaultLabel: "Custom Allowance (weighted)",
    bandCol: "CZ",
    inputCols: ["CZ"],
    totalCol: "DB",
    vbaSection: 13,
    spec: { kind: "MULTIPLIER", rateCol: "CZ", accountCol: "DA" },
  },
  {
    key: "bonus",
    defaultLabel: "Bonus",
    bandCol: "DC",
    inputCols: ["DC"],
    totalCol: "DE",
    vbaSection: 14,
    spec: { kind: "MULTIPLIER", rateCol: "DC", accountCol: "DD" },
  },
  {
    key: "incentive1",
    defaultLabel: "Incentive 1",
    bandCol: "DF",
    inputCols: ["DF"],
    totalCol: "DH",
    vbaSection: 15,
    spec: { kind: "MULTIPLIER", rateCol: "DF", accountCol: "DG" },
  },
  {
    key: "incentive2",
    defaultLabel: "Incentive 2",
    bandCol: "DI",
    inputCols: ["DI"],
    totalCol: "DK",
    vbaSection: 16,
    spec: { kind: "MULTIPLIER", rateCol: "DI", accountCol: "DJ" },
  },
  {
    key: "incentiveFlatMonthly",
    defaultLabel: "Incentive 3",
    bandCol: "DL",
    inputCols: ["DL"],
    totalCol: "DN",
    vbaSection: 17,
    spec: { kind: "FLAT_MONTHLY", amountCol: "DL", accountCol: "DM" },
  },
  {
    key: "incentiveFlatDaily",
    defaultLabel: "Incentive 4 (daily spread)",
    bandCol: "DO",
    inputCols: ["DO"],
    totalCol: "DQ",
    vbaSection: 18,
    spec: {
      kind: "COUNT_RATE",
      accountCol: "DP",
      spread: "DAYS",
      qtyMode: "WORKING_MONTHS",
      unitRateCol: "DO",
    },
  },
  {
    key: "overtime",
    defaultLabel: "Overtime",
    bandCol: "DR",
    inputCols: ["DR", "DS"],
    totalCol: "DU",
    vbaSection: 25,
    spec: {
      kind: "COUNT_RATE",
      accountCol: "DV",
      // The hours themselves book to the overtime hours account, which is what
      // the cost/stat pair of a COUNT_RATE block is for.
      statsAccountCol: "DX",
      spread: "ACTIVE_MONTHS",
      qtyMode: "MONTHLY_TIMES_MONTHS",
      qtyCol: "DR", // monthly hours
      unitRateCol: "DS", // cost per hour
    },
  },
  {
    key: "customMonthly1",
    defaultLabel: "Custom Monthly 1",
    bandCol: "DY",
    inputCols: monthColumns("DY"),
    totalCol: "EK",
    vbaSection: 19,
    spec: { kind: "CUSTOM_MONTHLY", firstMonthCol: "DY", accountCol: "EK" },
  },
  {
    key: "customMonthly2",
    defaultLabel: "Custom Monthly 2",
    bandCol: "EL",
    inputCols: monthColumns("EL"),
    totalCol: "EX",
    vbaSection: 24,
    spec: { kind: "CUSTOM_MONTHLY", firstMonthCol: "EL", accountCol: "EX" },
  },
];

/**
 * Total columns that a percentage band's formula may cite, mapped to what they
 * mean. Base salary is `AZ` (Budget Year Basic Salary — the merit-adjusted
 * series); everything else is another band's own total.
 *
 * Built per layout: on a file without the Overtime band the totals a formula
 * cites are the shifted letters, so a fixed map would read a pension base as
 * unresolvable and silently drop a term.
 */
function totalColumnMeaning(families: Family[]): Record<string, string> {
  return {
    [COL.budgetYearSalary]: "@salary",
    ...Object.fromEntries(families.map((family) => [family.totalCol, family.key])),
  };
}

/**
 * Restate the canonical (3.6.3) family list in the columns this file actually
 * uses. A band with no home in this layout — Overtime on 3.6.1 — is dropped
 * rather than pointed at whatever now sits in its place.
 */
export function familiesForLayout(layout: LegacyLayout): Family[] {
  if (layout.hasOvertime) return FAMILIES;

  const shift = (letter: string): string | null => mapColumn(letter, layout);
  const families: Family[] = [];

  for (const family of FAMILIES) {
    const bandCol = shift(family.bandCol);
    const totalCol = shift(family.totalCol);
    const inputCols = family.inputCols.map(shift);
    if (!bandCol || !totalCol || inputCols.some((column) => column === null)) {
      continue;
    }

    const spec = family.spec;
    let shifted: FamilySpec | null = null;
    switch (spec.kind) {
      case "MULTIPLIER": {
        const rateCol = shift(spec.rateCol);
        const accountCol = shift(spec.accountCol);
        if (rateCol && accountCol) shifted = { ...spec, rateCol, accountCol };
        break;
      }
      case "FLAT_MONTHLY": {
        const amountCol = shift(spec.amountCol);
        const accountCol = shift(spec.accountCol);
        if (amountCol && accountCol) shifted = { ...spec, amountCol, accountCol };
        break;
      }
      case "COUNT_RATE": {
        const accountCol = shift(spec.accountCol);
        const unitRateCol = shift(spec.unitRateCol);
        const qtyCol = spec.qtyCol ? shift(spec.qtyCol) : undefined;
        const statsAccountCol = spec.statsAccountCol
          ? shift(spec.statsAccountCol)
          : undefined;
        const qtyOk = spec.qtyCol ? !!qtyCol : true;
        const statsOk = spec.statsAccountCol ? !!statsAccountCol : true;
        if (accountCol && unitRateCol && qtyOk && statsOk) {
          shifted = {
            ...spec,
            accountCol,
            unitRateCol,
            qtyCol: qtyCol ?? undefined,
            statsAccountCol: statsAccountCol ?? undefined,
          };
        }
        break;
      }
      case "CUSTOM_MONTHLY": {
        const firstMonthCol = shift(spec.firstMonthCol);
        const accountCol = shift(spec.accountCol);
        if (firstMonthCol && accountCol) {
          shifted = { ...spec, firstMonthCol, accountCol };
        }
        break;
      }
    }
    if (!shifted) continue;

    families.push({
      ...family,
      bandCol,
      totalCol,
      inputCols: inputCols as string[],
      spec: shifted,
    });
  }
  return families;
}

/**
 * The Social-Security block: seven margin/rate pairs, the two caps and the
 * account, stated in 3.6.3 columns. Never imported — only described.
 */
const SS_COLUMNS = {
  firstMargin: "EY",
  monthlyCap: "FM",
  yearlyCap: "FN",
  account: "FO",
} as const;
const SS_BRACKETS = 7;

/**
 * Column references inside a formula. Deliberately narrow: it must not mistake
 * a function name (`IF(`, `MIN(`), a defined name (`CN_1`, `FT_Hours`,
 * `Total_Growth`) or an exponent (`1E+99`) for a column, all of which appear in
 * the workbook's own formulas.
 */
const COLUMN_TOKEN_RE = /(?<![A-Za-z0-9_])\$?([A-Z]{1,2})(?![A-Za-z0-9(_])/g;

// ---------------------------------------------------------------------------
// Column-letter arithmetic
// ---------------------------------------------------------------------------

export function columnIndex(letter: string): number {
  let index = 0;
  for (const character of letter) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function columnLetter(index: number): string {
  let out = "";
  let remaining = index + 1;
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    remaining = Math.floor((remaining - remainder) / 26);
  }
  return out;
}

/** Twelve consecutive column letters starting at `first`. */
function monthColumns(first: string): string[] {
  const start = columnIndex(first);
  return Array.from({ length: MONTHS }, (_unused, m) => columnLetter(start + m));
}

// ---------------------------------------------------------------------------
// Cell coercion
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/**
 * A GL account as Kairos stores it: the app-standard "A" prefix on the bare
 * code the workbook holds. The old tool writes the literal "Blank" where a line
 * should compute but not post, which is exactly Kairos's empty account.
 */
export function toAccountCode(value: unknown): string {
  const raw = text(value);
  if (!raw || raw.toLowerCase() === "blank") return "";
  const digits = raw.replace(/^A/i, "");
  return /^\d+$/.test(digits) ? `A${digits}` : raw.toUpperCase();
}

/** A department as Kairos stores it: "D" + the workbook's four-digit code. */
export function toDepartmentCode(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";
  const digits = raw.replace(/^D/i, "");
  return /^\d+$/.test(digits) ? `D${digits}` : raw.toUpperCase();
}

/** An Excel date serial as an ISO day string. Text dates pass through. */
export function toIsoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel's epoch is 1899-12-30 once its 1900 leap-year quirk is absorbed.
    const ms = Date.UTC(1899, 11, 30) + Math.round(value) * 86400000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

/** Twelve values read from consecutive columns. */
function monthVector(row: LegacyAssociateRow, first: string): number[] {
  return monthColumns(first).map((letter) => num(row.cells[letter]));
}

/** Σ seasonality — the "Total Working Months" the whole sheet divides by. */
function workingMonths(row: LegacyAssociateRow): number {
  return monthVector(row, COL.seasonalityFirst).reduce(
    (total, value) => total + value,
    0
  );
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/** The per-row inputs a block's slots take. */
export interface PlannedBlockValues {
  rate?: number;
  amount?: number;
  qty?: number;
  unitRate?: number;
  monthlyValues?: number[];
  accountCode?: string;
  statsAccountCode?: string;
}

export interface PlannedBlock {
  /** Family key — how other blocks name it as a base before ids exist. */
  key: string;
  /** Everything but the id, which the repo mints. */
  input: Omit<BlockInput, "id">;
  preview: LegacyBlockPreview;
  /** Sheet row → the values that row contributes. */
  valuesByRow: Map<number, PlannedBlockValues>;
  /** COMPOSITE bases, unresolved: family keys, plus whether salary is in. */
  baseBlockKeys: string[];
  baseIncludesSalary: boolean;
}

export interface PlannedPosition {
  sheetRow: number;
  /** Catalog-keyed engine/extra fields (vectors under their vector name). */
  fields: Record<string, unknown>;
  pii: Record<string, unknown>;
}

export interface ImportPlan {
  preview: LegacyImportPreview;
  /**
   * Dependency-ordered: a block's composite base is always created first.
   * EMPTY when the blocks are not being imported — `preview.blocks` still
   * describes what was found, but nothing here means nothing written.
   */
  blocks: PlannedBlock[];
  positions: PlannedPosition[];
  manualRows: ManualInputRowInput[];
  allocations: AllocationInput[];
  publicHolidaysByMonth: number[] | null;
  weeklyHours: number | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Bands → blocks
// ---------------------------------------------------------------------------

/** The label to show: the workbook's own band name, minus any parenthetical. */
function bandLabel(workbook: LegacyWorkbook, family: Family): string {
  const raw = workbook.bandNames[family.bandCol];
  if (!raw) return family.defaultLabel;
  const trimmed = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return trimmed || family.defaultLabel;
}

/** Rows carrying a non-zero value in any of the band's input columns. */
function usedRows(
  workbook: LegacyWorkbook,
  family: Family
): LegacyAssociateRow[] {
  return workbook.associates.filter((row) =>
    family.inputCols.some((letter) => num(row.cells[letter]) !== 0)
  );
}

/** Distinct account codes across the used rows, most common first. */
function accountTally(
  rows: LegacyAssociateRow[],
  column: string
): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const code = toAccountCode(row.cells[column]);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}

function describeAccounts(tally: Array<{ code: string; count: number }>): string {
  if (tally.length === 0) return "none";
  if (tally.length === 1) return tally[0].code || "calculation only";
  return `per row — ${tally
    .map((entry) => `${entry.code || "(none)"} ×${entry.count}`)
    .join(", ")}`;
}

// Exhaustive on purpose: the importer only ever builds the first four, but
// keeping the map total means a new BlockSpread trips the compiler here rather
// than silently printing "undefined" in a preview report.
const SPREAD_SUMMARY: Record<BlockSpread, string> = {
  ACTIVE_MONTHS: "split evenly across working months",
  DAYS: "spread by days in each month",
  VACATION_PATTERN: "spread on the vacation pattern",
  WEEKDAYS: "booked per selected weekday occurrence",
  WEIGHTED_BASE: "weighted by the monthly salary curve",
  WEIGHTED_HOURS_WORKED: "weighted by the hours-worked curve",
  WEIGHTED_HOURS_PAID: "weighted by the hours-paid curve",
  WEIGHTED_FTE: "weighted by the FTE curve",
};

/**
 * Read a percentage band's base off its total column's formula.
 *
 * The formulas are all of the shape `<rate> * (<term> + <term> + …)` in some
 * order, so pulling every column token, dropping the rate column itself, and
 * mapping what remains is both simple and robust to the arrangement. A token
 * that is not a known total is reported rather than assumed away.
 */
function resolveMultiplierBase(
  workbook: LegacyWorkbook,
  family: Family,
  rateCol: string,
  totalCol: string,
  label: string,
  meaning: Record<string, string>,
  warnings: string[]
): { keys: string[]; includesSalary: boolean } {
  const formula = workbook.formulas[totalCol];
  if (!formula) {
    warnings.push(
      `${label}: the total column has no formula, so its base could not be read. ` +
        `Imported as a percentage of base salary — check this block.`
    );
    return { keys: [], includesSalary: true };
  }

  const tokens = [...new Set(formula.match(COLUMN_TOKEN_RE) ?? [])]
    .map((token) => token.replace("$", ""))
    .filter((token) => token !== rateCol);

  const keys: string[] = [];
  let includesSalary = false;
  const unresolved: string[] = [];

  for (const token of tokens) {
    const resolved = meaning[token];
    if (resolved === "@salary") includesSalary = true;
    else if (resolved && resolved !== family.key) keys.push(resolved);
    else if (!resolved) unresolved.push(token);
  }

  if (unresolved.length > 0) {
    warnings.push(
      `${label}: part of its formula (${unresolved.join(", ")}) is not something ` +
        `this tool models, so it was left out of the base. Check this block.`
    );
  }
  if (!includesSalary && keys.length === 0) {
    warnings.push(
      `${label}: no recognisable base in its formula — imported as a percentage ` +
        `of base salary. Check this block.`
    );
    return { keys: [], includesSalary: true };
  }
  return { keys, includesSalary };
}

/** Plain-English description of a composite base, for the report. */
function describeBase(
  includesSalary: boolean,
  keys: string[],
  labelByKey: Map<string, string>
): string {
  const parts = [
    ...(includesSalary ? ["Base Salary"] : []),
    ...keys.map((key) => labelByKey.get(key) ?? key),
  ];
  return parts.join(" + ");
}

function planBlocks(
  workbook: LegacyWorkbook,
  layout: LegacyLayout,
  warnings: string[]
): { blocks: PlannedBlock[]; skipped: string[] } {
  const skipped: string[] = [];
  const labelByKey = new Map<string, string>();
  const planned: PlannedBlock[] = [];
  const families = familiesForLayout(layout);
  const meaning = totalColumnMeaning(families);

  for (const family of families) {
    const label = bandLabel(workbook, family);
    const rows = usedRows(workbook, family);
    if (rows.length === 0) {
      skipped.push(label);
      continue;
    }
    labelByKey.set(family.key, label);

    const spec = family.spec;
    const accounts = accountTally(rows, spec.accountCol);
    const accountLocked = accounts.length <= 1;
    const accountCode = accounts[0]?.code ?? "";

    const valuesByRow = new Map<number, PlannedBlockValues>();
    let baseBlockKeys: string[] = [];
    let baseIncludesSalary = false;
    let blockType: BlockType;
    let input: Omit<BlockInput, "id">;
    let spreadSummary: string | undefined;
    let baseSummary: string | undefined;

    switch (spec.kind) {
      case "MULTIPLIER": {
        blockType = "MULTIPLIER";
        const resolved = resolveMultiplierBase(
          workbook,
          family,
          spec.rateCol,
          family.totalCol,
          label,
          meaning,
          warnings
        );
        baseBlockKeys = resolved.keys;
        baseIncludesSalary = resolved.includesSalary;
        input = {
          blockType,
          label,
          accountCode,
          accountLocked,
          // Rewritten once the referenced blocks resolve (see linkBases).
          base: { kind: "BASE_SALARY" },
        };
        for (const row of rows) {
          valuesByRow.set(row.sheetRow, { rate: num(row.cells[spec.rateCol]) });
        }
        break;
      }
      case "FLAT_MONTHLY": {
        blockType = "FLAT_MONTHLY";
        input = { blockType, label, accountCode, accountLocked };
        spreadSummary = "a monthly amount, each working month";
        for (const row of rows) {
          valuesByRow.set(row.sheetRow, {
            amount: num(row.cells[spec.amountCol]),
          });
        }
        break;
      }
      case "COUNT_RATE": {
        blockType = "COUNT_RATE";
        const statsAccounts = spec.statsAccountCol
          ? accountTally(rows, spec.statsAccountCol)
          : [];
        input = {
          blockType,
          label,
          accountCode,
          accountLocked,
          statsAccountCode: statsAccounts[0]?.code ?? "",
          statsAccountLocked: statsAccounts.length <= 1,
          spread: spec.spread,
        };
        spreadSummary = SPREAD_SUMMARY[spec.spread];
        for (const row of rows) {
          const months = workingMonths(row);
          const unitRate = num(row.cells[spec.unitRateCol]);
          let qty: number;
          switch (spec.qtyMode) {
            case "ONE":
              qty = 1;
              break;
            case "COLUMN":
              qty = num(row.cells[spec.qtyCol as string]);
              break;
            case "WORKING_MONTHS":
              qty = months;
              break;
            case "MONTHLY_TIMES_MONTHS":
              qty = num(row.cells[spec.qtyCol as string]) * months;
              break;
          }
          valuesByRow.set(row.sheetRow, { qty, unitRate });
        }
        break;
      }
      case "CUSTOM_MONTHLY": {
        blockType = "CUSTOM_MONTHLY";
        input = { blockType, label, accountCode, accountLocked };
        spreadSummary = "the twelve amounts as typed";
        for (const row of rows) {
          valuesByRow.set(row.sheetRow, {
            monthlyValues: monthVector(row, spec.firstMonthCol),
          });
        }
        break;
      }
    }

    // Per-row account overrides only exist on an unlocked block.
    if (!accountLocked) {
      for (const row of rows) {
        const values = valuesByRow.get(row.sheetRow);
        if (values) values.accountCode = toAccountCode(row.cells[spec.accountCol]);
      }
      warnings.push(
        `${label}: rows post to more than one account (${describeAccounts(
          accounts
        )}), so the block keeps a per-row account column.`
      );
    }
    if (
      spec.kind === "COUNT_RATE" &&
      spec.statsAccountCol &&
      input.statsAccountLocked === false
    ) {
      for (const row of rows) {
        const values = valuesByRow.get(row.sheetRow);
        if (values) {
          values.statsAccountCode = toAccountCode(row.cells[spec.statsAccountCol]);
        }
      }
    }

    // A block config is hotel-wide, so a row whose total formula was edited by
    // hand cannot be reproduced. Import the standard shape and name the rows.
    for (const outlier of workbook.formulaOutliers[family.totalCol] ?? []) {
      const affected = outlier.sheetRows.filter((sheetRow) =>
        valuesByRow.has(sheetRow)
      );
      if (affected.length === 0) continue;
      const plural = affected.length > 1;
      warnings.push(
        `${label}: sheet row${plural ? "s" : ""} ${affected.join(", ")} ` +
          `calculate${plural ? "" : "s"} this differently (${outlier.formula}) ` +
          `from the other ${rows.length - affected.length}. Every row here uses ` +
          `the same rule, so ${plural ? "those rows" : "that row"} will not ` +
          `match your workbook — check ${plural ? "them" : "it"}.`
      );
    }

    planned.push({
      key: family.key,
      input,
      preview: {
        label,
        blockType,
        accountSummary: describeAccounts(accounts),
        spreadSummary,
        baseSummary,
        usedRows: rows.length,
      },
      valuesByRow,
      baseBlockKeys,
      baseIncludesSalary,
    });
  }

  linkBases(planned, labelByKey, warnings);
  return { blocks: orderByDependency(planned, warnings), skipped };
}

/**
 * Turn each multiplier's resolved family keys into a real base, dropping any
 * that never became a block (an unused band contributes nothing anyway).
 */
function linkBases(
  planned: PlannedBlock[],
  labelByKey: Map<string, string>,
  warnings: string[]
): void {
  const present = new Set(planned.map((block) => block.key));
  for (const block of planned) {
    if (block.input.blockType !== "MULTIPLIER") continue;

    const dropped = block.baseBlockKeys.filter((key) => !present.has(key));
    block.baseBlockKeys = block.baseBlockKeys.filter((key) => present.has(key));
    if (dropped.length > 0) {
      warnings.push(
        `${block.preview.label}: its base cites ${dropped
          .map((key) => labelByKey.get(key) ?? key)
          .join(", ")}, which is empty in this file and was left out.`
      );
    }

    if (block.baseBlockKeys.length === 0) {
      block.baseIncludesSalary = true;
      block.input.base = { kind: "BASE_SALARY" };
      block.preview.baseSummary = "Base Salary";
    } else {
      // Filled with real ids at commit time — analyze has none to give.
      block.input.base = {
        kind: "COMPOSITE",
        includeBaseSalary: block.baseIncludesSalary,
        blockIds: [],
      };
      block.preview.baseSummary = describeBase(
        block.baseIncludesSalary,
        block.baseBlockKeys,
        labelByKey
      );
      warnings.push(
        `${block.preview.label}: your file computes this on ${block.preview.baseSummary}, ` +
          `not base salary alone — imported that way. Untick the extras in the block's ` +
          `settings if you want it on salary only.`
      );
    }
  }
}

/**
 * Order blocks so a composite base is always saved before the block citing it.
 * A cycle can only come from an edited formula; break it rather than refuse the
 * whole import, and say which link was cut.
 */
function orderByDependency(
  planned: PlannedBlock[],
  warnings: string[]
): PlannedBlock[] {
  const byKey = new Map(planned.map((block) => [block.key, block]));
  const ordered: PlannedBlock[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (block: PlannedBlock): void => {
    const status = state.get(block.key);
    if (status === "done") return;
    if (status === "visiting") return; // handled by the caller's guard below
    state.set(block.key, "visiting");
    for (const key of [...block.baseBlockKeys]) {
      const dependency = byKey.get(key);
      if (!dependency) continue;
      if (state.get(dependency.key) === "visiting") {
        block.baseBlockKeys = block.baseBlockKeys.filter((k) => k !== key);
        warnings.push(
          `${block.preview.label} and ${dependency.preview.label} refer to each ` +
            `other, which cannot be calculated. ${dependency.preview.label} was ` +
            `left out of ${block.preview.label}'s base.`
        );
        continue;
      }
      visit(dependency);
    }
    state.set(block.key, "done");
    ordered.push(block);
  };

  for (const block of planned) visit(block);
  return ordered;
}

// ---------------------------------------------------------------------------
// Associates → positions
// ---------------------------------------------------------------------------

const JOB_TYPE_CODES = new Set(JOB_TYPE_OPTIONS.map((option) => option.value));

/**
 * The old tool's single "Manager / Hourly / Supervisor / Casual" column carries
 * both facts Kairos keeps apart: the classification and the pay basis. Read by
 * rule rather than from a fixed list, so a workbook with its own wording still
 * lands somewhere sensible.
 */
export function splitPayClass(raw: string): {
  jobTypeCode: string;
  payType: "HOURLY" | "SALARIED";
  recognised: boolean;
} {
  const value = raw.trim();
  const lower = value.toLowerCase();
  const payType = lower.includes("hourly") ? "HOURLY" : "SALARIED";

  let jobTypeCode = "";
  if (lower.startsWith("manager")) {
    jobTypeCode = lower.includes("non ex") ? "Manager (Non Exempt)" : "Manager";
  } else if (lower.startsWith("supervisor")) jobTypeCode = "Supervisor";
  else if (lower.startsWith("associate")) jobTypeCode = "Associate";
  else if (lower.startsWith("casual")) jobTypeCode = "Casual";

  if (!jobTypeCode || !JOB_TYPE_CODES.has(jobTypeCode)) {
    return { jobTypeCode: "Associate", payType, recognised: false };
  }
  return { jobTypeCode, payType, recognised: true };
}

function planPositions(
  workbook: LegacyWorkbook,
  departmentNameByCode: Map<string, string>,
  warnings: string[]
): PlannedPosition[] {
  const unrecognisedPayClasses = new Set<string>();
  const unknownDepartments = new Set<string>();
  let hourlyRows = 0;

  const positions = workbook.associates.map((row) => {
    const payClass = text(row.cells[COL.payClass]);
    const split = splitPayClass(payClass);
    if (!split.recognised && payClass) unrecognisedPayClasses.add(payClass);
    if (split.payType === "HOURLY") hourlyRows += 1;

    const departmentCode = toDepartmentCode(row.cells[COL.department]);
    const departmentName = departmentNameByCode.get(departmentCode) ?? "";
    if (departmentCode && !departmentName) unknownDepartments.add(departmentCode);

    const seasonality = monthVector(row, COL.seasonalityFirst);
    const additional = monthVector(row, COL.additionalCostFirst);
    const vacationWeights = monthVector(row, COL.vacationWeightFirst);
    const increaseMonth = Math.round(num(row.cells[COL.increaseMonth]));

    const fields: Record<string, unknown> = {
      active: true,
      departmentCode,
      deptName: departmentName,
      jobTypeCode: split.jobTypeCode,
      payType: split.payType,
      headcount: num(row.cells[COL.headcount]) || 1,
      // FTE (column P) is deliberately NOT imported: Kairos derives it from the
      // same contract inputs the workbook's own formula used — the day counts
      // and daily hours a few lines below, against the hotel-year full-time
      // reference (see engineInput.deriveFte). Writing it would also throw, the
      // field being COMPUTED since seed v24. Part-timers stay part-time because
      // their contract comes across, not because the ratio does.
      seasonality,
      // Stated, not defaulted: the workbook's Yearly Days / Days Off / Public
      // Holidays are a FULL-YEAR contract shape even on a seasonal row, so the
      // whole row reads on the Full year basis and Kairos prorates the derived
      // man-hours and FTE by the working months it also imported. Two figures on
      // an imported seasonal row therefore differ from the workbook: its derived
      // man-hours (which the VBA left at a full year's worth, inside however many
      // months the row worked) and its Manual Yearly Increase (which the VBA
      // spread whole from the increase month). Both are the correction this basis
      // exists to make — a nine-month post does not work twelve months of hours.
      annualDivisorBasis: "TWELVE",
      monthlyBaseSalary: num(row.cells[COL.monthlyBasicSalary]),
      meritIncreasePct: num(row.cells[COL.meritIncreasePct]),
      manualYearlyIncrease: num(row.cells[COL.manualYearlyIncrease]),
      increaseMonth:
        increaseMonth >= 1 && increaseMonth <= 12 ? increaseMonth : 13,
      dailyContractHours: num(row.cells[COL.dailyHours]),
      vacationDays: num(row.cells[COL.vacationDays]),
      vacationMonthlyWeights: vacationWeights,
      contractYearlyDays: num(row.cells[COL.contractYearlyDays]),
      contractDaysOff: num(row.cells[COL.contractDaysOff]),
      contractPubHolidays: num(row.cells[COL.contractPubHolidays]),
      // Posting accounts are instructions, not arithmetic, so they come across
      // by value even where the workbook derived them from the pay class.
      workingHoursAccount: toAccountCode(row.cells[COL.workingHoursAccount]),
      // The headcount account (column AW) is deliberately NOT imported: Kairos
      // derives it from the Classification carried above (seed v26), and writing
      // it would throw, the field being COMPUTED. The workbook derived it from
      // the pay class too, so the imported rows land on the same accounts.
      salaryAccountCode: toAccountCode(row.cells[COL.salaryAccount]),
      accrualAccount: toAccountCode(row.cells[COL.accrualAccount]),
      benefitsAccountCode: toAccountCode(row.cells[COL.benefitsAccount]),
    };
    // Twelve zeros is the default; only send the family when it says something.
    if (additional.some((value) => value !== 0)) {
      fields.additionalMonthlyCosts = additional;
    }

    const pii: Record<string, unknown> = {
      hiringDate: toIsoDate(row.cells[COL.hiringDate]),
      empNumber: text(row.cells[COL.empNumber]),
      lastName: text(row.cells[COL.lastName]),
      firstName: text(row.cells[COL.firstName]),
      title: text(row.cells[COL.title]),
    };

    return { sheetRow: row.sheetRow, fields, pii };
  });

  if (unrecognisedPayClasses.size > 0) {
    warnings.push(
      `Could not read the classification for ${[...unrecognisedPayClasses].join(
        ", "
      )} — those rows came in as Associate. Check the Classification column.`
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
  if (hourlyRows > 0) {
    warnings.push(
      `${hourlyRows} row(s) are hourly-paid. The old tool held no hourly rate — ` +
        `it budgeted them from the same monthly figure — so they came across on ` +
        `Monthly Basic with the pay basis set to Hourly. Enter an Hourly Rate on ` +
        `those rows if you want the base derived from hours instead.`
    );
  }
  // Standard Title is deliberately left blank: the column is a closed list the
  // local free-text title is NOT auto-mapped to (see fieldSeed), and guessing
  // here is exactly what that decision rules out.
  warnings.push(
    `Job titles came across as typed. The Standard Title column beside them is ` +
      `left blank for you to set — it is a fixed list and a guessed mapping ` +
      `would not be trustworthy.`
  );
  return positions;
}

// ---------------------------------------------------------------------------
// Buyout & Manual Input
// ---------------------------------------------------------------------------

/**
 * Each month occupies four columns from E: hours, hour rate, fixed amount, and
 * the total of the two. Kairos holds one rate for the whole row plus twelve
 * stats and twelve amounts, and cannot carry an hourly rate AND a fixed amount
 * on the same line — so the money comes across as the monthly TOTAL, which is
 * lossless, and the rate is only set where the workbook used it alone.
 */
function planManualRows(
  workbook: LegacyWorkbook,
  departmentNameByCode: Map<string, string>,
  warnings: string[]
): ManualInputRowInput[] {
  const firstMonth = columnIndex(MANUAL_COL.firstMonth);
  let collapsed = 0;

  const rows = workbook.manualRows.flatMap<ManualInputRowInput>((row) => {
    const stats: number[] = [];
    const amounts: number[] = [];
    const rates: number[] = [];
    const fixedAmounts: number[] = [];

    for (let month = 0; month < MONTHS; month++) {
      const base = firstMonth + month * 4;
      const hours = num(row.cells[columnLetter(base)]);
      const rate = num(row.cells[columnLetter(base + 1)]);
      const fixed = num(row.cells[columnLetter(base + 2)]);
      stats.push(hours);
      amounts.push(hours * rate + fixed);
      rates.push(rate);
      fixedAmounts.push(fixed);
    }

    const description = text(row.cells[MANUAL_COL.description]);
    const empty =
      !description &&
      stats.every((value) => value === 0) &&
      amounts.every((value) => value === 0);
    if (empty) return [];

    // One rate all year with nothing fixed alongside is the one shape Kairos
    // can hold natively — keep it, so the row stays rate-driven and editable.
    const distinctRates = new Set(rates);
    const rateDriven =
      distinctRates.size === 1 &&
      rates[0] !== 0 &&
      fixedAmounts.every((value) => value === 0);
    if (!rateDriven && rates.some((value) => value !== 0)) collapsed += 1;

    const departmentCode = toDepartmentCode(row.cells[MANUAL_COL.department]);
    return [
      {
        description,
        department: departmentNameByCode.get(departmentCode) ?? "",
        departmentCode,
        costAccount: toAccountCode(row.cells[MANUAL_COL.costAccount]),
        statsAccount: toAccountCode(row.cells[MANUAL_COL.statsAccount]),
        rate: rateDriven ? rates[0] : null,
        statsKpiDriverId: null,
        statsKpiDivisor: null,
        statsKpiFactor: null,
        stats,
        amounts,
        spreadMode: null,
        spreadBaseStats: null,
        spreadBaseAmount: null,
        increasePct: 0,
        increaseMonth: MANUAL_INPUT_NO_INCREASE_MONTH,
      },
    ];
  });

  if (collapsed > 0) {
    warnings.push(
      `Manual input: ${collapsed} row(s) mixed an hourly rate with a fixed ` +
        `amount, which a single row here cannot hold. The monthly totals came ` +
        `across in full; the rate/fixed split did not.`
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

/** The old tool's spread-base wording → the Kairos basis. */
const SPREAD_BASE_BY_LABEL: Record<string, SpreadBase> = {
  "head count": "HEADCOUNT",
  "fte count": "FTE",
  fte: "FTE",
  "hours worked": "MANHOURS_WORKED",
  "hours paid": "MANHOURS_PAID",
  "base salary(estimate)": "BASE_SALARY",
  "base salary": "BASE_SALARY",
  "contract days": "CONTRACT_DAYS",
  "vacation days": "VACATION_DAYS",
  "flat spread": "FLAT",
  flat: "FLAT",
};

function planAllocations(
  workbook: LegacyWorkbook,
  warnings: string[]
): AllocationInput[] {
  const active = workbook.allocationColumns.filter(
    (column) => column.status.toLowerCase() === "active"
  );
  if (active.length === 0) return [];

  return active.map((column) => {
    const key = column.spreadBaseLabel.toLowerCase().trim();
    const mapped = SPREAD_BASE_BY_LABEL[key];
    const spreadBase: SpreadBase =
      mapped && isValidSpreadBase(mapped) ? mapped : "HEADCOUNT";
    if (!mapped && column.spreadBaseLabel) {
      warnings.push(
        `Allocation "${column.title}": spread base "${column.spreadBaseLabel}" ` +
          `is not one this tool offers — set to Head Count. Check it.`
      );
    }

    // A department the sheet left blank in this column takes no share.
    const excludedDepartments = Object.entries(column.valuesByDepartment)
      .filter(([, value]) => value == null)
      .map(([code]) => toDepartmentCode(code));

    warnings.push(
      `Allocation "${column.title}": the inject account ` +
        `(${column.injectAccount || "none"}) and target department ` +
        `(${column.targetDepartment || "none"}) are not stored here — the ` +
        `allocations page only holds the split itself.`
    );

    return {
      name: column.title,
      spreadBase,
      excludedDepartments,
    };
  });
}

// ---------------------------------------------------------------------------
// Social Security — reported, never imported
// ---------------------------------------------------------------------------

/**
 * The old tool holds the NI/SS bands PER ASSOCIATE, so one workbook can carry
 * several schemes; Kairos runs one scheme for the whole hotel. Rather than pick
 * one and silently mis-charge everyone else, describe what is in the file and
 * leave the setup to the user.
 *
 * Reads through the layout like everything else past DR: on 3.6.1 these columns
 * are seven to the left, and the fixed map would have reported Custom-2 monthly
 * amounts as tax margins.
 */
function describeSocialSecurity(
  workbook: LegacyWorkbook,
  layout: LegacyLayout
): string[] {
  // These columns sit past DR, so an unidentified layout cannot place them
  // either. A guessed set of tax bands reads as fact and would be acted on —
  // saying nothing is the only honest option.
  if (!layout.blocksReadable) {
    return [
      `Social Security / NI could not be read: it sits in the same part of the ` +
        `sheet as the benefit bands, which this file's layout does not let the ` +
        `import identify. Set it up from Positions → add a Social Security ` +
        `block, using the bands in your workbook.`,
    ];
  }

  const firstMargin = mapColumn(SS_COLUMNS.firstMargin, layout);
  const monthlyCapCol = mapColumn(SS_COLUMNS.monthlyCap, layout);
  const yearlyCapCol = mapColumn(SS_COLUMNS.yearlyCap, layout);
  const accountCol = mapColumn(SS_COLUMNS.account, layout);
  if (!firstMargin || !monthlyCapCol || !yearlyCapCol || !accountCol) return [];

  const first = columnIndex(firstMargin);
  const signatures = new Map<string, number>();

  for (const row of workbook.associates) {
    const brackets: string[] = [];
    for (let index = 0; index < SS_BRACKETS; index++) {
      const margin = num(row.cells[columnLetter(first + index * 2)]);
      const rate = num(row.cells[columnLetter(first + index * 2 + 1)]);
      if (rate === 0 && margin === 0) continue;
      brackets.push(`${(rate * 100).toFixed(3)}% above ${margin}`);
    }
    if (brackets.length === 0) continue;
    const monthlyCap = num(row.cells[monthlyCapCol]);
    const yearlyCap = num(row.cells[yearlyCapCol]);
    const caps = [
      monthlyCap ? `monthly cap ${monthlyCap}` : null,
      yearlyCap ? `yearly cap ${yearlyCap}` : null,
    ].filter(Boolean);
    const account = toAccountCode(row.cells[accountCol]);
    const signature = `${brackets.join("; ")}${
      caps.length ? ` (${caps.join(", ")})` : ""
    } → ${account || "no account"}`;
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }

  if (signatures.size === 0) return [];

  const included = SS_BASE_FLAG_LABELS.filter(
    ([flag]) => workbook.ssBaseFlags[flag]
  ).map(([, label]) => label);

  return [
    `Social Security / NI was NOT imported — your file sets the bands per ` +
      `associate and this tool runs one scheme per hotel. Set it up from ` +
      `Positions → add a Social Security block, using: ` +
      [...signatures.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([signature, count]) => `${signature} [${count} rows]`)
        .join(" | ") +
      `. Contributory base in your file: ${
        included.length > 0 ? included.join(", ") : "nothing ticked"
      }.`,
  ];
}

/** CN_A<n> → the band it switches on, in the VBA's own order. */
const SS_BASE_FLAG_LABELS: Array<[string, string]> = [
  ["CN_A1", "Basic Salary"],
  ["CN_A2", "Pension"],
  ["CN_A3", "Indemnity"],
  ["CN_A4", "Stock Options"],
  ["CN_A5", "Transportation Allowance"],
  ["CN_A6", "Housing Allowance"],
  ["CN_A7", "Food Allowance"],
  ["CN_A8", "Hardship Allowance"],
  ["CN_A9", "Custom Allowance"],
  ["CN_A10", "Custom Allowance (daily)"],
  ["CN_A11", "Custom Allowance (weighted)"],
  ["CN_A12", "Bonus"],
  ["CN_A13", "Incentive 1"],
  ["CN_A14", "Incentive 2"],
  ["CN_A15", "Incentive 3"],
  ["CN_A16", "Incentive 4"],
  ["CN_A17", "Airfare / Tickets"],
  ["CN_A18", "Custom Monthly 1"],
  ["CN_A19", "Custom Monthly 2"],
  ["CN_A20", "Overtime"],
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AnalyzeContext {
  filePath: string;
  options: LegacyImportOptions;
  /** From the mapping tables, so manual-input rows get their department NAME. */
  departmentNameByCode: Map<string, string>;
}

export function analyzeWorkbook(
  workbook: LegacyWorkbook,
  context: AnalyzeContext
): ImportPlan {
  const warnings: string[] = [];
  const layout = resolveLayout(workbook, context.options.version);
  warnings.push(...layout.notes);

  // Blocks are read whenever the layout is known, whether or not they are being
  // imported: the preview lists them either way, so a user who leaves the
  // toggle off still gets the band names, bases and accounts to build from.
  //
  // Their fidelity warnings are collected separately and only surfaced when the
  // blocks are actually created — "Pension keeps a per-row account column"
  // describes a block that would otherwise not exist.
  const blockWarnings: string[] = [];
  const detected = layout.blocksReadable
    ? planBlocks(workbook, layout, blockWarnings)
    : { blocks: [], skipped: [] };

  const importBlocks = context.options.blocks && layout.blocksReadable;
  const blocksOmitted: LegacyBlocksOmission | null = importBlocks
    ? null
    : layout.blocksReadable
      ? "not_requested"
      : "layout_unknown";
  if (importBlocks) warnings.push(...blockWarnings);

  const blocks = importBlocks ? detected.blocks : [];
  const skipped = detected.skipped;

  const positions = planPositions(
    workbook,
    context.departmentNameByCode,
    warnings
  );
  const manualRows = context.options.manualInput
    ? planManualRows(workbook, context.departmentNameByCode, warnings)
    : [];
  const allocations = context.options.allocations
    ? planAllocations(workbook, warnings)
    : [];

  warnings.push(...describeSocialSecurity(workbook, layout));

  // Two columns are deliberately left behind; say so rather than let a user
  // discover it on the grid.
  warnings.push(
    `The Cluster column was not imported — clusters need weights and member ` +
      `hotels that the workbook does not carry. Set them up on the Clusters page.`
  );

  if (blocksOmitted === "not_requested" && detected.blocks.length > 0) {
    warnings.push(
      `${detected.blocks.length} benefit block(s) were found but not imported ` +
        `— "Benefit blocks" is switched off. They are listed above with the ` +
        `base and account each one uses, so you can build them on the ` +
        `Positions page and paste the values in from Excel.`
    );
  }

  if (blocks.some((block) => block.input.spread === "DAYS")) {
    warnings.push(
      `Daily-spread blocks: the old tool spread hourly staff by calendar days ` +
        `and salaried staff over a flat 30-day month. Here both follow the ` +
        `hotel's calendar, so a month can differ slightly for hourly-paid rows.`
    );
  }

  const preview: LegacyImportPreview = {
    filePath: context.filePath,
    sourceFileName: workbook.sourceFileName,
    fileHotelName: workbook.hotelName,
    fileOu: workbook.ou,
    fileYear: workbook.enteredYear,
    fileVersion: layout.declaredVersion,
    resolvedVersion: layout.version,
    versionSource: layout.source,
    versionNotes: layout.notes,
    positionCount: positions.length,
    // Everything found, so an unimported band is still a recipe.
    blocks: detected.blocks.map((block) => block.preview),
    blocksOmitted,
    skippedBlocks: skipped,
    manualInputRowCount: manualRows.length,
    allocationNames: allocations.map((allocation) => allocation.name),
    fullTimeWeeklyHours: context.options.calendarAndHours
      ? workbook.fullTimeWeeklyHours
      : null,
    publicHolidaysByMonth: context.options.calendarAndHours
      ? workbook.publicHolidaysByMonth
      : null,
    warnings,
  };

  return {
    preview,
    blocks,
    positions,
    manualRows,
    allocations,
    publicHolidaysByMonth: preview.publicHolidaysByMonth,
    weeklyHours: preview.fullTimeWeeklyHours,
    warnings,
  };
}
