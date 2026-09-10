/**
 * The bridge workbook, read back: the account matrix at full depth with the
 * columns below the chosen depth hidden under Excel outline groups, then
 * total payroll, heads, FTE, the statistic accounts, the BST figure and the
 * difference; then a sheet per department with positions, other sources and
 * the department total.
 */

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { BridgeAccount, BridgeCell, BridgeRow, PositionBridgeResponse } from "../../../shared/reports/bridge";
import { HEADER_ROWS } from "../excel/writeGrid";
import { buildBridgeWorkbook } from "../bridgeExport";

const cell = (account: string, bucket: BridgeCell["bucket"], total: number): BridgeCell => ({
  account,
  bucket,
  months: new Array(12).fill(total / 12),
  total,
  encoding: "AMOUNT",
});

const AW = { level: 12, label: "Associate Wages" };
const WS = { level: 14, label: "Wages & Salaries" };
const ACCOUNTS: BridgeAccount[] = [
  { code: "511000", name: "Mgmt salaries", bucket: "payroll", path: [AW, WS, { level: 18, label: "Mgmt Salaries" }] },
  { code: "512000", name: "Hourly", bucket: "payroll", path: [AW, WS, { level: 18, label: "Total Hourly Wages excl Overtime" }] },
  { code: "530000", name: "Bonus", bucket: "payroll", path: [AW, { level: 14, label: "Bonus Accrual Expense" }] },
  { code: "988308", name: "Hours", bucket: "hours", path: [] },
];

const position = (over: Partial<BridgeRow>): BridgeRow => ({
  key: "k",
  source: "ENGINE",
  positionId: "p",
  lineageId: "p",
  title: null,
  jobTypeCode: "Associate",
  payType: "HOURLY",
  headcount: 1,
  fte: 1,
  clusterName: null,
  active: true,
  deleted: false,
  label: "",
  cells: [],
  lines: [],
  ...over,
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
        position({
          key: "0410|pos:p1",
          positionId: "p1",
          title: "Finance Manager",
          jobTypeCode: "Manager",
          payType: "SALARIED",
          headcount: 2,
          fte: 2,
          label: "Finance Manager",
          cells: [cell("511000", "payroll", 72000), cell("988308", "hours", 4000)],
        }),
        position({ key: "0410|pos:p2", positionId: "p2", label: "Clerk", cells: [cell("512000", "payroll", 10000)] }),
        position({
          key: "0410|MANUAL:r1:Bonus pool",
          source: "MANUAL",
          positionId: null,
          lineageId: null,
          jobTypeCode: null,
          payType: null,
          headcount: null,
          fte: null,
          label: "Manual: bonus pool",
          cells: [cell("530000", "payroll", 5000)],
        }),
      ],
      totals: [
        cell("511000", "payroll", 72000),
        cell("988308", "hours", 4000),
        cell("512000", "payroll", 10000),
        cell("530000", "payroll", 5000),
      ],
    },
  ],
  accounts: ACCOUNTS,
  bst: { available: true, bucket: "BUDGET 2027", byDept: { "0410": { "511000": 60000, "530000": 5000 } } },
  compare: null,
};

async function readBack(depth?: number) {
  const wb = buildBridgeWorkbook(RESPONSE, {
    hotelName: "Test Hotel",
    scenarioLabel: "Planning 2027",
    generatedAt: new Date("2026-09-09T10:00:00.000Z"),
    depth,
  });
  const buffer = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buffer as never);
  return back;
}

describe("buildBridgeWorkbook", () => {
  it("writes the full account tree as outline groups, open at L14 by default", async () => {
    const back = await readBack();
    expect(back.worksheets.map((s) => s.name)).toEqual(["Payroll bridge", "0410 Admin"]);

    const summary = back.getWorksheet("Payroll bridge")!;
    // Line | Mgmt Salaries | Total Hourly… | Total W&S | Bonus Accrual | Total AW | Total payroll | Heads | FTE | Hours | BST | Plan − BST
    const headers = Array.from({ length: 11 }, (_, i) => summary.getCell(5, i + 2).value);
    expect(headers).toEqual([
      "Mgmt Salaries",
      "Total Hourly Wages excl Overtime",
      "Total Wages & Salaries",
      "Bonus Accrual Expense",
      "Total Associate Wages",
      "Total payroll",
      "Heads",
      "FTE",
      "Hours",
      "BST BUDGET 2027",
      "Plan − BST",
    ]);
    expect(summary.getCell(6, 2).value).toBe("511000");
    expect(summary.getCell(6, 4).value).toBe("Subtotal");
    // L18 detail is in the file, folded under Wages & Salaries.
    expect([2, 3, 4, 5, 6].map((c) => summary.getColumn(c).outlineLevel)).toEqual([2, 2, 1, 1, 0]);
    expect([2, 3, 4, 5, 6, 7].map((c) => !!summary.getColumn(c).hidden)).toEqual([true, true, false, false, false, false]);

    const hotel = HEADER_ROWS + 1;
    expect(summary.getCell(hotel, 1).value).toBe("Hotel");
    expect(summary.getCell(hotel, 2).value).toBe(72000);
    expect(summary.getCell(hotel, 4).value).toBe(82000);
    expect(summary.getCell(hotel, 6).value).toBe(87000);
    expect(summary.getCell(hotel, 7).value).toBe(87000);
    expect(summary.getCell(hotel, 8).value).toBe(3);
    expect(summary.getCell(hotel, 10).value).toBe(4000);
    expect(summary.getCell(hotel, 11).value).toBe(65000);
    expect(summary.getCell(hotel, 12).value).toBe(22000);
    expect(summary.getCell(hotel + 1, 1).value).toBe("0410 · Admin");

    const admin = back.getWorksheet("0410 Admin")!;
    const first = HEADER_ROWS + 1;
    expect(admin.getCell(first, 1).value).toBe("POSITIONS");
    expect(admin.getCell(first + 1, 1).value).toBe("Finance Manager · Manager");
    expect(admin.getCell(first + 1, 2).value).toBe(72000);
    expect(admin.getCell(first + 1, 7).value).toBe(72000);
    expect(admin.getCell(first + 2, 3).value).toBe(10000);
    expect(admin.getCell(first + 3, 1).value).toBe("OTHER SOURCES");
    expect(admin.getCell(first + 4, 1).value).toBe("MANUAL: Manual: bonus pool");
    expect(admin.getCell(first + 4, 5).value).toBe(5000);
    expect(admin.getCell(first + 5, 1).value).toBe("Department total");
    expect(admin.getCell(first + 5, 7).value).toBe(87000);
  });

  it("opens at the depth the page was showing", async () => {
    const summary = (await readBack(12)).getWorksheet("Payroll bridge")!;
    expect([2, 3, 4, 5, 6].map((c) => !!summary.getColumn(c).hidden)).toEqual([true, true, true, true, false]);
    const deep = (await readBack(99)).getWorksheet("Payroll bridge")!;
    expect([2, 3, 4, 5, 6].map((c) => !!deep.getColumn(c).hidden)).toEqual([false, false, false, false, false]);
  });
});
