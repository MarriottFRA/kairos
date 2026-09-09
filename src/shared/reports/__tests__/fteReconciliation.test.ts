/**
 * The FTE reconciliation from literals: the generated definition is valid
 * and reads manager heads as a level's mean plus staff hours over the work
 * week × 52 (overtime, manager and buyout hours left out); the grid side
 * splits managers from the rest, weights by Count and cluster share and
 * leaves Buyout Labour out; the merge groups as the pack does, keeps a
 * department either side alone knows, and totals tie.
 */

import { describe, expect, it } from "vitest";
import { ACC } from "../catalog";
import { compileDefinition, validateDefinition } from "../compile";
import { evaluateReport } from "../engine";
import {
  aggregateGridFte,
  buildFteReconciliation,
  buildFteReconciliationDefinition,
  readAccountSides,
  readFteHoursYear,
} from "../fteReconciliation";
import { UNMAPPED_GROUP } from "../packs";
import { buildMapIndex, buildValueSource } from "../sources";

const flat = (value: number) => new Array(12).fill(value);
const levels = (entries: Record<number, string>) => Array.from({ length: 31 }, (_, i) => entries[i] ?? null);

const MAPS = buildMapIndex(
  "v1",
  [
    { code: "D0010", name: "Rooms", levels: levels({ 7: "Rooms and Reservation" }) },
    { code: "D0410", name: "Admin", levels: levels({ 7: "Administrative & General" }) },
  ],
  [
    { code: "A988101", name: "Managers", levels: levels({ 1: ACC.statistics }) },
    { code: "A988113", name: "Non-exempt managers", levels: levels({ 1: ACC.statistics }) },
    { code: "A988699", name: "Staff hours", levels: levels({ 1: ACC.statistics, 4: ACC.totalManhours, 6: ACC.manhoursExclOvertimeAndManagers, 9: ACC.manHours }) },
    { code: "A988308", name: "Manager hours", levels: levels({ 1: ACC.statistics, 4: ACC.totalManhours, 6: "Non Prod Hours" }) },
    { code: "A988306", name: "Overtime", levels: levels({ 1: ACC.statistics, 4: ACC.totalManhours, 6: "Total Manhours - Overtime", 9: ACC.manHours }) },
    { code: "A988205", name: "Buyout hours", levels: levels({ 1: ACC.statistics, 4: ACC.totalManhours, 6: ACC.manhoursExclOvertimeAndManagers, 9: "Buyout Manhours" }) },
  ]
);

const SOURCE = buildValueSource("kairos", [
  // Two managers all year and one non-exempt manager from July.
  { dept: "D0410", account: "A988101", months: [2, ...flat(0).slice(1)], total: 2, encoding: "LEVEL" },
  { dept: "D0410", account: "A988113", months: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], total: 1, encoding: "LEVEL" },
  { dept: "D0410", account: "A988699", months: flat(173.3333333) }, // one full-timer at 40h
  { dept: "D0410", account: "A988308", months: flat(400) }, // manager hours: not FTE
  { dept: "D0410", account: "A988306", months: flat(50) }, // overtime: not FTE
  { dept: "D0010", account: "A988699", months: flat(346.6666667) }, // two full-timers
  { dept: "D0010", account: "A988205", months: flat(1000) }, // bought in: not FTE
  { dept: "D0999", account: "A988699", months: flat(86.6666667) }, // results only, unmapped
]);

describe("buildFteReconciliationDefinition", () => {
  it("is valid, plain data, and reads heads as a mean plus staff hours over the week × 52", () => {
    const definition = buildFteReconciliationDefinition(["D0410", "0410", "D0010", "D0999"]);
    expect(validateDefinition(definition)).toEqual([]);
    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
    expect(definition.atoms.map((a) => a.id)).toEqual(["d_0410_mgr", "d_0410_hrs", "d_0010_mgr", "d_0010_hrs", "d_0999_mgr", "d_0999_hrs"]);

    const report = evaluateReport(compileDefinition(definition), {
      getSource: () => SOURCE,
      maps: MAPS,
      getParam: (p) => (p.builtin === "weekly_hours" ? { months: flat(40), total: 40 } : null),
    });
    expect(report.warnings).toEqual([]);
    expect(readFteHoursYear(report)).toBe(2080);

    const sides = readAccountSides(["D0410", "D0010", "D0999", "D0777"], report);
    const admin = sides.get("0410")!;
    expect(admin.managerHeads).toBeCloseTo(2 + 0.5); // two all year, one for six months
    expect(admin.hours).toBeCloseTo(2080);
    expect(admin.hoursFte).toBeCloseTo(1);
    expect(admin.total).toBeCloseTo(3.5);
    const rooms = sides.get("0010")!;
    expect(rooms.managerHeads).toBe(0);
    expect(rooms.hours).toBeCloseTo(4160); // the buyout hours are not in it
    expect(rooms.total).toBeCloseTo(2);
    expect(sides.get("0999")!.total).toBeCloseTo(0.5);
    expect(sides.get("0777")).toEqual({ managerHeads: 0, hours: 0, hoursFte: 0, total: 0 });
  });
});

describe("aggregateGridFte", () => {
  it("splits the manager grades from the rest, weights by Count and cluster share, and leaves Buyout Labour out", () => {
    const grid = aggregateGridFte([
      { departmentCode: "D0410", jobTypeCode: "Manager", headcount: 2, fte: 1, hotelClusterWeight: 1 },
      { departmentCode: "D0410", jobTypeCode: "Manager (Non Exempt)", headcount: 1, fte: 0.5, hotelClusterWeight: 1 },
      { departmentCode: "D0410", jobTypeCode: "Associate", headcount: 1, fte: 1, hotelClusterWeight: 0.5 },
      { departmentCode: "0410", jobTypeCode: "Supervisor", headcount: 1, fte: 0.8, hotelClusterWeight: 1 },
      { departmentCode: "D0010", jobTypeCode: "Casual", headcount: 3, fte: 0.25, hotelClusterWeight: 1 },
      { departmentCode: "D0010", jobTypeCode: "Buyout Labour", headcount: 4, fte: 1, hotelClusterWeight: 1 },
    ]);
    expect(grid.get("0410")).toEqual({ managers: 2.5, others: 1.3, total: 3.8, heads: 5 });
    expect(grid.get("0010")).toEqual({ managers: 0, others: 0.75, total: 0.75, heads: 3 });
  });
});

describe("buildFteReconciliation", () => {
  it("groups as the pack does, keeps a department either side alone knows, and totals tie", () => {
    const grid = aggregateGridFte([
      { departmentCode: "D0410", jobTypeCode: "Manager", headcount: 2, fte: 1, hotelClusterWeight: 1 },
      { departmentCode: "D0410", jobTypeCode: "Associate", headcount: 1, fte: 0.9, hotelClusterWeight: 1 },
      { departmentCode: "D0555", jobTypeCode: "Associate", headcount: 1, fte: 1, hotelClusterWeight: 1 }, // positions only
    ]);
    const accounts = new Map([
      ["0410", { managerHeads: 2, hours: 2080, hoursFte: 1, total: 3 }],
      ["0010", { managerHeads: 0, hours: 4160, hoursFte: 2, total: 2 }], // results only
    ]);
    const groupOf: Record<string, string> = { "0410": "Administrative & General", "0010": "Rooms and Reservation" };
    const built = buildFteReconciliation(
      grid,
      accounts,
      (dept) => ({ "0410": "Admin", "0010": "Rooms" })[dept] ?? null,
      (dept) => groupOf[dept] ?? UNMAPPED_GROUP
    );
    expect(built.groups.map((g) => g.label)).toEqual(["Rooms and Reservation", "Administrative & General", UNMAPPED_GROUP]);
    const admin = built.groups[1].rows[0];
    expect(admin).toMatchObject({ dept: "0410", name: "Admin", variance: 3 - 2.9 });
    expect(built.groups[0].rows[0]).toMatchObject({ dept: "0010", name: "Rooms", grid: { total: 0, heads: 0 }, accounts: { total: 2 }, variance: 2 });
    expect(built.groups[2].rows[0]).toMatchObject({ dept: "0555", name: "0555", grid: { total: 1 }, accounts: { total: 0 }, variance: -1 });
    expect(built.totals.grid.total).toBeCloseTo(3.9);
    expect(built.totals.accounts.total).toBe(5);
    expect(built.totals.variance).toBeCloseTo(5 - 3.9);
    expect(built.totals.grid.heads).toBe(4);
  });
});
