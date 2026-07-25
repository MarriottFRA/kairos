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
  makeCalendar,
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
    // A vacation/accrual day is now valued at that derived day rate (45), not a
    // stored input. Vacation (all in Aug, priced at Aug's 1.10 merit):
    //   10 days × 45 × 1.10 = 495.
    // Accrual: 1 day × 45/day → 45 before Jul, 49.5 after; Aug nets 49.5 − 495.
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
          vacationMonthlyWeights: weights,
          accrualDaysPerMonth: 1,
        }),
      ],
      componentValues: [makeValue("p1", "pension", { rate: 0.1 })],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(posId("p1"));

    expectMonths(
      months(lines, "base"),
      [0, 0, 0, 900, 900, 900, 1005, 1005 - 495, 1005, 1005, 1005, 1005]
    );
    expectMonths(
      months(lines, "accrual"),
      [0, 0, 0, 45, 45, 45, 49.5, 49.5 - 495, 49.5, 49.5, 49.5, 49.5]
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
    // headcount (Count) = 2, so every currency + FTE + hours line books twice
    // over; the HEADCOUNT stat line already reports the count itself, so it stays
    // 2. Per-unit figures are noted, then ×2.
    // Indemnity: 1440 over a 14400 base, weighted by 1200/month → 120/mo × 2.
    expectMonths(months(lines, "indemnity"), flat(240));
    expectMonths(months(lines, "custom"), flat(20)); // 10/mo × 2
    // Overtime: 120h × 15 = 1800/year → 150/month × 2.
    expectMonths(months(lines, "overtime"), flat(300));
    expectMonths(months(lines, "hc"), flat(2)); // count itself — not scaled
    expectMonths(months(lines, "fte"), flat(3)); // 1.5 FTE × 2 positions
    // Hours: vac hours 5×8 = 40 added back (total 1540), spread over twd2 240
    // → 128.33/month, minus 40 × uniform 1/12 weights = 3.33 → 125/month × 2.
    expectMonths(months(lines, "hours"), flat(250));
  });
});

describe("golden master 4 — hourly-rate base derivation", () => {
  it("derives the base from rate × hours and feeds it downstream", () => {
    // Hourly path: base = rate × dailyContractHours × realDays[m], spread over
    // real productive days (default calendar = 20/month), NOT the twm/twd
    // normalization. 30 × 8 × 20 = 4800/month, flat over a full seasonal year.
    // monthlyBaseSalary is set too but must be ignored — presence of hourlyRate
    // is the discriminator, so the hourly derivation wins.
    const definitions = [
      makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" }),
      makeDef({ id: "pension", spreadMethod: "PERCENT_OF", accountCode: "620000" }),
      makeDef({ id: "hc", kind: "STAT", statKind: "HEADCOUNT", accountCode: "972000" }),
      makeDef({ id: "hours", kind: "STAT", statKind: "HOURS", accountCode: "971000" }),
    ];
    const input = makeInput({
      definitions,
      positions: [
        makePosition({
          id: "p1",
          payType: "HOURLY",
          monthlyBaseSalary: 9999, // ignored — hourlyRate takes precedence
          hourlyRate: 30,
          dailyContractHours: 8,
          yearlyHoursWorked: 1800,
        }),
      ],
      componentValues: [makeValue("p1", "pension", { rate: 0.05 })],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(posId("p1"));

    const flat = (value: number) => new Array(MONTHS).fill(value);
    expectMonths(months(lines, "base"), flat(4800)); // 30 × 8 × 20
    expectMonths(months(lines, "pension"), flat(240)); // 5% of 4800 — base flows on
    expectMonths(months(lines, "hc"), flat(1));
    // Hours stat is independent of the salary derivation: 1800/240 × 20 = 150.
    expectMonths(months(lines, "hours"), flat(150));
  });
});

describe("golden master 5 — bank-holiday premium (hourly-only, staff × premium)", () => {
  // One bank holiday in Jan and one in Aug (holidayDays = 1 those months).
  // A worked holiday is valued at the per-working-day base pay = rate × hours =
  // 30 × 8 = 240 (hourly staff exclude the day from base, so it is fully extra).
  // Def knobs: staffFraction 0.5 × premium 2 → combinedMult 1.0 (half the crew at
  // double time = one whole day's pay). Increase-aware, so a holiday after a
  // mid-year merit rise costs more.
  const holidayDays = [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  const definitions = [
    makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" }),
    makeDef({
      id: "bankhol",
      kind: "BANK_HOLIDAY",
      accountCode: "612000",
      increaseAware: true,
      bankHolidayStaffFraction: 0.5,
      bankHolidayPremiumMultiplier: 2,
    }),
  ];

  it("prices hourly holidays, scales with the merit increase, and skips salaried staff", () => {
    const input = makeInput({
      definitions,
      calendar: makeCalendar(undefined, holidayDays),
      positions: [
        // Hourly, no increase → each holiday costs one day's pay = 240.
        makePosition({ id: "hourly", payType: "HOURLY", hourlyRate: 30, dailyContractHours: 8 }),
        // Hourly with a 10% merit rise from Jul → Aug's holiday is 240 × 1.1 = 264.
        makePosition({
          id: "hourly-inc",
          payType: "HOURLY",
          hourlyRate: 30,
          dailyContractHours: 8,
          meritIncreasePct: 0.1,
          increaseMonth: 7,
        }),
        // Salaried → base already pays the holiday, so no premium line.
        makePosition({ id: "salaried", monthlyBaseSalary: 1200 }),
        // Hourly, headcount 4 → per-unit 240, booked 4× = 960 (2 of 4 at double time).
        makePosition({
          id: "hourly-hc",
          payType: "HOURLY",
          hourlyRate: 30,
          dailyContractHours: 8,
          headcount: 4,
        }),
      ],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);

    const bh = (id: string) => months(result.positionLines(posId(id)), "bankhol");
    expectMonths(bh("hourly"), [240, 0, 0, 0, 0, 0, 0, 240, 0, 0, 0, 0]);
    expectMonths(bh("hourly-inc"), [240, 0, 0, 0, 0, 0, 0, 264, 0, 0, 0, 0]);
    expectMonths(bh("salaried"), new Array(MONTHS).fill(0));
    expectMonths(bh("hourly-hc"), [960, 0, 0, 0, 0, 0, 0, 960, 0, 0, 0, 0]);
  });

  it("produces no premium when a hourly position works a holiday-free calendar", () => {
    const input = makeInput({
      definitions,
      // Default calendar → holidayDays all zero.
      positions: [makePosition({ id: "h", payType: "HOURLY", hourlyRate: 30, dailyContractHours: 8 })],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(posId("h"));
    expectMonths(months(lines, "bankhol"), new Array(MONTHS).fill(0));
  });
});

describe("golden master 6 — hotel-cluster weight", () => {
  // A shared person: this hotel carries `hotelClusterWeight` of the position.
  // The weight rides the count-multiplier pass (coeff = headcount × weight), so
  // every currency/FTE/hours line flexes by it while the HEADCOUNT stat — a
  // person is still one person here — never does.
  const definitions = [
    makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" }),
    makeDef({ id: "indemnity", spreadMethod: "WEIGHTED_BY_BASE", accountCode: "621000" }),
    makeDef({ id: "custom", spreadMethod: "DIRECT_MONTHLY", accountCode: "624000" }),
    makeDef({ id: "overtime", spreadMethod: "QTY_TIMES_RATE", accountCode: "625000" }),
    makeDef({ id: "hc", kind: "STAT", statKind: "HEADCOUNT", accountCode: "972000" }),
    makeDef({ id: "fte", kind: "STAT", statKind: "FTE", accountCode: "972540" }),
    makeDef({ id: "hours", kind: "STAT", statKind: "HOURS", accountCode: "971000" }),
  ];
  const values = (id: string) => [
    makeValue(id, "indemnity", { yearlyValue: 1440 }),
    makeValue(id, "custom", { monthlyValues: new Array(MONTHS).fill(10) }),
    makeValue(id, "overtime", { qty: 120, unitRate: 15 }),
  ];
  const position = (id: string, overrides: Record<string, unknown>) =>
    makePosition({
      id,
      monthlyBaseSalary: 1200,
      fte: 1.5,
      yearlyHoursWorked: 1500,
      vacationDays: 5,
      dailyContractHours: 8,
      ...overrides,
    });

  it("halves every line except the HEADCOUNT stat (weight 0.5)", () => {
    // Golden master 3's per-unit figures, × 0.5 instead of × 2.
    const input = makeInput({
      definitions,
      positions: [position("p1", { hotelClusterWeight: 0.5 })],
      componentValues: values("p1"),
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);
    const lines = result.positionLines(posId("p1"));

    const flat = (value: number) => new Array(MONTHS).fill(value);
    // Base: gross 1200 minus the vacation deduction (5 days × day-rate 40 =
    // 200/yr, uniform weights → 16.67/mo) = 1183.33 per-unit, × 0.5.
    expectMonths(months(lines, "base"), flat((1200 - 200 / 12) * 0.5));
    expectMonths(months(lines, "indemnity"), flat(60)); // 120/mo per-unit × 0.5
    expectMonths(months(lines, "custom"), flat(5)); // 10 × 0.5
    expectMonths(months(lines, "overtime"), flat(75)); // 150 × 0.5
    expectMonths(months(lines, "hc"), flat(1)); // NEVER weighted
    expectMonths(months(lines, "fte"), flat(0.75)); // 1.5 × 0.5
    expectMonths(months(lines, "hours"), flat(62.5)); // 125 × 0.5

    // The dedicated staffing stats mirror the lines: heads stay whole, FTE flexes.
    expect(result.stats.headcount[0]).toBe(1);
    expect(result.stats.fte[0]).toBeCloseTo(0.75, 9);
  });

  it("composes with the Count: headcount 2 × weight 0.5 = coeff 1 (per-unit figures)", () => {
    const input = makeInput({
      definitions,
      positions: [position("p1", { headcount: 2, hotelClusterWeight: 0.5 })],
      componentValues: values("p1"),
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);
    const lines = result.positionLines(posId("p1"));

    const flat = (value: number) => new Array(MONTHS).fill(value);
    expectMonths(months(lines, "indemnity"), flat(120)); // per-unit — 2 × 0.5 cancels
    expectMonths(months(lines, "custom"), flat(10));
    expectMonths(months(lines, "hc"), flat(2)); // the Count itself, unweighted
    expectMonths(months(lines, "fte"), flat(1.5)); // 1.5 × 2 × 0.5
    expect(result.stats.headcount[0]).toBe(2); // both heads still count
    expect(result.stats.fte[0]).toBeCloseTo(1.5, 9);
  });

  it("computes social security on the FULL salary, then books the hotel's share", () => {
    // The bracket boundary pins the ordering: gross 1200/mo crosses the 6000
    // bound at May on the FULL salary → per-unit SS [120×5, 60×7], × 0.5.
    // Weighting the salary first (600/mo, bound at Oct) would give
    // [60×10, 30×2] — a different shape, so a wrong order cannot pass.
    const scheme = makeScheme({
      id: "sch",
      brackets: [
        { upTo: 6000, rate: 0.1 },
        { upTo: null, rate: 0.05 },
      ],
    });
    const input = makeInput({
      definitions: [
        makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" }),
        makeDef({ id: "ss", kind: "SOCIAL_SECURITY", accountCode: "630000", ssSchemeId: "sch" as SsSchemeId }),
      ],
      ssSchemes: [scheme],
      positions: [
        makePosition({ id: "p1", monthlyBaseSalary: 1200, hotelClusterWeight: 0.5 }),
      ],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(posId("p1"));

    expectMonths(months(lines, "ss"), [60, 60, 60, 60, 60, 30, 30, 30, 30, 30, 30, 30]);
  });

  it("rejects an out-of-range or non-finite weight at compile", () => {
    for (const weight of [0, -0.5, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const input = makeInput({
        definitions: [makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" })],
        positions: [makePosition({ id: "p1", hotelClusterWeight: weight })],
      });
      const compiled = compile(input);
      expect("errors" in compiled, String(weight)).toBe(true);
      if ("errors" in compiled) {
        expect(compiled.errors.some((error) => error.code === "INVALID_POSITION")).toBe(true);
      }
    }
  });
});
