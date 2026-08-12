/**
 * BST Push IPC handlers.
 *
 * Recalculate the scenario, read the hotel's BST, and write the Results page's
 * dept×account×month rows into it. The mirror of the budget pull, and the
 * app-native successor to the old `ExportData2BST` macro.
 *
 * Two round-trips, one plan builder: `preview` builds the plan and writes
 * nothing; `commit` re-reads the same path and rebuilds the plan through the
 * SAME function before applying, so what the user approved and what lands in the
 * file cannot disagree. No server-side session state survives between the two —
 * the renderer carries only the path.
 *
 * Both guards are hard stops, and both read values the workbook states about
 * itself: `Setup Fields!D5` (OU) and `Setup Fields!B1` (budget year). Neither is
 * inferred, so neither needs an override.
 *
 * Every channel is OU-gated (ouScopeMiddleware in ipc/index.ts) and re-brands
 * the OU here via resolveOuScope, so a push can only ever carry the selected
 * hotel's numbers.
 */

import { dialog, shell } from "electron";
import * as path from "path";

import { IpcHandler, IpcResult } from "../types";
import {
  getCalendarYear,
  getPositionDefaults,
  localDbHandle,
} from "../../local_db";
import { secureDb } from "../../secure_db";
import { normalizeOu, resolveOuScope } from "../../main/positions/ouScope";
import type { OuScope } from "../../main/positions/ouScope";
import { runRecalc } from "../../main/positions/runRecalc";
import { listAccounts, listDepartments } from "../../main/mappingTables/repo";
import {
  applyToFile,
  isWorkbookOpen,
  readWorkbookBytes,
} from "../../main/bstPush/applyToFile";
import {
  NotBstFileError,
  UnsupportedLayoutError,
  readTarget,
} from "../../main/bstPush/readTarget";
import type { BstTarget } from "../../main/bstPush/readTarget";
import { buildPushPlan, toCellWrites } from "../../main/bstPush/plan";
import {
  readBstPushConfig,
  writeBstPushConfig,
} from "../../main/bstPush/config";
import {
  BST_PUSH_CHANNELS,
  BstPushCommitResult,
  BstPushConfig,
  BstPushOptions,
  BstPushPlan,
  BstPushPreviewResult,
  BstPushRefusal,
  isEmptyMonthPlan,
  normalizeBstPushOptions,
} from "../../shared/bstPush/ipc";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

function requireScenarioId(request: { scenarioId?: unknown } | undefined): string {
  const scenarioId =
    typeof request?.scenarioId === "string" ? request.scenarioId.trim() : "";
  if (!scenarioId) throw new Error("A scenarioId is required");
  return scenarioId;
}

function requireYear(request: { year?: unknown } | undefined): number {
  const year = Math.trunc(Number(request?.year));
  if (!Number.isFinite(year) || year <= 0) {
    throw new Error("A budget year is required");
  }
  return year;
}

function requireFilePath(request: { filePath?: unknown } | undefined): string {
  const filePath =
    typeof request?.filePath === "string" ? request.filePath.trim() : "";
  if (!filePath) throw new Error("No file was selected.");
  return filePath;
}

/** Calendars/defaults were saved under either OU form; try both, as recalc does. */
const getCalendarEitherForm = async (ou: string, year: number) =>
  (await getCalendarYear(ou, year)) ??
  (await getCalendarYear(ou.replace(/^OU/, ""), year));

const getDefaultsEitherForm = async (ou: string, year: number) =>
  (await getPositionDefaults(ou, year)) ??
  (await getPositionDefaults(ou.replace(/^OU/, ""), year));

/**
 * Read a target and check it belongs to this hotel and this budget year.
 * Returns a refusal, or the parsed target.
 */
function openTarget(
  filePath: string,
  scope: OuScope,
  year: number
): { refusal: BstPushRefusal } | { target: BstTarget } {
  const sourceFileName = path.basename(filePath);

  // Checked before reading: a workbook Excel has open would silently discard
  // the push on its next save.
  if (isWorkbookOpen(filePath)) {
    return { refusal: { outcome: "file_locked", sourceFileName } };
  }

  let target: BstTarget;
  try {
    target = readTarget(readWorkbookBytes(filePath), sourceFileName);
  } catch (error) {
    if (error instanceof NotBstFileError) {
      return {
        refusal: { outcome: "not_bst_file", sourceFileName, reason: error.message },
      };
    }
    if (error instanceof UnsupportedLayoutError) {
      return {
        refusal: {
          outcome: "unsupported_layout",
          sourceFileName,
          reason: error.message,
        },
      };
    }
    throw error;
  }

  const fileOu = normalizeOu(target.ou) ?? target.ou;
  if (fileOu !== scope.ou) {
    return {
      refusal: {
        outcome: "ou_mismatch",
        fileOu,
        selectedOu: scope.ou,
        sourceFileName,
      },
    };
  }

  if (target.year !== year) {
    return {
      refusal: {
        outcome: "year_mismatch",
        fileYear: target.year,
        selectedYear: year,
        sourceFileName,
      },
    };
  }

  return { target };
}

/**
 * Recalculate, then turn the stored outputs into a plan against `target`.
 * Shared by preview and commit — the single source of truth for what a push does.
 */
async function buildPlanFor(
  target: BstTarget,
  filePath: string,
  scope: OuScope,
  scenarioId: string,
  options: BstPushOptions
): Promise<BstPushPlan> {
  const outputs = await runRecalc(
    {
      localDb: localDbHandle(),
      secureDb: secureDb(),
      getCalendar: getCalendarEitherForm,
      getDefaults: getDefaultsEitherForm,
    },
    scope,
    scenarioId
  );

  // Read here rather than carried on the request: the rule set decides what
  // gets destroyed, so it comes from what the user actually saved, never from
  // the renderer's copy of it.
  const { clearPrefixes } = await readBstPushConfig();

  const db = localDbHandle();
  return buildPushPlan({
    target,
    filePath,
    outputs: outputs.rows,
    options,
    clearPrefixes,
    departmentNameByCode: new Map(
      listDepartments(db).map((dept) => [dept.code, dept.name])
    ),
    accountNameByCode: new Map(
      listAccounts(db).map((account) => [account.code, account.name])
    ),
    unpostedByLabel: outputs.diagnostics?.unpostedByLabel,
  });
}

export function createBstPushHandlers(): Record<string, IpcHandler> {
  /**
   * Pick a file, recalculate, and describe exactly what a push would write.
   *
   * A `filePath` on the request skips the dialog and re-previews that file —
   * how the review screen refreshes its numbers when the user changes an
   * option, without making them pick the file again.
   */
  const preview: IpcHandler<any, IpcResult<BstPushPreviewResult>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      const year = requireYear(request);
      const options = normalizeBstPushOptions(request?.options);

      let filePath =
        typeof request?.filePath === "string" ? request.filePath.trim() : "";
      if (!filePath) {
        const picked = await dialog.showOpenDialog({
          title: "Select the hotel's BST (BGT Spread File) to push into",
          properties: ["openFile"],
          filters: [{ name: "BGT Spread File", extensions: ["xlsm", "xlsx"] }],
        });
        if (picked.canceled || picked.filePaths.length === 0) {
          return ok({ outcome: "cancelled" });
        }
        filePath = picked.filePaths[0];
      }

      const opened = openTarget(filePath, scope, year);
      if ("refusal" in opened) return ok(opened.refusal);

      const plan = await buildPlanFor(
        opened.target,
        filePath,
        scope,
        scenarioId,
        options
      );
      if (plan.rows.length === 0) return ok({ outcome: "no_outputs" });

      return ok({ outcome: "ready", plan });
    } catch (error) {
      console.error("BST push preview failed:", error);
      return fail(error, { outcome: "cancelled" } as BstPushPreviewResult);
    }
  };

  /** Re-read the previewed path, rebuild the plan, and apply it. */
  const commit: IpcHandler<any, IpcResult<BstPushCommitResult>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      const year = requireYear(request);
      const filePath = requireFilePath(request);
      const options = normalizeBstPushOptions(request?.options);

      // A preview of an all-skip plan is a legitimate thing to look at; a
      // commit of one is not, so the guard lives here rather than there.
      if (isEmptyMonthPlan(options.months)) return ok({ outcome: "no_months" });

      // Re-checked here, not just in preview: the two calls are a user
      // interaction apart, and this is the guard that actually protects the file.
      const opened = openTarget(filePath, scope, year);
      if ("refusal" in opened) return ok(opened.refusal);

      const plan = await buildPlanFor(
        opened.target,
        filePath,
        scope,
        scenarioId,
        options
      );
      if (plan.rows.length === 0) return ok({ outcome: "no_outputs" });

      const applied = applyToFile(
        filePath,
        toCellWrites(plan, opened.target),
        { backup: options.backup }
      );

      return ok({
        outcome: "ok",
        report: {
          file: plan.file,
          options,
          rows: plan.rows,
          monthPlan: plan.monthPlan,
          clearScope: plan.clearScope,
          writeCount: plan.writeCount,
          problemCount: plan.problemCount,
          skippedCount: plan.skippedCount,
          cellCount: plan.cellCount,
          zeroCellCount: plan.zeroCellCount,
          sheetsTouched: applied.sheetsTouched,
          backupPath: applied.backupPath,
          warnings: plan.warnings,
        },
      });
    } catch (error) {
      console.error("BST push commit failed:", error);
      return fail(error, { outcome: "cancelled" } as BstPushCommitResult);
    }
  };

  /** The saved clear rules and last-used month plan. */
  const config: IpcHandler<any, IpcResult<BstPushConfig>> = async () => {
    try {
      return ok(await readBstPushConfig());
    } catch (error) {
      console.error("BST push config read failed:", error);
      return fail(error, await readBstPushConfig());
    }
  };

  /** Persist a partial change to that config and return it whole. */
  const setConfig: IpcHandler<any, IpcResult<BstPushConfig>> = async (
    _event,
    request
  ) => {
    try {
      return ok(await writeBstPushConfig(request?.config ?? request));
    } catch (error) {
      console.error("BST push config write failed:", error);
      return fail(error, await readBstPushConfig());
    }
  };

  /**
   * Show a written file in the OS file manager. Reveal only — never open or
   * execute — and only a path this feature just wrote or backed up, which the
   * renderer holds because we returned it.
   */
  const reveal: IpcHandler<any, IpcResult<boolean>> = async (_event, request) => {
    try {
      const filePath = requireFilePath(request);
      shell.showItemInFolder(path.resolve(filePath));
      return ok(true);
    } catch (error) {
      console.error("BST reveal failed:", error);
      return fail(error, false);
    }
  };

  return {
    [BST_PUSH_CHANNELS.preview]: preview,
    [BST_PUSH_CHANNELS.commit]: commit,
    [BST_PUSH_CHANNELS.config]: config,
    [BST_PUSH_CHANNELS.setConfig]: setConfig,
    [BST_PUSH_CHANNELS.reveal]: reveal,
  };
}
