/**
 * Outputs Service
 * Renderer-side driver for the Results page. Main owns the engine run and the
 * persisted output tables; this service relays the selected OU + scenario.
 * Recalculate overwrites the stored run and returns the refreshed read model.
 */

import { OutputsResponse, POSITIONS_CHANNELS } from "../shared/positions/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** The stored outputs + staleness for (hotel, scenario). */
export async function loadOutputs(
  ou: string,
  scenarioId: string
): Promise<OutputsResponse> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.outputsGet, {
    ou,
    scenarioId,
  });
  return (response.data as OutputsResponse) ?? { run: null, stale: false, rows: [] };
}

/** Run the engine over the persisted scenario; overwrites the stored outputs. */
export async function recalcOutputs(
  ou: string,
  scenarioId: string
): Promise<OutputsResponse> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.recalc, {
    ou,
    scenarioId,
  });
  return (response.data as OutputsResponse) ?? { run: null, stale: false, rows: [] };
}
