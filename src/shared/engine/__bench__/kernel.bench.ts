/**
 * Performance harness: 5,000 positions × the standard component set
 * (12 lines/position → 60k lines, ~185k instructions).
 *
 *   npm run bench
 *
 * The regression tripwire lives in kernel.bench.test.ts (full sim < 50 ms);
 * this file reports the actual numbers.
 */

import { bench, describe } from "vitest";
import { compile, simulate, recalc } from "../simulate";
import { randomScenario } from "../__tests__/fixtures";

const input = randomScenario(2027, 5000);
const compiled = compile(input);
if (!("plan" in compiled)) throw new Error("bench scenario failed to compile");
const plan = compiled.plan;
const warm = simulate(plan);
const oneDirty = [plan.positionIds[2500]];

describe("engine 5k positions", () => {
  bench("compile", () => {
    compile(input);
  });

  bench("full simulate", () => {
    simulate(plan);
  });

  bench("recalc single position (incl. full re-aggregation)", () => {
    recalc(warm.state, oneDirty);
  });
});
