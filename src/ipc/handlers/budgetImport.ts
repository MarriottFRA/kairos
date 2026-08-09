/**
 * Budget-import IPC handlers.
 *
 * Drives the "pull from Excel" flow entirely in main, in one pass: open a file
 * dialog, parse the workbook, gate it against the selected hotel's OU, and — on
 * a match — bulk write it into the plaintext local store (overwriting the
 * hotel's previous data), then return the stored rows. Reading the file is the
 * expensive part, so there is no separate preview/commit round-trip.
 *
 * Every channel is OU-gated (registered with ouScopeMiddleware in ipc/index.ts)
 * and re-brands the OU here via resolveOuScope, so a pull can only ever land in
 * the selected hotel's data.
 */

import { dialog } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import { IpcHandler, IpcResult } from "../types";
import { localDbHandle } from "../../local_db";
import { resolveOuScope, normalizeOu } from "../../main/positions/ouScope";
import { parseWorkbook } from "../../main/budgetImport/parseWorkbook";
import {
  commitImport,
  getCurrentImport,
  getImportRows,
  listImportDepartments,
} from "../../main/budgetImport/repo";
import { listDepartments } from "../../main/mappingTables/repo";
import { recomputeAllForOu } from "../../main/kpiDrivers/repo";
import {
  BUDGET_IMPORT_CHANNELS,
  BudgetDepartmentOption,
  ImportRowsResult,
  ImportSummary,
  PullResult,
} from "../../shared/budgetImport/ipc";

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
 * EPERM) we fall back to a temp-copy read.
 */
function readWorkbookBytes(filePath: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
    const tmp = path.join(
      os.tmpdir(),
      `kairos-bgt-${randomUUID()}${path.extname(filePath)}`
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

export function createBudgetImportHandlers(): Record<string, IpcHandler> {
  /** Pick a file, parse, OU-gate, persist (overwrite), return the stored data. */
  const pull: IpcHandler<any, IpcResult<PullResult>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const importedBy =
        typeof request?.importedBy === "string" && request.importedBy.trim()
          ? request.importedBy.trim()
          : null;

      const picked = await dialog.showOpenDialog({
        title: "Select the hotel's Excel budget file",
        properties: ["openFile"],
        filters: [{ name: "Excel Budget File", extensions: ["xlsm", "xlsx"] }],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return ok({ outcome: "cancelled" });
      }

      const filePath = picked.filePaths[0];
      const sourceFileName = path.basename(filePath);
      const dataset = parseWorkbook(readWorkbookBytes(filePath), sourceFileName);

      if (dataset.rows.length === 0) {
        return ok({ outcome: "no_data", sourceFileName });
      }

      const fileOu = normalizeOu(dataset.meta.ou) ?? dataset.meta.ou;
      if (fileOu !== scope.ou) {
        return ok({
          outcome: "ou_mismatch",
          fileOu,
          selectedOu: scope.ou,
          sourceFileName,
        });
      }

      const db = localDbHandle();
      commitImport(db, {
        id: randomUUID(),
        ou: scope.ou,
        importedBy,
        dataset,
        importedAt: new Date().toISOString(),
      });

      const summary = getCurrentImport(db, scope.ou);
      if (!summary) throw new Error("Import did not persist.");

      // The budget just changed — refresh every KPI driver's cached series for
      // this hotel so the KPI tab and engine read current numbers. Sequenced
      // here (not inside commitImport) to keep the budget repo unaware of KPIs.
      recomputeAllForOu(db, scope.ou, { computedAt: new Date().toISOString() });

      return ok({
        outcome: "ok",
        result: { summary, rows: getImportRows(db, scope.ou) },
      });
    } catch (error) {
      console.error("Budget import pull failed:", error);
      return fail(error, { outcome: "cancelled" } as PullResult);
    }
  };

  /** The current stored import (metadata + rows) for the OU, or null. */
  const getCurrent: IpcHandler<any, IpcResult<ImportRowsResult | null>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const db = localDbHandle();
      const summary = getCurrentImport(db, scope.ou);
      if (!summary) return ok(null);
      return ok({ summary, rows: getImportRows(db, scope.ou) });
    } catch (error) {
      console.error("Budget import getCurrent failed:", error);
      return fail(error, null);
    }
  };

  /**
   * The current import's metadata alone, or null.
   *
   * Same question as `getCurrent` minus the answer's bulk: a caller that only
   * needs "has this hotel pulled?" should not move a few thousand wide rows
   * across the boundary to find out.
   */
  const getSummary: IpcHandler<any, IpcResult<ImportSummary | null>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      return ok(getCurrentImport(localDbHandle(), scope.ou) ?? null);
    } catch (error) {
      console.error("Budget import getSummary failed:", error);
      return fail(error, null);
    }
  };

  /**
   * The hotel's own department list, from its budget file rather than from the
   * company-wide mapping tables. Names are resolved here, the same way the
   * allocations view does it, so the renderer never crosses the wide map.
   * Returns [] when the hotel has never pulled — the caller shows that as "pull
   * the file first" rather than falling back to 200 irrelevant departments.
   */
  const listDepartmentsHandler: IpcHandler<
    any,
    IpcResult<BudgetDepartmentOption[]>
  > = async (_event, request) => {
    try {
      const scope = resolveOuScope(request);
      const db = localDbHandle();
      const nameByCode = new Map(
        listDepartments(db).map((option) => [option.code, option.name])
      );
      const options = listImportDepartments(db, scope.ou).map((code) => ({
        code,
        name: nameByCode.get(code) ?? code,
      }));
      // By description, so the picker reads the way the user thinks about the
      // hotel rather than in GL-code order.
      options.sort((a, b) => a.name.localeCompare(b.name));
      return ok(options);
    } catch (error) {
      console.error("Budget import listDepartments failed:", error);
      return fail(error, [] as BudgetDepartmentOption[]);
    }
  };

  return {
    [BUDGET_IMPORT_CHANNELS.pull]: pull,
    [BUDGET_IMPORT_CHANNELS.getCurrent]: getCurrent,
    [BUDGET_IMPORT_CHANNELS.getSummary]: getSummary,
    [BUDGET_IMPORT_CHANNELS.listDepartments]: listDepartmentsHandler,
  };
}
