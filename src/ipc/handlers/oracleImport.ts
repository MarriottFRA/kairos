/**
 * Oracle report import IPC handlers — the port of `Add_New_Rows_Oracle`.
 *
 * Two channels, both OU-gated. `preview` picks a file, parses and analyses it,
 * and writes NOTHING; `commit` re-reads the same path and applies it. Splitting
 * them is what lets the confirm dialog show the first parsed rows — the check
 * that Oracle's column layout has not shifted, since the macro read most of its
 * columns positionally — along with every row that will be skipped and which
 * block each percentage lands on.
 *
 * Unlike the legacy importer, this one APPENDS into a plan someone is already
 * working in, so there is no "scenario must be empty" guard. The guard is the
 * employee number: anyone already in the plan is skipped, which makes the whole
 * import re-runnable against a refreshed extract. Nothing existing is changed.
 */

import { dialog } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import { IpcHandler, IpcResult } from "../types";
import {
  localDbHandle,
  getCalendarYear,
  getPositionDefaults,
} from "../../local_db";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import { getFieldCatalog } from "../../main/positions/structureRepo";
import { buildFieldMap } from "../../shared/positions/rowModel";
import { listDepartments } from "../../main/mappingTables/repo";
import { listBlocks } from "../../main/blocks/repo";
import * as positionsRepo from "../../main/positions/positionsRepo";
import { recomputeAllForOu } from "../../main/kpiDrivers/repo";
import {
  dailyHoursFromWeekly,
  resolvePositionDefaults,
} from "../../shared/positionDefaults";
import {
  NotOracleReportError,
  parseOracleReport,
} from "../../main/oracleImport/parseOracleReport";
import {
  analyzeOracleReport,
  buildAccountTemplates,
  normalizeEmpNumber,
  OracleImportPlan,
  OracleStandards,
} from "../../main/oracleImport/analyze";
import { commitOraclePlan } from "../../main/oracleImport/commit";
import {
  ORACLE_IMPORT_CHANNELS,
  OracleImportCommitResult,
  OracleImportPreviewResult,
  normalizeOracleImportOptions,
} from "../../shared/oracleImport/ipc";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

/**
 * Read a workbook's bytes even if Excel holds the file open. A plain read
 * usually succeeds (Excel opens shared-read), but on a Windows lock (EBUSY /
 * EPERM) we fall back to a temp-copy read. Same shape as the legacy-import
 * reader — someone importing is very likely to have the export open beside them.
 */
function readWorkbookBytes(filePath: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
    const tmp = path.join(
      os.tmpdir(),
      `kairos-oracle-${randomUUID()}${path.extname(filePath)}`
    );
    try {
      fs.copyFileSync(filePath, tmp);
      return fs.readFileSync(tmp);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

function requireScenarioId(request: unknown): string {
  const scenarioId = String((request as { scenarioId?: unknown })?.scenarioId ?? "");
  if (!scenarioId) throw new Error("A scenarioId is required");
  return scenarioId;
}

/** The scenario's budget year — the defaults and calendar are per year. */
function scenarioYear(ou: string, scenarioId: string): number {
  const row = localDbHandle()
    .prepare(
      `SELECT year FROM scenarios
        WHERE id = ? AND ou = ? AND deleted_at IS NULL`
    )
    .get(scenarioId, ou) as { year: number } | undefined;
  if (!row) throw new Error("That plan no longer exists.");
  return row.year;
}

/**
 * The macro's `Menu!O11 / O12 / O13`, read off the hotel-year defaults.
 *
 * Both the defaults AND a calendar are needed: a *linked* default resolves off
 * the calendar totals, and an unlinked one is a user pin that wins. Without them
 * the public-holiday proration has no yardstick, and a wrong denominator
 * silently mis-scales every imported row — so this refuses rather than guesses.
 */
async function loadStandards(
  ou: string,
  year: number
): Promise<OracleStandards | null> {
  const [defaults, calendar] = await Promise.all([
    getPositionDefaults(ou, year),
    getCalendarYear(ou, year),
  ]);
  if (!defaults || !calendar) return null;
  const resolved = resolvePositionDefaults(defaults, calendar);
  return {
    yearlyDays: resolved.fields.yearlyDays.value,
    pubHolidays: resolved.fields.pubHolidays.value,
    daysOff: resolved.fields.daysOff.value,
    dailyHours: dailyHoursFromWeekly(resolved.weeklyHours),
  };
}

/** Parse + analyse one path. Shared by preview and commit so the two can never
 *  disagree about what the file says. */
function buildPlan(
  filePath: string,
  request: unknown,
  scenarioId: string,
  standards: OracleStandards
): OracleImportPlan {
  const scope = resolveOuScope(request);
  const sourceFileName = path.basename(filePath);
  const report = parseOracleReport(readWorkbookBytes(filePath), sourceFileName);
  const options = normalizeOracleImportOptions(
    (request as { options?: unknown })?.options
  );

  const departmentNameByCode = new Map(
    listDepartments(localDbHandle()).map((dept) => [dept.code, dept.name])
  );

  // Identity guard: who is already in this plan.
  const pii = positionsRepo.getPii(secureDb(), scope, scenarioId);
  const existingEmpNumbers = new Map<string, string>();
  for (const record of Object.values(pii)) {
    const key = normalizeEmpNumber(record.empNumber ?? "");
    if (!key || existingEmpNumbers.has(key)) continue;
    const name = [record.lastName, record.firstName].filter(Boolean).join(", ");
    existingEmpNumbers.set(key, name || key);
  }

  // What each department already does with its posting accounts.
  const existing = positionsRepo.loadScenarioValues(secureDb(), scope, scenarioId);
  const accountTemplateByDepartment = options.inheritAccounts
    ? buildAccountTemplates(
        existing.positions.map((position) => ({
          departmentCode: position.departmentCode,
          extraValues: position.extraValues,
          updatedAt: position.updatedAt,
        }))
      )
    : new Map();

  return analyzeOracleReport(report, {
    filePath,
    options,
    departmentNameByCode,
    standards,
    existingEmpNumbers,
    existingPositionCount: existing.positions.length,
    accountTemplateByDepartment,
    existingBlocks: listBlocks(localDbHandle(), scope),
  });
}

export function createOracleImportHandlers(): Record<string, IpcHandler> {
  /** Pick a file and describe what importing it would do. Writes nothing. */
  const preview: IpcHandler<any, IpcResult<OracleImportPreviewResult>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      const year = scenarioYear(scope.ou, scenarioId);

      const standards = await loadStandards(scope.ou, year);
      if (!standards) {
        return ok({ outcome: "no_hotel_standards", year });
      }

      const picked = await dialog.showOpenDialog({
        title: "Select your Oracle report",
        properties: ["openFile"],
        filters: [{ name: "Oracle report", extensions: ["xlsx", "xlsm", "xls"] }],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return ok({ outcome: "cancelled" });
      }

      const filePath = picked.filePaths[0];
      try {
        const plan = buildPlan(filePath, request, scenarioId, standards);
        return ok({ outcome: "ready", preview: plan.preview });
      } catch (error) {
        if (error instanceof NotOracleReportError) {
          return ok({
            outcome: "not_oracle_file",
            sourceFileName: path.basename(filePath),
            reason: error.message,
          });
        }
        throw error;
      }
    } catch (error) {
      console.error("Oracle import preview failed:", error);
      return fail(error, { outcome: "cancelled" } as OracleImportPreviewResult);
    }
  };

  /** Re-read the previewed path and apply it. */
  const commit: IpcHandler<any, IpcResult<OracleImportCommitResult>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      const filePath = String((request as { filePath?: unknown })?.filePath ?? "");
      if (!filePath) throw new Error("No file was selected.");

      const year = scenarioYear(scope.ou, scenarioId);
      const standards = await loadStandards(scope.ou, year);
      if (!standards) {
        return ok({ outcome: "no_hotel_standards", year });
      }

      // Rebuilt from the path, not carried over from the preview: the two calls
      // are a user interaction apart, and this pass re-reads who is already in
      // the plan. Anyone added in between is skipped, and the report says so.
      const plan = buildPlan(filePath, request, scenarioId, standards);
      const catalog = getFieldCatalog(localDbHandle(), scope);

      const report = commitOraclePlan(plan, {
        localDb: localDbHandle(),
        secureDb: secureDb(),
        scope,
        scenarioId,
        now: new Date().toISOString(),
        newId: () => randomUUID(),
        fieldLookup: buildFieldMap(catalog),
      });

      // Positions (and possibly blocks) moved; refresh the KPI caches the same
      // way a budget pull does, so anything driven off them is not left stale.
      recomputeAllForOu(localDbHandle(), scope.ou, {
        computedAt: new Date().toISOString(),
      });

      return ok({ outcome: "ok", report });
    } catch (error) {
      console.error("Oracle import commit failed:", error);
      return fail(error, { outcome: "cancelled" } as OracleImportCommitResult);
    }
  };

  return {
    [ORACLE_IMPORT_CHANNELS.preview]: preview,
    [ORACLE_IMPORT_CHANNELS.commit]: commit,
  };
}
