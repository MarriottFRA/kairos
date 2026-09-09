/**
 * The built-in params from stubs: the full-time yardstick from the defaults
 * and the calendar, and the calendar's day counts with a leap year.
 */

import { describe, expect, it } from "vitest";
import { daysInMonthParam, resolveBuiltinParams } from "../params";

describe("resolveBuiltinParams", () => {
  it("gives the days in each month, with the year's total, and honours a leap year", async () => {
    expect(daysInMonthParam(2027)).toEqual({ months: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], total: 365 });
    const leap = daysInMonthParam(2028);
    expect((leap as { months: number[] }).months[1]).toBe(29);
    expect((leap as { total: number }).total).toBe(366);

    const resolved = await resolveBuiltinParams(undefined, "OU1", 2028);
    expect(resolved.days_in_month).toEqual(leap);
    expect(resolved.weekly_hours).toEqual({ months: new Array(12).fill(40), total: 40 });
  });
});
