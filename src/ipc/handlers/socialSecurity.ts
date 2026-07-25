/**
 * Social Security / NI IPC handlers.
 *
 * OU-gated (registered with ouScopeMiddleware in ipc/index.ts): a scheme is
 * OU-scoped reference data in the plaintext structure store, like block
 * configs. Reads reuse the engine's existing structureRepo.getSsSchemes; writes
 * go through the new socialSecurity repo. Every mutation returns the refreshed
 * list (one round-trip, the blocks idiom).
 */

import { IpcHandler, IpcResult } from "../types";
import { getCalendarYear, localDbHandle } from "../../local_db";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import { getSsSchemes } from "../../main/positions/structureRepo";
import { deleteScheme, saveScheme } from "../../main/socialSecurity/repo";
import { computeNiOpeningBalances } from "../../main/socialSecurity/openingBalances";
import {
  RecomputeOpeningsResponse,
  SOCIAL_SECURITY_CHANNELS,
  SsSchemeInput,
  SsSchemesListResponse,
} from "../../shared/socialSecurity/ipc";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

const EMPTY: SsSchemesListResponse = { schemes: [] };

export function createSocialSecurityHandlers(): Record<string, IpcHandler> {
  /** All non-deleted schemes (with brackets) for the OU. */
  const list: IpcHandler<any, IpcResult<SsSchemesListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      return ok({ schemes: getSsSchemes(localDbHandle(), scope) });
    } catch (error) {
      console.error("Social security list failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Create or update a scheme; returns the refreshed list. */
  const save: IpcHandler<any, IpcResult<SsSchemesListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const input = request?.scheme as SsSchemeInput | undefined;
      if (!input) throw new Error("Missing scheme payload.");
      const db = localDbHandle();
      saveScheme(db, scope, input, { now: new Date().toISOString() });
      return ok({ schemes: getSsSchemes(db, scope) });
    } catch (error) {
      console.error("Social security save failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Soft-delete a scheme; returns the refreshed list. */
  const remove: IpcHandler<any, IpcResult<SsSchemesListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const id = request?.id as string | undefined;
      if (!id) throw new Error("Missing scheme id.");
      const db = localDbHandle();
      deleteScheme(db, scope, id, { now: new Date().toISOString() });
      return ok({ schemes: getSsSchemes(db, scope) });
    } catch (error) {
      console.error("Social security delete failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Run the opening-balance pre-sim for a scenario and persist the results. */
  const recomputeOpenings: IpcHandler<any, IpcResult<RecomputeOpeningsResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = request?.scenarioId as string | undefined;
      if (!scenarioId) throw new Error("Missing scenario id.");
      const ssSchemeId = request?.ssSchemeId as string | undefined;
      if (!ssSchemeId) throw new Error("Missing scheme id.");
      // Calendars were saved under either OU form (mirrors the recalc handler).
      const getCalendarEitherForm = async (ou: string, year: number) =>
        (await getCalendarYear(ou, year)) ??
        (await getCalendarYear(ou.replace(/^OU/, ""), year));
      const result = await computeNiOpeningBalances(
        localDbHandle(),
        secureDb(),
        scope,
        scenarioId,
        ssSchemeId,
        getCalendarEitherForm,
        new Date().toISOString()
      );
      return ok(result);
    } catch (error) {
      console.error("Social security recompute-openings failed:", error);
      return fail(error, { updated: 0 });
    }
  };

  return {
    [SOCIAL_SECURITY_CHANNELS.list]: list,
    [SOCIAL_SECURITY_CHANNELS.save]: save,
    [SOCIAL_SECURITY_CHANNELS.delete]: remove,
    [SOCIAL_SECURITY_CHANNELS.recomputeOpenings]: recomputeOpenings,
  };
}
