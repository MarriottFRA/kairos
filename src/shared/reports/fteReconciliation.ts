/**
 * The FTE reconciliation — the Positions grid's FTE beside the FTE the
 * reports derive from the accounts, department by department.
 *
 * Two readings of one scenario that should agree and, where they do not,
 * say why:
 *
 *   grid      each position's derived FTE (the contract against the hotel's
 *             full-time yardstick, engineInput.deriveFte) × Count × the
 *             hotel's cluster share — the figure the Positions grid and the
 *             Staffing overview's Positions basis show. Split into the manager grades and
 *             everyone else. Buyout Labour is left out: it is bought in, not
 *             staffed, and its hours sit outside the account-side node too.
 *   accounts  the staffing catalog's FTE evaluated on the scenario's own
 *             results: manager heads (A988101 / A988113, a level whose year
 *             figure is its mean) plus the "excl Overtime and Manager
 *             Hours × Man Hours" hours ÷ the hours of a full-timer (the
 *             EFFECTIVE week × 52 — the contract week over the days a
 *             full-timer works once the roster's average vacation is out,
 *             shared/positions/effectiveWeek.ts). This is exactly what every
 *             report's FTE line reads once the positions are gone and only
 *             the accounts remain. With the average as the yardstick the
 *             hotel total reconciles; a department's gap is its leave mix
 *             against the average — the detail the accounts cannot carry,
 *             not a bug in either.
 *
 * The account side is a generated definition (one atom pair per department)
 * evaluated by the shared engine under the same column plan a report uses,
 * so the two can never disagree with the Reports page. Pure module: the
 * definition builder, the grid-side arithmetic and the merge; the read is
 * main/positions/fteReconciliation.ts.
 */

import { bareDept } from "../positions/comboKey";
import { accBase, deptBase } from "./catalog/helpers";
import {
  FTE_HOURS_FILTERS,
  FTE_HOURS_MEASURE,
  FTE_WEEKS_PARAM,
  MANAGER_FTE_ACCOUNTS,
  WEEKLY_HOURS_PARAM,
  fteFormula,
} from "./catalog/staffing";
import type { ReportRunInfo } from "./ipc";
import { UNMAPPED_GROUP, groupRank } from "./packs";
import { bucketForJobType } from "./staffingOverview";
import type { Atom, EvaluatedReport, Measure, ReportDefinition, ReportRow, ReportWarning } from "./types";
import type { WeeklyHoursInfo } from "./weeklyHours";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The grid side of one department. */
export interface FteGridSide {
  /** FTE of the manager grades (Manager, Manager (Non Exempt)). */
  managers: number;
  /** FTE of everyone else (supervisors, associates, casuals). */
  others: number;
  total: number;
  /** Heads as counted (unweighted), for context. */
  heads: number;
}

/** The account side of one department. */
export interface FteAccountSide {
  /** Mean of the monthly manager-head levels. */
  managerHeads: number;
  /** The year's hours that drive FTE. */
  hours: number;
  /** hours ÷ the full-timer's year. */
  hoursFte: number;
  total: number;
}

export interface FteReconciliationCells {
  grid: FteGridSide;
  accounts: FteAccountSide;
  /** accounts.total − grid.total. */
  variance: number;
}

export interface FteReconciliationRow extends FteReconciliationCells {
  /** Bare department code. */
  dept: string;
  name: string;
}

export interface FteReconciliationGroup {
  label: string;
  rows: FteReconciliationRow[];
  totals: FteReconciliationCells;
}

export interface FteReconciliationResponse {
  scenarioId: string;
  year: number;
  run: ReportRunInfo | null;
  /** The effective week the account side divided by, and where it was read. */
  weeklyHours: WeeklyHoursInfo | null;
  /** Hours of one FTE for the year (the work week × 52). */
  fteHoursYear: number;
  groups: FteReconciliationGroup[];
  totals: FteReconciliationCells;
  /** Bare department codes the mapping table has no group for. */
  unmappedDepartments: string[];
  warnings: ReportWarning[];
}

// ---------------------------------------------------------------------------
// The account side: a definition per department list
// ---------------------------------------------------------------------------

const idOf = (dept: string) => `d_${bareDept(dept).replace(/[^A-Za-z0-9_]/g, "_")}`;

export const FTE_RECONCILIATION_KEYS = {
  managerHeads: "mgr_fte",
  hours: "hours",
  hoursFte: "hours_fte",
  total: "fte",
} as const;

/** One atom pair and four measures per department; the full-timer's hours once. */
export function buildFteReconciliationDefinition(depts: readonly string[]): ReportDefinition {
  const atoms: Atom[] = [];
  const measures: Measure[] = [FTE_HOURS_MEASURE];
  const rows: ReportRow[] = [];
  const seen = new Set<string>();
  for (const raw of depts) {
    const dept = bareDept(raw);
    if (!dept || seen.has(dept)) continue;
    seen.add(dept);
    const p = idOf(dept);
    atoms.push(
      { id: `${p}_mgr`, label: `${dept}: manager heads`, filters: [deptBase(dept), accBase(...MANAGER_FTE_ACCOUNTS)] },
      { id: `${p}_hrs`, label: `${dept}: hours driving FTE`, filters: [deptBase(dept), ...FTE_HOURS_FILTERS] }
    );
    measures.push(
      { id: `${p}_${FTE_RECONCILIATION_KEYS.managerHeads}`, formula: `mean(${p}_mgr)`, format: "ratio" },
      { id: `${p}_${FTE_RECONCILIATION_KEYS.hours}`, formula: `${p}_hrs`, format: "number" },
      { id: `${p}_${FTE_RECONCILIATION_KEYS.hoursFte}`, formula: `div(${p}_hrs, ${FTE_HOURS_MEASURE.id})`, format: "ratio" },
      { id: `${p}_${FTE_RECONCILIATION_KEYS.total}`, formula: fteFormula(`${p}_mgr`, `${p}_hrs`), format: "ratio" }
    );
    for (const key of Object.values(FTE_RECONCILIATION_KEYS)) rows.push({ type: "measure", measureId: `${p}_${key}` });
  }
  rows.push({ type: "measure", measureId: FTE_HOURS_MEASURE.id });
  return {
    id: "fte_reconciliation",
    name: "FTE reconciliation",
    version: 1,
    atoms,
    measures,
    rows,
    params: [WEEKLY_HOURS_PARAM, FTE_WEEKS_PARAM],
  };
}

/** The evaluated account side, by bare department, from the Total slot. */
export function readAccountSides(depts: readonly string[], report: EvaluatedReport): Map<string, FteAccountSide> {
  const byMeasure = new Map<string, number>();
  for (const row of report.rows) {
    if (row.type === "measure" && row.measureId && row.values) byMeasure.set(row.measureId, row.values[12]);
  }
  const out = new Map<string, FteAccountSide>();
  for (const raw of depts) {
    const dept = bareDept(raw);
    if (!dept || out.has(dept)) continue;
    const p = idOf(dept);
    const value = (key: string) => byMeasure.get(`${p}_${key}`) ?? 0;
    out.set(dept, {
      managerHeads: value(FTE_RECONCILIATION_KEYS.managerHeads),
      hours: value(FTE_RECONCILIATION_KEYS.hours),
      hoursFte: value(FTE_RECONCILIATION_KEYS.hoursFte),
      total: value(FTE_RECONCILIATION_KEYS.total),
    });
  }
  return out;
}

/** The year's hours of one FTE as the report evaluated them. */
export function readFteHoursYear(report: EvaluatedReport): number {
  const row = report.rows.find((r) => r.type === "measure" && r.measureId === FTE_HOURS_MEASURE.id);
  return row?.values?.[12] ?? 0;
}

// ---------------------------------------------------------------------------
// The grid side
// ---------------------------------------------------------------------------

/** What the read hands over per active position (the staffing overview's shape). */
export interface FtePositionInput {
  departmentCode: string;
  jobTypeCode: string;
  headcount: number;
  /** The derived FTE of ONE post, before Count and cluster share. */
  fte: number;
  hotelClusterWeight: number;
}

const zeroGrid = (): FteGridSide => ({ managers: 0, others: 0, total: 0, heads: 0 });
const zeroAccounts = (): FteAccountSide => ({ managerHeads: 0, hours: 0, hoursFte: 0, total: 0 });
export const emptyFteCells = (): FteReconciliationCells => ({ grid: zeroGrid(), accounts: zeroAccounts(), variance: 0 });

/** Grid FTE by bare department: managers apart, Buyout Labour left out. */
export function aggregateGridFte(positions: readonly FtePositionInput[]): Map<string, FteGridSide> {
  const out = new Map<string, FteGridSide>();
  for (const position of positions) {
    const bucket = bucketForJobType(position.jobTypeCode);
    if (!bucket) continue;
    const dept = bareDept(position.departmentCode);
    let side = out.get(dept);
    if (!side) out.set(dept, (side = zeroGrid()));
    const headcount = Number(position.headcount) || 0;
    const fte = (Number(position.fte) || 0) * headcount * (Number(position.hotelClusterWeight) || 0);
    if (bucket === "mgr") side.managers += fte;
    else side.others += fte;
    side.total += fte;
    side.heads += headcount;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

function addCells(into: FteReconciliationCells, from: FteReconciliationCells): void {
  into.grid.managers += from.grid.managers;
  into.grid.others += from.grid.others;
  into.grid.total += from.grid.total;
  into.grid.heads += from.grid.heads;
  into.accounts.managerHeads += from.accounts.managerHeads;
  into.accounts.hours += from.accounts.hours;
  into.accounts.hoursFte += from.accounts.hoursFte;
  into.accounts.total += from.accounts.total;
  into.variance += from.variance;
}

/**
 * Departments from either side, grouped as the pack groups them (the
 * mapping table's level, the unmapped bucket last), rows by code.
 */
export function buildFteReconciliation(
  grid: ReadonlyMap<string, FteGridSide>,
  accounts: ReadonlyMap<string, FteAccountSide>,
  nameOf: (dept: string) => string | null,
  groupOf: (dept: string) => string
): Pick<FteReconciliationResponse, "groups" | "totals"> {
  const depts = [...new Set([...grid.keys(), ...accounts.keys()])].sort((a, b) => a.localeCompare(b));
  const byGroup = new Map<string, FteReconciliationRow[]>();
  for (const dept of depts) {
    const g = grid.get(dept) ?? zeroGrid();
    const a = accounts.get(dept) ?? zeroAccounts();
    const row: FteReconciliationRow = {
      dept,
      name: nameOf(dept) ?? dept,
      grid: { ...g },
      accounts: { ...a },
      variance: a.total - g.total,
    };
    const label = groupOf(dept);
    let rows = byGroup.get(label);
    if (!rows) byGroup.set(label, (rows = []));
    rows.push(row);
  }
  const labels = [...byGroup.keys()].sort(
    (a, b) => groupRank(a) - groupRank(b) || (a === UNMAPPED_GROUP ? 1 : 0) - (b === UNMAPPED_GROUP ? 1 : 0) || a.localeCompare(b)
  );
  const totals = emptyFteCells();
  const groups: FteReconciliationGroup[] = labels.map((label) => {
    const rows = byGroup.get(label)!;
    const groupTotals = emptyFteCells();
    for (const row of rows) addCells(groupTotals, row);
    addCells(totals, groupTotals);
    return { label, rows, totals: groupTotals };
  });
  return { groups, totals };
}
