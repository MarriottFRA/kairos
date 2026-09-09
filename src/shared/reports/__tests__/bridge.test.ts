/**
 * The bridge's account buckets: map labels first, code families as the
 * fallback, and the arithmetic over rows (payroll total, lineage index,
 * the summary a DOF reads first).
 */

import { describe, expect, it } from "vitest";
import {
  BridgeDepartment,
  classifyBridgeAccount,
  indexByLineage,
  payrollTotal,
  summarize,
} from "../bridge";

const labelsOf = (table: Record<string, Record<number, string>>) => ({
  accountLabel: (code: string, level: number) => table[code]?.[level] ?? null,
});

const HEADS = new Set(["972540", "988101"]);

describe("classifyBridgeAccount", () => {
  const labels = labelsOf({
    "511000": { 9: "Total Payroll", 12: "Associate Wages", 15: "Total Management Salaries" },
    "512000": { 9: "Total Payroll", 12: "Associate Wages", 15: "Total Hourly Wages", 21: "Hourly Wages" },
    "512500": { 9: "Total Payroll", 12: "Associate Wages", 15: "Total Hourly Wages", 18: "Hrly Overtime Prem" },
    "530000": { 9: "Total Payroll", 12: "Associate Wages", 15: "Bonus Payments" },
    "560303": { 9: "Total Payroll", 12: "Associate Benefits", 14: "Paid Time Off" },
    "561000": { 9: "Total Payroll", 12: "Associate Benefits" },
    "599000": { 9: "Total Payroll" },
    "988308": { 1: "Statistics", 4: "Total Manhours" },
    "610201": { 4: "Profit Amount", 6: "Total Expenses" },
  });

  it("reads the map levels in precedence order", () => {
    expect(classifyBridgeAccount("511000", labels, HEADS)).toBe("management_salaries");
    expect(classifyBridgeAccount("512000", labels, HEADS)).toBe("hourly_wages");
    expect(classifyBridgeAccount("512500", labels, HEADS)).toBe("overtime"); // overtime before hourly
    expect(classifyBridgeAccount("530000", labels, HEADS)).toBe("bonus");
    expect(classifyBridgeAccount("560303", labels, HEADS)).toBe("paid_time_off");
    expect(classifyBridgeAccount("561000", labels, HEADS)).toBe("benefits");
    expect(classifyBridgeAccount("599000", labels, HEADS)).toBe("other_payroll");
    expect(classifyBridgeAccount("988308", labels, HEADS)).toBe("hours");
    expect(classifyBridgeAccount("610201", labels, HEADS)).toBe("other");
  });

  it("puts the headcount statistics under heads, mapped or not", () => {
    expect(classifyBridgeAccount("972540", labels, HEADS)).toBe("heads");
    expect(classifyBridgeAccount("988101", labels, HEADS)).toBe("heads");
  });

  it("falls back to the code families Kairos posts to when the maps are silent", () => {
    const none = labelsOf({});
    expect(classifyBridgeAccount("988699", none, HEADS)).toBe("hours");
    expect(classifyBridgeAccount("972541", none, HEADS)).toBe("heads");
    expect(classifyBridgeAccount("512400", none, HEADS)).toBe("other_payroll");
    expect(classifyBridgeAccount("701110", none, HEADS)).toBe("other");
  });
});

describe("bridge arithmetic", () => {
  const cell = (account: string, bucket: Parameters<typeof payrollTotal>[0][number]["bucket"], total: number) => ({
    account,
    bucket,
    months: new Array(12).fill(total / 12),
    total,
    encoding: "AMOUNT" as const,
  });
  const row = (over: Partial<BridgeDepartment["rows"][number]>): BridgeDepartment["rows"][number] => ({
    key: "k",
    source: "ENGINE",
    positionId: "p",
    lineageId: null,
    title: "Agent",
    jobTypeCode: "Associate",
    payType: "HOURLY",
    headcount: 1,
    fte: 1,
    clusterName: null,
    active: true,
    deleted: false,
    label: "Agent",
    cells: [],
    lines: [],
    ...over,
  });
  const dept: BridgeDepartment = {
    code: "0010",
    name: "Rooms",
    rows: [
      row({ key: "a", lineageId: "L1", headcount: 2, fte: 1.5, cells: [cell("511000", "management_salaries", 60000)] }),
      row({ key: "b", lineageId: "L2", active: false, cells: [cell("512000", "hourly_wages", 1)] }),
      row({ key: "c", positionId: "x", deleted: true, cells: [cell("512000", "hourly_wages", 2)] }),
      row({ key: "d", source: "MANUAL", positionId: null, headcount: null, fte: null, cells: [cell("599000", "other_payroll", 3000)] }),
    ],
    totals: [
      cell("511000", "management_salaries", 60000),
      cell("512000", "hourly_wages", 3),
      cell("599000", "other_payroll", 3000),
      cell("988308", "hours", 4000),
      cell("972540", "heads", 2),
    ],
  };

  it("sums payroll over the payroll buckets only", () => {
    expect(payrollTotal(dept.totals)).toBe(63003);
  });

  it("summarises heads and FTE from active, undeleted positions and payroll from the lines", () => {
    expect(summarize([dept])).toEqual({ payroll: 63003, heads: 2, fte: 1.5, hours: 4000, payrollPerFte: 63003 / 1.5 });
  });

  it("indexes by lineage, skipping rows without one", () => {
    const index = indexByLineage([dept]);
    expect([...index.keys()]).toEqual(["L1", "L2"]);
  });
});
