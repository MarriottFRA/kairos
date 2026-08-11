/**
 * Production-representative engine benchmark.
 * -----------------------------------------------------------
 * Run it with `npm run bench:prod`, NOT under vitest. This entry is bundled by
 * scripts/bench-prod.js and executed on plain node, which is the whole point.
 *
 * WHY THIS EXISTS. `npm run bench` runs under vitest, and vitest evaluates
 * modules through a transform that wraps each module namespace in a Proxy and
 * defines named exports as accessors (see vitest/dist/module-evaluator.js).
 * An imported `const` is therefore NOT a constant at run time — it is a trapped
 * property load. execute.ts uses the imported `MONTHS` as the bound of every
 * inner loop and the imported `SCRATCH_*` as offsets inside them, so the VM's
 * hot loops pay that trap on every single iteration. Measured: a Proxy-backed
 * namespace read in an inner loop costs ~26 ns/element against ~0.7 ns for a
 * local const.
 *
 * The result is that vitest reports the engine ~10x slower than it really is:
 * 5,000 x 28 measures ~86 ms execute under vitest and ~8 ms bundled. The
 * production renderer is rollup-bundled, so it gets the fast path — the numbers
 * here are the ones that describe what a user actually waits for.
 *
 * Keep `npm run bench` too: its numbers are inflated but internally consistent,
 * so it is still valid for spotting relative regressions, and the tripwire
 * bounds in kernel.bench.test.ts are calibrated against it.
 */

import { compile, simulate } from "../simulate";
import { randomScenario } from "../__tests__/fixtures";

const RUNS = 9;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** positions x definitions. Width matters independently of rows: it sizes the
 *  aggregate matrix (definitions x departments) and the count x weight
 *  post-pass, neither of which more rows would ever exercise. */
const CASES: Array<[positions: number, width: number | undefined]> = [
  [1000, undefined],
  [5000, undefined],
  [1000, 100],
  [5000, 100],
  [10000, 100],
];

console.log(
  "  case            lines     instr  aggRows   compile      exec       agg   ns/instr"
);

for (const [positions, width] of CASES) {
  const input = randomScenario(2027, positions, width);

  const compileMs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    compile(input);
    compileMs.push(performance.now() - t);
  }

  const compiled = compile(input);
  if (!("plan" in compiled)) throw new Error(`${positions}x${width ?? 28} failed to compile`);
  const plan = compiled.plan;

  const execMs: number[] = [];
  const aggMs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const result = simulate(plan);
    execMs.push(result.timings.execMs);
    aggMs.push(result.timings.aggMs);
  }

  const exec = median(execMs);
  console.log(
    `  ${`${positions} x ${width ?? 28}`.padEnd(13)} ` +
      `${String(plan.lineCount).padStart(7)} ${String(plan.op.length).padStart(9)} ` +
      `${String(plan.aggKeys.length).padStart(8)} ` +
      `${median(compileMs).toFixed(1).padStart(8)}ms ${exec.toFixed(1).padStart(8)}ms ` +
      `${median(aggMs).toFixed(1).padStart(7)}ms ` +
      `${((exec * 1e6) / plan.op.length).toFixed(1).padStart(10)}`
  );
}
