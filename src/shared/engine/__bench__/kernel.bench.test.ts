/**
 * Performance regression tripwire, run with the normal test suite.
 *
 * Measured baselines for the 5k-position scenario (60k lines, 115k instrs):
 * a typical desktop runs the full simulation in ~10-20 ms; a throttled
 * corporate laptop (Defender, power saving) measures ~50-100 ms with heavy
 * run-to-run variance — raw control loops on the same machine swing 3-7×
 * between runs. The 250 ms bound is deliberately loose so the tripwire only
 * fires on order-of-magnitude regressions, never on machine noise. Use
 * `npm run bench` for real numbers.
 */

import { describe, expect, it } from "vitest";
import { compile, simulate } from "../simulate";
import { randomScenario } from "../__tests__/fixtures";

describe("performance tripwire", () => {
  it("simulates 5k positions in under 250 ms", () => {
    const input = randomScenario(2027, 5000);
    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");

    simulate(compiled.plan); // warm-up (JIT)
    const start = performance.now();
    const result = simulate(compiled.plan);
    const elapsed = performance.now() - start;

    expect(result.aggregates.keys.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250);
  });
});
