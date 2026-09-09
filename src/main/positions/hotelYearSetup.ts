/**
 * The hotel-year setup as one resolved reading: the calendar, the position
 * defaults resolved against it, the contract week and the full-time yardstick.
 *
 * loadScenarioInput resolves the same things inline for the engine (and
 * runLiveSim mirrors it — liveSimParity pins the two); this is the reading for
 * everything AROUND the engine that needs the same numbers — the effective
 * week the run posts, the reports' last-resort work week, the Home page's
 * live derivation — so none of them can resolve the defaults a different way.
 *
 * An unsaved calendar is the real-calendar default; unsaved defaults are the
 * built-in set (40h, every field linked); a non-positive contract week reads
 * as the built-in 40, which is what the Home page shows for it.
 */

import { CalendarYear, DEFAULT_WEEKEND_MASK, buildDefaultCalendar } from "../../shared/calendar";
import {
  DEFAULT_WEEKLY_HOURS,
  FullTimeReference,
  PositionDefaults,
  buildDefaultPositionDefaults,
  fullTimeReference,
  resolvePositionDefaults,
} from "../../shared/positionDefaults";
import type { CalendarGetter, PositionDefaultsGetter } from "./loadScenarioInput";

export interface HotelYearSetupDeps {
  getCalendar?: CalendarGetter;
  getPositionDefaults?: PositionDefaultsGetter;
}

export interface HotelYearSetup {
  calendar: CalendarYear;
  /** Linked fields resolved against `calendar`. */
  defaults: PositionDefaults;
  /** The typed full-time week (the built-in 40 when unsaved or not positive). */
  contractWeek: number;
  /** The yardstick every position's FTE is measured against. */
  reference: FullTimeReference;
}

export async function resolveHotelYearSetup(
  deps: HotelYearSetupDeps | undefined,
  ou: string,
  year: number
): Promise<HotelYearSetup> {
  const calendar =
    (deps?.getCalendar ? await deps.getCalendar(ou, year) : null) ??
    buildDefaultCalendar(ou, year, DEFAULT_WEEKEND_MASK);
  const stored = deps?.getPositionDefaults ? await deps.getPositionDefaults(ou, year) : null;
  const defaults = resolvePositionDefaults(stored ?? buildDefaultPositionDefaults(ou, year), calendar);
  const typed = Number(defaults.weeklyHours);
  const contractWeek = Number.isFinite(typed) && typed > 0 ? typed : DEFAULT_WEEKLY_HOURS;
  return {
    calendar,
    defaults,
    contractWeek,
    reference: fullTimeReference({ ...defaults, weeklyHours: contractWeek }),
  };
}
