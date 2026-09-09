/**
 * The report workbook, read back with ExcelJS: title block, group headers,
 * month sub-headers, frozen panes, number formats per row, the separator
 * strip, the unpushed-plan warning band (and its absence), the Sources
 * sheet, and sheet-name hygiene.
 */

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { ReportsEvaluateColumnsResponse } from "../../../../shared/reports/ipc";
import { sanitizeSheetName } from "../styles";
import { HEADER_ROWS } from "../writeGrid";
import { UNPUSHED_WARNING, buildReportWorkbook, suggestedFileName } from "../workbook";

const flat = (value: number) => [...new Array(12).fill(value), value * 12];

type Column = ReportsEvaluateColumnsResponse["columns"][number];

function response(kind: "bst" | "plan"): ReportsEvaluateColumnsResponse {
  const budget: Column = {
    id: "budget",
    label: "Budget 2027",
    spec: { id: "budget", series: kind === "plan" ? { kind: "plan" as const, scenarioId: "s1" } : { kind: "bst" as const, relativeTo: "s1" } },
    values: [null, flat(1000), flat(25), null],
    rowFormats: [null, null, null, null],
    atoms: {},
    params: {},
    warnings: [],
    scenarioId: "s1",
    year: 2027,
    run: { computedAt: "2026-09-09T10:00:00.000Z", stale: false },
    bst: [{ importId: "imp", bucketIndex: 1, bucketType: "BUDGET", year: 2027 }],
    drift: { differing: 1, onlyInPlan: 0, onlyInBst: 0, absDelta: new Array(13).fill(0), top: [] },
    weeklyHours: null,
  };
  const ly: Column = { ...budget, id: "ly", label: "LY 2026", spec: { id: "ly", series: { kind: "bst" as const, relativeTo: "s1", yearOffset: -1 } }, values: [null, flat(800), flat(20), null], drift: null, year: 2026 };
  const variance: Column = {
    ...budget,
    id: "v",
    label: "vs LY",
    spec: { id: "v", variance: { a: "budget", b: "ly", mode: "pct" as const } },
    values: [null, flat(25), flat(5), null],
    rowFormats: [null, "percent" as const, "pts" as const, null],
    run: null,
    bst: [],
    drift: null,
    weeklyHours: null,
    year: null,
    scenarioId: null,
  };
  return {
    definitionId: "summary_pl",
    rows: [
      { type: "header", label: "PAYROLL", indent: 0 },
      { type: "measure", label: "Total Payroll", indent: 1, measureId: "p", format: "currency", polarity: "cost" },
      { type: "measure", label: "Payroll %", indent: 1, measureId: "q", format: "percent" },
      { type: "spacer", label: "", indent: 0 },
    ],
    columns: [budget, ly, variance],
    mappingVersion: "maps-1",
    timings: { loadMs: 1, evaluateMs: 1 },
  };
}

const META = {
  reportName: "Summary P&L",
  hotelName: "Test Hotel",
  scenarioLabel: "Planning 2027",
  generatedAt: new Date("2026-09-09T10:00:00.000Z"),
  months: true,
};

async function roundTrip(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buffer = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  // ExcelJS's Buffer typing predates Node's generic Buffer; the value is a Buffer.
  await back.xlsx.load(buffer as never);
  return back;
}

describe("buildReportWorkbook", () => {
  it("lays the report out as a PS Loader-style sheet", async () => {
    const wb = await roundTrip(buildReportWorkbook(response("bst"), META));
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Summary P&L", "Sources"]);
    const ws = wb.getWorksheet("Summary P&L")!;

    expect(ws.getCell("A1").value).toBe("Summary P&L");
    expect(ws.getCell("A2").value).toBe("Test Hotel · Planning 2027");
    expect(String(ws.getCell("A3").value)).toMatch(/^Generated: /);
    expect(ws.getCell("A4").value).toBeNull();

    // Group headers: budget in B..N, separator O, LY in P..AB, separator AC, variance AD..AP.
    expect(ws.getCell(5, 1).value).toBe("Line");
    expect(ws.getCell(5, 2).value).toBe("Budget 2027");
    expect(ws.getCell(6, 2).value).toBe("Jan");
    expect(ws.getCell(6, 14).value).toBe("Total");
    expect(ws.getCell(5, 16).value).toBe("LY 2026");
    expect(ws.getCell(5, 30).value).toBe("vs LY");
    expect(ws.getColumn(15).width).toBe(2);

    // Body.
    const first = HEADER_ROWS + 1;
    expect(ws.getCell(first, 1).value).toBe("PAYROLL");
    expect(ws.getCell(first + 1, 1).value).toBe("Total Payroll");
    expect(ws.getCell(first + 1, 2).value).toBe(1000);
    expect(ws.getCell(first + 1, 14).value).toBe(12000);
    expect(ws.getCell(first + 1, 2).numFmt).toBe('#,##0;-#,##0;"–"');
    expect(ws.getCell(first + 2, 2).numFmt).toBe('0.0"%";-0.0"%";"–"');
    // The variance of the percent row is in points; of the cost row a percentage.
    expect(ws.getCell(first + 1, 30).numFmt).toBe('0.0"%";-0.0"%";"–"');
    expect(ws.getCell(first + 2, 30).numFmt).toBe('0.0" pts";-0.0" pts";"–"');
    // A cost that rose is unfavourable.
    expect(ws.getCell(first + 1, 30).font?.color?.argb).toBe("FFB91C1C");
    expect(ws.getCell(first + 2, 30).font?.color?.argb).toBe("FF15803D");
    expect(ws.getRow(first + 3).height).toBe(8);

    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 1, ySplit: HEADER_ROWS });
  });

  it("collapses to one Total column per group when months are off", async () => {
    const wb = await roundTrip(buildReportWorkbook(response("bst"), { ...META, months: false }));
    const ws = wb.getWorksheet("Summary P&L")!;
    expect(ws.getCell(6, 2).value).toBe("Total");
    expect(ws.getCell(5, 4).value).toBe("LY 2026"); // B, sep C, D
    expect(ws.getCell(HEADER_ROWS + 2, 2).value).toBe(12000);
  });

  it("shows money in thousands through the number format, leaving values and other formats alone", async () => {
    const wb = await roundTrip(buildReportWorkbook(response("bst"), { ...META, thousands: true }));
    const ws = wb.getWorksheet("Summary P&L")!;
    const first = HEADER_ROWS + 1;
    expect(ws.getCell("A2").value).toBe("Test Hotel · Planning 2027 · Amounts in 000's except ratios & stats");
    expect(ws.getCell(first + 1, 2).value).toBe(1000);
    expect(ws.getCell(first + 1, 2).numFmt).toBe('#,##0,;-#,##0,;"–"');
    expect(ws.getCell(first + 2, 2).numFmt).toBe('0.0"%";-0.0"%";"–"');
    expect(ws.getCell(first + 1, 30).numFmt).toBe('0.0"%";-0.0"%";"–"');
  });

  it("brands a workbook that includes unpushed plan data, on the sheet and in the file name", async () => {
    const wb = await roundTrip(buildReportWorkbook(response("plan"), META));
    const ws = wb.getWorksheet("Summary P&L")!;
    expect(ws.getCell("A4").value).toBe(UNPUSHED_WARNING);
    expect(ws.getCell("A4").font?.color?.argb).toBe("FFB91C1C");
    expect(suggestedFileName(META, true)).toBe("Test_Hotel_Summary_P_L_Planning_2027_2026-09-09_UNPUSHED.xlsx");
    expect(suggestedFileName(META, false)).toBe("Test_Hotel_Summary_P_L_Planning_2027_2026-09-09.xlsx");
  });

  it("writes a Sources sheet naming each column's provenance", async () => {
    const wb = await roundTrip(buildReportWorkbook(response("bst"), META));
    const ws = wb.getWorksheet("Sources")!;
    expect(ws.getCell(5, 1).value).toBe("Column");
    expect(ws.getCell(6, 1).value).toBe("budget");
    expect(String(ws.getCell(6, 3).value)).toMatch(/^BST: BUDGET 2027/);
    expect(ws.getCell(6, 6).value).toBe("no");
    expect(ws.getCell(6, 7).value).toBe("1 changed, 0 not in BST, 0 to clear");
    expect(String(ws.getCell(8, 3).value)).toMatch(/^pct variance/);
    expect(ws.getCell(8, 5).value).toBeNull();
  });
});

describe("sanitizeSheetName", () => {
  it("strips forbidden characters, caps at 31 and de-duplicates", () => {
    expect(sanitizeSheetName("Rooms / F&B: [Q1]*?")).toBe("Rooms F&B Q1");
    expect(sanitizeSheetName("x".repeat(40))).toHaveLength(31);
    const taken = new Set(["Summary"]);
    expect(sanitizeSheetName("Summary", taken)).toBe("Summary (2)");
    expect(sanitizeSheetName("", taken)).toBe("Sheet");
  });
});
