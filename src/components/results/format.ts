/**
 * Result-number formatting. One module so the grid and the inspector can never
 * render the same figure two different ways.
 *
 * The interesting case is `percent`: an allocation split is stored the way the
 * BST holds it — a share out of 100, carried in January with zeroes after it —
 * so the number itself is already the figure that gets loaded. It is rendered
 * bare, WITHOUT a % sign: the page's job is to show what reaches the workbook,
 * and a "%" invites the reader to wonder whether the stored value is really
 * 0.065. The Year column is a plain sum for every kind, which for a
 * January-carried level gives that level back.
 */

import type { OutputValueKind } from "../../shared/positions/ipc";

/** An empty cell (no line at all) vs. a real, posted zero. */
const NO_VALUE = "";
const ZERO = "–"; // en dash

/**
 * `_kind` is deliberately unused: all three kinds now render as the plain
 * number they are stored and pushed as (a split included — 6.5, not 6.5% and
 * not 0.065). It stays on the signature because the callers already carry it
 * and it is the seam where kind-specific formatting would go back.
 */
export function formatResultValue(
  value: number | null | undefined,
  _kind: OutputValueKind = "currency"
): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return NO_VALUE;
  if (num === 0) return ZERO;

  // Two decimal places is what the Allocations grid shows.
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
