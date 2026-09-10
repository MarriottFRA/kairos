/**
 * The staffing statistics build over literal lines: which accounts count as
 * what, level-10 grouping (with its level-7 fallback and name clashes), the
 * LEVEL reading of heads, FTE, the tree, and the grade-mix flags.
 */

import { describe, expect, it } from "vitest";
import { UNMAPPED_GROUP, packLabelsOf } from "../packs";
import { MapRowInput, buildMapIndex } from "../sources";
import {
  StaffingStatsLine,
  StaffingStatsNode,
  buildStaffingStatistics,
  classifyStaffingAccount,
  describeMix,
  hoursOfKind,
  shortAccountName,
  tierOf,
} from "../staffingStatistics";

const levels = (entries: Record<number, string>) => Array.from({ length: 31 }, (_, i) => entries[i] ?? null);
const row = (code: string, name: string, entries: Record<number, string>): MapRowInput => ({ code, name, levels: levels(entries) });

const HOURS = { 1: "Statistics", 4: "Total Manhours" };
const ACCOUNTS: MapRowInput[] = [
  row("A988699", "988699 - Staff hours", { ...HOURS, 6: "Total Manhours excl Overtime and Manager Hours", 9: "Man Hours" }),
  row("A988307", "988307 - Overtime Hours for Associates", { ...HOURS, 6: "Total Manhours - Overtime", 9: "Man Hours" }),
  row("A988308", "988308 - Manager Hours", { ...HOURS, 6: "Non Prod Hours" }),
  row("A988201", "988201 - Buyout Labour Hours", { ...HOURS, 6: "Total Manhours excl Overtime and Manager Hours", 9: "Buyout Manhours" }),
  row("A988101", "988101 - Number Of Managers", { 1: "Statistics", 4: "Number Of Managers" }),
  row("A988112", "988112 - Standard work week hours", { 1: "Statistics", 4: "Other Stats4" }),
  row("A988110", "988110 - Casual FTE", { 1: "Statistics", 4: "Other Stats3" }),
  row("A511000", "511000 - Salaries", { 9: "Total Payroll" }),
];
const DEPARTMENTS: MapRowInput[] = [
  row("D0100", "Rooms", { 7: "Rooms and Reservation", 10: "Rooms" }),
  row("D0200", "Marina", { 7: "Other Operated Departments", 10: "Other Profit Departments" }),
  row("D0300", "Payroll allocation", { 7: "Payroll Cost Allocation", 10: "Other Profit Departments" }),
  row("D0400", "Engineering", { 7: "Property Operation & Maintenance" }),
];
const LABELS = packLabelsOf(buildMapIndex("maps-1", DEPARTMENTS, ACCOUNTS));
const UNAVAILABLE = packLabelsOf(buildMapIndex(null, [], []));

/** 156 hours a month, 1,872 a year: a 36h effective week. */
const FTE_HOURS = [...new Array(12).fill(156), 1872];

const flat = (value: number) => new Array(12).fill(value);
const firstMonths = (value: number, count: number) => Array.from({ length: 12 }, (_, m) => (m < count ? value : 0));
/** A level as the projection stores it: January's value, then the changes. */
const deltas = (monthly: number[]) => monthly.map((value, m) => value - (m === 0 ? 0 : monthly[m - 1]));

const position = (id: string, jobTypeCode: string, title = jobTypeCode) => ({ id, title, jobTypeCode, deleted: false });

function line(dept: string, account: string, months: number[], pos: StaffingStatsLine["position"], encoding: "LEVEL" | "AMOUNT" = "AMOUNT"): StaffingStatsLine {
  return { dept, account, months, encoding, position: pos, sourceLabel: "Manual input" };
}

const heads = (dept: string, pos: StaffingStatsLine["position"], monthly = flat(1)) =>
  line(dept, "A972540", deltas(monthly), pos, "LEVEL");

function find(node: StaffingStatsNode, id: string): StaffingStatsNode {
  if (node.id === id) return node;
  for (const child of node.children) {
    try {
      return find(child, id);
    } catch {
      // keep looking
    }
  }
  throw new Error(`no node ${id}`);
}

describe("classifyStaffingAccount", () => {
  it("reads heads, manager heads and the kinds of hours off the maps", () => {
    const kindOf = (code: string) => classifyStaffingAccount(code, LABELS);
    expect(kindOf("A972540")).toEqual({ role: "heads" });
    expect(kindOf("A988101")).toEqual({ role: "managerHeads" });
    expect(kindOf("988113")).toEqual({ role: "managerHeads" });
    expect(kindOf("A988699")).toEqual({ role: "hours", kind: "fte" });
    expect(kindOf("A988307")).toEqual({ role: "hours", kind: "overtime" });
    expect(kindOf("A988308")).toEqual({ role: "hours", kind: "manager" });
    expect(kindOf("A988201")).toEqual({ role: "hours", kind: "buyout" });
    // Mapped as something other than hours, or the work week: ignored.
    expect(kindOf("A988112")).toBeNull();
    expect(kindOf("A988110")).toBeNull();
    expect(kindOf("A511000")).toBeNull();
    // Unmapped A988: hours, never FTE.
    expect(kindOf("A988555")).toEqual({ role: "hours", kind: "other" });
    expect(kindOf("A512000")).toBeNull();
  });

  it("still finds heads and hours without the maps, but nothing drives FTE", () => {
    expect(classifyStaffingAccount("A972540", UNAVAILABLE)).toEqual({ role: "heads" });
    expect(classifyStaffingAccount("A988699", UNAVAILABLE)).toEqual({ role: "hours", kind: "other" });
    expect(classifyStaffingAccount("A988112", UNAVAILABLE)).toBeNull();
    // The supervisor head count is heads, not hours, whether or not it is mapped.
    expect(classifyStaffingAccount("A988102", UNAVAILABLE)).toBeNull();
  });

  it("puts casuals with associates and leaves buyout labour out", () => {
    expect(tierOf("Casual")).toBe("assoc");
    expect(tierOf("")).toBe("assoc");
    expect(tierOf("Manager (Non Exempt)")).toBe("mgr");
    expect(tierOf("Supervisor")).toBe("svsr");
    expect(tierOf("Buyout Labour")).toBeNull();
  });
});

describe("buildStaffingStatistics", () => {
  const supervisor = position("sv", "Supervisor", "Front Office Supervisor");
  const agent = position("ag", "Associate", "Front Desk Agent");
  const manager = position("mg", "Manager", "Rooms Manager");

  const lines: StaffingStatsLine[] = [
    heads("D0100", manager),
    line("D0100", "A988101", deltas(flat(1)), manager, "LEVEL"),
    line("D0100", "A988308", flat(160), manager),
    heads("D0100", supervisor),
    line("D0100", "A988699", flat(100), supervisor),
    // The agent leaves at the end of June.
    heads("D0100", agent, firstMonths(1, 6)),
    line("D0100", "A988699", firstMonths(150, 6), agent),
    line("D0100", "A988307", firstMonths(10, 6), agent),
    // Manual hours: counted, but no grade.
    line("D0100", "A988699", flat(10), null),
    // Money and the work week: not the report's business.
    line("D0100", "A511000", flat(3000), manager),
    line("D0410", "A988112", deltas(flat(36)), null, "LEVEL"),
    // The two "Other Profit Departments", the level-7 fallback, the unmapped one.
    heads("D0200", position("m1", "Associate", "Deckhand")),
    heads("D0300", position("p1", "Associate", "Allocated")),
    heads("D0400", position("e1", "Associate", "Engineer")),
    heads("D0999", position("x1", "Associate", "Mystery")),
    // An account with nothing on it anywhere drops out of the columns.
    line("D0400", "A988201", flat(0), position("e1", "Associate", "Engineer")),
  ];
  const built = buildStaffingStatistics(lines, FTE_HOURS, LABELS);
  const rooms = find(built.hotel, "d:0100");

  it("reads heads as levels: the month's running sum, the year where it ends up", () => {
    expect(rooms.values.heads[0]).toBe(3);
    expect(rooms.values.heads[6]).toBe(2); // the agent is gone in July
    expect(rooms.values.heads[12]).toBe(2);
    expect(rooms.values.managerHeads[12]).toBe(1); // the mean level
  });

  it("derives FTE from manager heads plus the FTE-driving hours only", () => {
    const fteHours = 100 * 12 + 150 * 6 + 10 * 12; // supervisor + agent + manual
    expect(rooms.values.byAccount["988699"][12]).toBe(fteHours);
    expect(rooms.values.hoursFte[12]).toBeCloseTo(fteHours / 1872);
    expect(rooms.values.fte[12]).toBeCloseTo(1 + fteHours / 1872);
    expect(rooms.values.hoursFte[0]).toBeCloseTo((100 + 150 + 10) / 156);
    // Every hours account in the total: manager and overtime hours too.
    expect(rooms.values.hours[12]).toBe(fteHours + 160 * 12 + 10 * 6);
    expect(hoursOfKind(rooms.values, built.accounts, "manager")[12]).toBe(1920);
  });

  it("rolls positions up to the department, the group and the hotel", () => {
    expect(rooms.children.map((c) => c.label)).toEqual(["Rooms Manager", "Front Office Supervisor", "Front Desk Agent", "Manual input"]);
    expect(rooms.children.map((c) => c.tier)).toEqual(["mgr", "svsr", "assoc", null]);
    expect(rooms.children[3].kind).toBe("other");
    const sum = (pick: (n: StaffingStatsNode) => number) => rooms.children.reduce((s, c) => s + pick(c), 0);
    expect(sum((c) => c.values.hours[12])).toBeCloseTo(rooms.values.hours[12]);
    expect(sum((c) => c.values.fte[12])).toBeCloseTo(rooms.values.fte[12]);
    expect(built.hotel.values.heads[0]).toBe(3 + 4);
    // The work week and the money are nowhere: D0410 posts only the week, so it has no row.
    expect(() => find(built.hotel, "d:0410")).toThrow();
    expect(rooms.values.byAccount["511000"]).toBeUndefined();
  });

  it("groups by level 10, falls back to level 7, names clashing groups apart and puts the unmapped last", () => {
    expect(built.hotel.children.map((g) => g.label)).toEqual([
      "Rooms",
      "Other Profit Departments (Other Operated Departments)",
      "Property Operation & Maintenance",
      "Other Profit Departments (Payroll Cost Allocation)",
      UNMAPPED_GROUP,
    ]);
    expect(built.unmappedDepartments).toEqual(["0999"]);
  });

  it("lists the hours accounts with a figure, FTE-driving first", () => {
    expect(built.accounts.map((a) => [a.code, a.kind])).toEqual([
      ["988699", "fte"],
      ["988307", "overtime"],
      ["988308", "manager"],
    ]);
    expect(shortAccountName(built.accounts[2])).toBe("Manager Hours");
  });

  it("flags an account more than one grade books to, and says who", () => {
    expect(built.gradeMix).toEqual([
      expect.objectContaining({
        dept: "0100",
        account: "988699",
        accountKind: "fte",
        kinds: ["mixed"],
        hoursByTier: { mgr: 0, svsr: 1200, assoc: 900 },
        positionsByTier: { mgr: 0, svsr: 1, assoc: 1 },
      }),
    ]);
    expect(rooms.mix["988699"]).toEqual({ kinds: ["mixed"], departments: 1 });
    expect(built.hotel.mix["988699"]).toEqual({ kinds: ["mixed"], departments: 1 });
    // One grade on an account is fine; so is overtime from a single grade.
    expect(rooms.mix["988308"]).toBeUndefined();
    expect(rooms.mix["988307"]).toBeUndefined();
    // "Mixed" is a department's fact, not a position's.
    expect(rooms.children[1].mix).toEqual({});
    const entry = built.gradeMix[0];
    expect(describeMix(rooms, rooms.mix["988699"], entry)).toMatch(/^Supervisors 1,200 h · Associates 900 h\. More than one grade/);
    expect(describeMix(built.hotel, built.hotel.mix["988699"])).toMatch(/^1 department below/);
  });

  it("flags hours on the wrong side of FTE, on the department and the position that put them there", () => {
    const boss = position("b1", "Manager (Non Exempt)", "Chef");
    const cook = position("c1", "Associate", "Cook");
    const wrong = buildStaffingStatistics(
      [
        line("D0100", "A988699", flat(160), boss), // a manager's hours driving FTE: counted twice
        line("D0100", "A988308", flat(120), cook), // a cook's hours on the manager account: left out
      ],
      FTE_HOURS,
      LABELS
    );
    const dept = find(wrong.hotel, "d:0100");
    expect(dept.mix["988699"].kinds).toEqual(["manager_hours_drive_fte"]);
    expect(dept.mix["988308"].kinds).toEqual(["staff_hours_outside_fte"]);
    expect(find(wrong.hotel, "p:0100:b1").mix).toEqual({ "988699": { kinds: ["manager_hours_drive_fte"], departments: 0 } });
    expect(find(wrong.hotel, "p:0100:c1").mix).toEqual({ "988308": { kinds: ["staff_hours_outside_fte"], departments: 0 } });
  });
});
