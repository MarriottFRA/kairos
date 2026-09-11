/**
 * Build one budget submission for a plan.
 *
 * Inputs come from the same loaders the engine run uses (loadScenarioInput
 * for the resolved FTE and worked hours, loadScenarioValues for what was
 * typed), the calculated staffing columns from the run's own output lines
 * read exactly as the Staffing statistics report reads them, and the
 * effective week from the same derivation the Home page shows. The plan is
 * recalculated first when its results are missing or out of date, so the
 * calculated columns can never disagree with the inputs beside them.
 *
 * PII: only getTitles is read off the sidecar — see positionsRepo.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import type { ClearRuleSet } from "../../shared/bstPush/ipc";
import type { KpiDriverId } from "../../shared/kpiDrivers/ipc";
import {
  isKpiStatsDriven,
  isRateDriven,
  manualMonthlyAmounts,
  resolveManualRowStats,
} from "../../shared/manualInput/rowMath";
import type { ManualKpiSeriesSlice } from "../../shared/manualInput/rowMath";
import { bareDept } from "../../shared/positions/comboKey";
import { deriveEffectiveWeek } from "../../shared/positions/effectiveWeek";
import {
  FTE_CONTRACT_KEYS,
  basisScaleFor,
  readContractDays,
  readInputBasis,
} from "../../shared/positions/engineInput";
import { BASIC_SALARY_ANNUAL_KEY, SALARY_ENTRY_MODE_KEY } from "../../shared/positions/fields";
import type { ReportRunInfo } from "../../shared/reports/ipc";
import { packLabelsOf } from "../../shared/reports/packs/labels";
import {
  StaffingStatsAccount,
  StaffingStatsNode,
  buildStaffingStatistics,
  hoursOfKind,
  staffingAccountClassifier,
} from "../../shared/reports/staffingStatistics";
import type { ReportWarning } from "../../shared/reports/types";
import { readWeeklyHours } from "../../shared/reports/weeklyHours";
import {
  SUBMISSION_BUYOUT_ROW_COLUMNS,
  SUBMISSION_HEADER_COLUMNS,
  SUBMISSION_MANUAL_ROW_COLUMNS,
  SUBMISSION_MONTHS,
  SUBMISSION_POSITION_COLUMNS,
  SUBMISSION_SCHEMA_VERSION,
  SubmissionCell,
  SubmissionPayload,
  SubmissionTable,
} from "../../shared/submission/schema";
import type { SubmissionBuildRequest, SubmissionCounts } from "../../shared/submission/ipc";
import { getSeries } from "../kpiDrivers/repo";
import { listRows as listManualRows } from "../manualInput/repo";
import { resolveHotelYearSetup } from "../positions/hotelYearSetup";
import { CalendarGetter, PositionDefaultsGetter, loadScenarioInput } from "../positions/loadScenarioInput";
import type { OuScope } from "../positions/ouScope";
import { readRunInfo } from "../positions/positionBridge";
import { getTitles, loadScenarioValues } from "../positions/positionsRepo";
import { runRecalc } from "../positions/runRecalc";
import { readFteDivisor, readStaffingLines } from "../positions/staffingStatistics";
import { listScenarios } from "../positions/structureRepo";
import { getMapIndex } from "../reports/mapsIndex";
import { getResultsSource } from "../reports/resultsSource";

type Db = InstanceType<typeof Database>;
type Dbs = { localDb: Db; secureDb: Db };

export interface SubmissionBuildDeps {
  getCalendar: CalendarGetter;
  getPositionDefaults: PositionDefaultsGetter;
  /** The saved push clear rules, so the FTE divisor is read as every report reads it. */
  clearRules: ClearRuleSet;
  appVersion: string;
  /** Injectable for tests. */
  now?: () => string;
  newId?: () => string;
}

export interface SubmissionBuildResult {
  payload: SubmissionPayload;
  counts: SubmissionCounts;
  run: ReportRunInfo | null;
  warnings: ReportWarning[];
}

const YEAR_SLOT = SUBMISSION_MONTHS;

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** A typed extra value: a finite number, else null (blank cells stay blank). */
const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const textOrNull = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
};

/** Twelve months then the year, as cells. */
function monthlyCells(months: readonly number[], year: number): SubmissionCell[] {
  const out: SubmissionCell[] = [];
  for (let m = 0; m < SUBMISSION_MONTHS; m++) out.push(num(months[m]));
  out.push(year);
  return out;
}

const sum = (months: readonly number[]): number => months.reduce((acc, v) => acc + num(v), 0);

/** Twelve months only (a vector with no year total). */
function vectorCells(values: readonly number[]): SubmissionCell[] {
  return Array.from({ length: SUBMISSION_MONTHS }, (_, m) => num(values[m]));
}

/** A table is only as good as its row widths: refuse to build a ragged one. */
function table(columns: readonly string[], rows: SubmissionCell[][]): SubmissionTable {
  rows.forEach((row, i) => {
    if (row.length !== columns.length) {
      throw new Error(`Submission row ${i} has ${row.length} cells for ${columns.length} columns`);
    }
  });
  return { columns: [...columns], rows };
}

// ---------------------------------------------------------------------------
// Calculated staffing columns, per position
// ---------------------------------------------------------------------------

interface CalculatedStats {
  heads: number[];
  fte: number[];
  hoursTotal: number[];
  hoursFte: number[];
}

const zeros13 = () => new Array<number>(YEAR_SLOT + 1).fill(0);

const positionIdOf = (node: StaffingStatsNode): string | null => {
  // "p:<dept>:<positionId>" — codes carry no colon; ids are UUIDs.
  const parts = node.id.split(":");
  return parts.length >= 3 && parts[0] === "p" ? parts.slice(2).join(":") : null;
};

/** The Staffing statistics tree folded per position: a position whose lines
 *  post to two departments is one position here. `hoursFte` is the HOURS on
 *  the FTE-driving accounts (node.values.hoursFte is already the FTE those
 *  hours make, which `fte` carries). */
function collectCalculated(
  hotel: StaffingStatsNode,
  accounts: readonly StaffingStatsAccount[]
): Map<string, CalculatedStats> {
  const out = new Map<string, CalculatedStats>();
  const visit = (node: StaffingStatsNode) => {
    if (node.kind === "position") {
      const id = positionIdOf(node);
      if (id) {
        const acc = out.get(id) ?? { heads: zeros13(), fte: zeros13(), hoursTotal: zeros13(), hoursFte: zeros13() };
        const fteHours = hoursOfKind(node.values, accounts, "fte");
        for (let s = 0; s <= YEAR_SLOT; s++) {
          acc.heads[s] += num(node.values.heads[s]);
          acc.fte[s] += num(node.values.fte[s]);
          acc.hoursTotal[s] += num(node.values.hours[s]);
          acc.hoursFte[s] += num(fteHours[s]);
        }
        out.set(id, acc);
      }
    }
    node.children.forEach(visit);
  };
  visit(hotel);
  return out;
}

const NO_STATS: CalculatedStats = { heads: zeros13(), fte: zeros13(), hoursTotal: zeros13(), hoursFte: zeros13() };

const calcCells = (stats: CalculatedStats): SubmissionCell[] => [
  ...stats.heads,
  ...stats.fte,
  ...stats.hoursTotal,
  ...stats.hoursFte,
];

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export async function buildSubmission(
  dbs: Dbs,
  scope: OuScope,
  request: SubmissionBuildRequest,
  deps: SubmissionBuildDeps
): Promise<SubmissionBuildResult> {
  const { localDb, secureDb } = dbs;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());
  const warnings: ReportWarning[] = [];

  const scenario = listScenarios(localDb, scope).find((s) => s.id === request.scenarioId);
  if (!scenario) throw new Error("The plan does not exist for this hotel.");
  if (scenario.year !== request.year) {
    throw new Error(`The plan "${scenario.label}" is for ${scenario.year}, not ${request.year}.`);
  }

  // The calculated columns must be the inputs' own: recalculate when the run
  // is missing or an input moved since — the same test the Results page makes.
  let run = readRunInfo(dbs, scope, scenario.id);
  if (!run || run.stale) {
    await runRecalc(
      { localDb, secureDb, getCalendar: deps.getCalendar, getDefaults: deps.getPositionDefaults, now },
      scope,
      scenario.id
    );
    run = readRunInfo(dbs, scope, scenario.id);
  }

  const [input, setup, divisor] = await Promise.all([
    loadScenarioInput(localDb, secureDb, scope, scenario.id, deps.getCalendar, deps.getPositionDefaults),
    resolveHotelYearSetup(deps, scope.ou, scenario.year),
    readFteDivisor(dbs, scope, scenario.id, deps),
  ]);
  divisor.warnings.forEach((w) => warnings.push(w));

  const values = loadScenarioValues(secureDb, scope, scenario.id);
  const titles = getTitles(secureDb, scope, scenario.id);
  const maps = getMapIndex(localDb);
  const deptName = (code: string, typed?: unknown): string | null =>
    textOrNull(typed) ?? maps.name("dept", bareDept(code));

  // Calculated staffing, off the run's lines exactly as the report reads them.
  const labels = packLabelsOf(maps);
  const classify = staffingAccountClassifier(labels);
  const lines = readStaffingLines(secureDb, scope, scenario.id, (account) => classify(account) !== null);
  const staffing = buildStaffingStatistics(lines, divisor.fteHours, labels);
  const calculated = collectCalculated(staffing.hotel, staffing.accounts);

  // ---- positions -----------------------------------------------------------
  const resolvedById = new Map(input.positions.map((p) => [p.id as string, p]));
  const active = values.positions
    .filter((record) => record.active)
    .sort((a, b) => a.departmentCode.localeCompare(b.departmentCode) || a.id.localeCompare(b.id));

  const positionRows: SubmissionCell[][] = [];
  for (const record of active) {
    const resolved = resolvedById.get(record.id);
    if (!resolved) continue; // the loader dropped it: not budgeted
    const extra = record.extraValues ?? {};
    const contract = readContractDays(extra);
    const scale = basisScaleFor(extra, record.seasonality);
    const stats = calculated.get(record.id) ?? NO_STATS;
    const title = titles.get(record.id) ?? record.jobTypeCode ?? "Position";
    positionRows.push([
      record.id,
      record.lineageId || null,
      record.clusterLinkId || null,
      resolved.cluster || null,
      resolved.hotelClusterWeight,
      record.departmentCode,
      deptName(record.departmentCode, extra.deptName),
      title,
      textOrNull(extra.standardJobTitle),
      record.jobTypeCode,
      record.payType,
      record.headcount,
      resolved.fte,
      numOrNull(extra[FTE_CONTRACT_KEYS.yearlyDays]),
      numOrNull(extra[FTE_CONTRACT_KEYS.daysOff]),
      numOrNull(extra[FTE_CONTRACT_KEYS.pubHolidays]),
      record.dailyContractHours,
      resolved.yearlyHoursWorked,
      (contract.yearlyDays - contract.daysOff) * record.dailyContractHours * scale,
      record.vacationDays,
      resolved.accrualDaysPerMonth,
      sum(record.seasonality),
      ...vectorCells(record.seasonality),
      ...vectorCells(record.vacationMonthlyWeights),
      textOrNull(extra[SALARY_ENTRY_MODE_KEY]),
      readInputBasis(extra),
      numOrNull(extra[BASIC_SALARY_ANNUAL_KEY]),
      record.monthlyBaseSalary,
      record.hourlyRate,
      record.meritIncreasePct,
      record.manualYearlyIncrease,
      record.increaseMonth,
      textOrNull(extra.salaryAccountCode),
      textOrNull(extra.workingHoursAccount),
      textOrNull(extra.benefitsAccountCode),
      textOrNull(extra.accrualAccount),
      ...calcCells(stats),
    ]);
  }

  // ---- manual rows ---------------------------------------------------------
  const kpiCache = new Map<string, ManualKpiSeriesSlice[] | null>();
  const kpiLookup = (driverId: string): ManualKpiSeriesSlice[] | null => {
    let slices = kpiCache.get(driverId);
    if (slices === undefined) {
      const series = getSeries(localDb, scope.ou, driverId as KpiDriverId);
      slices = series.length > 0 ? series : null;
      kpiCache.set(driverId, slices);
    }
    return slices;
  };
  const manualRows = resolveManualRowStats(listManualRows(secureDb, scope.ou, scenario.id), kpiLookup).map(
    (row): SubmissionCell[] => {
      const amounts = manualMonthlyAmounts(row);
      return [
        row.id,
        row.description,
        row.departmentCode,
        deptName(row.departmentCode, row.department),
        textOrNull(row.costAccount),
        textOrNull(row.statsAccount),
        row.rate,
        isRateDriven(row.rate),
        row.statsKpiDriverId,
        row.statsKpiDivisor,
        row.statsKpiFactor,
        isKpiStatsDriven(row.statsKpiDriverId),
        row.spreadMode,
        row.spreadBaseStats,
        row.spreadBaseAmount,
        row.increasePct,
        row.increaseMonth,
        row.sortOrder,
        ...monthlyCells(row.stats, sum(row.stats)),
        ...monthlyCells(amounts, sum(amounts)),
      ];
    }
  );

  // ---- buyout rows ---------------------------------------------------------
  const buyoutRows = values.buyouts.map((row): SubmissionCell[] => [
    row.id,
    row.departmentCode,
    deptName(row.departmentCode),
    textOrNull(row.accountCode),
    ...monthlyCells(row.monthlyValues, sum(row.monthlyValues)),
  ]);

  // ---- header --------------------------------------------------------------
  const derivation = deriveEffectiveWeek(setup.contractWeek, setup.reference, input.positions);
  const posted = readWeeklyHours(getResultsSource(secureDb, scope, scenario.id).source);
  const workingDays = setup.calendar.months.map(
    (m) => num(m.calendarDays) - num(m.publicHolidays) - num(m.weekendDays)
  );
  const publicHolidays = setup.calendar.months.reduce((acc, m) => acc + num(m.publicHolidays), 0);
  const counts: SubmissionCounts = {
    positions: positionRows.length,
    manualRows: manualRows.length,
    buyoutRows: buyoutRows.length,
  };
  const header: SubmissionCell[] = [
    newId(),
    SUBMISSION_SCHEMA_VERSION,
    scope.ou,
    request.hotelName?.trim() || scope.ou,
    scenario.year,
    request.slot,
    scenario.id,
    scenario.label,
    deps.appVersion,
    now(),
    run?.computedAt ?? null,
    derivation.contractWeek,
    derivation.effectiveWeek,
    posted,
    derivation.productiveDays,
    derivation.dailyHours,
    derivation.averageVacationDays,
    derivation.fullTimeDays,
    derivation.fullTimeHoursYear,
    derivation.weightedFte,
    setup.calendar.weekendMask,
    ...monthlyCells(workingDays, sum(workingDays)),
    publicHolidays,
    counts.positions,
    counts.manualRows,
    counts.buyoutRows,
  ];

  if (counts.positions === 0) {
    warnings.push({
      code: "NO_POSITIONS",
      message: "This plan has no active positions — the submission would carry no staffing.",
    });
  }
  if (posted !== null && Math.abs(posted - derivation.effectiveWeek) > 1e-6) {
    warnings.push({
      code: "EFFECTIVE_WEEK_DRIFT",
      message: "The posted effective week differs from the derived one — recalculate on the Results page and try again.",
    });
  }

  return {
    payload: {
      schemaVersion: SUBMISSION_SCHEMA_VERSION,
      submission: table(SUBMISSION_HEADER_COLUMNS, [header]),
      positions: table(SUBMISSION_POSITION_COLUMNS, positionRows),
      manualRows: table(SUBMISSION_MANUAL_ROW_COLUMNS, manualRows),
      buyoutRows: table(SUBMISSION_BUYOUT_ROW_COLUMNS, buyoutRows),
    },
    counts,
    run,
    warnings,
  };
}
