/**
 * Social security bracket/cap edge cases. The salaried fixture yields a gross
 * base of exactly 1000/month ((1000×12/360)×30), so every expectation below
 * is hand-checkable.
 */

import { describe, expect, it } from "vitest";
import { compile, simulate } from "../simulate";
import { MONTHS, SocialSecurityScheme } from "../types";
import { makeDef, makeInput, makePosition, makeScheme, makeValue, posId } from "./fixtures";

function runSs(
  scheme: SocialSecurityScheme,
  opts: { ssOpeningBase?: number } = {}
): { ss: Float64Array; pension: Float64Array } {
  // The opening base now rides the SS def's ComponentValue (per position, per
  // scheme), not a position scalar.
  const componentValues = [makeValue("p1", "pension", { rate: 0.1 })];
  if (opts.ssOpeningBase !== undefined) {
    componentValues.push(makeValue("p1", "ss", { ssOpeningBase: opts.ssOpeningBase }));
  }
  const input = makeInput({
    definitions: [
      makeDef({ id: "b", kind: "BASE_SALARY" }),
      makeDef({ id: "pension", spreadMethod: "PERCENT_OF" }),
      makeDef({ id: "ss", kind: "SOCIAL_SECURITY", ssSchemeId: scheme.id }),
    ],
    ssSchemes: [scheme],
    positions: [makePosition({ id: "p1", monthlyBaseSalary: 1000 })],
    componentValues,
  });
  const compiled = compile(input);
  if (!("plan" in compiled)) throw new Error("compile failed");
  const lines = simulate(compiled.plan).positionLines(posId("p1"));
  return {
    ss: lines.find((line) => (line.component.id as string) === "ss")!.months,
    pension: lines.find((line) => (line.component.id as string) === "pension")!.months,
  };
}

describe("social security", () => {
  it("single unbounded bracket with no caps is equivalent to PERCENT_OF", () => {
    const { ss, pension } = runSs(makeScheme({ id: "s", brackets: [{ upTo: null, rate: 0.1 }] }));
    for (let m = 0; m < MONTHS; m++) {
      // Equivalent within float noise: SS differences cumulative totals
      // (tax(cum) − tax(cumPrev)) so it is not bit-identical to rate × base.
      expect(ss[m]).toBeCloseTo(pension[m], 9);
      expect(ss[m]).toBeCloseTo(100, 9);
    }
  });

  it("applies the monthly cap to each month's base", () => {
    const { ss } = runSs(
      makeScheme({ id: "s", monthlyCap: 800, brackets: [{ upTo: null, rate: 0.1 }] })
    );
    for (let m = 0; m < MONTHS; m++) expect(ss[m]).toBeCloseTo(80, 9);
  });

  it("stops contributions once the yearly cap is reached, partially in the crossing month", () => {
    const { ss } = runSs(
      makeScheme({ id: "s", monthlyCap: 800, yearlyCap: 5000, brackets: [{ upTo: null, rate: 0.1 }] })
    );
    // Capped base 800/month: 6 full months = 4800, month 7 contributes the last 200.
    for (let m = 0; m < 6; m++) expect(ss[m]).toBeCloseTo(80, 9);
    expect(ss[6]).toBeCloseTo(20, 9);
    for (let m = 7; m < MONTHS; m++) expect(ss[m]).toBe(0);
  });

  it("charges the marginal rate when the cumulative base crosses a bracket mid-month", () => {
    const { ss } = runSs(
      makeScheme({
        id: "s",
        brackets: [
          { upTo: 5500, rate: 0.1 },
          { upTo: null, rate: 0.05 },
        ],
      })
    );
    // Months 1-5: fully inside the 10% bracket (cum 5000).
    for (let m = 0; m < 5; m++) expect(ss[m]).toBeCloseTo(100, 9);
    // Month 6: 500 at 10% + 500 at 5%.
    expect(ss[5]).toBeCloseTo(75, 9);
    // Months 7-12: fully in the 5% bracket.
    for (let m = 6; m < MONTHS; m++) expect(ss[m]).toBeCloseTo(50, 9);
  });

  it("leaves the excess untaxed when the last bracket is bounded", () => {
    const { ss } = runSs(makeScheme({ id: "s", brackets: [{ upTo: 3000, rate: 0.1 }] }));
    for (let m = 0; m < 3; m++) expect(ss[m]).toBeCloseTo(100, 9);
    for (let m = 3; m < MONTHS; m++) expect(ss[m]).toBe(0);
  });

  it("honours yearly cap and brackets together", () => {
    const { ss } = runSs(
      makeScheme({ id: "s", yearlyCap: 5500, brackets: [{ upTo: null, rate: 0.1 }] })
    );
    for (let m = 0; m < 5; m++) expect(ss[m]).toBeCloseTo(100, 9);
    expect(ss[5]).toBeCloseTo(50, 9);
    for (let m = 6; m < MONTHS; m++) expect(ss[m]).toBe(0);
  });
});

describe("social security — accumulation mode + tax year (2c)", () => {
  it("PER_PERIOD charges each month alone, ignoring the yearly cap", () => {
    // Cumulative, this yearly cap would stop after 5 months; per-period ignores it.
    const { ss } = runSs(
      makeScheme({
        id: "s",
        accumulationMode: "PER_PERIOD",
        yearlyCap: 500,
        brackets: [{ upTo: null, rate: 0.1 }],
      })
    );
    for (let m = 0; m < MONTHS; m++) expect(ss[m]).toBeCloseTo(100, 9);
  });

  it("PER_PERIOD re-applies the full bracket table every month", () => {
    // Base 1000/mo: 600@10% + 400@5% = 80 EVERY month (no cumulative crossing).
    const { ss } = runSs(
      makeScheme({
        id: "s",
        accumulationMode: "PER_PERIOD",
        brackets: [
          { upTo: 600, rate: 0.1 },
          { upTo: null, rate: 0.05 },
        ],
      })
    );
    for (let m = 0; m < MONTHS; m++) expect(ss[m]).toBeCloseTo(80, 9);
  });

  it("CUMULATIVE seeds from the opening base and resets at the tax-year start", () => {
    // opening 4500 + 1000/mo, bands 10% up to 5000 then 2%, tax year starts April.
    const { ss } = runSs(
      makeScheme({
        id: "s",
        taxYearStartMonth: 4,
        brackets: [
          { upTo: 5000, rate: 0.1 },
          { upTo: null, rate: 0.02 },
        ],
      }),
      { ssOpeningBase: 4500 }
    );
    // Jan continues from 4500: 4500→5000 @10% (50) + 5000→5500 @2% (10) = 60.
    expect(ss[0]).toBeCloseTo(60, 9);
    // Feb/Mar wholly in the 2% band.
    expect(ss[1]).toBeCloseTo(20, 9);
    expect(ss[2]).toBeCloseTo(20, 9);
    // April resets to 0 → fresh 10% band again.
    expect(ss[3]).toBeCloseTo(100, 9);
    expect(ss[6]).toBeCloseTo(100, 9);
    expect(ss[7]).toBeCloseTo(100, 9); // cum hits 5000 exactly
    expect(ss[8]).toBeCloseTo(20, 9); // now into the 2% band again
  });

  it("a January tax year discards the opening base (identical to pre-2c)", () => {
    const withOpening = runSs(
      makeScheme({ id: "s", brackets: [{ upTo: null, rate: 0.1 }] }),
      { ssOpeningBase: 9999 }
    ).ss;
    for (let m = 0; m < MONTHS; m++) expect(withOpening[m]).toBeCloseTo(100, 9);
  });
});
