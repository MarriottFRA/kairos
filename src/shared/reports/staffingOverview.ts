/**
 * The staffing overview — head count and full-time equivalents per department
 * group and job title, split by classification.
 *
 * Pure vocabulary and arithmetic: the four BUCKETS a classification lands in
 * (managers, supervisors, non-managers, casuals — decided 2026-09-09: shown
 * apart, never merged; Buyout Labour is bought in, not staffed, and books no
 * heads), the title a position rolls up under (the job title as typed or the
 * Standard Title, each falling back through the other, then the
 * classification — the ladder outputsRepo.resolveDisplayName uses), the
 * aggregation over a scenario's positions, and the merge against a compared
 * scenario by (group, title) — no lineage needed, so a post that was added or
 * removed rather than cloned still lines up.
 *
 * Two BASES (decided 2026-09-10), the accounts one the default:
 *
 *   accounts   read off the scenario's engine output lines, so the figures
 *              are the ones every other report — and actuals — carry. HC is
 *              the pinned position count (A972540) where it ends the year;
 *              FTE is the reports' FTE: manager heads (A988101 / A988113,
 *              their mean) + the FTE-driving hours ÷ one full-timer's year
 *              (the effective week × 52). Only as fresh as the last run.
 *   positions  read off the positions themselves. HC is the row's Count as
 *              it stands: a person a cluster shares is one head in every
 *              hotel (the engine's HEADCOUNT stat is exempt from the cluster
 *              weight). FTE is the derived FTE × Count × the hotel's cluster
 *              share — the Positions grid's figure, always current.
 *
 * See main/positions/staffingOverview.ts for the read.
 */

import { BUYOUT_JOB_TYPE } from "../positions/systemAccounts";
import type { ReportRunInfo } from "./ipc";
import { UNMAPPED_GROUP, groupRank } from "./packs";
import type { StaffingAccountRole, StaffingStatsLine } from "./staffingStatistics";
import type { ReportWarning } from "./types";
import type { WeeklyHoursInfo } from "./weeklyHours";

/** Where the figures come from. */
export type StaffingBasis = "accounts" | "positions";

export const STAFFING_BASIS_LABELS: Record<StaffingBasis, string> = { accounts: "Accounts", positions: "Positions" };

export type StaffingBucket = "mgr" | "svsr" | "assoc" | "casual";

export const STAFFING_BUCKETS: readonly StaffingBucket[] = ["mgr", "svsr", "assoc", "casual"];

export const STAFFING_BUCKET_LABELS: Record<StaffingBucket, string> = {
  mgr: "Mgr",
  svsr: "Supervisor",
  assoc: "Non-Mgr",
  casual: "Casual",
};

export type StaffingKind = "hc" | "fte";
export const STAFFING_KINDS: readonly StaffingKind[] = ["hc", "fte"];
export const STAFFING_KIND_LABELS: Record<StaffingKind, string> = { hc: "HC", fte: "FTE" };

/** Which title a position rolls up under. */
export type TitleMode = "title" | "standard";

/**
 * The bucket for a Classification. Manager and Manager (Non Exempt) are both
 * managers; a blank or unknown grade is a non-manager (it still reports its
 * heads, as positionCountAccountForJobType says); Buyout Labour is null —
 * left out, as it is of the position count.
 */
export function bucketForJobType(jobTypeCode: string | null | undefined): StaffingBucket | null {
  const code = (jobTypeCode ?? "").trim();
  if (code === BUYOUT_JOB_TYPE) return null;
  if (code === "Manager" || code === "Manager (Non Exempt)") return "mgr";
  if (code === "Supervisor") return "svsr";
  if (code === "Casual") return "casual";
  return "assoc";
}

export interface StaffingCells {
  hc: Record<StaffingBucket, number>;
  fte: Record<StaffingBucket, number>;
}

const zeroBuckets = (): Record<StaffingBucket, number> => ({ mgr: 0, svsr: 0, assoc: 0, casual: 0 });

export const emptyCells = (): StaffingCells => ({ hc: zeroBuckets(), fte: zeroBuckets() });

export function addCells(into: StaffingCells, from: StaffingCells): void {
  for (const bucket of STAFFING_BUCKETS) {
    into.hc[bucket] += from.hc[bucket];
    into.fte[bucket] += from.fte[bucket];
  }
}

export function subCells(a: StaffingCells, b: StaffingCells): StaffingCells {
  const out = emptyCells();
  for (const bucket of STAFFING_BUCKETS) {
    out.hc[bucket] = a.hc[bucket] - b.hc[bucket];
    out.fte[bucket] = a.fte[bucket] - b.fte[bucket];
  }
  return out;
}

export function cellsTotal(cells: StaffingCells, kind: StaffingKind): number {
  return STAFFING_BUCKETS.reduce((sum, bucket) => sum + cells[kind][bucket], 0);
}

/** What the read hands the aggregation per active position. */
export interface StaffingPositionInput {
  id: string;
  departmentCode: string;
  jobTypeCode: string;
  headcount: number;
  /** The derived FTE of ONE post (applyInputBasis), before Count and cluster share. */
  fte: number;
  hotelClusterWeight: number;
}

export interface StaffingTitleSource {
  title?: string | null;
  extraValues?: Record<string, unknown> | null;
}

/** The title a position rolls up under, in the chosen mode, never blank. */
export function staffingTitle(pii: StaffingTitleSource | undefined, jobTypeCode: string | null | undefined, mode: TitleMode): string {
  const typed = (pii?.title ?? "").trim();
  const standard = String(pii?.extraValues?.standardJobTitle ?? "").trim();
  const ladder = mode === "standard" ? [standard, typed] : [typed, standard];
  return ladder.find((value) => value !== "") || (jobTypeCode ?? "").trim() || "Position";
}

/** group label → title → cells. */
export type StaffingAggregate = Map<string, Map<string, StaffingCells>>;

export function aggregateStaffing(
  positions: readonly StaffingPositionInput[],
  titleOf: (position: StaffingPositionInput) => string,
  groupOf: (departmentCode: string) => string
): StaffingAggregate {
  const out: StaffingAggregate = new Map();
  for (const position of positions) {
    const bucket = bucketForJobType(position.jobTypeCode);
    if (!bucket) continue;
    const group = groupOf(position.departmentCode);
    const title = titleOf(position) || "Position";
    let titles = out.get(group);
    if (!titles) out.set(group, (titles = new Map()));
    let cells = titles.get(title);
    if (!cells) titles.set(title, (cells = emptyCells()));
    const headcount = Number(position.headcount) || 0;
    cells.hc[bucket] += headcount;
    cells.fte[bucket] += (Number(position.fte) || 0) * headcount * (Number(position.hotelClusterWeight) || 0);
  }
  return out;
}

const MONTHS = 12;

/**
 * The accounts basis: engine lines rolled up by group and title. Per line
 * only the accounts the reports' FTE reads count — the position count (HC,
 * its December level), the manager heads (FTE, their mean level) and the
 * FTE-driving hours (FTE, ÷ `fteHoursYear`); overtime, manager and buyout
 * hours are left out, as the reports leave them out. A LEVEL line is
 * January-plus-changes (the BST's running sum); an AMOUNT line holds levels
 * already. A position's line takes its grade's bucket (Buyout Labour none);
 * a line no position produced (manual input, allocation) is a manager's if
 * it posts manager heads, else a non-manager's — the blank-grade rule.
 * `classify` is the staffing statistics' classifier, passed in so this
 * module stays free of the maps.
 */
export function aggregateStaffingLines(
  lines: Iterable<StaffingStatsLine>,
  fteHoursYear: number,
  classify: (account: string) => StaffingAccountRole | null,
  titleOf: (line: StaffingStatsLine) => string,
  groupOf: (departmentCode: string) => string
): StaffingAggregate {
  const out: StaffingAggregate = new Map();
  for (const line of lines) {
    const role = classify(line.account);
    if (!role || (role.role === "hours" && role.kind !== "fte")) continue;
    const bucket = line.position ? bucketForJobType(line.position.jobTypeCode) : role.role === "managerHeads" ? "mgr" : "assoc";
    if (!bucket) continue;

    const months = Array.from({ length: MONTHS }, (_, m) => Number(line.months[m]) || 0);
    let running = 0;
    const levels = line.encoding === "LEVEL" ? months.map((value) => (running += value)) : months;
    let hc = 0;
    let fte = 0;
    if (role.role === "heads") hc = levels[MONTHS - 1];
    else if (role.role === "managerHeads") fte = levels.reduce((sum, value) => sum + value, 0) / MONTHS;
    else fte = Math.abs(fteHoursYear) < 1e-12 ? 0 : months.reduce((sum, value) => sum + value, 0) / fteHoursYear;
    if (hc === 0 && fte === 0) continue;

    const group = groupOf(line.dept);
    const title = titleOf(line) || "Position";
    let titles = out.get(group);
    if (!titles) out.set(group, (titles = new Map()));
    let cells = titles.get(title);
    if (!cells) titles.set(title, (cells = emptyCells()));
    cells.hc[bucket] += hc;
    cells.fte[bucket] += fte;
  }
  return out;
}

export interface StaffingRow {
  title: string;
  cells: StaffingCells;
  /** The compared scenario's cells for the same (group, title); null without a comparison. */
  compare: StaffingCells | null;
  /** cells − compare; null without a comparison. */
  variance: StaffingCells | null;
}

export interface StaffingGroup {
  label: string;
  rows: StaffingRow[];
  totals: StaffingCells;
  compareTotals: StaffingCells | null;
  varianceTotals: StaffingCells | null;
}

export interface StaffingScenarioInfo {
  scenarioId: string;
  year: number;
  run: ReportRunInfo | null;
}

export interface StaffingOverviewResponse extends StaffingScenarioInfo {
  basis: StaffingBasis;
  titleMode: TitleMode;
  /** The effective week the accounts basis divided by; null on the positions basis. */
  weeklyHours: WeeklyHoursInfo | null;
  /** The accounts basis's: a scenario not calculated, a week not posted. */
  warnings: ReportWarning[];
  groups: StaffingGroup[];
  totals: StaffingCells;
  compareTotals: StaffingCells | null;
  varianceTotals: StaffingCells | null;
  compare: StaffingScenarioInfo | null;
  /** Bare department codes the mapping table has no group for (they sit under the unmapped group). */
  unmappedDepartments: string[];
}

/**
 * Groups in the pack's order (the unmapped bucket last), rows by title; a
 * title only in the compared scenario gets zero budget cells so the
 * variance still shows what went away.
 */
export function buildStaffingGroups(
  budget: StaffingAggregate,
  compare: StaffingAggregate | null
): Pick<StaffingOverviewResponse, "groups" | "totals" | "compareTotals" | "varianceTotals"> {
  const labels = new Set<string>([...budget.keys(), ...(compare ? compare.keys() : [])]);
  const ordered = [...labels].sort(
    (a, b) => groupRank(a) - groupRank(b) || (a === UNMAPPED_GROUP ? 1 : 0) - (b === UNMAPPED_GROUP ? 1 : 0) || a.localeCompare(b)
  );
  const totals = emptyCells();
  const compareTotals = compare ? emptyCells() : null;
  const groups: StaffingGroup[] = ordered.map((label) => {
    const here = budget.get(label) ?? new Map<string, StaffingCells>();
    const there = compare?.get(label) ?? null;
    const titles = [...new Set([...here.keys(), ...(there ? there.keys() : [])])].sort((a, b) => a.localeCompare(b));
    const groupTotals = emptyCells();
    const groupCompare = compare ? emptyCells() : null;
    const rows: StaffingRow[] = titles.map((title) => {
      const cells = here.get(title) ?? emptyCells();
      const other = compare ? there?.get(title) ?? emptyCells() : null;
      addCells(groupTotals, cells);
      if (groupCompare && other) addCells(groupCompare, other);
      return { title, cells, compare: other, variance: other ? subCells(cells, other) : null };
    });
    addCells(totals, groupTotals);
    if (compareTotals && groupCompare) addCells(compareTotals, groupCompare);
    return {
      label,
      rows,
      totals: groupTotals,
      compareTotals: groupCompare,
      varianceTotals: groupCompare ? subCells(groupTotals, groupCompare) : null,
    };
  });
  return {
    groups,
    totals,
    compareTotals,
    varianceTotals: compareTotals ? subCells(totals, compareTotals) : null,
  };
}
