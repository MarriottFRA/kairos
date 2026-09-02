/**
 * The manual-input derivation rules — the amount rule has long been pinned by
 * the repo/grid tests around it; these pin the newer stats rule (KPI ÷ Per ×
 * Units) and its fallback ladder: derived when the series resolves, zeros when
 * the driver has nothing for the department, the stored snapshot when there is
 * nothing to resolve from at all.
 */

import { describe, expect, it } from "vitest";
import {
  ManualKpiSeriesSlice,
  ManualStatsSource,
  isKpiStatsDriven,
  manualMonthlyStats,
  manualStatForMonth,
  resolveManualRowStats,
  resolveManualStatsSeries,
} from "../rowMath";

const SERIES = [
  100000, 50000, 0, 25000, 100000, 50000, 100000, 50000, 100000, 50000, 100000,
  50000,
];

function drivenRow(overrides: Partial<ManualStatsSource> = {}): ManualStatsSource {
  return {
    statsKpiDriverId: "kpi-1",
    statsKpiDivisor: 50000,
    statsKpiFactor: 20,
    departmentCode: "D0410",
    stats: new Array(12).fill(7), // the stored snapshot, distinct from anything derived
    ...overrides,
  };
}

describe("isKpiStatsDriven", () => {
  it("is driven only by a non-blank driver id", () => {
    expect(isKpiStatsDriven("kpi-1")).toBe(true);
    expect(isKpiStatsDriven(null)).toBe(false);
    expect(isKpiStatsDriven("")).toBe(false);
    expect(isKpiStatsDriven("   ")).toBe(false);
    expect(isKpiStatsDriven(undefined)).toBe(false);
  });
});

describe("manualStatForMonth", () => {
  it("derives seriesValue / divisor * factor", () => {
    // "20 hours per 50,000" against 100,000 of revenue.
    expect(manualStatForMonth(50000, 20, 100000)).toBe(40);
    expect(manualStatForMonth(50000, 20, 25000)).toBe(10);
  });

  it("yields 0 for an unusable divisor instead of NaN/Infinity", () => {
    expect(manualStatForMonth(0, 20, 100000)).toBe(0);
    expect(manualStatForMonth(-1, 20, 100000)).toBe(0);
    expect(manualStatForMonth(null, 20, 100000)).toBe(0);
    expect(manualStatForMonth("abc", 20, 100000)).toBe(0);
  });

  it("treats a missing factor or series value as 0", () => {
    expect(manualStatForMonth(50000, null, 100000)).toBe(0);
    expect(manualStatForMonth(50000, 20, undefined)).toBe(0);
  });
});

describe("resolveManualStatsSeries", () => {
  const explicit: ManualKpiSeriesSlice = { deptKey: "*", values: SERIES };
  const dept: ManualKpiSeriesSlice = {
    deptKey: "D0410",
    values: new Array(12).fill(1),
  };

  it("prefers the EXPLICIT '*' slice over a department match", () => {
    expect(resolveManualStatsSeries([dept, explicit], "D0410")).toEqual(SERIES);
  });

  it("falls back to the slice matching the department code", () => {
    expect(resolveManualStatsSeries([dept], "D0410")).toEqual(
      new Array(12).fill(1)
    );
  });

  it("resolves to zeros when slices exist but none match the department", () => {
    expect(resolveManualStatsSeries([dept], "D9999")).toEqual(
      new Array(12).fill(0)
    );
  });

  it("returns null when there is nothing to resolve from", () => {
    expect(resolveManualStatsSeries(null, "D0410")).toBeNull();
    expect(resolveManualStatsSeries([], "D0410")).toBeNull();
  });

  it("normalizes a ragged series to length 12", () => {
    expect(
      resolveManualStatsSeries([{ deptKey: "*", values: [1, 2] }], "D0410")
    ).toEqual([1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("manualMonthlyStats", () => {
  it("derives all 12 months when the series resolves", () => {
    const derived = manualMonthlyStats(drivenRow(), () => [
      { deptKey: "*", values: SERIES },
    ]);
    expect(derived[0]).toBe(40); // 100000 / 50000 * 20
    expect(derived[1]).toBe(20);
    expect(derived[2]).toBe(0);
    expect(derived[3]).toBe(10);
  });

  it("falls back to the stored snapshot when the lookup knows no such driver", () => {
    expect(manualMonthlyStats(drivenRow(), () => null)).toEqual(
      new Array(12).fill(7)
    );
  });

  it("returns the stored stats verbatim for a non-driven row", () => {
    const row = drivenRow({ statsKpiDriverId: null });
    expect(
      manualMonthlyStats(row, () => [{ deptKey: "*", values: SERIES }])
    ).toEqual(new Array(12).fill(7));
  });
});

describe("resolveManualRowStats", () => {
  it("replaces stats on driven rows and leaves the rest by reference", () => {
    const driven = drivenRow();
    const typed = drivenRow({ statsKpiDriverId: null });
    const [outDriven, outTyped] = resolveManualRowStats([driven, typed], () => [
      { deptKey: "*", values: SERIES },
    ]);
    expect(outDriven).not.toBe(driven);
    expect(outDriven.stats[0]).toBe(40);
    expect(outTyped).toBe(typed);
    // The input row itself is untouched.
    expect(driven.stats).toEqual(new Array(12).fill(7));
  });
});
