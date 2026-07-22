/**
 * Positions IPC Handlers
 * The renderer's only door into the positions feature: scenarios + field
 * catalog (plaintext store), position values + PII (encrypted store), and the
 * assembled engine ScenarioInput.
 *
 * Every channel requires a valid hotel OU (enforced twice: ouScopeMiddleware
 * fails fast, resolveOuScope() brands the value the repositories require).
 * When the encrypted store is locked the error is mapped to the
 * SECURE_DB_LOCKED sentinel so the renderer can prompt for re-auth instead of
 * showing a raw failure.
 */

import { IpcHandler, IpcResult } from "../types";
import { getCalendarYear, localDbHandle } from "../../local_db";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import {
  ensureDefaultScenario,
  getFieldCatalog,
  listRemovedFields,
  listScenarios,
  purgeCatalogFields,
  saveFieldCatalog,
  saveScenario,
  softDeleteScenario,
} from "../../main/positions/structureRepo";
import {
  batchWrite,
  cloneScenarioValues,
  countExtraValueUsage,
  getPii,
  loadScenarioValues,
  scrubExtraValueKeys,
} from "../../main/positions/positionsRepo";
import { loadScenarioInput } from "../../main/positions/loadScenarioInput";
import { uuidv7 } from "../../shared/engine/ids";
import { buildFieldMap } from "../../shared/positions/rowModel";
import {
  FieldCatalogPurgeRequest,
  FieldCatalogPurgeResponse,
  FieldCatalogResponse,
  FieldCatalogSaveRequest,
  PiiRecord,
  PositionsBatchWriteRequest,
  PositionsBatchWriteResponse,
  PositionsLoadResponse,
  RemovedFieldDto,
  ScenarioCloneRequest,
  ScenarioCloneResponse,
  ScenarioDto,
  ScenarioSaveRequest,
  SECURE_DB_LOCKED,
} from "../../shared/positions/ipc";
import type { ScenarioInput } from "../../shared/engine/types";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  let message = error instanceof Error ? error.message : "Unknown error";
  if (message.includes("Secure database is locked")) {
    message = SECURE_DB_LOCKED;
  }
  return { success: false, error: message, data, timestamp: Date.now() };
}

function requireScenarioId(request: { scenarioId?: unknown } | undefined): string {
  const scenarioId =
    typeof request?.scenarioId === "string" ? request.scenarioId.trim() : "";
  if (!scenarioId) throw new Error("A scenarioId is required");
  return scenarioId;
}

export class PositionsHandlers {
  // ── Scenarios (plaintext store) ─────────────────────────────────

  scenarioList: IpcHandler<any, IpcResult<ScenarioDto[]>> = async (_event, request) => {
    try {
      const scope = resolveOuScope(request);
      // When the caller supplies a year, guarantee its default "Planning"
      // scenario exists before listing, so a fresh OU+year is never empty.
      const year = Math.trunc(Number(request?.year));
      if (Number.isFinite(year) && year > 0) {
        ensureDefaultScenario(localDbHandle(), scope, year);
      }
      return ok(listScenarios(localDbHandle(), scope));
    } catch (error) {
      console.error("Failed to list scenarios:", error);
      return fail(error, [] as ScenarioDto[]);
    }
  };

  scenarioSave: IpcHandler<any, IpcResult<ScenarioDto | null>> = async (
    _event,
    request: ScenarioSaveRequest
  ) => {
    try {
      const scope = resolveOuScope(request);
      if (!request?.scenario) throw new Error("A scenario payload is required");
      return ok(saveScenario(localDbHandle(), scope, request.scenario));
    } catch (error) {
      console.error("Failed to save scenario:", error);
      return fail(error, null);
    }
  };

  scenarioDelete: IpcHandler<any, IpcResult<void>> = async (_event, request) => {
    try {
      const scope = resolveOuScope(request);
      softDeleteScenario(localDbHandle(), scope, requireScenarioId(request));
      return ok(undefined as void);
    } catch (error) {
      console.error("Failed to delete scenario:", error);
      return fail(error, undefined as void);
    }
  };

  /**
   * Roll a scenario forward: snapshot-copy every value row into an empty
   * target. Both scenarios are verified to belong to this OU against the
   * plaintext store before the encrypted store is touched — the ids arrive
   * over IPC and the value tables have no cross-file FK to check them.
   */
  scenarioClone: IpcHandler<any, IpcResult<ScenarioCloneResponse | null>> = async (
    _event,
    request: ScenarioCloneRequest
  ) => {
    try {
      const scope = resolveOuScope(request);
      const sourceScenarioId = String(request?.sourceScenarioId ?? "").trim();
      const targetScenarioId = String(request?.targetScenarioId ?? "").trim();
      if (!sourceScenarioId || !targetScenarioId) {
        throw new Error("Both a source and a target scenario are required");
      }

      const owned = new Set(
        listScenarios(localDbHandle(), scope).map((scenario) => scenario.id)
      );
      if (!owned.has(sourceScenarioId) || !owned.has(targetScenarioId)) {
        throw new Error("Scenario not found in this hotel");
      }

      return ok(
        cloneScenarioValues(
          secureDb(),
          scope,
          sourceScenarioId,
          targetScenarioId,
          uuidv7
        )
      );
    } catch (error) {
      console.error("Failed to copy scenario:", error);
      return fail(error, null);
    }
  };

  // ── Field catalog (plaintext store) ─────────────────────────────

  fieldCatalogGet: IpcHandler<any, IpcResult<FieldCatalogResponse | null>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      return ok(getFieldCatalog(localDbHandle(), scope));
    } catch (error) {
      console.error("Failed to get field catalog:", error);
      return fail(error, null);
    }
  };

  fieldCatalogSave: IpcHandler<any, IpcResult<FieldCatalogResponse | null>> = async (
    _event,
    request: FieldCatalogSaveRequest
  ) => {
    try {
      const scope = resolveOuScope(request);
      const patches = Array.isArray(request?.patches) ? request.patches : [];
      return ok(saveFieldCatalog(localDbHandle(), scope, patches));
    } catch (error) {
      console.error("Failed to save field catalog:", error);
      return fail(error, null);
    }
  };

  /**
   * Soft-deleted USER columns for the "Recently removed" surface, each with a
   * cross-scenario value count. The catalog lives in the plaintext store; the
   * counts in the encrypted one — if it is locked the columns still list, with
   * a null count, so the user can still restore them.
   */
  fieldCatalogRemoved: IpcHandler<any, IpcResult<RemovedFieldDto[]>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const removed = listRemovedFields(localDbHandle(), scope);
      const counts = new Map<string, number | null>();
      try {
        const db = secureDb();
        for (const field of removed) {
          counts.set(field.key, countExtraValueUsage(db, scope, field.key));
        }
      } catch {
        for (const field of removed) counts.set(field.key, null);
      }
      return ok(
        removed.map((field) => ({ ...field, valueCount: counts.get(field.key) ?? null }))
      );
    } catch (error) {
      console.error("Failed to list removed fields:", error);
      return fail(error, [] as RemovedFieldDto[]);
    }
  };

  /**
   * Permanently purge removed columns. Either an explicit `keys` list (manual
   * "delete forever") or a `sweepGraceDays` window (the automatic cleanup:
   * purge columns that hold no data, or whose removal is older than the
   * window). Values are scrubbed from the encrypted store BEFORE the catalog
   * rows are dropped — the two stores have no shared transaction, and this
   * order means a mid-way failure leaves the column recoverable, never a
   * dangling catalog row over already-deleted data.
   */
  fieldCatalogPurge: IpcHandler<any, IpcResult<FieldCatalogPurgeResponse>> = async (
    _event,
    request: FieldCatalogPurgeRequest
  ) => {
    try {
      const scope = resolveOuScope(request);
      const local = localDbHandle();
      const secure = secureDb();
      const removed = listRemovedFields(local, scope);
      const removedKeys = new Set(removed.map((field) => field.key));

      let targets: string[];
      if (Array.isArray(request?.keys) && request.keys.length > 0) {
        targets = request.keys.filter((key) => removedKeys.has(key));
      } else if (typeof request?.sweepGraceDays === "number") {
        const cutoff = Date.now() - request.sweepGraceDays * 24 * 60 * 60 * 1000;
        targets = removed
          .filter(
            (field) =>
              countExtraValueUsage(secure, scope, field.key) === 0 ||
              Date.parse(field.deletedAt) < cutoff
          )
          .map((field) => field.key);
      } else {
        targets = [];
      }

      if (targets.length === 0) return ok({ purged: [] });

      scrubExtraValueKeys(secure, scope, targets);
      const purged = purgeCatalogFields(local, scope, targets);
      return ok({ purged });
    } catch (error) {
      console.error("Failed to purge removed fields:", error);
      return fail(error, { purged: [] });
    }
  };

  // ── Position values + PII (encrypted store) ─────────────────────

  load: IpcHandler<any, IpcResult<PositionsLoadResponse | null>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      return ok(loadScenarioValues(secureDb(), scope, scenarioId));
    } catch (error) {
      console.error("Failed to load positions:", error);
      return fail(error, null);
    }
  };

  piiGet: IpcHandler<any, IpcResult<Record<string, PiiRecord> | null>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      return ok(getPii(secureDb(), scope, scenarioId));
    } catch (error) {
      console.error("Failed to load position PII:", error);
      return fail(error, null);
    }
  };

  batchWrite: IpcHandler<any, IpcResult<PositionsBatchWriteResponse | null>> = async (
    _event,
    request: PositionsBatchWriteRequest
  ) => {
    try {
      const scope = resolveOuScope(request);
      // The catalog is the write-path validator: every incoming field key must
      // resolve through it before touching SQL.
      const catalog = getFieldCatalog(localDbHandle(), scope);
      const lookup = buildFieldMap(catalog);
      return ok(batchWrite(secureDb(), scope, request, lookup));
    } catch (error) {
      console.error("Failed to write positions batch:", error);
      return fail(error, null);
    }
  };

  // ── Engine input ────────────────────────────────────────────────

  scenarioInput: IpcHandler<any, IpcResult<ScenarioInput | null>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      // Calendars were saved under whatever OU form the hotel switcher held at
      // the time (bare 5-digit from the API, or the OU-prefixed form), so look
      // up both before falling back to the default calendar.
      const getCalendarEitherForm = async (ou: string, year: number) =>
        (await getCalendarYear(ou, year)) ??
        (await getCalendarYear(ou.replace(/^OU/, ""), year));
      return ok(
        await loadScenarioInput(
          localDbHandle(),
          secureDb(),
          scope,
          scenarioId,
          getCalendarEitherForm
        )
      );
    } catch (error) {
      console.error("Failed to assemble scenario input:", error);
      return fail(error, null);
    }
  };
}

export function createPositionsHandlers() {
  const handlers = new PositionsHandlers();

  return {
    "positions:scenario-list": handlers.scenarioList,
    "positions:scenario-save": handlers.scenarioSave,
    "positions:scenario-delete": handlers.scenarioDelete,
    "positions:scenario-clone": handlers.scenarioClone,
    "positions:field-catalog-get": handlers.fieldCatalogGet,
    "positions:field-catalog-save": handlers.fieldCatalogSave,
    "positions:field-catalog-removed": handlers.fieldCatalogRemoved,
    "positions:field-catalog-purge": handlers.fieldCatalogPurge,
    "positions:load": handlers.load,
    "positions:pii-get": handlers.piiGet,
    "positions:batch-write": handlers.batchWrite,
    "positions:scenario-input": handlers.scenarioInput,
  };
}
