/**
 * The budget pack from literals: page order by level_10 group (level_7
 * fallback, level_7 order), the excluded
 * departments gone, the ledger's category CASE and level_12 sub-groups with
 * subtotals that tie, an unmapped account in the residual group, a
 * cache-only department present, and every generated definition valid and
 * plain data.
 */

import { describe, expect, it } from "vitest";
import { compileDefinition, validateDefinition } from "../compile";
import { EvaluationContext, evaluateReport } from "../engine";
import {
  PackUniverse,
  buildLedgerDefinition,
  buildPackPageDefinition,
  layoutPack,
  packLabelsOf,
} from "../packs";
import { buildMapIndex, buildValueSource } from "../sources";

const flat = (value: number) => new Array(12).fill(value);
const levels = (entries: Record<number, string>) =>
  Array.from({ length: 31 }, (_, i) => entries[i] ?? null);

const MAPS = buildMapIndex(
  "v1",
  [
    {
      code: "D0010",
      name: "Rooms",
      levels: levels({ 2: "Lodging Operations", 5: "ROOMS_and_RESERVATION", 7: "Rooms and Reservation", 10: "Rooms" }),
    },
    {
      code: "D0210",
      name: "Restaurant",
      levels: levels({ 2: "Lodging Operations", 5: "Total Food & Beverage", 7: "Total Food & Beverage", 10: "Outlets and Lounge", 11: "Lounge" }),
    },
    {
      code: "D0211",
      name: "Room service",
      levels: levels({
        2: "Lodging Operations",
        5: "Total Food & Beverage",
        7: "Total Food & Beverage",
        10: "Outlets and Lounge",
        11: "Restaurants and Room Service",
      }),
    },
    { code: "D0410", name: "Admin", levels: levels({ 2: "Lodging Operations", 7: "Administrative & General" }) },
    { code: "D0499", name: "Excluded", levels: levels({ 7: "Payroll Cost Allocation" }) },
  ],
  [
    { code: "A300100", name: "Room revenue", levels: levels({ 4: "Profit Amount", 6: "Revenue", 12: "Total Room Revenue" }) },
    { code: "A310100", name: "Food revenue", levels: levels({ 4: "Profit Amount", 6: "Revenue", 12: "Food Revenue" }) },
    { code: "A511000", name: "Salaries", levels: levels({ 4: "Profit Amount", 9: "Total Payroll", 12: "Associate Wages" }) },
    { code: "A560303", name: "Vacation", levels: levels({ 4: "Profit Amount", 9: "Total Payroll", 12: "Associate Benefits" }) },
    { code: "A610201", name: "Guest supplies", levels: levels({ 4: "Profit Amount", 6: "Total Expenses", 12: "Supplies" }) },
    { code: "A420100", name: "Food cost", levels: levels({ 4: "Profit Amount", 9: "Cost Of Sales", 12: "Food Cost" }) },
    { code: "A960101", name: "Rooms available", levels: levels({ 1: "Statistics" }) },
    { code: "A960103", name: "Rooms sold", levels: levels({ 1: "Statistics" }) },
    { code: "A988308", name: "Hours", levels: levels({ 1: "Statistics", 4: "Total Manhours", 6: "Total Manhours excl Overtime and Manager Hours", 9: "Man Hours" }) },
    { code: "A972540", name: "Position count", levels: levels({ 1: "Statistics" }) },
    { code: "A988101", name: "Manager heads", levels: levels({ 1: "Statistics" }) },
    { code: "A914011", name: "Breakfast covers", levels: levels({ 1: "Statistics", 4: "Department Volume", 6: "Cover B/B/L/D" }) },
    {
      code: "A914103",
      name: "Allocation basis",
      levels: levels({ 1: "Statistics", 4: "Department Volume", 6: "Cover Other Meal Periods", 9: "Cover Other Segments" }),
    },
    { code: "A968801", name: "Arrivals", levels: levels({ 1: "Statistics" }) },
    { code: "A968802", name: "Departures", levels: levels({ 1: "Statistics" }) },
  ]
);
const LABELS = packLabelsOf(MAPS);

const BASE_ROWS = [
  { dept: "D0010", account: "A300100", months: flat(100000) },
  { dept: "D0010", account: "A511000", months: flat(10000) },
  { dept: "D0010", account: "A560303", months: flat(1000) },
  { dept: "D0010", account: "A610201", months: flat(3000) },
  { dept: "D0010", account: "A999999", months: flat(7) }, // unmapped account
  { dept: "D0010", account: "A960103", months: flat(2100) },
  { dept: "D0010", account: "A988308", months: flat(4000) },
  { dept: "D0010", account: "A972540", months: [5, ...flat(0).slice(1)], total: 5, encoding: "LEVEL" },
  { dept: "D0210", account: "A310100", months: flat(40000) },
  { dept: "D0210", account: "A420100", months: flat(12000) },
  { dept: "D0210", account: "A511000", months: flat(9000) },
  { dept: "D0499", account: "A511000", months: flat(999) },
  { dept: "D0777", account: "A511000", months: flat(500) }, // cache-only, unmapped department
] as const;
const SOURCE = buildValueSource("bst", BASE_ROWS);

function universeOf(...sources: Array<typeof SOURCE>): PackUniverse {
  const out = new Map<string, Set<string>>();
  for (const source of sources) {
    for (const entry of source.entries) {
      let accounts = out.get(entry.dept);
      if (!accounts) out.set(entry.dept, (accounts = new Set()));
      accounts.add(entry.account);
    }
  }
  return out;
}

const context: EvaluationContext = {
  getSource: () => SOURCE,
  maps: MAPS,
  getParam: (p) => (p.builtin === "weekly_hours" ? 40 : null),
};

const evaluate = (definition: ReturnType<typeof buildPackPageDefinition>) => {
  const report = evaluateReport(compileDefinition(definition), context);
  return { report, byLabel: new Map(report.rows.map((r) => [r.label, r.values])) };
};

describe("layoutPack", () => {
  const layout = layoutPack(universeOf(SOURCE), LABELS);

  it("orders pages summary, total, then each level_10 group with its departments; excluded ones gone", () => {
    // D0410 is mapped but carries nothing in any source: no page for it.
    expect(layout.groups).toEqual(["Rooms", "Outlets and Lounge", "Unmapped departments"]);
    expect(layout.pages.map((p) => p.id)).toEqual([
      "summary",
      "summary_reporting",
      "total",
      "group:Rooms",
      "dept:0010",
      "group:Outlets and Lounge",
      "dept:0210",
      "group:Unmapped departments",
      "dept:0777",
    ]);
    expect(layout.pages.find((p) => p.id === "dept:0777")!.title).toBe("0777 · 0777");
    expect(layout.departments.map((d) => d.code)).not.toContain("0499");
  });
});

describe("ledger pages", () => {
  const layout = layoutPack(universeOf(SOURCE), LABELS);
  const universe = universeOf(SOURCE);

  it("lays a department out by category, level_12 group and account, with subtotals that tie", () => {
    const page = layout.pages.find((p) => p.id === "dept:0010")!;
    const definition = buildPackPageDefinition(page, layout, universe, LABELS);
    expect(validateDefinition(definition)).toEqual([]);
    const { report, byLabel } = evaluate(definition);

    expect(report.rows.map((r) => (r.type === "header" ? `# ${r.label}` : r.type === "spacer" ? "-" : r.label))).toEqual([
      "# REVENUE",
      "300100 · Room revenue",
      "Total Revenue",
      "-",
      "# PAYROLL",
      "# Associate Benefits",
      "560303 · Vacation",
      "Total Associate Benefits",
      "# Associate Wages",
      "511000 · Salaries",
      "Total Associate Wages",
      "Total Payroll",
      "-",
      "# CONTROLLABLES",
      "610201 · Guest supplies",
      "Total Controllables",
      "-",
      "# STATS",
      "960103 · Rooms sold",
      "972540 · Position count",
      "988308 · Hours",
      "999999 · 999999", // unmapped, but a 9… code is a statistic by the CASE
      "Total Stats",
      "-",
      "Department Profit",
      "GOP %",
    ]);
    expect(byLabel.get("Total Revenue")![12]).toBe(1200000);
    expect(byLabel.get("Total Payroll")![12]).toBe(132000);
    expect(byLabel.get("Total Associate Wages")![12]).toBe(120000);
    expect(byLabel.get("Department Profit")![12]).toBe(1200000 - 132000 - 36000);
    expect(byLabel.get("GOP %")![12]).toBeCloseTo(((1200000 - 168000) / 1200000) * 100);
    expect(byLabel.get("972540 · Position count")![12]).toBe(5); // a level, read as one
    expect(report.rows.find((r) => r.label === "Total Payroll")!.polarity).toBe("cost");
  });

  it("sums a group's departments and the hotel total across all of them", () => {
    const group = layout.pages.find((p) => p.id === "group:Outlets and Lounge")!;
    const { byLabel: fb } = evaluate(buildPackPageDefinition(group, layout, universe, LABELS));
    expect(fb.get("Total Revenue")![12]).toBe(480000);
    expect(fb.get("Total Cost of Sales")![12]).toBe(144000);

    const total = layout.pages.find((p) => p.id === "total")!;
    const { byLabel: hotel } = evaluate(buildPackPageDefinition(total, layout, universe, LABELS));
    expect(hotel.get("Total Revenue")![12]).toBe(1680000);
    // The excluded department's payroll is not in the hotel total.
    expect(hotel.get("Total Payroll")![12]).toBe((10000 + 1000 + 9000 + 500) * 12);
  });

  it("gives a department with no revenue a plain Total, and files an unmapped account by the CASE", () => {
    const unmapped = layout.pages.find((p) => p.id === "dept:0777")!;
    const definition = buildPackPageDefinition(unmapped, layout, universe, LABELS);
    expect(validateDefinition(definition)).toEqual([]);
    const { report, byLabel } = evaluate(definition);
    expect(report.rows.map((r) => r.label)).toEqual(["PAYROLL", "511000 · Salaries", "Total Payroll", "", "Total"]);
    expect(byLabel.get("Total")![12]).toBe(6000);
    // An account no map knows and no 9 prefix marks lands in Other.
    const other = buildLedgerDefinition({ id: "x", name: "x", depts: ["0010"], accounts: ["777777"], labels: LABELS });
    expect(other.rows.map((r) => (r.type === "spacer" ? "" : r.label))).toEqual([
      "OTHER",
      "777777 · 777777",
      "Total Other",
      "",
      "Total",
    ]);
  });
});

describe("summary page", () => {
  it("shows the KPI block per group and for the hotel, FTE from the hours and the work week", () => {
    const layout = layoutPack(universeOf(SOURCE), LABELS);
    const definition = buildPackPageDefinition(layout.pages[0], layout, universeOf(SOURCE), LABELS);
    expect(validateDefinition(definition)).toEqual([]);
    const { report } = evaluate(definition);
    const blocks = report.rows.filter((r) => r.type === "header").map((r) => r.label);
    expect(blocks).toEqual(["HOTEL", "ROOMS", "OUTLETS AND LOUNGE", "UNMAPPED DEPARTMENTS"]);
    const rooms = report.rows.slice(report.rows.findIndex((r) => r.label === "ROOMS"));
    const value = (label: string) => rooms.find((r) => r.label === label)!.values![12];
    expect(value("Revenue")).toBe(1200000);
    expect(value("Total payroll")).toBe(132000);
    expect(value("Other expenses")).toBe(36000);
    expect(value("Department profit")).toBe(1200000 - 132000 - 36000);
    expect(value("Hours")).toBe(48000);
    expect(value("FTE")).toBeCloseTo(48000 / 2080); // hours ÷ (40 × 52), no manager heads in this group
    expect(value("Heads")).toBe(5);
    expect(value("Payroll % of revenue")).toBeCloseTo(11);
    expect(value("Payroll per FTE")).toBeCloseTo(132000 / (48000 / 2080));
    expect(report.warnings).toEqual([]);
  });

  it("generates plain data that round-trips", () => {
    const layout = layoutPack(universeOf(SOURCE), LABELS);
    for (const page of layout.pages) {
      const definition = buildPackPageDefinition(page, layout, universeOf(SOURCE), LABELS);
      const clone = JSON.parse(JSON.stringify(definition));
      expect(clone).toEqual(definition);
      expect(compileDefinition(clone).order).toEqual(compileDefinition(definition).order);
    }
  });
});

describe("summary reporting page", () => {
  // The summary source plus what this page reads: rooms available, manager
  // heads, covers (one real, one allocation basis filed with them), arrivals
  // and departures, and a room-service department beside the lounge.
  const REPORTING_SOURCE = buildValueSource("bst", [
    ...BASE_ROWS,
    { dept: "D0010", account: "A960101", months: flat(3000) },
    { dept: "D0010", account: "A988101", months: [2, ...flat(0).slice(1)], total: 2, encoding: "LEVEL" },
    { dept: "D0010", account: "A968801", months: flat(400) },
    { dept: "D0010", account: "A968802", months: flat(390) },
    { dept: "D0210", account: "A914011", months: flat(1500) },
    { dept: "D0210", account: "A914103", months: flat(99) },
    { dept: "D0211", account: "A310100", months: flat(8000) },
    { dept: "D0211", account: "A914011", months: flat(500) },
    // Admin has no level_10 label: it falls back to its level_7 group.
    { dept: "D0410", account: "A988308", months: flat(300) },
  ]);
  const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const reportingContext: EvaluationContext = {
    getSource: () => REPORTING_SOURCE,
    maps: MAPS,
    getParam: (p) =>
      p.builtin === "weekly_hours"
        ? 40
        : p.builtin === "days_in_month"
          ? { months: DAYS, total: 365 }
          : null,
  };
  const layout = layoutPack(universeOf(REPORTING_SOURCE), LABELS);
  const page = layout.pages.find((p) => p.id === "summary_reporting")!;
  const definition = buildPackPageDefinition(page, layout, universeOf(REPORTING_SOURCE), LABELS);
  const report = evaluateReport(compileDefinition(definition), reportingContext);
  const rows = report.rows;
  const value = (label: string, from = 0) => rows.slice(from).find((r) => r.label === label)!.values![12];

  it("is a valid page with the hotel section then one block per level_10 group, in level_7 order", () => {
    expect(page.kind).toBe("summary_reporting");
    expect(validateDefinition(definition)).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(rows.filter((r) => r.type === "header").map((r) => r.label)).toEqual([
      "FINANCIAL & STATS SUMMARY",
      "ROOMS",
      "OUTLETS AND LOUNGE", // restaurant and room service together
      "ADMINISTRATIVE & GENERAL", // no level_10: the level_7 label
      "UNMAPPED DEPARTMENTS",
    ]);
    // The same groups as the rest of the pack (Summary page, ledgers).
    expect(layout.groups).toEqual(["Rooms", "Outlets and Lounge", "Administrative & General", "Unmapped departments"]);
  });

  it("tells a level_10 label under two level_7 groups apart by its parent", () => {
    const l7: Record<string, string> = { "1": "Other Operated Departments", "2": "Payroll Cost Allocation", "3": "Rooms and Reservation" };
    const labels = {
      ...LABELS,
      deptLabel: (code: string, level: number) =>
        level === 7 ? l7[code] ?? null : level === 10 ? (code === "3" ? "Rooms" : "Other Profit Departments") : null,
    };
    const universe: PackUniverse = new Map(["1", "2", "3"].map((code) => [code, new Set<string>()]));
    const split = layoutPack(universe, labels);
    expect(split.groups).toEqual([
      "Rooms",
      "Other Profit Departments (Other Operated Departments)",
      "Other Profit Departments (Payroll Cost Allocation)",
    ]);
    expect(split.departments.map((d) => [d.code, d.group])).toEqual([
      ["3", "Rooms"],
      ["1", "Other Profit Departments (Other Operated Departments)"],
      ["2", "Other Profit Departments (Payroll Cost Allocation)"],
    ]);
  });

  it("reads the hotel stats: rooms ÷ days, guests, covers less the allocation bases, arrivals + departures", () => {
    const noOfRooms = rows.find((r) => r.label === "No. of Rooms")!.values!;
    expect(noOfRooms[0]).toBeCloseTo(3000 / 31);
    expect(noOfRooms[12]).toBeCloseTo(36000 / 365);
    expect(value("Customers Outlets")).toBe((1500 + 500) * 12); // A914103 is "Cover Other Segments"
    expect(value("Customers Catering")).toBe(0);
    expect(value("Arrivals & Departures")).toBe((400 + 390) * 12);
    // Total Payroll is the hierarchy form (Lodging Operations × Total Payroll),
    // so the unmapped D0777 is not in it — unlike the group blocks, which pin
    // department codes and therefore carry it in the unmapped block.
    expect(value("Total Payroll PAR")).toBeCloseTo(((10000 + 1000 + 9000) * 12) / 36000);
    expect(value("Total Payroll POR")).toBeCloseTo(((10000 + 1000 + 9000) * 12) / (2100 * 12));
  });

  it("splits F&B sales by department node, with the lounge in the remainder", () => {
    expect(value("F&B Sales")).toBe((40000 + 8000) * 12);
    expect(value("F&B Outlets Restaurants / Room Service / Minibar")).toBe(8000 * 12);
    expect(value("F&B Outlets Lounges and Other")).toBe(40000 * 12);
    expect(value("F&B Catering/AV")).toBe(0);
  });

  it("gives each group heads, managers, hours, wages and payroll against the hotel's sales and rooms", () => {
    const from = rows.findIndex((r) => r.label === "ROOMS");
    const totalSales = (100000 + 40000 + 8000) * 12;
    expect(value("HC", from)).toBe(5);
    expect(value("# Managers", from)).toBe(2);
    expect(value("Total Hours", from)).toBe(48000);
    expect(value("Salaries only (excl. Benefits)", from)).toBe(120000);
    expect(value("Total Payroll Cost", from)).toBe(132000);
    expect(value("Total Payroll Cost in % to Sales", from)).toBeCloseTo((132000 / totalSales) * 100);
    expect(value("Total Payroll POR", from)).toBeCloseTo(132000 / (2100 * 12));
    expect(value("Hours POR", from)).toBeCloseTo(48000 / (2100 * 12));
    expect(rows.slice(from).find((r) => r.label === "Total Payroll Cost")!.polarity).toBe("cost");
  });

  it("round-trips as plain data", () => {
    const layout = layoutPack(universeOf(SOURCE), LABELS);
    for (const page of layout.pages) {
      const definition = buildPackPageDefinition(page, layout, universeOf(SOURCE), LABELS);
      const clone = JSON.parse(JSON.stringify(definition));
      expect(clone).toEqual(definition);
      expect(compileDefinition(clone).order).toEqual(compileDefinition(definition).order);
    }
  });
});
