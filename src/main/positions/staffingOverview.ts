/**
 * The staffing overview read: a scenario's active positions, each with the
 * FTE the engine would use, rolled up by department group (the mapping
 * table's level, as the budget pack groups) and job title, split by
 * classification — with, when asked, a second scenario beside it.
 *
 * Unlike the bridge this reads the positions themselves, not the run's
 * lines: the FTE column on `positions` is vestigial and the FTE statistic
 * is never posted to an account, so the only faithful figure is the one
 * loadScenarioInput derives — the same call the engine run makes, so the
 * FTE here equals the FTE on the Positions grid. That also means "stale"
 * is read the other way round from the bridge: the positions are current
 * by construction; the run info says whether the RESULTS lag behind them.
 *
 * Only the job title is read from the PII store (the Standard Title is a
 * position extra, not PII); a name never crosses this boundary.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { bareDept } from "../../shared/positions/comboKey";
import {
  StaffingAggregate,
  StaffingOverviewResponse,
  StaffingPositionInput,
  TitleMode,
  aggregateStaffing,
  buildStaffingGroups,
  staffingTitle,
} from "../../shared/reports/staffingOverview";
import { PACK_GROUP_LEVEL, groupOf, packLabelsOf } from "../../shared/reports/packs";
import { getMapIndex } from "../reports/mapsIndex";
import { CalendarGetter, PositionDefaultsGetter, loadScenarioInput } from "./loadScenarioInput";
import type { OuScope } from "./ouScope";
import { readRunInfo, scenarioYear } from "./positionBridge";
import { getPii, loadScenarioValues } from "./positionsRepo";

type Db = InstanceType<typeof Database>;

export interface StaffingOverviewDeps {
  getCalendar: CalendarGetter;
  getPositionDefaults: PositionDefaultsGetter;
}

export interface StaffingOverviewOptions {
  compareScenarioId?: string;
  titleMode?: TitleMode;
}

interface ScenarioStaffing {
  aggregate: StaffingAggregate;
  unmapped: Set<string>;
}

async function readScenario(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  titleMode: TitleMode,
  deps: StaffingOverviewDeps,
  labels: ReturnType<typeof packLabelsOf>
): Promise<ScenarioStaffing> {
  const input = await loadScenarioInput(dbs.localDb, dbs.secureDb, scope, scenarioId, deps.getCalendar, deps.getPositionDefaults);
  const pii = getPii(dbs.secureDb, scope, scenarioId);
  // The Standard Title is a position extra (positions.extra_values), beside
  // the contract columns; the typed title is the PII row's.
  const extras = new Map(loadScenarioValues(dbs.secureDb, scope, scenarioId).positions.map((p) => [p.id, p.extraValues]));
  const positions: StaffingPositionInput[] = input.positions.map((position) => ({
    id: position.id,
    departmentCode: position.departmentCode,
    jobTypeCode: position.jobTypeCode,
    headcount: position.headcount,
    fte: position.fte,
    hotelClusterWeight: position.hotelClusterWeight,
  }));
  const unmapped = new Set<string>();
  const aggregate = aggregateStaffing(
    positions,
    (position) => {
      return staffingTitle(
        { title: pii[position.id]?.title ?? null, extraValues: extras.get(position.id) ?? null },
        position.jobTypeCode,
        titleMode
      );
    },
    (departmentCode) => {
      const code = bareDept(departmentCode);
      if (labels.deptLabel(code, PACK_GROUP_LEVEL) === null) unmapped.add(code);
      return groupOf(labels, code);
    }
  );
  return { aggregate, unmapped };
}

export async function readStaffingOverview(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  options: StaffingOverviewOptions,
  deps: StaffingOverviewDeps
): Promise<StaffingOverviewResponse> {
  const titleMode: TitleMode = options.titleMode === "standard" ? "standard" : "title";
  const year = scenarioYear(dbs.localDb, scope, scenarioId);
  const labels = packLabelsOf(getMapIndex(dbs.localDb));
  const budget = await readScenario(dbs, scope, scenarioId, titleMode, deps, labels);

  let compare: StaffingOverviewResponse["compare"] = null;
  let compared: ScenarioStaffing | null = null;
  if (options.compareScenarioId && options.compareScenarioId !== scenarioId) {
    const compareYear = scenarioYear(dbs.localDb, scope, options.compareScenarioId);
    compared = await readScenario(dbs, scope, options.compareScenarioId, titleMode, deps, labels);
    compare = {
      scenarioId: options.compareScenarioId,
      year: compareYear,
      run: readRunInfo(dbs, scope, options.compareScenarioId),
    };
  }

  const built = buildStaffingGroups(budget.aggregate, compared?.aggregate ?? null);
  return {
    scenarioId,
    year,
    run: readRunInfo(dbs, scope, scenarioId),
    titleMode,
    ...built,
    compare,
    unmappedDepartments: [...new Set([...budget.unmapped, ...(compared?.unmapped ?? [])])].sort(),
  };
}
