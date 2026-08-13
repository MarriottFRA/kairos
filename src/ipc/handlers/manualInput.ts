/**
 * Manual-input IPC handlers.
 *
 * CRUD over hand-entered cost lines in the encrypted secure store. Every channel
 * is OU-gated (registered with ouScopeMiddleware in ipc/index.ts) and re-brands
 * the OU here via resolveOuScope, so a row can only ever land in the selected
 * hotel's data. The secure DB is reachable only after sign-in unlocks it —
 * secureDb() throws otherwise, which the try/catch surfaces as a failed result.
 * Mutations return the full current list so the renderer refreshes in one
 * round-trip.
 */

import { randomUUID } from "crypto";

import { IpcHandler, IpcResult } from "../types";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import {
  deleteRows,
  healBlankRowIds,
  healRowScenario,
  listRows,
  nextSortOrder,
  saveRow,
} from "../../main/manualInput/repo";
import {
  MANUAL_INPUT_CHANNELS,
  ManualInputRow,
  ManualInputRowId,
  ManualInputRowInput,
} from "../../shared/manualInput/ipc";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

/**
 * The scenario every channel here works in, plus the one-shot adoption of rows
 * that predate the scoping.
 *
 * Manual rows post into the persisted results, which are per (ou, scenario), so
 * they had to become scenario-scoped too. The secure-store migration could only
 * default the column to '' — `scenarios` lives in the plaintext store and the
 * two files can never be ATTACHed — so the stamp happens here, the first place
 * that knows both the OU and which scenario the renderer is looking at.
 */
function scenarioOf(db: SecureDbHandle, request: any, ou: string): string {
  const scenarioId = String(request?.scenarioId ?? "").trim();
  if (!scenarioId) throw new Error("Missing scenario.");
  healRowScenario(db, ou, scenarioId);
  return scenarioId;
}

type SecureDbHandle = ReturnType<typeof secureDb>;

export function createManualInputHandlers(): Record<string, IpcHandler> {
  /** All rows for the OU, in sort order. */
  const list: IpcHandler<any, IpcResult<ManualInputRow[]>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const db = secureDb();
      const scenarioId = scenarioOf(db, request, scope.ou);
      // Rescue rows minted with an empty id by the bug fixed in `save` below —
      // list is the first thing the page does, so they arrive already healed.
      healBlankRowIds(db, scope.ou, () => randomUUID());
      return ok(listRows(db, scope.ou, scenarioId));
    } catch (error) {
      console.error("Manual input list failed:", error);
      return fail(error, []);
    }
  };

  /** Create or update a row, then return the refreshed list. */
  const save: IpcHandler<any, IpcResult<ManualInputRow[]>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const input = request?.row as ManualInputRowInput | undefined;
      if (!input) throw new Error("Missing row payload.");

      const db = secureDb();
      const scenarioId = scenarioOf(db, request, scope.ou);
      const now = new Date().toISOString();
      // `??` was wrong here: "Add row" sends id: "" (the renderer has no id to
      // give yet), and `"" ?? uuid` is "", so every new row was stored under the
      // empty-string primary key — one shared blank row per install, which the
      // next add overwrote and which delete could never name ("Missing row
      // id(s)."). `isNew` already treated "" as new; this now agrees with it.
      const isNew = !input.id;
      const id = (isNew ? randomUUID() : input.id) as ManualInputRowId;
      const createdBy =
        typeof request?.createdBy === "string" && request.createdBy.trim()
          ? request.createdBy.trim()
          : null;

      saveRow(db, {
        id,
        ou: scope.ou,
        scenarioId,
        description: input.description,
        department: input.department,
        departmentCode: input.departmentCode,
        costAccount: input.costAccount,
        statsAccount: input.statsAccount,
        rate: input.rate,
        stats: input.stats ?? [],
        amounts: input.amounts ?? [],
        spreadMode: input.spreadMode ?? null,
        spreadBaseStats: input.spreadBaseStats ?? null,
        spreadBaseAmount: input.spreadBaseAmount ?? null,
        increasePct: input.increasePct ?? 0,
        increaseMonth: input.increaseMonth ?? 13,
        sortOrder: isNew ? nextSortOrder(db, scope.ou, scenarioId) : 0,
        createdBy,
        now,
      });

      return ok(listRows(db, scope.ou, scenarioId));
    } catch (error) {
      console.error("Manual input save failed:", error);
      return fail(error, []);
    }
  };

  /** Soft-delete one or more rows, then return the refreshed list. */
  const del: IpcHandler<any, IpcResult<ManualInputRow[]>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const raw = request?.ids ?? request?.id;
      const ids = (Array.isArray(raw) ? raw : [raw])
        .map((value) => String(value ?? ""))
        .filter(Boolean);
      if (ids.length === 0) throw new Error("Missing row id(s).");
      const db = secureDb();
      const scenarioId = scenarioOf(db, request, scope.ou);
      deleteRows(db, scope.ou, ids, { now: new Date().toISOString() });
      return ok(listRows(db, scope.ou, scenarioId));
    } catch (error) {
      console.error("Manual input delete failed:", error);
      return fail(error, []);
    }
  };

  return {
    [MANUAL_INPUT_CHANNELS.list]: list,
    [MANUAL_INPUT_CHANNELS.save]: save,
    [MANUAL_INPUT_CHANNELS.delete]: del,
  };
}
