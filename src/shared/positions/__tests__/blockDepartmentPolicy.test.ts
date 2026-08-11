/**
 * resolveBlockValues' department half of the override policy.
 *
 * A stored per-row department must only compile while its block is actually in
 * PER_ROW mode. The value stays in the DB either way, so switching a block back
 * and forth is non-destructive — but a block that is no longer in PER_ROW mode
 * must book every line to its own answer, or the grid would show one department
 * while the output used another.
 *
 * The last case guards the identity fast path: with nothing overridden,
 * resolveBlockValues must hand back the SAME objects, so an ordinary plan
 * allocates nothing new on the way into compile.
 */

import { describe, expect, it } from "vitest";
import {
  ComponentDefId,
  ComponentValue,
  CostComponentDefinition,
  PositionId,
} from "../../engine/types";
import { BlockOverridePolicy, resolveBlockValues } from "../engineInput";

const COST = "b1:cost" as ComponentDefId;

const DEFS = [
  {
    id: COST,
    ou: "H001",
    kind: "SPREAD",
    spreadMethod: "PERCENT_OF",
    label: "Shared Services Levy",
    accountCode: "A519000",
    departmentMode: "POSITION",
    increaseAware: false,
    sortOrder: 0,
    updatedAt: "",
    deletedAt: null,
  } as unknown as CostComponentDefinition,
];

const value = (overrides: Partial<ComponentValue> = {}): ComponentValue => ({
  positionId: "p1" as PositionId,
  componentDefId: COST,
  rate: 0.03,
  updatedAt: "",
  deletedAt: null,
  ...overrides,
});

const policy = (departmentPerRow: boolean): BlockOverridePolicy => ({
  costDefId: COST,
  accountLocked: true,
  statsAccountLocked: true,
  departmentPerRow,
});

describe("per-row department policy", () => {
  it("compiles the override while the block is in PER_ROW mode", () => {
    const [out] = resolveBlockValues(DEFS, [value({ departmentCode: "1910" })], [
      policy(true),
    ]);
    expect(out.departmentCode).toBe("1910");
  });

  it("discards a stored override once the block leaves PER_ROW mode", () => {
    const [out] = resolveBlockValues(DEFS, [value({ departmentCode: "1910" })], [
      policy(false),
    ]);
    expect(out.departmentCode).toBeUndefined();
    // The rest of the row is untouched — only where it books changed.
    expect(out.rate).toBe(0.03);
  });

  it("keeps the identity fast path when nothing is overridden", () => {
    const input = value();
    const [out] = resolveBlockValues(DEFS, [input], [policy(false)]);
    expect(out).toBe(input);
  });

  it("passes stored values through untouched with no policies at all", () => {
    const input = value({ departmentCode: "1910" });
    const [out] = resolveBlockValues(DEFS, [input]);
    expect(out).toBe(input);
  });
});
