/**
 * Safe-defaults derivations: linked fields track the calendar totals / weekly
 * hours, unlinked fields keep their pinned value, and the seed maps onto the
 * Contract field keys a draft position expects.
 */

import { describe, expect, it } from "vitest";
import { buildDefaultCalendar } from "../calendar";
import {
  buildDefaultPositionDefaults,
  dailyHoursFromWeekly,
  normalizePositionDefaults,
  resolvePositionDefaults,
  seedInitForPosition,
} from "../positionDefaults";

// 2025 is a non-leap year: 365 calendar days, Sat/Sun weekends = 104.
const OU = "H1";
const YEAR = 2025;

function calendarWithHolidays(holidaysInJan: number) {
  const calendar = buildDefaultCalendar(OU, YEAR);
  calendar.months[0].publicHolidays = holidaysInJan;
  return calendar;
}

describe("dailyHoursFromWeekly", () => {
  it("divides weekly hours by 5", () => {
    expect(dailyHoursFromWeekly(40)).toBe(8);
    expect(dailyHoursFromWeekly(37.5)).toBe(7.5);
  });

  it("floors non-positive / non-finite input at zero", () => {
    expect(dailyHoursFromWeekly(0)).toBe(0);
    expect(dailyHoursFromWeekly(-10)).toBe(0);
    expect(dailyHoursFromWeekly(Number.NaN)).toBe(0);
  });
});

describe("resolvePositionDefaults", () => {
  it("fills linked fields from the calendar totals and weekly hours", () => {
    const calendar = calendarWithHolidays(3);
    const resolved = resolvePositionDefaults(
      buildDefaultPositionDefaults(OU, YEAR),
      calendar
    );

    expect(resolved.fields.yearlyDays.value).toBe(365);
    expect(resolved.fields.daysOff.value).toBe(104);
    expect(resolved.fields.pubHolidays.value).toBe(3);
    expect(resolved.fields.dailyHours.value).toBe(8);
  });

  it("leaves an unlinked field pinned to its own value", () => {
    const defaults = buildDefaultPositionDefaults(OU, YEAR);
    defaults.fields.yearlyDays = { value: 260, linked: false };

    const resolved = resolvePositionDefaults(defaults, buildDefaultCalendar(OU, YEAR));

    expect(resolved.fields.yearlyDays.value).toBe(260);
    expect(resolved.fields.yearlyDays.linked).toBe(false);
    // Sibling fields still track the calendar.
    expect(resolved.fields.daysOff.value).toBe(104);
  });

  it("recomputes daily hours when weekly hours change", () => {
    const defaults = { ...buildDefaultPositionDefaults(OU, YEAR), weeklyHours: 45 };
    const resolved = resolvePositionDefaults(defaults, buildDefaultCalendar(OU, YEAR));
    expect(resolved.fields.dailyHours.value).toBe(9);
  });
});

describe("seedInitForPosition", () => {
  it("maps resolved values onto the Contract field keys", () => {
    const resolved = resolvePositionDefaults(
      buildDefaultPositionDefaults(OU, YEAR),
      buildDefaultCalendar(OU, YEAR)
    );
    expect(seedInitForPosition(resolved)).toEqual({
      contractYearlyDays: 365,
      contractDaysOff: 104,
      contractPubHolidays: 0,
      dailyContractHours: 8,
    });
  });
});

describe("normalizePositionDefaults", () => {
  it("fills missing fields and coerces bad values", () => {
    const normalized = normalizePositionDefaults(OU, YEAR, "not-a-number", {
      yearlyDays: { value: -5, linked: false },
    });
    expect(normalized.weeklyHours).toBe(40);
    expect(normalized.fields.yearlyDays).toEqual({ value: 0, linked: false });
    // Untouched keys fall back to the linked default.
    expect(normalized.fields.daysOff.linked).toBe(true);
  });
});
