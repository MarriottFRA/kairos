/**
 * The staffing overview read: a scenario's heads and FTE rolled up by
 * department group (the mapping table's level, as the budget pack groups)
 * and job title, split by classification — with, when asked, a second
 * scenario beside it, read on the same basis.
 *
 * Two bases (shared/reports/staffingOverview.ts says what each counts):
 *
 *   accounts   the default. The scenario's engine output lines — the same
 *              read Staffing statistics makes — with the full-timer's hours
 *              evaluated under the Reports page's own column plan, so the
 *              FTE here is the FTE every report shows. A scenario not
 *              calculated reads empty, with a nudge.
 *   positions  the positions themselves, through loadScenarioInput — the
 *              call the engine run makes, so the FTE equals the Positions
 *              grid's. The positions are current by construction; the run
 *              info only says whether the RESULTS lag behind them.
 *
 * Only the job title is read from the PII store (the Standard Title is a
 * position extra, not PII); a name never crosses this boundary.
 */

import type { ClearRuleSet } from "../../shared/bstPush/ipc";
import type Database from "better-sqlite3-multiple-ciphers";
import { bareDept } from "../../shared/positions/comboKey";
import {
  StaffingAggregate,
  StaffingBasis,
  StaffingOverviewResponse,
  StaffingPositionInput,
  TitleMode,
  aggregateStaffing,
  aggregateStaffingLines,
  buildStaffingGroups,
  staffingTitle,
} from "../../shared/reports/staffingOverview";
import { staffingAccountClassifier } from "../../shared/reports/staffingStatistics";
import type { ReportWarning } from "../../shared/reports/types";
import type { WeeklyHoursInfo } from "../../shared/reports/weeklyHours";
import { PACK_GROUP_LEVEL, groupOf, packLabelsOf } from "../../shared/reports/packs";
import { getMapIndex } from "../reports/mapsIndex";
import { CalendarGetter, PositionDefaultsGetter, loadScenarioInput } from "./loadScenarioInput";
import type { OuScope } from "./ouScope";
import { readRunInfo, scenarioYear } from "./positionBridge";
import { getPii, loadScenarioValues } from "./positionsRepo";
import { readFteDivisor, readStaffingLines } from "./staffingStatistics";

type Db = InstanceType<typeof Database>;

export interface StaffingOverviewDeps {
  getCalendar: CalendarGetter;
  getPositionDefaults: PositionDefaultsGetter;
  /** The saved push clear rules and exceptions, so the accounts basis plans its column as the Reports page does. */
  clearRules: ClearRuleSet;
}

export interface StaffingOverviewOptions {
  compareScenarioId?: string;
  titleMode?: TitleMode;
  basis?: StaffingBasis;
}

interface ScenarioStaffing {
  aggregate: StaffingAggregate;
  unmapped: Set<string>;
  weeklyHours: WeeklyHoursInfo | null;
  warnings: ReportWarning[];
}

type Labels = ReturnType<typeof packLabelsOf>;

/** The title a position rolls up under, from its PII title and its extras. */
function titleReader(dbs: { secureDb: Db }, scope: OuScope, scenarioId: string, titleMode: TitleMode) {
  const pii = getPii(dbs.secureDb, scope, scenarioId);
  // The Standard Title is a position extra (positions.extra_values), beside
  // the contract columns; the typed title is the PII row's.
  const extras = new Map(loadScenarioValues(dbs.secureDb, scope, scenarioId).positions.map((p) => [p.id, p.extraValues]));
  return (positionId: string, jobTypeCode: string | null) =>
    staffingTitle({ title: pii[positionId]?.title ?? null, extraValues: extras.get(positionId) ?? null }, jobTypeCode, titleMode);
}

function groupReader(labels: Labels, unmapped: Set<string>) {
  return (departmentCode: string) => {
    const code = bareDept(departmentCode);
    if (labels.deptLabel(code, PACK_GROUP_LEVEL) === null) unmapped.add(code);
    return groupOf(labels, code);
  };
}

async function readFromPositions(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  titleMode: TitleMode,
  deps: StaffingOverviewDeps,
  labels: Labels
): Promise<ScenarioStaffing> {
  const input = await loadScenarioInput(dbs.localDb, dbs.secureDb, scope, scenarioId, deps.getCalendar, deps.getPositionDefaults);
  const titleOf = titleReader(dbs, scope, scenarioId, titleMode);
  const positions: StaffingPositionInput[] = input.positions.map((position) => ({
    id: position.id,
    departmentCode: position.departmentCode,
    jobTypeCode: position.jobTypeCode,
    headcount: position.headcount,
    fte: position.fte,
    hotelClusterWeight: position.hotelClusterWeight,
  }));
  const unmapped = new Set<string>();
  const aggregate = aggregateStaffing(positions, (position) => titleOf(position.id, position.jobTypeCode), groupReader(labels, unmapped));
  return { aggregate, unmapped, weeklyHours: null, warnings: [] };
}

async function readFromAccounts(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  titleMode: TitleMode,
  deps: StaffingOverviewDeps,
  labels: Labels,
  compared: boolean
): Promise<ScenarioStaffing> {
  const divisor = await readFteDivisor(dbs, scope, scenarioId, deps);
  const classify = staffingAccountClassifier(labels);
  const lines = readStaffingLines(dbs.secureDb, scope, scenarioId, (account) => classify(account) !== null);
  const titleOf = titleReader(dbs, scope, scenarioId, titleMode);
  const unmapped = new Set<string>();
  const aggregate = aggregateStaffingLines(
    lines,
    divisor.fteHours[12],
    classify,
    // A line no position produced rolls up under what it is ("Manual input · Extra hours").
    (line) => (line.position ? titleOf(line.position.id, line.position.jobTypeCode) : line.sourceLabel),
    groupReader(labels, unmapped)
  );
  // The divisor's own "not calculated" says "this scenario" whichever it is;
  // the one below names the scenario. Anything else it says about the
  // compared scenario must not read as the budget's.
  const warnings = divisor.warnings
    .filter((warning) => warning.code !== "NO_RESULTS")
    .map((warning) => (compared ? { ...warning, message: `Compared scenario: ${warning.message}` } : warning));
  if (!readRunInfo(dbs, scope, scenarioId)) {
    warnings.push({
      code: "NO_RESULTS",
      message: compared
        ? "The compared scenario has not been calculated yet — open it in Results and Recalculate, or switch to Positions."
        : "This scenario has not been calculated yet — open Results and Recalculate, or switch to Positions.",
    });
  }
  return { aggregate, unmapped, weeklyHours: divisor.weeklyHours, warnings };
}

export async function readStaffingOverview(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  options: StaffingOverviewOptions,
  deps: StaffingOverviewDeps
): Promise<StaffingOverviewResponse> {
  const titleMode: TitleMode = options.titleMode === "standard" ? "standard" : "title";
  const basis: StaffingBasis = options.basis === "positions" ? "positions" : "accounts";
  const year = scenarioYear(dbs.localDb, scope, scenarioId);
  const labels = packLabelsOf(getMapIndex(dbs.localDb));
  const read = (id: string, compared: boolean) =>
    basis === "accounts"
      ? readFromAccounts(dbs, scope, id, titleMode, deps, labels, compared)
      : readFromPositions(dbs, scope, id, titleMode, deps, labels);
  const budget = await read(scenarioId, false);

  let compare: StaffingOverviewResponse["compare"] = null;
  let compared: ScenarioStaffing | null = null;
  if (options.compareScenarioId && options.compareScenarioId !== scenarioId) {
    const compareYear = scenarioYear(dbs.localDb, scope, options.compareScenarioId);
    compared = await read(options.compareScenarioId, true);
    compare = {
      scenarioId: options.compareScenarioId,
      year: compareYear,
      run: readRunInfo(dbs, scope, options.compareScenarioId),
    };
  }

  const warnings: ReportWarning[] = [];
  for (const warning of [...budget.warnings, ...(compared?.warnings ?? [])]) {
    if (!warnings.some((w) => w.code === warning.code && w.message === warning.message)) warnings.push(warning);
  }

  const built = buildStaffingGroups(budget.aggregate, compared?.aggregate ?? null);
  return {
    scenarioId,
    year,
    run: readRunInfo(dbs, scope, scenarioId),
    basis,
    titleMode,
    weeklyHours: budget.weeklyHours,
    warnings,
    ...built,
    compare,
    unmappedDepartments: [...new Set([...budget.unmapped, ...(compared?.unmapped ?? [])])].sort(),
  };
}
