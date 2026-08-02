/**
 * Budget Import Service
 * Renderer-side driver for pulling a hotel's Excel budget file into the local
 * store. Main owns the file dialog, parse, OU-gate, and storage; this service
 * only relays the selected OU and reads results back. Every call carries `ou`
 * (the selected hotel) so the OU-gate middleware can scope it.
 */

import {
  BUDGET_IMPORT_CHANNELS,
  BudgetDepartmentOption,
  ImportRowsResult,
  PullResult,
} from "../shared/budgetImport/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/**
 * Open a file dialog, parse + OU-gate the workbook, and (on a match) persist it
 * — overwriting the hotel's previous data — returning the stored rows. One
 * round-trip: there is no separate preview/commit step.
 */
export async function pullBudgetFile(
  ou: string,
  importedBy: string | null
): Promise<PullResult> {
  const response = await ipc().sendIpcRequest(BUDGET_IMPORT_CHANNELS.pull, {
    ou,
    importedBy,
  });
  return response.data as PullResult;
}

/** The current stored import (metadata + rows) for a hotel, or null. */
export async function getCurrentBudgetImport(
  ou: string
): Promise<ImportRowsResult | null> {
  const response = await ipc().sendIpcRequest(
    BUDGET_IMPORT_CHANNELS.getCurrent,
    { ou }
  );
  return (response.data as ImportRowsResult | null) ?? null;
}

/**
 * The departments this hotel's budget file carries, named and sorted for a
 * picker. Empty when the hotel has never pulled — deliberately NOT falling back
 * to the mapping tables, whose company-wide list runs to 200-plus departments
 * and says nothing about which ones this hotel operates.
 */
export async function loadBudgetDepartments(
  ou: string
): Promise<BudgetDepartmentOption[]> {
  const response = await ipc().sendIpcRequest(
    BUDGET_IMPORT_CHANNELS.listDepartments,
    { ou }
  );
  return (response.data as BudgetDepartmentOption[]) ?? [];
}
