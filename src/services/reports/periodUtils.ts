/**
 * Period utilities — pure local date math used by reports for any KPI that
 * needs the calendar length of the period being rendered (e.g. Rooms
 * Available per Day = total available rooms ÷ days in period).
 *
 * No network, no DB, no React. Months are 1-indexed (Jan = 1).
 */

/** Last calendar day of a month. Uses the JS Date trick of asking for "day 0
 *  of next month", which evaluates to the last day of this month and handles
 *  leap years natively. */
export const daysInMonth = (year: number, month: number): number =>
  new Date(year, month, 0).getDate();

/** Inclusive total day count from (startMonth/startYear) through
 *  (endMonth/endYear). One helper covers both period shapes used across the
 *  app — single-month (pass m,y,m,y) and multi-month YTD or custom range. */
export const daysInPeriod = (
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number
): number => {
  let total = 0;
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    total += daysInMonth(y, m);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return total;
};
