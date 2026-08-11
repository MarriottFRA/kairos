/**
 * Performance harness: 5,000 positions × the standard component set
 * (28 lines/position → 140k lines, ~375k instructions).
 *
 *   npm run bench                  # the standard matrix
 *   BENCH_STRESS=1 npm run bench   # adds the 10k × 100 stress case
 *
 * READ THIS BEFORE QUOTING A NUMBER FROM HERE. These figures are inflated
 * roughly 10x and DO NOT describe production. vitest evaluates modules through
 * a transform that wraps each namespace in a Proxy and defines named exports as
 * accessors (vitest/dist/module-evaluator.js). An imported `const` is therefore
 * not a constant at run time. execute.ts uses the imported MONTHS as the bound
 * of every inner loop and the imported SCRATCH_* as offsets inside them, so the
 * VM's hot loops pay a trapped property load per iteration — measured at
 * ~26 ns/element against ~0.7 ns for a local const. Production is
 * rollup-bundled and pays none of it:
 *
 *     5,000 x 28    execute   86 ms here    6.2 ms bundled
 *                   aggregate 15 ms here    0.9 ms bundled
 *
 * Use `npm run bench:prod` for numbers that describe what a user waits for.
 * This file is still worth keeping: its numbers are internally consistent, so
 * they track relative regressions, and kernel.bench.test.ts's bounds are
 * calibrated against them. Just never quote them as the engine's real cost —
 * doing exactly that is what once prompted a proposal to rewrite the VM.
 *
 * Compile used to be ~150 ms and DOMINATE — it allocated a lookup string and a
 * key object per line — so if you see it drift, look for an allocation that has
 * crept into the per-line loop. Scaling is linear on both axes, so a number
 * growing faster than the position count is a regression in kind, not degree.
 *
 * TWO AXES, and they are not interchangeable. Rows scale the instruction count
 * and the line matrix. WIDTH — definitions per position, which a block-heavy
 * install pushes to 50-100 against the 28 here — additionally scales the
 * aggregate matrix (sized by definitions × departments, not by rows) and the
 * count × weight post-pass in execute.ts, which walks defCount per position.
 * Stacking on more rows never surfaces either, so the matrix below benches both.
 * A hotel at 1,000 × 100 is the shape the live sim has to absorb synchronously
 * on the UI thread, on every committed grid edit.
 *
 * The exec/agg split is printed once per case at startup, from simulate()'s own
 * timings — tinybench only reports wall clock for the whole call.
 *
 * The regression tripwires live in kernel.bench.test.ts and bound BOTH phases;
 * this file reports the actual numbers.
 */

import { bench, describe } from "vitest";
import { compile, recalc, simulate } from "../simulate";
import { randomScenario } from "../__tests__/fixtures";
import type { CompiledPlan } from "../compile";
import type { ScenarioInput } from "../types";

interface Case {
  label: string;
  input: ScenarioInput;
  plan: CompiledPlan;
}

function makeCase(positions: number, width?: number): Case {
  const input = randomScenario(2027, positions, width);
  const compiled = compile(input);
  if (!("plan" in compiled)) throw new Error(`bench scenario ${positions}×${width} failed to compile`);
  return { label: `${positions} × ${width ?? 28}`, input, plan: compiled.plan };
}

const cases: Case[] = [
  makeCase(5000), // the historical baseline — unchanged, for continuity
  makeCase(1000, 100), // the realistic block-heavy hotel
  makeCase(5000, 100), // headroom
  ...(process.env.BENCH_STRESS ? [makeCase(10000, 100)] : []),
];

// Startup report: the exec/agg split and the shape of each case, which the
// tinybench table below cannot show.
for (const c of cases) {
  const { plan } = c;
  const run = simulate(plan);
  const instructions = plan.op.length;
  process.stdout.write(
    `  [bench] ${c.label.padEnd(12)} ` +
      `lines=${String(plan.lineCount).padStart(7)} ` +
      `instr=${String(instructions).padStart(8)} ` +
      `aggRows=${String(plan.aggKeys.length).padStart(5)} ` +
      `exec=${run.timings.execMs.toFixed(1).padStart(7)}ms ` +
      `agg=${run.timings.aggMs.toFixed(1).padStart(6)}ms\n`
  );
}

// The original 5k × 28 block, kept verbatim so historical numbers stay comparable.
describe("engine 5k positions", () => {
  const plan = cases[0].plan;
  const input = cases[0].input;
  const warm = simulate(plan);
  const oneDirty = [plan.positionIds[2500]];

  bench("compile", () => {
    compile(input);
  });

  bench("full simulate", () => {
    simulate(plan);
  });

  // Isolates aggregation: one position's instruction range, then a FULL rebuild.
  bench("recalc single position (incl. full re-aggregation)", () => {
    recalc(warm.state, oneDirty);
  });
});

describe("engine width axis", () => {
  for (const c of cases.slice(1)) {
    bench(`compile ${c.label}`, () => {
      compile(c.input);
    });

    bench(`full simulate ${c.label}`, () => {
      simulate(c.plan);
    });
  }
});
