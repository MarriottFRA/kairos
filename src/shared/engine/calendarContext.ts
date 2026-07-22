/**
 * Bridges the app's budget calendar (src/shared/calendar.ts, persisted in the
 * calendar_years/calendar_months tables) to the engine's CalendarContext.
 *
 * realDays  — net productive days per month (calendar − holidays − weekends):
 *             the hourly-staff day basis and the basis for the HOURS stat.
 *             The legacy workbook took these weights from its Menu sheet; here
 *             they come from the calendar the user maintains on the home page.
 * flatDays  — 30/360: the salaried day basis.
 */

import { CalendarYear, netProductiveDays } from "../calendar";
import { CalendarContext, MONTHS } from "./types";

export function buildCalendarContext(calendar: CalendarYear): CalendarContext {
  const realDays = new Float64Array(MONTHS);
  for (const row of calendar.months) {
    if (row.month >= 1 && row.month <= MONTHS) {
      realDays[row.month - 1] = netProductiveDays(row);
    }
  }
  return { realDays, flatDays: new Float64Array(MONTHS).fill(30) };
}

/** A context with explicit day counts — used by tests and synthetic data. */
export function makeCalendarContext(realDays: number[]): CalendarContext {
  if (realDays.length !== MONTHS) {
    throw new Error(`realDays must have ${MONTHS} entries`);
  }
  return {
    realDays: Float64Array.from(realDays),
    flatDays: new Float64Array(MONTHS).fill(30),
  };
}
