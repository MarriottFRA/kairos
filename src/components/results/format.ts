/**
 * Result-number formatting. One module so the grid and the inspector can never
 * render the same figure two different ways.
 *
 * The interesting case is `percent`: an allocation split is stored the way the
 * BST holds it — a share out of 100, carried in January with zeroes after it —
 * so the number itself is already the percentage and only needs a % sign. The
 * Year column is a plain sum for every kind, which for a January-carried level
 * gives that level back.
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

  if (kind === "percent") {
    // 15.23% — the share as it is stored and as it is pushed, not a re-scaled
    // decimal. Two places is what the Allocations grid shows.
    return `${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  }
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * What the Year column should show for a row.
 *
 * Always the sum of the twelve months. For an ordinary monthly amount that is
 * the year's cost; for a level-valued row (headcount, position count, an
 * allocation split) the months are CHANGES, so their sum is the December level —
 * the share, or the heads the budget ends the year with.
 */
export function yearValueOf(row: { total: number }): number {
  return row.total;
}
