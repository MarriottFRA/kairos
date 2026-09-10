/**
 * The payroll bridge as a workbook: a hotel summary sheet (one row per
 * department), then one sheet per department with a row per position. The
 * columns are the page's account matrix at full depth — L12 → L14 → L18 →
 * L21 → account — as Excel column outline groups, opened collapsed at the
 * depth the page was showing; then total payroll, heads, FTE and the
 * statistic accounts (and on the summary, the BST's figure and the
 * difference). Built on the report writer so it looks like every other
 * export.
 */

import ExcelJS from "exceljs";
import type { EvaluatedRowMeta } from "../../shared/reports/columns";
import {
  BRIDGE_BUCKET_LABELS,
  BRIDGE_STAT_BUCKETS,
  BridgeBucket,
  BridgeCell,
  BridgeDepartment,
  BridgeRow,
  PositionBridgeResponse,
  bucketTotal,
  payrollTotal,
} from "../../shared/reports/bridge";
import {
  BridgeMatrixColumn,
  DEFAULT_BRIDGE_DEPTH,
  activePayrollAccounts,
  allExpanded,
  amountsOf,
  buildAccountTree,
  expandedForDepth,
  layoutMatrix,
  sumAccounts,
} from "../../shared/reports/bridgeMatrix";
import { flat13, flatColumn as column, FlatColumn } from "./excel/flatColumns";
import { COLOR, sanitizeSheetName } from "./excel/styles";
import { writeGridSheet } from "./excel/writeGrid";

type Layout = NonNullable<Parameters<typeof writeGridSheet>[1]["layout"]>[number];

/** The account columns for these departments: the full tree, with the
 *  columns deeper than `depth` hidden under their outline group. */
function matrixFor(response: PositionBridgeResponse, departments: readonly BridgeDepartment[], depth: number) {
  const tree = buildAccountTree(activePayrollAccounts(response.accounts, departments));
  const shown = new Set(layoutMatrix(tree, expandedForDepth(tree, depth)).columns.map((c) => c.node.key));
  const columns = layoutMatrix(tree, allExpanded(tree)).columns;
  const layout: Layout[] = columns.map((c) => ({
    outlineLevel: c.outlineLevel,
    hidden: !shown.has(c.node.key),
    subLabel: c.kind === "subtotal" ? "Subtotal" : c.node.accounts.length === 1 ? c.node.accounts[0] : "",
  }));
  return { columns, layout };
}

const activeOf = (rows: readonly BridgeRow[]) => rows.filter((r) => r.source === "ENGINE" && r.active && !r.deleted);

function statBucketsOf(departments: readonly BridgeDepartment[]) {
  return BRIDGE_STAT_BUCKETS.filter((b) => departments.some((d) => d.totals.some((c) => c.bucket === b)));
}

/** Collects one row's figures per column while the sheet's rows are built. */
class Figures {
  readonly matrix: number[][][];
  readonly payroll: number[][] = [];
  readonly heads: number[][] = [];
  readonly fte: number[][] = [];
  readonly stats: number[][][];

  constructor(
    private readonly columns: readonly BridgeMatrixColumn[],
    private readonly statBuckets: readonly BridgeBucket[]
  ) {
    this.matrix = columns.map((): number[][] => []);
    this.stats = statBuckets.map((): number[][] => []);
  }

  blank() {
    for (const values of [...this.matrix, ...this.stats, this.payroll, this.heads, this.fte]) values.push([]);
  }

  push(cells: readonly BridgeCell[], heads: number | null, fte: number | null) {
    const amounts = amountsOf(cells);
    this.columns.forEach((c, i) => this.matrix[i].push(flat13(sumAccounts(amounts, c.node.accounts))));
    this.statBuckets.forEach((b, i) => this.stats[i].push(flat13(bucketTotal(cells, b))));
    this.payroll.push(flat13(payrollTotal(cells)));
    this.heads.push(heads === null ? [] : flat13(heads));
    this.fte.push(fte === null ? [] : flat13(fte));
  }

  /** The matrix, total payroll, heads and FTE, then the statistic accounts. */
  columnsOut(): FlatColumn[] {
    return [
      ...this.columns.map((c, i) => column(`m_${c.node.id}`, c.label, this.matrix[i], "currency")),
      column("payroll", "Total payroll", this.payroll, "currency"),
      column("heads", "Heads", this.heads, "number"),
      column("fte", "FTE", this.fte, "ratio"),
      ...this.statBuckets.map((b, i) => column(b, BRIDGE_BUCKET_LABELS[b], this.stats[i], "number")),
    ];
  }
}

function bstPayroll(response: PositionBridgeResponse, department: BridgeDepartment): number | null {
  if (!response.bst.available) return null;
  const totals = response.bst.byDept[department.code] ?? {};
  let sum = 0;
  for (const cell of department.totals) if (cell.bucket === "payroll") sum += totals[cell.account] ?? 0;
  return sum;
}

export function buildBridgeWorkbook(
  response: PositionBridgeResponse,
  meta: { hotelName: string; scenarioLabel: string; generatedAt: Date; depth?: number }
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kairos";
  wb.created = meta.generatedAt;
  const depth = meta.depth ?? DEFAULT_BRIDGE_DEPTH;
  const taken = new Set<string>();
  const subtitle = `${meta.hotelName} · ${meta.scenarioLabel}`;
  const generatedAt = meta.generatedAt.toLocaleString();

  // Summary: one row per department.
  {
    const name = sanitizeSheetName("Payroll bridge", taken);
    taken.add(name);
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: COLOR.header } } });
    const { columns, layout } = matrixFor(response, response.departments, depth);
    const statBuckets = statBucketsOf(response.departments);
    const figures = new Figures(columns, statBuckets);
    const rows: EvaluatedRowMeta[] = [];
    const bst: number[][] = [];
    const diff: number[][] = [];
    const push = (label: string, indent: number, department: BridgeDepartment | null) => {
      rows.push({ type: "measure", label, indent, format: "currency" });
      const cells = department ? department.totals : response.departments.flatMap((d) => d.totals);
      const active = activeOf(department ? department.rows : response.departments.flatMap((d) => d.rows));
      figures.push(
        cells,
        active.reduce((s, r) => s + (r.headcount ?? 0), 0),
        active.reduce((s, r) => s + (r.fte ?? 0), 0)
      );
      const held = department
        ? bstPayroll(response, department)
        : response.bst.available
          ? response.departments.reduce((s, d) => s + (bstPayroll(response, d) ?? 0), 0)
          : null;
      bst.push(held === null ? [] : flat13(held));
      diff.push(held === null ? [] : flat13(payrollTotal(cells) - held));
    };
    push("Hotel", 0, null);
    for (const department of response.departments) push(`${department.code} · ${department.name}`, 1, department);

    const out = [
      ...figures.columnsOut(),
      column("bst", response.bst.bucket ? `BST ${response.bst.bucket}` : "BST", bst, "currency"),
      column("diff", "Plan − BST", diff, "currency"),
    ];
    writeGridSheet(ws, {
      title: "Payroll bridge — by department",
      subtitle,
      generatedAt,
      rows,
      months: false,
      separators: false,
      columns: out,
      layout: [...layout, ...out.slice(layout.length).map(() => ({}))],
    });
  }

  // One sheet per department: a row per position.
  for (const department of response.departments) {
    const name = sanitizeSheetName(`${department.code} ${department.name}`, taken);
    taken.add(name);
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: COLOR.separator } } });
    const { columns, layout } = matrixFor(response, [department], depth);
    const figures = new Figures(columns, statBucketsOf([department]));
    const rows: EvaluatedRowMeta[] = [];
    let section: "positions" | "other" | null = null;
    for (const row of department.rows) {
      const wanted = row.source === "ENGINE" ? "positions" : "other";
      if (section !== wanted) {
        section = wanted;
        rows.push({ type: "header", label: wanted === "positions" ? "POSITIONS" : "OTHER SOURCES", indent: 0 });
        figures.blank();
      }
      const label =
        row.source === "ENGINE"
          ? [row.label || row.jobTypeCode || row.positionId, row.jobTypeCode, row.deleted ? "(deleted)" : row.active ? null : "(inactive)"]
              .filter(Boolean)
              .join(" · ")
          : `${row.source}: ${row.label}`;
      rows.push({ type: "measure", label, indent: 1, format: "currency" });
      figures.push(row.cells, row.headcount, row.fte);
    }
    rows.push({ type: "measure", label: "Department total", indent: 0, format: "currency" });
    const active = activeOf(department.rows);
    figures.push(
      department.totals,
      active.reduce((s, r) => s + (r.headcount ?? 0), 0),
      active.reduce((s, r) => s + (r.fte ?? 0), 0)
    );

    const out = figures.columnsOut();
    writeGridSheet(ws, {
      title: `Payroll bridge — ${department.code} · ${department.name}`,
      subtitle,
      generatedAt,
      rows,
      months: false,
      separators: false,
      columns: out,
      layout: [...layout, ...out.slice(layout.length).map(() => ({}))],
    });
  }
  return wb;
}
