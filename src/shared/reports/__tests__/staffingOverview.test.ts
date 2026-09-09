/**
 * The staffing overview's arithmetic from literals: every classification
 * lands in one bucket (or, for bought-in labour, none), heads are counted
 * unweighted while FTE carries Count and the cluster share, the title ladder
 * in both modes, groups in the pack's order with the unmapped bucket last,
 * and a comparison merged by (group, title) with the variance both ways.
 */

import { describe, expect, it } from "vitest";
import { JOB_TYPE_OPTIONS } from "../../positions/fieldSeed";
import { UNMAPPED_GROUP } from "../packs";
import {
  StaffingPositionInput,
  aggregateStaffing,
  bucketForJobType,
  buildStaffingGroups,
  cellsTotal,
  staffingTitle,
} from "../staffingOverview";

const position = (overrides: Partial<StaffingPositionInput>): StaffingPositionInput => ({
  id: "p",
  departmentCode: "D0010",
  jobTypeCode: "Associate",
  headcount: 1,
  fte: 1,
  hotelClusterWeight: 1,
  ...overrides,
});

const GROUP_OF: Record<string, string> = {
  D0010: "Rooms and Reservation",
  D0410: "Administrative & General",
  D0210: "Total Food & Beverage",
};
const groupOf = (dept: string) => GROUP_OF[dept] ?? UNMAPPED_GROUP;
const titleOf = (p: StaffingPositionInput) => p.id;

describe("bucketForJobType", () => {
  it("files every classification the field catalog offers, Buyout Labour excluded", () => {
    const seen = Object.fromEntries(JOB_TYPE_OPTIONS.map((o) => [o.value, bucketForJobType(o.value)]));
    expect(seen).toEqual({
      Manager: "mgr",
      "Manager (Non Exempt)": "mgr",
      Supervisor: "svsr",
      Associate: "assoc",
      Casual: "casual",
      "Buyout Labour": null,
    });
    // An unclassified row still reports its heads, as a non-manager.
    expect(bucketForJobType("")).toBe("assoc");
    expect(bucketForJobType(null)).toBe("assoc");
  });
});

describe("staffingTitle", () => {
  const pii = { title: " Front Desk Agent ", extraValues: { standardJobTitle: "Guest Service Agent" } };
  it("prefers the mode's title and falls back through the other, then the classification", () => {
    expect(staffingTitle(pii, "Associate", "title")).toBe("Front Desk Agent");
    expect(staffingTitle(pii, "Associate", "standard")).toBe("Guest Service Agent");
    expect(staffingTitle({ title: "", extraValues: { standardJobTitle: "Chef" } }, "Associate", "title")).toBe("Chef");
    expect(staffingTitle({ title: "Chef", extraValues: {} }, "Associate", "standard")).toBe("Chef");
    expect(staffingTitle({ title: null, extraValues: null }, "Supervisor", "title")).toBe("Supervisor");
    expect(staffingTitle(undefined, "", "standard")).toBe("Position");
  });
});

describe("aggregateStaffing", () => {
  it("counts heads as they stand and FTE × count × cluster share, per group and title", () => {
    const aggregate = aggregateStaffing(
      [
        position({ id: "Attendant", jobTypeCode: "Associate", headcount: 3, fte: 0.5 }),
        position({ id: "Attendant", jobTypeCode: "Associate", headcount: 1, fte: 1 }),
        position({ id: "Manager", jobTypeCode: "Manager", headcount: 2, fte: 0.5, hotelClusterWeight: 0.5 }),
        position({ id: "Guard", departmentCode: "D0410", jobTypeCode: "Casual", fte: 0.2 }),
        position({ id: "Agency", departmentCode: "D0410", jobTypeCode: "Buyout Labour", headcount: 9 }),
        position({ id: "Lost", departmentCode: "D9999", jobTypeCode: "Supervisor" }),
      ],
      titleOf,
      groupOf
    );
    const rooms = aggregate.get("Rooms and Reservation")!;
    expect(rooms.get("Attendant")!.hc.assoc).toBe(4);
    expect(rooms.get("Attendant")!.fte.assoc).toBeCloseTo(2.5);
    // Two shared managers: two heads here, one FTE (0.5 each × ½ share × 2).
    expect(rooms.get("Manager")!.hc.mgr).toBe(2);
    expect(rooms.get("Manager")!.fte.mgr).toBeCloseTo(0.5);
    const admin = aggregate.get("Administrative & General")!;
    expect(admin.get("Guard")!.hc.casual).toBe(1);
    expect(admin.get("Guard")!.fte.casual).toBeCloseTo(0.2);
    expect(admin.has("Agency")).toBe(false);
    expect(aggregate.get(UNMAPPED_GROUP)!.get("Lost")!.hc.svsr).toBe(1);
  });
});

describe("buildStaffingGroups", () => {
  const budget = aggregateStaffing(
    [
      position({ id: "Clerk", departmentCode: "D0410" }),
      position({ id: "Attendant", headcount: 4 }),
      position({ id: "Lost", departmentCode: "D9999" }),
      position({ id: "Waiter", departmentCode: "D0210", headcount: 2 }),
    ],
    titleOf,
    groupOf
  );

  it("orders groups as the pack does, unmapped last, rows by title, with totals", () => {
    const built = buildStaffingGroups(budget, null);
    expect(built.groups.map((g) => g.label)).toEqual([
      "Rooms and Reservation",
      "Total Food & Beverage",
      "Administrative & General",
      UNMAPPED_GROUP,
    ]);
    expect(built.groups[0].rows.map((r) => r.title)).toEqual(["Attendant"]);
    expect(built.groups[0].totals.hc.assoc).toBe(4);
    expect(cellsTotal(built.totals, "hc")).toBe(8);
    expect(built.compareTotals).toBeNull();
    expect(built.groups[0].rows[0].compare).toBeNull();
    expect(built.groups[0].rows[0].variance).toBeNull();
  });

  it("merges a comparison by group and title, a vanished title showing as a negative variance", () => {
    const compare = aggregateStaffing(
      [
        position({ id: "Attendant", headcount: 3 }),
        position({ id: "Porter", jobTypeCode: "Casual" }),
        position({ id: "Clerk", departmentCode: "D0410" }),
        position({ id: "Lost", departmentCode: "D9999" }),
        position({ id: "Waiter", departmentCode: "D0210", headcount: 2 }),
      ],
      titleOf,
      groupOf
    );
    const built = buildStaffingGroups(budget, compare);
    const rooms = built.groups[0];
    expect(rooms.rows.map((r) => r.title)).toEqual(["Attendant", "Porter"]);
    const attendant = rooms.rows[0];
    expect(attendant.compare!.hc.assoc).toBe(3);
    expect(attendant.variance!.hc.assoc).toBe(1);
    const porter = rooms.rows[1];
    expect(porter.cells.hc.casual).toBe(0);
    expect(porter.variance!.hc.casual).toBe(-1);
    expect(rooms.varianceTotals!.hc.assoc).toBe(1);
    expect(rooms.varianceTotals!.hc.casual).toBe(-1);
    expect(cellsTotal(built.compareTotals!, "hc")).toBe(8);
    expect(cellsTotal(built.varianceTotals!, "hc")).toBe(0);
    expect(built.varianceTotals!.hc).toEqual({ mgr: 0, svsr: 0, assoc: 1, casual: -1 });
  });
});
