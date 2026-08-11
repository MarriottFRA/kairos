/**
 * Run the engine over the PERSISTED scenario and overwrite the stored outputs.
 *
 * Extracted from the `positions:recalc` handler so the BST Push can recalculate
 * with byte-identical semantics before it reads the outputs. Two call sites that
 * each assembled their own input would eventually disagree about what a scenario
 * computes to — and a push that disagreed with the Results page would be worse
 * than no push at all.
 *
 * Blank-account lines (calculation-only blocks) are computed but never written:
 * the workbook's "Blank" contract, enforced in projectOutputLines.
 *
 * The engine is untouched by the level-vs-movement encoding of the headcount
 * stats: it emits the count in every active month as it always has, and the
 * projection re-expresses that as the January-plus-changes series the BST reads
 * (see toMonthlyDeltas). Choosing WHICH definitions get that treatment is the
 * only part that needs the scenario's definitions, so it happens here.
 *
 * Dependencies come in by argument (db handles, calendar/defaults lookups) so
 * this stays unit-testable and Electron-free.
 */

import type Database from "better-sqlite3-multiple-ciphers";

import { ensureSystemDefs } from "../blocks/repo";
import {
  CalendarGetter,
  PositionDefaultsGetter,
  loadScenarioInput,
} from "./loadScenarioInput";
import {
  computeFingerprint,
  cumulativeStatDefIds,
  projectAllocationLines,
  projectBuyoutLines,
  projectManualLines,
  projectOutputLines,
  projectSetupLines,
  readOutputs,
  writeRun,
} from "./outputsRepo";
import { DEFAULT_WEEKLY_HOURS } from "../../shared/positionDefaults";
import { listAllocations } from "../allocations/repo";
import { aggregateDepartmentMetrics } from "../../shared/allocations/compute";
import { listRows as listManualRows } from "../manualInput/repo";
import { loadScenarioValues } from "./positionsRepo";
import { compile, simulate } from "../../shared/engine/simulate";
import type { OutputsResponse } from "../../shared/positions/ipc";
import type { OuScope } from "./ouScope";

type Db = InstanceType<typeof Database>;

export interface RunRecalcDeps {
  /** Plaintext store: scenarios, definitions, blocks. */
  localDb: Db;
  /** Encrypted store: position values, buyouts, persisted outputs. */
  secureDb: Db;
  getCalendar: CalendarGetter;
  getDefaults: PositionDefaultsGetter;
  /** Injectable for tests; defaults to now. */
  now?: () => string;
}

/**
 * Recalculate + persist, then return the freshly stored outputs with the run's
 * diagnostics attached.
 *
 * @throws if the block setup cannot be compiled.
 */
export async function runRecalc(
  deps: RunRecalcDeps,
  scope: OuScope,
  scenarioId: string
): Promise<OutputsResponse> {
  const { localDb, secureDb, getCalendar, getDefaults } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  // The permanent system heads must exist before the definitions are read —
  // otherwise a hotel that has never opened the Blocks page recalculates with no
  // BASE_SALARY def (a hard compile error). Idempotent.
  ensureSystemDefs(localDb, scope, { now: now() });

  const input = await loadScenarioInput(
    localDb,
    secureDb,
    scope,
    scenarioId,
    getCalendar,
    getDefaults
  );

  const compiled = compile(input);
  if ("errors" in compiled) {
    throw new Error(
      compiled.errors.map((entry) => entry.message).join(" ") ||
        "The block setup cannot be calculated."
    );
  }
  const result = simulate(compiled.plan);

  // Headcount stats are LEVELS, not monthly amounts, and the BST reads a level
  // as the running sum of its months — so they post as changes: the count in
  // January (or in the month the position comes online), zero thereafter.
  const { lines, unpostedByLabel, allZeroPositions } = projectOutputLines(
    result,
    input.positions,
    cumulativeStatDefIds(input.definitions)
  );

  // ---- the four non-engine sources -----------------------------------------
  // Read here rather than inside loadScenarioInput: none of them is engine
  // INPUT — the engine never sees them and does not need to. They are output
  // contributions that land in the same dept × account table, so they belong
  // beside the projection, not beside the compile.

  // Weekly Hours reports itself as a statistic. loadScenarioInput reads the same
  // defaults to size the FTE yardstick, but it hands the engine only the derived
  // reference — and widening ScenarioInput to carry a setting the engine never
  // reads would be the wrong trade for saving one indexed single-row lookup.
  // Unsaved defaults post the built-in 40, which is both what the Home page
  // shows and what the yardstick above just used: the page and the budget must
  // report the same contract.
  const setupDefaults = await getDefaults(scope.ou, input.scenario.year);
  const setupLines = projectSetupLines({
    weeklyHours: setupDefaults?.weeklyHours ?? DEFAULT_WEEKLY_HOURS,
  });

  // Buyouts came in with the scenario input already (the compiler interns them
  // for its in-memory aggregate); this is the projection step that was missing.
  const buyoutLines = projectBuyoutLines(input.buyouts);

  const manualLines = projectManualLines(
    listManualRows(secureDb, scope.ou, scenarioId)
  );

  // Allocations spread over the SAME department metrics the Allocations page
  // shows — same loader, same aggregator, same calendar — so the two pages can
  // never disagree about a split. (aggregateDepartmentMetrics wants the stored
  // PositionRecords, not the engine's narrowed Position type, and does its own
  // active filtering.)
  const allocationLines = projectAllocationLines(
    listAllocations(localDb, scope),
    aggregateDepartmentMetrics(
      loadScenarioValues(secureDb, scope, scenarioId).positions,
      input.calendar
    )
  );

  const allLines = [
    ...lines,
    ...buyoutLines,
    ...manualLines,
    ...allocationLines,
    ...setupLines,
  ];

  // Fingerprint AFTER the load (same data the run saw).
  const fingerprint = computeFingerprint(localDb, secureDb, scope, scenarioId);
  writeRun(
    secureDb,
    scope,
    scenarioId,
    {
      fingerprint,
      computedAt: now(),
      positionCount: input.positions.length,
    },
    allLines
  );

  return {
    ...readOutputs(localDb, secureDb, scope, scenarioId),
    diagnostics: { unpostedByLabel, allZeroPositions },
  };
}
