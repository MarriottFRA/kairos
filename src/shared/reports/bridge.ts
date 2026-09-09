/**
 * The payroll bridge — from a department's payroll line back to the
 * positions it is built from.
 *
 * Pure vocabulary and helpers: the account BUCKETS a position's lines are
 * pivoted into (management salaries, hourly wages, overtime, bonus, paid
 * time off, benefits, other payroll, hours, heads, other), classified by the
 * account's map labels with code-prefix fallbacks so an unmapped account
 * still lands somewhere; the row and department shapes the read returns;
 * and the arithmetic the page and the export share (bucket totals, FTE,
 * payroll per FTE, lineage matching against a compared scenario).
 *
 * Titles only, never names: the bridge shows what a POST costs, the way the
 * Results inspector does. See main/positions/positionBridge.ts for the read.
 */

import type { OutputEncoding, OutputSource } from "../positions/ipc";
import type { ReportRunInfo } from "./ipc";

export type BridgeBucket =
  | "management_salaries"
  | "hourly_wages"
  | "overtime"
  | "bonus"
  | "paid_time_off"
  | "benefits"
  | "other_payroll"
  | "hours"
  | "heads"
  | "other";

export const BRIDGE_BUCKET_ORDER: readonly BridgeBucket[] = [
  "management_salaries",
  "hourly_wages",
  "overtime",
  "bonus",
  "paid_time_off",
  "benefits",
  "other_payroll",
  "hours",
  "heads",
  "other",
];

export const BRIDGE_BUCKET_LABELS: Record<BridgeBucket, string> = {
  management_salaries: "Management salaries",
  hourly_wages: "Hourly wages",
  overtime: "Overtime",
  bonus: "Bonus",
  paid_time_off: "Paid time off",
  benefits: "Benefits",
  other_payroll: "Other payroll",
  hours: "Hours",
  heads: "Heads",
  other: "Other accounts",
};

/** The buckets that add up to "Total payroll". */
export const PAYROLL_BUCKETS: ReadonlySet<BridgeBucket> = new Set([
  "management_salaries",
  "hourly_wages",
  "overtime",
  "bonus",
  "paid_time_off",
  "benefits",
  "other_payroll",
]);

export interface BridgeAccountLabels {
  accountLabel(code: string, level: number): string | null;
}

/** The headcount statistics (position count plus the graded heads). */
export function classifyBridgeAccount(
  bareAccount: string,
  labels: BridgeAccountLabels,
  headAccounts: ReadonlySet<string>
): BridgeBucket {
  if (headAccounts.has(bareAccount)) return "heads";
  const l9 = labels.accountLabel(bareAccount, 9);
  if (l9 === "Total Payroll") {
    if (labels.accountLabel(bareAccount, 18) === "Hrly Overtime Prem") return "overtime";
    const l15 = labels.accountLabel(bareAccount, 15);
    if (l15 === "Total Management Salaries") return "management_salaries";
    if (l15 === "Total Hourly Wages") return "hourly_wages";
    if (l15 === "Bonus Payments") return "bonus";
    if (labels.accountLabel(bareAccount, 14) === "Paid Time Off") return "paid_time_off";
    if (labels.accountLabel(bareAccount, 12) === "Associate Benefits") return "benefits";
    return "other_payroll";
  }
  if (labels.accountLabel(bareAccount, 4) === "Total Manhours") return "hours";
  // Unmapped: the code families Kairos itself posts to.
  if (bareAccount.startsWith("988")) return "hours";
  if (bareAccount.startsWith("97254")) return "heads";
  if (bareAccount.startsWith("5")) return "other_payroll";
  return "other";
}

export interface BridgeCell {
  account: string;
  bucket: BridgeBucket;
  months: number[];
  total: number;
  encoding: OutputEncoding;
}

export interface BridgeLine {
  account: string;
  label: string;
  months: number[];
  total: number;
  encoding: OutputEncoding;
}

export interface BridgeRow {
  /** Stable within the scenario: the position id, or the line's own identity. */
  key: string;
  source: OutputSource;
  positionId: string | null;
  /** Null when the position has no lineage (never cloned). */
  lineageId: string | null;
  /** The job title (PII sidecar); never a name. */
  title: string | null;
  jobTypeCode: string | null;
  payType: string | null;
  headcount: number | null;
  fte: number | null;
  clusterName: string | null;
  active: boolean;
  /** The position was deleted after the run; its lines stay until the next recalculation. */
  deleted: boolean;
  /** Non-engine rows: the line's label ("Manual: …", the allocation, the buyout). */
  label: string;
  cells: BridgeCell[];
  lines: BridgeLine[];
}

export interface BridgeDepartment {
  code: string;
  name: string;
  rows: BridgeRow[];
  /** Per account, summed over the rows in the order the lines were written —
   *  the same order the results cache summed them, so the two tie. */
  totals: BridgeCell[];
}

export interface BridgeBstTotals {
  available: boolean;
  /** Bucket type and year of the bucket read. */
  bucket: string | null;
  /** dept → account → year total, for the accounts the bridge shows. */
  byDept: Record<string, Record<string, number>>;
}

export interface PositionBridgeResponse {
  scenarioId: string;
  year: number;
  run: ReportRunInfo | null;
  departments: BridgeDepartment[];
  /** Every account the rows touch, with its bucket and name. */
  accounts: Array<{ code: string; name: string | null; bucket: BridgeBucket }>;
  bst: BridgeBstTotals;
  compare: { scenarioId: string; year: number; departments: BridgeDepartment[] } | null;
}

// ---------------------------------------------------------------------------
// Arithmetic the page and the export share
// ---------------------------------------------------------------------------

export function bucketTotal(cells: readonly BridgeCell[], bucket: BridgeBucket): number {
  let sum = 0;
  for (const cell of cells) if (cell.bucket === bucket) sum += cell.total;
  return sum;
}

export function payrollTotal(cells: readonly BridgeCell[]): number {
  let sum = 0;
  for (const cell of cells) if (PAYROLL_BUCKETS.has(cell.bucket)) sum += cell.total;
  return sum;
}

/** The rows of a compared scenario, by lineage — the join key across clones. */
export function indexByLineage(departments: readonly BridgeDepartment[]): Map<string, BridgeRow> {
  const out = new Map<string, BridgeRow>();
  for (const department of departments) {
    for (const row of department.rows) if (row.lineageId) out.set(row.lineageId, row);
  }
  return out;
}

export interface BridgeSummary {
  payroll: number;
  heads: number;
  fte: number;
  hours: number;
  payrollPerFte: number;
}

/** Heads and FTE come from the positions themselves (the grid's own figures),
 *  hours and payroll from the lines. */
export function summarize(departments: readonly BridgeDepartment[]): BridgeSummary {
  let payroll = 0;
  let heads = 0;
  let fte = 0;
  let hours = 0;
  for (const department of departments) {
    payroll += payrollTotal(department.totals);
    hours += bucketTotal(department.totals, "hours");
    for (const row of department.rows) {
      if (row.source !== "ENGINE" || !row.active || row.deleted) continue;
      heads += row.headcount ?? 0;
      fte += row.fte ?? 0;
    }
  }
  return { payroll, heads, fte, hours, payrollPerFte: fte > 0 ? payroll / fte : 0 };
}
