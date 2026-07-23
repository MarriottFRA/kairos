/**
 * Guardrail 1 — the VM must reproduce the naive reference implementation
 * BIT-FOR-BIT on randomized inputs. Any wrong paramPool offset or reordered
 * arithmetic in compile.ts/execute.ts shows up here as a concrete position,
 * component and month, with the disassembly of the failing position attached.
 */

import { describe, expect, it } from "vitest";
import { disassemble } from "../disassemble";
import { referencePosition } from "../reference";
import { compile, simulate } from "../simulate";
import { MONTHS } from "../types";
import { randomScenario } from "./fixtures";

const SEEDS = [1, 42, 20260721];

describe("VM ↔ reference parity", () => {
  for (const seed of SEEDS) {
    it(`matches the reference bit-for-bit on random scenario (seed ${seed})`, () => {
      const input = randomScenario(seed, 25);
      const compiled = compile(input);
      expect("plan" in compiled).toBe(true);
      if (!("plan" in compiled)) return;

      const result = simulate(compiled.plan);

      for (const position of input.positions) {
        const reference = referencePosition(
          position,
          input.calendar,
          input.definitions,
          input.ssSchemes,
          input.componentValues
        );
        const vmLines = result.positionLines(position.id);
        expect(vmLines.length).toBe(input.definitions.length);

        for (const vmLine of vmLines) {
          const refMonths = reference.lines.get(vmLine.component.id);
          expect(refMonths, `reference missing ${vmLine.component.label}`).toBeDefined();
          for (let m = 0; m < MONTHS; m++) {
            if (vmLine.months[m] !== refMonths![m]) {
              throw new Error(
                [
                  `parity mismatch: position ${position.id}, component "${vmLine.component.label}", month ${m + 1}`,
                  `  VM:        ${vmLine.months[m]}`,
                  `  reference: ${refMonths![m]}`,
                  disassemble(compiled.plan, position.id),
                ].join("\n")
              );
            }
          }
        }
      }
    });
  }

  it("keeps aggregates equal to the sum of reference lines (seed 7)", () => {
    const input = randomScenario(7, 15);
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);

    // Rebuild the aggregation naively from reference outputs.
    const expected = new Map<string, number[]>();
    for (const position of input.positions) {
      const reference = referencePosition(
        position,
        input.calendar,
        input.definitions,
        input.ssSchemes,
        input.componentValues
      );
      for (const def of input.definitions) {
        const dept =
          def.departmentMode === "FIXED" && def.fixedDepartment
            ? def.fixedDepartment
            : position.departmentCode;
        const key = `${dept}|${def.accountCode}`;
        const bucket = expected.get(key) ?? new Array(MONTHS).fill(0);
        const months = reference.lines.get(def.id)!;
        for (let m = 0; m < MONTHS; m++) bucket[m] += months[m];
        expected.set(key, bucket);
      }
    }

    expect(result.aggregates.keys.length).toBe(expected.size);
    result.aggregates.keys.forEach((key, row) => {
      const bucket = expected.get(`${key.dept}|${key.account}`)!;
      for (let m = 0; m < MONTHS; m++) {
        // Aggregation order differs from the naive map insertion order, so
        // allow float-noise here (parity above already pinned exactness).
        expect(result.aggregates.values[row * MONTHS + m]).toBeCloseTo(bucket[m], 6);
      }
    });
  });
});
