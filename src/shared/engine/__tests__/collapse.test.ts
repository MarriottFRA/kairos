/**
 * collapseMonths — a MULTIPLIER's whole yearly result landing in chosen months
 * (the 13th/14th-period-salary shape), via the COLLAPSE_LINE post-op.
 *
 * Pinned here because none of it is visible in a total:
 *
 *  - the yearly figure is CONSERVED — collapse moves money between months,
 *    never creates or destroys it (while a chosen month is active);
 *  - the drop policy: a chosen-but-inactive month gets nothing, the remaining
 *    chosen active months split evenly, and when NO chosen month is active the
 *    whole cost is dropped — the engine's standing inactive-month invariant;
 *  - the post-op composes with every PERCENT_OF lowering (scalar rate,
 *    monthlyRates, COMBINE) and with the count × cluster-weight tail.
 *
 * Parity with reference.ts is asserted bit-for-bit throughout — COLLAPSE_LINE
 * and the reference's collapse block are two encodings of one formula, sharing
 * collapseWeights.
 */

import { describe, expect, it } from "vitest";
import { referencePosition } from "../reference";
import { compile, simulate } from "../simulate";
import { collapseWeights, CostComponentDefinition, MONTHS, Position, ScenarioInput } from "../types";
import { defId, makeDef, makeInput, makePosition, makeValue } from "./fixtures";

const FULL_YEAR = Array.from({ length: MONTHS }, () => 1);

function sum(months: ArrayLike<number>): number {
  let total = 0;
  for (let m = 0; m < MONTHS; m++) total += months[m];
  return total;
}

/** Runs one def's line through the VM, asserts bit-for-bit reference parity,
 *  and returns the months. */
function lineMonths(input: ScenarioInput, id: string): number[] {
  const compiled = compile(input);
  if (!("plan" in compiled)) throw new Error("compile failed");
  const line = simulate(compiled.plan)
    .positionLines(input.positions[0].id)
    .find((l) => l.component.id === defId(id))!;

  const reference = referencePosition(
    input.positions[0],
    input.calendar,
    input.definitions,
    input.ssSchemes,
    input.componentValues
  );
  const refMonths = reference.lines.get(defId(id))!;
  for (let m = 0; m < MONTHS; m++) {
    expect(line.months[m], `month ${m + 1}`).toBe(refMonths[m]);
  }
  return [...line.months];
}

/** A salaried position (gross 1200 every active month) with a 1/12 multiplier
 *  of base salary carrying `collapseMonths` — the 13th-salary block. */
function thirteenthInput(opts: {
  collapseMonths: number[];
  seasonality?: number[];
  rate?: number;
  headcount?: number;
  hotelClusterWeight?: number;
  position?: Partial<Position>;
  def?: Partial<CostComponentDefinition>;
}): ScenarioInput {
  return makeInput({
    definitions: [
      makeDef({ id: "def-base", kind: "BASE_SALARY", label: "Base Salary", accountCode: "610000", sortOrder: 0 }),
      makeDef({
        id: "def-13th",
        spreadMethod: "PERCENT_OF",
        label: "Thirteenth Salary",
        accountCode: "628900",
        sortOrder: 1,
        collapseMonths: opts.collapseMonths,
        ...opts.def,
      }),
    ],
    positions: [
      makePosition({
        id: "pos-1",
        seasonality: opts.seasonality ?? FULL_YEAR,
        headcount: opts.headcount ?? 1,
        hotelClusterWeight: opts.hotelClusterWeight ?? 1,
        ...opts.position,
      }),
    ],
    componentValues: [makeValue("pos-1", "def-13th", { rate: opts.rate ?? 1 / 12 })],
  });
}

describe("collapseWeights", () => {
  it("splits evenly over the chosen active months, dropping inactive ones", () => {
    const seas = [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1]; // June off
    expect(collapseWeights([6], FULL_YEAR)[5]).toBe(1);
    expect(collapseWeights([6, 12], FULL_YEAR)).toEqual([0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0.5]);
    // June inactive: December carries the whole figure.
    expect(collapseWeights([6, 12], seas)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    // No chosen month active: every weight zero — the cost is dropped.
    expect(collapseWeights([6], seas)).toEqual(new Array(MONTHS).fill(0));
  });

  it("ignores duplicates and out-of-range entries", () => {
    expect(collapseWeights([6, 6, 0, 13], FULL_YEAR)).toEqual(
      collapseWeights([6], FULL_YEAR)
    );
  });
});

describe("collapse into a single month", () => {
  it("books the whole yearly figure in the chosen month and nothing elsewhere", () => {
    const months = lineMonths(thirteenthInput({ collapseMonths: [6] }), "def-13th");
    // Uncollapsed: 100/month (1/12 of 1200). Collapsed: 1200 in June alone.
    expect(months[5]).toBeCloseTo(1200, 9);
    for (let m = 0; m < MONTHS; m++) if (m !== 5) expect(months[m]).toBe(0);
    expect(sum(months)).toBeCloseTo(1200, 9);
  });

  it("conserves the yearly total the spread form would have booked", () => {
    const spread = lineMonths(
      thirteenthInput({ collapseMonths: [6], def: { collapseMonths: undefined } }),
      "def-13th"
    );
    const collapsed = lineMonths(thirteenthInput({ collapseMonths: [6] }), "def-13th");
    expect(sum(collapsed)).toBeCloseTo(sum(spread), 9);
  });
});

describe("collapse into several months", () => {
  it("splits the yearly figure evenly across the chosen months", () => {
    const months = lineMonths(thirteenthInput({ collapseMonths: [6, 12] }), "def-13th");
    expect(months[5]).toBeCloseTo(600, 9);
    expect(months[11]).toBeCloseTo(600, 9);
    for (let m = 0; m < MONTHS; m++) {
      if (m !== 5 && m !== 11) expect(months[m]).toBe(0);
    }
  });

  it("flattens across every active month when all twelve are chosen", () => {
    const months = lineMonths(
      thirteenthInput({ collapseMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }),
      "def-13th"
    );
    for (let m = 0; m < MONTHS; m++) expect(months[m]).toBeCloseTo(100, 9);
  });
});

describe("the inactive-month drop policy", () => {
  // Active January–May only: the base sum is already prorated to 6000.
  const JAN_TO_MAY = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];

  it("shifts to the remaining chosen active month when one falls outside the plan", () => {
    const months = lineMonths(
      thirteenthInput({ collapseMonths: [3, 12], seasonality: JAN_TO_MAY }),
      "def-13th"
    );
    // December is inactive, so March carries the whole prorated figure: 500.
    expect(months[2]).toBeCloseTo(500, 9);
    for (let m = 0; m < MONTHS; m++) if (m !== 2) expect(months[m]).toBe(0);
  });

  it("drops the cost entirely when no chosen month is active", () => {
    const months = lineMonths(
      thirteenthInput({ collapseMonths: [12], seasonality: JAN_TO_MAY }),
      "def-13th"
    );
    for (let m = 0; m < MONTHS; m++) expect(months[m]).toBe(0);
  });
});

describe("composition with the rest of the engine", () => {
  it("commutes with the count × cluster-weight tail", () => {
    const months = lineMonths(
      thirteenthInput({ collapseMonths: [6], headcount: 3, hotelClusterWeight: 0.5 }),
      "def-13th"
    );
    expect(months[5]).toBeCloseTo(1200 * 3 * 0.5, 9);
    for (let m = 0; m < MONTHS; m++) if (m !== 5) expect(months[m]).toBe(0);
  });

  it("collapses the increased series when the base carries a merit step", () => {
    // 10% merit from July: base books 1200 ×6 + 1320 ×6 = 15120; 1/12 = 1260.
    const months = lineMonths(
      thirteenthInput({
        collapseMonths: [12],
        position: { meritIncreasePct: 0.1, increaseMonth: 7 },
      }),
      "def-13th"
    );
    expect(months[11]).toBeCloseTo(1260, 9);
    for (let m = 0; m < MONTHS; m++) if (m !== 11) expect(months[m]).toBe(0);
  });

  it("collapses Σ rate[m]·base[m] when the rate is month-varying", () => {
    const monthlyRates = Array.from({ length: MONTHS }, (_, m) => (m < 6 ? 0.01 : 0.02));
    const input = thirteenthInput({ collapseMonths: [6] });
    input.componentValues = [makeValue("pos-1", "def-13th", { monthlyRates })];
    const months = lineMonths(input, "def-13th");
    // 6×(0.01×1200) + 6×(0.02×1200) = 72 + 144 = 216, all in June.
    expect(months[5]).toBeCloseTo(216, 9);
    for (let m = 0; m < MONTHS; m++) if (m !== 5) expect(months[m]).toBe(0);
  });

  it("collapses a COMBINE base's line after COMBINE_ACC", () => {
    const LEFT = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const RIGHT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const input = makeInput({
      definitions: [
        makeDef({ id: "def-base", kind: "BASE_SALARY", label: "Base Salary", accountCode: "610000", sortOrder: 0 }),
        makeDef({ id: "def-left", spreadMethod: "DIRECT_ABS", label: "Left", accountCode: "640000", sortOrder: 1 }),
        makeDef({ id: "def-right", spreadMethod: "DIRECT_ABS", label: "Right", accountCode: "641000", sortOrder: 2 }),
        makeDef({
          id: "def-combined",
          spreadMethod: "PERCENT_OF",
          label: "Combined",
          accountCode: "642000",
          sortOrder: 3,
          collapseMonths: [6],
          baseSelector: {
            kind: "COMBINE",
            op: "ADD",
            left: { kind: "COMPONENTS", componentIds: [defId("def-left")] },
            right: { kind: "COMPONENTS", componentIds: [defId("def-right")] },
          },
        }),
      ],
      positions: [makePosition({ id: "pos-1", seasonality: FULL_YEAR })],
      componentValues: [
        makeValue("pos-1", "def-left", { monthlyValues: LEFT }),
        makeValue("pos-1", "def-right", { monthlyValues: RIGHT }),
        makeValue("pos-1", "def-combined", { rate: 1 }),
      ],
    });
    const months = lineMonths(input, "def-combined");
    expect(months[5]).toBeCloseTo(sum(LEFT) + sum(RIGHT), 9);
    for (let m = 0; m < MONTHS; m++) if (m !== 5) expect(months[m]).toBe(0);
  });

  it("collapses a block-valued multiplier (rateDefId) line", () => {
    const input = thirteenthInput({ collapseMonths: [6] });
    input.definitions.push(
      makeDef({
        id: "def-housing",
        spreadMethod: "FLAT_PER_ACTIVE_MONTH",
        label: "Housing",
        accountCode: "622000",
        sortOrder: 0.5,
      })
    );
    input.definitions.find((def) => def.id === defId("def-13th"))!.ruleRateDefIds = [
      defId("def-housing"),
    ];
    input.componentValues = [
      makeValue("pos-1", "def-housing", { yearlyValue: 24 }), // 2/month
      makeValue("pos-1", "def-13th", { rateDefId: defId("def-housing") }),
    ];
    const months = lineMonths(input, "def-13th");
    // base 1200 × housing 2, every month, collapsed: 28800 in June.
    expect(months[5]).toBeCloseTo(1200 * 2 * 12, 9);
    for (let m = 0; m < MONTHS; m++) if (m !== 5) expect(months[m]).toBe(0);
  });

  it("feeds the collapsed series to a downstream block that uses it as a base", () => {
    const input = thirteenthInput({ collapseMonths: [6] });
    input.definitions.push(
      makeDef({
        id: "def-on-top",
        spreadMethod: "PERCENT_OF",
        label: "Pension On 13th",
        accountCode: "620000",
        sortOrder: 2,
        baseSelector: { kind: "COMPONENTS", componentIds: [defId("def-13th")] },
      })
    );
    input.componentValues.push(makeValue("pos-1", "def-on-top", { rate: 0.1 }));
    const months = lineMonths(input, "def-on-top");
    // 10% of the COLLAPSED line — June only, not 10% of a spread 100/month.
    expect(months[5]).toBeCloseTo(120, 9);
    for (let m = 0; m < MONTHS; m++) if (m !== 5) expect(months[m]).toBe(0);
  });
});
