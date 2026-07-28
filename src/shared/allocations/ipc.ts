/**
 * Allocations — shared types + IPC channel names.
 *
 * An allocation is a shared cost (e.g. "Laundry", "Employee Meal") that has to be
 * pushed out across departments in proportion to a chosen driver (the "spread
 * base" — head count, FTE, hours, salary, …). The page shows a grid of
 * departments (rows) × allocations (columns); each column is normalized so its
 * percentages sum to 100. A department can be excluded from an allocation (zeroed
 * before normalizing) so the cost isn't charged back to the department that owns
 * it. This reproduces the legacy VBA `Full_Alloc_Recalc`.
 *
 * Definitions are per-hotel reference data (OU-gated, like blocks); they live in
 * the PLAINTEXT structure store. The grid values are computed on demand from the
 * hotel's active positions — nothing about the grid itself is stored.
 *
 * This module is the single contract imported by both the renderer service and
 * the main-process repo/handlers.
 */

/** The driver a column spreads by. Every per-head metric is summed weighted by
 *  the position's headcount; FLAT gives each department an equal share. */
export type SpreadBase =
  | "HEADCOUNT"
  | "FTE"
  | "MANHOURS_WORKED"
  | "MANHOURS_PAID"
  | "BASE_SALARY"
  | "CONTRACT_DAYS"
  | "VACATION_DAYS"
  | "FLAT";

/** Ordered for the dropdown; label is what the user sees. */
export const SPREAD_BASE_META: ReadonlyArray<{
  base: SpreadBase;
  label: string;
  hint: string;
}> = [
  { base: "HEADCOUNT", label: "Head Count", hint: "Sum of Count per department." },
  { base: "FTE", label: "FTE", hint: "Sum of FTE × Count per department." },
  {
    base: "MANHOURS_WORKED",
    label: "Manhours Worked",
    hint: "Sum of worked hours × Count (calendar-derived, matches the engine).",
  },
  {
    base: "MANHOURS_PAID",
    label: "Manhours Paid",
    hint: "Sum of paid hours × Count ((yearly days − days off) × daily hours).",
  },
  { base: "BASE_SALARY", label: "Base Salary", hint: "Sum of Monthly Basic × Count." },
  {
    base: "CONTRACT_DAYS",
    label: "Contract Days",
    hint: "Sum of yearly contract days × Count.",
  },
  {
    base: "VACATION_DAYS",
    label: "Vacation Days",
    hint: "Sum of vacation days × Count.",
  },
  {
    base: "FLAT",
    label: "Flat / Equal",
    hint: "Every department gets an equal share.",
  },
];

const SPREAD_BASE_SET: ReadonlySet<string> = new Set(
  SPREAD_BASE_META.map((entry) => entry.base)
);

export function isValidSpreadBase(value: unknown): value is SpreadBase {
  return typeof value === "string" && SPREAD_BASE_SET.has(value);
}

export function spreadBaseLabel(base: SpreadBase): string {
  return SPREAD_BASE_META.find((entry) => entry.base === base)?.label ?? base;
}

/** An allocation definition as seen by the renderer. */
export interface AllocationDto {
  id: string;
  name: string;
  spreadBase: SpreadBase;
  /** Department codes zeroed out before normalizing (the cost's owners). */
  excludedDepartments: string[];
  /**
   * The account this allocation's split posts to on the Results page: one stat
   * row per department carrying the DECIMAL fraction (0.1523, not 15.23), the
   * same value in all 12 months. '' = not posted — the same "Blank" contract
   * the engine applies to calculation-only blocks.
   */
  injectAccount: string;
  sortOrder: number;
  updatedAt: string;
}

/** The payload the renderer sends to create/update an allocation. */
export interface AllocationInput {
  /** Omit to create; present to update an existing allocation. */
  id?: string;
  name: string;
  spreadBase: SpreadBase;
  excludedDepartments: string[];
  /** Omit or blank = the split is computed but not posted to Results. */
  injectAccount?: string;
}

/**
 * Percent (what the Allocations grid shows) → the decimal the Results page and
 * the BST carry. Kept here beside the contract so the projector and any future
 * consumer cannot drift on the factor.
 */
export function allocationPercentToDecimal(percent: number): number {
  return Number.isFinite(percent) ? percent / 100 : 0;
}

/** One department row of the spread grid. `values` maps allocationId → percent. */
export interface AllocationDeptRow {
  departmentCode: string;
  departmentName: string;
  values: Record<string, number>;
}

/**
 * The full view the page renders: the definitions plus the computed department
 * grid. Every mutation returns this refreshed (one round-trip, blocks idiom).
 */
export interface AllocationsViewResponse {
  allocations: AllocationDto[];
  departments: AllocationDeptRow[];
}

/**
 * Pure shape validation shared by the dialog and the repo (the repo adds the
 * name-clash check, which needs the database). Returns the canonicalized input;
 * throws with a user-facing message on invalid data.
 */
export function normalizeAllocationInput(input: AllocationInput): {
  id?: string;
  name: string;
  spreadBase: SpreadBase;
  excludedDepartments: string[];
  injectAccount: string;
} {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new Error("An allocation name is required.");
  if (!isValidSpreadBase(input?.spreadBase)) {
    throw new Error("Choose a spread base for the allocation.");
  }
  const raw = Array.isArray(input?.excludedDepartments)
    ? input.excludedDepartments
    : [];
  // De-dupe, drop blanks, keep as trimmed strings.
  const excludedDepartments = [
    ...new Set(raw.map((code) => String(code ?? "").trim()).filter(Boolean)),
  ];
  // Blank is legal and meaningful: "computed, but not posted to Results".
  const injectAccount = String(input?.injectAccount ?? "").trim();
  return {
    id: input.id,
    name,
    spreadBase: input.spreadBase,
    excludedDepartments,
    injectAccount,
  };
}

export const ALLOCATIONS_CHANNELS = {
  /** All non-deleted allocations + the computed department grid for a scenario. */
  list: "allocations:list",
  /** Create or update an allocation; returns the refreshed view. */
  save: "allocations:save",
  /** Soft-delete an allocation; returns the refreshed view. */
  delete: "allocations:delete",
} as const;
