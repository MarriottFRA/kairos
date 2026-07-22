/**
 * Payroll cost-spread simulation engine — domain model.
 * -----------------------------------------------------------
 * Pure, dependency-free types shared by the compiler, the VM, the reference
 * implementation, and (later) the persistence loaders. Nothing here touches
 * Electron, React, or the databases.
 *
 * The model replaces the legacy Excel workbook's hardcoded column layout with
 * user-configurable "lego" cost components:
 *
 *   structure (component definitions, schemes, labels)  → plaintext kairos.db
 *   values (positions, per-position amounts, buyouts)   → encrypted kairos_secure.db
 *
 * The engine itself never sees PII: a Position carries only budget-relevant
 * numbers. Names / employee refs live in a separate PII table whose loader is
 * never part of a ScenarioInput.
 *
 * All month vectors are Jan→Dec, length 12. `increaseMonth` is 1-based; a
 * value of 13 (or anything outside 1..12) means "no increase this year", and
 * 1 means the increase applies to the whole year.
 */

export const MONTHS = 12;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Every persisted entity uses a UUIDv7 string id (time-ordered, so ids sort by
 * creation and merge cleanly under future cloud sync). Branding prevents one
 * id kind being passed where another is expected.
 */
export type PositionId = string & { readonly __brand: "PositionId" };
export type ComponentDefId = string & { readonly __brand: "ComponentDefId" };
export type ScenarioId = string & { readonly __brand: "ScenarioId" };
export type SsSchemeId = string & { readonly __brand: "SsSchemeId" };
export type BuyoutRowId = string & { readonly __brand: "BuyoutRowId" };

/** Sync bookkeeping carried by every persisted entity. The engine ignores it —
 *  loaders must filter soft-deleted rows before building a ScenarioInput. */
export interface SyncMeta {
  updatedAt: string;
  deletedAt: string | null;
}

// ---------------------------------------------------------------------------
// Structure — component definitions (plaintext DB)
// ---------------------------------------------------------------------------

/**
 * How a SPREAD component distributes its yearly/monthly input across months.
 * These generalize the legacy workbook's hardcoded sections.
 *
 *  PERCENT_OF             rate × the selected base's monthly values
 *                         (pension, bonus %, incentive %)
 *  WEIGHTED_BY_BASE       yearly value distributed proportional to the
 *                         selected base's monthly distribution (indemnity)
 *  FLAT_PER_ACTIVE_MONTH  yearly / totalWorkingMonths × seasonality[m]
 *                         (housing, airfare, stock, hardship, overtime)
 *  FLAT_PER_DAY           yearly / totalWorkingDays × daysPerMonth[m] ×
 *                         seasonality[m] (transportation, food)
 *  DIRECT_MONTHLY         the user's 12 values × seasonality[m]
 *  QTY_TIMES_RATE         qty × unitRate = yearly value, then spread like
 *                         FLAT_PER_ACTIVE_MONTH (overtime hours × cost/hour)
 *  REVENUE_WEIGHTED       reserved — rejected by the compiler until revenue
 *                         data exists in the app
 */
export type SpreadMethod =
  | "PERCENT_OF"
  | "WEIGHTED_BY_BASE"
  | "FLAT_PER_ACTIVE_MONTH"
  | "FLAT_PER_DAY"
  | "DIRECT_MONTHLY"
  | "QTY_TIMES_RATE"
  | "REVENUE_WEIGHTED";

/**
 *  BASE_SALARY      the salary engine block. Exactly one per scenario. Emits
 *                   the base-salary line NET of vacation cost (the workbook
 *                   deducted vacation from the salary line); percent/weighted
 *                   bases keep using the GROSS values.
 *  HOLIDAY_ACCRUAL  optional vacation-accrual line: accrualDays × costPerDay
 *                   × seasonality (increase-aware) − vacation cost.
 *  SPREAD           a configurable lego (see SpreadMethod).
 *  SOCIAL_SECURITY  progressive bracket contribution over a configurable base.
 *  STAT             non-currency line: headcount / FTE / hours worked.
 */
export type ComponentKind =
  | "BASE_SALARY"
  | "HOLIDAY_ACCRUAL"
  | "SPREAD"
  | "SOCIAL_SECURITY"
  | "STAT";

export type StatKind = "HEADCOUNT" | "FTE" | "HOURS";

/**
 * Which monthly series feeds a PERCENT_OF / WEIGHTED_BY_BASE spread or a
 * social-security contribution base.
 *
 * BASE_SALARY means the gross base-salary values (before vacation deduction),
 * matching the workbook. COMPONENTS is an explicit inclusion list — the
 * replacement for the workbook's 20 hardcoded CN_A* booleans. Referencing the
 * BASE_SALARY component id inside COMPONENTS also resolves to the gross
 * series.
 */
export type BaseSelector =
  | { kind: "BASE_SALARY" }
  | { kind: "COMPONENTS"; componentIds: ComponentDefId[] };

export interface CostComponentDefinition extends SyncMeta {
  id: ComponentDefId;
  /** Hotel OU the definition belongs to. */
  ou: string;
  kind: ComponentKind;
  /** Required when kind === "SPREAD". */
  spreadMethod?: SpreadMethod;
  /** Required when kind === "STAT". */
  statKind?: StatKind;
  /** User-renamable display name of the lego. */
  label: string;
  /** GL account the emitted line posts to. */
  accountCode: string;
  /** Inherit the position's department, or post to a fixed one. */
  departmentMode: "POSITION" | "FIXED";
  fixedDepartment?: string;
  /**
   * When true the spread is multiplied by the merit-increase factor from
   * `increaseMonth` onward (the workbook applied this to base, vacation and
   * accrual only; it is now available to any SPREAD).
   */
  increaseAware: boolean;
  /** Stable ordering for display and deterministic compilation. */
  sortOrder: number;
  /** For PERCENT_OF / WEIGHTED_BY_BASE / SOCIAL_SECURITY. Defaults to base salary. */
  baseSelector?: BaseSelector;
  /** Required when kind === "SOCIAL_SECURITY". */
  ssSchemeId?: SsSchemeId;
}

export interface SsBracket {
  /** Upper cumulative-base bound of the bracket; null = unbounded (∞). */
  upTo: number | null;
  rate: number;
}

export interface SocialSecurityScheme extends SyncMeta {
  id: SsSchemeId;
  label: string;
  /** Cap applied to each month's contribution base before accumulation. Null = none. */
  monthlyCap: number | null;
  /** Cap on the cumulative yearly contribution base. Null = none. */
  yearlyCap: number | null;
  /** Ascending by upTo; at most SS_MAX_BRACKETS entries; only the last may be unbounded. */
  brackets: SsBracket[];
}

export const SS_MAX_BRACKETS = 7;

// ---------------------------------------------------------------------------
// Values — per-position data (encrypted DB)
// ---------------------------------------------------------------------------

/** Selects the day basis for day-proportional spreads:
 *  HOURLY → the real productive-days calendar, SALARIED → flat 30/360. */
export type PayType = "HOURLY" | "SALARIED";

export interface Position extends SyncMeta {
  id: PositionId;
  scenarioId: ScenarioId;
  departmentCode: string;
  /** Job-type code used for stats clustering (e.g. manager / associate / casual). */
  jobTypeCode: string;
  /** Department cluster for the staffing overview (e.g. Rooms, F&B). */
  cluster: string;
  payType: PayType;
  headcount: number;
  fte: number;
  /** Fractional activity per month, 0..1. Drives every spread. */
  seasonality: number[];
  monthlyBaseSalary: number;
  /** Extra salary cost per month, added on top of the day-spread base. */
  additionalMonthlyCosts: number[];
  /** Merit/other % increase applied from increaseMonth onward (0.05 = 5%). */
  meritIncreasePct: number;
  /** Fixed yearly increase, divided over active months ≥ increaseMonth. */
  manualYearlyIncrease: number;
  /** 1..12 = first month of the increase; 13 (or out of range) = none. */
  increaseMonth: number;
  /** Contract daily working hours (used for vacation-hour redistribution). */
  dailyContractHours: number;
  /** Contract yearly man-hours worked (the HOURS stat input). */
  yearlyHoursWorked: number;
  vacationDays: number;
  /** Cost of one vacation day. */
  dailyVacationCost: number;
  /** Distribution of vacation across the year, used as-is (the UI keeps the
   *  twelve weights summing to 1, like the workbook's Total Weights column). */
  vacationMonthlyWeights: number[];
  /** Vacation accrual: days accrued per month × cost per day. */
  accrualDaysPerMonth: number;
  accrualCostPerDay: number;
}

/** The user-entered amount wiring one SPREAD component to one position.
 *  Which field applies depends on the definition's SpreadMethod; a missing
 *  ComponentValue simply yields a zero line for that position. */
export interface ComponentValue extends SyncMeta {
  positionId: PositionId;
  componentDefId: ComponentDefId;
  /** PERCENT_OF (0.1 = 10%). */
  rate?: number;
  /** WEIGHTED_BY_BASE / FLAT_PER_ACTIVE_MONTH / FLAT_PER_DAY. */
  yearlyValue?: number;
  /** DIRECT_MONTHLY. */
  monthlyValues?: number[];
  /** QTY_TIMES_RATE (yearly qty × unit rate). */
  qty?: number;
  unitRate?: number;
}

/** Manual dept×account row that bypasses the position engine entirely
 *  (the workbook's "Buyout & Manual Input" sheet). */
export interface BuyoutRow extends SyncMeta {
  id: BuyoutRowId;
  scenarioId: ScenarioId;
  departmentCode: string;
  accountCode: string;
  monthlyValues: number[];
}

export interface Scenario extends SyncMeta {
  id: ScenarioId;
  ou: string;
  year: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Calendar context
// ---------------------------------------------------------------------------

/** Day counts per month for the two spread bases. Built from the app's
 *  calendar tables by calendarContext.ts. */
export interface CalendarContext {
  /** Weighted/real productive days per month (hourly-staff basis, and the
   *  basis for the HOURS stat regardless of pay type). */
  realDays: Float64Array;
  /** Flat 30-day months (salaried 30/360 basis). */
  flatDays: Float64Array;
}

// ---------------------------------------------------------------------------
// Engine input / output
// ---------------------------------------------------------------------------

/** Everything the compiler needs for one simulation scenario. Loaders are
 *  responsible for filtering soft-deleted rows and never including PII. */
export interface ScenarioInput {
  scenario: Scenario;
  calendar: CalendarContext;
  definitions: CostComponentDefinition[];
  ssSchemes: SocialSecurityScheme[];
  positions: Position[];
  componentValues: ComponentValue[];
  buyouts: BuyoutRow[];
}

export type CompileErrorCode =
  | "NO_POSITIONS"
  | "MISSING_BASE"
  | "MULTIPLE_BASE"
  | "MULTIPLE_ACCRUAL"
  | "MISSING_SCHEME"
  | "MISSING_SPREAD_METHOD"
  | "MISSING_STAT_KIND"
  | "UNSUPPORTED_METHOD"
  | "MISSING_DEF"
  | "INVALID_BASE_REF"
  | "INVALID_SCHEME"
  | "CYCLE"
  | "INVALID_POSITION";

export interface CompileError {
  code: CompileErrorCode;
  message: string;
  /** Ids/labels of the entities involved, when applicable. */
  refs?: string[];
}

export interface AggregateKey {
  dept: string;
  account: string;
}

export interface StatKey {
  cluster: string;
  jobTypeCode: string;
}

export interface SimulationTimings {
  compileMs?: number;
  execMs: number;
  aggMs: number;
}

export interface PositionLine {
  component: CostComponentDefinition;
  dept: string;
  account: string;
  /** A live subarray view into the line matrix — do not mutate. */
  months: Float64Array;
}

export interface SimulationResult {
  /** Dept×account aggregation. `values` is rows×12, row i keyed by keys[i]. */
  aggregates: { keys: AggregateKey[]; values: Float64Array };
  /** Yearly headcount / FTE by (cluster, jobType). */
  stats: { keys: StatKey[]; headcount: Float64Array; fte: Float64Array };
  /** Drill-down: every emitted line for one position (views, zero-copy). */
  positionLines(id: PositionId): PositionLine[];
  timings: SimulationTimings;
  /** Feed back into recalc() for incremental updates. */
  state: EngineState;
}

/** Opaque handle over the compiled plan + persistent value matrices.
 *  Created by simulate(), threaded through recalc(). */
export interface EngineState {
  plan: import("./compile").CompiledPlan;
  /** Line matrix, lineCount×12. */
  values: Float64Array;
  /** Aggregate matrix, aggRows×12 (rewritten by every aggregation pass). */
  aggValues: Float64Array;
  statHeadcount: Float64Array;
  statFte: Float64Array;
}
