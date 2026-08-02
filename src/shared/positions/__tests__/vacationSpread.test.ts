/**
 * Vacation weights → holiday accrual: the spread has to be able to express an
 * EVEN year.
 *
 * The accrual is a liability roll-forward (see reference.holidayAccrual): it
 * earns the year's leave evenly across worked months and releases it on these
 * weights, so it reads zero month by month only when the twelve weights are
 * exactly equal to each other. Two things used to make that impossible:
 *
 *   1. sanitizeRow rounded every numeric to the field's `decimals` (4 here), so
 *      an even spread — 1/12 = 8.3333…% — could not be stored at all.
 *   2. The "total must be 100%" cue pushed users to hand-nudge one or two months
 *      (8.36, 8.40) to make the column add up, and that inequality IS the noise.
 *
 * The weights are relative proportions the engine normalizes by their own sum,
 * so the total is free — 8.33 twelve times (99.96%) is just as exact as 1/12.
 */

import { describe, expect, it } from "vitest";
import { compile, simulate } from "../../engine/simulate";
import { MONTHS } from "../../engine/types";
import { BUILTIN_CATALOG } from "../fieldSeed";
import { vectorKey } from "../fields";
import { PositionRow, sanitizeRow } from "../rowModel";
import {
  makeDef,
  makeInput,
  makePosition,
  posId,
} from "../../engine/__tests__/fixtures";

const WEIGHT = "vacationMonthlyWeights";

function rowWithWeights(weights: number[]): PositionRow {
  const row: PositionRow = { id: "p1", payType: "SALARIED", increaseMonth: 13 };
  for (let m = 1; m <= MONTHS; m++) {
    row[vectorKey("seasonality", m)] = 1;
    row[vectorKey(WEIGHT, m)] = weights[m - 1];
  }
  return row;
}

function storedWeights(weights: number[]): number[] {
  const out = sanitizeRow(rowWithWeights(weights), rowWithWeights(weights), BUILTIN_CATALOG);
  return Array.from({ length: MONTHS }, (_, m) => out[vectorKey(WEIGHT, m + 1)] as number);
}

/** The holiday-accrual line for a full-year salaried post with a mid-year rise —
 *  the shape that exposed the drift (merit step in Mar, leave skewed to Dec). */
function accrualLine(weights: number[]): number[] {
  const input = makeInput({
    definitions: [
      makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" }),
      makeDef({ id: "accrual", kind: "HOLIDAY_ACCRUAL", accountCode: "611000" }),
    ],
    positions: [
      makePosition({
        id: "p1",
        monthlyBaseSalary: 3000,
        meritIncreasePct: 0.01387,
        increaseMonth: 3,
        vacationDays: 24,
        vacationMonthlyWeights: weights,
        accrualDaysPerMonth: 2,
      }),
    ],
  });
  const compiled = compile(input);
  if (!("plan" in compiled)) throw new Error("compile failed");
  const line = simulate(compiled.plan)
    .positionLines(posId("p1"))
    .find((entry) => (entry.component.id as string) === "accrual")!.months;
  return Array.from({ length: MONTHS }, (_, m) => line[m]);
}

describe("sanitizeRow keeps vacation weights at full precision", () => {
  it("stores an even 1/12 spread without rounding it to 4 decimals", () => {
    const stored = storedWeights(new Array(MONTHS).fill(1 / MONTHS));
    for (const weight of stored) expect(weight).toBe(1 / MONTHS);
  });

  it("floors at zero but allows a weight above 1", () => {
    // Seed v25 dropped the max-1 clamp: these are weights, not percentages, so
    // "this month takes 4× a normal month" is a legitimate entry.
    const stored = storedWeights([-0.5, 4, ...new Array(MONTHS - 2).fill(1)]);
    expect(stored[0]).toBe(0);
    expect(stored[1]).toBe(4);
  });

  it("leaves other numeric fields rounded — the exemption is weights-only", () => {
    const row = rowWithWeights(new Array(MONTHS).fill(1 / MONTHS));
    row.meritIncreasePct = 0.0833333333;
    const out = sanitizeRow(row, row, BUILTIN_CATALOG);
    expect(out.meritIncreasePct).toBe(0.0833);
  });
});

describe("an even spread makes the accrual read zero every month", () => {
  it("is exactly zero for an exact 1/12 spread", () => {
    for (const value of accrualLine(new Array(MONTHS).fill(1 / MONTHS))) {
      expect(value).toBe(0);
    }
  });

  it("is exactly zero for twelve equal 8.33% weights, total 99.96%", () => {
    // The total is free — the engine normalizes by it. Equality is what counts.
    for (const value of accrualLine(new Array(MONTHS).fill(0.0833))) {
      expect(value).toBe(0);
    }
  });

  it("drifts once a month is nudged to force the total to exactly 100%", () => {
    // Ten months at 8.33, Oct 8.36, Nov 8.40, Dec 16.65, Jan 0 — the hand-balanced
    // shape that produced the reported 0.28 / −2.29 / −5.72 residue.
    const line = accrualLine([0, ...new Array(8).fill(0.0833), 0.0836, 0.084, 0.1665]);
    expect(line[1]).not.toBe(0);
    expect(line[9]).not.toBe(0);
    expect(line[10]).not.toBe(0);
  });

  it("is zero in the untouched months when the same shape is exact", () => {
    // Jan empty, Dec double, the other ten even — expressed as proportions.
    const line = accrualLine([0, ...new Array(10).fill(1 / MONTHS), 2 / MONTHS]);
    for (let m = 1; m <= 10; m++) {
      if (m === 2) continue; // Mar carries the merit remeasurement, by design.
      expect(line[m], `month ${m + 1}`).toBe(0);
    }
    expect(line[0]).toBeGreaterThan(0); // Jan accrues, nothing taken
    expect(line[11]).toBeLessThan(0); // Dec releases the year
  });

  it("is exactly zero for twelve weights of 1 — the seed-v25 default", () => {
    for (const value of accrualLine(new Array(MONTHS).fill(1))) expect(value).toBe(0);
  });

  it("reads a month set to 2 as taking twice a month set to 1", () => {
    // The shape the percent skin could not express: Jan off, Dec double, the
    // other ten even. As weights it is just 0 / 1×10 / 2.
    const line = accrualLine([0, ...new Array(10).fill(1), 2]);
    for (let m = 1; m <= 10; m++) {
      if (m === 2) continue; // Mar carries the merit remeasurement, by design.
      expect(line[m], `month ${m + 1}`).toBe(0);
    }
    expect(line[0]).toBeGreaterThan(0);
    expect(line[11]).toBeLessThan(0);
  });

  it("accepts plain relative numbers — 0 / 0.5 / 1 — for the same shape", () => {
    // The total here is 600%, which the grid reddens and the engine ignores.
    // Typing proportions sidesteps the "what is a twelfth to 2dp" problem
    // entirely: 0.5 and 1 are exact in binary, 8.3333…% never is.
    const line = accrualLine([0, ...new Array(10).fill(0.5), 1]);
    for (let m = 1; m <= 10; m++) {
      if (m === 2) continue; // Mar carries the merit remeasurement.
      expect(line[m], `month ${m + 1}`).toBe(0);
    }
  });

  it("shows real drift when Jan is emptied but the rest are left even", () => {
    // Jan 0 and eleven equal months is NOT the user's intent-free case: the
    // eleven each take a eleventh while earning a twelfth, so a small negative
    // in each is arithmetically correct, not noise. Documented so nobody
    // "fixes" it later.
    const line = accrualLine([0, ...new Array(11).fill(1 / MONTHS)]);
    expect(line[0]).toBeGreaterThan(0);
    for (let m = 1; m < MONTHS; m++) expect(line[m]).toBeLessThan(0);
  });

  it("nets to zero over the year whichever spread is used", () => {
    for (const weights of [
      new Array(MONTHS).fill(1 / MONTHS),
      new Array(MONTHS).fill(0.0833),
      [0, ...new Array(8).fill(0.0833), 0.0836, 0.084, 0.1665],
      [0, ...new Array(10).fill(1 / MONTHS), 2 / MONTHS],
    ]) {
      const total = accrualLine(weights).reduce((a, b) => a + b, 0);
      expect(Math.abs(total)).toBeLessThan(1e-9);
    }
  });
});
