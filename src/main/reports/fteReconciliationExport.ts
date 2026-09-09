/**
 * The FTE reconciliation as a workbook: one sheet, a band per department
 * group with a row per department and the group's total, then the hotel
 * total; the Positions grid's FTE (managers, others, total, heads), the
 * account-derived FTE (manager heads, hours, hours-driven FTE, total) and
 * the difference. Built on the report writer so it looks like every other
 * export; the work week the account side divided by is in the subtitle.
 */

import ExcelJS from "exceljs";
import type { EvaluatedRowMeta } from "../../shared/reports/columns";
import type { FteReconciliationCells, FteReconciliationResponse } from "../../shared/reports/fteReconciliation";
import type { Format } from "../../shared/reports/types";
import { WEEKLY_HOURS_ORIGIN_LABELS } from "../../shared/reports/weeklyHours";
import { FlatColumn, flat13, flatColumn } from "./excel/flatColumns";
import { COLOR, sanitizeSheetName } from "./excel/styles";
import { writeGridSheet } from "./excel/writeGrid";

export interface FteReconciliationWorkbookMeta {
  hotelName: string;
  scenarioLabel: string;
  generatedAt: Date;
}

interface ColumnDef {
  id: string;
  label: string;
  format: Format;
  pick: (cells: FteReconciliationCells) => number;
}

const COLUMNS: ColumnDef[] = [
  { id: "grid_managers", label: "Positions grid · Manager FTE", format: "ratio", pick: (c) => c.grid.managers },
  { id: "grid_others", label: "Positions grid · Other FTE", format: "ratio", pick: (c) => c.grid.others },
  { id: "grid_total", label: "Positions grid · Total FTE", format: "ratio", pick: (c) => c.grid.total },
  { id: "grid_heads", label: "Positions grid · Heads", format: "number", pick: (c) => c.grid.heads },
  { id: "acc_managers", label: "Accounts · Manager heads", format: "ratio", pick: (c) => c.accounts.managerHeads },
  { id: "acc_hours", label: "Accounts · Hours driving FTE", format: "number", pick: (c) => c.accounts.hours },
  { id: "acc_hours_fte", label: "Accounts · Hours-driven FTE", format: "ratio", pick: (c) => c.accounts.hoursFte },
  { id: "acc_total", label: "Accounts · Total FTE", format: "ratio", pick: (c) => c.accounts.total },
  { id: "variance", label: "Accounts − grid", format: "ratio", pick: (c) => c.variance },
];

export function buildFteReconciliationWorkbook(
  response: FteReconciliationResponse,
  meta: FteReconciliationWorkbookMeta
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kairos";
  wb.created = meta.generatedAt;
  const ws = wb.addWorksheet(sanitizeSheetName("FTE reconciliation"), { properties: { tabColor: { argb: COLOR.header } } });

  const rows: EvaluatedRowMeta[] = [];
  const values = new Map<string, number[][]>(COLUMNS.map((c): [string, number[][]] => [c.id, []]));
  const push = (label: string, indent: number, cells: FteReconciliationCells | null) => {
    rows.push(cells ? { type: "measure", label, indent, format: "ratio" } : { type: "header", label, indent });
    for (const column of COLUMNS) values.get(column.id)!.push(cells ? flat13(column.pick(cells)) : []);
  };
  for (const group of response.groups) {
    push(group.label.toUpperCase(), 0, null);
    for (const row of group.rows) push(`${row.dept} · ${row.name}`, 1, row);
    push(`Total ${group.label}`, 0, group.totals);
  }
  push("TOTAL HOTEL", 0, response.totals);

  const columns: FlatColumn[] = COLUMNS.map((column) =>
    flatColumn(
      column.id,
      column.label,
      values.get(column.id)!,
      column.format,
      column.id === "variance" ? { id: column.id, variance: { a: "acc_total", b: "grid_total", mode: "abs" } } : undefined
    )
  );

  const week = response.weeklyHours
    ? ` · ${response.weeklyHours.value}h week from ${WEEKLY_HOURS_ORIGIN_LABELS[response.weeklyHours.origin]} · ${Math.round(response.fteHoursYear)} hours per FTE`
    : "";
  writeGridSheet(ws, {
    title: "FTE reconciliation — Positions grid vs accounts",
    subtitle: `${meta.hotelName} · ${meta.scenarioLabel}${week}`,
    generatedAt: meta.generatedAt.toLocaleString(),
    rows,
    months: false,
    columns,
  });
  return wb;
}
