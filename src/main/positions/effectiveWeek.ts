/**
 * The effective week a scenario would post right now, beside what its last
 * run actually posted.
 *
 * The derivation is the run's own (runRecalc → projectSetupLines): the same
 * loadScenarioInput positions, the same hotel-year setup, the same pure
 * function — so the Home page's live cell and the ledger can only differ
 * when the positions changed since the run, and the response says so
 * (`posted` vs `derivation.effectiveWeek`, and the run's staleness).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { deriveEffectiveWeek } from "../../shared/positions/effectiveWeek";
import type { EffectiveWeekResponse } from "../../shared/reports/ipc";
import { readWeeklyHours } from "../../shared/reports/weeklyHours";
import { getResultsSource } from "../reports/resultsSource";
import { resolveHotelYearSetup } from "./hotelYearSetup";
import { CalendarGetter, PositionDefaultsGetter, loadScenarioInput } from "./loadScenarioInput";
import type { OuScope } from "./ouScope";
import { readRunInfo, scenarioYear } from "./positionBridge";

type Db = InstanceType<typeof Database>;

export interface EffectiveWeekDeps {
  getCalendar: CalendarGetter;
  getPositionDefaults: PositionDefaultsGetter;
}

export async function readEffectiveWeek(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  deps: EffectiveWeekDeps
): Promise<EffectiveWeekResponse> {
  const year = scenarioYear(dbs.localDb, scope, scenarioId);
  const [input, setup] = await Promise.all([
    loadScenarioInput(dbs.localDb, dbs.secureDb, scope, scenarioId, deps.getCalendar, deps.getPositionDefaults),
    resolveHotelYearSetup(deps, scope.ou, year),
  ]);
  const derivation = deriveEffectiveWeek(setup.contractWeek, setup.reference, input.positions);
  const posted = readWeeklyHours(getResultsSource(dbs.secureDb, scope, scenarioId).source);
  return {
    scenarioId,
    year,
    derivation,
    posted,
    run: readRunInfo(dbs, scope, scenarioId),
  };
}
