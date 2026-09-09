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
  ImportSummary,
  PullResult,
  RecentBudgetFile,
} from "../shared/budgetImport/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/**
 * Parse + OU-gate a workbook and (on a match) persist it — overwriting the
 * hotel's previous data — returning the stored rows. One round-trip: there is
 * no separate preview/commit step.
 *
 * With no `filePath` main opens the file dialog; with one it pulls that file
 * directly, which is all "pull the file I used last time" is. Same call, same
 * parse, same OU gate either way.
 */
export async function pullBudgetFile(
  ou: string,
  importedBy: string | null,
  filePath?: string
): Promise<PullResult> {
  const response = await ipc().sendIpcRequest(BUDGET_IMPORT_CHANNELS.pull, {
    ou,
    importedBy,
    ...(filePath ? { filePath } : {}),
  });
  return response.data as PullResult;
}

/**
 * The workbook this hotel was last pulled from, or null.
 *
 * Only ever a file that already cleared the OU gate, so offering it back cannot
 * hand the user a click that fails.
 */
export async function getRecentBudgetFile(
  ou: string
): Promise<RecentBudgetFile | null> {
  const response = await ipc().sendIpcRequest(
    BUDGET_IMPORT_CHANNELS.recentFile,
    { ou }
  );
  return (response.data as RecentBudgetFile | null) ?? null;
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
 * The current stored import's metadata only, or null if this hotel has never
 * pulled. Use this — not `getCurrentBudgetImport` — when the question is merely
 * whether a local BST exists; the rows are the expensive part of that answer.
 */
export async function getBudgetImportSummary(
  ou: string
): Promise<ImportSummary | null> {
  const response = await ipc().sendIpcRequest(
    BUDGET_IMPORT_CHANNELS.getSummary,
    { ou }
  );
  return (response.data as ImportSummary | null) ?? null;
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
