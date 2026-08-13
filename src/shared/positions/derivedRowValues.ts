/**
 * The per-row values the grid DISPLAYS but does not store.
 * -----------------------------------------------------------
 * Vacation cost, derived manhours, derived FTE and every block's live-sim total
 * are all recomputed from `rows` on every committed edit. They are read only
 * inside column callbacks (valueGetter / valueSetter / renderCell), never at
 * column-build time.
 *
 * That distinction is the whole point of this module. Passed as four plain Maps
 * they were four column-memo DEPENDENCIES, so one cell commit rebuilt every
 * colDef, re-ran MUI's column pipeline and defeated GridRow's memo for every
 * mounted row — a full-grid re-render to change one number. Passed as ONE ref
 * whose identity never changes, the columns are built once and the callbacks
 * read the current values when they run.
 *
 * The idiom is the one already used for `statusByRow` (see
 * services/positionsWriteQueue.emit, which deliberately re-emits the SAME Map
 * instance) and for the render-assigned refs in routes/nestedPages/positions.
 *
 * THE INVARIANT, and the reason a stale sort is not possible here: every
 * mutation of the ref must be followed IN THE SAME COMMIT by either a `rows`
 * prop change or an explicit `apiRef.updateRows(...)`. MUI caches sorted and
 * filtered row order, so a displayed value that moves with neither would leave
 * that order stale. Three of the four maps satisfy this for free — their values
 * change only for a row whose object identity also changed. `blockResults` does
 * not: a pooled block re-slices every member when any one of them is edited, so
 * routes/nestedPages/positions diffs it and calls updateRows for the rows whose
 * totals actually moved.
 */

import type { BlockDto } from "../blocks/ipc";
import {
  RateRuleBindContext,
  RateRuleResult,
  bindRateRules,
  evaluateBoundRules,
} from "../blocks/rateRules";
import type { BlockResultsById } from "./liveSim";
import type { PositionRow } from "./rowModel";
import { serviceDaysFor } from "./serviceDays";

export interface DerivedRowValues {
  /** Simulated vacation cost per row id (engine reference math). */
  vacationCostById: ReadonlyMap<string, number>;
  /** Calendar-derived Manhours Worked per row id — shown when the cell carries
   *  no positive manual override. */
  manhoursWorkedById: ReadonlyMap<string, number>;
  /** Derived FTE per row id — the row's contract over the hotel-year full-time
   *  reference. */
  fteById: ReadonlyMap<string, number>;
  /**
   * Per-row live-sim block lines. Empty rather than null while the structure or
   * calendar load: an empty map and a null map render identically (a blank
   * cell), and a non-nullable field removes a branch from a per-cell callback.
   */
  blockResults: BlockResultsById;
  /** rowId → costDefId → the rate a rules-driven multiplier resolved to (the
   *  read-only cell where the rate column used to be). */
  ruleRatesById: ReadonlyMap<string, ReadonlyMap<string, RateRuleResult>>;
}

/**
 * Structural, not React's RefObject — the form dialog and the tests build one
 * inline, and nothing here needs React.
 */
export type DerivedRowValuesRef = { readonly current: DerivedRowValues };

export const EMPTY_DERIVED_ROW_VALUES: DerivedRowValues = {
  vacationCostById: new Map(),
  manhoursWorkedById: new Map(),
  fteById: new Map(),
  blockResults: new Map(),
  ruleRatesById: new Map(),
};

/**
 * The displayed rate of every rules-driven multiplier, per row — the SAME
 * evaluator the loaders run (bind once per block, evaluate per row), over the
 * SAME subject shape the live sim builds (the row is the bag, engine scalars
 * read off the row's own columns, service days from the hiring date). The cell
 * therefore cannot disagree with what the engine multiplied by.
 */
export function ruleRatesForRows(
  rows: readonly PositionRow[],
  blocks: readonly BlockDto[],
  planYear: number | null,
  ctx: RateRuleBindContext = {}
): Map<string, Map<string, RateRuleResult>> {
  const out = new Map<string, Map<string, RateRuleResult>>();
  const ruleBlocks = blocks.filter(
    (block) => block.blockType === "MULTIPLIER" && block.rateRules
  );
  if (ruleBlocks.length === 0 || planYear === null) return out;

  const bound = ruleBlocks.map((block) => ({
    costDefId: block.costDefId,
    rules: bindRateRules(block.rateRules!, ctx),
  }));

  for (const row of rows) {
    if (row.active === false) continue;
    const service = serviceDaysFor(
      typeof row.hiringDate === "string" ? row.hiringDate : null,
      planYear
    );
    const subject = {
      bag: row as Record<string, unknown>,
      departmentCode: typeof row.departmentCode === "string" ? row.departmentCode : "",
      jobTypeCode: typeof row.jobTypeCode === "string" ? row.jobTypeCode : "",
      payType: typeof row.payType === "string" ? row.payType : "",
      serviceDaysPerMonth: service.perMonth,
      serviceDaysOpening: service.opening,
    };
    const byDef = new Map<string, RateRuleResult>();
    for (const block of bound) {
      byDef.set(block.costDefId, evaluateBoundRules(block.rules, subject));
    }
    out.set(String(row.id), byDef);
  }
  return out;
}

/**
 * A fixed ref for callers with nothing to update — tests, and any consumer
 * rendering a snapshot rather than a live grid.
 */
export function staticDerivedRowValues(
  partial: Partial<DerivedRowValues> = {}
): DerivedRowValuesRef {
  return { current: { ...EMPTY_DERIVED_ROW_VALUES, ...partial } };
}

/**
 * Row ids whose block TOTAL differs between two live-sim results.
 *
 * Only `.total` is compared because only `.total` is displayed (see
 * blockColumns' Total column) — the monthly vectors behind it are read by the
 * form dialog, which re-renders on its own. Rows present in one map and not the
 * other count as changed, so a row appearing or disappearing refreshes too.
 *
 * Exact equality, not an epsilon: these are two runs of the same deterministic
 * engine, so "changed" means a different double, and rounding a comparison here
 * would silently drop a real one-cent movement.
 */
export function rowIdsWithChangedTotals(
  before: BlockResultsById,
  after: BlockResultsById
): string[] {
  const changed: string[] = [];
  for (const [rowId, afterLines] of after) {
    const beforeLines = before.get(rowId);
    if (!beforeLines) {
      changed.push(rowId);
      continue;
    }
    if (beforeLines.size !== afterLines.size) {
      changed.push(rowId);
      continue;
    }
    for (const [defId, afterLine] of afterLines) {
      const beforeLine = beforeLines.get(defId);
      if (!beforeLine || beforeLine.total !== afterLine.total) {
        changed.push(rowId);
        break;
      }
    }
  }
  // A row that vanished from the results (deactivated, deleted) also needs its
  // cells cleared — but only if the grid still holds it; callers filter.
  for (const rowId of before.keys()) {
    if (!after.has(rowId)) changed.push(rowId);
  }
  return changed;
}
