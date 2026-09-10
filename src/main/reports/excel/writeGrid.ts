/**
 * One evaluated report → one worksheet.
 *
 * Layout (PS Loader's report-pack shape, one column group per series):
 *
 *   1  Report name                      (merged across the sheet)
 *   2  Hotel · scenario · year
 *   3  Generated: …
 *   4  [warning band when the figures include unpushed plan data]
 *   5  Line | <group 1 label …>  | ‖ | <group 2 label …> | …
 *   6       | Jan … Dec  Total  | ‖ | Jan … Dec  Total  | …      (or just Total)
 *   7+ the rows: headers as category bands, spacers as short blank rows,
 *      measures indented by their level with the row's number format.
 *
 * Panes freeze under row 6 and right of the label column. Values are the
 * engine's numbers written as numbers — never pre-formatted strings — so a
 * reader can sum them.
 */

import type { Worksheet } from "exceljs";
import type { EvaluatedColumn, EvaluatedRowMeta } from "../../../shared/reports/columns";
import { isSeriesColumn } from "../../../shared/reports/columns";
import type { Format } from "../../../shared/reports/types";
import { COLOR, FONT, THOUSANDS_NOTE, WIDTH, numberFormatFor, solid, thinBorder } from "./styles";

export const MONTH_LABELS = Array.from({ length: 12 }, (_, m) =>
  new Date(2000, m, 1).toLocaleString("en", { month: "short" })
);

export interface GridSheetInput {
  title: string;
  subtitle: string;
  generatedAt: string;
  /** A band under the title, in red — the unpushed-plan warning. */
  warning?: string | null;
  rows: EvaluatedRowMeta[];
  columns: Pick<EvaluatedColumn, "id" | "label" | "values" | "rowFormats" | "spec">[];
  /** Twelve months + Total per group, or the Total alone. */
  months: boolean;
  /** Money shown in thousands (the value stays whole; the format scales it). */
  thousands?: boolean;
  /** The blue-grey strip between column groups; default on. */
  separators?: boolean;
  /** Per column (parallel to `columns`): an Excel outline level, whether the
   *  column starts hidden (collapsed), and the text under its header instead
   *  of "Total". */
  layout?: Array<{ outlineLevel?: number; hidden?: boolean; subLabel?: string }>;
}

export const HEADER_ROWS = 6;

export function writeGridSheet(ws: Worksheet, input: GridSheetInput): void {
  const slotsPerGroup = input.months ? 13 : 1;
  const groups = input.columns;
  const separators = input.separators !== false;
  const separatorAfter = (index: number) => separators && index < groups.length - 1;
  // Column 1 = label; each group takes its slots, followed by a separator
  // (none after the last).
  const groupStart: number[] = [];
  let col = 2;
  groups.forEach((_group, index) => {
    groupStart.push(col);
    col += slotsPerGroup;
    if (separatorAfter(index)) col += 1;
  });
  const lastCol = col - 1;

  ws.getColumn(1).width = WIDTH.label;
  for (let c = 2; c <= lastCol; c++) ws.getColumn(c).width = WIDTH.number;
  groups.forEach((_group, index) => {
    if (separatorAfter(index)) ws.getColumn(groupStart[index] + slotsPerGroup).width = WIDTH.separator;
  });
  if (input.layout) {
    let deepest = 0;
    groups.forEach((_group, index) => {
      const layout = input.layout?.[index];
      if (!layout) return;
      for (let s = 0; s < slotsPerGroup; s++) {
        const column = ws.getColumn(groupStart[index] + s);
        if (layout.outlineLevel) column.outlineLevel = layout.outlineLevel;
        if (layout.hidden) column.hidden = true;
      }
      deepest = Math.max(deepest, layout.outlineLevel ?? 0);
    });
    ws.properties.outlineLevelCol = deepest;
  }

  // Title block.
  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = input.title;
  ws.getCell(1, 1).font = FONT.title;
  ws.getRow(1).height = 24;
  ws.mergeCells(2, 1, 2, lastCol);
  ws.getCell(2, 1).value = input.thousands ? `${input.subtitle} · ${THOUSANDS_NOTE}` : input.subtitle;
  ws.getCell(2, 1).font = FONT.subtitle;
  ws.mergeCells(3, 1, 3, lastCol);
  ws.getCell(3, 1).value = `Generated: ${input.generatedAt}`;
  ws.getCell(3, 1).font = FONT.muted;
  ws.mergeCells(4, 1, 4, lastCol);
  if (input.warning) {
    ws.getCell(4, 1).value = input.warning;
    ws.getCell(4, 1).font = FONT.warning;
    ws.getRow(4).height = 20;
  }

  // Group header (row 5) and sub header (row 6).
  const headerRow = ws.getRow(5);
  const subRow = ws.getRow(6);
  // Tree headers are long ("Total Hourly Wages excl Overtime"): wrap them.
  headerRow.height = input.layout ? 42 : 24;
  subRow.height = 20;
  ws.getCell(5, 1).value = "Line";
  ws.getCell(6, 1).value = "";
  for (const r of [5, 6]) {
    const cell = ws.getCell(r, 1);
    cell.fill = solid(COLOR.header);
    cell.font = FONT.headerWhite;
    cell.alignment = { vertical: "middle" };
  }
  groups.forEach((group, index) => {
    const start = groupStart[index];
    const end = start + slotsPerGroup - 1;
    if (end > start) ws.mergeCells(5, start, 5, end);
    const head = ws.getCell(5, start);
    head.value = group.label;
    head.fill = solid(COLOR.header);
    head.font = FONT.headerWhite;
    head.alignment = { horizontal: "center", vertical: "middle", wrapText: !!input.layout };
    const subLabel = input.layout?.[index]?.subLabel;
    for (let c = start; c <= end; c++) {
      const sub = ws.getCell(6, c);
      sub.value = input.months ? (c === end ? "Total" : MONTH_LABELS[c - start]) : subLabel ?? "Total";
      sub.fill = solid(COLOR.header);
      sub.font = FONT.headerWhite;
      sub.alignment = { horizontal: "right", vertical: "middle" };
    }
    if (separatorAfter(index)) {
      for (let r = 5; r <= HEADER_ROWS + input.rows.length; r++) {
        ws.getCell(r, end + 1).fill = solid(COLOR.separator);
      }
    }
  });

  // Body.
  input.rows.forEach((row, rowIndex) => {
    const r = HEADER_ROWS + 1 + rowIndex;
    const excelRow = ws.getRow(r);
    const label = ws.getCell(r, 1);
    if (row.type === "spacer") {
      excelRow.height = 8;
      return;
    }
    if (row.type === "header") {
      excelRow.height = 20;
      label.value = row.label;
      label.font = FONT.bold;
      label.alignment = { indent: row.indent, vertical: "middle" };
      for (let c = 1; c <= lastCol; c++) {
        const cell = ws.getCell(r, c);
        if (cell.fill && (cell.fill as { fgColor?: { argb?: string } }).fgColor?.argb === COLOR.separator) continue;
        cell.fill = solid(COLOR.category);
      }
      return;
    }
    label.value = row.label;
    label.font = row.indent === 0 ? FONT.bold : FONT.body;
    label.alignment = { indent: row.indent, vertical: "middle" };
    label.border = thinBorder;
    groups.forEach((group, index) => {
      const values = group.values[rowIndex];
      const format: Format = group.rowFormats[rowIndex] ?? row.format ?? "number";
      const variance = !isSeriesColumn(group.spec);
      const start = groupStart[index];
      for (let s = 0; s < slotsPerGroup; s++) {
        const slot = input.months ? s : 12;
        const cell = ws.getCell(r, start + s);
        const raw = values ? values[slot] : null;
        const value = raw === null || raw === undefined ? null : row.invertSign ? -raw : raw;
        cell.value = value;
        cell.numFmt = numberFormatFor(format, input.thousands === true);
        cell.alignment = { horizontal: "right" };
        cell.border = thinBorder;
        cell.font = row.indent === 0 ? FONT.bold : FONT.body;
        if (variance && value !== null && value !== 0) {
          const favourable = row.polarity === "cost" ? value < 0 : value > 0;
          cell.font = { ...cell.font, color: { argb: favourable ? COLOR.favourable : COLOR.unfavourable } };
        }
      }
    });
  });

  ws.views = [{ state: "frozen", xSplit: 1, ySplit: HEADER_ROWS }];
}
