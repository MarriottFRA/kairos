/**
 * Allocations compute tests — the pure spread math (VBA Full_Alloc_Recalc):
 * headcount-weighted aggregation, exclude-then-normalize to 100, flat/equal,
 * and the zero-total guard.
 */

import { describe, expect, it } from "vitest";
import type { CalendarContext } from "../../engine/types";
import type { PositionRecord } from "../../positions/ipc";
import type { AllocationDto } from "../ipc";
import {
  aggregateDepartmentMetrics,
  computeAllocationColumn,
  computeSpreadGrid,
  type DepartmentAgg,
} from "../compute";

// A calendar with 300 productive days (25/month) so worked-hours derivation is
// deterministic when a position carries no stored override.
const CALENDAR: Pick<CalendarContext, "realDays"> = {
  realDays: Float64Array.from(Array(12).fill(25)),
};

function mkPos(over: Partial<PositionRecord>): PositionRecord {
  return {
    id: "p",
    scenarioId: "s",
    lineageId: "p",
    active: true,
    departmentCode: "",
    jobTypeCode: "",
    cluster: "",
    clusterMultiplierOverride: null,
    payType: "SALARIED",
    headcount: 1,
    fte: 1,
    seasonality: Array(12).fill(1),
    monthlyBaseSalary: 0,
    hourlyRate: 0,
    additionalMonthlyCosts: Array(12).fill(0),
    meritIncreasePct: 0,
    manualYearlyIncrease: 0,
    increaseMonth: 13,
    dailyContractHours: 0,
    yearlyHoursWorked: 0,
    vacationDays: 0,
    vacationMonthlyWeights: Array(12).fill(1 / 12),
    accrualDaysPerMonth: 0,
    extraValues: {},
    updatedAt: "",
    ...over,
  } as PositionRecord;
}

function alloc(over: Partial<AllocationDto>): AllocationDto {
  return {
    id: "a",
    name: "Alloc",
    spreadBase: "HEADCOUNT",
    excludedDepartments: [],
    injectAccount: "",
    sortOrder: 10,
    updatedAt: "",
    ...over,
  };
}

describe("aggregateDepartmentMetrics", () => {
  it("groups by department and weights every metric by headcount", () => {
    const depts = aggregateDepartmentMetrics(
      [
        mkPos({ departmentCode: "HK", headcount: 5, fte: 0.8, monthlyBaseSalary: 100 }),
        mkPos({ departmentCode: "HK", headcount: 2, fte: 1, monthlyBaseSalary: 200 }),
        mkPos({ departmentCode: "FD", headcount: 3, fte: 1, monthlyBaseSalary: 300 }),
      ],
      CALENDAR
    );

    const hk = depts.find((d) => d.departmentCode === "HK")!;
    const fd = depts.find((d) => d.departmentCode === "FD")!;
    expect(hk.metrics.headcount).toBe(7);
    // fte × headcount: 0.8*5 + 1*2 = 6
    expect(hk.metrics.fte).toBeCloseTo(6);
    // monthlyBaseSalary × headcount: 100*5 + 200*2 = 900
    expect(hk.metrics.baseSalary).toBe(900);
    expect(fd.metrics.headcount).toBe(3);
    expect(fd.metrics.baseSalary).toBe(900);
  });

  it("drops inactive positions", () => {
    const depts = aggregateDepartmentMetrics(
      [
        mkPos({ departmentCode: "HK", headcount: 5, active: false }),
        mkPos({ departmentCode: "HK", headcount: 2, active: true }),
      ],
      CALENDAR
    );
    expect(depts).toHaveLength(1);
    expect(depts[0].metrics.headcount).toBe(2);
  });

  it("reads contract days / manhours paid from extra_values", () => {
    const [dept] = aggregateDepartmentMetrics(
      [
        mkPos({
          departmentCode: "HK",
          headcount: 2,
          dailyContractHours: 8,
          extraValues: { contractYearlyDays: 260, contractDaysOff: 30 },
        }),
      ],
      CALENDAR
    );
    // contractDays × hc = 260 * 2 = 520
    expect(dept.metrics.contractDays).toBe(520);
    // manhoursPaid = (260 - 30) * 8 * 2 = 3680
    expect(dept.metrics.manhoursPaid).toBe(3680);
  });

  it("derives worked hours from the calendar when no override is stored", () => {
    const [dept] = aggregateDepartmentMetrics(
      [mkPos({ departmentCode: "HK", headcount: 1, dailyContractHours: 8, vacationDays: 0 })],
      CALENDAR
    );
    // (300 productive days - 0 vacation) * 8 daily * 1 hc = 2400
    expect(dept.metrics.manhoursWorked).toBe(2400);
  });
});

describe("computeAllocationColumn", () => {
  const departments: DepartmentAgg[] = [
    { departmentCode: "HK", metrics: metricsWith({ headcount: 60, fte: 50 }) },
    { departmentCode: "FD", metrics: metricsWith({ headcount: 30, fte: 30 }) },
    { departmentCode: "LN", metrics: metricsWith({ headcount: 10, fte: 5 }) },
  ];

  it("normalizes the base to percentages summing to 100", () => {
    const col = computeAllocationColumn(alloc({ spreadBase: "HEADCOUNT" }), departments);
    expect(col.get("HK")).toBeCloseTo(60);
    expect(col.get("FD")).toBeCloseTo(30);
    expect(col.get("LN")).toBeCloseTo(10);
    expect(sum(col)).toBeCloseTo(100);
  });

  it("zeros excluded departments and re-normalizes the rest to 100", () => {
    const col = computeAllocationColumn(
      alloc({ spreadBase: "HEADCOUNT", excludedDepartments: ["LN"] }),
      departments
    );
    expect(col.get("LN")).toBe(0);
    // HK:FD = 60:30 of 90 → 66.67 / 33.33
    expect(col.get("HK")).toBeCloseTo((60 / 90) * 100);
    expect(col.get("FD")).toBeCloseTo((30 / 90) * 100);
    expect(sum(col)).toBeCloseTo(100);
  });

  it("uses a different base independently (FTE)", () => {
    const col = computeAllocationColumn(alloc({ spreadBase: "FTE" }), departments);
    // fte 50:30:5 of 85
    expect(col.get("HK")).toBeCloseTo((50 / 85) * 100);
    expect(sum(col)).toBeCloseTo(100);
  });

  it("flat spreads equally across departments", () => {
    const col = computeAllocationColumn(alloc({ spreadBase: "FLAT" }), departments);
    expect(col.get("HK")).toBeCloseTo(100 / 3);
    expect(col.get("FD")).toBeCloseTo(100 / 3);
    expect(col.get("LN")).toBeCloseTo(100 / 3);
    expect(sum(col)).toBeCloseTo(100);
  });

  it("returns all zeros when the column total is zero (no divide-by-zero)", () => {
    const col = computeAllocationColumn(
      alloc({ spreadBase: "BASE_SALARY" }), // no salary metrics set → total 0
      departments
    );
    expect(col.get("HK")).toBe(0);
    expect(col.get("FD")).toBe(0);
    expect(col.get("LN")).toBe(0);
  });
});

describe("computeSpreadGrid", () => {
  it("produces a per-department map of allocationId → percent for every column", () => {
    const departments: DepartmentAgg[] = [
      { departmentCode: "HK", metrics: metricsWith({ headcount: 3, fte: 2 }) },
      { departmentCode: "FD", metrics: metricsWith({ headcount: 1, fte: 1 }) },
    ];
    const grid = computeSpreadGrid(
      [
        alloc({ id: "laundry", spreadBase: "HEADCOUNT" }),
        alloc({ id: "meal", spreadBase: "FTE" }),
      ],
      departments
    );
    expect(grid.get("HK")).toEqual({
      laundry: expect.closeTo(75, 5),
      meal: expect.closeTo((2 / 3) * 100, 5),
    });
    expect(grid.get("FD")!.laundry).toBeCloseTo(25);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function metricsWith(over: Partial<import("../compute").DeptMetrics>) {
  return {
    headcount: 0,
    fte: 0,
    manhoursWorked: 0,
    manhoursPaid: 0,
    baseSalary: 0,
    contractDays: 0,
    vacationDays: 0,
    ...over,
  };
}

function sum(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}
