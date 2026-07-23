/**
 * Aggregation: line matrix → dept×account matrix, plus the staffing stats.
 * -----------------------------------------------------------
 * Always a FULL pass. At a few million adds it costs single-digit
 * milliseconds, and rebuilding from scratch every time means incremental
 * recalcs can never accumulate floating-point drift the way subtract-old /
 * add-new bookkeeping would. All row indexes were interned at compile time —
 * no hashing or string work happens here.
 */

import { CompiledPlan } from "./compile";
import { MONTHS } from "./types";

export function aggregate(
  plan: CompiledPlan,
  values: Float64Array,
  aggValues: Float64Array,
  statHeadcount: Float64Array,
  statFte: Float64Array
): void {
  aggValues.fill(0);

  const { lineAggRow, lineCount } = plan;
  for (let line = 0; line < lineCount; line++) {
    const rowOfs = lineAggRow[line] * MONTHS;
    const lineOfs = line * MONTHS;
    for (let m = 0; m < MONTHS; m++) aggValues[rowOfs + m] += values[lineOfs + m];
  }

  const buyoutCount = plan.buyoutAggRow.length;
  for (let b = 0; b < buyoutCount; b++) {
    const rowOfs = plan.buyoutAggRow[b] * MONTHS;
    const buyoutOfs = b * MONTHS;
    for (let m = 0; m < MONTHS; m++) aggValues[rowOfs + m] += plan.buyoutValues[buyoutOfs + m];
  }

  statHeadcount.fill(0);
  statFte.fill(0);
  const positionCount = plan.positionIds.length;
  for (let p = 0; p < positionCount; p++) {
    const row = plan.positionStatRow[p];
    // posHeadcount is the Count multiplier — the number of identical positions on
    // the row — so it is already the total people. FTE is stored per position, so
    // it scales by the same Count to give the row's total FTE.
    statHeadcount[row] += plan.posHeadcount[p];
    statFte[row] += plan.posFte[p] * plan.posHeadcount[p];
  }
}
