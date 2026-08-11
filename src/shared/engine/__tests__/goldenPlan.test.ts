/**
 * Golden PLAN snapshot — the compiled program itself, not its output.
 * -----------------------------------------------------------
 * goldenMaster.test.ts pins what the engine COMPUTES; reference-parity pins it
 * against the spec. Neither notices if the compiler emits the same numbers
 * through a differently shaped plan — a reordered `aggKeys`, a shifted
 * `paramOfs`, an instruction moved between positions. Those are exactly the
 * things a compiler refactor breaks, and they surface later as a line booked to
 * the wrong department or an incremental repack writing into the wrong slot.
 *
 * So this snapshots the plan: every typed array by a byte-exact digest (so a
 * single flipped bit fails), and the two interned DIMENSIONS in full, in order,
 * because their order is what `lineAggRow` and `positionStatRow` index into.
 * Per-array digests rather than one whole-plan hash so a failure names the
 * array that moved.
 *
 * If a change here is intended, read what moved before running `-u`. An
 * `aggKeys` reorder that "looks fine" is money landing in the wrong account.
 */

import { describe, expect, it } from "vitest";
import { compile } from "../simulate";
import type { CompiledPlan } from "../compile";
import { randomScenario } from "./fixtures";

type Typed =
  | Uint8Array
  | Uint32Array
  | Float64Array;

/** FNV-1a over the array's RAW BYTES — bit-exact, so it separates 0 from -0 and
 *  catches a float that moved in its last mantissa bit. */
function digest(array: Typed): string {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${array.length}:${hash.toString(16).padStart(8, "0")}`;
}

function planShape(plan: CompiledPlan): Record<string, unknown> {
  return {
    lineCount: plan.lineCount,
    positionCount: plan.positionIds.length,
    defCount: plan.componentDefs.length,
    instructionCount: plan.op.length,
    paramPoolLength: plan.paramPool.length,

    // Emission order: the topological sort's output. A def moving here moves
    // every line index in the matrix.
    defsInEmissionOrder: plan.componentDefs.map((def) => def.id as string),

    // The interned dimensions, in full. Insertion order IS the row index.
    aggKeys: plan.aggKeys.map((key) => `${key.dept}|${key.account}`),
    statKeys: plan.statKeys.map((key) => `${key.cluster}|${key.jobTypeCode}`),

    // Which defs the count × cluster-weight pass scales. Spelled out rather
    // than digested: it is one byte per definition, it is read by the VM's tail
    // loop, and a wrong entry silently multiplies (or fails to multiply) a whole
    // line by headcount — worth being able to read straight off a diff.
    countScaled: Array.from(plan.countScaled),

    // Everything bulk, byte-exact.
    op: digest(plan.op),
    outLine: digest(plan.outLine),
    arg0: digest(plan.arg0),
    paramOfs: digest(plan.paramOfs),
    paramPool: digest(plan.paramPool),
    positionInstrStart: digest(plan.positionInstrStart),
    lineAggRow: digest(plan.lineAggRow),
    positionStatRow: digest(plan.positionStatRow),
    seasonality: digest(plan.seasonality),
    daysPerMonth: digest(plan.daysPerMonth),
    realDays: digest(plan.realDays),
    holidayDays: digest(plan.holidayDays),
    posHeadcount: digest(plan.posHeadcount),
    posFte: digest(plan.posFte),
    posWeight: digest(plan.posWeight),
    buyoutAggRow: digest(plan.buyoutAggRow),
    buyoutValues: digest(plan.buyoutValues),
  };
}

function compilePlan(seed: number, positions: number): CompiledPlan {
  const compiled = compile(randomScenario(seed, positions));
  if (!("plan" in compiled)) {
    throw new Error(`fixture failed to compile: ${compiled.errors[0]?.message}`);
  }
  return compiled.plan;
}

describe("golden plan", () => {
  // 200 positions: big enough that every spread branch, both base ops, the
  // service bases and the per-row department override are all exercised, small
  // enough that a failure is diagnosable.
  it("compiles the 200-position fixture to a stable program", () => {
    expect(planShape(compilePlan(2027, 200))).toMatchSnapshot();
  });

  // A second seed, because one scenario can miss a branch — this one draws a
  // different mix of hourly/salaried, bank-holiday knobs and hiring dates.
  it("compiles the 50-position fixture to a stable program", () => {
    expect(planShape(compilePlan(7, 50))).toMatchSnapshot();
  });

  // Not a snapshot: the property the snapshots exist to protect. Compiling the
  // same input twice must produce the identical program, or nothing downstream
  // (a cached plan, an incremental repack) can be trusted to match a fresh run.
  it("is deterministic across repeated compiles of the same input", () => {
    const input = randomScenario(2027, 60);
    const first = compile(input);
    const second = compile(input);
    if (!("plan" in first) || !("plan" in second)) throw new Error("compile failed");
    expect(planShape(second.plan)).toEqual(planShape(first.plan));
  });
});
