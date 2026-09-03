/**
 * Vacation on an awkward season — the semantics Input Basis changed, at the
 * engine layer.
 *
 * `vacationDaysTaken` used to normalize the twelve weights by their own total
 * and THEN zero the months the position does not work, so leave weighted into an
 * inactive month was silently dropped — an implicit prorate whose size depended
 * on where the weights happened to sit. It now normalizes by Σ(weight × season),
 * so the months actually worked absorb whatever entitlement they are handed, and
 * the prorate is an explicit, visible property of the INPUT instead.
 *
 * These tests use a staggered season (every other month) rather than a
 * contiguous block, because a block hides the difference between "the months
 * that come first" and "the months that are worked".
 */

import { describe, expect, it } from "vitest";
import { referencePosition } from "../reference";
import { compile, simulate } from "../simulate";
import { MONTHS } from "../types";
import type { CostComponentDefinition, Position } from "../types";
import {
  defId,
  makeCalendar,
  makeDef,
  makeInput,
  makePosition,
  makeValue,
  posId,
} from "./fixtures";

/** Jan, Mar, May, Jul, Sep, Nov — six months worked, none of them adjacent. */
const STAGGERED: number[] = Array.from({ length: MONTHS }, (_v, m) =>
  m % 2 === 0 ? 1 : 0
);

const CALENDAR = makeCalendar(new Array(MONTHS).fill(30));

function vacationOf(position: Position, definitions: CostComponentDefinition[]) {
  return referencePosition(position, CALENDAR, definitions, [], []);
}

/**
 * The vacation series in DAYS. referencePosition exposes the priced series, and
 * the price of one day is a single constant for the row — base x twm / twd on
 * the salaried 30/360 basis — so dividing it back out is exact, and doing it
 * here rather than asserting on money keeps these tests about WHERE the leave
 * lands. Every position below has no merit increase, so incMul is 1 throughout.
 */
function vacationDaysOf(
  position: Position,
  definitions: CostComponentDefinition[] = [BASE]
): number[] {
  let twm = 0;
  let twd = 0;
  for (let m = 0; m < MONTHS; m++) {
    twm += position.seasonality[m];
    twd += 30 * position.seasonality[m];
  }
  const dayRate = (position.monthlyBaseSalary * twm) / twd;
  return [...vacationOf(position, definitions).vacation].map((cost) => cost / dayRate);
}

const BASE = makeDef({ id: "def-base", kind: "BASE_SALARY", label: "Base" });
const ACCRUAL = makeDef({
  id: "def-accrual",
  kind: "HOLIDAY_ACCRUAL",
  label: "Accrual",
  sortOrder: 1,
});
const VACATION_LEVY = makeDef({
  id: "def-vaclevy",
  spreadMethod: "PERCENT_OF",
  label: "Vacation Levy",
  sortOrder: 2,
  baseSelector: { kind: "VACATION" },
});
const HOURS = makeDef({
  id: "def-hours",
  kind: "STAT",
  statKind: "HOURS",
  label: "Hours Worked",
  sortOrder: 3,
});

function seasonalPosition(weights: number[], overrides: Partial<Position> = {}) {
  return makePosition({
    id: "p1",
    seasonality: STAGGERED,
    monthlyBaseSalary: 3_000,
    dailyContractHours: 8,
    vacationDays: 12,
    accrualDaysPerMonth: 2,
    yearlyHoursWorked: 900,
    vacationMonthlyWeights: weights,
    ...overrides,
  });
}

describe("leave lands inside the months that are worked", () => {
  it("places the whole entitlement across a staggered season", () => {
    const position = seasonalPosition(new Array(MONTHS).fill(1));
    const days = vacationDaysOf(position);

    let total = 0;
    for (let m = 0; m < MONTHS; m++) total += days[m];
    expect(total).toBeCloseTo(12, 10);
    // Two days in each of the six worked months, nothing in the six that are not.
    for (let m = 0; m < MONTHS; m++) {
      expect(days[m]).toBeCloseTo(m % 2 === 0 ? 2 : 0, 10);
    }
  });

  it("keeps the leave that a partly-misaimed weighting would have dropped", () => {
    // Two thirds of the weight sits in months this position does not work.
    // Before, the normalizer divided by all twelve weights and THEN zeroed the
    // inactive months, so eight of the twelve days quietly vanished. Now March
    // and July — the only worked months named — carry the whole entitlement
    // between them, in the 1:2 proportion the user actually asked for.
    const weights = new Array<number>(MONTHS).fill(0);
    weights[1] = 2; // February, not worked
    weights[2] = 1; // March, worked
    weights[5] = 2; // June, not worked
    weights[6] = 2; // July, worked
    const days = vacationDaysOf(seasonalPosition(weights));

    let total = 0;
    for (let m = 0; m < MONTHS; m++) total += days[m];
    expect(total).toBeCloseTo(12, 10);
    expect(days[2]).toBeCloseTo(4, 10);
    expect(days[6]).toBeCloseTo(8, 10);
  });

  it("places nothing when EVERY weight misses the season, and says so here", () => {
    // The one case where leave really is dropped. It is the existing "a zero
    // weight total places no vacation" rule seen from the other side: with no
    // worked month named, there is no statement about when the leave is taken,
    // and inventing an even spread would be putting words in the user's mouth.
    // It is visible rather than silent — the Vacation Cost column reads 0 —
    // and the fix is to weight a month the position actually works.
    const weights = Array.from({ length: MONTHS }, (_v, m) => (m % 2 === 1 ? 1 : 0));
    const days = vacationDaysOf(seasonalPosition(weights));
    for (let m = 0; m < MONTHS; m++) expect(days[m]).toBe(0);
  });

  it("honours weights that straddle the boundary, using only the live half", () => {
    // Weight 3 in March (worked) and 1 in April (not). All 12 days land in
    // March: April's share is not silently dropped, it was never April's.
    const weights = new Array<number>(MONTHS).fill(0);
    weights[2] = 3;
    weights[3] = 1;
    const days = vacationDaysOf(seasonalPosition(weights));

    expect(days[2]).toBeCloseTo(12, 10);
    expect(days[3]).toBe(0);
  });

  it("places nothing when every weight is zero", () => {
    const days = vacationDaysOf(seasonalPosition(new Array(MONTHS).fill(0)));
    for (let m = 0; m < MONTHS; m++) expect(days[m]).toBe(0);
  });

  it("scales a fractional month's share by how much of it is worked", () => {
    const half = [...STAGGERED];
    half[0] = 0.5;
    const days = vacationDaysOf(
      seasonalPosition(new Array(MONTHS).fill(1), { seasonality: half })
    );

    let total = 0;
    for (let m = 0; m < MONTHS; m++) total += days[m];
    expect(total).toBeCloseTo(12, 10);
    // January is worked at half strength, so it takes half of what March takes.
    expect(days[0]).toBeCloseTo(days[2] / 2, 10);
  });
});

describe("the invariants that hang off the same day series", () => {
  it("still telescopes the accrual to zero across a staggered season", () => {
    // The roll-forward provisions for exactly the days it releases. If the
    // earning leg and the taking leg ever stopped reading ONE day series this
    // would drift, and a seasonal row is where it would drift first.
    const weights = new Array<number>(MONTHS).fill(0);
    weights[4] = 2;
    weights[8] = 1;
    const lines = vacationOf(seasonalPosition(weights), [BASE, ACCRUAL]).lines;
    const accrual = lines.get(defId("def-accrual"))!;

    let total = 0;
    for (let m = 0; m < MONTHS; m++) total += accrual[m];
    expect(total).toBeCloseTo(0, 8);
  });

  it("adds back and removes exactly the same vacation hours", () => {
    // The HOURS stat adds the vacation hours into the yearly total, spreads by
    // days, then takes them out again by the weights. With the old all-twelve
    // normalizer those two only cancelled on a full-year row; a seasonal row
    // over-reported its hours by whatever the weights failed to remove.
    const weights = new Array<number>(MONTHS).fill(0);
    weights[6] = 1;
    const position = seasonalPosition(weights);
    const hours = vacationOf(position, [BASE, HOURS]).lines.get(defId("def-hours"))!;

    let total = 0;
    for (let m = 0; m < MONTHS; m++) total += hours[m];
    expect(total).toBeCloseTo(position.yearlyHoursWorked, 8);
  });

  it("prices a block that spreads over the VACATION base", () => {
    // A block reading the vacation base follows the same day series, so the
    // leave rescued from an inactive month reaches the block's cost too.
    const weights = new Array<number>(MONTHS).fill(0);
    weights[1] = 2; // February, not worked
    weights[2] = 1; // March, worked
    const position = seasonalPosition(weights);
    const definitions = [BASE, VACATION_LEVY];
    const values = [
      makeValue("p1", "def-vaclevy", { rate: 0.1 }),
    ];
    const reference = referencePosition(position, CALENDAR, definitions, [], values);
    const levy = reference.lines.get(defId("def-vaclevy"))!;

    let total = 0;
    for (let m = 0; m < MONTHS; m++) total += levy[m];
    expect(total).toBeGreaterThan(0);
    for (let m = 0; m < MONTHS; m++) {
      if (m % 2 === 1) expect(levy[m]).toBe(0);
    }
  });
});

describe("the VM agrees with the reference on all of it", () => {
  it("matches month for month over a staggered season and awkward weights", () => {
    // Both normalizers were edited in two files each (vacationDaysTaken and
    // hoursWorked, reference and VM). This is the shape that separates them:
    // weights that do not sum to 1, sitting on both sides of the active line.
    const weights = new Array<number>(MONTHS).fill(0);
    weights[0] = 0.4;
    weights[1] = 2.5; // inactive
    weights[6] = 1.1;
    weights[9] = 3; // inactive
    const position = seasonalPosition(weights, { meritIncreasePct: 0.05, increaseMonth: 7 });
    const definitions = [BASE, ACCRUAL, VACATION_LEVY, HOURS];
    const values = [
      makeValue("p1", "def-vaclevy", { rate: 0.1 }),
    ];

    const input = makeInput({ definitions, positions: [position], componentValues: values, calendar: CALENDAR });
    const compiled = compile(input);
    expect("plan" in compiled).toBe(true);
    if (!("plan" in compiled)) return;

    const reference = referencePosition(position, CALENDAR, definitions, [], values);
    for (const line of simulate(compiled.plan).positionLines(posId("p1"))) {
      const expected = reference.lines.get(line.component.id)!;
      for (let m = 0; m < MONTHS; m++) {
        expect(
          line.months[m],
          `${line.component.label} month ${m + 1}`
        ).toBeCloseTo(expected[m], 10);
      }
    }
  });
});
