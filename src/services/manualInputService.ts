/**
 * Manual Input Service
 * Renderer-side driver for the Manual Input tab. Main owns storage (the encrypted
 * secure store); this service relays the selected OU and the edited row. Every
 * call carries `ou` (the selected hotel) so the OU-gate middleware can scope it.
 * Mutations return the full refreshed list.
 */

import {
  MANUAL_INPUT_CHANNELS,
  ManualInputRow,
  ManualInputRowId,
  ManualInputRowInput,
} from "../shared/manualInput/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** All manual-input rows for a hotel, in sort order. */
export async function listManualRows(ou: string): Promise<ManualInputRow[]> {
  const response = await ipc().sendIpcRequest(MANUAL_INPUT_CHANNELS.list, { ou });
  return (response.data as ManualInputRow[]) ?? [];
}

/** Create or update a row; returns the refreshed list. */
export async function saveManualRow(
  ou: string,
  row: ManualInputRowInput,
  createdBy: string | null
): Promise<ManualInputRow[]> {
  const response = await ipc().sendIpcRequest(MANUAL_INPUT_CHANNELS.save, {
    ou,
    row,
    createdBy,
  });
  return (response.data as ManualInputRow[]) ?? [];
}

/** Soft-delete one or more rows; returns the refreshed list. */
export async function deleteManualRows(
  ou: string,
  ids: ManualInputRowId[]
): Promise<ManualInputRow[]> {
  const response = await ipc().sendIpcRequest(MANUAL_INPUT_CHANNELS.delete, {
    ou,
    ids,
  });
  return (response.data as ManualInputRow[]) ?? [];
}
