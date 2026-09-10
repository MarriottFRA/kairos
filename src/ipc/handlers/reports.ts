/**
 * Reports IPC handlers.
 *
 * Evaluate a built-in report definition for the selected hotel — under one
 * scenario, or under a column set — list the definitions, serve the
 * drill-down, and export a workbook. Every channel is OU-gated
 * (ouScopeMiddleware in ipc/index.ts) and re-brands the OU here via
 * resolveOuScope. A locked encrypted store maps to the SECURE_DB_LOCKED
 * sentinel, as on the Results page, so the renderer can prompt for re-auth.
 *
 * The clear-rule prefixes the plan overlay applies are read from the SAVED
 * push configuration here, never taken from the request: a report can no
 * more apply unsaved rules than a push can.
 */

import { dialog } from "electron";
import * as path from "path";
import { IpcHandler, IpcResult } from "../types";
import { getCalendarYear, getPositionDefaults, localDbHandle } from "../../local_db";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import { readBstPushConfig } from "../../main/bstPush/config";
import {
  EvaluateColumnsOptions,
  evaluateReportColumns,
  evaluateReportForScenario,
  getReportDefinitionDetail,
  listAtomCombos,
  listReportDefinitionSummaries,
} from "../../main/reports/evaluate";
import {
  buildReportWorkbook,
  includesUnpushedPlan,
  suggestedFileName,
} from "../../main/reports/excel/workbook";
import { isSeriesColumn, normalizeColumns } from "../../shared/reports/columns";
import { isParamValue } from "../../shared/reports/compile";
import { findReportDefinition } from "../../shared/reports/definitions";
import {
  REPORTS_CHANNELS,
  ReportsAtomCombosRequest,
  ReportsEvaluateColumnsRequest,
  ReportsEvaluateRequest,
  ReportsExportRequest,
  ReportsExportResponse,
  ReportsEffectiveWeekRequest,
  ReportsFteReconciliationExportRequest,
  ReportsFteReconciliationRequest,
  ReportsGetDefinitionRequest,
  ReportsPackEvaluateRequest,
  ReportsPackExportRequest,
  ReportsPackPagesRequest,
  ReportsPositionBridgeExportRequest,
  ReportsPositionBridgeRequest,
  ReportsStaffingOverviewExportRequest,
  ReportsStaffingOverviewRequest,
  ReportsStaffingStatisticsExportRequest,
  ReportsStaffingStatisticsRequest,
} from "../../shared/reports/ipc";
import { readPositionBridge } from "../../main/positions/positionBridge";
import { readStaffingOverview } from "../../main/positions/staffingOverview";
import { readStaffingStatistics } from "../../main/positions/staffingStatistics";
import { buildStaffingStatisticsWorkbook } from "../../main/reports/staffingStatisticsExport";
import { readFteReconciliation } from "../../main/positions/fteReconciliation";
import { readEffectiveWeek } from "../../main/positions/effectiveWeek";
import { buildBridgeWorkbook } from "../../main/reports/bridgeExport";
import { BRIDGE_DEPTHS, DEFAULT_BRIDGE_DEPTH } from "../../shared/reports/bridgeMatrix";
import { buildStaffingOverviewWorkbook } from "../../main/reports/staffingOverviewExport";
import { buildFteReconciliationWorkbook } from "../../main/reports/fteReconciliationExport";
import {
  buildPackWorkbook,
  evaluatePackPage,
  listPackAtomCombos,
  listPackPages,
} from "../../main/reports/packs";
import type { ParamValue } from "../../shared/reports/types";
import { SUMMARY_REPORTING_PAGE_ID } from "../../shared/reports/packs";
import { SECURE_DB_LOCKED } from "../../shared/positions/ipc";
import { prepared } from "../../main/positions/stmtCache";

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

/** Param overrides as sent: keep only well-formed values under string keys. */
function normalizeParams(raw: unknown): Record<string, ParamValue> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isParamValue(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Hotel OUs are stored both branded ("OU12345") and bare by different writers;
// read either, as the positions handlers do.
const getCalendarEitherForm = async (ou: string, year: number) =>
  (await getCalendarYear(ou, year)) ?? (await getCalendarYear(ou.replace(/^OU/, ""), year));
const getDefaultsEitherForm = async (ou: string, year: number) =>
  (await getPositionDefaults(ou, year)) ??
  (await getPositionDefaults(ou.replace(/^OU/, ""), year));

async function columnOptions(
  request: Pick<ReportsEvaluateColumnsRequest, "bst" | "params">
): Promise<EvaluateColumnsOptions> {
  const { clearPrefixes } = await readBstPushConfig();
  return {
    bst: request?.bst,
    clearPrefixes,
    params: normalizeParams(request?.params),
    deps: { getCalendar: getCalendarEitherForm, getPositionDefaults: getDefaultsEitherForm },
  };
}

const dbs = () => ({ localDb: localDbHandle(), secureDb: secureDb() });

/** The staffing overview derives FTE the way the engine run does, from the
 *  same calendar and hotel-year defaults. */
const staffingDeps = { getCalendar: getCalendarEitherForm, getPositionDefaults: getDefaultsEitherForm };

function staffingOptions(request: ReportsStaffingOverviewRequest | undefined) {
  return {
    compareScenarioId:
      typeof request?.compareScenarioId === "string" && request.compareScenarioId.trim()
        ? request.compareScenarioId.trim()
        : undefined,
    titleMode: request?.titleMode === "standard" ? ("standard" as const) : ("title" as const),
    basis: request?.basis === "positions" ? ("positions" as const) : ("accounts" as const),
  };
}

/** "Planning 2027" for the first scenario the columns name; "" when none. */
function scenarioLabelFor(ou: string, columns: ReportsExportRequest["columns"]): string {
  const first = columns.find(isSeriesColumn);
  const scenarioId = !first
    ? null
    : first.series.kind === "bst"
      ? first.series.relativeTo ?? null
      : first.series.scenarioId;
  if (!scenarioId) return "";
  const row = prepared(
    localDbHandle(),
    `SELECT label, year FROM scenarios WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(scenarioId, ou) as { label: string; year: number } | undefined;
  return row ? `${row.label} ${row.year}` : "";
}

export function createReportsHandlers(): Record<string, IpcHandler> {
  return {
    [REPORTS_CHANNELS.evaluate]: async (_event, request: ReportsEvaluateRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const definitionId = requireString(request?.definitionId, "definitionId");
        return ok(evaluateReportForScenario(dbs(), scope, scenarioId, definitionId, { bst: request?.bst }));
      } catch (error) {
        console.error("Failed to evaluate report:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.evaluateColumns]: async (_event, request: ReportsEvaluateColumnsRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const definitionId = requireString(request?.definitionId, "definitionId");
        const columns = normalizeColumns(request?.columns);
        return ok(await evaluateReportColumns(dbs(), scope, definitionId, columns, await columnOptions(request)));
      } catch (error) {
        console.error("Failed to evaluate report columns:", error);
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

    [REPORTS_CHANNELS.getDefinition]: async (_event, request: ReportsGetDefinitionRequest) => {
      try {
        resolveOuScope(request?.ou);
        return ok(getReportDefinitionDetail(requireString(request?.definitionId, "definitionId")));
      } catch (error) {
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.atomCombos]: async (_event, request: ReportsAtomCombosRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const definitionId = request?.pack ? "" : requireString(request?.definitionId, "definitionId");
        const atomId = requireString(request?.atomId, "atomId");
        const [column] = normalizeColumns([request?.column]);
        if (!isSeriesColumn(column)) throw new Error("The drill-down needs a series column.");
        if (request?.pack) {
          const pageId = requireString(request.pack.pageId, "pageId");
          const columns = normalizeColumns(request.pack.columns);
          return ok(await listPackAtomCombos(dbs(), scope, pageId, atomId, column, columns, await columnOptions(request)));
        }
        return ok(await listAtomCombos(dbs(), scope, definitionId, atomId, column, await columnOptions(request)));
      } catch (error) {
        console.error("Failed to resolve atom combos:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.packPages]: async (_event, request: ReportsPackPagesRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const columns = normalizeColumns(request?.columns);
        return ok(await listPackPages(dbs(), scope, columns, await columnOptions(request)));
      } catch (error) {
        console.error("Failed to list pack pages:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.packEvaluate]: async (_event, request: ReportsPackEvaluateRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const pageId = requireString(request?.pageId, "pageId");
        const columns = normalizeColumns(request?.columns);
        return ok(await evaluatePackPage(dbs(), scope, pageId, columns, await columnOptions(request)));
      } catch (error) {
        console.error("Failed to evaluate pack page:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.packExport]: async (_event, request: ReportsPackExportRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const columns = normalizeColumns(request?.columns);
        const pageId = typeof request?.pageId === "string" && request.pageId.trim() ? request.pageId.trim() : undefined;
        const meta = {
          reportName: pageId === SUMMARY_REPORTING_PAGE_ID ? "Summary reporting" : pageId ? `Budget pack ${pageId}` : "Budget pack",
          hotelName: typeof request?.hotelName === "string" && request.hotelName.trim() ? request.hotelName.trim() : scope.ou,
          scenarioLabel: scenarioLabelFor(scope.ou, columns),
          generatedAt: new Date(),
          months: request?.months !== false,
          thousands: request?.thousands === true,
        };
        const unpushed = includesUnpushedPlan(columns);
        const defaultName =
          typeof request?.fileName === "string" && request.fileName.trim()
            ? `${request.fileName.trim()}${unpushed ? "_UNPUSHED" : ""}.xlsx`
            : suggestedFileName(meta, unpushed);
        const picked = await dialog.showSaveDialog({
          title: pageId ? "Save the report as an Excel workbook" : "Save the budget pack as an Excel workbook",
          defaultPath: defaultName,
          filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
        });
        if (picked.canceled || !picked.filePath) return ok<ReportsExportResponse>({ outcome: "cancelled" });
        const target = picked.filePath.toLowerCase().endsWith(".xlsx") ? picked.filePath : `${picked.filePath}.xlsx`;
        const wb = await buildPackWorkbook(
          dbs(),
          scope,
          columns,
          await columnOptions(request),
          meta,
          request?.includeDepartments !== false,
          pageId
        );
        await wb.xlsx.writeFile(target);
        return ok<ReportsExportResponse>({ outcome: "saved", path: path.resolve(target), sheets: wb.worksheets.length });
      } catch (error) {
        console.error("Failed to export the budget pack:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.positionBridge]: async (_event, request: ReportsPositionBridgeRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        return ok(
          readPositionBridge(dbs(), scope, scenarioId, {
            dept: typeof request?.dept === "string" && request.dept.trim() ? request.dept.trim() : undefined,
            compareScenarioId:
              typeof request?.compareScenarioId === "string" && request.compareScenarioId.trim()
                ? request.compareScenarioId.trim()
                : undefined,
          })
        );
      } catch (error) {
        console.error("Failed to read the payroll bridge:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.positionBridgeExport]: async (_event, request: ReportsPositionBridgeExportRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const response = readPositionBridge(dbs(), scope, scenarioId, {
          dept: typeof request?.dept === "string" && request.dept.trim() ? request.dept.trim() : undefined,
        });
        const scenarioLabel = scenarioLabelFor(scope.ou, [{ id: "s", series: { kind: "kairos", scenarioId } }]);
        const meta = {
          reportName: "Payroll bridge",
          hotelName: typeof request?.hotelName === "string" && request.hotelName.trim() ? request.hotelName.trim() : scope.ou,
          scenarioLabel,
          generatedAt: new Date(),
          months: false,
        };
        const defaultName =
          typeof request?.fileName === "string" && request.fileName.trim()
            ? `${request.fileName.trim()}.xlsx`
            : suggestedFileName(meta, false);
        const picked = await dialog.showSaveDialog({
          title: "Save the payroll bridge as an Excel workbook",
          defaultPath: defaultName,
          filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
        });
        if (picked.canceled || !picked.filePath) return ok<ReportsExportResponse>({ outcome: "cancelled" });
        const target = picked.filePath.toLowerCase().endsWith(".xlsx") ? picked.filePath : `${picked.filePath}.xlsx`;
        const depth = BRIDGE_DEPTHS.includes(Number(request?.depth)) ? Number(request?.depth) : DEFAULT_BRIDGE_DEPTH;
        const wb = buildBridgeWorkbook(response, { ...meta, depth });
        await wb.xlsx.writeFile(target);
        return ok<ReportsExportResponse>({ outcome: "saved", path: path.resolve(target), sheets: wb.worksheets.length });
      } catch (error) {
        console.error("Failed to export the payroll bridge:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.staffingOverview]: async (_event, request: ReportsStaffingOverviewRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const { clearPrefixes } = await readBstPushConfig();
        return ok(await readStaffingOverview(dbs(), scope, scenarioId, staffingOptions(request), { ...staffingDeps, clearPrefixes }));
      } catch (error) {
        console.error("Failed to read the staffing overview:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.staffingOverviewExport]: async (_event, request: ReportsStaffingOverviewExportRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const options = staffingOptions(request);
        const { clearPrefixes } = await readBstPushConfig();
        const response = await readStaffingOverview(dbs(), scope, scenarioId, options, { ...staffingDeps, clearPrefixes });
        const labelOf = (id: string) => scenarioLabelFor(scope.ou, [{ id: "s", series: { kind: "kairos", scenarioId: id } }]);
        const meta = {
          reportName: "Staffing overview",
          hotelName: typeof request?.hotelName === "string" && request.hotelName.trim() ? request.hotelName.trim() : scope.ou,
          scenarioLabel: labelOf(scenarioId),
          compareLabel: options.compareScenarioId ? labelOf(options.compareScenarioId) : null,
          generatedAt: new Date(),
          months: false,
        };
        const defaultName =
          typeof request?.fileName === "string" && request.fileName.trim()
            ? `${request.fileName.trim()}.xlsx`
            : suggestedFileName(meta, false);
        const picked = await dialog.showSaveDialog({
          title: "Save the staffing overview as an Excel workbook",
          defaultPath: defaultName,
          filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
        });
        if (picked.canceled || !picked.filePath) return ok<ReportsExportResponse>({ outcome: "cancelled" });
        const target = picked.filePath.toLowerCase().endsWith(".xlsx") ? picked.filePath : `${picked.filePath}.xlsx`;
        const wb = buildStaffingOverviewWorkbook(response, meta);
        await wb.xlsx.writeFile(target);
        return ok<ReportsExportResponse>({ outcome: "saved", path: path.resolve(target), sheets: wb.worksheets.length });
      } catch (error) {
        console.error("Failed to export the staffing overview:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.staffingStatistics]: async (_event, request: ReportsStaffingStatisticsRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const { clearPrefixes } = await readBstPushConfig();
        return ok(await readStaffingStatistics(dbs(), scope, scenarioId, { ...staffingDeps, clearPrefixes }));
      } catch (error) {
        console.error("Failed to read the staffing statistics:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.staffingStatisticsExport]: async (_event, request: ReportsStaffingStatisticsExportRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const { clearPrefixes } = await readBstPushConfig();
        const response = await readStaffingStatistics(dbs(), scope, scenarioId, { ...staffingDeps, clearPrefixes });
        const slot = Number.isInteger(request?.slot) && request.slot! >= 0 && request.slot! <= 12 ? request.slot! : 12;
        const meta = {
          reportName: "Staffing statistics",
          hotelName: typeof request?.hotelName === "string" && request.hotelName.trim() ? request.hotelName.trim() : scope.ou,
          scenarioLabel: scenarioLabelFor(scope.ou, [{ id: "s", series: { kind: "kairos", scenarioId } }]),
          generatedAt: new Date(),
          months: false,
          slot,
        };
        const defaultName =
          typeof request?.fileName === "string" && request.fileName.trim()
            ? `${request.fileName.trim()}.xlsx`
            : suggestedFileName(meta, false);
        const picked = await dialog.showSaveDialog({
          title: "Save the staffing statistics as an Excel workbook",
          defaultPath: defaultName,
          filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
        });
        if (picked.canceled || !picked.filePath) return ok<ReportsExportResponse>({ outcome: "cancelled" });
        const target = picked.filePath.toLowerCase().endsWith(".xlsx") ? picked.filePath : `${picked.filePath}.xlsx`;
        const wb = buildStaffingStatisticsWorkbook(response, meta);
        await wb.xlsx.writeFile(target);
        return ok<ReportsExportResponse>({ outcome: "saved", path: path.resolve(target), sheets: wb.worksheets.length });
      } catch (error) {
        console.error("Failed to export the staffing statistics:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.fteReconciliation]: async (_event, request: ReportsFteReconciliationRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const { clearPrefixes } = await readBstPushConfig();
        return ok(await readFteReconciliation(dbs(), scope, scenarioId, { ...staffingDeps, clearPrefixes }));
      } catch (error) {
        console.error("Failed to read the FTE reconciliation:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.effectiveWeek]: async (_event, request: ReportsEffectiveWeekRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        return ok(await readEffectiveWeek(dbs(), scope, scenarioId, staffingDeps));
      } catch (error) {
        console.error("Failed to derive the effective week:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.fteReconciliationExport]: async (_event, request: ReportsFteReconciliationExportRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const scenarioId = requireString(request?.scenarioId, "scenarioId");
        const { clearPrefixes } = await readBstPushConfig();
        const response = await readFteReconciliation(dbs(), scope, scenarioId, { ...staffingDeps, clearPrefixes });
        const meta = {
          reportName: "FTE reconciliation",
          hotelName: typeof request?.hotelName === "string" && request.hotelName.trim() ? request.hotelName.trim() : scope.ou,
          scenarioLabel: scenarioLabelFor(scope.ou, [{ id: "s", series: { kind: "kairos", scenarioId } }]),
          generatedAt: new Date(),
          months: false,
        };
        const defaultName =
          typeof request?.fileName === "string" && request.fileName.trim()
            ? `${request.fileName.trim()}.xlsx`
            : suggestedFileName(meta, false);
        const picked = await dialog.showSaveDialog({
          title: "Save the FTE reconciliation as an Excel workbook",
          defaultPath: defaultName,
          filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
        });
        if (picked.canceled || !picked.filePath) return ok<ReportsExportResponse>({ outcome: "cancelled" });
        const target = picked.filePath.toLowerCase().endsWith(".xlsx") ? picked.filePath : `${picked.filePath}.xlsx`;
        const wb = buildFteReconciliationWorkbook(response, meta);
        await wb.xlsx.writeFile(target);
        return ok<ReportsExportResponse>({ outcome: "saved", path: path.resolve(target), sheets: wb.worksheets.length });
      } catch (error) {
        console.error("Failed to export the FTE reconciliation:", error);
        return fail(error, null);
      }
    },

    [REPORTS_CHANNELS.export]: async (_event, request: ReportsExportRequest) => {
      try {
        const scope = resolveOuScope(request?.ou);
        const definitionId = requireString(request?.definitionId, "definitionId");
        const columns = normalizeColumns(request?.columns);
        const compiled = findReportDefinition(definitionId);
        if (!compiled) throw new Error(`Unknown report "${definitionId}".`);

        const response = await evaluateReportColumns(dbs(), scope, definitionId, columns, await columnOptions(request));
        const meta = {
          reportName: compiled.definition.name,
          hotelName: typeof request?.hotelName === "string" && request.hotelName.trim() ? request.hotelName.trim() : scope.ou,
          scenarioLabel: scenarioLabelFor(scope.ou, columns),
          generatedAt: new Date(),
          months: request?.months !== false,
          thousands: request?.thousands === true,
        };
        const unpushed = includesUnpushedPlan(columns);
        const defaultName =
          typeof request?.fileName === "string" && request.fileName.trim()
            ? `${request.fileName.trim()}${unpushed ? "_UNPUSHED" : ""}.xlsx`
            : suggestedFileName(meta, unpushed);

        const picked = await dialog.showSaveDialog({
          title: "Save the report as an Excel workbook",
          defaultPath: defaultName,
          filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
        });
        if (picked.canceled || !picked.filePath) return ok<ReportsExportResponse>({ outcome: "cancelled" });

        const target = picked.filePath.toLowerCase().endsWith(".xlsx") ? picked.filePath : `${picked.filePath}.xlsx`;
        const wb = buildReportWorkbook(response, meta);
        await wb.xlsx.writeFile(target);
        return ok<ReportsExportResponse>({ outcome: "saved", path: path.resolve(target), sheets: wb.worksheets.length });
      } catch (error) {
        console.error("Failed to export report:", error);
        return fail(error, null);
      }
    },
  };
}
