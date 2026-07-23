/**
 * Guardrail 3 — per-opcode emission tests. Compile-layer bugs (wrong param
 * order, wrong operand, missing flag) are caught here, at the layer they are
 * made, instead of surfacing as plausible-but-wrong numbers downstream.
 */

import { describe, expect, it } from "vitest";
import { compile, CompiledPlan } from "../compile";
import { FLAG_INCREASE_AWARE, LINE_NONE, Op, OP_NAMES, OpCode } from "../opcodes";
import { MONTHS, SsSchemeId } from "../types";
import { defId, makeDef, makeInput, makePosition, makeScheme, makeValue } from "./fixtures";

interface DecodedInstr {
  name: string;
  outLine: number;
  arg0: number;
  params: number[];
}

/** Decodes position p's instruction range with each op's actual param slice. */
function decode(plan: CompiledPlan, p: number): DecodedInstr[] {
  const out: DecodedInstr[] = [];
  const end = plan.positionInstrStart[p + 1];
  for (let i = plan.positionInstrStart[p]; i < end; i++) {
    const next = i + 1 < plan.op.length ? plan.paramOfs[i + 1] : plan.paramPool.length;
    out.push({
      name: OP_NAMES[plan.op[i] as OpCode],
      outLine: plan.outLine[i],
      arg0: plan.arg0[i],
      params: Array.from(plan.paramPool.subarray(plan.paramOfs[i], next)),
    });
  }
  return out;
}

function mustCompile(input: Parameters<typeof compile>[0]): CompiledPlan {
  const result = compile(input);
  if ("errors" in result) {
    throw new Error(`compile failed: ${result.errors.map((error) => error.message).join("; ")}`);
  }
  return result.plan;
}

function lineOf(plan: CompiledPlan, p: number, id: string): number {
  const di = plan.componentDefs.findIndex((def) => (def.id as string) === id);
  expect(di).toBeGreaterThanOrEqual(0);
  return p * plan.componentDefs.length + di;
}

const baseDef = () => makeDef({ id: "b", kind: "BASE_SALARY", accountCode: "610000" });

describe("instruction emission", () => {
  it("starts every position with DERIVE carrying the increase params", () => {
    const plan = mustCompile(
      makeInput({
        definitions: [baseDef()],
        positions: [
          makePosition({ id: "p1", meritIncreasePct: 0.05, manualYearlyIncrease: 600, increaseMonth: 7 }),
        ],
      })
    );
    const [derive] = decode(plan, 0);
    expect(derive.name).toBe("DERIVE");
    expect(derive.outLine).toBe(LINE_NONE);
    expect(derive.params).toEqual([0.05, 600, 7]);
  });

  it("emits the base block as BASE_SALARY / VACATION / BASE_DEDUCT on the same line", () => {
    const addl = Array.from({ length: MONTHS }, (_, m) => m * 10);
    const weights = Array.from({ length: MONTHS }, (_, m) => (m === 7 ? 1 : 0));
    const plan = mustCompile(
      makeInput({
        definitions: [baseDef()],
        positions: [
          makePosition({
            id: "p1",
            monthlyBaseSalary: 2500,
            additionalMonthlyCosts: addl,
            vacationDays: 12,
            vacationMonthlyWeights: weights,
          }),
        ],
      })
    );
    const [, base, vacation, deduct] = decode(plan, 0);
    const line = lineOf(plan, 0, "b");
    expect(base).toMatchObject({ name: "BASE_SALARY", outLine: line, params: [2500, ...addl] });
    expect(vacation).toMatchObject({
      name: "VACATION",
      outLine: LINE_NONE,
      params: [12, ...weights],
    });
    expect(deduct).toMatchObject({ name: "BASE_DEDUCT", outLine: line });
  });

  it("emits ACCRUAL with the days-per-month param", () => {
    const plan = mustCompile(
      makeInput({
        definitions: [baseDef(), makeDef({ id: "acc", kind: "HOLIDAY_ACCRUAL" })],
        positions: [makePosition({ id: "p1", accrualDaysPerMonth: 2.5 })],
      })
    );
    const accrual = decode(plan, 0).find((instr) => instr.name === "ACCRUAL");
    expect(accrual).toMatchObject({ outLine: lineOf(plan, 0, "acc"), params: [2.5] });
  });

  it("realizes a default base selector as ACC_CLEAR + ACC_ADD_GROSS", () => {
    const plan = mustCompile(
      makeInput({
        definitions: [baseDef(), makeDef({ id: "pct", spreadMethod: "PERCENT_OF" })],
        positions: [makePosition({ id: "p1" })],
        componentValues: [makeValue("p1", "pct", { rate: 0.07 })],
      })
    );
    const names = decode(plan, 0).map((instr) => instr.name);
    const clearAt = names.indexOf("ACC_CLEAR");
    expect(names.slice(clearAt, clearAt + 3)).toEqual(["ACC_CLEAR", "ACC_ADD_GROSS", "PCT_OF_ACC"]);
    const pct = decode(plan, 0)[clearAt + 2];
    expect(pct.params).toEqual([0.07]);
    expect(pct.outLine).toBe(lineOf(plan, 0, "pct"));
  });

  it("realizes an explicit component base as ACC_ADD_* ops in selector order", () => {
    const plan = mustCompile(
      makeInput({
        definitions: [
          baseDef(),
          makeDef({ id: "housing", spreadMethod: "FLAT_PER_ACTIVE_MONTH" }),
          makeDef({
            id: "pct",
            spreadMethod: "PERCENT_OF",
            baseSelector: { kind: "COMPONENTS", componentIds: [defId("housing"), defId("b")] },
          }),
        ],
        positions: [makePosition({ id: "p1" })],
      })
    );
    const decoded = decode(plan, 0);
    const clearAt = decoded.findIndex((instr) => instr.name === "ACC_CLEAR");
    expect(decoded[clearAt + 1]).toMatchObject({
      name: "ACC_ADD_LINE",
      arg0: lineOf(plan, 0, "housing"),
    });
    // The base-salary reference resolves to the gross series, not the net line.
    expect(decoded[clearAt + 2].name).toBe("ACC_ADD_GROSS");
    expect(decoded[clearAt + 3].name).toBe("PCT_OF_ACC");
  });

  it("emits FLAT_ACTIVE with the increase flag and QTY_TIMES_RATE premultiplied", () => {
    const plan = mustCompile(
      makeInput({
        definitions: [
          baseDef(),
          makeDef({ id: "housing", spreadMethod: "FLAT_PER_ACTIVE_MONTH", increaseAware: true }),
          makeDef({ id: "ot", spreadMethod: "QTY_TIMES_RATE" }),
          makeDef({ id: "transport", spreadMethod: "FLAT_PER_DAY" }),
        ],
        positions: [makePosition({ id: "p1" })],
        componentValues: [
          makeValue("p1", "housing", { yearlyValue: 2400 }),
          makeValue("p1", "ot", { qty: 120, unitRate: 15 }),
          makeValue("p1", "transport", { yearlyValue: 900 }),
        ],
      })
    );
    const decoded = decode(plan, 0);
    const housing = decoded.find(
      (instr) => instr.name === "FLAT_ACTIVE" && instr.outLine === lineOf(plan, 0, "housing")
    );
    expect(housing).toMatchObject({ arg0: FLAG_INCREASE_AWARE, params: [2400] });
    const overtime = decoded.find(
      (instr) => instr.name === "FLAT_ACTIVE" && instr.outLine === lineOf(plan, 0, "ot")
    );
    expect(overtime).toMatchObject({ arg0: 0, params: [120 * 15] });
    const transport = decoded.find((instr) => instr.name === "FLAT_DAY");
    expect(transport).toMatchObject({ arg0: 0, params: [900] });
  });

  it("emits DIRECT with exactly twelve month params, zero-filled", () => {
    const plan = mustCompile(
      makeInput({
        definitions: [baseDef(), makeDef({ id: "direct", spreadMethod: "DIRECT_MONTHLY" })],
        positions: [makePosition({ id: "p1" })],
        componentValues: [makeValue("p1", "direct", { monthlyValues: [5, 6, 7] })],
      })
    );
    const direct = decode(plan, 0).find((instr) => instr.name === "DIRECT");
    expect(direct?.params).toEqual([5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("emits SOCIAL_SEC params as caps, count, then padded bracket pairs", () => {
    const scheme = makeScheme({
      id: "sch",
      monthlyCap: 4000,
      yearlyCap: null,
      brackets: [
        { upTo: 6000, rate: 0.1 },
        { upTo: null, rate: 0.05 },
      ],
    });
    const plan = mustCompile(
      makeInput({
        definitions: [
          baseDef(),
          makeDef({ id: "ss", kind: "SOCIAL_SECURITY", ssSchemeId: "sch" as SsSchemeId }),
        ],
        ssSchemes: [scheme],
        positions: [makePosition({ id: "p1" })],
      })
    );
    const ss = decode(plan, 0).find((instr) => instr.name === "SOCIAL_SEC");
    expect(ss?.params).toEqual([
      4000, Infinity, 2,
      6000, 0.1,
      Infinity, 0.05,
      Infinity, 0, Infinity, 0, Infinity, 0, Infinity, 0, Infinity, 0,
    ]);
  });

  it("emits STAT_HOURS with vacation hours folded into the totals", () => {
    const plan = mustCompile(
      makeInput({
        definitions: [baseDef(), makeDef({ id: "hours", kind: "STAT", statKind: "HOURS" })],
        positions: [
          makePosition({ id: "p1", yearlyHoursWorked: 1600, vacationDays: 10, dailyContractHours: 8 }),
        ],
      })
    );
    const hours = decode(plan, 0).find((instr) => instr.name === "STAT_HOURS");
    expect(hours?.params.slice(0, 2)).toEqual([1600 + 80, 80]);
  });

  it("emits every op exactly once per position across two positions", () => {
    const plan = mustCompile(
      makeInput({
        definitions: [baseDef(), makeDef({ id: "hc", kind: "STAT", statKind: "HEADCOUNT" })],
        positions: [makePosition({ id: "p1", headcount: 2 }), makePosition({ id: "p2", headcount: 3 })],
      })
    );
    for (let p = 0; p < 2; p++) {
      const decoded = decode(plan, p);
      expect(decoded.map((instr) => instr.name)).toEqual([
        "DERIVE", "BASE_SALARY", "VACATION", "BASE_DEDUCT", "STAT_HC",
      ]);
      expect(decoded[4].params).toEqual([p === 0 ? 2 : 3]);
      expect(decoded[4].outLine).toBe(lineOf(plan, p, "hc"));
    }
  });
});

// Keep the Op import meaningful: the decode helper relies on OP_NAMES covering
// every opcode — fail loudly here if someone adds an op without a name.
describe("opcode table", () => {
  it("names every opcode", () => {
    for (const code of Object.values(Op)) {
      expect(OP_NAMES[code]).toBeTypeOf("string");
    }
  });
});
