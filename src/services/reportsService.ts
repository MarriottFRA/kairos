/**
 * Reports Service
 * Renderer-side driver for the report engine. Main owns the results cache,
 * the mapping tables and the budget import; this service relays the selected
 * OU + scenario and the definition to evaluate.
 */

import {
  REPORTS_CHANNELS,
  ReportDefinitionSummary,
  ReportsEvaluateRequest,
  ReportsEvaluateResponse,
} from "../shared/reports/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Evaluate one built-in report for (hotel, scenario). Throws on failure. */
export async function evaluateReport(
  ou: string,
  scenarioId: string,
  definitionId: string,
  options: { bst?: ReportsEvaluateRequest["bst"] } = {}
): Promise<ReportsEvaluateResponse> {
  const request: ReportsEvaluateRequest = { ou, scenarioId, definitionId, bst: options.bst };
  const response = await ipc().sendIpcRequest(REPORTS_CHANNELS.evaluate, request);
  if (response && response.success === false) {
    throw new Error(response.error || "Failed to evaluate the report");
  }
  return response.data as ReportsEvaluateResponse;
}

/** The built-in definitions, for a picker. */
export async function listReportDefinitions(ou: string): Promise<ReportDefinitionSummary[]> {
  const response = await ipc().sendIpcRequest(REPORTS_CHANNELS.listDefinitions, { ou });
  return (response.data as ReportDefinitionSummary[]) ?? [];
}
