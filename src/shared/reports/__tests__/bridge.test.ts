/**
 * The bridge's account buckets (map labels first, code families as the
 * fallback), each payroll account's path through the tree levels, and the
 * arithmetic over rows (payroll total, lineage index, the summary a DOF
 * reads first).
 */

import { describe, expect, it } from "vitest";
import {
  BridgeDepartment,
  bridgeAccountPath,
  classifyBridgeAccount,
  indexByLineage,
  payrollTotal,
  summarize,
} from "../bridge";

const labelsOf = (table: Record<string, Record<number, string>>) => ({
  accountLabel: (code: string, level: number) => table[code]?.[level] ?? null,
  hasAccount: (code: string) => code in table,
});

const HEADS = new Set(["972540", "988101"]);

describe("classifyBridgeAccount", () => {
  const labels = labelsOf({
    "511000": { 9: "Total Payroll", 12: "Associate Wages" },
    "560303": { 9: "Total Payroll", 12: "Associate Benefits", 14: "Paid Time Off" },
    "988308": { 1: "Statistics", 4: "Total Manhours" },
    "610201": { 4: "Profit Amount", 6: "Total Expenses" },
  });

  it("puts everything under Total Payroll in payroll, and reads hours from the map", () => {
    expect(classifyBridgeAccount("511000", labels, HEADS)).toBe("payroll");
    expect(classifyBridgeAccount("560303", labels, HEADS)).toBe("payroll");
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
    expect(classifyBridgeAccount("512400", none, HEADS)).toBe("payroll");
    expect(classifyBridgeAccount("701110", none, HEADS)).toBe("other");
  });
});

describe("bridgeAccountPath", () => {
  const labels = labelsOf({
    "510005": { 9: "Total Payroll", 12: "Associate Wages", 14: "Wages & Salaries", 18: "Total Hourly Wages excl Overtime", 21: "Hourly Wages" },
    "560303": { 9: "Total Payroll", 12: "Associate Benefits", 14: "Paid Time Off" },
    "599000": { 9: "Total Payroll" },
  });

  it("walks L12 → L14 → L18 → L21, skipping the blank levels", () => {
    expect(bridgeAccountPath("510005", labels)).toEqual([
      { level: 12, label: "Associate Wages" },
      { level: 14, label: "Wages & Salaries" },
      { level: 18, label: "Total Hourly Wages excl Overtime" },
      { level: 21, label: "Hourly Wages" },
    ]);
    expect(bridgeAccountPath("560303", labels)).toEqual([
      { level: 12, label: "Associate Benefits" },
      { level: 14, label: "Paid Time Off" },
    ]);
  });

  it("groups a mapped account with no tree labels, and an unmapped one, apart", () => {
    expect(bridgeAccountPath("599000", labels)).toEqual([{ level: 12, label: "Other payroll" }]);
    expect(bridgeAccountPath("512400", labels)).toEqual([{ level: 12, label: "Unmapped" }]);
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
      row({ key: "a", lineageId: "L1", headcount: 2, fte: 1.5, cells: [cell("511000", "payroll", 60000)] }),
      row({ key: "b", lineageId: "L2", active: false, cells: [cell("512000", "payroll", 1)] }),
      row({ key: "c", positionId: "x", deleted: true, cells: [cell("512000", "payroll", 2)] }),
      row({ key: "d", source: "MANUAL", positionId: null, headcount: null, fte: null, cells: [cell("599000", "payroll", 3000)] }),
    ],
    totals: [
      cell("511000", "payroll", 60000),
      cell("512000", "payroll", 3),
      cell("599000", "payroll", 3000),
      cell("988308", "hours", 4000),
      cell("972540", "heads", 2),
    ],
  };

  it("sums payroll over the payroll accounts only", () => {
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
