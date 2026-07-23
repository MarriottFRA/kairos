/**
 * Mapping Tables Service
 * Renderer-side driver for the cached reference tables (account maps, department
 * maps, account/department combos). Main owns the fetch + storage; this service
 * only kicks off a version-gated sync, forces a rebuild, or reads status.
 */

import {
  AccountOption,
  DepartmentOption,
  MAPPING_TABLES_CHANNELS,
  MappingSyncResult,
  MappingTablesStatus,
} from "../shared/mappingTables/types";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Version-gated sync: pulls the bulk payloads only if the server version moved. */
export async function syncMappingTables(): Promise<MappingSyncResult> {
  const response = await ipc().sendIpcRequest(MAPPING_TABLES_CHANNELS.sync);
  return response.data as MappingSyncResult;
}

/** Clear the local cache and force a full re-download of all three tables. */
export async function rebuildMappingTables(): Promise<MappingSyncResult> {
  const response = await ipc().sendIpcRequest(MAPPING_TABLES_CHANNELS.rebuild);
  return response.data as MappingSyncResult;
}

/** Read local cache metadata + row counts (no network). */
export async function getMappingTablesStatus(): Promise<MappingTablesStatus> {
  const response = await ipc().sendIpcRequest(MAPPING_TABLES_CHANNELS.status);
  return response.data as MappingTablesStatus;
}

/**
 * Department options (code + name) for the positions dropdown, read from the
 * local cache. Returns [] when the mapping tables have never been synced — the
 * grid degrades that field to free text rather than blocking.
 */
export async function loadDepartments(): Promise<DepartmentOption[]> {
  const response = await ipc().sendIpcRequest(
    MAPPING_TABLES_CHANNELS.listDepartments
  );
  return (response.data as DepartmentOption[]) ?? [];
}

/**
 * Account options (code + description) for the account dropdowns, read from the
 * local cache. Returns the whole account_maps table — each account field
 * narrows it to its own subset (A9…, A5…) in the renderer. Returns [] when the
 * mapping tables have never been synced — the grid degrades account fields to
 * free text rather than blocking.
 */
export async function loadAccounts(): Promise<AccountOption[]> {
  const response = await ipc().sendIpcRequest(
    MAPPING_TABLES_CHANNELS.listAccounts
  );
  return (response.data as AccountOption[]) ?? [];
}
