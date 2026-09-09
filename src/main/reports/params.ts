/**
 * Built-in report params, resolved for a (hotel, year).
 *
 * Two families. The work week — the LAST resort for the `weekly_hours`
 * param: a report reads it off the column's own source first (department
 * D0410, account A988112, the effective week Kairos posts — see
 * evaluate.ts), then derives it from the scenario's positions, and only a
 * column with no scenario at all falls through to here: the effective week
 * of the hotel-year setup ALONE, resolved the way the Home page shows it
 * (the contract week scaled by the productive days, no vacation to average;
 * a hotel that saved nothing gets the built-in 40 over its calendar). And
 * the calendar's day counts, so a per-day stat (rooms available ÷ days =
 * rooms in the hotel) reads right in a leap year.
 *
 * The getters are injected (the local_db ones are async and bound to that
 * module's handle) so this stays testable with literals.
 */

import { CalendarYear, daysInMonth } from "../../shared/calendar";
import type { PositionDefaults } from "../../shared/positionDefaults";
import { EffectiveWeekDerivation, effectiveWeekOf } from "../../shared/positions/effectiveWeek";
import type { BuiltinParam, ParamValue } from "../../shared/reports/types";
import { weeklyHoursParam } from "../../shared/reports/weeklyHours";
import { resolveHotelYearSetup } from "../positions/hotelYearSetup";

export interface ParamDeps {
  getCalendar(ou: string, year: number): Promise<CalendarYear | null>;
  getPositionDefaults(ou: string, year: number): Promise<PositionDefaults | null>;
}

export type BuiltinParamValues = Record<BuiltinParam, ParamValue>;

/** Days in each month of `year`; the Total is the year's days (365 or 366). */
export function daysInMonthParam(year: number): ParamValue {
  const months = Array.from({ length: 12 }, (_, m) => daysInMonth(year, m + 1));
  return { months, total: months.reduce((sum, days) => sum + days, 0) };
}

/** The effective week of the hotel-year setup alone — the contract week
 *  (the built-in 40 when none is saved or the saved figure is not positive)
 *  over the full-timer's productive days, with no roster to average. */
export async function resolveSetupEffectiveWeek(
  deps: ParamDeps | undefined,
  ou: string,
  year: number
): Promise<EffectiveWeekDerivation> {
  const setup = await resolveHotelYearSetup(deps, ou, year);
  return effectiveWeekOf(setup.contractWeek, setup.reference);
}

export async function resolveBuiltinParams(
  deps: ParamDeps | undefined,
  ou: string,
  year: number
): Promise<BuiltinParamValues> {
  return {
    weekly_hours: weeklyHoursParam((await resolveSetupEffectiveWeek(deps, ou, year)).effectiveWeek),
    days_in_month: daysInMonthParam(year),
  };
}
