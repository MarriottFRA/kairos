/**
 * Pool-spread tests — the contract a POOL_SPREAD block lives or dies by:
 * the pot is conserved, seasonality/cluster/headcount shape the SHARE rather
 * than scaling the result, and a month nobody is eligible for books nothing.
 */

import { describe, expect, it } from "vitest";
import type { BlockDto } from "../../blocks/ipc";
import type { ComponentValue, Position } from "../../engine/types";
import type { KpiSeriesSlice } from "../engineInput";
import {
  applyPoolSpread,
  buildPoolSpecs,
  isPoolEligible,
  resolvePoolPot,
  type PoolSpreadSpec,
} from "../poolSpread";

const MONTHS = 12;
const DEF = "blk-1:cost";

// Loose overrides: ids here are plain strings, not the branded PositionId.
function mkPos(over: Record<string, unknown>): Position {
  return {
    id: "p",
    scenarioId: "s",
    departmentCode: "",
    jobTypeCode: "",
    cluster: "",
    hotelClusterWeight: 1,
    payType: "SALARIED",
    headcount: 1,
    fte: 1,
    seasonality: Array(MONTHS).fill(1),
    monthlyBaseSalary: 0,
    hourlyRate: 0,
    additionalMonthlyCosts: Array(MONTHS).fill(0),
    meritIncreasePct: 0,
    manualYearlyIncrease: 0,
    increaseMonth: 13,
    dailyContractHours: 0,
    yearlyHoursWorked: 0,
    vacationDays: 0,
    vacationMonthlyWeights: Array(MONTHS).fill(1 / MONTHS),
    accrualDaysPerMonth: 0,
    updatedAt: "",
    ...over,
  } as unknown as Position;
}

function spec(over: Partial<PoolSpreadSpec> = {}): PoolSpreadSpec {
  return {
    costDefId: DEF,
    pot: Array(MONTHS).fill(1200),
    spreadBase: "HEADCOUNT",
    eligibilityMode: "RULE",
    departments: [],
    jobTypes: [],
    ...over,
  };
}

/** The pool line written for one position, or all-zero when none was. */
function sharesFor(out: ComponentValue[], positionId: string): number[] {
  const value = out.find(
    (v) => v.positionId === positionId && v.componentDefId === DEF
  );
  return value?.monthlyValues ?? Array(MONTHS).fill(0);
}

/** What the pool actually booked in each month, across everyone. */
function bookedByMonth(out: ComponentValue[], positions: Position[]): number[] {
  return Array.from({ length: MONTHS }, (_unused, m) =>
    positions.reduce((sum, p) => sum + sharesFor(out, p.id)[m], 0)
  );
}

describe("applyPoolSpread", () => {
  it("conserves the pot across every spread basis", () => {
    // Deliberately lopsided people, so an unconserved formula shows up.
    const positions = [
      mkPos({ id: "a", headcount: 2, fte: 0.5, monthlyBaseSalary: 3000, yearlyHoursWorked: 1800, vacationDays: 25 }),
      mkPos({ id: "b", headcount: 1, fte: 1, monthlyBaseSalary: 1500, yearlyHoursWorked: 900, vacationDays: 10 }),
      mkPos({ id: "c", headcount: 3, fte: 0.8, monthlyBaseSalary: 2200, yearlyHoursWorked: 2000, vacationDays: 30 }),
    ];
    const bases = [
      "HEADCOUNT",
      "FTE",
      "MANHOURS_WORKED",
      "BASE_SALARY",
      "VACATION_DAYS",
      "FLAT",
    ] as const;

    for (const spreadBase of bases) {
      const out = applyPoolSpread([spec({ spreadBase })], positions, []);
      for (const booked of bookedByMonth(out, positions)) {
        expect(booked).toBeCloseTo(1200, 8);
      }
    }
  });

  it("splits equally per head, so a row of 2 takes twice a row of 1", () => {
    const positions = [
      mkPos({ id: "a", headcount: 2 }),
      mkPos({ id: "b", headcount: 1 }),
    ];
    const out = applyPoolSpread([spec()], positions, []);
    expect(sharesFor(out, "a")[0]).toBeCloseTo(800, 8);
    expect(sharesFor(out, "b")[0]).toBeCloseTo(400, 8);
  });

  it("FLAT gives every row the same share regardless of headcount", () => {
    const positions = [
      mkPos({ id: "a", headcount: 2 }),
      mkPos({ id: "b", headcount: 1 }),
    ];
    const out = applyPoolSpread([spec({ spreadBase: "FLAT" })], positions, []);
    expect(sharesFor(out, "a")[0]).toBeCloseTo(600, 8);
    expect(sharesFor(out, "b")[0]).toBeCloseTo(600, 8);
  });

  it("halves a clustered position's share and still books the whole pot", () => {
    const positions = [
      mkPos({ id: "shared", hotelClusterWeight: 0.5 }),
      mkPos({ id: "local", hotelClusterWeight: 1 }),
    ];
    const out = applyPoolSpread([spec()], positions, []);
    expect(sharesFor(out, "shared")[0]).toBeCloseTo(400, 8);
    expect(sharesFor(out, "local")[0]).toBeCloseTo(800, 8);
    expect(bookedByMonth(out, positions)[0]).toBeCloseTo(1200, 8);
  });

  it("drops an out-of-season position from that month only, redistributing", () => {
    const seasonality = Array(MONTHS).fill(1);
    seasonality[0] = 0; // off in January
    const positions = [
      mkPos({ id: "seasonal", seasonality }),
      mkPos({ id: "yearRound" }),
    ];
    const out = applyPoolSpread([spec()], positions, []);

    expect(sharesFor(out, "seasonal")[0]).toBe(0);
    // The whole pot still lands — on the one person working that month.
    expect(sharesFor(out, "yearRound")[0]).toBeCloseTo(1200, 8);
    // February is shared normally again.
    expect(sharesFor(out, "seasonal")[1]).toBeCloseTo(600, 8);
    expect(sharesFor(out, "yearRound")[1]).toBeCloseTo(600, 8);
  });

  it("gives a half-active month half a share", () => {
    const seasonality = Array(MONTHS).fill(1);
    seasonality[0] = 0.5;
    const positions = [mkPos({ id: "half", seasonality }), mkPos({ id: "full" })];
    const out = applyPoolSpread([spec()], positions, []);
    expect(sharesFor(out, "half")[0]).toBeCloseTo(400, 8);
    expect(sharesFor(out, "full")[0]).toBeCloseTo(800, 8);
  });

  it("books nothing — no NaN, no throw — when no weight is eligible", () => {
    // Everyone out of season in January; February is normal.
    const seasonality = Array(MONTHS).fill(1);
    seasonality[0] = 0;
    const positions = [mkPos({ id: "a", seasonality }), mkPos({ id: "b", seasonality })];
    const out = applyPoolSpread([spec()], positions, []);

    for (const p of positions) {
      expect(sharesFor(out, p.id)[0]).toBe(0);
      expect(sharesFor(out, p.id).every(Number.isFinite)).toBe(true);
    }
    expect(bookedByMonth(out, positions)[0]).toBe(0);
    expect(bookedByMonth(out, positions)[1]).toBeCloseTo(1200, 8);
  });

  it("books nothing when a RULE matches nobody", () => {
    const positions = [mkPos({ id: "a", departmentCode: "D0010" })];
    const out = applyPoolSpread(
      [spec({ departments: ["D9999"] })],
      positions,
      []
    );
    expect(bookedByMonth(out, positions)[0]).toBe(0);
  });

  it("MANUAL spreads across the ticked rows only", () => {
    const positions = [mkPos({ id: "in" }), mkPos({ id: "out" })];
    const values = [
      { positionId: "in", componentDefId: DEF, rate: 1 },
      { positionId: "out", componentDefId: DEF, rate: 0 },
    ] as unknown as ComponentValue[];

    const out = applyPoolSpread(
      [spec({ eligibilityMode: "MANUAL" })],
      positions,
      values
    );
    expect(sharesFor(out, "in")[0]).toBeCloseTo(1200, 8);
    expect(sharesFor(out, "out")[0]).toBe(0);
  });

  it("MANUAL with nothing ticked spreads nothing", () => {
    const positions = [mkPos({ id: "a" }), mkPos({ id: "b" })];
    const out = applyPoolSpread(
      [spec({ eligibilityMode: "MANUAL" })],
      positions,
      []
    );
    expect(bookedByMonth(out, positions)[0]).toBe(0);
  });

  it("keeps a stored row's account override while overwriting its months", () => {
    const positions = [mkPos({ id: "a" })];
    const values = [
      {
        positionId: "a",
        componentDefId: DEF,
        rate: 1,
        accountCode: "A123456",
        monthlyValues: Array(MONTHS).fill(999),
      },
    ] as unknown as ComponentValue[];

    const out = applyPoolSpread(
      [spec({ eligibilityMode: "MANUAL" })],
      positions,
      values
    );
    const value = out.find((v) => v.positionId === "a");
    expect(value?.accountCode).toBe("A123456");
    expect(value?.monthlyValues?.[0]).toBeCloseTo(1200, 8);
    // The caller's array is untouched — both loaders pass loader-owned copies,
    // but nothing here should depend on that.
    expect(values[0].monthlyValues?.[0]).toBe(999);
  });

  it("zeroes a stored row whose position is no longer eligible", () => {
    const positions = [mkPos({ id: "a", departmentCode: "D0010" })];
    const values = [
      {
        positionId: "a",
        componentDefId: DEF,
        rate: 1,
        monthlyValues: Array(MONTHS).fill(999),
      },
    ] as unknown as ComponentValue[];

    const out = applyPoolSpread(
      [spec({ departments: ["D9999"] })],
      positions,
      values
    );
    expect(sharesFor(out, "a")).toEqual(Array(MONTHS).fill(0));
  });

  it("synthesizes rows compile will actually index", () => {
    // compile keys componentValues on a strict `deletedAt === null`; an
    // undefined would drop the whole pooled line with no error anywhere.
    const positions = [mkPos({ id: "a" })];
    const out = applyPoolSpread([spec()], positions, []);
    const added = out.find((v) => v.positionId === "a");
    expect(added?.deletedAt).toBeNull();
    expect(added?.updatedAt).toBe("");
  });

  it("leaves other blocks' values alone", () => {
    const positions = [mkPos({ id: "a" })];
    const other = {
      positionId: "a",
      componentDefId: "other:cost",
      rate: 0.05,
    } as unknown as ComponentValue;

    const out = applyPoolSpread([spec()], positions, [other]);
    expect(out.find((v) => v.componentDefId === "other:cost")).toBe(other);
  });
});

describe("isPoolEligible", () => {
  const position = { departmentCode: "D0010", jobTypeCode: "ASSOCIATE" };

  it("RULE with no filters includes everyone, tick or not", () => {
    const rule = {
      eligibilityMode: "RULE" as const,
      departments: [] as string[],
      jobTypes: [] as string[],
    };
    expect(isPoolEligible(rule, position, false)).toBe(true);
  });

  it("RULE requires BOTH filters to match when both are set", () => {
    const rule = {
      eligibilityMode: "RULE" as const,
      departments: ["D0010"],
      jobTypes: ["MANAGER"],
    };
    expect(isPoolEligible(rule, position, true)).toBe(false);
    expect(
      isPoolEligible({ ...rule, jobTypes: ["ASSOCIATE"] }, position, false)
    ).toBe(true);
  });

  it("MANUAL ignores the filters and uses the tick", () => {
    const manual = {
      eligibilityMode: "MANUAL" as const,
      departments: ["D9999"],
      jobTypes: [] as string[],
    };
    expect(isPoolEligible(manual, position, true)).toBe(true);
    expect(isPoolEligible(manual, position, false)).toBe(false);
  });
});

describe("resolvePoolPot / buildPoolSpecs", () => {
  function block(over: Partial<BlockDto>): BlockDto {
    return {
      id: "blk-1",
      ou: "OU1",
      blockType: "POOL_SPREAD",
      label: "Gratuities",
      accountCode: "A600000",
      accountLocked: true,
      statsAccountCode: "",
      statsAccountLocked: true,
      spread: "ACTIVE_MONTHS",
      increaseAware: false,
      departmentMode: "POSITION",
      sortOrder: 10,
      updatedAt: "",
      costDefId: DEF,
      ...over,
    } as BlockDto;
  }

  const explicit: KpiSeriesSlice[] = [
    { deptKey: "*", values: Array.from({ length: MONTHS }, (_u, m) => m + 1) },
  ];

  it("takes the '*' series for an EXPLICIT driver", () => {
    const pot = resolvePoolPot(
      block({ poolSource: "KPI", poolKpiDriverId: "d1" }),
      () => explicit
    );
    expect(pot[0]).toBe(1);
    expect(pot[11]).toBe(12);
  });

  it("sums the per-department series of a POSITION driver into one pot", () => {
    const perDept: KpiSeriesSlice[] = [
      { deptKey: "D0010", values: Array(MONTHS).fill(10) },
      { deptKey: "D0020", values: Array(MONTHS).fill(5) },
    ];
    const pot = resolvePoolPot(
      block({ poolSource: "KPI", poolKpiDriverId: "d1" }),
      () => perDept
    );
    expect(pot).toEqual(Array(MONTHS).fill(15));
  });

  it("is all zeros with no driver attached", () => {
    const pot = resolvePoolPot(block({ poolSource: "KPI" }), () => explicit);
    expect(pot).toEqual(Array(MONTHS).fill(0));
  });

  it("takes the typed amounts for a MANUAL pot, padding short input", () => {
    const pot = resolvePoolPot(
      block({ poolSource: "MANUAL", poolMonthlyAmounts: [100, 200] }),
      () => []
    );
    expect(pot[0]).toBe(100);
    expect(pot[1]).toBe(200);
    expect(pot[2]).toBe(0);
    expect(pot).toHaveLength(MONTHS);
  });

  it("builds specs for pool blocks only", () => {
    const specs = buildPoolSpecs(
      [
        block({ poolSource: "MANUAL", poolMonthlyAmounts: Array(MONTHS).fill(1) }),
        block({ id: "blk-2", blockType: "FLAT_MONTHLY", costDefId: "blk-2:cost" }),
      ],
      () => []
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].costDefId).toBe(DEF);
    // Defaults land for a block saved before a field existed.
    expect(specs[0].spreadBase).toBe("HEADCOUNT");
    expect(specs[0].eligibilityMode).toBe("MANUAL");
  });
});
