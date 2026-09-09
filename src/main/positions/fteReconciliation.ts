/**
 * The FTE reconciliation read: a scenario's positions on one side, its
 * results on the other, per department.
 *
 * The grid side is the same call the engine run and the Staffing overview
 * make (loadScenarioInput), so the FTE here IS the Positions grid's. The
 * account side is the staffing catalog's FTE evaluated by the shared engine
 * on the scenario's results cache, under the very column plan the Reports
 * page uses for a Kairos column — same atoms, same work-week fallback chain
 * (evaluate.ts), same warnings — so this page and the reports cannot
 * disagree. Departments come from either side: one with positions but no
 * results, or results but no positions, still gets its row.
 *
 * Stale is the run info: the positions are current by construction; it
 * says whether the results lag behind them.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { bareDept } from "../../shared/positions/comboKey";
import { compileDefinition } from "../../shared/reports/compile";
import type { SeriesColumnSpec } from "../../shared/reports/columns";
import { evaluateReport } from "../../shared/reports/engine";
import {
  FtePositionInput,
  FteReconciliationResponse,
  aggregateGridFte,
  buildFteReconciliation,
  buildFteReconciliationDefinition,
  readAccountSides,
  readFteHoursYear,
} from "../../shared/reports/fteReconciliation";
import { PACK_GROUP_LEVEL, groupOf, packLabelsOf } from "../../shared/reports/packs";
import { planColumns } from "../reports/evaluate";
import { getMapIndex } from "../reports/mapsIndex";
import { getResultsSource } from "../reports/resultsSource";
import { CalendarGetter, PositionDefaultsGetter, loadScenarioInput } from "./loadScenarioInput";
import type { OuScope } from "./ouScope";
import { readRunInfo, scenarioYear } from "./positionBridge";

type Db = InstanceType<typeof Database>;

export interface FteReconciliationDeps {
  getCalendar: CalendarGetter;
  getPositionDefaults: PositionDefaultsGetter;
  /** The saved push clear rules (a plan overlay's business; passed through so
   *  the column plan is built exactly as the Reports page builds it). */
  clearPrefixes: readonly string[];
}

export async function readFteReconciliation(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  deps: FteReconciliationDeps
): Promise<FteReconciliationResponse> {
  const year = scenarioYear(dbs.localDb, scope, scenarioId);

  // The grid side.
  const input = await loadScenarioInput(dbs.localDb, dbs.secureDb, scope, scenarioId, deps.getCalendar, deps.getPositionDefaults);
  const positions: FtePositionInput[] = input.positions.map((position) => ({
    departmentCode: position.departmentCode,
    jobTypeCode: position.jobTypeCode,
    headcount: position.headcount,
    fte: position.fte,
    hotelClusterWeight: position.hotelClusterWeight,
  }));
  const grid = aggregateGridFte(positions);

  // The account side: every department either side knows.
  const results = getResultsSource(dbs.secureDb, scope, scenarioId);
  const depts = [...new Set([...grid.keys(), ...results.source.deptCodes].map(bareDept))].sort();
  const compiled = compileDefinition(buildFteReconciliationDefinition(depts));
  const column: SeriesColumnSpec = { id: "kairos", series: { kind: "kairos", scenarioId } };
  const plan = await planColumns(dbs, scope, compiled, [column], {
    clearPrefixes: deps.clearPrefixes,
    deps: { getCalendar: deps.getCalendar, getPositionDefaults: deps.getPositionDefaults },
  });
  const report = evaluateReport(compiled, plan.contextFor(column));
  const accounts = readAccountSides(depts, report);

  const labels = packLabelsOf(getMapIndex(dbs.localDb));
  const unmapped = new Set<string>();
  const built = buildFteReconciliation(
    grid,
    accounts,
    (dept) => labels.deptName(dept),
    (dept) => {
      if (labels.deptLabel(dept, PACK_GROUP_LEVEL) === null) unmapped.add(dept);
      return groupOf(labels, dept);
    }
  );

  return {
    scenarioId,
    year,
    run: readRunInfo(dbs, scope, scenarioId),
    weeklyHours: plan.infos.get(column.id)?.weeklyHours ?? null,
    fteHoursYear: readFteHoursYear(report),
    ...built,
    unmappedDepartments: [...unmapped].sort(),
    warnings: report.warnings,
  };
}
