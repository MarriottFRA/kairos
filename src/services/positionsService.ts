/**
 * Positions Service
 * Renderer-side access to position rows in the encrypted store. PII travels
 * only over its dedicated channel; the load channel never returns it.
 */

import {
  PiiRecord,
  POSITIONS_CHANNELS,
  PositionsBatchWriteRequest,
  PositionsBatchWriteResponse,
  PositionsLoadResponse,
} from "../shared/positions/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

export async function loadPositions(
  ou: string,
  scenarioId: string
): Promise<PositionsLoadResponse> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.load, {
    ou,
    scenarioId,
  });
  return response.data as PositionsLoadResponse;
}

export async function loadPii(
  ou: string,
  scenarioId: string
): Promise<Record<string, PiiRecord>> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.piiGet, {
    ou,
    scenarioId,
  });
  return (response.data as Record<string, PiiRecord>) ?? {};
}

export async function batchWrite(
  request: PositionsBatchWriteRequest
): Promise<PositionsBatchWriteResponse> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.batchWrite, request);
  return response.data as PositionsBatchWriteResponse;
}
