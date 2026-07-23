/**
 * Guardrail 2 — the disassembler must render a position's program readably,
 * with component labels, dept|account targets and decoded params. (During
 * debugging: console.log(disassemble(plan, positionId)).)
 */

import { describe, expect, it } from "vitest";
import { disassemble } from "../disassemble";
import { compile } from "../simulate";
import {
  makeInput,
  makePosition,
  makeValue,
  posId,
  standardDefinitions,
  standardScheme,
} from "./fixtures";

describe("disassemble", () => {
  it("renders the standard component set with labels, targets and params", () => {
    const input = makeInput({
      definitions: standardDefinitions(),
      ssSchemes: [standardScheme()],
      positions: [
        makePosition({
          id: "p1",
          payType: "HOURLY",
          seasonality: [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],
          monthlyBaseSalary: 900,
          meritIncreasePct: 0.1,
          increaseMonth: 7,
        }),
      ],
      componentValues: [
        makeValue("p1", "def-pension", { rate: 0.05 }),
        makeValue("p1", "def-overtime", { qty: 120, unitRate: 15 }),
      ],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const text = disassemble(compiled.plan, posId("p1"));

    expect(text).toContain("position p1");
    expect(text).toContain('BASE_SALARY   out="Base Salary" → 1010|610000  monthlyBase=900');
    expect(text).toContain("meritPct=0.100000");
    expect(text).toContain("increaseMonth=7");
    expect(text).toContain('PCT_OF_ACC    out="Pension" → 1010|620000  rate=0.0500000');
    // QTY_TIMES_RATE folds into FLAT_ACTIVE with the premultiplied yearly.
    expect(text).toContain('FLAT_ACTIVE   out="Overtime" → 1010|625000  yearly=1800');
    // The SS base decodes its source lines by label.
    expect(text).toContain('src="Pension"');
    expect(text).toContain("brackets=[≤6000@0.100000, ≤∞@0.0500000]");
  });

  it("reports an unknown position instead of throwing", () => {
    const input = makeInput({
      definitions: standardDefinitions(),
      ssSchemes: [standardScheme()],
      positions: [makePosition({ id: "p1" })],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    expect(disassemble(compiled.plan, posId("ghost"))).toContain("not found");
  });
});
