/**
 * Guardrail 2 — the disassembler must render a position's program readably,
 * with component labels, dept|account targets and decoded params. (During
 * debugging: console.log(disassemble(plan, positionId)).)
 */

import { describe, expect, it } from "vitest";
import { disassemble } from "../disassemble";
import { compile } from "../simulate";
import {
  makeDef,
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
        makeValue("p1", "def-multtiered", {
          monthlyRates: [21, 21, 21, 21, 21, 30, 30, 30, 30, 30, 30, 30],
        }),
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
    // The month-varying rate decodes as the full twelve-rate vector.
    expect(text).toContain(
      'PCT_OF_ACC_M  out="Tiered Indemnity Levy" → 1010|628700  rates=[21, 21, 21, 21, 21, 30, 30, 30, 30, 30, 30, 30]'
    );
    // QTY_TIMES_RATE folds into FLAT_ACTIVE with the premultiplied yearly.
    expect(text).toContain('FLAT_ACTIVE   out="Overtime" → 1010|625000  yearly=1800');
    // The SS base decodes its source lines by label.
    expect(text).toContain('src="Pension"');
    expect(text).toContain("brackets=[≤6000@0.100000, ≤∞@0.0500000]");
  });

  it("renders COLLAPSE_LINE with its twelve weights", () => {
    const input = makeInput({
      definitions: [
        ...standardDefinitions(),
        makeDef({
          id: "def-13th",
          spreadMethod: "PERCENT_OF",
          label: "Thirteenth Salary",
          accountCode: "628900",
          sortOrder: 24,
          collapseMonths: [6, 12],
        }),
      ],
      ssSchemes: [standardScheme()],
      positions: [makePosition({ id: "p1" })],
      componentValues: [makeValue("p1", "def-13th", { rate: 1 / 12 })],
    });
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const text = disassemble(compiled.plan, posId("p1"));

    expect(text).toContain(
      'COLLAPSE_LINE out="Thirteenth Salary" → 1010|628900  weights=[0, 0, 0, 0, 0, 0.500000, 0, 0, 0, 0, 0, 0.500000]'
    );
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
