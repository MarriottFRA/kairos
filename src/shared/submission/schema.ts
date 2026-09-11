/**
 * Budget submission — the wire schema.
 *
 * What a hotel sends head office once its plan is done: the staffing inputs
 * and the calculated staffing statistics, as dense tables the backend can
 * bulk-insert straight into Postgres. Every table is `{ columns, rows }` with
 * rows as arrays in column order, so a loader never has to interpret keys;
 * the column names ARE the Postgres column names.
 *
 * Deliberately NOT here (decided 2026-09-11):
 *   - money by department × account: the ledger pipeline owns financials
 *   - the blocks and their per-position values: the stats are the point
 *   - allocations: they move cost, not heads or hours
 *   - inactive positions: retained in the grid, never budgeted
 *   - any PII: the PII sidecar's name, number and hiring date never cross —
 *     only the position's title, which describes the post, not the person
 *
 * Months are Jan..Dec as `<prefix>_01` .. `<prefix>_12`, with `<prefix>_year`
 * beside them. Headcount ("calc_heads") is a LEVEL: a month is that month's
 * count and the year is December's. FTE and hours are what the run posted,
 * read exactly as the Staffing statistics report reads them.
 *
 * Bump SUBMISSION_SCHEMA_VERSION whenever a column is added, removed or
 * changes meaning; the backend keys its loader on it.
 */

export const SUBMISSION_SCHEMA_VERSION = 1;

/** A submission slot is a free tag: "BUD" now; forecasts arrive later as
 *  their own tags ("F2026_09"), never as a period column. */
export const SUBMISSION_SLOTS = ["BUD", "FCST", "ACT"] as const;
export type SubmissionSlot = (typeof SUBMISSION_SLOTS)[number];
/** The slots the picker lets a hotel choose today. */
export const ENABLED_SUBMISSION_SLOTS: readonly SubmissionSlot[] = ["BUD"];

/** Budget years open for submission. The year itself is the app-wide budget
 *  year (the app bar), not picked on the Submit page; any other year is refused. */
export const ENABLED_SUBMISSION_YEARS: readonly number[] = [2027];

export const SUBMISSION_MONTHS = 12;

/** `prefix_01` .. `prefix_12`, then `prefix_year`. */
export function monthlyColumns(prefix: string): string[] {
  const out: string[] = [];
  for (let m = 1; m <= SUBMISSION_MONTHS; m++) out.push(`${prefix}_${String(m).padStart(2, "0")}`);
  out.push(`${prefix}_year`);
  return out;
}

export type SubmissionCell = string | number | boolean | null;

export interface SubmissionTable {
  columns: string[];
  rows: SubmissionCell[][];
}

// ---------------------------------------------------------------------------
// submission — one row
// ---------------------------------------------------------------------------

export const SUBMISSION_HEADER_COLUMNS: readonly string[] = [
  "submission_id",
  "schema_version",
  "ou",
  "hotel_name",
  "year",
  "slot",
  "scenario_id",
  "scenario_label",
  "app_version",
  "submitted_at",
  "engine_computed_at",
  // The hotel-year setup every position's FTE is measured against.
  "contract_week",
  "effective_week",
  "effective_week_posted",
  "productive_days",
  "daily_hours",
  "average_vacation_days",
  "full_time_days",
  "full_time_hours_year",
  "weighted_fte",
  "calendar_weekend_mask",
  ...monthlyColumns("working_days"),
  "public_holidays_year",
  // Row counts, so the loader can check it received everything.
  "position_count",
  "manual_row_count",
  "buyout_row_count",
];

// ---------------------------------------------------------------------------
// positions — one row per ACTIVE position
// ---------------------------------------------------------------------------

export const SUBMISSION_POSITION_COLUMNS: readonly string[] = [
  "position_id",
  /** Stable across years — a scenario clone keeps it. */
  "lineage_id",
  /** Same person mirrored into every member hotel of a cluster; dedupe on it. */
  "cluster_link_id",
  "cluster_name",
  /** This hotel's share of the position (1 = wholly its own). */
  "cluster_weight",
  "department_code",
  "department_name",
  "title",
  "standard_job_title",
  /** The grade: Manager, Manager (Non Exempt), Supervisor, Associate, Casual, Buyout Labour. */
  "classification",
  "pay_type",
  "headcount",
  /** The grid's derived FTE for ONE head, before the count multiplier. */
  "fte",
  // Contract, as entered.
  "contract_yearly_days",
  "contract_days_off",
  "contract_pub_holidays",
  "daily_contract_hours",
  /** Net of vacation, restated for the input basis (the engine's HOURS input). */
  "yearly_hours_worked",
  /** (Yearly days − days off) × daily hours, restated for the input basis. */
  "yearly_manhours_paid",
  "vacation_days",
  "accrual_days_per_month",
  "total_working_months",
  ...monthlyColumns("working").slice(0, SUBMISSION_MONTHS),
  ...monthlyColumns("vacation_weight").slice(0, SUBMISSION_MONTHS),
  // Pay, as entered.
  "salary_entry_mode",
  "annual_divisor_basis",
  "annual_base_salary",
  "monthly_base_salary",
  "hourly_rate",
  "merit_increase_pct",
  "manual_yearly_increase",
  "increase_month",
  "salary_account",
  "working_hours_account",
  "benefits_account",
  "accrual_account",
  // Calculated by the run, read as the Staffing statistics report reads them.
  ...monthlyColumns("calc_heads"),
  ...monthlyColumns("calc_fte"),
  ...monthlyColumns("calc_hours_total"),
  ...monthlyColumns("calc_hours_fte"),
];

// ---------------------------------------------------------------------------
// manual_rows — one row per Manual Input grid line
// ---------------------------------------------------------------------------

export const SUBMISSION_MANUAL_ROW_COLUMNS: readonly string[] = [
  "row_id",
  "description",
  "department_code",
  "department_name",
  "cost_account",
  "stats_account",
  "rate",
  "rate_driven",
  "stats_kpi_driver_id",
  "stats_kpi_divisor",
  "stats_kpi_factor",
  "stats_kpi_driven",
  "spread_mode",
  "spread_base_stats",
  "spread_base_amount",
  "increase_pct",
  "increase_month",
  "sort_order",
  // The effective figures — derived where the row is rate- or KPI-driven,
  // exactly as the run posts them.
  ...monthlyColumns("stats"),
  ...monthlyColumns("amount"),
];

// ---------------------------------------------------------------------------
// buyout_rows — one row per buyout line (department × account amounts)
// ---------------------------------------------------------------------------

export const SUBMISSION_BUYOUT_ROW_COLUMNS: readonly string[] = [
  "row_id",
  "department_code",
  "department_name",
  "account",
  ...monthlyColumns("amount"),
];

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

export interface SubmissionPayload {
  schemaVersion: number;
  /** One row (SUBMISSION_HEADER_COLUMNS), as a table so every part loads alike. */
  submission: SubmissionTable;
  positions: SubmissionTable;
  manualRows: SubmissionTable;
  buyoutRows: SubmissionTable;
}

/** The header as an object, for the page and for tests. */
export function submissionHeaderOf(payload: SubmissionPayload): Record<string, SubmissionCell> {
  const out: Record<string, SubmissionCell> = {};
  const row = payload.submission.rows[0] ?? [];
  payload.submission.columns.forEach((column, i) => {
    out[column] = row[i] ?? null;
  });
  return out;
}

/** `${slot}_${year}` — the tag that, with the OU, identifies a submission. */
export function submissionTag(slot: string, year: number): string {
  return `${slot}_${year}`;
}
