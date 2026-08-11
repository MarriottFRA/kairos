/**
 * Length-of-service day counts, derived from a position's hiring date.
 * -----------------------------------------------------------
 * The input for the two SERVICE block bases ("Service days in month" and
 * "Total service days") — end-of-service / indemnity accruals are written
 * against total service, not against days worked.
 *
 * These are PURE CALENDAR DAYS: every day from the hiring date onward counts,
 * whether or not it was worked, paid, a weekend, a public holiday, or unpaid
 * leave. That is deliberate and is what separates this from the CALENDAR bases
 * (PAY_DAYS / REAL_DAYS), which count productive days and are scaled by
 * seasonality. Statutory service accrues on the contract, not on attendance.
 *
 * Both endpoints are inclusive, so someone hired on 1 January has 31 days of
 * service at the end of January.
 *
 * NO HIRING DATE → ALL ZEROS. A row the user never filled in contributes
 * nothing rather than silently defaulting to "hired on 1 January", which would
 * invent a liability out of a blank cell.
 *
 * Computed by the loaders (main + liveSim) and handed to the engine as plain
 * numbers on Position — the engine itself never sees the date, keeping the
 * no-PII-in-ScenarioInput rule intact. serviceDaysParity pins the two loaders
 * to this one implementation, exactly like resolveYearlyHoursWorked.
 */

import { MONTHS } from "../engine/types";

/** Milliseconds in a day — every count here is a UTC day difference. */
const DAY_MS = 86_400_000;

export interface ServiceDays {
  /**
   * Calendar days of service falling inside each month of the plan year.
   * Zero before the hiring month, partial in it, the full month after.
   */
  perMonth: number[];
  /**
   * Days of service already accrued before 1 January of the plan year — the
   * prior-years carry-in that makes the running total a true length of service
   * rather than a within-year count. Zero for anyone hired during or after the
   * plan year.
   */
  opening: number;
}

/**
 * Parse a stored hiring date to a UTC midnight timestamp, or null.
 *
 * Dates are stored as ISO day strings ("YYYY-MM-DD"); slicing to 10 chars and
 * building the timestamp in UTC avoids the local-timezone off-by-one that would
 * otherwise shift a hire date across a month boundary west of Greenwich (the
 * same trap gridValueBridge documents for the grid's date columns).
 */
function parseIsoDayUtc(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const stamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(stamp)) return null;
  // Rejects the impossible ("2026-02-30" would roll into March).
  const rolled = new Date(stamp);
  if (rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day) return null;
  return stamp;
}

/**
 * The per-month and carry-in service-day counts for one position in one plan
 * year. An absent, malformed or future hiring date yields all zeros.
 */
export function serviceDaysFor(
  hiringDate: string | null | undefined,
  planYear: number
): ServiceDays {
  const hired = parseIsoDayUtc(hiringDate);
  if (hired === null || !Number.isFinite(planYear)) return zeroServiceDays();

  const perMonth = new Array(MONTHS).fill(0);
  const yearStart = Date.UTC(planYear, 0, 1);

  // Prior-years carry-in: the days in [hire, 31 Dec of the year before].
  // Hired during or after the plan year → nothing carried in.
  const opening = hired < yearStart ? (yearStart - hired) / DAY_MS : 0;

  for (let m = 0; m < MONTHS; m++) {
    const monthStart = Date.UTC(planYear, m, 1);
    const monthEnd = Date.UTC(planYear, m + 1, 1); // exclusive
    if (hired >= monthEnd) continue; // not yet hired anywhere in this month
    // Inclusive of the hiring day itself, hence the start clamp rather than a
    // plain difference from the hire date.
    const from = hired > monthStart ? hired : monthStart;
    perMonth[m] = (monthEnd - from) / DAY_MS;
  }

  return { perMonth, opening };
}

/** A fresh zero series — never hand out the shared frozen-by-convention one. */
export function zeroServiceDays(): ServiceDays {
  return { perMonth: new Array(MONTHS).fill(0), opening: 0 };
}
