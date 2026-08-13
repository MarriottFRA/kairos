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
 *                   staff who work each bank holiday, valued at the
 *                   per-working-day base pay. Global toggle, at most one per
 *                   scenario. All of its knobs fold into a single per-position
 *                   coefficient before the VM runs — see bankHolidayCoefficient.
 *  SPREAD           a configurable lego (see SpreadMethod).
 *  SOCIAL_SECURITY  progressive bracket contribution over a configurable base.
 *  STAT             non-currency line: headcount / FTE / hours worked / hours paid.
 */
export type ComponentKind =
  | "BASE_SALARY"
  | "HOLIDAY_ACCRUAL"
  | "BANK_HOLIDAY"
  | "SPREAD"
  | "SOCIAL_SECURITY"
  | "STAT";

/** HOURS = hours actually at work; HOURS_PAID = the same total with the vacation
 *  hours left in (worked + vacation). See hoursWorked/hoursPaid in reference.ts. */
export type StatKind = "HEADCOUNT" | "FTE" | "HOURS" | "HOURS_PAID";

/** The day-count series a CALENDAR base can resolve to. See BaseSelector. */
export type CalendarSeries = "PAY_DAYS" | "REAL_DAYS" | "HOLIDAY_DAYS";

/** ACC_ADD_DAYS' arg0 encoding — the wire form of CalendarSeries. Shared by the
 *  compiler and the disassembler so the numbering has exactly one home. */
export const CALENDAR_SERIES_ARG: Record<CalendarSeries, number> = {
  PAY_DAYS: 0,
  REAL_DAYS: 1,
  HOLIDAY_DAYS: 2,
};

/** Which length-of-service series a SERVICE base reads. MONTH is the month's
 *  own increment, TOTAL the running service to date. See BaseSelector. */
export type ServiceMode = "MONTH" | "TOTAL";

/** ACC_ADD_SERVICE's arg0 encoding — the wire form of ServiceMode. */
export const SERVICE_MODE_ARG: Record<ServiceMode, number> = {
  MONTH: 0,
  TOTAL: 1,
};

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
 * pay-type day basis (realDays for hourly, flat 30s for salaried), REAL_DAYS
 * is the productive-days calendar regardless of pay type, and HOLIDAY_DAYS is
 * the public-holiday count per month — all × seasonality, so inactive months
 * contribute nothing. VACATION resolves to the position's vacation-cost series
 * (the same values BASE_DEDUCT nets out of the salary line). These two power
 * "multiplier of days / vacation cost" blocks; HOLIDAY_DAYS in particular is
 * the escape hatch for holiday-driven costs the built-in BANK_HOLIDAY premium
 * does not model.
 */
export type BaseSelector =
  | { kind: "BASE_SALARY" }
  | { kind: "COMPONENTS"; componentIds: ComponentDefId[] }
  | { kind: "CALENDAR"; series: CalendarSeries }
  /**
   * Length of service, in pure calendar days from the position's hiring date —
   * the base for end-of-service / indemnity accruals, which are written against
   * service, not attendance. MONTH is the days falling in that month (zero
   * before the hiring month, partial in it); TOTAL is the running service to
   * the end of that month, prior years included.
   *
   * Unlike CALENDAR this is per-position, counts non-working days, and is
   * gated by seasonality rather than scaled by it — see serviceSeries. A
   * position with no hiring date resolves to zero in every month.
   */
  | { kind: "SERVICE"; mode: ServiceMode }
  | { kind: "VACATION" }
  /**
   * The Social-Security contributory base, decomposed. `includeBaseSalary` adds
   * the NET base-salary line (gross − vacation); `includeVacation` adds the
   * vacation series; `componentIds` add other (non-base, non-vacation) lines.
   * Ticking both flags reproduces gross base salary. Built at engine load by
   * applySocialSecurityBase from the scheme's own base membership — unlike
   * COMPONENTS, a base-salary id here means the NET line, not gross.
   */
  | {
      kind: "SS_BASE";
      includeBaseSalary: boolean;
      includeVacation: boolean;
      componentIds: ComponentDefId[];
    }
  /**
   * Two selectors combined by an arithmetic operation — the "compound block".
   * COMPONENTS can only ever SUM its refs, so this is what expresses a
   * difference, a product or a ratio between two series (e.g. cost ÷ hours).
   *
   * DIV yields 0 in any month the divisor is 0, matching WEIGHTED_BY_BASE's
   * zero-total guard: a block silently contributing nothing beats an Infinity
   * poisoning every downstream aggregate.
   *
   * Recursive by type, but the compiler VALIDATES TO DEPTH 1 — neither side may
   * itself be a COMBINE, because the VM holds exactly one saved operand vector
   * (see Op.ACC_PUSH). The type stays recursive so lifting that cap later is a
   * compiler change, not a stored-data migration.
   */
  | {
      kind: "COMBINE";
      op: CombineOp;
      left: BaseSelector;
      right: BaseSelector;
      /**
       * Fixed multiplier, replacing the per-position ComponentValue.rate. Set
       * when a compound block carries NO per-row input column: without it the
       * absent value would read as rate 0 and zero the line, where the block
       * plainly means "just the combination" (rate 1). Leave undefined to take
       * the rate from each position's stored value as usual.
       */
      rate?: number;
    };

/** Arithmetic a COMBINE selector applies between its two sides. */
export type CombineOp = "ADD" | "SUB" | "MUL" | "DIV";

/** Wire order — the VM carries the op as an index in its param pool. */
export const COMBINE_OPS: readonly CombineOp[] = ["ADD", "SUB", "MUL", "DIV"] as const;

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
   * DEPENDENCY EDGES ONLY, never values: the definitions this def's rate rules
   * may use as a block-valued multiplier (ComponentValue.rateDefId picks one
   * per position). The topological sort orders those lines first; nothing else
   * reads this. Injected at load time from the block configs by
   * applyRuleRateDependencies — not persisted on the definition row.
   */
  ruleRateDefIds?: ComponentDefId[];
  /**
   * Exempt this line from the count × cluster-weight post-pass, which normally
   * books every line `headcount` times over. Set for RATIOS — a line like
   * cost ÷ hours is already the per-person figure and is the SAME figure for a
   * row standing for three identical people, so scaling it would treble a
   * number that should not move. Off by default; every existing line keeps its
   * behaviour. (The HEADCOUNT stat and DIRECT_ABS are exempt on their own
   * account and do not need this.)
   */
  countExempt?: boolean;
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
  /** Fraction of a position's headcount rostered to work each bank holiday
   *  (0..1). Required when kind === "BANK_HOLIDAY". */
  bankHolidayStaffFraction?: number;
  /** Pay-rate multiplier for a worked bank holiday (e.g. 1.5, 2). Required when
   *  kind === "BANK_HOLIDAY". Whether the whole multiplier or only the uplift is
   *  charged depends on the position's pay type — see bankHolidayCoefficient. */
  bankHolidayPremiumMultiplier?: number;
  /** Who the premium is booked for. Absent = "HOURLY". */
  bankHolidayAppliesTo?: "HOURLY" | "ALL";
  /** Hourly staff are paid a normal day for the holiday even when off. */
  bankHolidayPaidWhenNotWorked?: boolean;
  /** Sparse per-department overrides of bankHolidayStaffFraction, keyed by
   *  department code. An absent key means the hotel-wide fraction. */
  bankHolidayCoverageByDepartment?: Record<string, number>;
}

/**
 * The BANK_HOLIDAY premium, folded into one per-position coefficient: the number
 * of days' base pay a single public holiday costs for one head of this position.
 * The VM then only does `coefficient · dayRate · holidayDays[m] · seas[m] · inc[m]`.
 *
 * The hourly/salaried split is not a policy choice — it falls out of which day
 * basis each pay type is paid on (see the `days` selection in compile.ts):
 *
 *   HOURLY   paid on realDays = calendar − public holidays − weekends, so the
 *            holiday is not in base pay at all. Working it is fully additional
 *            at the holiday rate. Where the day is paid regardless
 *            (paidWhenNotWorked), the staff who are OFF are also owed a normal
 *            day — pay the app's base has likewise left out.
 *   SALARIED paid on flat 30-day months, so the holiday is already covered by
 *            base pay. Only the uplift over a normal day is incremental.
 *
 * Shared by the compiler and the reference implementation: the parity test
 * between them is only meaningful if they compute this the same way, once.
 */
export function bankHolidayCoefficient(
  def: Pick<
    CostComponentDefinition,
    | "bankHolidayStaffFraction"
    | "bankHolidayPremiumMultiplier"
    | "bankHolidayAppliesTo"
    | "bankHolidayPaidWhenNotWorked"
    | "bankHolidayCoverageByDepartment"
  >,
  position: Pick<Position, "hourlyRate" | "departmentCode">
): number {
  const hourly = position.hourlyRate > 0;
  if (!hourly && (def.bankHolidayAppliesTo ?? "HOURLY") !== "ALL") return 0;

  const hotelWide = def.bankHolidayStaffFraction ?? 0;
  const override = def.bankHolidayCoverageByDepartment?.[position.departmentCode];
  const coverage = override === undefined ? hotelWide : override;
  const payRate = def.bankHolidayPremiumMultiplier ?? 0;

  if (!hourly) return coverage * Math.max(0, payRate - 1);
  return def.bankHolidayPaidWhenNotWorked
    ? coverage * payRate + (1 - coverage)
    : coverage * payRate;
}

/**
 * The SERVICE base resolved to twelve numbers for one position.
 *
 * MONTH is the position's per-month service days; TOTAL runs them up from the
 * prior-years carry-in, so month m holds the service accrued to the END of
 * month m. A position with no hiring date carries no series and resolves to
 * zeros — see serviceDaysPerMonth on Position.
 *
 * WHOLE calendar days, never scaled by seasonality — a day of service is a day
 * whether or not it was worked, and 0.6 of a statutory day means nothing. But
 * an INACTIVE month (seasonality 0) is gated to zero and does not accrue: the
 * engine's standing invariant is that a position not in the plan for a month
 * costs nothing that month, and an indemnity line is no exception. For the
 * ordinary all-active row the two rules coincide exactly.
 *
 * Shared by the compiler and the reference implementation for the same reason
 * bankHolidayCoefficient is: the parity test between them only means something
 * if they compute this the same way, once. The date → per-month step lives one
 * layer out in shared/positions/serviceDays.ts, so the engine stays PII-free.
 */
export function serviceSeries(
  position: Pick<Position, "serviceDaysPerMonth" | "serviceDaysOpening" | "seasonality">,
  mode: ServiceMode
): number[] {
  const perMonth = position.serviceDaysPerMonth;
  const out = new Array<number>(MONTHS).fill(0);
  if (!perMonth) return out;
  if (mode === "MONTH") {
    for (let m = 0; m < MONTHS; m++) {
      out[m] = position.seasonality[m] > 0 ? perMonth[m] ?? 0 : 0;
    }
    return out;
  }
  let running = position.serviceDaysOpening ?? 0;
  for (let m = 0; m < MONTHS; m++) {
    if (position.seasonality[m] <= 0) {
      out[m] = 0; // not in the plan this month — no accrual, no liability booked
      continue;
    }
    running += perMonth[m] ?? 0;
    out[m] = running;
  }
  return out;
}

export interface SsBracket {
  /** Upper cumulative-base bound of the bracket; null = unbounded (∞). */
  upTo: number | null;
  rate: number;
}

/**
 * How contributions accumulate across the year.
 * CUMULATIVE — the base runs up month to month within a tax year (with the
 *   yearly cap), resetting at the tax-year boundary. UK PAYE / annual schemes.
 * PER_PERIOD — each month stands alone against the brackets + monthly cap; no
 *   carry-over, no yearly cap. UK National Insurance.
 */
export type SsAccumulationMode = "CUMULATIVE" | "PER_PERIOD";

export interface SocialSecurityScheme extends SyncMeta {
  id: SsSchemeId;
  label: string;
  /** Cap applied to each month's contribution base before accumulation. Null = none. */
  monthlyCap: number | null;
  /** Cap on the cumulative yearly contribution base. Null = none. */
  yearlyCap: number | null;
  /** Ascending by upTo; at most SS_MAX_BRACKETS entries; only the last may be unbounded. */
  brackets: SsBracket[];
  /** Defaults to CUMULATIVE (today's behaviour) when absent. */
  accumulationMode?: SsAccumulationMode;
  /** Month (1–12) the tax year starts; the cumulative accumulator resets here.
   *  Defaults to 1 (January = calendar year) when absent — then the opening
   *  base is discarded and the run is identical to the pre-2c engine. */
  taxYearStartMonth?: number;
  /** Contributory base: include the NET base-salary line. Defaults to true. */
  includeBaseSalary?: boolean;
  /** Contributory base: include the vacation series. Defaults to true. */
  includeVacation?: boolean;
  /** Contributory base: cost-def ids of other blocks in this scheme's base. */
  baseComponentIds?: ComponentDefId[];
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
  /** Hotel-cluster name for the staffing overview grouping ("" = none). The
   *  loaders resolve the stored cluster id to its display name; the engine
   *  only ever sees this string as a grouping key. */
  cluster: string;
  /** Resolved hotel-cluster share of this position's costs (1 = fully owned
   *  by this hotel). Applied by the count-multiplier pass exactly like
   *  headcount — post-computation, with the same exemptions (HEADCOUNT stat,
   *  DIRECT_ABS) — so per-person effects (SS brackets/caps) run on the FULL
   *  salary first and the hotel then books its share. Resolution from cluster
   *  definitions + override happens at input-building time in both loaders
   *  (see src/shared/hotelClusters/resolve.ts); the engine never sees ids. */
  hotelClusterWeight: number;
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
  /**
   * Length of service in pure calendar days, resolved from the hiring date by
   * the loaders (see shared/positions/serviceDays.ts) — the engine never sees
   * the date itself, so ScenarioInput stays PII-free. Days per month of the
   * plan year: zero before the hiring month, partial in it, the whole month
   * after. Absent (or an unfilled hiring date) means zero service everywhere,
   * which is what the SERVICE base then resolves to.
   *
   * Optional because it is derived, not stored: every construction site that
   * predates the SERVICE base keeps working and simply has no service series.
   */
  serviceDaysPerMonth?: number[];
  /** Service days accrued before 1 January of the plan year — the prior-years
   *  carry-in that makes SERVICE/TOTAL a true length of service. Absent = 0. */
  serviceDaysOpening?: number;
}

/** The user-entered amount wiring one SPREAD component to one position.
 *  Which field applies depends on the definition's SpreadMethod; a missing
 *  ComponentValue simply yields a zero line for that position. */
export interface ComponentValue extends SyncMeta {
  positionId: PositionId;
  componentDefId: ComponentDefId;
  /** PERCENT_OF (0.1 = 10%). */
  rate?: number;
  /** PERCENT_OF only: a month-varying rate that overrides `rate` per month.
   *  Synthesized by the loaders when a block's rate rules contain a
   *  days-in-position or KPI term that flips inside the year — never
   *  user-entered, never persisted, never set on a COMBINE base (the loaders
   *  collapse a constant result back to `rate`). */
  monthlyRates?: number[];
  /** PERCENT_OF only: use ANOTHER definition's computed line as this
   *  position's multiplier — line = that line × the base, month by month.
   *  Synthesized by the loaders from a rule's block outcome; never persisted,
   *  never set together with monthlyRates, never on a COMBINE base. The owning
   *  def's ruleRateDefIds must list every candidate so the topo sort computes
   *  them first. A reference to a missing definition reads as a zero series. */
  rateDefId?: ComponentDefId;
  /** WEIGHTED_BY_BASE / FLAT_PER_ACTIVE_MONTH / FLAT_PER_DAY. */
  yearlyValue?: number;
  /** DIRECT_MONTHLY. */
  monthlyValues?: number[];
  /** QTY_TIMES_RATE (yearly qty × unit rate). */
  qty?: number;
  unitRate?: number;
  /** SOCIAL_SECURITY defs only: the position's cumulative NI/SS contribution
   *  base already accrued into the current tax year before its first simulated
   *  month (a non-January tax year straddles the prior calendar year). Seeds the
   *  SS accumulator; only consulted for a CUMULATIVE scheme with
   *  taxYearStartMonth > 1. Defaults to 0. Per (position, scheme) since each SS
   *  block is its own component def. */
  ssOpeningBase?: number;
  /** Per-line account override: when defined, this line's dept×account key
   *  uses it instead of the definition's account. Loaders populate it only
   *  for "unlocked" blocks; values never change, only the aggregation key. */
  accountCode?: string;
  /** Per-line department override: when defined, this line's dept×account key
   *  uses it instead of the department the definition resolves. Loaders
   *  populate it only for MULTIPLIER blocks in PER_ROW mode; like the account
   *  override it moves the key and nothing else. */
  departmentCode?: string;
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
