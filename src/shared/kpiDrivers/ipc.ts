/**
 * KPI drivers — shared types + IPC channel names.
 *
 * A KPI driver aggregates the pulled budget (budget_values) into a reusable
 * 12-month series that engine cost-component blocks multiply against a
 * per-position multiplier. Definitions live in the plaintext local store; their
 * resolved series are precalculated and cached. This module is the single
 * contract imported by both the renderer service and the main-process repo.
 */

/** Number of month periods in a driver series (Jan..Dec). */
export const KPI_PERIOD_COUNT = 12;

/** Sentinel dept_key for an EXPLICIT driver's single series. */
export const KPI_EXPLICIT_DEPT_KEY = "*";

export type KpiDriverId = string & { readonly __brand: "KpiDriverId" };

/**
 * How the department filter is resolved:
 *   - EXPLICIT — the driver carries its own dept GLOB patterns, so it evaluates
 *     to one series regardless of which position references it.
 *   - POSITION — evaluated per position, filtered to that position's own
 *     departmentCode, so it yields a different series per department.
 */
export type KpiDeptMode = "EXPLICIT" | "POSITION";

/** Only SUM is supported today (see schema CHECK). */
export type KpiAggregation = "SUM";

/** A KPI-driver definition as seen by the renderer. */
export interface KpiDriver {
  id: KpiDriverId;
  ou: string;
  label: string;
  /** Optional free-text note; "" when unset. Searchable in the UI. */
  description: string;
  deptMode: KpiDeptMode;
  /** GLOB patterns; empty for POSITION mode. "*" means all departments. */
  deptPatterns: string[];
  /** Account prefixes (>=1); matched as (prefix || '*') via GLOB. */
  accountPrefixes: string[];
  /** Budget bucket to read from (1..3, default 1). */
  bucketIndex: number;
  /**
   * Factor applied to the aggregated series at recompute time (1 = as-is).
   * Lets a driver name a derived pot rather than a raw budget roll-up —
   * "Gratuities" = the F&B revenue accounts x 0.12. Because it is baked into
   * the cache, the KPI page and every consumer see the same final figure.
   */
  multiplier: number;
  aggregation: KpiAggregation;
  sortOrder: number;
  /** Code-defined default (read-only), derived at read time — never stored. */
  isBuiltin: boolean;
  /**
   * Cache is out of date: either computed against a superseded budget import,
   * or the definition changed after its last compute. Derived at read time.
   */
  isStale: boolean;
  updatedAt: string;
}

/** One resolved 12-period series (for display and load-time injection). */
export interface KpiDriverSeries {
  driverId: KpiDriverId;
  /** '*' for EXPLICIT, else a department code. */
  deptKey: string;
  /** length KPI_PERIOD_COUNT; missing periods are 0. */
  values: number[];
  sourceImportId: string | null;
  computedAt: string;
}

/** The payload the renderer sends to create/update a driver. */
export interface KpiDriverInput {
  /** Omit/empty to create; present to update an existing user driver. */
  id?: KpiDriverId;
  label: string;
  /** Optional free-text note; omitted/empty stores "". */
  description?: string;
  deptMode: KpiDeptMode;
  deptPatterns: string[];
  accountPrefixes: string[];
  bucketIndex: number;
  /** Omitted or non-finite stores 1 (no change to the aggregated series). */
  multiplier?: number;
}

/** A driver plus its computed series — the read model the tab renders. */
export interface KpiDriverWithSeries {
  driver: KpiDriver;
  series: KpiDriverSeries[];
}

export const KPI_DRIVERS_CHANNELS = {
  /** All drivers (user + built-in) for the OU, each with its cached series. */
  list: "kpiDrivers:list",
  /** Create or update a user driver, then recompute it; returns it with series. */
  save: "kpiDrivers:save",
  /** Soft-delete a user driver (built-ins rejected). */
  delete: "kpiDrivers:delete",
  /** Recompute one driver (or all, when driverId is omitted) for the OU. */
  recalc: "kpiDrivers:recalc",
} as const;
