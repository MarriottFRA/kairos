/**
 * Result-number formatting. One module so the grid and the inspector can never
 * render the same figure two different ways.
 *
 * The interesting case is `rate`: an allocation split is a decimal share of 1,
 * repeated across all twelve months. Rendering it with the currency formatter
 * would show "0" for every department, and summing it into a Year total would
 * produce a number that means nothing. So rates get four decimals, and the Year
 * column shows the rate itself rather than a sum.
 */

import type { OutputValueKind } from "../../shared/positions/ipc";

/** An empty cell (no line at all) vs. a real, posted zero. */
const NO_VALUE = "";
const ZERO = "–"; // en dash

export function formatResultValue(
  value: number | null | undefined,
  kind: OutputValueKind = "currency"
): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return NO_VALUE;
  if (num === 0) return ZERO;

  if (kind === "rate") {
    // 0.1523 — the decimal the BST carries, not a rounded percentage.
    return num.toLocaleString(undefined, {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  }
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * What the Year column should show for a row.
 *
 * For a rate row the twelve months are the SAME value, so their sum is an
 * artefact — show the rate. Everything else is additive and shows its total.
 */
export function yearValueOf(row: {
  months: number[];
  total: number;
  valueKind: OutputValueKind;
}): number {
  if (row.valueKind !== "rate") return row.total;
  return row.months?.[0] ?? 0;
}
