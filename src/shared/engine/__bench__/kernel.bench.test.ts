/**
 * Performance regression tripwires, run with the normal test suite.
 *
 * Measured baselines for the 5k-position scenario (28 lines/position → 140k
 * lines, 375k instructions) on the reference desktop: compile ~43 ms (it was
 * ~150 before the per-line string and object allocations came out of it — see
 * the value index and the aggregate interner), full simulation ~89 ms (75 ms
 * execute + 14 ms aggregate). A throttled corporate
 * laptop (Defender, power saving) measures 3-7× slower with heavy run-to-run
 * variance — raw control loops on the same machine swing that much between
 * runs. The bounds below are the reference number × ~7, so a tripwire only
 * fires on an order-of-magnitude regression, never on machine noise.
 *
 * Those numbers are TEST-HARNESS numbers and are ~10× production. Everything in
 * this file runs under vitest, whose module evaluator turns imported constants
 * into trapped property loads — and execute.ts reads imported constants inside
 * every inner loop. Bundled, the same scenario executes in ~6 ms, not ~75 ms.
 * The bounds here are deliberately calibrated to the inflated path, because
 * that is the path this file runs on; keep them that way. For numbers that
 * describe what a user waits for, run `npm run bench:prod`.
 *
 * BOTH phases are bounded because compile is the larger of the two and used to
 * sit outside the timed region entirely: a regression there — an allocation
 * reintroduced into the per-line loop, say — was invisible to CI while the
 * simulation bound stayed green.
 */

import { describe, expect, it } from "vitest";
import { compile, simulate } from "../simulate";
import { randomScenario } from "../__tests__/fixtures";

const POSITIONS = 5000;

function planFor(): ReturnType<typeof compile> {
  return compile(randomScenario(2027, POSITIONS));
}

describe("performance tripwire", () => {
  it("simulates 5k positions in under 600 ms", () => {
    const compiled = planFor();
    if (!("plan" in compiled)) throw new Error("compile failed");

    simulate(compiled.plan); // warm-up (JIT)
    const start = performance.now();
    const result = simulate(compiled.plan);
    const elapsed = performance.now() - start;

    expect(result.aggregates.keys.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(600);
  });

  // Ratcheted down from 1000 ms once compile dropped to ~43 ms. A bound that
  // tightens with the wins is the only thing stopping them eroding one
  // convenient allocation at a time; 500 ms is still ~11× the reference.
  it("compiles 5k positions in under 500 ms", () => {
    const input = randomScenario(2027, POSITIONS);

    compile(input); // warm-up (JIT)
    const start = performance.now();
    const compiled = compile(input);
    const elapsed = performance.now() - start;

    if (!("plan" in compiled)) throw new Error("compile failed");
    expect(compiled.plan.lineCount).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});
