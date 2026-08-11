/**
 * Per-row department override (a MULTIPLIER block in PER_ROW mode).
 *
 * The whole point of the design is that a department is resolved ONCE at
 * compile time and interned into `lineAggRow`, so an override moves a line's
 * dept×account key and changes nothing else. These tests pin exactly that: the
 * value matrix must be bit-identical with and without an override, and only the
 * aggregation must differ. If someone ever "optimises" this by pushing the
 * department into the VM, the first assertion is what fails.
 */

import { describe, expect, it } from "vitest";
import { compile, simulate } from "../simulate";
import { MONTHS } from "../types";
import {
  makeInput,
  makePosition,
  makeValue,
  standardDefinitions,
  standardScheme,
} from "./fixtures";

const OVERRIDE_DEPT = "1910";

function scenario(withOverride: boolean) {
  return makeInput({
    definitions: standardDefinitions(),
    ssSchemes: [standardScheme()],
    positions: [
      makePosition({ id: "pos-0001", departmentCode: "1010", monthlyBaseSalary: 4000 }),
      makePosition({ id: "pos-0002", departmentCode: "1010", monthlyBaseSalary: 3000 }),
    ],
    componentValues: [
      makeValue("pos-0001", "def-pension", {
        rate: 0.08,
        ...(withOverride ? { departmentCode: OVERRIDE_DEPT } : {}),
      }),
      makeValue("pos-0002", "def-pension", { rate: 0.08 }),
    ],
  });
}

function planFor(withOverride: boolean) {
  const compiled = compile(scenario(withOverride));
  if (!("plan" in compiled)) throw new Error("compile failed");
  return simulate(compiled.plan);
}

describe("per-row department override", () => {
  it("leaves every line value bit-identical", () => {
    const plain = planFor(false);
    const overridden = planFor(true);

    expect(overridden.state.values.length).toBe(plain.state.values.length);
    for (let i = 0; i < plain.state.values.length; i++) {
      // toBe, not toBeCloseTo: an override must not perturb arithmetic at all.
      expect(overridden.state.values[i]).toBe(plain.state.values[i]);
    }
  });

  it("moves the line onto its own dept×account key", () => {
    const plain = planFor(false);
    const overridden = planFor(true);

    const pensionAccount = standardDefinitions().find((def) =>
      String(def.id).endsWith("def-pension")
    )!.accountCode;

    const findRow = (
      result: ReturnType<typeof planFor>,
      dept: string,
      account: string
    ) =>
      result.aggregates.keys.findIndex(
        (key) => key.dept === dept && key.account === account
      );

    expect(findRow(plain, OVERRIDE_DEPT, pensionAccount)).toBe(-1);

    const movedRow = findRow(overridden, OVERRIDE_DEPT, pensionAccount);
    expect(movedRow).toBeGreaterThanOrEqual(0);
    expect(overridden.aggregates.keys.length).toBe(plain.aggregates.keys.length + 1);

    // The moved amount is exactly pos-0001's pension line, and the original
    // key keeps only pos-0002's.
    const pos1Pension = overridden
      .positionLines("pos-0001" as never)
      .find((line) => String(line.component.id).endsWith("def-pension"))!;
    expect(pos1Pension.dept).toBe(OVERRIDE_DEPT);

    const homeRow = findRow(overridden, "1010", pensionAccount);
    const plainHomeRow = findRow(plain, "1010", pensionAccount);
    for (let m = 0; m < MONTHS; m++) {
      expect(overridden.aggregates.values[movedRow * MONTHS + m]).toBeCloseTo(
        pos1Pension.months[m],
        9
      );
      expect(overridden.aggregates.values[homeRow * MONTHS + m]).toBeCloseTo(
        plain.aggregates.values[plainHomeRow * MONTHS + m] - pos1Pension.months[m],
        9
      );
    }
  });

  it("beats a FIXED department on the same definition", () => {
    const definitions = standardDefinitions().map((def) =>
      String(def.id).endsWith("def-pension")
        ? { ...def, departmentMode: "FIXED" as const, fixedDepartment: "1310" }
        : def
    );
    const input = makeInput({
      definitions,
      ssSchemes: [standardScheme()],
      positions: [makePosition({ id: "pos-0001", departmentCode: "1010" })],
      componentValues: [
        makeValue("pos-0001", "def-pension", { rate: 0.08, departmentCode: OVERRIDE_DEPT }),
      ],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);

    const line = result
      .positionLines("pos-0001" as never)
      .find((entry) => String(entry.component.id).endsWith("def-pension"))!;
    expect(line.dept).toBe(OVERRIDE_DEPT);
  });
});
