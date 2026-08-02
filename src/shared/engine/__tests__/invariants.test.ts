/**
 * Property/invariant tests: conservation of yearly totals, zero-activity
 * behaviour, input-order independence and incremental-recalc equivalence.
 */

import { describe, expect, it } from "vitest";
import { compile, simulate, recalc } from "../simulate";
import { MONTHS } from "../types";
import {
  makeDef,
  makeInput,
  makePosition,
  makeValue,
  posId,
  randomScenario,
  rng,
} from "./fixtures";

function sum(months: Float64Array): number {
  let total = 0;
  for (let m = 0; m < MONTHS; m++) total += months[m];
  return total;
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe("conservation invariants", () => {
  it("yearly-input spreads sum back to their yearly input under full seasonality", () => {
    const input = makeInput({
      definitions: [
        makeDef({ id: "base", kind: "BASE_SALARY" }),
        makeDef({ id: "flat", spreadMethod: "FLAT_PER_ACTIVE_MONTH" }),
        makeDef({ id: "daily", spreadMethod: "FLAT_PER_DAY" }),
        makeDef({ id: "weighted", spreadMethod: "WEIGHTED_BY_BASE" }),
        makeDef({ id: "direct", spreadMethod: "DIRECT_MONTHLY" }),
        makeDef({ id: "hours", kind: "STAT", statKind: "HOURS" }),
      ],
      positions: [
        makePosition({
          id: "p1",
          payType: "HOURLY", // uneven real-days calendar exercises the day spread
          monthlyBaseSalary: 3210.45,
          yearlyHoursWorked: 1780,
          vacationDays: 20,
          dailyContractHours: 8,
        }),
      ],
      componentValues: [
        makeValue("p1", "flat", { yearlyValue: 12345.67 }),
        makeValue("p1", "daily", { yearlyValue: 9876.54 }),
        makeValue("p1", "weighted", { yearlyValue: 4321.09 }),
        makeValue("p1", "direct", { monthlyValues: new Array(MONTHS).fill(11.5) }),
      ],
    });
    // Uneven productive-days calendar exercises the day-proportional spreads.
    input.calendar.realDays.set([21, 19, 22, 20, 21, 20, 22, 21, 20, 22, 19, 21]);

    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(posId("p1"));
    const line = (id: string) =>
      lines.find((entry) => (entry.component.id as string) === id)!.months;

    expect(sum(line("flat"))).toBeCloseTo(12345.67, 8);
    expect(sum(line("daily"))).toBeCloseTo(9876.54, 8);
    expect(sum(line("weighted"))).toBeCloseTo(4321.09, 8);
    expect(sum(line("direct"))).toBeCloseTo(11.5 * MONTHS, 8);
    // Vacation hours are added back and re-removed → yearly total conserved.
    expect(sum(line("hours"))).toBeCloseTo(1780, 8);
  });

  it("the holiday-accrual line nets to zero over the year, for every position", () => {
    // The accrual is a liability roll-forward: it earns exactly the days it
    // releases, so the closing balance is zero and the twelve movements
    // telescope away. This must hold whatever the inputs do — skewed vacation
    // weights, weights that total ≠ 1, weights parked in off-season months,
    // mid-year merit steps, hourly and salaried bases alike. randomScenario
    // generates all of those, which is why the assertion is fuzzed rather than
    // hand-built: the old 1/12-vs-normalized-weights formula drifted on each of
    // them independently.
    for (const seed of [1, 7, 42, 99, 2024]) {
      const input = randomScenario(seed, 12);
      const compiled = compile(input);
      if (!("plan" in compiled)) throw new Error("compile failed");
      const sim = simulate(compiled.plan);
      for (const position of input.positions) {
        const accrual = sim
          .positionLines(position.id)
          .find((entry) => (entry.component.id as string) === "def-accrual");
        if (!accrual) continue;
        // Scale the tolerance to the line's own size — a position with a 5k
        // salary and 30 days' leave swings ±10k, so a fixed epsilon would
        // either be vacuous for big rows or flaky for small ones.
        let magnitude = 0;
        for (let m = 0; m < MONTHS; m++) magnitude += Math.abs(accrual.months[m]);
        expect(
          Math.abs(sum(accrual.months)),
          `seed ${seed} ${position.id as string}`
        ).toBeLessThan(1e-9 * Math.max(magnitude, 1));
      }
    }
  });

  it("a position with zero seasonality produces all-zero lines", () => {
    const input = randomScenario(99, 3);
    input.positions[1].seasonality = new Array(MONTHS).fill(0);
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const lines = simulate(compiled.plan).positionLines(input.positions[1].id);
    for (const line of lines) {
      for (let m = 0; m < MONTHS; m++) {
        expect(line.months[m], `${line.component.label} month ${m + 1}`).toBe(0);
      }
    }
  });
});

describe("determinism invariants", () => {
  it("is independent of input array order, bit for bit", () => {
    const input = randomScenario(1234, 20);
    const rand = rng(555);
    const shuffledInput = {
      ...input,
      definitions: shuffled(input.definitions, rand),
      positions: shuffled(input.positions, rand),
      componentValues: shuffled(input.componentValues, rand),
      buyouts: shuffled(input.buyouts, rand),
    };

    const a = compile(input);
    const b = compile(shuffledInput);
    if (!("plan" in a) || !("plan" in b)) throw new Error("compile failed");
    const resultA = simulate(a.plan);
    const resultB = simulate(b.plan);

    expect(b.plan.aggKeys).toEqual(a.plan.aggKeys);
    expect(resultB.aggregates.values.length).toBe(resultA.aggregates.values.length);
    for (let i = 0; i < resultA.aggregates.values.length; i++) {
      expect(resultB.aggregates.values[i]).toBe(resultA.aggregates.values[i]);
    }
  });

  it("recalc over every position reproduces a fresh simulate, bit for bit", () => {
    const input = randomScenario(4321, 20);
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");

    const fresh = simulate(compiled.plan);
    const again = recalc(fresh.state, [...compiled.plan.positionIds]);

    for (let i = 0; i < fresh.state.values.length; i++) {
      expect(again.state.values[i]).toBe(fresh.state.values[i]);
    }
    for (let i = 0; i < fresh.aggregates.values.length; i++) {
      expect(again.aggregates.values[i]).toBe(fresh.aggregates.values[i]);
    }
  });

  it("recalc of a subset leaves untouched positions' lines intact", () => {
    const input = randomScenario(777, 10);
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");

    const result = simulate(compiled.plan);
    const before = Float64Array.from(result.state.values);
    recalc(result.state, [compiled.plan.positionIds[3]]);

    for (let i = 0; i < before.length; i++) {
      expect(result.state.values[i]).toBe(before[i]);
    }
  });
});
