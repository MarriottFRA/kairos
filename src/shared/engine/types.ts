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
 *  DIRECT_ABS             the 12 values verbatim — no seasonality, no increase,
 *                         no headcount scaling. Internal only: the loader emits
 *                         it for KPI-driven blocks after resolving the KPI
 *                         series (already absolute per month) × the per-position
 *                         multiplier. Never chosen in the UI.
 *  QTY_TIMES_RATE         qty × unitRate = yearly value, then spread like
 *                         FLAT_PER_ACTIVE_MONTH (overtime hours × cost/hour)
 *  FLAT_MONTHLY           the user's single per-month amount × seasonality[m]
 *                         (a "fixed monthly amount" block; total = amount ×
 *                         totalWorkingMonths). Lowered to DIRECT at compile.
 *  VACATION_WEIGHTED      yearly value distributed by the position's vacation
 *                         monthly weights (normalized), × seasonality[m].
 *                         Lowered to DIRECT at compile.
 *  REVENUE_WEIGHTED       reserved — rejected by the compiler until revenue
 *                         data exists in the app
 */
export type SpreadMethod =
  | "PERCENT_OF"
  | "WEIGHTED_BY_BASE"
  | "FLAT_PER_ACTIVE_MONTH"
  | "FLAT_PER_DAY"
  | "DIRECT_MONTHLY"
  | "DIRECT_ABS"
  | "QTY_TIMES_RATE"
  | "FLAT_MONTHLY"
  | "VACATION_WEIGHTED"
  | "REVENUE_WEIGHTED";

/**
 *  BASE_SALARY      the salary engine block. Exactly one per scenario. Emits
 *                   the base-salary line NET of vacation cost (the workbook
 *                   deducted vacation from the salary line); percent/weighted
 *                   bases keep using the GROSS values.
 *  HOLIDAY_ACCRUAL  optional vacation-accrual line: accrualDays × costPerDay
 *                   × seasonality (increase-aware) − vacation cost.
 *  BANK_HOLIDAY     optional public-holiday premium line: the extra cost of the
 *                   staff who actually work each bank holiday, valued at the
 *                   per-working-day base pay. Hourly-wage staff only (their base
 *                   already excludes the holiday day), so a worked holiday is
 *                   pure additional cost. Global toggle, at most one per scenario
 *                   (see bankHolidayStaffFraction / bankHolidayPremiumMultiplier).
 *  SPREAD           a configurable lego (see SpreadMethod).
 *  SOCIAL_SECURITY  progressive bracket contribution over a configurable base.
 *  STAT             non-currency line: headcount / FTE / hours worked.
 */
export type ComponentKind =
  | "BASE_SALARY"
  | "HOLIDAY_ACCRUAL"
  | "BANK_HOLIDAY"
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
 *
 * CALENDAR resolves to a day-count series: PAY_DAYS is the position's own
 * pay-type day basis (realDays for hourly, flat 30s for salaried) and
 * REAL_DAYS is the productive-days calendar regardless of pay type — both ×
 * seasonality, so inactive months contribute nothing. VACATION resolves to
 * the position's vacation-cost series (the same values BASE_DEDUCT nets out
 * of the salary line). These two power "multiplier of days / vacation cost"
 * blocks.
 */
export type BaseSelector =
  | { kind: "BASE_SALARY" }
  | { kind: "COMPONENTS"; componentIds: ComponentDefId[] }
  | { kind: "CALENDAR"; series: "PAY_DAYS" | "REAL_DAYS" }
  | { kind: "VACATION" };

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
  /**
   * When set, this SPREAD def is KPI-driven: at engine load the KPI's
   * precalculated series (× the per-position multiplier in ComponentValue.rate)
   * is resolved into monthlyValues and the def is rewritten to spreadMethod
   * "DIRECT_ABS" before compile — so the VM/compiler never read this field.
   * Stored as a plain string to keep the engine free of KPI-module coupling.
   */
  kpiDriverId?: string;
  /** Required when kind === "SOCIAL_SECURITY". */
  ssSchemeId?: SsSchemeId;
  /** Fraction of a position's headcount that actually works each bank holiday
   *  (0..1). Required when kind === "BANK_HOLIDAY". */
  bankHolidayStaffFraction?: number;
  /** Pay-rate multiplier for a worked bank holiday (e.g. 1.5, 2). The premium is
   *  the full multiplier — hourly base excludes the holiday day, so the whole
   *  amount is additional. Required when kind === "BANK_HOLIDAY". */
  bankHolidayPremiumMultiplier?: number;
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
  /** Hourly pay rate. When > 0 the base salary is derived from
   *  rate × dailyContractHours × realDays[m] (net productive days) instead of
   *  monthlyBaseSalary. The two are mutually exclusive inputs — only one is
   *  entered per position; the UI locks the other. */
  hourlyRate: number;
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
  /** Distribution of vacation across the year, used as-is (the UI keeps the
   *  twelve weights summing to 1, like the workbook's Total Weights column).
   *  A vacation day is valued by the engine at the position's per-working-day
   *  base pay (base·twm/twd, or the hourly coeff), so no daily rate is stored. */
  vacationMonthlyWeights: number[];
  /** Vacation accrual: days accrued per month, valued at the same derived
   *  per-working-day base pay as vacation. */
  accrualDaysPerMonth: number;
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
  /** Per-line account override: when defined, this line's dept×account key
   *  uses it instead of the definition's account. Loaders populate it only
   *  for "unlocked" blocks; values never change, only the aggregation key. */
  accountCode?: string;
  /** Resolution-only (never read by the compiler): the dual-block stat line's
   *  per-row account, consumed by resolveDualBlockValues before compile. */
  statsAccountCode?: string;
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
  /** Public/bank-holiday count per month — the number subtracted out of
   *  realDays, kept here so the BANK_HOLIDAY component can value it. Zero-filled
   *  when the calendar carries no holidays. */
  holidayDays: Float64Array;
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
  | "MULTIPLE_BANK_HOLIDAY"
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
