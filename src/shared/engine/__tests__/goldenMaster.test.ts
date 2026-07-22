/**
 * Golden-master tests: end-to-end scenarios small enough to compute by hand,
 * pinning the engine to the legacy workbook's semantics. The comments show
 * the hand calculation next to every expectation.
 */

import { describe, expect, it } from "vitest";
import { compile, simulate } from "../simulate";
import { MONTHS, SsSchemeId } from "../types";
import {
  makeBuyout,
  makeDef,
  makeInput,
  makePosition,
  makeScheme,
  makeValue,
  posId,
} from "./fixtures";

function months(lines: ReturnType<ReturnType<typeof simulate>["positionLines"]>, id: string) {
  const line = lines.find((entry) => (entry.component.id as string) === id);
  if (!line) throw new Error(`no line for ${id}`);
  return line.months;
}

function expectMonths(actual: Float64Array, expected: number[]): void {
  for (let m = 0; m < MONTHS; m++) {
    expect(actual[m], `month ${m + 1}`).toBeCloseTo(expected[m], 9);
  }
}

describe("golden master 1 — salaried, full year, no increase", () => {
  // SALARIED → 30/360 basis: gross = (1200×12/360)×30 = 1200 every month.
  const scheme = makeScheme({
    id: "sch",
    brackets: [
      { upTo: 6000, rate: 0.1 },
      { upTo: null, rate: 0.05 },
    ],
  });
  const definitions = [
    makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" }),
    makeDef({ id: "pension", spreadMethod: "PERCENT_OF", accountCode: "620000" }),
    makeDef({ id: "housing", spreadMethod: "FLAT_PER_ACTIVE_MONTH", accountCode: "622000" }),
    makeDef({ id: "transport", spreadMethod: "FLAT_PER_DAY", accountCode: "623000" }),
    makeDef({ id: "ss", kind: "SOCIAL_SECURITY", accountCode: "630000", ssSchemeId: "sch" as SsSchemeId }),
    makeDef({ id: "hc", kind: "STAT", statKind: "HEADCOUNT", accountCode: "972000" }),
    makeDef({ id: "fte", kind: "STAT", statKind: "FTE", accountCode: "972540" }),
    makeDef({ id: "hours", kind: "STAT", statKind: "HOURS", accountCode: "971000" }),
  ];
  const values = (id: string) => [
    makeValue(id, "pension", { rate: 0.05 }),
    makeValue(id, "housing", { yearlyValue: 2400 }),
    makeValue(id, "transport", { yearlyValue: 3600 }),
  ];

  it("reproduces the hand-computed monthly lines", () => {
    const input = makeInput({
      definitions,
      ssSchemes: [scheme],
      positions: [makePosition({ id: "p1", monthlyBaseSalary: 1200, yearlyHoursWorked: 1800 })],
      componentValues: values("p1"),
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(posId("p1"));

    const flat = (value: number) => new Array(MONTHS).fill(value);
    expectMonths(months(lines, "base"), flat(1200));
    expectMonths(months(lines, "pension"), flat(60)); // 5% of 1200
    expectMonths(months(lines, "housing"), flat(200)); // 2400 / 12 active months
    expectMonths(months(lines, "transport"), flat(300)); // 3600 / 360 days × 30
    // SS base = gross 1200/mo. Cum hits the 6000 bound exactly at May:
    // Jan–May 10% of 1200 = 120; from Jun the 5% bracket = 60.
    expectMonths(months(lines, "ss"), [120, 120, 120, 120, 120, 60, 60, 60, 60, 60, 60, 60]);
    expectMonths(months(lines, "hc"), flat(1));
    expectMonths(months(lines, "fte"), flat(1));
    // Hours: real-days basis (20/month, twd2 = 240): 1800/240 × 20 = 150.
    expectMonths(months(lines, "hours"), flat(150));
  });

  it("aggregates identical positions and merges buyout rows", () => {
    const input = makeInput({
      definitions,
      ssSchemes: [scheme],
      positions: [
        makePosition({ id: "p1", monthlyBaseSalary: 1200 }),
        makePosition({ id: "p2", monthlyBaseSalary: 1200 }),
      ],
      componentValues: [...values("p1"), ...values("p2")],
      buyouts: [
        makeBuyout("buy-1", "1010", "610000", new Array(MONTHS).fill(100)), // existing dept×account
        makeBuyout("buy-2", "9999", "700000", new Array(MONTHS).fill(7)), // brand-new key
      ],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);

    const row = (dept: string, account: string) =>
      result.aggregates.keys.findIndex((key) => key.dept === dept && key.account === account);

    const baseRow = row("1010", "610000");
    expect(baseRow).toBeGreaterThanOrEqual(0);
    // 2 positions × 1200 + 100 buyout = 2500 every month.
    for (let m = 0; m < MONTHS; m++) {
      expect(result.aggregates.values[baseRow * MONTHS + m]).toBeCloseTo(2500, 9);
    }

    const buyoutRow = row("9999", "700000");
    expect(buyoutRow).toBeGreaterThanOrEqual(0);
    for (let m = 0; m < MONTHS; m++) {
      expect(result.aggregates.values[buyoutRow * MONTHS + m]).toBe(7);
    }

    // Stats: both positions share (cluster, jobType) → headcount 2, FTE 2.
    expect(result.stats.keys.length).toBe(1);
    expect(result.stats.headcount[0]).toBe(2);
    expect(result.stats.fte[0]).toBe(2);
  });
});

describe("golden master 2 — hourly seasonal with mid-year increase, vacation and accrual", () => {
  it("reproduces the hand-computed lines", () => {
    // Seasonality Apr–Dec (9 months), 20 real days/month → twm 9, twd 180.
    // Day rate: 900 × 9 / 180 = 45 → 45 × 20 = 900/month before increase.
    // From Jul: ×1.10 merit + manual 90 over 6 active months = +15 → 1005.
    // Vacation (all in Aug): adjusted day pay 30/9×12 = 40;
    //   10 days × 40 × 1.10 = 440.
    // Accrual: 1 day × 30/day → 30 before Jul, 33 after; Aug nets 33 − 440.
    const definitions = [
      makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" }),
      makeDef({ id: "accrual", kind: "HOLIDAY_ACCRUAL", accountCode: "611000" }),
      makeDef({ id: "pension", spreadMethod: "PERCENT_OF", accountCode: "620000" }),
    ];
    const seasonality = [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const weights = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    const input = makeInput({
      definitions,
      positions: [
        makePosition({
          id: "p1",
          payType: "HOURLY",
          seasonality,
          monthlyBaseSalary: 900,
          meritIncreasePct: 0.1,
          manualYearlyIncrease: 90,
          increaseMonth: 7,
          vacationDays: 10,
          dailyVacationCost: 30,
          vacationMonthlyWeights: weights,
          accrualDaysPerMonth: 1,
          accrualCostPerDay: 30,
        }),
      ],
      componentValues: [makeValue("p1", "pension", { rate: 0.1 })],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(posId("p1"));

    expectMonths(
      months(lines, "base"),
      [0, 0, 0, 900, 900, 900, 1005, 1005 - 440, 1005, 1005, 1005, 1005]
    );
    expectMonths(
      months(lines, "accrual"),
      [0, 0, 0, 30, 30, 30, 33, 33 - 440, 33, 33, 33, 33]
    );
    // Pension runs on the GROSS base — Aug's vacation deduction must not leak in.
    expectMonths(
      months(lines, "pension"),
      [0, 0, 0, 90, 90, 90, 100.5, 100.5, 100.5, 100.5, 100.5, 100.5]
    );
  });
});

describe("golden master 3 — weighted, direct, qty×rate and hours redistribution", () => {
  it("reproduces the hand-computed lines", () => {
    const definitions = [
      makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" }),
      makeDef({ id: "indemnity", spreadMethod: "WEIGHTED_BY_BASE", accountCode: "621000" }),
      makeDef({ id: "custom", spreadMethod: "DIRECT_MONTHLY", accountCode: "624000" }),
      makeDef({ id: "overtime", spreadMethod: "QTY_TIMES_RATE", accountCode: "625000" }),
      makeDef({ id: "hc", kind: "STAT", statKind: "HEADCOUNT", accountCode: "972000" }),
      makeDef({ id: "fte", kind: "STAT", statKind: "FTE", accountCode: "972540" }),
      makeDef({ id: "hours", kind: "STAT", statKind: "HOURS", accountCode: "971000" }),
    ];
    const input = makeInput({
      definitions,
      positions: [
        makePosition({
          id: "p1",
          monthlyBaseSalary: 1200,
          headcount: 2,
          fte: 1.5,
          yearlyHoursWorked: 1500,
          vacationDays: 5,
          dailyContractHours: 8,
        }),
      ],
      componentValues: [
        makeValue("p1", "indemnity", { yearlyValue: 1440 }),
        makeValue("p1", "custom", { monthlyValues: new Array(MONTHS).fill(10) }),
        makeValue("p1", "overtime", { qty: 120, unitRate: 15 }),
      ],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(posId("p1"));

    const flat = (value: number) => new Array(MONTHS).fill(value);
    // Indemnity: 1440 over a 14400 base, weighted by 1200/month → 120/month.
    expectMonths(months(lines, "indemnity"), flat(120));
    expectMonths(months(lines, "custom"), flat(10));
    // Overtime: 120h × 15 = 1800/year → 150/month.
    expectMonths(months(lines, "overtime"), flat(150));
    expectMonths(months(lines, "hc"), flat(2));
    expectMonths(months(lines, "fte"), flat(1.5));
    // Hours: vac hours 5×8 = 40 added back (total 1540), spread over twd2 240
    // → 128.33/month, minus 40 × uniform 1/12 weights = 3.33 → 125/month.
    expectMonths(months(lines, "hours"), flat(125));
  });
});
