/**
 * Safe defaults for new positions.
 * -----------------------------------------------------------
 * Pure, dependency-free model shared by the main process (persistence in
 * local_db.ts) and the renderer (the Home-page defaults panel + the Positions
 * add-row path). Nothing here touches Electron or the DB, so both bundles can
 * import it — the same shape as `src/shared/calendar.ts`.
 *
 * A hotel-year carries one set of defaults that seed the Contract columns of
 * every new position. Three of them are *linked* to the budget/forecast
 * calendar by default; the fourth (Daily Hours) is derived from the Weekly
 * Hours input (÷ 5). Any field can be *unlinked* so the user pins their own
 * number instead of tracking the calendar. The Home-page table is the only
 * linked surface — the numbers copied onto a new position are a one-time seed,
 * so those rows are always independent.
 */

import { CalendarYear, calendarTotals } from "./calendar";

export type DefaultKey = "yearlyDays" | "daysOff" | "pubHolidays" | "dailyHours";

export const DEFAULT_KEYS: DefaultKey[] = [
  "yearlyDays",
  "daysOff",
  "pubHolidays",
  "dailyHours",
];

export interface DefaultField {
  /** Resolved numeric value — what a new position is seeded with. */
  value: number;
  /** true = tracks the calendar / weekly hours; false = user-pinned override. */
  linked: boolean;
}

export interface PositionDefaults {
  ou: string;
  year: number;
  /** Manual input; drives Daily Hours (÷ 5) when that field is linked. */
  weeklyHours: number;
  fields: Record<DefaultKey, DefaultField>;
  updatedAt?: string | null;
}

/** 40h / 5 days = 8h/day out of the box. */
export const DEFAULT_WEEKLY_HOURS = 40;

/** Fixed working-days-per-week divisor for Daily Hours (a USALI convention). */
export const WORKING_DAYS_PER_WEEK = 5;

/** Human labels for the defaults panel. */
export const DEFAULT_LABELS: Record<DefaultKey, string> = {
  yearlyDays: "Yearly Days",
  daysOff: "Days Off",
  pubHolidays: "Public Holidays",
  dailyHours: "Daily Hours",
};

/** The Positions Contract field each default seeds (keys from fieldSeed.ts). */
export const DEFAULT_TO_FIELD: Record<DefaultKey, string> = {
  yearlyDays: "contractYearlyDays",
  daysOff: "contractDaysOff",
  pubHolidays: "contractPubHolidays",
  dailyHours: "dailyContractHours",
};

/** Daily hours implied by a weekly-hours figure. */
export function dailyHoursFromWeekly(weeklyHours: number): number {
  const weekly = Number(weeklyHours);
  if (!Number.isFinite(weekly) || weekly <= 0) return 0;
  return weekly / WORKING_DAYS_PER_WEEK;
}

/**
 * The full-time yardstick every position's FTE is measured against — the two
 * constants the VBA held on the Menu sheet (`Menu!$O$14` and `FT_Hours`).
 *
 * They are not a new setting: the hotel-year defaults already state exactly this
 * (what a full-time contract at this hotel looks like), so FTE reads off the
 * same numbers a new position is seeded with. Keeping one source means a hotel
 * that moves to a 39-hour week changes it in one place and every FTE follows.
 */
export interface FullTimeReference {
  /** Productive days a full-timer has: Yearly Days − Days Off − Public Holidays. */
  productiveDays: number;
  /** Hours a full-timer works a day: Weekly Hours ÷ 5. */
  dailyHours: number;
}

/** An FTE reference that yields 0 — what a row shows before defaults load. */
export const EMPTY_FULL_TIME_REFERENCE: FullTimeReference = {
  productiveDays: 0,
  dailyHours: 0,
};

/**
 * Read the full-time yardstick out of a hotel-year's defaults. Pass the
 * *resolved* set (see resolvePositionDefaults) so linked fields carry the
 * calendar's numbers rather than whatever was last persisted.
 *
 * Note this deliberately ignores the defaults' own Daily Hours field: that one
 * is per-position seed material and can be pinned away from the week, whereas
 * the FTE denominator has to stay the hotel's standard full-time day.
 */
export function fullTimeReference(
  defaults: PositionDefaults | null | undefined
): FullTimeReference {
  if (!defaults) return EMPTY_FULL_TIME_REFERENCE;
  const productiveDays =
    defaults.fields.yearlyDays.value -
    defaults.fields.daysOff.value -
    defaults.fields.pubHolidays.value;
  return {
    productiveDays: productiveDays > 0 ? productiveDays : 0,
    dailyHours: dailyHoursFromWeekly(defaults.weeklyHours),
  };
}

/**
 * A brand-new defaults set for (ou, year): every field linked, weekly hours at
 * the 40h default. Values are placeholders until `resolvePositionDefaults` runs
 * them against a calendar.
 */
export function buildDefaultPositionDefaults(
  ou: string,
  year: number
): PositionDefaults {
  return {
    ou,
    year,
    weeklyHours: DEFAULT_WEEKLY_HOURS,
    fields: {
      yearlyDays: { value: 0, linked: true },
      daysOff: { value: 0, linked: true },
      pubHolidays: { value: 0, linked: true },
      dailyHours: { value: dailyHoursFromWeekly(DEFAULT_WEEKLY_HOURS), linked: true },
    },
  };
}

/**
 * Recompute every *linked* field from the calendar totals (and weekly hours for
 * Daily Hours); unlinked fields keep their pinned value. This is the single
 * source of truth for both the Home preview and the value a new position is
 * seeded with.
 */
export function resolvePositionDefaults(
  defaults: PositionDefaults,
  calendar: CalendarYear
): PositionDefaults {
  const totals = calendarTotals(calendar);
  const linkedSource: Record<DefaultKey, number> = {
    yearlyDays: totals.calendarDays,
    daysOff: totals.weekendDays,
    pubHolidays: totals.publicHolidays,
    dailyHours: dailyHoursFromWeekly(defaults.weeklyHours),
  };

  const fields = {} as Record<DefaultKey, DefaultField>;
  for (const key of DEFAULT_KEYS) {
    const field = defaults.fields[key];
    fields[key] = field.linked
      ? { value: linkedSource[key], linked: true }
      : { value: field.value, linked: false };
  }

  return { ...defaults, fields };
}

/**
 * Map the resolved defaults onto the Contract field keys a draft position row
 * expects. Pass the result as `newDraftRow`'s `init` — it wins over the field
 * catalog's static defaults.
 */
export function seedInitForPosition(
  defaults: PositionDefaults
): Record<string, number> {
  const init: Record<string, number> = {};
  for (const key of DEFAULT_KEYS) {
    init[DEFAULT_TO_FIELD[key]] = defaults.fields[key].value;
  }
  return init;
}

/**
 * Coerce anything read back from storage into a well-formed defaults object:
 * a finite weekly-hours figure and all four fields present with numeric values
 * and boolean link flags. Mirrors `normalizeCalendar`.
 */
export function normalizePositionDefaults(
  ou: string,
  year: number,
  weeklyHours: unknown,
  fields: Partial<Record<DefaultKey, Partial<DefaultField>>> | undefined
): PositionDefaults {
  const base = buildDefaultPositionDefaults(ou, year);
  const weekly = Number(weeklyHours);
  base.weeklyHours =
    Number.isFinite(weekly) && weekly >= 0 ? weekly : DEFAULT_WEEKLY_HOURS;

  for (const key of DEFAULT_KEYS) {
    const stored = fields?.[key];
    if (!stored) continue;
    const value = Number(stored.value);
    base.fields[key] = {
      value: Number.isFinite(value) ? Math.max(0, value) : 0,
      linked: stored.linked !== false,
    };
  }

  return base;
}
