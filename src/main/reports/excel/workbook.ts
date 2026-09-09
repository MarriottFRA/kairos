/**
 * Report workbooks — an evaluated report (or, later, a pack of them) as an
 * .xlsx built from scratch with ExcelJS. Nothing here edits an existing
 * file: the BST writer's OOXML surgery exists because the BST is a macro
 * workbook that must survive untouched; a fresh report workbook has no such
 * constraint and ExcelJS gives us styling for free.
 *
 * Every workbook carries a "Sources" sheet naming, per column, the scenario,
 * the year, the bucket, when the run was calculated and whether it was out
 * of date, plus the warnings — so a sheet forwarded by email still says
 * where its numbers came from. A workbook that includes unpushed plan data
 * says so in red on every sheet and in the file name: the corporate line is
 * that the BST is the record, and a report that bypasses it must look like
 * what it is.
 */

import ExcelJS from "exceljs";
import type { EvaluatedColumn, ReportColumnSpec } from "../../../shared/reports/columns";
import { isSeriesColumn } from "../../../shared/reports/columns";
import type { ReportColumnInfo, ReportsEvaluateColumnsResponse } from "../../../shared/reports/ipc";
import { hasDrift } from "../../../shared/reports/sources";
import { COLOR, FONT, sanitizeSheetName, solid } from "./styles";
import { writeGridSheet } from "./writeGrid";

export const UNPUSHED_WARNING =
  "UNPUSHED PLAN DATA — these figures include Kairos results that have not been pushed to the BST.";

export interface ReportWorkbookMeta {
  reportName: string;
  hotelName: string;
  /** e.g. "Planning 2027". */
  scenarioLabel: string;
  generatedAt: Date;
  months: boolean;
  /** Money in thousands on every sheet. */
  thousands?: boolean;
}

export const includesUnpushedPlan = (columns: readonly ReportColumnSpec[]): boolean =>
  columns.some((c) => isSeriesColumn(c) && c.series.kind === "plan");

function describeSeries(column: EvaluatedColumn & ReportColumnInfo): string {
  if (!isSeriesColumn(column.spec)) {
    const v = column.spec.variance;
    return `${v.mode} variance: ${v.a} − ${v.b}`;
  }
  const s = column.spec.series;
  if (s.kind === "plan") return "Plan: scenario results laid over the BST";
  if (s.kind === "kairos") return "Kairos: scenario results only";
  const bucket = column.bst.map((b) => `${b.bucketType ?? "?"} ${b.year ?? "?"} (bucket ${b.bucketIndex})`).join(", ");
  return `BST: ${bucket || "no bucket read"}`;
}

export function addSourcesSheet(
  wb: ExcelJS.Workbook,
  response: ReportsEvaluateColumnsResponse,
  meta: ReportWorkbookMeta,
  taken: Set<string>
): ExcelJS.Worksheet {
  const name = sanitizeSheetName("Sources", taken);
  taken.add(name);
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: COLOR.section } } });
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 28;
  ws.getColumn(3).width = 48;
  ws.getColumn(4).width = 14;
  ws.getColumn(5).width = 22;
  ws.getColumn(6).width = 14;
  ws.getColumn(7).width = 40;

  ws.getCell(1, 1).value = `${meta.reportName} — sources`;
  ws.getCell(1, 1).font = FONT.title;
  ws.getCell(2, 1).value = `${meta.hotelName} · ${meta.scenarioLabel}`;
  ws.getCell(2, 1).font = FONT.subtitle;
  ws.getCell(3, 1).value = `Mapping tables version: ${response.mappingVersion ?? "not synced"}`;
  ws.getCell(3, 1).font = FONT.muted;

  const headers = ["Column", "Label", "Reads", "Year", "Calculated", "Out of date", "Plan vs BST"];
  headers.forEach((h, i) => {
    const cell = ws.getCell(5, i + 1);
    cell.value = h;
    cell.fill = solid(COLOR.header);
    cell.font = FONT.headerWhite;
  });
  response.columns.forEach((column, index) => {
    const r = 6 + index;
    ws.getCell(r, 1).value = column.id;
    ws.getCell(r, 2).value = column.label;
    ws.getCell(r, 3).value = describeSeries(column);
    ws.getCell(r, 4).value = column.year;
    ws.getCell(r, 5).value = column.run ? new Date(column.run.computedAt).toLocaleString() : null;
    ws.getCell(r, 6).value = column.run ? (column.run.stale ? "yes" : "no") : null;
    ws.getCell(r, 7).value = hasDrift(column.drift)
      ? `${column.drift!.differing} changed, ${column.drift!.onlyInPlan} not in BST, ${column.drift!.onlyInBst} to clear`
      : column.drift
        ? "in step"
        : null;
  });

  const warnings = response.columns.flatMap((c) => c.warnings.map((w) => `${c.id}: ${w.message}`));
  const unique = [...new Set(warnings)];
  if (unique.length > 0) {
    const start = 6 + response.columns.length + 1;
    ws.getCell(start, 1).value = "Warnings";
    ws.getCell(start, 1).font = FONT.bold;
    unique.forEach((text, i) => {
      ws.mergeCells(start + 1 + i, 1, start + 1 + i, 7);
      ws.getCell(start + 1 + i, 1).value = text;
      ws.getCell(start + 1 + i, 1).font = FONT.body;
    });
  }
  return ws;
}

/** One report, one sheet, plus its Sources sheet. */
export function buildReportWorkbook(
  response: ReportsEvaluateColumnsResponse,
  meta: ReportWorkbookMeta
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kairos";
  wb.created = meta.generatedAt;
  const taken = new Set<string>();
  const unpushed = includesUnpushedPlan(response.columns.map((c) => c.spec));

  const name = sanitizeSheetName(meta.reportName, taken);
  taken.add(name);
  const ws = wb.addWorksheet(name, {
    properties: { tabColor: { argb: unpushed ? COLOR.warning : COLOR.header } },
  });
  writeGridSheet(ws, {
    title: meta.reportName,
    subtitle: `${meta.hotelName} · ${meta.scenarioLabel}`,
    generatedAt: meta.generatedAt.toLocaleString(),
    warning: unpushed ? UNPUSHED_WARNING : null,
    rows: response.rows,
    columns: response.columns,
    months: meta.months,
    thousands: meta.thousands === true,
  });
  addSourcesSheet(wb, response, meta, taken);
  return wb;
}

/** A file name that says what the file is — and, when it is, that it holds
 *  unpushed figures. */
export function suggestedFileName(meta: ReportWorkbookMeta, unpushed: boolean): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const stamp = meta.generatedAt.toISOString().slice(0, 10);
  return `${safe(meta.hotelName)}_${safe(meta.reportName)}_${safe(meta.scenarioLabel)}_${stamp}${unpushed ? "_UNPUSHED" : ""}.xlsx`;
}
