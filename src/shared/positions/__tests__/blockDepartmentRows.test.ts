/**
 * The per-row department override, end to end through the pure row layer:
 * storage -> flat row -> sanitize -> diff -> patch -> live-sim rebuild.
 *
 * Every one of those steps has an account twin already, and the two must stay
 * in step — a department that survives the trip out but not back is a cell that
 * looks saved and is not.
 */

import { describe, expect, it } from "vitest";
import { BlockDto } from "../../blocks/ipc";
import { ComponentValueRecord } from "../ipc";
import { PositionRow } from "../rowModel";
import {
  applyComponentValuesToRow,
  blockDepartmentKey,
  blockDepartmentRowKeys,
  blockOverrideRowKeys,
  blockPatchesFromRow,
  changedBlockKeys,
  rowToComponentValues,
  sanitizeBlockInputs,
} from "../blockRows";

const DEF = "b1:cost";

function block(overrides: Partial<BlockDto> = {}): BlockDto {
  return {
    id: "b1",
    ou: "H001",
    blockType: "MULTIPLIER",
    label: "Shared Services Levy",
    accountCode: "A519000",
    accountLocked: true,
    statsAccountCode: "",
    statsAccountLocked: true,
    spread: "ACTIVE_MONTHS",
    increaseAware: false,
    departmentMode: "PER_ROW",
    sortOrder: 0,
    updatedAt: "",
    costDefId: DEF,
    ...overrides,
  } as BlockDto;
}

function stored(departmentCode: string | null): ComponentValueRecord[] {
  return [
    {
      positionId: "p1",
      componentDefId: DEF,
      rate: 0.03,
      yearlyValue: null,
      monthlyValues: null,
      qty: null,
      unitRate: null,
      ssOpeningBase: null,
      accountCode: null,
      statsAccountCode: null,
      departmentCode,
      updatedAt: "",
    },
  ];
}

const row = (fields: Partial<PositionRow> = {}) =>
  ({ id: "p1", ...fields }) as PositionRow;

describe("block department row keys", () => {
  it("appears only for a PER_ROW multiplier", () => {
    expect(blockDepartmentRowKeys(block())).toEqual([blockDepartmentKey(DEF)]);
    expect(blockDepartmentRowKeys(block({ departmentMode: "POSITION" }))).toEqual([]);
    expect(blockDepartmentRowKeys(block({ departmentMode: "FIXED" }))).toEqual([]);
    expect(
      blockDepartmentRowKeys(block({ blockType: "FLAT_MONTHLY" }))
    ).toEqual([]);
  });

  it("is included in the override keys alongside accounts", () => {
    const unlocked = block({ accountLocked: false });
    expect(blockOverrideRowKeys(unlocked)).toContain(blockDepartmentKey(DEF));
    expect(blockOverrideRowKeys(unlocked)).toHaveLength(2);
  });
});

describe("storage -> row", () => {
  it("folds a stored department onto the row", () => {
    const out = applyComponentValuesToRow(row(), stored("1910"), [block()]);
    expect(out[blockDepartmentKey(DEF)]).toBe("1910");
  });

  it("reads null as blank — the row's own department", () => {
    const out = applyComponentValuesToRow(row(), stored(null), [block()]);
    expect(out[blockDepartmentKey(DEF)]).toBeNull();
  });

  it("ignores a stored department while the block is not in PER_ROW mode", () => {
    const out = applyComponentValuesToRow(row(), stored("1910"), [
      block({ departmentMode: "POSITION" }),
    ]);
    expect(out[blockDepartmentKey(DEF)]).toBeUndefined();
  });
});

describe("row -> storage patch", () => {
  it("trims, and treats whitespace as a clear", () => {
    const out = sanitizeBlockInputs(
      row({ [blockDepartmentKey(DEF)]: "  1910  " }),
      row(),
      [block()]
    );
    expect(out[blockDepartmentKey(DEF)]).toBe("1910");

    const blanked = sanitizeBlockInputs(
      row({ [blockDepartmentKey(DEF)]: "   " }),
      row({ [blockDepartmentKey(DEF)]: "1910" }),
      [block()]
    );
    expect(blanked[blockDepartmentKey(DEF)]).toBeNull();
  });

  it("diffs and patches the department like an account", () => {
    const before = row({ [blockDepartmentKey(DEF)]: null });
    const after = row({ [blockDepartmentKey(DEF)]: "1910" });

    const changed = changedBlockKeys(before, after, [block()]);
    expect(changed).toEqual([blockDepartmentKey(DEF)]);

    const patches = blockPatchesFromRow(after, changed, [block()]);
    expect(patches).toEqual([
      { positionId: "p1", componentDefId: DEF, fields: { departmentCode: "1910" } },
    ]);
  });

  it("patches a clear back to null", () => {
    const after = row({ [blockDepartmentKey(DEF)]: null });
    const patches = blockPatchesFromRow(after, [blockDepartmentKey(DEF)], [block()]);
    expect(patches[0].fields.departmentCode).toBeNull();
  });
});

describe("row -> live-sim values", () => {
  it("carries the department, and makes the row worth simulating on its own", () => {
    const values = rowToComponentValues(
      row({ [blockDepartmentKey(DEF)]: "1910" }),
      [block()]
    );
    expect(values).toHaveLength(1);
    expect(values[0].departmentCode).toBe("1910");
  });

  it("drops the department when the block is no longer in PER_ROW mode", () => {
    const values = rowToComponentValues(
      row({ [blockDepartmentKey(DEF)]: "1910" }),
      [block({ departmentMode: "POSITION" })]
    );
    expect(values).toHaveLength(0);
  });
});
