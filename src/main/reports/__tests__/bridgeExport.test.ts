/**
 * The bridge workbook, read back: a summary sheet with one row per
 * department plus the hotel, the bucket columns that are in use, the BST
 * figure and the difference; then a sheet per department with positions,
 * other sources and the department total.
 */

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { BridgeCell, PositionBridgeResponse } from "../../../shared/reports/bridge";
import { HEADER_ROWS } from "../excel/writeGrid";
import { buildBridgeWorkbook } from "../bridgeExport";

const cell = (account: string, bucket: BridgeCell["bucket"], total: number): BridgeCell => ({
  account,
  bucket,
  months: new Array(12).fill(total / 12),
  total,
  encoding: "AMOUNT",
});

const RESPONSE: PositionBridgeResponse = {
  scenarioId: "s1",
  year: 2027,
  run: { computedAt: "2026-09-09T10:00:00.000Z", stale: false },
  departments: [
    {
      code: "0410",
      name: "Admin",
      rows: [
        {
          key: "0410|pos:p1",
          source: "ENGINE",
          positionId: "p1",
          lineageId: "p1",
          title: "Finance Manager",
          jobTypeCode: "Manager",
          payType: "SALARIED",
          headcount: 2,
          fte: 2,
          clusterName: null,
          active: true,
          deleted: false,
          label: "Finance Manager",
          cells: [cell("511000", "management_salaries", 72000), cell("988308", "hours", 4000)],
          lines: [],
        },
        {
          key: "0410|MANUAL:r1:Bonus pool",
          source: "MANUAL",
          positionId: null,
          lineageId: null,
          title: null,
          jobTypeCode: null,
          payType: null,
          headcount: null,
          fte: null,
          clusterName: null,
          active: true,
          deleted: false,
          label: "Manual: bonus pool",
          cells: [cell("530000", "bonus", 5000)],
          lines: [],
        },
      ],
      totals: [cell("511000", "management_salaries", 72000), cell("988308", "hours", 4000), cell("530000", "bonus", 5000)],
    },
  ],
  accounts: [],
  bst: { available: true, bucket: "BUDGET 2027", byDept: { "0410": { "511000": 60000, "530000": 5000 } } },
  compare: null,
};

describe("buildBridgeWorkbook", () => {
  it("writes a summary and a sheet per department that read back correctly", async () => {
    const wb = buildBridgeWorkbook(RESPONSE, {
      hotelName: "Test Hotel",
      scenarioLabel: "Planning 2027",
      generatedAt: new Date("2026-09-09T10:00:00.000Z"),
    });
    const buffer = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buffer as never);
    expect(back.worksheets.map((s) => s.name)).toEqual(["Payroll bridge", "0410 Admin"]);

    const summary = back.getWorksheet("Payroll bridge")!;
    // Columns: Line | Management salaries | sep | Bonus | sep | Hours | sep | Total payroll | sep | Heads | sep | FTE | sep | BST | sep | Plan − BST
    expect(summary.getCell(5, 2).value).toBe("Management salaries");
    expect(summary.getCell(5, 4).value).toBe("Bonus");
    expect(summary.getCell(5, 6).value).toBe("Hours");
    expect(summary.getCell(5, 8).value).toBe("Total payroll");
    expect(summary.getCell(5, 14).value).toBe("BST BUDGET 2027");
    const hotel = HEADER_ROWS + 1;
    expect(summary.getCell(hotel, 1).value).toBe("Hotel");
    expect(summary.getCell(hotel, 8).value).toBe(77000);
    expect(summary.getCell(hotel, 10).value).toBe(2);
    expect(summary.getCell(hotel, 14).value).toBe(65000);
    expect(summary.getCell(hotel, 16).value).toBe(12000);
    expect(summary.getCell(hotel + 1, 1).value).toBe("0410 · Admin");

    const admin = back.getWorksheet("0410 Admin")!;
    const first = HEADER_ROWS + 1;
    expect(admin.getCell(first, 1).value).toBe("POSITIONS");
    expect(admin.getCell(first + 1, 1).value).toBe("Finance Manager · Manager");
    expect(admin.getCell(first + 1, 8).value).toBe(72000);
    expect(admin.getCell(first + 2, 1).value).toBe("OTHER SOURCES");
    expect(admin.getCell(first + 3, 1).value).toBe("MANUAL: Manual: bonus pool");
    expect(admin.getCell(first + 4, 1).value).toBe("Department total");
    expect(admin.getCell(first + 4, 8).value).toBe(77000);
  });
});
