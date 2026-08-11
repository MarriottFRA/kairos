/**
 * The block-total diff, which is what keeps a sorted grid honest.
 *
 * Displayed values now reach the grid through a mutable ref rather than through
 * column identity, so MUI is not told a value moved unless this function says
 * so. Miss a changed row and its cell paints stale AND a sort on that column
 * keeps a wrong order; report a row that did not change and the only cost is a
 * needless row clone. The asymmetry is why the tests below lean on the
 * "reports everything that moved" side.
 */

import { describe, expect, it } from "vitest";
import { rowIdsWithChangedTotals } from "../derivedRowValues";
import type { BlockResultsById } from "../liveSim";

/** rowId → defId → total, as the sim's shape. Months are not compared (only the
 *  Total column is displayed), so they are filled with a marker. */
function results(shape: Record<string, Record<string, number>>): BlockResultsById {
  const out: BlockResultsById = new Map();
  for (const [rowId, byDef] of Object.entries(shape)) {
    const perDef = new Map(
      Object.entries(byDef).map(([defId, total]) => [
        defId,
        { months: new Array(12).fill(total / 12), total },
      ])
    );
    out.set(rowId, perDef);
  }
  return out;
}

describe("rowIdsWithChangedTotals", () => {
  it("reports nothing when the totals are identical", () => {
    const before = results({ p1: { b1: 100, b2: 50 }, p2: { b1: 200 } });
    const after = results({ p1: { b1: 100, b2: 50 }, p2: { b1: 200 } });
    expect(rowIdsWithChangedTotals(before, after)).toEqual([]);
  });

  it("reports only the row whose total moved", () => {
    const before = results({ p1: { b1: 100 }, p2: { b1: 200 }, p3: { b1: 300 } });
    const after = results({ p1: { b1: 100 }, p2: { b1: 250 }, p3: { b1: 300 } });
    expect(rowIdsWithChangedTotals(before, after)).toEqual(["p2"]);
  });

  it("reports every member when a pooled block re-slices its pot", () => {
    // The case the whole mechanism exists for: editing p1 changes what p2 and
    // p3 are shown, without their row objects changing.
    const before = results({ p1: { pool: 100 }, p2: { pool: 100 }, p3: { pool: 100 } });
    const after = results({ p1: { pool: 150 }, p2: { pool: 75 }, p3: { pool: 75 } });
    expect(rowIdsWithChangedTotals(before, after).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("catches a sub-cent movement — no epsilon", () => {
    // Two runs of the same deterministic engine: "changed" means a different
    // double. Rounding here would drop a real movement on a large pot.
    const before = results({ p1: { b1: 1000.0 } });
    const after = results({ p1: { b1: 1000.0000001 } });
    expect(rowIdsWithChangedTotals(before, after)).toEqual(["p1"]);
  });

  it("reports a row that gained a block line", () => {
    const before = results({ p1: { b1: 100 } });
    const after = results({ p1: { b1: 100, b2: 40 } });
    expect(rowIdsWithChangedTotals(before, after)).toEqual(["p1"]);
  });

  it("reports a row that lost a block line", () => {
    const before = results({ p1: { b1: 100, b2: 40 } });
    const after = results({ p1: { b1: 100 } });
    expect(rowIdsWithChangedTotals(before, after)).toEqual(["p1"]);
  });

  it("reports a row that appeared", () => {
    const before = results({ p1: { b1: 100 } });
    const after = results({ p1: { b1: 100 }, p2: { b1: 10 } });
    expect(rowIdsWithChangedTotals(before, after)).toEqual(["p2"]);
  });

  it("reports a row that disappeared", () => {
    // Deactivated or deleted — the caller filters these against the grid's own
    // row nodes, but the diff must still surface them.
    const before = results({ p1: { b1: 100 }, p2: { b1: 10 } });
    const after = results({ p1: { b1: 100 } });
    expect(rowIdsWithChangedTotals(before, after)).toEqual(["p2"]);
  });

  it("treats a first result set as all-new", () => {
    const after = results({ p1: { b1: 100 }, p2: { b1: 10 } });
    expect(rowIdsWithChangedTotals(new Map(), after).sort()).toEqual(["p1", "p2"]);
  });

  it("does not report a row twice when several of its blocks move", () => {
    const before = results({ p1: { b1: 100, b2: 40, b3: 5 } });
    const after = results({ p1: { b1: 111, b2: 44, b3: 6 } });
    expect(rowIdsWithChangedTotals(before, after)).toEqual(["p1"]);
  });
});
