/**
 * Legacy Excel import IPC handlers — the one-shot migration off the Excel
 * "Payroll Budget Tool".
 *
 * Two channels, both OU-gated. `preview` picks a file, parses and analyses it,
 * and writes NOTHING; `commit` re-reads the same path and applies it. Splitting
 * them is what lets the confirm dialog name the hotel the workbook thinks it is
 * and list every fidelity warning before anything lands — this import creates
 * ~160 positions and a dozen blocks, so a wrong file caught after the fact is
 * expensive to unpick.
 *
 * Commit is refused unless the target scenario has no positions. The importer
 * is for standing a NEW hotel up; merging it into a scenario someone has been
 * working in would be impossible to reason about, and there is no undo.
 */

import { dialog } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import { IpcHandler, IpcResult } from "../types";
import { localDbHandle, getCalendarYear, saveCalendarYear, getPositionDefaults, savePositionDefaults } from "../../local_db";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import { getFieldCatalog } from "../../main/positions/structureRepo";
import { buildFieldMap } from "../../shared/positions/rowModel";
import { listDepartments } from "../../main/mappingTables/repo";
import { recomputeAllForOu } from "../../main/kpiDrivers/repo";
import {
  NotLegacyWorkbookError,
  parseLegacyWorkbook,
} from "../../main/legacyImport/parseWorkbook";
import {
  coreAnchorMismatches,
  isUnreadableLayout,
} from "../../main/legacyImport/layout";
import { analyzeWorkbook, ImportPlan } from "../../main/legacyImport/analyze";
import { commitImportPlan } from "../../main/legacyImport/commit";
import {
  LEGACY_IMPORT_CHANNELS,
  LegacyImportCommitResult,
  LegacyImportPreviewResult,
  normalizeLegacyImportOptions,
} from "../../shared/legacyImport/ipc";

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
 * EPERM) we fall back to a temp-copy read. Same shape as the budget-import
 * reader — someone migrating is very likely to have the file open beside them.
 */
function readWorkbookBytes(filePath: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
    const tmp = path.join(
      os.tmpdir(),
      `kairos-legacy-${randomUUID()}${path.extname(filePath)}`
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

/** The scenario's budget year — the calendar and defaults are written per year. */
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

/** Positions already in the target scenario — the import refuses to merge. */
function existingPositionCount(ou: string, scenarioId: string): number {
  const row = secureDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM positions
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`
    )
    .get(ou, scenarioId) as { count: number };
  return row?.count ?? 0;
}

/** Parse + analyse one path. Shared by preview and commit so the two can never
 *  disagree about what the file says. */
function buildPlan(
  filePath: string,
  request: unknown
): ImportPlan {
  const sourceFileName = path.basename(filePath);
  const workbook = parseLegacyWorkbook(readWorkbookBytes(filePath), sourceFileName);

  // The sheet names were enough to say "this is a Payroll Budget Tool file";
  // this says "…and its columns are still where every version puts them". An
  // unrecognised BLOCK region only costs the blocks, but a core region that has
  // moved would mis-read salaries, so refuse the file rather than degrade.
  const mismatches = coreAnchorMismatches(workbook);
  if (isUnreadableLayout(workbook)) {
    throw new NotLegacyWorkbookError(
      `"${sourceFileName}" has a column layout this tool does not recognise ` +
        `(${mismatches.join("; ")}). Importing it would read the wrong columns, ` +
        `so nothing was changed.`
    );
  }

  const departmentNameByCode = new Map(
    listDepartments(localDbHandle()).map((dept) => [dept.code, dept.name])
  );
  return analyzeWorkbook(workbook, {
    filePath,
    options: normalizeLegacyImportOptions(
      (request as { options?: unknown })?.options
    ),
    departmentNameByCode,
  });
}

export function createLegacyImportHandlers(): Record<string, IpcHandler> {
  /** Pick a file and describe what importing it would do. Writes nothing. */
  const preview: IpcHandler<any, IpcResult<LegacyImportPreviewResult>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);

      const occupied = existingPositionCount(scope.ou, scenarioId);
      if (occupied > 0) {
        return ok({ outcome: "scenario_not_empty", positionCount: occupied });
      }

      const picked = await dialog.showOpenDialog({
        title: "Select the Excel Payroll Budget Tool file to import",
        properties: ["openFile"],
        filters: [
          { name: "Payroll Budget Tool", extensions: ["xlsm", "xlsx"] },
        ],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return ok({ outcome: "cancelled" });
      }

      const filePath = picked.filePaths[0];
      try {
        const plan = buildPlan(filePath, request);
        return ok({ outcome: "ready", preview: plan.preview });
      } catch (error) {
        if (error instanceof NotLegacyWorkbookError) {
          return ok({
            outcome: "not_legacy_file",
            sourceFileName: path.basename(filePath),
            reason: error.message,
          });
        }
        throw error;
      }
    } catch (error) {
      console.error("Legacy import preview failed:", error);
      return fail(error, { outcome: "cancelled" } as LegacyImportPreviewResult);
    }
  };

  /** Re-read the previewed path and apply it. */
  const commit: IpcHandler<any, IpcResult<LegacyImportCommitResult>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      const filePath = String((request as { filePath?: unknown })?.filePath ?? "");
      if (!filePath) throw new Error("No file was selected.");

      // Re-checked here, not just in preview: the two calls are a user
      // interaction apart, and this is the guard that actually protects data.
      const occupied = existingPositionCount(scope.ou, scenarioId);
      if (occupied > 0) {
        return ok({ outcome: "scenario_not_empty", positionCount: occupied });
      }

      const year = scenarioYear(scope.ou, scenarioId);
      const plan = buildPlan(filePath, request);
      const catalog = getFieldCatalog(localDbHandle(), scope);

      const report = await commitImportPlan(plan, {
        localDb: localDbHandle(),
        secureDb: secureDb(),
        scope,
        scenarioId,
        year,
        now: new Date().toISOString(),
        newId: () => randomUUID(),
        fieldLookup: buildFieldMap(catalog),
        getCalendar: () => getCalendarYear(scope.ou, year),
        saveCalendar: (calendar) => saveCalendarYear(calendar),
        getPositionDefaults: () => getPositionDefaults(scope.ou, year),
        savePositionDefaults: (defaults) => savePositionDefaults(defaults),
      });

      // Blocks and positions both moved; refresh the KPI caches the same way a
      // budget pull does, so anything driven off them is not left stale.
      recomputeAllForOu(localDbHandle(), scope.ou, {
        computedAt: new Date().toISOString(),
      });

      return ok({ outcome: "ok", report });
    } catch (error) {
      console.error("Legacy import commit failed:", error);
      return fail(error, { outcome: "cancelled" } as LegacyImportCommitResult);
    }
  };

  return {
    [LEGACY_IMPORT_CHANNELS.preview]: preview,
    [LEGACY_IMPORT_CHANNELS.commit]: commit,
  };
}
