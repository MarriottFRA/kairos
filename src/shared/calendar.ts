/**
 * Budget / forecast calendar model.
 * -----------------------------------------------------------
 * Pure, dependency-free types and derivations shared by the main process
 * (persistence in local_db.ts) and the renderer (the home-page input grid).
 * Nothing here touches Electron or the DB, so both bundles can import it.
 *
 * The grid the user sees is:
 *
 *   Calendar Days        derived from the real calendar (never typed)
 *   Public Holidays      typed per month
 *   Weekends             pre-filled from the weekend pattern, but editable
 *   Net Productive Days  Calendar − Holidays − Weekends
 *
 * Weekends are a *pattern*, not a constant: EMEA and the wider world do not all
 * rest on Sat/Sun. `weekendMask` is a 7-bit set (bit 0 = Sunday … bit 6 =
 * Saturday) used only to seed the row — once seeded the user may override any
 * month's count, so the stored weekend numbers are authoritative.
 */

export interface CalendarMonth {
  /** 1–12 */
  month: number;
  calendarDays: number;
  publicHolidays: number;
  weekendDays: number;
}

export interface CalendarYear {
  /** Hotel OU this calendar belongs to. */
  ou: string;
  year: number;
  /** Weekday bitmask used to seed the Weekends row (bit 0 = Sun … bit 6 = Sat). */
  weekendMask: number;
  /** Always 12 entries, ordered Jan → Dec. */
  months: CalendarMonth[];
  updatedAt?: string | null;
}

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Sunday-first weekday labels, aligned with the bit order of `weekendMask`. */
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Display order for the weekend picker: Monday-first, ending on Sunday, which is
 * how most of the world reads a week. Values are `getDay()` indices into
 * `WEEKDAY_LABELS`, so this reorders the buttons visually without touching the
 * Sunday-first bit order of `weekendMask`.
 */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Sat + Sun — the most common pattern, and what a fresh year starts from. */
export const DEFAULT_WEEKEND_MASK = (1 << 0) | (1 << 6); // 65

export function isWeekendDay(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0;
}

export function toggleWeekendDay(mask: number, weekday: number): number {
  return mask ^ (1 << weekday);
}

/** Real number of days in a month (month is 1-based). */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** How many days of `month` fall on a weekday in `mask`. */
export function countWeekendDays(year: number, month: number, mask: number): number {
  const total = daysInMonth(year, month);
  let count = 0;
  for (let day = 1; day <= total; day++) {
    if (isWeekendDay(mask, new Date(year, month - 1, day).getDay())) count++;
  }
  return count;
}

/** Net productive days for one month, floored at zero. */
export function netProductiveDays(row: CalendarMonth): number {
  return Math.max(0, row.calendarDays - row.publicHolidays - row.weekendDays);
}

/**
 * A brand-new calendar for `year`: real calendar days, weekends seeded from the
 * pattern, no holidays yet. This is what the grid shows before anything is saved
 * and what "reset to calendar defaults" restores.
 */
export function buildDefaultCalendar(
  ou: string,
  year: number,
  weekendMask: number = DEFAULT_WEEKEND_MASK
): CalendarYear {
  return {
    ou,
    year,
    weekendMask,
    months: MONTH_LABELS.map((_, index) => {
      const month = index + 1;
      return {
        month,
        calendarDays: daysInMonth(year, month),
        publicHolidays: 0,
        weekendDays: countWeekendDays(year, month, weekendMask),
      };
    }),
  };
}

/**
 * Re-seed the Weekends row from a new pattern, keeping the typed holidays.
 * Calendar days are re-derived too, so this doubles as a year-change reseed.
 */
export function reseedWeekends(calendar: CalendarYear, weekendMask: number): CalendarYear {
  return {
    ...calendar,
    weekendMask,
    months: calendar.months.map((row) => ({
      ...row,
      calendarDays: daysInMonth(calendar.year, row.month),
      weekendDays: countWeekendDays(calendar.year, row.month, weekendMask),
    })),
  };
}

/**
 * Coerce anything read back from storage into a well-formed calendar: exactly 12
 * months, integral non-negative counts, calendar days re-derived from the year.
 */
export function normalizeCalendar(
  ou: string,
  year: number,
  weekendMask: number,
  months: Array<Partial<CalendarMonth>>
): CalendarYear {
  const byMonth = new Map(months.map((row) => [Number(row.month), row]));
  const mask = Number.isFinite(weekendMask) ? weekendMask : DEFAULT_WEEKEND_MASK;

  return {
    ou,
    year,
    weekendMask: mask,
    months: MONTH_LABELS.map((_, index) => {
      const month = index + 1;
      const calendarDays = daysInMonth(year, month);
      const stored = byMonth.get(month);
      const clamp = (value: unknown) =>
        Math.min(calendarDays, Math.max(0, Math.trunc(Number(value) || 0)));
      return {
        month,
        calendarDays,
        publicHolidays: clamp(stored?.publicHolidays),
        weekendDays: stored
          ? clamp(stored.weekendDays)
          : countWeekendDays(year, month, mask),
      };
    }),
  };
}

/** Column totals for the trailing "Total" column. */
export function calendarTotals(calendar: CalendarYear) {
  return calendar.months.reduce(
    (totals, row) => ({
      calendarDays: totals.calendarDays + row.calendarDays,
      publicHolidays: totals.publicHolidays + row.publicHolidays,
      weekendDays: totals.weekendDays + row.weekendDays,
      netProductiveDays: totals.netProductiveDays + netProductiveDays(row),
    }),
    { calendarDays: 0, publicHolidays: 0, weekendDays: 0, netProductiveDays: 0 }
  );
}
