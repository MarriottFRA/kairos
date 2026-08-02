/**
 * Blocks — shared types + IPC channel names.
 *
 * A "block" is the user-facing configuration for a cost/stat calculation the
 * positions grid renders as a column band. Saving a block COMPILES it into
 * 1..n engine cost-component definitions (deterministic ids `<blockId>:cost`
 * and, for dual-output blocks, `<blockId>:stat`) in the plaintext structure
 * store — the engine itself only ever sees CostComponentDefinition rows.
 * Per-position inputs stay in the encrypted component_values table.
 *
 * This module is the single contract imported by both the renderer service
 * and the main-process repo.
 */

import type {
  CostComponentDefinition,
  SocialSecurityScheme,
  SpreadMethod,
} from "../engine/types";

/** The user-facing block palette. */
export type BlockType =
  | "MULTIPLIER" // per-row multiplier × a chosen base series
  | "FLAT_MONTHLY" // per-row absolute amount booked each active month
  | "COUNT_RATE" // per-row count × rate → cost account, count → stats account
  | "CUSTOM_MONTHLY" // per-row 12 monthly amounts
  | "SOCIAL_SECURITY" // NI/SS scheme on a contributory base
  | "POOL_SPREAD"; // one pot (KPI or typed) divided among eligible positions

export const BLOCK_TYPES: readonly BlockType[] = [
  "MULTIPLIER",
  "FLAT_MONTHLY",
  "COUNT_RATE",
  "CUSTOM_MONTHLY",
  "SOCIAL_SECURITY",
  "POOL_SPREAD",
] as const;

/**
 * Every block type can be created by the user. SOCIAL_SECURITY is added like the
 * rest (as many as the OU needs — one grid column each), but through the
 * specialized scheme dialog rather than the generic block form.
 */
export const USER_ADDABLE_BLOCK_TYPES: readonly BlockType[] = BLOCK_TYPES;

/**
 * How a COUNT_RATE block distributes its yearly figures across months.
 *
 * The WEIGHTED_* family all compile to the engine's WEIGHTED_BY_BASE, which
 * distributes a yearly figure over whatever its base selector resolves to — so
 * "spread like hours" is that method pointed at the system hours stat, and
 * needs no engine work. See SPREAD_TO_STAT_BASE.
 */
export type BlockSpread =
  | "ACTIVE_MONTHS" // evenly over the position's working months
  | "DAYS" // proportional to working days per month
  | "VACATION_PATTERN" // following the position's vacation weights
  | "WEIGHTED_BASE" // proportional to the monthly base-salary curve
  | "WEIGHTED_HOURS_WORKED" // proportional to the hours-worked curve
  | "WEIGHTED_HOURS_PAID" // proportional to the hours-paid curve
  | "WEIGHTED_FTE"; // proportional to the FTE curve

/**
 * What a MULTIPLIER block multiplies against. BASE_SALARY / BLOCK / COMPOSITE
 * compile to the engine's existing BaseSelector; KPI compiles to the
 * kpi_driver_id path (series × per-row multiplier, resolved at engine load).
 * STAT / CALENDAR / VACATION are stored as a base_ref JSON on the definition and
 * light up with the matching engine BaseSelector extensions.
 *
 * COMPOSITE is the sum of several series — base salary and/or other blocks'
 * cost lines. It needs no engine work: the engine's COMPONENTS selector has
 * always accepted a list, and it already reads the BASE_SALARY definition as
 * gross salary when that id appears among the refs (see engine/reference.ts
 * resolveBase and the matching branch in engine/compile.ts). Legacy Excel tools
 * routinely define pension/bonus this way — "% of salary + food allowance + …".
 */
export type BlockBaseRef =
  | { kind: "BASE_SALARY" }
  | { kind: "BLOCK"; blockId: string }
  | { kind: "COMPOSITE"; includeBaseSalary: boolean; blockIds: string[] }
  | { kind: "KPI"; kpiDriverId: string }
  | { kind: "STAT"; stat: "HOURS" | "HOURS_PAID" | "HEADCOUNT" | "FTE" }
  | { kind: "CALENDAR"; series: "PAY_DAYS" | "REAL_DAYS" | "HOLIDAY_DAYS" }
  | { kind: "VACATION" }
  /**
   * The compound block: two bases and an operation between them, so the
   * "multiplier" can be another block rather than a typed number. COMPOSITE
   * already covers addition of several series; this is what expresses a
   * difference, a product or a ratio.
   *
   * Sides may not themselves be COMBINE (validated) — the VM saves exactly one
   * operand vector. KPI is also rejected as a side, since a KPI base compiles
   * to a different engine path (DIRECT_ABS) rather than a base series.
   */
  | { kind: "COMBINE"; op: BlockCombineOp; left: BlockBaseRef; right: BlockBaseRef };

/** The operations a compound block offers. */
export type BlockCombineOp = "ADD" | "SUB" | "MUL" | "DIV";

export const BLOCK_COMBINE_OPS: readonly BlockCombineOp[] = [
  "ADD",
  "SUB",
  "MUL",
  "DIV",
] as const;

export const BLOCK_COMBINE_OP_META: Record<
  BlockCombineOp,
  { symbol: string; label: string }
> = {
  ADD: { symbol: "+", label: "Plus" },
  SUB: { symbol: "−", label: "Minus" },
  MUL: { symbol: "×", label: "Times" },
  DIV: { symbol: "÷", label: "Divided by" },
};

/** Where a POOL_SPREAD block's monthly pot comes from. */
export type PoolSource =
  | "KPI" // a KPI driver's cached series (already multiplier-applied)
  | "MANUAL"; // twelve amounts typed into the block config

/**
 * The per-position weight a POOL_SPREAD block divides its pot by. Mirrors the
 * Allocations vocabulary (see shared/allocations/ipc.ts) minus CONTRACT_DAYS,
 * whose inputs (contractYearlyDays / contractDaysOff) are POSITION_EXTRA and
 * never reach the engine Position type.
 *
 * MANHOURS_PAID is available here on the engine's own definition — worked hours
 * plus vacation hours, both already on Position — rather than Allocations'
 * contract-days formula. The two differ by public holidays; see the STAT
 * HOURS_PAID note in engine/reference.ts.
 */
export type PoolSpreadBase =
  | "HEADCOUNT"
  | "FTE"
  | "MANHOURS_WORKED"
  | "MANHOURS_PAID"
  | "BASE_SALARY"
  | "VACATION_DAYS"
  | "FLAT";

export const POOL_SPREAD_BASES: readonly PoolSpreadBase[] = [
  "HEADCOUNT",
  "FTE",
  "MANHOURS_WORKED",
  "MANHOURS_PAID",
  "BASE_SALARY",
  "VACATION_DAYS",
  "FLAT",
] as const;

export const POOL_SPREAD_BASE_META: Record<
  PoolSpreadBase,
  { label: string; hint: string }
> = {
  HEADCOUNT: {
    label: "Headcount",
    hint: "Equal per head — a row counting 3 people takes three shares.",
  },
  FTE: {
    label: "FTE",
    hint: "By full-time equivalent, so part-timers take a smaller share.",
  },
  MANHOURS_WORKED: {
    label: "Man-hours worked",
    hint: "By hours actually worked over the year, vacation excluded.",
  },
  MANHOURS_PAID: {
    label: "Man-hours paid",
    hint: "By hours paid over the year, vacation included. Reads slightly lower than the Manhours Paid grid column, which also counts public holidays.",
  },
  BASE_SALARY: {
    label: "Base salary",
    hint: "Higher earners take proportionally more. Note that hourly-paid positions carry no monthly base salary and would take nothing.",
  },
  VACATION_DAYS: {
    label: "Vacation days",
    hint: "By contractual vacation entitlement.",
  },
  FLAT: {
    label: "Flat (equal per row)",
    hint: "Every eligible row takes the same share regardless of how many people it counts. With share weights on top, this is the classic 'points' pool.",
  },
};

/** How a POOL_SPREAD block decides which positions share the pot. */
export type PoolEligibilityMode =
  | "MANUAL" // per-row share weight in the grid — anything above zero is in
  | "RULE"; // department / classification filters here in the config

/** Number of monthly amounts a MANUAL pool carries. */
export const POOL_MONTHS = 12;

/**
 * The share weight of a position nobody has weighted — one whole share.
 *
 * Weights multiply the spread basis, so 1 is the neutral element: leaving every
 * weight alone reproduces exactly the split this feature had before weights
 * existed, which is what makes the upgrade safe for saved plans.
 */
export const POOL_WEIGHT_DEFAULT = 1;

/**
 * The most a share weight may be. Not a modelling opinion — a guard. The weights
 * divide by their own sum, so an accidental 1e9 pasted into one cell would round
 * everyone else's share to zero without any other symptom.
 */
export const POOL_WEIGHT_MAX = 1000;

/** The payload the renderer sends to create/update a block. */
export interface BlockInput {
  /** Omit to create; present to update an existing block. */
  id?: string;
  /** Immutable after create (the input shape and stored values depend on it). */
  blockType: BlockType;
  label: string;
  /** GL account the cost line posts to. "" = calculation only (never output). */
  accountCode: string;
  /** true = same account for every row; false = per-row dropdown. */
  accountLocked: boolean;
  /** COUNT_RATE only: the stats account the count line posts to. */
  statsAccountCode?: string;
  statsAccountLocked?: boolean;
  /** MULTIPLIER only. */
  base?: BlockBaseRef;
  /** MULTIPLIER + COMBINE base: keep a per-row multiplier column as well as the
   *  two combined sides. False = the block is pure calculation with no grid
   *  input. Ignored for every other base kind, which always has a rate.
   *  Defaults to true. */
  useRowRate?: boolean;
  /** MULTIPLIER + COMBINE base: exempt the line from the engine's headcount
   *  multiplier because it is a ratio. Defaults to true for DIV, false
   *  otherwise (a ÷ b is the same figure however many people the row counts). */
  ratioNoHeadcount?: boolean;
  /** COUNT_RATE only; defaults to ACTIVE_MONTHS. */
  spread?: BlockSpread;
  /** Apply the merit increase from the position's increase month onward. */
  increaseAware?: boolean;
  /** Book to each position's own department, or always to a fixed one. */
  departmentMode?: "POSITION" | "FIXED";
  fixedDepartment?: string;
  /** SOCIAL_SECURITY only: the scheme (brackets + caps + contributory base) this
   *  block runs. Unset = unconfigured → compiles to no def (harmless), grid
   *  shows "set up NI". A block's membership in any scheme's base now lives on
   *  the scheme itself (SocialSecurityScheme.baseComponentIds), not here. */
  ssSchemeId?: string;
  /** POOL_SPREAD only — see BlockDto for the semantics of each. */
  poolSource?: PoolSource;
  poolKpiDriverId?: string;
  poolMonthlyAmounts?: number[];
  poolSpreadBase?: PoolSpreadBase;
  poolEligibilityMode?: PoolEligibilityMode;
  poolDepartments?: string[];
  poolJobTypes?: string[];
  poolJobTypeWeights?: Record<string, number>;
}

/** A block as seen by the renderer. */
export interface BlockDto {
  id: string;
  ou: string;
  blockType: BlockType;
  label: string;
  accountCode: string;
  accountLocked: boolean;
  statsAccountCode: string;
  statsAccountLocked: boolean;
  base?: BlockBaseRef;
  /** MULTIPLIER + COMBINE base — see BlockInput. Defaults to true; drives
   *  whether the grid shows a multiplier column (blockInputSlots). */
  useRowRate?: boolean;
  /** MULTIPLIER + COMBINE base — see BlockInput. */
  ratioNoHeadcount?: boolean;
  spread: BlockSpread;
  increaseAware: boolean;
  departmentMode: "POSITION" | "FIXED";
  fixedDepartment?: string;
  /** SOCIAL_SECURITY only: attached scheme id ("" = unconfigured). */
  ssSchemeId?: string;
  /** SOCIAL_SECURITY only: true when the attached scheme is CUMULATIVE with a
   *  non-January tax year — the only case with a prior-year opening base. Gates
   *  the per-row "Opening base" input column (resolved server-side against the
   *  scheme, since BlockDto alone has no accumulation fields). */
  ssCumulativeNonJan?: boolean;
  /**
   * POOL_SPREAD only. The block owns ONE pot per month and divides it among the
   * eligible positions, so — unlike every other block type — the per-row figures
   * are an output, and their sum is exactly the pot. See
   * shared/positions/poolSpread.ts for the division itself.
   */
  poolSource?: PoolSource;
  /** POOL_SPREAD + poolSource KPI: the driver whose series is the pot. */
  poolKpiDriverId?: string;
  /** POOL_SPREAD + poolSource MANUAL: twelve amounts, Jan..Dec. */
  poolMonthlyAmounts?: number[];
  /** POOL_SPREAD: what each eligible position's share is proportional to. The
   *  per-row share weight multiplies whatever this picks. */
  poolSpreadBase?: PoolSpreadBase;
  /** POOL_SPREAD: RULE derives membership here (the grid's weight column then
   *  only tunes the size of a member's share); MANUAL reads membership off that
   *  column itself — any weight above zero is in the pool. */
  poolEligibilityMode?: PoolEligibilityMode;
  /** POOL_SPREAD + RULE: department codes; empty means every department. */
  poolDepartments?: string[];
  /** POOL_SPREAD + RULE: job-type codes; empty means every classification. */
  poolJobTypes?: string[];
  /**
   * POOL_SPREAD + RULE: the default share weight per job classification —
   * `{ "Manager": 1.5, "Supervisor": 1.25 }`. A classification that is absent
   * (or set to 1) takes one whole share. A weight typed on the row itself wins.
   *
   * RULE only, and deliberately so: under MANUAL the row's own number is both
   * "in the pool" and "how big a share", so there is no such thing as a member
   * with no weight of their own for a default to fill in.
   */
  poolJobTypeWeights?: Record<string, number>;
  sortOrder: number;
  updatedAt: string;
  /** Compiled engine definition ids (the grid keys inputs/totals by these). */
  costDefId: string;
  /** Present for dual-output blocks (COUNT_RATE). */
  statDefId?: string;
}

/**
 * The full structure read model for the OU: blocks plus the raw engine
 * definitions (blocks' compiled defs AND any non-block definitions such as
 * BASE_SALARY) and SS schemes — everything the renderer live-sim needs.
 */
export interface BlocksListResponse {
  blocks: BlockDto[];
  definitions: CostComponentDefinition[];
  ssSchemes: SocialSecurityScheme[];
}

/** Deterministic definition ids a block compiles to. */
export function blockCostDefId(blockId: string): string {
  return `${blockId}:cost`;
}
export function blockStatDefId(blockId: string): string {
  return `${blockId}:stat`;
}

/**
 * Deterministic ids of the permanent SYSTEM definitions — the heads that exist
 * for every OU regardless of which blocks the user has built (see
 * blocks/repo.ensureSystemDefs, which seeds them).
 *
 * Shared rather than main-only because the renderer needs them too: each is the
 * definition a Positions-grid account column posts through, and both engine-input
 * assemblies attach the per-row account by these ids (see
 * engineInput.applyPositionAccounts).
 */
export function baseSalaryDefId(ou: string): string {
  return `sys-base:${ou}`;
}
export function positionCountDefId(ou: string): string {
  return `sys-poscount:${ou}`;
}
export function systemStatDefId(
  ou: string,
  stat: "HOURS" | "HOURS_PAID" | "HEADCOUNT" | "FTE"
): string {
  return `sys-stat-${stat.toLowerCase()}:${ou}`;
}
export function holidayAccrualDefId(ou: string): string {
  return `sys-accrual:${ou}`;
}
export function vacationCostDefId(ou: string): string {
  return `sys-vaccost:${ou}`;
}

/** Engine spread method a BlockSpread maps to (yearly value is synthesized
 *  per row by the block-value resolver: count × rate or count alone). */
export const SPREAD_TO_METHOD: Record<BlockSpread, SpreadMethod> = {
  ACTIVE_MONTHS: "FLAT_PER_ACTIVE_MONTH",
  DAYS: "FLAT_PER_DAY",
  VACATION_PATTERN: "VACATION_WEIGHTED",
  WEIGHTED_BASE: "WEIGHTED_BY_BASE",
  WEIGHTED_HOURS_WORKED: "WEIGHTED_BY_BASE",
  WEIGHTED_HOURS_PAID: "WEIGHTED_BY_BASE",
  WEIGHTED_FTE: "WEIGHTED_BY_BASE",
};

/**
 * Which system stat definition a WEIGHTED_* spread points its base selector at.
 * Absent = the engine default, the base-salary curve (WEIGHTED_BASE). Kept as a
 * companion map rather than reshaping SPREAD_TO_METHOD, which is read in several
 * places that only care about the method.
 */
export const SPREAD_TO_STAT_BASE: Partial<
  Record<BlockSpread, "HOURS" | "HOURS_PAID" | "FTE">
> = {
  WEIGHTED_HOURS_WORKED: "HOURS",
  WEIGHTED_HOURS_PAID: "HOURS_PAID",
  WEIGHTED_FTE: "FTE",
};

/** Dropdown labels + hints for the COUNT_RATE spread choice. */
export const BLOCK_SPREAD_META: Record<
  BlockSpread,
  { label: string; hint: string }
> = {
  ACTIVE_MONTHS: {
    label: "Evenly over months",
    hint: "The same amount each month the position is active.",
  },
  DAYS: {
    label: "By days in month",
    hint: "Proportional to working days, so longer months carry more.",
  },
  VACATION_PATTERN: {
    label: "Like vacation",
    hint: "Following the position's vacation weights.",
  },
  WEIGHTED_BASE: {
    label: "Like salary",
    hint: "Proportional to the monthly base-salary curve, so it steps with merit increases.",
  },
  WEIGHTED_HOURS_WORKED: {
    label: "Like hours worked",
    hint: "Proportional to hours actually at work, so vacation months carry less.",
  },
  WEIGHTED_HOURS_PAID: {
    label: "Like hours paid",
    hint: "Proportional to hours paid, vacation included.",
  },
  WEIGHTED_FTE: {
    label: "Like FTE",
    hint: "Proportional to the full-time-equivalent curve across the year.",
  },
};

export const BLOCKS_CHANNELS = {
  /** Blocks + raw definitions + SS schemes for the OU. */
  list: "blocks:list",
  /** Create or update a block (recompiles its definitions); returns the list. */
  save: "blocks:save",
  /** Soft-delete a block (refused while another block uses it as a base). */
  delete: "blocks:delete",
  /** Restore a soft-deleted block. */
  restore: "blocks:restore",
  /** Persist a new display order (also the engine's deterministic tie-break). */
  reorder: "blocks:reorder",
} as const;
