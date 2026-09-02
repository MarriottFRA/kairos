/**
 * DIRECT_ABS opcode — the absolute pass-through used for KPI-driven blocks.
 *
 * Unlike DIRECT_MONTHLY (× seasonality, optionally × increase) and unlike every
 * currency line (× headcount at the count-multiplier pass), DIRECT_ABS must emit
 * its 12 values verbatim: no seasonality, no increase, no headcount scaling. The
 * KPI series is already resolved to absolute per-month figures at load time, so
 * this is the only faithful path — proven here against a seasonal, multi-head
 * position where DIRECT_MONTHLY would visibly diverge. Parity with reference.ts
 * is asserted so the VM and the spec stay in lockstep.
 */

import { describe, expect, it } from "vitest";
import { referencePosition } from "../reference";
import { compile, simulate } from "../simulate";
import { MONTHS } from "../types";
import {
  makeDef,
  makeInput,
  makePosition,
  makeValue,
  defId,
} from "./fixtures";

// A position that is inactive in some months (seasonality 0) and represents
// several identical heads — exactly the cases that would corrupt a KPI value
// routed through DIRECT_MONTHLY or scaled by headcount.
const SEASONALITY = [1, 0.5, 0, 1, 0.25, 0, 1, 1, 0, 0.75, 1, 0];
const KPI_MONTHLY = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];

function buildInput() {
  // A BASE_SALARY component is mandatory (compile rejects a scenario without
  // exactly one); it is irrelevant to the DIRECT_ABS assertions below.
  const baseDef = makeDef({
    id: "def-base",
    kind: "BASE_SALARY",
    label: "Base Salary",
    accountCode: "610000",
    sortOrder: 0,
  });
  const kpiDef = makeDef({
    id: "def-kpi",
    spreadMethod: "DIRECT_ABS",
    label: "KPI Driven",
    accountCode: "640000",
    sortOrder: 2,
  });
  // A DIRECT_MONTHLY twin with the SAME values, to contrast the two paths.
  const directDef = makeDef({
    id: "def-direct",
    spreadMethod: "DIRECT_MONTHLY",
    label: "Direct Monthly",
    accountCode: "641000",
    sortOrder: 1,
  });
  const position = makePosition({
    id: "pos-1",
    headcount: 3,
    seasonality: SEASONALITY,
  });
  return makeInput({
    definitions: [baseDef, kpiDef, directDef],
    positions: [position],
    componentValues: [
      makeValue("pos-1", "def-kpi", { monthlyValues: KPI_MONTHLY }),
      makeValue("pos-1", "def-direct", { monthlyValues: KPI_MONTHLY }),
    ],
  });
}

describe("DIRECT_ABS", () => {
  it("emits the values verbatim — no seasonality, no headcount scaling", () => {
    const input = buildInput();
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);

    const lines = result.positionLines(input.positions[0].id);
    const kpiLine = lines.find((l) => l.component.id === defId("def-kpi"))!;
    const directLine = lines.find((l) => l.component.id === defId("def-direct"))!;

    for (let m = 0; m < MONTHS; m++) {
      // DIRECT_ABS: exactly the input, ignoring seasonality and the 3 heads.
      expect(kpiLine.months[m]).toBe(KPI_MONTHLY[m]);
      // DIRECT_MONTHLY twin: × seasonality × headcount — visibly different.
      expect(directLine.months[m]).toBeCloseTo(
        KPI_MONTHLY[m] * SEASONALITY[m] * 3,
        6
      );
    }
  });

  it("collapses into chosen months like any other line — still seasonality-gated", () => {
    // A KPI-driven multiplier with collapseMonths: the absolute series is
    // computed as usual, then the year's figure lands in the chosen months.
    // The collapse TARGET keeps the inactive-month gate even though DIRECT_ABS
    // itself ignores seasonality — one drop policy everywhere (collapseWeights).
    const input = buildInput();
    const kpiDef = input.definitions.find((d) => d.id === defId("def-kpi"))!;

    kpiDef.collapseMonths = [4]; // April, active (seasonality 1)
    let compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    let line = simulate(compiled.plan)
      .positionLines(input.positions[0].id)
      .find((l) => l.component.id === defId("def-kpi"))!;
    const yearTotal = KPI_MONTHLY.reduce((a, b) => a + b, 0);
    for (let m = 0; m < MONTHS; m++) {
      // Whole year in April, still no headcount scaling (DIRECT_ABS is exempt).
      expect(line.months[m]).toBe(m === 3 ? yearTotal : 0);
    }
    let reference = referencePosition(
      input.positions[0], input.calendar, input.definitions,
      input.ssSchemes, input.componentValues
    );
    for (let m = 0; m < MONTHS; m++) {
      expect(line.months[m]).toBe(reference.lines.get(defId("def-kpi"))![m]);
    }

    kpiDef.collapseMonths = [3]; // March: seasonality 0 — the cost is dropped.
    compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    line = simulate(compiled.plan)
      .positionLines(input.positions[0].id)
      .find((l) => l.component.id === defId("def-kpi"))!;
    reference = referencePosition(
      input.positions[0], input.calendar, input.definitions,
      input.ssSchemes, input.componentValues
    );
    for (let m = 0; m < MONTHS; m++) {
      expect(line.months[m]).toBe(0);
      expect(reference.lines.get(defId("def-kpi"))![m]).toBe(0);
    }
  });

  it("matches the reference implementation bit-for-bit", () => {
    const input = buildInput();
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);

    const reference = referencePosition(
      input.positions[0],
      input.calendar,
      input.definitions,
      input.ssSchemes,
      input.componentValues
    );
    for (const vmLine of result.positionLines(input.positions[0].id)) {
      const refMonths = reference.lines.get(vmLine.component.id)!;
      for (let m = 0; m < MONTHS; m++) {
        expect(vmLine.months[m]).toBe(refMonths[m]);
      }
    }
  });
});
