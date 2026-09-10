/**
 * The staffing statistics as a workbook, everything expanded:
 *
 *   Staffing statistics  the hotel total, then each department group with its
 *                        departments under it — heads, FTE (managers by head,
 *                        from hours, total), hours and the hours per account.
 *                        A cell whose account more than one grade books to
 *                        carries a note saying who and why it matters.
 *   Positions            one row per position (and per manual / allocation /
 *                        buyout line) with its group and department, filterable
 *                        — the "what makes up the value" view, flat so Excel's
 *                        own filters do the drilling.
 *   Grade mixing         only when something is flagged: one row per
 *                        department × account, the hours each grade put there.
 *
 * One period per workbook: the year (heads at year end, FTE the average,
 * hours the total) or the month the page was showing.
 */

import ExcelJS from "exceljs";
import type { EvaluatedRowMeta } from "../../shared/reports/columns";
import {
  GRADE_MIX_MESSAGES,
  GRADE_TIERS,
  GRADE_TIER_LABELS,
  GradeMixEntry,
  HOURS_KIND_LABELS,
  StaffingStatisticsResponse,
  StaffingStatsNode,
  StaffingStatsValues,
  YEAR_SLOT,
  describeMix,
  shortAccountName,
} from "../../shared/reports/staffingStatistics";
import type { Format } from "../../shared/reports/types";
import { WEEKLY_HOURS_ORIGIN_LABELS } from "../../shared/reports/weeklyHours";
import { FlatColumn, flat13, flatColumn } from "./excel/flatColumns";
import { COLOR, FONT, WIDTH, numberFormatFor, sanitizeSheetName, solid, thinBorder } from "./excel/styles";
import { HEADER_ROWS, MONTH_LABELS, writeGridSheet } from "./excel/writeGrid";

export interface StaffingStatisticsWorkbookMeta {
  hotelName: string;
  scenarioLabel: string;
  generatedAt: Date;
  /** 0..11 a month, 12 the year. */
  slot: number;
}

interface Column {
  id: string;
  label: string;
  format: Format;
  /** The hours account the column shows; null for the headline figures. */
  account: string | null;
  pick: (values: StaffingStatsValues) => number;
}

export function periodLabel(slot: number): string {
  return slot >= YEAR_SLOT ? "Year" : MONTH_LABELS[slot];
}

function columnsFor(response: StaffingStatisticsResponse, slot: number): Column[] {
  const at = (series: number[] | undefined) => series?.[slot] ?? 0;
  return [
    { id: "heads", label: slot >= YEAR_SLOT ? "Heads (year end)" : "Heads", format: "number", account: null, pick: (v) => at(v.heads) },
    { id: "fte_mgr", label: "FTE · Managers (heads)", format: "ratio", account: null, pick: (v) => at(v.managerHeads) },
    { id: "fte_hours", label: "FTE · From hours", format: "ratio", account: null, pick: (v) => at(v.hoursFte) },
    { id: "fte", label: "FTE · Total", format: "ratio", account: null, pick: (v) => at(v.fte) },
    { id: "hours", label: "Hours · Total", format: "number", account: null, pick: (v) => at(v.hours) },
    ...response.accounts.map(
      (account): Column => ({
        id: `acc_${account.code}`,
        label: `${HOURS_KIND_LABELS[account.kind]} · ${account.code} ${shortAccountName(account)}`,
        format: "number",
        account: account.code,
        pick: (v) => at(v.byAccount[account.code]),
      })
    ),
  ];
}

const entryKey = (dept: string, account: string) => `${dept}|${account}`;

function mixNote(node: StaffingStatsNode, account: string, entries: Map<string, GradeMixEntry>): string | null {
  const cell = node.mix[account];
  if (!cell || cell.kinds.length === 0) return null;
  return describeMix(node, cell, node.code ? entries.get(entryKey(node.code, account)) : null);
}

export function buildStaffingStatisticsWorkbook(
  response: StaffingStatisticsResponse,
  meta: StaffingStatisticsWorkbookMeta
): ExcelJS.Workbook {
  const slot = Math.min(Math.max(Math.trunc(meta.slot), 0), YEAR_SLOT);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kairos";
  wb.created = meta.generatedAt;
  const columns = columnsFor(response, slot);
  const entries = new Map(response.gradeMix.map((entry) => [entryKey(entry.dept, entry.account), entry]));
  const period = periodLabel(slot);
  const week = response.weeklyHours
    ? ` · ${response.weeklyHours.value.toFixed(2)}h effective week from ${WEEKLY_HOURS_ORIGIN_LABELS[response.weeklyHours.origin]}`
    : "";
  const subtitle = `${meta.hotelName} · ${meta.scenarioLabel} · ${period}${week}`;

  // --- Sheet 1: hotel, groups, departments -------------------------------
  const summary = wb.addWorksheet(sanitizeSheetName("Staffing statistics"), { properties: { tabColor: { argb: COLOR.header } } });
  const rows: EvaluatedRowMeta[] = [];
  const nodes: (StaffingStatsNode | null)[] = [];
  const values = new Map<string, number[][]>(columns.map((c): [string, number[][]] => [c.id, []]));
  const push = (node: StaffingStatsNode | null, label: string, indent: number) => {
    rows.push(node ? { type: "measure", label, indent, format: "number" } : { type: "spacer", label: "", indent: 0 });
    nodes.push(node);
    for (const column of columns) values.get(column.id)!.push(node ? flat13(column.pick(node.values)) : []);
  };
  push(response.hotel, "TOTAL HOTEL", 0);
  for (const group of response.hotel.children) {
    push(null, "", 0);
    push(group, group.label, 0);
    for (const dept of group.children) push(dept, `${dept.code} · ${dept.label}`, 1);
  }
  writeGridSheet(summary, {
    title: "Staffing statistics — heads, FTE and hours",
    subtitle,
    generatedAt: meta.generatedAt.toLocaleString(),
    rows,
    months: false,
    columns: columns.map((column): FlatColumn => flatColumn(column.id, column.label, values.get(column.id)!, column.format)),
  });
  nodes.forEach((node, rowIndex) => {
    if (!node) return;
    columns.forEach((column, index) => {
      if (!column.account) return;
      const note = mixNote(node, column.account, entries);
      if (note) summary.getCell(HEADER_ROWS + 1 + rowIndex, 2 + index * 2).note = note;
    });
  });

  // --- Sheet 2: positions ------------------------------------------------
  const positions = wb.addWorksheet(sanitizeSheetName("Positions"));
  const fixed = ["Group", "Dept", "Department", "Position", "Classification"];
  const headers = [...fixed, ...columns.map((c) => c.label)];
  positions.getCell(1, 1).value = "Staffing statistics — positions";
  positions.getCell(1, 1).font = FONT.title;
  positions.getCell(2, 1).value = subtitle;
  positions.getCell(2, 1).font = FONT.subtitle;
  const headerRow = 4;
  headers.forEach((header, index) => {
    const cell = positions.getCell(headerRow, index + 1);
    cell.value = header;
    cell.fill = solid(COLOR.header);
    cell.font = FONT.headerWhite;
    cell.alignment = { vertical: "middle", wrapText: true, horizontal: index < fixed.length ? "left" : "right" };
  });
  positions.getRow(headerRow).height = 32;
  let r = headerRow + 1;
  for (const group of response.hotel.children) {
    for (const dept of group.children) {
      for (const leaf of dept.children) {
        const label = leaf.deleted ? `${leaf.label} (deleted)` : leaf.label;
        const cells: (string | number)[] = [group.label, dept.code ?? "", dept.label, label, leaf.jobTypeCode ?? "—"];
        cells.forEach((value, index) => {
          const cell = positions.getCell(r, index + 1);
          cell.value = value;
          cell.font = FONT.body;
          cell.border = thinBorder;
        });
        columns.forEach((column, index) => {
          const cell = positions.getCell(r, fixed.length + index + 1);
          cell.value = column.pick(leaf.values);
          cell.numFmt = numberFormatFor(column.format, false);
          cell.font = FONT.body;
          cell.border = thinBorder;
          if (column.account) {
            const note = mixNote(leaf, column.account, entries);
            if (note) cell.note = note;
          }
        });
        r++;
      }
    }
  }
  positions.getColumn(1).width = 28;
  positions.getColumn(2).width = 8;
  positions.getColumn(3).width = 30;
  positions.getColumn(4).width = 32;
  positions.getColumn(5).width = 20;
  for (let c = fixed.length + 1; c <= headers.length; c++) positions.getColumn(c).width = WIDTH.number + 2;
  positions.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(headerRow, r - 1), column: headers.length } };
  positions.views = [{ state: "frozen", xSplit: 4, ySplit: headerRow }];

  // --- Sheet 3: grade mixing, when there is any ----------------------------
  if (response.gradeMix.length > 0) {
    const mix = wb.addWorksheet(sanitizeSheetName("Grade mixing"));
    mix.getCell(1, 1).value = "Grade mixing — hours accounts more than one grade books to";
    mix.getCell(1, 1).font = FONT.title;
    mix.getCell(2, 1).value = `${meta.hotelName} · ${meta.scenarioLabel} · the year's hours`;
    mix.getCell(2, 1).font = FONT.subtitle;
    const mixHeaders = [
      "Group",
      "Dept",
      "Department",
      "Account",
      "Account name",
      "Hours type",
      ...GRADE_TIERS.map((tier) => `${GRADE_TIER_LABELS[tier]} hours`),
      ...GRADE_TIERS.map((tier) => `${GRADE_TIER_LABELS[tier]} positions`),
      "Why it matters",
    ];
    mixHeaders.forEach((header, index) => {
      const cell = mix.getCell(headerRow, index + 1);
      cell.value = header;
      cell.fill = solid(COLOR.header);
      cell.font = FONT.headerWhite;
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    mix.getRow(headerRow).height = 32;
    response.gradeMix.forEach((entry, index) => {
      const row = headerRow + 1 + index;
      const cells: (string | number)[] = [
        entry.group,
        entry.dept,
        entry.deptName,
        entry.account,
        entry.accountName ?? "",
        HOURS_KIND_LABELS[entry.accountKind],
        ...GRADE_TIERS.map((tier) => entry.hoursByTier[tier]),
        ...GRADE_TIERS.map((tier) => entry.positionsByTier[tier]),
        entry.kinds.map((kind) => GRADE_MIX_MESSAGES[kind]).join(" "),
      ];
      cells.forEach((value, c) => {
        const cell = mix.getCell(row, c + 1);
        cell.value = value;
        cell.font = FONT.body;
        cell.border = thinBorder;
        if (typeof value === "number") cell.numFmt = numberFormatFor("number", false);
      });
    });
    [28, 8, 30, 10, 30, 14, 14, 14, 14, 12, 12, 12, 80].forEach((width, index) => (mix.getColumn(index + 1).width = width));
    mix.views = [{ state: "frozen", ySplit: headerRow }];
  }

  return wb;
}
