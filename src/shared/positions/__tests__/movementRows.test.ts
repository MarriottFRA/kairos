/**
 * Movement rows — the pure row layer for a MULTIPLIER that books the movement.
 *
 * Three invariants:
 *   1. The block exposes an "Opening balance" slot, and drops its rate slot
 *      when the per-row multiplier is switched off (the loaders then pin rate
 *      1 — applyPinnedRowRates).
 *   2. The slot reads and writes ComponentValue.ssOpeningBase — the SS column,
 *      reused — through the same read, diff and write-back paths every other
 *      slot uses, so nothing about the movement is special-cased downstream.
 *   3. The slot is there in BOTH opening-balance modes: worked out (the
 *      default) or typed, the mode only decides what BLANK means, and this
 *      layer never knows the difference.
 */

import { describe, expect, it } from "vitest";
import { BlockDto } from "../../blocks/ipc";
import {
  applyComponentValuesToRow,
  blockFieldKey,
  blockInputSlots,
  blockPatchesFromRow,
  changedBlockKeys,
  rowToComponentValues,
} from "../blockRows";
import { ComponentValueRecord } from "../ipc";
import { PositionRow } from "../rowModel";

const DEF = "b1:cost";
const OPENING_KEY = blockFieldKey(DEF, "openingBase");
const RATE_KEY = blockFieldKey(DEF, "rate");

function block(overrides: Partial<BlockDto> = {}): BlockDto {
  return {
    id: "b1",
    ou: "H001",
    blockType: "MULTIPLIER",
    label: "Indemnity Charge",
    accountCode: "628990",
    accountLocked: true,
    statsAccountCode: "",
    statsAccountLocked: true,
    base: { kind: "BLOCK", blockId: "b0" },
    movement: true,
    spread: "ACTIVE_MONTHS",
    increaseAware: false,
    departmentMode: "POSITION",
    sortOrder: 0,
    updatedAt: "",
    costDefId: DEF,
    ...overrides,
  } as BlockDto;
}

const row = (fields: Partial<PositionRow> = {}) =>
  ({ id: "p1", active: true, departmentCode: "0410", jobTypeCode: "Manager", payType: "SALARIED", ...fields }) as PositionRow;

function record(fields: Partial<ComponentValueRecord> = {}): ComponentValueRecord {
  return {
    positionId: "p1",
    componentDefId: DEF,
    rate: null,
    yearlyValue: null,
    monthlyValues: null,
    qty: null,
    unitRate: null,
    ssOpeningBase: null,
    accountCode: null,
    statsAccountCode: null,
    departmentCode: null,
    updatedAt: "",
    ...fields,
  };
}

describe("slots", () => {
  it("adds the opening balance next to the rate", () => {
    expect(blockInputSlots(block())).toEqual(["rate", "openingBase"]);
  });

  it("drops the rate when the per-row multiplier is off, keeping the opening", () => {
    expect(blockInputSlots(block({ useRowRate: false }))).toEqual(["openingBase"]);
  });

  it("drops the rate under rules too, keeping the opening", () => {
    expect(
      blockInputSlots(block({ rateRules: { rules: [], otherwise: 1 } }))
    ).toEqual(["openingBase"]);
  });

  it("exposes no opening on a block that books its result as it is", () => {
    expect(blockInputSlots(block({ movement: undefined }))).toEqual(["rate"]);
    expect(blockInputSlots(block({ movement: undefined, useRowRate: false }))).toEqual([]);
  });

  it("keeps the slot in both opening-balance modes — only what blank means differs", () => {
    for (const autoOpeningBalance of [undefined, true, false]) {
      expect(blockInputSlots(block({ autoOpeningBalance }))).toEqual(["rate", "openingBase"]);
      expect(blockInputSlots(block({ autoOpeningBalance, useRowRate: false }))).toEqual([
        "openingBase",
      ]);
    }
  });
});

describe("storage ↔ row", () => {
  it("reads the stored opening balance into the row, and no rate cell when off", () => {
    const filled = applyComponentValuesToRow(
      row(),
      [record({ ssOpeningBase: 900, rate: 0.25 })],
      [block({ useRowRate: false })]
    );
    expect(filled[OPENING_KEY]).toBe(900);
    expect(RATE_KEY in filled).toBe(false);
  });

  it("diffs and writes the opening back as ssOpeningBase", () => {
    const before = row();
    const after = row({ [OPENING_KEY]: 900 } as Partial<PositionRow>);
    const changed = changedBlockKeys(before, after, [block({ useRowRate: false })]);
    expect(changed).toEqual([OPENING_KEY]);
    expect(blockPatchesFromRow(after, changed, [block({ useRowRate: false })])).toEqual([
      { positionId: "p1", componentDefId: DEF, fields: { ssOpeningBase: 900 } },
    ]);
  });

  it("clears a blanked opening to null rather than 0", () => {
    const after = row({ [OPENING_KEY]: null } as Partial<PositionRow>);
    expect(blockPatchesFromRow(after, [OPENING_KEY], [block()])).toEqual([
      { positionId: "p1", componentDefId: DEF, fields: { ssOpeningBase: null } },
    ]);
  });

  it("rebuilds the live-sim record with the opening and no rate", () => {
    const records = rowToComponentValues(
      row({ [OPENING_KEY]: 900 } as Partial<PositionRow>),
      [block({ useRowRate: false })]
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      positionId: "p1",
      componentDefId: DEF,
      rate: null,
      ssOpeningBase: 900,
    });
  });

  it("carries a figure typed on a worked-out block exactly like a typed one", () => {
    // The override: a typed figure travels store → row → patch → live-sim
    // record unchanged, and a blank stays blank for the loaders to fill.
    const auto = [block({ autoOpeningBalance: true, useRowRate: false })];
    const filled = applyComponentValuesToRow(row(), [record({ ssOpeningBase: 0 })], auto);
    expect(filled[OPENING_KEY]).toBe(0);
    const typed = row({ [OPENING_KEY]: 0 } as Partial<PositionRow>);
    const changed = changedBlockKeys(row(), typed, auto);
    expect(changed).toEqual([OPENING_KEY]);
    expect(blockPatchesFromRow(typed, changed, auto)).toEqual([
      { positionId: "p1", componentDefId: DEF, fields: { ssOpeningBase: 0 } },
    ]);
    expect(rowToComponentValues(typed, auto)[0]).toMatchObject({ ssOpeningBase: 0 });
    for (const rebuilt of rowToComponentValues(row(), auto)) {
      expect(rebuilt.ssOpeningBase).toBeNull();
    }
  });
});
