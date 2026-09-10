/**
 * The staffing statistics read: every engine output line of a scenario that
 * posts heads or hours, with the position that produced it, handed to the
 * shared build (shared/reports/staffingStatistics.ts).
 *
 * The FTE divisor — one full-timer's hours per slot — is the staffing
 * catalog's measure evaluated under the very column plan the Reports page
 * uses for a Kairos column, so the effective week, its fallback chain and its
 * warnings are the ones every report shows (as the FTE reconciliation does).
 *
 * Only the PII title is read, as the payroll bridge does; a name never
 * crosses this boundary.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { OutputSource } from "../../shared/positions/ipc";
import { FTE_HOURS_MEASURE, FTE_WEEKS_PARAM, WEEKLY_HOURS_PARAM } from "../../shared/reports/catalog/staffing";
import { compileDefinition } from "../../shared/reports/compile";
import type { SeriesColumnSpec } from "../../shared/reports/columns";
import { evaluateReport } from "../../shared/reports/engine";
import { packLabelsOf } from "../../shared/reports/packs";
import {
  STAFFING_GROUP_LEVEL,
  StaffingStatisticsResponse,
  StaffingStatsLine,
  buildStaffingStatistics,
  staffingAccountClassifier,
} from "../../shared/reports/staffingStatistics";
import type { ReportWarning } from "../../shared/reports/types";
import type { WeeklyHoursInfo } from "../../shared/reports/weeklyHours";
import { planColumns } from "../reports/evaluate";
import { getMapIndex } from "../reports/mapsIndex";
import type { CalendarGetter, PositionDefaultsGetter } from "./loadScenarioInput";
import type { OuScope } from "./ouScope";
import { readRunInfo, scenarioYear } from "./positionBridge";
import { normalizeEncoding, normalizeSource } from "./resultsCache";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

export interface StaffingStatisticsDeps {
  getCalendar: CalendarGetter;
  getPositionDefaults: PositionDefaultsGetter;
  /** The saved push clear rules, so the column plan is built as the Reports page builds it. */
  clearPrefixes: readonly string[];
}

/** One full-timer's hours per slot, and nothing else. */
const FTE_DIVISOR = compileDefinition({
  id: "staffing_statistics_divisor",
  name: "Staffing statistics — hours per FTE",
  version: 1,
  atoms: [],
  measures: [FTE_HOURS_MEASURE],
  rows: [{ type: "measure", measureId: FTE_HOURS_MEASURE.id }],
  params: [WEEKLY_HOURS_PARAM, FTE_WEEKS_PARAM],
});

const SOURCE_LABELS: Record<OutputSource, string> = {
  ENGINE: "Engine",
  MANUAL: "Manual input",
  ALLOCATION: "Allocation",
  BUYOUT: "Buyout",
  SETUP: "Setup",
};

interface LineRecord {
  position_id: string;
  source: string;
  label: string;
  dept: string;
  account: string;
  monthly_values: string;
  encoding: string;
  job_type_code: string | null;
  deleted_at: string | null;
  title: string | null;
}

function parseMonths(raw: string): number[] {
  let months: unknown = [];
  try {
    months = JSON.parse(raw);
  } catch {
    months = [];
  }
  const list = Array.isArray(months) ? months : [];
  return Array.from({ length: 12 }, (_, m) => Number(list[m]) || 0);
}

/** A scenario's engine lines on the accounts `wanted` keeps, each with the position that produced it. */
export function readStaffingLines(
  secureDb: Db,
  scope: OuScope,
  scenarioId: string,
  wanted: (account: string) => boolean
): StaffingStatsLine[] {
  const records = prepared(
    secureDb,
    `SELECT l.position_id, l.source, l.label, l.dept, l.account, l.monthly_values, l.encoding,
            p.job_type_code, p.deleted_at, pii.title
       FROM engine_output_lines l
       LEFT JOIN positions    p   ON p.id = l.position_id
       LEFT JOIN position_pii pii ON pii.position_id = l.position_id
      WHERE l.ou = ? AND l.scenario_id = ?
      ORDER BY l.rowid`
  ).all(scope.ou, scenarioId) as LineRecord[];

  const out: StaffingStatsLine[] = [];
  for (const record of records) {
    // Classify before parsing: most lines are money and are skipped here.
    if (!wanted(record.account)) continue;
    const source = normalizeSource(record.source);
    const isPosition = source === "ENGINE" && record.job_type_code !== null;
    out.push({
      dept: record.dept,
      account: record.account,
      months: parseMonths(record.monthly_values),
      encoding: normalizeEncoding(record.encoding),
      position: isPosition
        ? {
            id: record.position_id,
            title: (record.title ?? "").trim() || (record.job_type_code ?? "").trim() || "Position",
            jobTypeCode: record.job_type_code,
            deleted: record.deleted_at !== null,
          }
        : null,
      sourceLabel: record.label ? `${SOURCE_LABELS[source]} · ${record.label}` : SOURCE_LABELS[source],
    });
  }
  return out;
}

export interface FteDivisor {
  /** Hours of one FTE per slot: Jan..Dec, then the year. */
  fteHours: number[];
  /** The effective week behind it, and where it was read. */
  weeklyHours: WeeklyHoursInfo | null;
  warnings: ReportWarning[];
}

/** One full-timer's hours per slot for a scenario, as the Reports page's Kairos column reads them. */
export async function readFteDivisor(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  deps: StaffingStatisticsDeps
): Promise<FteDivisor> {
  const column: SeriesColumnSpec = { id: "kairos", series: { kind: "kairos", scenarioId } };
  const plan = await planColumns(dbs, scope, FTE_DIVISOR, [column], {
    clearPrefixes: deps.clearPrefixes,
    deps: { getCalendar: deps.getCalendar, getPositionDefaults: deps.getPositionDefaults },
  });
  const divisor = evaluateReport(FTE_DIVISOR, plan.contextFor(column));
  const values = divisor.rows.find((row) => row.type === "measure" && row.measureId === FTE_HOURS_MEASURE.id)?.values ?? [];
  return {
    fteHours: Array.from({ length: 13 }, (_, slot) => Number(values[slot]) || 0),
    weeklyHours: plan.infos.get(column.id)?.weeklyHours ?? null,
    warnings: divisor.warnings,
  };
}

export async function readStaffingStatistics(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  deps: StaffingStatisticsDeps
): Promise<StaffingStatisticsResponse> {
  const year = scenarioYear(dbs.localDb, scope, scenarioId);
  const divisor = await readFteDivisor(dbs, scope, scenarioId, deps);

  const labels = packLabelsOf(getMapIndex(dbs.localDb));
  const classify = staffingAccountClassifier(labels);
  const lines = readStaffingLines(dbs.secureDb, scope, scenarioId, (account) => classify(account) !== null);
  const built = buildStaffingStatistics(lines, divisor.fteHours, labels);

  const run = readRunInfo(dbs, scope, scenarioId);
  const warnings: ReportWarning[] = [];
  const seen = new Set<string>();
  const warn = (warning: ReportWarning) => {
    const key = `${warning.code}|${warning.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      warnings.push(warning);
    }
  };
  divisor.warnings.forEach(warn);
  if (!run && !warnings.some((w) => w.code === "NO_RESULTS")) {
    warn({ code: "NO_RESULTS", message: "This scenario has not been calculated yet — open Results and Recalculate." });
  }

  return {
    scenarioId,
    year,
    run,
    weeklyHours: divisor.weeklyHours,
    fteHours: divisor.fteHours,
    groupLevel: STAFFING_GROUP_LEVEL,
    ...built,
    warnings,
  };
}
