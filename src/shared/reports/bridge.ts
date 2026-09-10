/**
 * The payroll bridge — from a department's payroll line back to the
 * positions it is built from.
 *
 * Pure vocabulary and helpers: the BUCKET each account falls in (payroll,
 * hours, heads, other), classified by the account's map labels with
 * code-prefix fallbacks so an unmapped account still lands somewhere; the
 * map PATH a payroll account sits on, which the matrix's column tree is
 * built from (see bridgeMatrix.ts); the row and department shapes the read
 * returns; and the arithmetic the page and the export share (payroll totals,
 * FTE, payroll per FTE, lineage matching against a compared scenario).
 *
 * Titles only, never names: the bridge shows what a POST costs, the way the
 * Results inspector does. See main/positions/positionBridge.ts for the read.
 */

import type { OutputEncoding, OutputSource } from "../positions/ipc";
import type { ReportRunInfo } from "./ipc";

/** "payroll" is everything under Total Payroll — the matrix's account tree.
 *  The other three are fixed columns beside it. */
export type BridgeBucket = "payroll" | "hours" | "heads" | "other";

export const BRIDGE_STAT_BUCKETS: readonly Exclude<BridgeBucket, "payroll">[] = ["hours", "heads", "other"];

export const BRIDGE_BUCKET_LABELS: Record<BridgeBucket, string> = {
  payroll: "Total payroll",
  hours: "Hours",
  /** The headcount statistic accounts — "Heads" is the positions' own count. */
  heads: "Heads posted",
  other: "Other accounts",
};

/** The account map levels the column tree steps through, top down; the
 *  account itself (its max-level description) is the leaf under them. */
export const BRIDGE_TREE_LEVELS: readonly number[] = [12, 14, 18, 21];

/** Payroll accounts the maps do not know. */
export const UNMAPPED_GROUP = "Unmapped";
/** Mapped payroll accounts with nothing at any tree level. */
export const UNGROUPED_GROUP = "Other payroll";

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
  if (labels.accountLabel(bareAccount, 9) === "Total Payroll") return "payroll";
  if (labels.accountLabel(bareAccount, 4) === "Total Manhours") return "hours";
  // Unmapped: the code families Kairos itself posts to.
  if (bareAccount.startsWith("988")) return "hours";
  if (bareAccount.startsWith("97254")) return "heads";
  if (bareAccount.startsWith("5")) return "payroll";
  return "other";
}

export interface BridgeAccountStep {
  level: number;
  label: string;
}

/** Where a payroll account sits in the column tree: its non-blank labels at
 *  the tree levels, top down. Blank levels are skipped, not shown empty. */
export function bridgeAccountPath(
  bareAccount: string,
  labels: BridgeAccountLabels & { hasAccount(code: string): boolean }
): BridgeAccountStep[] {
  if (!labels.hasAccount(bareAccount)) return [{ level: BRIDGE_TREE_LEVELS[0], label: UNMAPPED_GROUP }];
  const path: BridgeAccountStep[] = [];
  for (const level of BRIDGE_TREE_LEVELS) {
    const label = labels.accountLabel(bareAccount, level);
    if (label) path.push({ level, label });
  }
  return path.length ? path : [{ level: BRIDGE_TREE_LEVELS[0], label: UNGROUPED_GROUP }];
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

export interface BridgeAccount {
  code: string;
  name: string | null;
  bucket: BridgeBucket;
  path: BridgeAccountStep[];
}

export interface PositionBridgeResponse {
  scenarioId: string;
  year: number;
  run: ReportRunInfo | null;
  departments: BridgeDepartment[];
  /** Every account the rows touch, with its bucket, name and — for payroll
   *  accounts — its place in the column tree (empty otherwise). */
  accounts: BridgeAccount[];
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
  return bucketTotal(cells, "payroll");
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
