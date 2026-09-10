/**
 * The staffing statistics workbook: the hotel on top then groups and their
 * departments, a note on a flagged cell, every position on a filterable
 * sheet, and the grade-mixing sheet only when something is flagged.
 */

import { describe, expect, it } from "vitest";
import { packLabelsOf } from "../../../shared/reports/packs";
import { MapRowInput, buildMapIndex } from "../../../shared/reports/sources";
import {
  StaffingStatisticsResponse,
  StaffingStatsLine,
  buildStaffingStatistics,
} from "../../../shared/reports/staffingStatistics";
import { HEADER_ROWS } from "../excel/writeGrid";
import { buildStaffingStatisticsWorkbook } from "../staffingStatisticsExport";

const levels = (entries: Record<number, string>) => Array.from({ length: 31 }, (_, i) => entries[i] ?? null);
const LABELS = packLabelsOf(
  buildMapIndex(
    "maps-1",
    [{ code: "D0100", name: "Rooms", levels: levels({ 7: "Rooms and Reservation", 10: "Rooms" }) }],
    [
      {
        code: "A988699",
        name: "988699 - Staff hours",
        levels: levels({ 4: "Total Manhours", 6: "Total Manhours excl Overtime and Manager Hours", 9: "Man Hours" }),
      },
    ] as MapRowInput[]
  )
);

const flat = (value: number) => new Array(12).fill(value);
const pos = (id: string, jobTypeCode: string) => ({ id, title: `${jobTypeCode} post`, jobTypeCode, deleted: false });
const line = (account: string, months: number[], position: StaffingStatsLine["position"], encoding: "LEVEL" | "AMOUNT" = "AMOUNT"): StaffingStatsLine => ({
  dept: "D0100",
  account,
  months,
  encoding,
  position,
  sourceLabel: "Manual input",
});

function response(mixed: boolean): StaffingStatisticsResponse {
  const lines = [
    line("A972540", [1, ...new Array(11).fill(0)], pos("a", "Associate"), "LEVEL"),
    line("A988699", flat(150), pos("a", "Associate")),
    line("A972540", [1, ...new Array(11).fill(0)], pos("s", mixed ? "Supervisor" : "Associate"), "LEVEL"),
    line("A988699", flat(100), pos("s", mixed ? "Supervisor" : "Associate")),
  ];
  return {
    scenarioId: "s1",
    year: 2027,
    run: null,
    weeklyHours: { value: 36, origin: "column" },
    fteHours: [...new Array(12).fill(156), 1872],
    groupLevel: 10,
    warnings: [],
    ...buildStaffingStatistics(lines, [...new Array(12).fill(156), 1872], LABELS),
  };
}

const META = { hotelName: "Test Hotel", scenarioLabel: "Planning 2027", generatedAt: new Date("2026-09-10T00:00:00Z"), slot: 12 };

describe("buildStaffingStatisticsWorkbook", () => {
  it("writes the hotel, the group and its department, with a note where grades share an account", () => {
    const wb = buildStaffingStatisticsWorkbook(response(true), META);
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Staffing statistics", "Positions", "Grade mixing"]);

    const ws = wb.getWorksheet("Staffing statistics")!;
    const first = HEADER_ROWS + 1;
    expect(ws.getCell(first, 1).value).toBe("TOTAL HOTEL");
    expect(ws.getCell(first, 2).value).toBe(2); // heads at year end
    expect(ws.getCell(first, 10).value).toBe(3000); // hours · total
    // Spacer, group, department.
    expect(ws.getCell(first + 2, 1).value).toBe("Rooms");
    expect(ws.getCell(first + 3, 1).value).toBe("0100 · Rooms");
    const accountCol = 2 + 5 * 2; // the first account column, after heads, three FTE and total hours
    expect(ws.getCell(5, accountCol).value).toMatch(/988699 Staff hours/);
    expect(String(ws.getCell(first + 3, accountCol).note)).toMatch(/Supervisors 1,200 h · Associates 1,800 h/);

    const positions = wb.getWorksheet("Positions")!;
    expect(positions.getCell(5, 4).value).toBe("Supervisor post");
    expect(positions.getCell(6, 4).value).toBe("Associate post");
    expect(positions.getCell(6, 5).value).toBe("Associate");

    const mix = wb.getWorksheet("Grade mixing")!;
    expect(mix.getCell(5, 4).value).toBe("988699");
  });

  it("leaves the grade-mixing sheet out when nothing is flagged, and writes the month asked for", () => {
    const wb = buildStaffingStatisticsWorkbook(response(false), { ...META, slot: 0 });
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Staffing statistics", "Positions"]);
    const ws = wb.getWorksheet("Staffing statistics")!;
    expect(String(ws.getCell(2, 1).value)).toMatch(/· Jan ·/);
    expect(ws.getCell(HEADER_ROWS + 1, 10).value).toBe(250); // January's hours
  });
});
