/**
 * Public API of the simulation engine.
 * -----------------------------------------------------------
 *   const compiled = compile(scenarioInput);      // on load / structure change
 *   if ("errors" in compiled) → surface them
 *   let result = simulate(compiled.plan);         // full run
 *   result = recalc(result.state, [positionId]);  // per-edit incremental run
 *
 * All matrices are Float64Array, so the whole state is transferable to a Web
 * Worker later without touching this module.
 */

import { aggregate } from "./aggregate";
import { CompiledPlan } from "./compile";
import { createScratch, executeAll, executePosition } from "./execute";
import {
  EngineState,
  MONTHS,
  PositionId,
  PositionLine,
  SimulationResult,
  SimulationTimings,
} from "./types";

export { compile } from "./compile";
export type { CompiledPlan, CompileResult } from "./compile";

function buildResult(state: EngineState, timings: SimulationTimings): SimulationResult {
  const { plan, values } = state;
  const defCount = plan.componentDefs.length;

  return {
    aggregates: { keys: plan.aggKeys, values: state.aggValues },
    stats: { keys: plan.statKeys, headcount: state.statHeadcount, fte: state.statFte },
    positionLines(id: PositionId): PositionLine[] {
      const p = plan.positionIndex.get(id);
      if (p === undefined) return [];
      const lines: PositionLine[] = [];
      for (let di = 0; di < defCount; di++) {
        const line = p * defCount + di;
        const key = plan.aggKeys[plan.lineAggRow[line]];
        lines.push({
          component: plan.componentDefs[di],
          dept: key.dept,
          account: key.account,
          months: values.subarray(line * MONTHS, (line + 1) * MONTHS),
        });
      }
      return lines;
    },
    timings,
    state,
  };
}

/** Fresh full run: allocates the persistent matrices and executes every position. */
export function simulate(plan: CompiledPlan): SimulationResult {
  const state: EngineState = {
    plan,
    values: new Float64Array(plan.lineCount * MONTHS),
    aggValues: new Float64Array(plan.aggKeys.length * MONTHS),
    statHeadcount: new Float64Array(plan.statKeys.length),
    statFte: new Float64Array(plan.statKeys.length),
  };

  const execStart = performance.now();
  executeAll(plan, state.values, createScratch());
  const aggStart = performance.now();
  aggregate(plan, state.values, state.aggValues, state.statHeadcount, state.statFte);
  const aggEnd = performance.now();

  return buildResult(state, { execMs: aggStart - execStart, aggMs: aggEnd - aggStart });
}

/**
 * Incremental run: re-executes only the dirty positions' instruction ranges,
 * then re-aggregates in full. Value-only edits (amounts, rates, seasonality
 * changes re-compiled into the plan) go through here; structural changes
 * (components or positions added/removed/reordered) need a fresh compile().
 *
 * NOTE: a value edit still needs the plan's packed params refreshed — until a
 * patch helper lands in a later round, recompiling is the safe route for any
 * change. recalc() exists for callers that mutate plan.paramPool/seasonality
 * in place through their own bookkeeping, and for re-running verification.
 */
export function recalc(state: EngineState, dirty: PositionId[]): SimulationResult {
  const { plan } = state;
  const scratch = createScratch();

  const execStart = performance.now();
  for (const id of dirty) {
    const p = plan.positionIndex.get(id);
    if (p !== undefined) executePosition(plan, state.values, scratch, p);
  }
  const aggStart = performance.now();
  aggregate(plan, state.values, state.aggValues, state.statHeadcount, state.statFte);
  const aggEnd = performance.now();

  return buildResult(state, { execMs: aggStart - execStart, aggMs: aggEnd - aggStart });
}
