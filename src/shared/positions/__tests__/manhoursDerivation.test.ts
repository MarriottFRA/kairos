/**
 * Manhours Worked auto-derivation — the calendar-driven replacement for the
 * old free-entry hours field. Both engine-input paths (loadScenarioInput,
 * runLiveSim) call resolveYearlyHoursWorked, so this pins the shared math.
 */

import { describe, expect, it } from "vitest";
import { makeCalendarContext } from "../../engine/calendarContext";
import {
  deriveYearlyHoursWorked,
  resolveYearlyHoursWorked,
} from "../engineInput";

describe("Manhours Worked derivation", () => {
  // 21 net productive days each month = 252 productive days/year.
  const calendar = makeCalendarContext(Array(12).fill(21));

  it("derives (productive days − vacation) × daily hours", () => {
    // (252 − 20) × 8 = 1856
    expect(
      deriveYearlyHoursWorked({ vacationDays: 20, dailyContractHours: 8 }, calendar)
    ).toBe(1856);
  });

  it("floors at 0 when vacation exceeds productive days", () => {
    expect(
      deriveYearlyHoursWorked({ vacationDays: 400, dailyContractHours: 8 }, calendar)
    ).toBe(0);
  });

  it("returns 0 when the calendar has no productive days", () => {
    const empty = makeCalendarContext(Array(12).fill(0));
    expect(
      deriveYearlyHoursWorked({ vacationDays: 0, dailyContractHours: 8 }, empty)
    ).toBe(0);
  });

  it("uses a positive stored value as a manual override", () => {
    expect(
      resolveYearlyHoursWorked(1234, { vacationDays: 20, dailyContractHours: 8 }, calendar)
    ).toBe(1234);
  });

  it("falls back to the derived value when unset (≤ 0)", () => {
    expect(
      resolveYearlyHoursWorked(0, { vacationDays: 20, dailyContractHours: 8 }, calendar)
    ).toBe(1856);
    expect(
      resolveYearlyHoursWorked(-5, { vacationDays: 20, dailyContractHours: 8 }, calendar)
    ).toBe(1856);
  });
});
