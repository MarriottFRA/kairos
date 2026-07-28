/**
 * Maintenance Service
 * Renderer-side driver for the storage cleanup in Settings. Main owns both
 * database handles and all the delete logic; this only asks for a preview or
 * commits the purge.
 */

import {
  AutoCleanupConfig,
  CleanupPurgeResponse,
  CleanupScanResponse,
  MAINTENANCE_CHANNELS,
} from "../shared/maintenance/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Exact preview of what a cleanup would remove. Writes nothing. */
export async function scanDeletedData(): Promise<CleanupScanResponse> {
  const response = await ipc().sendIpcRequest(MAINTENANCE_CHANNELS.scanDeleted);
  return response.data as CleanupScanResponse;
}

/** Permanently remove every soft-deleted row, then VACUUM. Irreversible. */
export async function purgeDeletedData(): Promise<CleanupPurgeResponse> {
  const response = await ipc().sendIpcRequest(MAINTENANCE_CHANNELS.purgeDeleted);
  return response.data as CleanupPurgeResponse;
}

/**
 * Set how long deleted rows are kept before the automatic sweep takes them
 * (0 = never). Takes effect from the next sweep; it does not purge anything now.
 */
export async function setAutoCleanupRetention(
  retentionDays: number
): Promise<AutoCleanupConfig> {
  const response = await ipc().sendIpcRequest(
    MAINTENANCE_CHANNELS.setAutoCleanup,
    { retentionDays }
  );
  return response.data as AutoCleanupConfig;
}
