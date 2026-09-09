/**
 * The staffing overview as a workbook: one sheet, a band per department
 * group with a row per job title and the group's total, then the hotel
 * total; per classification a head count and an FTE column for the budget
 * scenario, the compared one, and the variance (coloured — fewer heads
 * reads as good news, the report's lines being costs). Built on the report
 * writer so it looks like every other export.
 */

import ExcelJS from "exceljs";
import type { EvaluatedRowMeta } from "../../shared/reports/columns";
import {
  STAFFING_BUCKETS,
  STAFFING_BUCKET_LABELS,
  STAFFING_KINDS,
  STAFFING_KIND_LABELS,
  StaffingCells,
  StaffingKind,
  StaffingOverviewResponse,
} from "../../shared/reports/staffingOverview";
import { FlatColumn, flat13, flatColumn } from "./excel/flatColumns";
import { COLOR, sanitizeSheetName } from "./excel/styles";
import { writeGridSheet } from "./excel/writeGrid";

export interface StaffingWorkbookMeta {
  hotelName: string;
  scenarioLabel: string;
  compareLabel?: string | null;
  generatedAt: Date;
}

type Series = "budget" | "compare" | "variance";

const kindFormat = (kind: StaffingKind) => (kind === "hc" ? "number" : "ratio");

export function buildStaffingOverviewWorkbook(response: StaffingOverviewResponse, meta: StaffingWorkbookMeta): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kairos";
  wb.created = meta.generatedAt;
  const name = sanitizeSheetName("Staffing overview");
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: COLOR.header } } });

  const series: Series[] = response.compare ? ["budget", "compare", "variance"] : ["budget"];
  const seriesLabel: Record<Series, string> = {
    budget: meta.scenarioLabel || `Budget ${response.year}`,
    compare: meta.compareLabel || (response.compare ? `Compared ${response.compare.year}` : "Compared"),
    variance: "Variance",
  };
  const cellsOf = (series: Series, row: { cells: StaffingCells; compare: StaffingCells | null; variance: StaffingCells | null }) =>
    series === "budget" ? row.cells : series === "compare" ? row.compare : row.variance;

  const rows: EvaluatedRowMeta[] = [];
  const values = new Map<string, number[][]>();
  const key = (s: Series, kind: StaffingKind, bucket: string) => `${s}_${kind}_${bucket}`;
  for (const s of series) for (const kind of STAFFING_KINDS) for (const bucket of STAFFING_BUCKETS) values.set(key(s, kind, bucket), []);

  const push = (
    label: string,
    indent: number,
    row: { cells: StaffingCells; compare: StaffingCells | null; variance: StaffingCells | null } | null
  ) => {
    rows.push(row ? { type: "measure", label, indent, format: "number", polarity: "cost" } : { type: "header", label, indent });
    for (const s of series) {
      for (const kind of STAFFING_KINDS) {
        for (const bucket of STAFFING_BUCKETS) {
          const cells = row ? cellsOf(s, row) : null;
          values.get(key(s, kind, bucket))!.push(cells ? flat13(cells[kind][bucket]) : []);
        }
      }
    }
  };

  for (const group of response.groups) {
    push(group.label.toUpperCase(), 0, null);
    for (const row of group.rows) push(row.title, 1, row);
    push(`Total ${group.label}`, 0, { cells: group.totals, compare: group.compareTotals, variance: group.varianceTotals });
  }
  push("TOTAL HOTEL", 0, { cells: response.totals, compare: response.compareTotals, variance: response.varianceTotals });

  const columns: FlatColumn[] = [];
  for (const s of series) {
    for (const kind of STAFFING_KINDS) {
      for (const bucket of STAFFING_BUCKETS) {
        const id = key(s, kind, bucket);
        const label = `${seriesLabel[s]} · ${STAFFING_BUCKET_LABELS[bucket]} ${STAFFING_KIND_LABELS[kind]}`;
        columns.push(
          flatColumn(
            id,
            label,
            values.get(id)!,
            kindFormat(kind),
            s === "variance"
              ? { id, variance: { a: key("budget", kind, bucket), b: key("compare", kind, bucket), mode: "abs" } }
              : undefined
          )
        );
      }
    }
  }

  writeGridSheet(ws, {
    title: "Staffing overview — head count and FTE per department group",
    subtitle: `${meta.hotelName} · ${meta.scenarioLabel}${meta.compareLabel ? ` vs ${meta.compareLabel}` : ""}`,
    generatedAt: meta.generatedAt.toLocaleString(),
    rows,
    months: false,
    columns,
  });
  return wb;
}
