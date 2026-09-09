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
 * HC is the row's Count as it stands: a person a cluster shares is one head
 * in every hotel (the engine's HEADCOUNT stat is exempt from the cluster
 * weight). FTE is the engine's FTE stat for the year: the derived FTE ×
 * Count × the hotel's cluster share. See main/positions/staffingOverview.ts
 * for the read.
 */

import { BUYOUT_JOB_TYPE } from "../positions/systemAccounts";
import type { ReportRunInfo } from "./ipc";
import { UNMAPPED_GROUP, groupRank } from "./packs";

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
  titleMode: TitleMode;
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
