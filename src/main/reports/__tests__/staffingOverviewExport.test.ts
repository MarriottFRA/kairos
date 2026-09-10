/**
 * The staffing overview workbook, read back: the group band, a row per
 * title with its head count and FTE cells, the group total, the hotel
 * total, the compared scenario's columns and coloured variances.
 */

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { StaffingCells, StaffingOverviewResponse, emptyCells } from "../../../shared/reports/staffingOverview";
import { HEADER_ROWS } from "../excel/writeGrid";
import { buildStaffingOverviewWorkbook } from "../staffingOverviewExport";

const cells = (partial: Partial<StaffingCells["hc"]>, fte: Partial<StaffingCells["fte"]> = partial): StaffingCells => {
  const out = emptyCells();
  Object.assign(out.hc, partial);
  Object.assign(out.fte, fte);
  return out;
};

const RESPONSE: StaffingOverviewResponse = {
  scenarioId: "s1",
  year: 2027,
  run: { computedAt: "2026-09-09T10:00:00.000Z", stale: false },
  basis: "accounts",
  titleMode: "title",
  weeklyHours: null,
  warnings: [],
  groups: [
    {
      label: "Rooms and Reservation",
      rows: [
        { title: "Attendant", cells: cells({ assoc: 4 }, { assoc: 3.5 }), compare: cells({ assoc: 3 }), variance: cells({ assoc: 1 }, { assoc: 0.5 }) },
        { title: "Manager", cells: cells({ mgr: 1 }), compare: cells({ mgr: 2 }), variance: cells({ mgr: -1 }) },
      ],
      totals: cells({ assoc: 4, mgr: 1 }, { assoc: 3.5, mgr: 1 }),
      compareTotals: cells({ assoc: 3, mgr: 2 }),
      varianceTotals: cells({ assoc: 1, mgr: -1 }, { assoc: 0.5, mgr: -1 }),
    },
  ],
  totals: cells({ assoc: 4, mgr: 1 }, { assoc: 3.5, mgr: 1 }),
  compareTotals: cells({ assoc: 3, mgr: 2 }),
  varianceTotals: cells({ assoc: 1, mgr: -1 }, { assoc: 0.5, mgr: -1 }),
  compare: { scenarioId: "s0", year: 2026, run: null },
  unmappedDepartments: [],
};

describe("buildStaffingOverviewWorkbook", () => {
  it("writes the groups, titles, totals and coloured variances", async () => {
    const wb = buildStaffingOverviewWorkbook(RESPONSE, {
      hotelName: "Test Hotel",
      scenarioLabel: "Planning 2027",
      compareLabel: "Last year 2026",
      generatedAt: new Date("2026-09-09T10:00:00.000Z"),
    });
    const buffer = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buffer as never);
    expect(back.worksheets.map((s) => s.name)).toEqual(["Staffing overview"]);
    const ws = back.getWorksheet("Staffing overview")!;
    expect(ws.getCell("A1").value).toBe("Staffing overview — head count and FTE per department group, from the accounts");
    expect(ws.getCell("A2").value).toBe("Test Hotel · Planning 2027 vs Last year 2026");

    // Column groups of one Total each, separated: budget HC ×4 (B, D, F, H), budget FTE ×4 (J, L, N, P),
    // compare HC ×4 (R, T, V, X), compare FTE ×4 (Z, AB, AD, AF), variance HC ×4 (AH, AJ, AL, AN) …
    expect(ws.getCell(5, 2).value).toBe("Planning 2027 · Mgr HC");
    expect(ws.getCell(5, 6).value).toBe("Planning 2027 · Non-Mgr HC");
    expect(ws.getCell(5, 10).value).toBe("Planning 2027 · Mgr FTE");
    expect(ws.getCell(5, 18).value).toBe("Last year 2026 · Mgr HC");
    expect(ws.getCell(5, 34).value).toBe("Variance · Mgr HC");

    const first = HEADER_ROWS + 1;
    expect(ws.getCell(first, 1).value).toBe("ROOMS AND RESERVATION");
    expect(ws.getCell(first + 1, 1).value).toBe("Attendant");
    expect(ws.getCell(first + 1, 6).value).toBe(4);
    expect(ws.getCell(first + 1, 14).value).toBe(3.5);
    expect(ws.getCell(first + 1, 14).numFmt).toBe('#,##0.00;-#,##0.00;"–"');
    expect(ws.getCell(first + 1, 22).value).toBe(3);
    expect(ws.getCell(first + 1, 38).value).toBe(1);
    // One more head is a cost that rose: unfavourable; one fewer manager: favourable.
    expect(ws.getCell(first + 1, 38).font?.color?.argb).toBe("FFB91C1C");
    expect(ws.getCell(first + 2, 34).value).toBe(-1);
    expect(ws.getCell(first + 2, 34).font?.color?.argb).toBe("FF15803D");
    expect(ws.getCell(first + 3, 1).value).toBe("Total Rooms and Reservation");
    expect(ws.getCell(first + 3, 6).value).toBe(4);
    expect(ws.getCell(first + 4, 1).value).toBe("TOTAL HOTEL");
    expect(ws.getCell(first + 4, 2).value).toBe(1);
  });

  it("writes the budget columns alone without a comparison", async () => {
    const wb = buildStaffingOverviewWorkbook(
      { ...RESPONSE, basis: "positions", compare: null, compareTotals: null, varianceTotals: null },
      { hotelName: "Test Hotel", scenarioLabel: "Planning 2027", generatedAt: new Date("2026-09-09T10:00:00.000Z") }
    );
    const ws = wb.getWorksheet("Staffing overview")!;
    expect(ws.getCell("A1").value).toBe("Staffing overview — head count and FTE per department group, from the positions");
    expect(ws.getCell(5, 18).value).toBeNull();
    expect(ws.getCell("A2").value).toBe("Test Hotel · Planning 2027");
  });
});
