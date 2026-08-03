/**
 * Preset catalogue self-consistency.
 *
 * The catalogue is hand-written data, and its one dangerous mistake is a `$ref`
 * that names a step which does not exist or has not been created yet — a typo
 * that type-checks, ships, and only surfaces as a thrown save when a user
 * clicks the row. These assertions turn that into a red test instead.
 */

import { describe, expect, it } from "vitest";
import {
  BLOCK_PRESETS,
  BLOCK_PRESET_GROUP_LABELS,
  presetRefKeys,
  resolvePresetRefs,
} from "../presets";

describe("BLOCK_PRESETS", () => {
  it("has unique preset ids", () => {
    const ids = BLOCK_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique step keys within each preset", () => {
    for (const preset of BLOCK_PRESETS) {
      const keys = preset.steps.map((step) => step.key);
      expect(new Set(keys).size, `${preset.id} step keys`).toBe(keys.length);
    }
  });

  it("has at least one step and a name for every block", () => {
    for (const preset of BLOCK_PRESETS) {
      expect(preset.steps.length, preset.id).toBeGreaterThan(0);
      for (const step of preset.steps) {
        expect(step.block.label.trim(), `${preset.id}/${step.key}`).not.toBe("");
      }
    }
  });

  it("only references steps that come earlier in the same preset", () => {
    for (const preset of BLOCK_PRESETS) {
      const seen = new Set<string>();
      for (const step of preset.steps) {
        for (const ref of presetRefKeys(step.block.base)) {
          expect(
            seen.has(ref),
            `${preset.id}/${step.key} references "${ref}" before it exists`
          ).toBe(true);
        }
        seen.add(step.key);
      }
    }
  });

  it("resolves every reference when applied in order", () => {
    for (const preset of BLOCK_PRESETS) {
      const idByKey = new Map<string, string>();
      for (const step of preset.steps) {
        expect(() =>
          resolvePresetRefs(step.block.base, idByKey)
        ).not.toThrow();
        idByKey.set(step.key, `id-${step.key}`);
      }
    }
  });

  it("gives every group a section heading", () => {
    for (const preset of BLOCK_PRESETS) {
      expect(BLOCK_PRESET_GROUP_LABELS[preset.group], preset.id).toBeTruthy();
    }
  });

  it("only puts a base on multiplier steps", () => {
    // Every other block type ignores `base` at save time, so one on a
    // FLAT_MONTHLY would be quietly dropped rather than honoured.
    for (const preset of BLOCK_PRESETS) {
      for (const step of preset.steps) {
        if (step.block.blockType === "MULTIPLIER") {
          expect(step.block.base, `${preset.id}/${step.key}`).toBeDefined();
        } else {
          expect(step.block.base, `${preset.id}/${step.key}`).toBeUndefined();
        }
      }
    }
  });
});

describe("resolvePresetRefs", () => {
  const ids = new Map([["a", "id-a"], ["b", "id-b"]]);

  it("leaves a real block id alone", () => {
    expect(resolvePresetRefs({ kind: "BLOCK", blockId: "real" }, ids)).toEqual({
      kind: "BLOCK",
      blockId: "real",
    });
  });

  it("rewrites both sides of a combine", () => {
    expect(
      resolvePresetRefs(
        {
          kind: "COMBINE",
          op: "MUL",
          left: { kind: "BLOCK", blockId: "$a" },
          right: { kind: "BLOCK", blockId: "$b" },
        },
        ids
      )
    ).toEqual({
      kind: "COMBINE",
      op: "MUL",
      left: { kind: "BLOCK", blockId: "id-a" },
      right: { kind: "BLOCK", blockId: "id-b" },
    });
  });

  it("rewrites composite members", () => {
    expect(
      resolvePresetRefs(
        { kind: "COMPOSITE", includeBaseSalary: true, blockIds: ["$a", "real"] },
        ids
      )
    ).toEqual({
      kind: "COMPOSITE",
      includeBaseSalary: true,
      blockIds: ["id-a", "real"],
    });
  });

  it("throws on a reference that has not been created", () => {
    expect(() =>
      resolvePresetRefs({ kind: "BLOCK", blockId: "$missing" }, ids)
    ).toThrow(/missing/);
  });
});
