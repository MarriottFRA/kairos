/**
 * Reports IPC handlers.
 *
 * Evaluate a built-in report definition for the selected hotel + scenario,
 * and list the definitions. Every channel is OU-gated (ouScopeMiddleware in
 * ipc/index.ts) and re-brands the OU here via resolveOuScope. A locked
 * encrypted store maps to the SECURE_DB_LOCKED sentinel, as on the Results
 * page, so the renderer can prompt for re-auth.
 */

import { IpcHandler, IpcResult } from "../types";
import { localDbHandle } from "../../local_db";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import {
  evaluateReportForScenario,
  listReportDefinitionSummaries,
} from "../../main/reports/evaluate";
import {
  REPORTS_CHANNELS,
  ReportsEvaluateRequest,
} from "../../shared/reports/ipc";
import { SECURE_DB_LOCKED } from "../../shared/positions/ipc";

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

function requireString(value: unknown, what: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`A ${what} is required`);
  return text;
}

export function createReportsHandlers(): Record<string, IpcHandler> {
  return {
    [REPORTS_CHANNELS.evaluate]: async (_event, request: ReportsEvaluateRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const definitionId = requireString(request?.definitionId, "definitionId");
        return ok(
          evaluateReportForScenario(
            { localDb: localDbHandle(), secureDb: secureDb() },
            scope,
            scenarioId,
            definitionId,
            { bst: request?.bst }
          )
        );
      } catch (error) {
        console.error("Failed to evaluate report:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.listDefinitions]: async () => {
      try {
        return ok(listReportDefinitionSummaries());
      } catch (error) {
        return fail(error, []);
      }
    },
  };
}
