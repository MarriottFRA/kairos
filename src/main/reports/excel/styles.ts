/**
 * The look of an exported report — PS Loader's Marriott report-pack palette
 * and conventions, kept so a sheet from Kairos sits beside one from the
 * older tool without a seam: navy header band, charcoal section rows,
 * light category fills, a blue-grey separator strip between column groups,
 * `#,##0` on money, percentages with one decimal, frozen headers.
 */

import type { Borders, Fill, Font } from "exceljs";
import type { Format } from "../../../shared/reports/types";

export const COLOR = {
  header: "FF1E3A5F",
  section: "FF4A4A4A",
  category: "FFF0F4F8",
  group: "FFF5F7FA",
  subtotal: "FFDCE6F0",
  separator: "FF8899AA",
  border: "FFD0D0D0",
  muted: "FF6B7280",
  white: "FFFFFFFF",
  warning: "FFB91C1C",
  favourable: "FF15803D",
  unfavourable: "FFB91C1C",
} as const;

export const solid = (argb: string): Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

export const thinBorder: Partial<Borders> = {
  top: { style: "thin", color: { argb: COLOR.border } },
  bottom: { style: "thin", color: { argb: COLOR.border } },
  left: { style: "thin", color: { argb: COLOR.border } },
  right: { style: "thin", color: { argb: COLOR.border } },
};

export const FONT: Record<"body" | "headerWhite" | "sectionWhite" | "bold" | "muted" | "title" | "subtitle" | "warning", Partial<Font>> = {
  body: { size: 10 },
  headerWhite: { size: 11, bold: true, color: { argb: COLOR.white } },
  sectionWhite: { size: 10, bold: true, color: { argb: COLOR.white } },
  bold: { size: 10, bold: true },
  muted: { size: 8, color: { argb: COLOR.muted } },
  title: { size: 14, bold: true, color: { argb: COLOR.header } },
  subtitle: { size: 12, bold: true },
  warning: { size: 11, bold: true, color: { argb: COLOR.warning } },
};

/** Number formats per display format. Percentages are stored ×100 by the
 *  engine, so the format prints the number with a literal sign. Zero prints
 *  as an en dash, as the Results grid does. */
export const NUMBER_FORMAT: Record<Format, string> = {
  currency: '#,##0;-#,##0;"–"',
  number: '#,##0;-#,##0;"–"',
  ratio: '#,##0.00;-#,##0.00;"–"',
  rate: '#,##0.00;-#,##0.00;"–"',
  percent: '0.0"%";-0.0"%";"–"',
  pts: '0.0" pts";-0.0" pts";"–"',
};

/** Money in thousands: Excel's trailing-comma scaling, so the cell keeps the
 *  full value and only shows it ÷ 1000. Nothing but money scales — a `rate`
 *  is money already divided by a statistic (ADR, RevPAR, POR) and stays whole. */
export const THOUSANDS_CURRENCY_FORMAT = '#,##0,;-#,##0,;"–"';

export function numberFormatFor(format: Format, thousands: boolean): string {
  return thousands && format === "currency" ? THOUSANDS_CURRENCY_FORMAT : NUMBER_FORMAT[format];
}

export const THOUSANDS_NOTE = "Amounts in 000's except ratios & stats";

export const WIDTH = {
  label: 42,
  number: 12,
  separator: 2,
} as const;

/** Excel forbids `\ / * ? : [ ]` in a sheet name and caps it at 31 chars. */
export function sanitizeSheetName(name: string, taken: ReadonlySet<string> = new Set()): string {
  const cleaned = name.replace(/[\\/*?:[\]]/g, " ").replace(/\s+/g, " ").trim() || "Sheet";
  const base = cleaned.slice(0, 31);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = base.slice(0, 31 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
