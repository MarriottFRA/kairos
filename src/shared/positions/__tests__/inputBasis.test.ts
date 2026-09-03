/**
 * Input Basis — what period a row's yearly figures are stated for.
 *
 * The switch has one job and it is a semantic one, so these tests are mostly
 * about the awkward shapes rather than the happy path: seasons that are not
 * contiguous, fractional months, entitlements weighted into months the position
 * does not work, and rows that work no months at all.
 *
 * The headline property is the LAST describe block: a six-month post entered as
 * a six-month contract and the same post entered as a full-year contract it only
 * works half of must produce the same budget, month for month. If that holds,
 * the switch means what the column header says it means.
 */

import { describe, expect, it } from "vitest";
import {
  applyInputBasis,
  basisMonthsFor,
  basisScaleFor,
  deriveFte,
  readInputBasis,
  resolveYearlyHoursWorked,
} from "../engineInput";
import { MONTHS, Position } from "../../engine/types";
import { makeCalendar, makePosition } from "../../engine/__tests__/fixtures";
import { FullTimeReference } from "../../positionDefaults";

const FULL_TIME: FullTimeReference = { productiveDays: 253, dailyHours: 8 };
const CALENDAR = makeCalendar(new Array(MONTHS).fill(30));

/** Seasonality from a list of 1-based month numbers. */
function months(...active: number[]): number[] {
  const out = new Array<number>(MONTHS).fill(0);
  for (const m of active) out[m - 1] = 1;
  return out;
}

/** Every second month worked: Jan, Mar, May, Jul, Sep, Nov — twm 6, but split
 *  across the year rather than a block, which is what "staggered" breaks. */
const STAGGERED = months(1, 3, 5, 7, 9, 11);

/** A full year that lands on exactly the yardstick's 253 productive days, so a
 *  full-timer on it reads 1.00 and the seasonal cases below read clean halves. */
const FULL_YEAR_CONTRACT = {
  contractYearlyDays: 365,
  contractDaysOff: 104,
  contractPubHolidays: 8,
};

describe("reading the switch", () => {
  it("treats anything unrecognized as a full year", () => {
    expect(readInputBasis({})).toBe("TWELVE");
    expect(readInputBasis({ annualDivisorBasis: null })).toBe("TWELVE");
    expect(readInputBasis({ annualDivisorBasis: "" })).toBe("TWELVE");
    expect(readInputBasis({ annualDivisorBasis: "twelve" })).toBe("TWELVE");
    expect(readInputBasis({ annualDivisorBasis: "WORKING_MONTHS" })).toBe(
      "WORKING_MONTHS"
    );
  });
});

describe("the two numbers everything else is built from", () => {
  const contract = { annualDivisorBasis: "WORKING_MONTHS" };
  const fullYear = { annualDivisorBasis: "TWELVE" };

  it("is a no-op on the contract basis, whatever the shape of the season", () => {
    // Scale 1 means "use what was typed" — the divisor and the months worked are
    // the same number, so they cancel. True for a staggered season too: nothing
    // here cares WHERE the months are, only how many.
    expect(basisScaleFor(contract, STAGGERED)).toBe(1);
    expect(basisScaleFor(contract, months(1, 2, 3))).toBe(1);
    expect(basisMonthsFor(contract, STAGGERED)).toBe(6);
  });

  it("prorates by twm/12 on the full-year basis", () => {
    expect(basisMonthsFor(fullYear, STAGGERED)).toBe(MONTHS);
    expect(basisScaleFor(fullYear, STAGGERED)).toBeCloseTo(0.5, 12);
    expect(basisScaleFor(fullYear, new Array(MONTHS).fill(1))).toBe(1);
  });

  it("handles fractional months on both bases", () => {
    const half = new Array<number>(MONTHS).fill(0);
    half[0] = 0.5;
    half[1] = 0.25;
    expect(basisMonthsFor(contract, half)).toBeCloseTo(0.75, 12);
    expect(basisScaleFor(contract, half)).toBe(1);
    expect(basisScaleFor(fullYear, half)).toBeCloseTo(0.0625, 12);
  });

  it("returns 0 rather than NaN or Infinity for a post that never works", () => {
    const never = new Array<number>(MONTHS).fill(0);
    // Contract basis: dividing by its own zero months. The guard is what stops
    // an Infinity reaching the paramPool, where the engine's own zero checks
    // would not catch it (NaN === 0 is false).
    expect(basisMonthsFor(contract, never)).toBe(0);
    expect(basisScaleFor(contract, never)).toBe(0);
    expect(basisScaleFor(fullYear, never)).toBe(0);
    expect(Number.isFinite(basisScaleFor(contract, never))).toBe(true);
  });

  it("reads a missing seasonality vector as a full year, not as zero months", () => {
    // Absence is not "works no months": every default in the system is twelve
    // 1s, and reading it as zero would scale every figure on the row away.
    expect(basisScaleFor(fullYear, undefined as unknown as number[])).toBe(1);
    expect(basisScaleFor(fullYear, [])).toBe(1);
  });
});

describe("FTE", () => {
  const position = (seasonality: number[]): Position =>
    makePosition({ id: "p", seasonality, vacationDays: 25, dailyContractHours: 8 });

  it("reads 1.00 for a full-timer on the hotel's own contract", () => {
    const fte = deriveFte(
      makePosition({
        id: "p",
        seasonality: new Array(MONTHS).fill(1),
        vacationDays: 25,
        dailyContractHours: 8,
      }),
      { yearlyDays: 365, daysOff: 104, pubHolidays: 8 },
      FULL_TIME,
      MONTHS
    );
    expect(fte).toBeCloseTo(1, 10);
  });

  it("reads 0.50 for a full-year contract worked half the year", () => {
    const fte = deriveFte(
      position(STAGGERED),
      { yearlyDays: 365, daysOff: 104, pubHolidays: 8 },
      FULL_TIME,
      MONTHS
    );
    expect(fte).toBeCloseTo(0.5, 10);
  });

  it("still reads 0.50 when that same job is stated as a six-month contract", () => {
    // FTE is an ANNUAL ratio, so the answer cannot depend on how the contract
    // was written down. Half the days, half the leave, and a divisor of six that
    // cancels the six months worked — the prorate moves from the numerator to
    // the divisor and the result does not move at all.
    const fte = deriveFte(
      makePosition({
        id: "p",
        seasonality: STAGGERED,
        vacationDays: 12.5,
        dailyContractHours: 8,
      }),
      { yearlyDays: 365 / 2, daysOff: 52, pubHolidays: 4 },
      FULL_TIME,
      6
    );
    expect(fte).toBeCloseTo(0.5, 10);
  });

  it("is 0, not NaN, when the basis has no months to divide by", () => {
    const fte = deriveFte(
      position(new Array(MONTHS).fill(0)),
      { yearlyDays: 365, daysOff: 104, pubHolidays: 8 },
      FULL_TIME,
      0
    );
    expect(fte).toBe(0);
  });
});

describe("worked hours", () => {
  const position = makePosition({
    id: "p",
    seasonality: STAGGERED,
    vacationDays: 0,
    dailyContractHours: 8,
    yearlyHoursWorked: 0,
  });

  it("prorates a derived figure on the full-year basis", () => {
    const hours = resolveYearlyHoursWorked(0, position, FULL_YEAR_CONTRACT, CALENDAR);
    expect(hours).toBeCloseTo(((365 - 104 - 8) * 8) / 2, 10);
  });

  it("prorates a TYPED override the same way", () => {
    // The switch says what period every number on the row covers. An override
    // that escaped the prorate would mean the same 1,800 hours said two
    // different things depending on whether a person typed it.
    const hours = resolveYearlyHoursWorked(1_800, position, FULL_YEAR_CONTRACT, CALENDAR);
    expect(hours).toBe(900);
  });

  it("leaves both alone on the contract basis", () => {
    const source = { ...FULL_YEAR_CONTRACT, annualDivisorBasis: "WORKING_MONTHS" };
    expect(resolveYearlyHoursWorked(1_800, position, source, CALENDAR)).toBe(1_800);
    expect(resolveYearlyHoursWorked(0, position, source, CALENDAR)).toBeCloseTo(
      (365 - 104 - 8) * 8,
      10
    );
  });
});

describe("applyInputBasis", () => {
  function built(overrides: Partial<Position> = {}): Position {
    return makePosition({
      id: "p",
      seasonality: STAGGERED,
      vacationDays: 24,
      dailyContractHours: 8,
      yearlyHoursWorked: 0,
      manualYearlyIncrease: 1_200,
      ...overrides,
    });
  }

  it("nets vacation off the contract days BEFORE prorating either", () => {
    // The ordering guarantee. Contract days are a full-year count and so is the
    // entitlement, so they must meet at full size; scaling vacation first would
    // subtract 12 days from 252 and inflate the hours.
    const position = built();
    applyInputBasis(position, FULL_YEAR_CONTRACT, CALENDAR, FULL_TIME);
    expect(position.yearlyHoursWorked).toBeCloseTo(((365 - 104 - 8 - 24) * 8) / 2, 10);
    expect(position.vacationDays).toBe(12);
  });

  it("prorates the manual yearly increase", () => {
    const position = built();
    applyInputBasis(position, FULL_YEAR_CONTRACT, CALENDAR, FULL_TIME);
    expect(position.manualYearlyIncrease).toBe(600);
  });

  it("earns the accrual over the months worked, not over twelve", () => {
    const position = built();
    applyInputBasis(position, FULL_YEAR_CONTRACT, CALENDAR, FULL_TIME);
    // 12 days earned across 6 worked months.
    expect(position.accrualDaysPerMonth).toBe(2);
  });

  it("zeroes a row that works no months instead of writing NaN", () => {
    const position = built({ seasonality: new Array(MONTHS).fill(0) });
    applyInputBasis(position, FULL_YEAR_CONTRACT, CALENDAR, FULL_TIME);
    for (const value of [
      position.fte,
      position.yearlyHoursWorked,
      position.vacationDays,
      position.manualYearlyIncrease,
      position.accrualDaysPerMonth,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(0);
    }
  });

  it("changes nothing on a full-year row", () => {
    // The upgrade guarantee for the ordinary position: identical in, identical
    // out, whichever basis it happens to carry.
    for (const basis of ["TWELVE", "WORKING_MONTHS"]) {
      const position = built({ seasonality: new Array(MONTHS).fill(1) });
      const before = { ...position };
      applyInputBasis(
        position,
        { ...FULL_YEAR_CONTRACT, annualDivisorBasis: basis },
        CALENDAR,
        FULL_TIME
      );
      expect(position.vacationDays).toBe(before.vacationDays);
      expect(position.manualYearlyIncrease).toBe(before.manualYearlyIncrease);
      expect(position.yearlyHoursWorked).toBeCloseTo((365 - 104 - 8 - 24) * 8, 10);
    }
  });
});

describe("the two bases describe the same job", () => {
  /** The same six-month post, stated twice. */
  function statedAsFullYear(): { position: Position; source: Record<string, unknown> } {
    return {
      position: makePosition({
        id: "p",
        seasonality: STAGGERED,
        vacationDays: 24,
        dailyContractHours: 8,
        manualYearlyIncrease: 1_200,
        yearlyHoursWorked: 0,
      }),
      source: { ...FULL_YEAR_CONTRACT, annualDivisorBasis: "TWELVE" },
    };
  }

  function statedAsContract(): { position: Position; source: Record<string, unknown> } {
    return {
      position: makePosition({
        id: "p",
        seasonality: STAGGERED,
        // Half of everything: half the leave, half the increase, and a contract
        // that only spans the six months worked.
        vacationDays: 12,
        dailyContractHours: 8,
        manualYearlyIncrease: 600,
        yearlyHoursWorked: 0,
      }),
      source: {
        contractYearlyDays: 365 / 2,
        contractDaysOff: 104 / 2,
        contractPubHolidays: 8 / 2,
        annualDivisorBasis: "WORKING_MONTHS",
      },
    };
  }

  it("lands on the same engine input from either statement", () => {
    const a = statedAsFullYear();
    const b = statedAsContract();
    applyInputBasis(a.position, a.source, CALENDAR, FULL_TIME);
    applyInputBasis(b.position, b.source, CALENDAR, FULL_TIME);

    expect(b.position.fte).toBeCloseTo(a.position.fte, 10);
    expect(b.position.yearlyHoursWorked).toBeCloseTo(a.position.yearlyHoursWorked, 10);
    expect(b.position.vacationDays).toBeCloseTo(a.position.vacationDays, 10);
    expect(b.position.manualYearlyIncrease).toBeCloseTo(
      a.position.manualYearlyIncrease,
      10
    );
    expect(b.position.accrualDaysPerMonth).toBeCloseTo(
      a.position.accrualDaysPerMonth,
      10
    );
  });
});
