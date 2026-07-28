/**
 * Outputs Service
 * Renderer-side driver for the Results page. Main owns the engine run and the
 * persisted output tables; this service relays the selected OU + scenario.
 * Recalculate overwrites the stored run and returns the refreshed read model.
 */

import {
  OutputLineDto,
  OutputLinesResponse,
  OutputsResponse,
  POSITIONS_CHANNELS,
} from "../shared/positions/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/**
 * The individual lines behind one dept×account row — the Results inspector.
 * A pure read of the last run; `month` (0-based) only ranks the result, so the
 * same call serves both a month cell and a whole row.
 */
export async function loadOutputLines(
  ou: string,
  scenarioId: string,
  dept: string,
  account: string,
  month?: number
): Promise<OutputLineDto[]> {
  const response = await ipc().sendIpcRequest(
    POSITIONS_CHANNELS.outputLinesGet,
    { ou, scenarioId, dept, account, month }
  );
  return (response.data as OutputLinesResponse)?.lines ?? [];
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
