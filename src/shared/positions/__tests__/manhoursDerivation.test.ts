/**
 * Manhours Worked auto-derivation — the contract-driven replacement for the
 * old free-entry hours field. Both engine-input paths (loadScenarioInput,
 * runLiveSim) call resolveYearlyHoursWorked, so this pins the shared math.
 *
 * The day count is the ROW's own contract, not the hotel calendar: that is what
 * makes editing Days Off or Public Holidays on a position move its hours the way
 * it already moved Manhours Paid and FTE. The calendar survives only as the
 * fallback for a row that states no Yearly Days at all.
 */

import { describe, expect, it } from "vitest";
import { makeCalendarContext } from "../../engine/calendarContext";
import {
  ContractDays,
  deriveYearlyHoursWorked,
  resolveYearlyHoursWorked,
} from "../engineInput";

describe("Manhours Worked derivation", () => {
  // 21 net productive days each month = 252 productive days/year.
  const calendar = makeCalendarContext(Array(12).fill(21));
  const position = {
    vacationDays: 20,
    dailyContractHours: 8,
    // Full year: resolveYearlyHoursWorked reads seasonality for the Input Basis
    // prorate, which is a no-op here and exercised on its own in inputBasis.test.
    seasonality: Array(12).fill(1) as number[],
  };
  /** A full-year contract: 365 − 104 weekend − 9 holidays = 252 productive. */
  const contract: ContractDays = { yearlyDays: 365, daysOff: 104, pubHolidays: 9 };
  /** What a row written before the Contract defaults existed looks like. */
  const blank: ContractDays = { yearlyDays: 0, daysOff: 0, pubHolidays: 0 };

  it("derives (yearly days − days off − public holidays − vacation) × daily hours", () => {
    // (365 − 104 − 9 − 20) × 8 = 1856
    expect(deriveYearlyHoursWorked(position, contract, calendar)).toBe(1856);
  });

  it("follows Days Off — the whole point of the change", () => {
    // A 4-day-week contract: 52 more days off than the full-timer above.
    const partTime: ContractDays = { ...contract, daysOff: 156 };
    expect(deriveYearlyHoursWorked(position, partTime, calendar)).toBe(1440);
  });

  it("follows Public Holidays", () => {
    const extraHolidays: ContractDays = { ...contract, pubHolidays: 14 };
    expect(deriveYearlyHoursWorked(position, extraHolidays, calendar)).toBe(1816);
  });

  it("ignores the hotel calendar once the row states its own Yearly Days", () => {
    // Half the calendar's productive days must not change a stated contract.
    const halved = makeCalendarContext(Array(12).fill(10));
    expect(deriveYearlyHoursWorked(position, contract, halved)).toBe(
      deriveYearlyHoursWorked(position, contract, calendar)
    );
  });

  it("falls back to the calendar when the row states no Yearly Days", () => {
    // (252 − 20) × 8 = 1856 — the pre-change number, so rows written before the
    // Contract defaults keep exactly the hours they had.
    expect(deriveYearlyHoursWorked(position, blank, calendar)).toBe(1856);
  });

  it("floors at 0 when vacation exceeds productive days", () => {
    expect(
      deriveYearlyHoursWorked({ vacationDays: 400, dailyContractHours: 8 }, contract, calendar)
    ).toBe(0);
  });

  it("returns 0 when neither the contract nor the calendar has productive days", () => {
    const empty = makeCalendarContext(Array(12).fill(0));
    expect(
      deriveYearlyHoursWorked({ vacationDays: 0, dailyContractHours: 8 }, blank, empty)
    ).toBe(0);
  });

  /** The flat bag both engine paths actually hold (extraValues / a grid row). */
  const bag = {
    contractYearlyDays: 365,
    contractDaysOff: 104,
    contractPubHolidays: 9,
  };

  it("uses a positive stored value as a manual override", () => {
    expect(resolveYearlyHoursWorked(1234, position, bag, calendar)).toBe(1234);
  });

  it("falls back to the derived value when unset (≤ 0)", () => {
    expect(resolveYearlyHoursWorked(0, position, bag, calendar)).toBe(1856);
    expect(resolveYearlyHoursWorked(-5, position, bag, calendar)).toBe(1856);
  });

  it("reads the contract keys out of the bag, not just the calendar", () => {
    const partTimeBag = { ...bag, contractDaysOff: 156 };
    expect(resolveYearlyHoursWorked(0, position, partTimeBag, calendar)).toBe(1440);
  });

  it("restates both branches for the row's Input Basis", () => {
    // A full-year contract worked for six months does half a year's hours,
    // whether that figure was derived or typed in by hand. The switch says what
    // period every number on the row covers; an override is one of them.
    const seasonal = { ...position, seasonality: Array(12).fill(0).map((_v, m) => (m < 6 ? 1 : 0)) };
    expect(resolveYearlyHoursWorked(0, seasonal, bag, calendar)).toBe(928);
    expect(resolveYearlyHoursWorked(1800, seasonal, bag, calendar)).toBe(900);

    // Stated over its own six months instead, nothing is prorated.
    const contractBasis = { ...bag, annualDivisorBasis: "WORKING_MONTHS" };
    expect(resolveYearlyHoursWorked(0, seasonal, contractBasis, calendar)).toBe(1856);
    expect(resolveYearlyHoursWorked(1800, seasonal, contractBasis, calendar)).toBe(1800);
  });
});
