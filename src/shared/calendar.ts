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
  /** Bank-holiday premium: when on, the engine books the extra cost of the staff
   *  who work each public holiday. Hourly-wage staff only — their pay already
   *  excludes the holiday day, so working it is entirely additional. Scoped to
   *  this hotel-year, since holidays and staffing patterns differ by both. */
  bankHolidayEnabled?: boolean;
  /** Fraction of a position's staff who actually work a holiday (0..1). */
  bankHolidayStaffFraction?: number;
  /** Pay-rate multiplier for a worked holiday (e.g. 1.5, 2). */
  bankHolidayPremiumMultiplier?: number;
  /** GL account the premium posts to (empty = feature effectively off). */
  bankHolidayAccount?: string;
  updatedAt?: string | null;
}

/** Defaults for a hotel-year that has never configured the bank-holiday premium:
 *  off, with sensible starting knobs the home page shows once it is switched on. */
export const DEFAULT_BANK_HOLIDAY_STAFF_FRACTION = 0.5;
export const DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER = 2;

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Alias of MONTH_LABELS, for code that reads better saying "short". */
export const MONTH_SHORT = MONTH_LABELS;

export const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * "Oct", "Oct–Dec", "Jan–Mar, Oct–Dec" — a run-collapsed list of month names
 * from 0-based indices. Every warning and consequence sentence about a set of
 * months goes through this, so they all read the same way.
 */
export function formatMonthRanges(
  indices: number[],
  labels: readonly string[] = MONTH_LABELS
): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";

  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  const flush = () => {
    parts.push(start === prev ? labels[start] : `${labels[start]}–${labels[prev]}`);
  };

  for (const index of sorted.slice(1)) {
    if (index === prev + 1) {
      prev = index;
      continue;
    }
    flush();
    start = index;
    prev = index;
  }
  flush();
  return parts.join(", ");
}

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

/** The four bank-holiday-premium fields, coerced into well-formed values:
 *  a real boolean, fraction clamped to 0..1, non-negative multiplier, a trimmed
 *  account string. Shared by buildDefaultCalendar and normalizeCalendar so every
 *  path (fresh, reseeded, read-from-storage) produces the same canonical shape. */
export function normalizeBankHoliday(
  source: Partial<Pick<
    CalendarYear,
    | "bankHolidayEnabled"
    | "bankHolidayStaffFraction"
    | "bankHolidayPremiumMultiplier"
    | "bankHolidayAccount"
  >>
): Required<Pick<
  CalendarYear,
  | "bankHolidayEnabled"
  | "bankHolidayStaffFraction"
  | "bankHolidayPremiumMultiplier"
  | "bankHolidayAccount"
>> {
  const fraction = Number(source.bankHolidayStaffFraction);
  const multiplier = Number(source.bankHolidayPremiumMultiplier);
  return {
    bankHolidayEnabled: !!source.bankHolidayEnabled,
    bankHolidayStaffFraction: Number.isFinite(fraction)
      ? Math.min(1, Math.max(0, fraction))
      : DEFAULT_BANK_HOLIDAY_STAFF_FRACTION,
    bankHolidayPremiumMultiplier: Number.isFinite(multiplier)
      ? Math.max(0, multiplier)
      : DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER,
    bankHolidayAccount:
      typeof source.bankHolidayAccount === "string" ? source.bankHolidayAccount.trim() : "",
  };
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
    ...normalizeBankHoliday({}),
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
  months: Array<Partial<CalendarMonth>>,
  bankHoliday: Partial<Pick<
    CalendarYear,
    | "bankHolidayEnabled"
    | "bankHolidayStaffFraction"
    | "bankHolidayPremiumMultiplier"
    | "bankHolidayAccount"
  >> = {}
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
    ...normalizeBankHoliday(bankHoliday),
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
