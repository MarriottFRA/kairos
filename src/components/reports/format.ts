/**
 * Report-number formatting — one module so the grid, the inspector and the
 * banners never print the same figure two different ways.
 *
 * Percentages arrive ×100 from the engine (pct() is 100 × a ÷ b), so they are
 * printed with one decimal and a sign, never rescaled. A zero prints as an en
 * dash, as the Results grid does; an absent value prints as nothing.
 */

import type { Format } from "../../shared/reports/types";

const NO_VALUE = "";
const ZERO = "–";

export function formatReportValue(value: number | null | undefined, format: Format): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return NO_VALUE;
  if (num === 0) return ZERO;
  switch (format) {
    case "percent":
      return `${num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    case "pts":
      return `${num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pts`;
    case "ratio":
    case "rate":
      return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "currency":
    case "number":
    default:
      return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
}

/**
 * The "amounts in 000's" reading: money ÷ 1000, everything else as is. A
 * count, an hour, a ratio or a percentage is never scaled — the workbook's
 * own rule ("Amounts in 000's except Ratios & Stats").
 *
 * `rate` is money that is already divided by a statistic (ADR, RevPAR, a POR
 * or per-FTE figure). It is a stat, not an amount: scaling it would turn a
 * £150 ADR into 0 and read as a broken KPI rather than a smaller unit.
 */
export function scaleForDisplay(value: number | null | undefined, format: Format, thousands: boolean): number | null | undefined {
  if (!thousands || format !== "currency" || value === null || value === undefined) return value;
  return value / 1000;
}

export const THOUSANDS_CAPTION = "Amounts in 000's except ratios & stats";

export const MONTH_SHORT = Array.from({ length: 12 }, (_, m) =>
  new Date(2000, m, 1).toLocaleString("en", { month: "short" })
);

/**
 * A difference as a signed figure: `+1,210`, `−3.4%`, `+2.0 pts`. The minus
 * is the typographic one so it lines up with the plus. A zero difference
 * prints as NOTHING, not a dash — in a grid of deltas only the exceptions
 * should carry ink. An absent value prints as nothing too.
 */
export function formatReportDelta(value: number | null | undefined, format: Format): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return NO_VALUE;
  const body = formatReportValue(Math.abs(num), format);
  if (!body) return NO_VALUE;
  return `${num < 0 ? "−" : "+"}${body}`;
}
