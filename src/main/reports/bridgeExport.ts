/**
 * The payroll bridge as a workbook: a hotel summary sheet (one row per
 * department, the bucket columns, heads, FTE, payroll per FTE, the BST's
 * figure and the difference), then one sheet per department with a row per
 * position. Built on the report writer so it looks like every other export.
 */

import ExcelJS from "exceljs";
import type { EvaluatedRowMeta } from "../../shared/reports/columns";
import {
  BRIDGE_BUCKET_LABELS,
  BRIDGE_BUCKET_ORDER,
  BridgeBucket,
  BridgeDepartment,
  PAYROLL_BUCKETS,
  PositionBridgeResponse,
  bucketTotal,
  payrollTotal,
} from "../../shared/reports/bridge";
import type { Format } from "../../shared/reports/types";
import { flat13, flatColumn as column } from "./excel/flatColumns";
import { COLOR, sanitizeSheetName } from "./excel/styles";
import { writeGridSheet } from "./excel/writeGrid";

const bucketFormat = (bucket: BridgeBucket): Format => (bucket === "hours" || bucket === "heads" ? "number" : "currency");

/** Which buckets appear: those with any value anywhere, in the fixed order. */
function activeBuckets(departments: readonly BridgeDepartment[]): BridgeBucket[] {
  const seen = new Set<BridgeBucket>();
  for (const d of departments) for (const c of d.totals) seen.add(c.bucket);
  return BRIDGE_BUCKET_ORDER.filter((b) => seen.has(b));
}

function bstPayroll(response: PositionBridgeResponse, department: BridgeDepartment): number | null {
  if (!response.bst.available) return null;
  const totals = response.bst.byDept[department.code] ?? {};
  let sum = 0;
  for (const cell of department.totals) {
    if (PAYROLL_BUCKETS.has(cell.bucket)) sum += totals[cell.account] ?? 0;
  }
  return sum;
}

export function buildBridgeWorkbook(
  response: PositionBridgeResponse,
  meta: { hotelName: string; scenarioLabel: string; generatedAt: Date }
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kairos";
  wb.created = meta.generatedAt;
  const taken = new Set<string>();
  const buckets = activeBuckets(response.departments);
  const subtitle = `${meta.hotelName} · ${meta.scenarioLabel}`;
  const generatedAt = meta.generatedAt.toLocaleString();

  // Summary: one row per department.
  {
    const name = sanitizeSheetName("Payroll bridge", taken);
    taken.add(name);
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: COLOR.header } } });
    const rows: EvaluatedRowMeta[] = [];
    const perBucket = new Map<BridgeBucket, number[][]>(buckets.map((b): [BridgeBucket, number[][]] => [b, []]));
    const payroll: number[][] = [];
    const heads: number[][] = [];
    const fte: number[][] = [];
    const bst: number[][] = [];
    const diff: number[][] = [];
    const push = (label: string, indent: number, department: BridgeDepartment | null) => {
      rows.push({ type: "measure", label, indent, format: "currency" });
      const cells = department ? department.totals : response.departments.flatMap((d) => d.totals);
      for (const b of buckets) perBucket.get(b)!.push(flat13(bucketTotal(cells, b)));
      const pay = payrollTotal(cells);
      payroll.push(flat13(pay));
      const active = (department ? department.rows : response.departments.flatMap((d) => d.rows)).filter(
        (r) => r.source === "ENGINE" && r.active && !r.deleted
      );
      heads.push(flat13(active.reduce((s, r) => s + (r.headcount ?? 0), 0)));
      fte.push(flat13(active.reduce((s, r) => s + (r.fte ?? 0), 0)));
      const held = department
        ? bstPayroll(response, department)
        : response.bst.available
          ? response.departments.reduce((s, d) => s + (bstPayroll(response, d) ?? 0), 0)
          : null;
      bst.push(held === null ? [] : flat13(held));
      diff.push(held === null ? [] : flat13(pay - held));
    };
    push("Hotel", 0, null);
    for (const department of response.departments) push(`${department.code} · ${department.name}`, 1, department);

    writeGridSheet(ws, {
      title: "Payroll bridge — by department",
      subtitle,
      generatedAt,
      rows,
      months: false,
      columns: [
        ...buckets.map((b) => column(b, BRIDGE_BUCKET_LABELS[b], perBucket.get(b)!, bucketFormat(b))),
        column("payroll", "Total payroll", payroll, "currency"),
        column("heads", "Heads", heads, "number"),
        column("fte", "FTE", fte, "ratio"),
        column("bst", response.bst.bucket ? `BST ${response.bst.bucket}` : "BST", bst, "currency"),
        column("diff", "Plan − BST", diff, "currency"),
      ],
    });
  }

  // One sheet per department: a row per position.
  for (const department of response.departments) {
    const name = sanitizeSheetName(`${department.code} ${department.name}`, taken);
    taken.add(name);
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: COLOR.separator } } });
    const rows: EvaluatedRowMeta[] = [];
    const perBucket = new Map<BridgeBucket, number[][]>(buckets.map((b): [BridgeBucket, number[][]] => [b, []]));
    const payroll: number[][] = [];
    const heads: number[][] = [];
    const fte: number[][] = [];
    let section: "positions" | "other" | null = null;
    for (const row of department.rows) {
      const wanted = row.source === "ENGINE" ? "positions" : "other";
      if (section !== wanted) {
        section = wanted;
        rows.push({ type: "header", label: wanted === "positions" ? "POSITIONS" : "OTHER SOURCES", indent: 0 });
        for (const b of buckets) perBucket.get(b)!.push([]);
        payroll.push([]);
        heads.push([]);
        fte.push([]);
      }
      const label =
        row.source === "ENGINE"
          ? [row.label || row.jobTypeCode || row.positionId, row.jobTypeCode, row.deleted ? "(deleted)" : row.active ? null : "(inactive)"]
              .filter(Boolean)
              .join(" · ")
          : `${row.source}: ${row.label}`;
      rows.push({ type: "measure", label, indent: 1, format: "currency" });
      for (const b of buckets) perBucket.get(b)!.push(flat13(bucketTotal(row.cells, b)));
      payroll.push(flat13(payrollTotal(row.cells)));
      heads.push(row.headcount === null ? [] : flat13(row.headcount));
      fte.push(row.fte === null ? [] : flat13(row.fte));
    }
    rows.push({ type: "measure", label: "Department total", indent: 0, format: "currency" });
    for (const b of buckets) perBucket.get(b)!.push(flat13(bucketTotal(department.totals, b)));
    payroll.push(flat13(payrollTotal(department.totals)));
    const active = department.rows.filter((r) => r.source === "ENGINE" && r.active && !r.deleted);
    heads.push(flat13(active.reduce((s, r) => s + (r.headcount ?? 0), 0)));
    fte.push(flat13(active.reduce((s, r) => s + (r.fte ?? 0), 0)));

    writeGridSheet(ws, {
      title: `Payroll bridge — ${department.code} · ${department.name}`,
      subtitle,
      generatedAt,
      rows,
      months: false,
      columns: [
        ...buckets.map((b) => column(b, BRIDGE_BUCKET_LABELS[b], perBucket.get(b)!, bucketFormat(b))),
        column("payroll", "Total payroll", payroll, "currency"),
        column("heads", "Heads", heads, "number"),
        column("fte", "FTE", fte, "ratio"),
      ],
    });
  }
  return wb;
}
