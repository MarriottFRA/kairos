/**
 * Budget submission IPC handlers: preview (build only), send (build and PUT),
 * status (what the server holds). OU-gated like the reports handlers, with
 * the same SECURE_DB_LOCKED mapping so the page can prompt for re-auth.
 *
 * The picker's rules (which slots and years are open) are enforced here too:
 * what the page cannot choose, main will not send.
 */

import { app } from "electron";
import { IpcHandler, IpcResult } from "../types";
import { getCalendarYear, getPositionDefaults, localDbHandle } from "../../local_db";
import { secureDb } from "../../secure_db";
import type { ApiClient } from "../../main/auth/apiClient";
import { readClearRules } from "../../main/bstPush/config";
import { KairosClient } from "../../main/kairosSync/client";
import { resolveOuScope } from "../../main/positions/ouScope";
import { buildSubmission } from "../../main/submission/build";
import { fetchSubmissionStatus, sendSubmission } from "../../main/submission/server";
import { SECURE_DB_LOCKED } from "../../shared/positions/ipc";
import {
  SUBMISSION_CHANNELS,
  SubmissionBuildRequest,
  SubmissionPreviewResponse,
  SubmissionSendResponse,
  SubmissionStatusRequest,
  SubmissionStatusResponse,
} from "../../shared/submission/ipc";
import { ENABLED_SUBMISSION_SLOTS, ENABLED_SUBMISSION_YEARS } from "../../shared/submission/schema";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  let message = error instanceof Error ? error.message : "Unknown error";
  if (message.includes("Secure database is locked")) message = SECURE_DB_LOCKED;
  return { success: false, error: message, data, timestamp: Date.now() };
}

// Hotel OUs are stored both branded ("OU12345") and bare by different writers;
// read either, as the positions and reports handlers do.
const getCalendarEitherForm = async (ou: string, year: number) =>
  (await getCalendarYear(ou, year)) ?? (await getCalendarYear(ou.replace(/^OU/, ""), year));
const getDefaultsEitherForm = async (ou: string, year: number) =>
  (await getPositionDefaults(ou, year)) ?? (await getPositionDefaults(ou.replace(/^OU/, ""), year));

export function checkSubmissionRequest(request: SubmissionBuildRequest | undefined): SubmissionBuildRequest {
  const scenarioId = typeof request?.scenarioId === "string" ? request.scenarioId.trim() : "";
  if (!scenarioId) throw new Error("Choose a plan to submit.");
  const slot = typeof request?.slot === "string" ? request.slot.trim().toUpperCase() : "";
  if (!(ENABLED_SUBMISSION_SLOTS as readonly string[]).includes(slot)) {
    throw new Error(`The "${slot || "?"}" submission is not open yet.`);
  }
  const year = Number(request?.year);
  if (!ENABLED_SUBMISSION_YEARS.includes(year)) {
    throw new Error(`Submissions for ${Number.isFinite(year) ? year : "that year"} are not open yet.`);
  }
  return { ou: request?.ou ?? "", scenarioId, slot, year, hotelName: request?.hotelName };
}

export function createSubmissionHandlers(apiClient: ApiClient): Record<string, IpcHandler> {
  const client = new KairosClient(apiClient);
  const dbs = () => ({ localDb: localDbHandle(), secureDb: secureDb() });

  const build = async (raw: SubmissionBuildRequest | undefined) => {
    const scope = resolveOuScope(raw?.ou);
    const request = checkSubmissionRequest(raw);
    const clearRules = await readClearRules();
    return buildSubmission(dbs(), scope, request, {
      getCalendar: getCalendarEitherForm,
      getPositionDefaults: getDefaultsEitherForm,
      clearRules,
      appVersion: app.getVersion(),
    });
  };

  return {
    [SUBMISSION_CHANNELS.preview]: async (
      _event,
      request?: SubmissionBuildRequest
    ): Promise<IpcResult<SubmissionPreviewResponse | null>> => {
      try {
        const built = await build(request);
        return ok({ payload: built.payload, counts: built.counts, run: built.run, warnings: built.warnings });
      } catch (error) {
        return fail(error, null);
      }
    },

    [SUBMISSION_CHANNELS.send]: async (
      _event,
      request?: SubmissionBuildRequest
    ): Promise<IpcResult<SubmissionSendResponse | null>> => {
      try {
        const built = await build(request);
        const receipt = await sendSubmission(client, built.payload);
        return ok({ receipt, counts: built.counts, warnings: built.warnings });
      } catch (error) {
        return fail(error, null);
      }
    },

    [SUBMISSION_CHANNELS.status]: async (
      _event,
      request?: SubmissionStatusRequest
    ): Promise<IpcResult<SubmissionStatusResponse | null>> => {
      try {
        const scope = resolveOuScope(request?.ou);
        return ok(await fetchSubmissionStatus(client, scope.ou));
      } catch (error) {
        return fail(error, null);
      }
    },
  };
}
