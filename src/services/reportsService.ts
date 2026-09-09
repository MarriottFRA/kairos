/**
 * Reports Service
 * Renderer-side driver for the report engine. Main owns the results cache,
 * the mapping tables and the budget import; this service relays the selected
 * OU, the definition and the columns to evaluate, and asks for the
 * drill-down and the export.
 */

import type { ReportColumnSpec, SeriesColumnSpec } from "../shared/reports/columns";
import {
  REPORTS_CHANNELS,
  ReportDefinitionDetail,
  ReportDefinitionSummary,
  ReportsAtomCombosRequest,
  ReportsAtomCombosResponse,
  ReportsEvaluateColumnsRequest,
  ReportsEvaluateColumnsResponse,
  ReportsEvaluateRequest,
  ReportsEvaluateResponse,
  ReportsExportRequest,
  ReportsExportResponse,
  ReportsPackEvaluateRequest,
  ReportsPackEvaluateResponse,
  ReportsPackExportRequest,
  ReportsPackPagesRequest,
  ReportsPackPagesResponse,
  EffectiveWeekResponse,
  ReportsEffectiveWeekRequest,
  ReportsFteReconciliationExportRequest,
  ReportsFteReconciliationRequest,
  ReportsPositionBridgeExportRequest,
  ReportsPositionBridgeRequest,
  ReportsStaffingOverviewExportRequest,
  ReportsStaffingOverviewRequest,
} from "../shared/reports/ipc";
import type { PositionBridgeResponse } from "../shared/reports/bridge";
import type { FteReconciliationResponse } from "../shared/reports/fteReconciliation";
import type { StaffingOverviewResponse, TitleMode } from "../shared/reports/staffingOverview";
import type { ParamValue } from "../shared/reports/types";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

async function request<T>(channel: string, payload: unknown, fallback: string): Promise<T> {
  const response = await ipc().sendIpcRequest(channel, payload);
  if (response && response.success === false) {
    throw new Error(response.error || fallback);
  }
  return response.data as T;
}

export interface ColumnRequestOptions {
  bst?: ReportsEvaluateRequest["bst"];
  params?: Record<string, ParamValue>;
}

/** Where a drill-down's definition comes from: the registry, or a pack page. */
export interface AtomCombosOptions extends ColumnRequestOptions {
  pack?: ReportsAtomCombosRequest["pack"];
}

/** Evaluate one built-in report for (hotel, scenario). Throws on failure. */
export async function evaluateReport(
  ou: string,
  scenarioId: string,
  definitionId: string,
  options: { bst?: ReportsEvaluateRequest["bst"] } = {}
): Promise<ReportsEvaluateResponse> {
  const payload: ReportsEvaluateRequest = { ou, scenarioId, definitionId, bst: options.bst };
  return request(REPORTS_CHANNELS.evaluate, payload, "Failed to evaluate the report");
}

/** Evaluate one built-in report under a column set. Throws on failure. */
export async function evaluateReportColumns(
  ou: string,
  definitionId: string,
  columns: ReportColumnSpec[],
  options: ColumnRequestOptions = {}
): Promise<ReportsEvaluateColumnsResponse> {
  const payload: ReportsEvaluateColumnsRequest = { ou, definitionId, columns, ...options };
  return request(REPORTS_CHANNELS.evaluateColumns, payload, "Failed to evaluate the report");
}

/** The built-in definitions, for a picker. */
export async function listReportDefinitions(ou: string): Promise<ReportDefinitionSummary[]> {
  const response = await ipc().sendIpcRequest(REPORTS_CHANNELS.listDefinitions, { ou });
  return (response.data as ReportDefinitionSummary[]) ?? [];
}

/** One definition as data plus each measure's references — the drill-down's map. */
export async function getReportDefinition(ou: string, definitionId: string): Promise<ReportDefinitionDetail> {
  return request(REPORTS_CHANNELS.getDefinition, { ou, definitionId }, "Failed to load the report definition");
}

/** The combos one atom summed under one series column. */
export async function listAtomCombos(
  ou: string,
  definitionId: string,
  atomId: string,
  column: SeriesColumnSpec,
  options: AtomCombosOptions = {}
): Promise<ReportsAtomCombosResponse> {
  const payload: ReportsAtomCombosRequest = { ou, definitionId, atomId, column, bst: options.bst, pack: options.pack };
  return request(REPORTS_CHANNELS.atomCombos, payload, "Failed to resolve the atom");
}

/** The budget pack's pages for the columns' sources. */
export async function listPackPages(
  ou: string,
  columns: ReportColumnSpec[],
  options: ColumnRequestOptions = {}
): Promise<ReportsPackPagesResponse> {
  const payload: ReportsPackPagesRequest = { ou, columns, ...options };
  return request(REPORTS_CHANNELS.packPages, payload, "Failed to list the budget pack");
}

/** One pack page evaluated. */
export async function evaluatePackPage(
  ou: string,
  pageId: string,
  columns: ReportColumnSpec[],
  options: ColumnRequestOptions = {}
): Promise<ReportsPackEvaluateResponse> {
  const payload: ReportsPackEvaluateRequest = { ou, pageId, columns, ...options };
  return request(REPORTS_CHANNELS.packEvaluate, payload, "Failed to evaluate the pack page");
}

/** The whole pack — or one page of it — as .xlsx; main shows the save dialog. */
export async function exportPack(
  ou: string,
  columns: ReportColumnSpec[],
  options: ColumnRequestOptions & {
    months: boolean;
    thousands?: boolean;
    includeDepartments: boolean;
    pageId?: string;
    hotelName?: string;
    fileName?: string;
  }
): Promise<ReportsExportResponse> {
  const payload: ReportsPackExportRequest = { ou, columns, ...options };
  return request(REPORTS_CHANNELS.packExport, payload, "Failed to export the budget pack");
}

/** The payroll bridge: a scenario's payroll by position, per department. */
export async function loadPositionBridge(
  ou: string,
  scenarioId: string,
  options: { dept?: string; compareScenarioId?: string } = {}
): Promise<PositionBridgeResponse> {
  const payload: ReportsPositionBridgeRequest = { ou, scenarioId, ...options };
  return request(REPORTS_CHANNELS.positionBridge, payload, "Failed to load the payroll bridge");
}

/** The bridge as .xlsx; main shows the save dialog. */
export async function exportPositionBridge(
  ou: string,
  scenarioId: string,
  options: { dept?: string; hotelName?: string; fileName?: string } = {}
): Promise<ReportsExportResponse> {
  const payload: ReportsPositionBridgeExportRequest = { ou, scenarioId, ...options };
  return request(REPORTS_CHANNELS.positionBridgeExport, payload, "Failed to export the payroll bridge");
}

/** The staffing overview: heads and FTE per department group and title. */
export async function loadStaffingOverview(
  ou: string,
  scenarioId: string,
  options: { compareScenarioId?: string; titleMode?: TitleMode } = {}
): Promise<StaffingOverviewResponse> {
  const payload: ReportsStaffingOverviewRequest = { ou, scenarioId, ...options };
  return request(REPORTS_CHANNELS.staffingOverview, payload, "Failed to load the staffing overview");
}

/** The staffing overview as .xlsx; main shows the save dialog. */
export async function exportStaffingOverview(
  ou: string,
  scenarioId: string,
  options: { compareScenarioId?: string; titleMode?: TitleMode; hotelName?: string; fileName?: string } = {}
): Promise<ReportsExportResponse> {
  const payload: ReportsStaffingOverviewExportRequest = { ou, scenarioId, ...options };
  return request(REPORTS_CHANNELS.staffingOverviewExport, payload, "Failed to export the staffing overview");
}

/** The FTE reconciliation: the Positions grid's FTE beside the account-derived FTE. */
export async function loadFteReconciliation(ou: string, scenarioId: string): Promise<FteReconciliationResponse> {
  const payload: ReportsFteReconciliationRequest = { ou, scenarioId };
  return request(REPORTS_CHANNELS.fteReconciliation, payload, "Failed to load the FTE reconciliation");
}

/** The effective week a scenario would post right now, with its working and what the last run posted. */
export async function loadEffectiveWeek(ou: string, scenarioId: string): Promise<EffectiveWeekResponse> {
  const payload: ReportsEffectiveWeekRequest = { ou, scenarioId };
  return request(REPORTS_CHANNELS.effectiveWeek, payload, "Failed to derive the effective week");
}

/** The FTE reconciliation as .xlsx; main shows the save dialog. */
export async function exportFteReconciliation(
  ou: string,
  scenarioId: string,
  options: { hotelName?: string; fileName?: string } = {}
): Promise<ReportsExportResponse> {
  const payload: ReportsFteReconciliationExportRequest = { ou, scenarioId, ...options };
  return request(REPORTS_CHANNELS.fteReconciliationExport, payload, "Failed to export the FTE reconciliation");
}

/** Evaluate and save as .xlsx; main shows the save dialog. */
export async function exportReport(
  ou: string,
  definitionId: string,
  columns: ReportColumnSpec[],
  options: ColumnRequestOptions & { months: boolean; thousands?: boolean; hotelName?: string; fileName?: string }
): Promise<ReportsExportResponse> {
  const payload: ReportsExportRequest = { ou, definitionId, columns, ...options };
  return request(REPORTS_CHANNELS.export, payload, "Failed to export the report");
}
