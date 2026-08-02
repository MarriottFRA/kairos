/**
 * The pooled share weight's trip through the flat grid row.
 *
 * It rides ComponentValue.rate — a column POOL_SPREAD otherwise never uses —
 * which is what let the tick box become a weight with no migration. That reuse
 * is only safe while every leg of the round trip agrees on what a stored 0, a
 * blank and a pasted "TRUE" mean, so all four legs are pinned here.
 */

import { describe, expect, it } from "vitest";
import type { BlockDto } from "../../blocks/ipc";
import {
  applyComponentValuesToRow,
  blockFieldKey,
  blockPatchesFromRow,
  POOL_WEIGHT_SLOT,
  rowToComponentValues,
  sanitizeBlockInputs,
} from "../blockRows";
import type { ComponentValueRecord } from "../ipc";
import type { PositionRow } from "../rowModel";

const DEF = "blk-1:cost";
const KEY = blockFieldKey(DEF, POOL_WEIGHT_SLOT);

const BLOCK = {
  id: "blk-1",
  ou: "OU1",
  blockType: "POOL_SPREAD",
  label: "Gratuities",
  accountCode: "A600000",
  accountLocked: true,
  statsAccountCode: "",
  statsAccountLocked: true,
  spread: "ACTIVE_MONTHS",
  increaseAware: false,
  departmentMode: "POSITION",
  poolSource: "MANUAL",
  poolEligibilityMode: "MANUAL",
  sortOrder: 10,
  updatedAt: "",
  costDefId: DEF,
} as BlockDto;

function stored(rate: number | null): ComponentValueRecord[] {
  return [
    {
      positionId: "p1",
      componentDefId: DEF,
      rate,
      yearlyValue: null,
      monthlyValues: null,
      qty: null,
      unitRate: null,
      ssOpeningBase: null,
      accountCode: null,
      statsAccountCode: null,
      updatedAt: "",
    },
  ];
}

function row(over: Partial<PositionRow> = {}): PositionRow {
  return { id: "p1", ...over } as PositionRow;
}

/** One cell edit, sanitized the way the grid sanitizes it. */
function typed(value: unknown, previous: unknown = null): unknown {
  const before = row({ [KEY]: previous } as Partial<PositionRow>);
  const after = row({ [KEY]: value } as Partial<PositionRow>);
  return sanitizeBlockInputs(after, before, [BLOCK])[KEY];
}

describe("share weight — storage to row", () => {
  it("reads a weight off the rate column", () => {
    expect(applyComponentValuesToRow(row(), stored(1.5), [BLOCK])[KEY]).toBe(1.5);
  });

  it("reads the old tick box's 0 as blank, not as a zero somebody typed", () => {
    expect(applyComponentValuesToRow(row(), stored(0), [BLOCK])[KEY]).toBeNull();
  });

  it("reads the old tick box's 1 as one whole share", () => {
    expect(applyComponentValuesToRow(row(), stored(1), [BLOCK])[KEY]).toBe(1);
  });
});

describe("share weight — what the cell accepts", () => {
  it("takes a typed number, decimals included", () => {
    expect(typed("2.5")).toBe(2.5);
    expect(typed(1.25)).toBe(1.25);
  });

  it("clears to blank on empty, zero and negatives", () => {
    expect(typed("")).toBeNull();
    expect(typed(0)).toBeNull();
    expect(typed("-3")).toBeNull();
  });

  it("reads a pasted TRUE/FALSE as one share and none", () => {
    // The column was a tick box until weights arrived; the sheets people paste
    // from still hold booleans.
    expect(typed("TRUE")).toBe(1);
    expect(typed(true)).toBe(1);
    expect(typed("false")).toBeNull();
  });

  it("caps rather than letting one cell swallow the pot", () => {
    expect(typed("1e9")).toBe(1000);
  });

  it("reverts junk instead of silently emptying the cell", () => {
    expect(typed("abc", 2)).toBe(2);
  });
});

describe("share weight — row to storage", () => {
  it("patches back into the rate column", () => {
    const patches = blockPatchesFromRow(row({ [KEY]: 1.5 }), [KEY], [BLOCK]);
    expect(patches).toEqual([
      { positionId: "p1", componentDefId: DEF, fields: { rate: 1.5 } },
    ]);
  });

  it("clears to NULL rather than 0, so 'no weight' is one value", () => {
    const patches = blockPatchesFromRow(row({ [KEY]: null }), [KEY], [BLOCK]);
    expect(patches[0].fields.rate).toBeNull();
  });

  it("rebuilds the engine record the live sim spreads on", () => {
    const values = rowToComponentValues(row({ [KEY]: 2 }), [BLOCK]);
    expect(values).toHaveLength(1);
    expect(values[0].rate).toBe(2);
  });

  it("writes no record at all for a row with no weight", () => {
    expect(rowToComponentValues(row({ [KEY]: null }), [BLOCK])).toEqual([]);
  });
});
