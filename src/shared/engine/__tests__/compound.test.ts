/**
 * Compound (COMBINE) bases — the block whose "multiplier" is another block.
 *
 * COMPONENTS can only ever SUM its refs, so COMBINE is what expresses a
 * difference, a product or a ratio between two series. Three things are pinned
 * here because each is easy to get subtly wrong and none is visible in a total:
 *
 *  - the arithmetic itself, per operation, against hand-computed months;
 *  - the RATIO case: a line like cost ÷ hours is already a per-person figure, so
 *    a row standing for three identical people must NOT show three times it —
 *    that is what countExempt buys, and the contrast is asserted both ways;
 *  - dividing by a zero month books nothing rather than Infinity.
 *
 * Parity with reference.ts is asserted bit-for-bit throughout, since the VM's
 * COMBINE_ACC and the spec's resolveBase are two encodings of one formula.
 */

import { describe, expect, it } from "vitest";
import { referencePosition } from "../reference";
import { compile, simulate } from "../simulate";
import { BaseSelector, CombineOp, MONTHS } from "../types";
import { defId, makeDef, makeInput, makePosition, makeValue } from "./fixtures";

// Active all year, so seasonality never clouds the arithmetic, and standing for
// three identical heads — the case the ratio exemption is about.
const SEASONALITY = Array.from({ length: MONTHS }, () => 1);
const HEADCOUNT = 3;
const LEFT_MONTHLY = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
const RIGHT_MONTHLY = [2, 4, 5, 8, 10, 0, 20, 16, 18, 25, 22, 24]; // note the 0

/**
 * Two DIRECT_ABS lines as operands. DIRECT_ABS is deliberate: it passes its
 * values through verbatim (no seasonality, no headcount), so the expected
 * arithmetic below is exactly the numbers above and nothing else.
 */
function buildInput(op: CombineOp, countExempt: boolean, rate?: number) {
  const baseDef = makeDef({
    id: "def-base",
    kind: "BASE_SALARY",
    label: "Base Salary",
    accountCode: "610000",
    sortOrder: 0,
  });
  const leftDef = makeDef({
    id: "def-left",
    spreadMethod: "DIRECT_ABS",
    label: "Left",
    accountCode: "640000",
    sortOrder: 1,
  });
  const rightDef = makeDef({
    id: "def-right",
    spreadMethod: "DIRECT_ABS",
    label: "Right",
    accountCode: "641000",
    sortOrder: 2,
  });
  const selector: BaseSelector = {
    kind: "COMBINE",
    op,
    left: { kind: "COMPONENTS", componentIds: [defId("def-left")] },
    right: { kind: "COMPONENTS", componentIds: [defId("def-right")] },
    ...(rate === undefined ? {} : { rate }),
  };
  const combinedDef = makeDef({
    id: "def-combined",
    spreadMethod: "PERCENT_OF",
    label: "Combined",
    accountCode: "642000",
    sortOrder: 3,
    baseSelector: selector,
    countExempt,
  });

  return makeInput({
    definitions: [baseDef, leftDef, rightDef, combinedDef],
    positions: [
      makePosition({ id: "pos-1", headcount: HEADCOUNT, seasonality: SEASONALITY }),
    ],
    componentValues: [
      makeValue("pos-1", "def-left", { monthlyValues: LEFT_MONTHLY }),
      makeValue("pos-1", "def-right", { monthlyValues: RIGHT_MONTHLY }),
      // Only consulted when the selector does not pin its own rate.
      makeValue("pos-1", "def-combined", { rate: 1 }),
    ],
  });
}

function combinedMonths(
  op: CombineOp,
  countExempt: boolean,
  rate?: number
): number[] {
  const input = buildInput(op, countExempt, rate);
  const compiled = compile(input);
  if (!("plan" in compiled)) throw new Error("compile failed");
  const result = simulate(compiled.plan);

  const line = result
    .positionLines(input.positions[0].id)
    .find((l) => l.component.id === defId("def-combined"))!;

  // Same scenario through the spec — the two must agree exactly.
  const reference = referencePosition(
    input.positions[0],
    input.calendar,
    input.definitions,
    input.ssSchemes,
    input.componentValues
  );
  const refMonths = reference.lines.get(defId("def-combined"))!;
  for (let m = 0; m < MONTHS; m++) {
    expect(line.months[m]).toBe(refMonths[m]);
  }
  return [...line.months];
}

describe("COMBINE arithmetic", () => {
  it("adds, subtracts and multiplies the two sides month by month", () => {
    // Not ratios, so these keep the headcount multiplier like any other line.
    const add = combinedMonths("ADD", false);
    const sub = combinedMonths("SUB", false);
    const mul = combinedMonths("MUL", false);

    for (let m = 0; m < MONTHS; m++) {
      expect(add[m]).toBeCloseTo((LEFT_MONTHLY[m] + RIGHT_MONTHLY[m]) * HEADCOUNT, 9);
      expect(sub[m]).toBeCloseTo((LEFT_MONTHLY[m] - RIGHT_MONTHLY[m]) * HEADCOUNT, 9);
      expect(mul[m]).toBeCloseTo(LEFT_MONTHLY[m] * RIGHT_MONTHLY[m] * HEADCOUNT, 9);
    }
  });

  it("divides, and books nothing in a month whose divisor is zero", () => {
    const div = combinedMonths("DIV", true);

    for (let m = 0; m < MONTHS; m++) {
      const expected = RIGHT_MONTHLY[m] === 0 ? 0 : LEFT_MONTHLY[m] / RIGHT_MONTHLY[m];
      expect(div[m]).toBeCloseTo(expected, 9);
      expect(Number.isFinite(div[m])).toBe(true);
    }
    // June's divisor is 0 — the guard, not an Infinity leaking into the totals.
    expect(RIGHT_MONTHLY[5]).toBe(0);
    expect(div[5]).toBe(0);
  });

  it("subtraction goes negative rather than clamping at zero", () => {
    // Operands swapped so the smaller series leads — a credit line is a
    // legitimate result and must not be floored.
    const input = buildInput("SUB", false);
    const combined = input.definitions.find((d) => d.id === defId("def-combined"))!;
    combined.baseSelector = {
      kind: "COMBINE",
      op: "SUB",
      left: { kind: "COMPONENTS", componentIds: [defId("def-right")] },
      right: { kind: "COMPONENTS", componentIds: [defId("def-left")] },
    };

    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const line = simulate(compiled.plan)
      .positionLines(input.positions[0].id)
      .find((l) => l.component.id === defId("def-combined"))!;

    for (let m = 0; m < MONTHS; m++) {
      expect(line.months[m]).toBeCloseTo(
        (RIGHT_MONTHLY[m] - LEFT_MONTHLY[m]) * HEADCOUNT,
        9
      );
      expect(line.months[m]).toBeLessThan(0);
    }
  });
});

describe("countExempt — the ratio flag", () => {
  it("keeps a ratio per-person on a row standing for several people", () => {
    const exempt = combinedMonths("DIV", true);
    const scaled = combinedMonths("DIV", false);

    for (let m = 0; m < MONTHS; m++) {
      const ratio = RIGHT_MONTHLY[m] === 0 ? 0 : LEFT_MONTHLY[m] / RIGHT_MONTHLY[m];
      // Exempt: the cost per hour, whether the row counts one person or three.
      expect(exempt[m]).toBeCloseTo(ratio, 9);
      // Not exempt: the same figure trebled — right for money, wrong for a rate.
      expect(scaled[m]).toBeCloseTo(ratio * HEADCOUNT, 9);
    }
  });

  it("leaves non-ratio lines alone", () => {
    // The flag is opt-in per definition, so an ADD block is untouched by it.
    const add = combinedMonths("ADD", false);
    expect(add[0]).toBeCloseTo((LEFT_MONTHLY[0] + RIGHT_MONTHLY[0]) * HEADCOUNT, 9);
  });
});

describe("COMBINE rate", () => {
  it("uses the per-row multiplier when the selector pins no rate", () => {
    // makeValue above supplies rate 1, so the line IS the combination.
    expect(combinedMonths("ADD", false)[0]).toBeCloseTo(
      (LEFT_MONTHLY[0] + RIGHT_MONTHLY[0]) * HEADCOUNT,
      9
    );
  });

  it("lets a pinned rate override the stored value", () => {
    // What a block with no per-row column compiles to: rate lives on the
    // selector, so an absent (or stale) ComponentValue cannot zero the line.
    const halved = combinedMonths("ADD", false, 0.5);
    for (let m = 0; m < MONTHS; m++) {
      expect(halved[m]).toBeCloseTo(
        (LEFT_MONTHLY[m] + RIGHT_MONTHLY[m]) * 0.5 * HEADCOUNT,
        9
      );
    }
  });
});

describe("COMBINE validation", () => {
  it("rejects a nested compound — the VM saves only one operand", () => {
    const input = buildInput("MUL", false);
    const combined = input.definitions.find((d) => d.id === defId("def-combined"))!;
    combined.baseSelector = {
      kind: "COMBINE",
      op: "MUL",
      left: { kind: "BASE_SALARY" },
      right: {
        kind: "COMBINE",
        op: "ADD",
        left: { kind: "BASE_SALARY" },
        right: { kind: "VACATION" },
      },
    };

    const compiled = compile(input);
    expect("errors" in compiled).toBe(true);
    if ("errors" in compiled) {
      expect(compiled.errors.some((e) => e.code === "INVALID_BASE_REF")).toBe(true);
    }
  });

  it("reports a side that references a missing definition", () => {
    // collectBaseRefIds has to recurse, or a dangling ref inside a compound
    // would sail past validation and compile into a silently-zero operand.
    const input = buildInput("ADD", false);
    const combined = input.definitions.find((d) => d.id === defId("def-combined"))!;
    combined.baseSelector = {
      kind: "COMBINE",
      op: "ADD",
      left: { kind: "COMPONENTS", componentIds: [defId("def-left")] },
      right: { kind: "COMPONENTS", componentIds: [defId("def-nope")] },
    };

    const compiled = compile(input);
    expect("errors" in compiled).toBe(true);
    if ("errors" in compiled) {
      expect(compiled.errors.some((e) => e.code === "MISSING_DEF")).toBe(true);
    }
  });

  it("orders a compound after both sides, whichever way they are listed", () => {
    // The topological sort has to see through COMBINE; if it did not, the
    // operands could compile after the line that reads them and read zeroes.
    const input = buildInput("ADD", false);
    input.definitions.reverse();

    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);
    const line = result
      .positionLines(input.positions[0].id)
      .find((l) => l.component.id === defId("def-combined"))!;

    expect(line.months[0]).toBeCloseTo(
      (LEFT_MONTHLY[0] + RIGHT_MONTHLY[0]) * HEADCOUNT,
      9
    );
  });
});
