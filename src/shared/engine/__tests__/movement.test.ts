/**
 * movement — a MULTIPLIER booking the month-on-month CHANGE of its result
 * (balance → charge) via the MOVEMENT_LINE post-op.
 *
 * Pinned here because none of it is visible in a total:
 *
 *  - January is measured against the row's opening balance (ssOpeningBase,
 *    the SS column reused), every later month against the last ACTIVE month;
 *  - the hold policy: an inactive month books 0 and does NOT advance the
 *    previous balance, so the next worked month picks up the whole change and
 *    the year telescopes to (balance at the last active month − opening);
 *  - a January salary rise restates the whole balance in January by itself —
 *    the reason a provision is modelled as a balance in the first place;
 *  - the post-op composes with every PERCENT_OF lowering (scalar rate,
 *    monthlyRates, COMBINE, rateDefId), with DIRECT_ABS, with a downstream
 *    base, and with the count × cluster-weight tail.
 *
 * Parity with reference.ts is asserted bit-for-bit throughout — MOVEMENT_LINE
 * and the reference's movement block are two encodings of one subtraction.
 */

import { describe, expect, it } from "vitest";
import { referencePosition } from "../reference";
import { compile, simulate } from "../simulate";
import { CostComponentDefinition, MONTHS, Position, ScenarioInput } from "../types";
import { defId, makeDef, makeInput, makePosition, makeValue, rng } from "./fixtures";

const FULL_YEAR = Array.from({ length: MONTHS }, () => 1);
/** A running balance: 100 in January growing by 100 a month to 1200. */
const BALANCE = Array.from({ length: MONTHS }, (_, m) => 100 * (m + 1));

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

/** A balance typed as twelve monthly values, and a ×1 multiplier of it
 *  carrying `movement` — the provision-charge block. */
function provisionInput(opts: {
  opening?: number;
  seasonality?: number[];
  rate?: number;
  headcount?: number;
  hotelClusterWeight?: number;
  balance?: number[];
  position?: Partial<Position>;
  def?: Partial<CostComponentDefinition>;
}): ScenarioInput {
  return makeInput({
    definitions: [
      makeDef({ id: "def-base", kind: "BASE_SALARY", label: "Base Salary", accountCode: "610000", sortOrder: 0 }),
      makeDef({
        id: "def-balance",
        spreadMethod: "DIRECT_MONTHLY",
        label: "Provision Balance",
        accountCode: "628980",
        sortOrder: 1,
      }),
      makeDef({
        id: "def-charge",
        spreadMethod: "PERCENT_OF",
        label: "Provision Charge",
        accountCode: "628990",
        sortOrder: 2,
        movement: true,
        baseSelector: { kind: "COMPONENTS", componentIds: [defId("def-balance")] },
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
    componentValues: [
      makeValue("pos-1", "def-balance", { monthlyValues: opts.balance ?? BALANCE }),
      makeValue("pos-1", "def-charge", {
        rate: opts.rate ?? 1,
        ...(opts.opening === undefined ? {} : { ssOpeningBase: opts.opening }),
      }),
    ],
  });
}

describe("the movement of a balance", () => {
  it("books each month's balance less the previous one, January against the opening", () => {
    const months = lineMonths(provisionInput({ opening: 40 }), "def-charge");
    expect(months[0]).toBe(60);
    for (let m = 1; m < MONTHS; m++) expect(months[m]).toBe(100);
    // The year telescopes: closing balance less opening.
    expect(sum(months)).toBe(1200 - 40);
  });

  it("measures January against 0 when the row carries no opening balance", () => {
    const months = lineMonths(provisionInput({}), "def-charge");
    expect(months[0]).toBe(100);
    expect(sum(months)).toBe(1200);
  });

  it("scales with the per-row multiplier like any other line", () => {
    const months = lineMonths(provisionInput({ opening: 40, rate: 0.5 }), "def-charge");
    // Balance × 0.5 → 50, 100, … 600; January = 50 − 40.
    expect(months[0]).toBe(10);
    for (let m = 1; m < MONTHS; m++) expect(months[m]).toBe(50);
  });
});

describe("the inactive-month hold policy", () => {
  it("books 0 in a dark month and catches up from the last worked month after it", () => {
    const mayOff = [1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1];
    const months = lineMonths(provisionInput({ opening: 40, seasonality: mayOff }), "def-charge");
    expect(months[4]).toBe(0);
    // June: balance 600 less April's 400 — May neither booked nor advanced.
    expect(months[5]).toBe(200);
    for (let m = 0; m < MONTHS; m++) {
      if (m === 0) expect(months[m]).toBe(60);
      else if (m !== 4 && m !== 5) expect(months[m]).toBe(100);
    }
    expect(sum(months)).toBe(1200 - 40);
  });

  it("closes at the last worked month's balance when December is dark", () => {
    const decOff = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
    const months = lineMonths(provisionInput({ opening: 40, seasonality: decOff }), "def-charge");
    expect(months[11]).toBe(0);
    expect(sum(months)).toBe(1100 - 40);
  });

  it("books nothing, opening included, for a position with no active month", () => {
    const months = lineMonths(
      provisionInput({ opening: 40, seasonality: new Array(MONTHS).fill(0) }),
      "def-charge"
    );
    for (let m = 0; m < MONTHS; m++) expect(months[m]).toBe(0);
  });

  it("telescopes to the last active balance less the opening for any seasonality", () => {
    for (const seed of [3, 11, 97]) {
      const rand = rng(seed);
      const seasonality = Array.from({ length: MONTHS }, () => (rand() < 0.3 ? 0 : 1));
      const months = lineMonths(provisionInput({ opening: 75, seasonality }), "def-charge");
      let lastActive = -1;
      for (let m = 0; m < MONTHS; m++) {
        if (seasonality[m] > 0) lastActive = m;
        else expect(months[m], `seed ${seed} month ${m + 1}`).toBe(0);
      }
      const expected = lastActive < 0 ? 0 : BALANCE[lastActive] - 75;
      expect(sum(months), `seed ${seed}`).toBeCloseTo(expected, 9);
    }
  });
});

describe("restatement", () => {
  it("books a January salary rise as a restatement of the whole balance", () => {
    // The balance IS the salary (×1 of base pay, 1200/month → 1320 after a 10%
    // rise from January) and the opening is last year's closing balance. The
    // only movement in the year is January's restatement of 120.
    const months = lineMonths(
      provisionInput({
        opening: 1200,
        def: { baseSelector: { kind: "BASE_SALARY" } },
        position: { meritIncreasePct: 0.1, increaseMonth: 1 },
      }),
      "def-charge"
    );
    expect(months[0]).toBeCloseTo(120, 9);
    for (let m = 1; m < MONTHS; m++) expect(months[m]).toBe(0);
  });

  it("books a mid-year rise in the month it lands and nothing else", () => {
    const months = lineMonths(
      provisionInput({
        opening: 1200,
        def: { baseSelector: { kind: "BASE_SALARY" } },
        position: { meritIncreasePct: 0.1, increaseMonth: 7 },
      }),
      "def-charge"
    );
    for (let m = 0; m < MONTHS; m++) {
      if (m === 6) expect(months[m]).toBeCloseTo(120, 9);
      else expect(months[m]).toBe(0);
    }
  });
});

describe("composition with the rest of the engine", () => {
  it("commutes with the count × cluster-weight tail — the opening is per person", () => {
    const months = lineMonths(
      provisionInput({ opening: 40, headcount: 3, hotelClusterWeight: 0.5 }),
      "def-charge"
    );
    expect(months[0]).toBeCloseTo(60 * 1.5, 9);
    for (let m = 1; m < MONTHS; m++) expect(months[m]).toBeCloseTo(150, 9);
  });

  it("restates a month-varying rate's line (PCT_OF_ACC_M)", () => {
    const monthlyRates = Array.from({ length: MONTHS }, (_, m) => (m < 6 ? 0.5 : 1));
    const input = provisionInput({});
    input.componentValues = [
      makeValue("pos-1", "def-balance", { monthlyValues: BALANCE }),
      makeValue("pos-1", "def-charge", { monthlyRates }),
    ];
    const months = lineMonths(input, "def-charge");
    // Balance × rate: 50 … 300 then 700 … 1200. July jumps 300 → 700.
    for (let m = 0; m < MONTHS; m++) {
      expect(months[m], `month ${m + 1}`).toBe(m === 6 ? 400 : m < 6 ? 50 : 100);
    }
  });

  it("restates a COMBINE base's line after COMBINE_ACC", () => {
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
          movement: true,
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
        makeValue("pos-1", "def-combined", { rate: 1, ssOpeningBase: 5 }),
      ],
    });
    const months = lineMonths(input, "def-combined");
    // Balance 11, 22, … 132: January 11 − 5, then 11 a month.
    expect(months[0]).toBe(6);
    for (let m = 1; m < MONTHS; m++) expect(months[m]).toBe(11);
  });

  it("restates a block-valued multiplier (rateDefId) line", () => {
    const input = provisionInput({ opening: 0 });
    input.definitions.push(
      makeDef({
        id: "def-housing",
        spreadMethod: "FLAT_PER_ACTIVE_MONTH",
        label: "Housing",
        accountCode: "622000",
        sortOrder: 1.5,
      })
    );
    input.definitions.find((def) => def.id === defId("def-charge"))!.ruleRateDefIds = [
      defId("def-housing"),
    ];
    input.componentValues = [
      makeValue("pos-1", "def-balance", { monthlyValues: BALANCE }),
      makeValue("pos-1", "def-housing", { yearlyValue: 24 }), // 2/month
      makeValue("pos-1", "def-charge", { rateDefId: defId("def-housing") }),
    ];
    const months = lineMonths(input, "def-charge");
    // Balance × 2 → 200 … 2400: 200 a month.
    for (let m = 0; m < MONTHS; m++) expect(months[m]).toBe(200);
  });

  it("follows a DIRECT_ABS lowering, where the opening is a whole-line figure", () => {
    const input = provisionInput({ headcount: 3 });
    const charge = input.definitions.find((def) => def.id === defId("def-charge"))!;
    charge.spreadMethod = "DIRECT_ABS";
    delete charge.baseSelector;
    input.componentValues = [
      makeValue("pos-1", "def-balance", { monthlyValues: BALANCE }),
      makeValue("pos-1", "def-charge", { monthlyValues: BALANCE, ssOpeningBase: 40 }),
    ];
    const months = lineMonths(input, "def-charge");
    // Absolute: not headcount-scaled, so 60 not 180.
    expect(months[0]).toBe(60);
    for (let m = 1; m < MONTHS; m++) expect(months[m]).toBe(100);
  });

  it("feeds the movement to a downstream block that uses it as a base", () => {
    const input = provisionInput({ opening: 40 });
    input.definitions.push(
      makeDef({
        id: "def-on-top",
        spreadMethod: "PERCENT_OF",
        label: "Levy On Charge",
        accountCode: "620000",
        sortOrder: 3,
        baseSelector: { kind: "COMPONENTS", componentIds: [defId("def-charge")] },
      })
    );
    input.componentValues.push(makeValue("pos-1", "def-on-top", { rate: 0.1 }));
    const months = lineMonths(input, "def-on-top");
    // 10% of the MOVEMENT — 6 in January, 10 after — not 10% of the balance.
    expect(months[0]).toBeCloseTo(6, 9);
    for (let m = 1; m < MONTHS; m++) expect(months[m]).toBeCloseTo(10, 9);
  });

  it("runs after collapse when both flags arrive by sync (parity pinned)", () => {
    // The blocks repo refuses the pair; the engine still has to agree with
    // itself if a synced definition carries both. Collapse first: the whole
    // 7800 lands in June, so the movement is +7800 in June and −7800 in July.
    const months = lineMonths(
      provisionInput({ opening: 0, def: { collapseMonths: [6] } }),
      "def-charge"
    );
    for (let m = 0; m < MONTHS; m++) {
      expect(months[m], `month ${m + 1}`).toBe(m === 5 ? 7800 : m === 6 ? -7800 : 0);
    }
  });
});
