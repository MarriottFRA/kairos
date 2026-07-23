/**
 * Scenario Service
 * Renderer-side access to budget scenarios (OU + year + label), stored in the
 * plaintext structure DB. Follows the calendarService envelope pattern.
 */

import {
  POSITIONS_CHANNELS,
  ScenarioCloneResponse,
  ScenarioDto,
} from "../shared/positions/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** List this hotel's scenarios. Passing a year guarantees that year's default
 *  "Planning" scenario exists before the list comes back. */
export async function listScenarios(ou: string, year?: number): Promise<ScenarioDto[]> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.scenarioList, {
    ou,
    year,
  });
  return (response.data as ScenarioDto[]) ?? [];
}

export async function saveScenario(
  ou: string,
  scenario: { id?: string; year: number; label: string }
): Promise<ScenarioDto> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.scenarioSave, {
    ou,
    scenario,
  });
  return response.data as ScenarioDto;
}

export async function deleteScenario(ou: string, scenarioId: string): Promise<void> {
  await ipc().sendIpcRequest(POSITIONS_CHANNELS.scenarioDelete, { ou, scenarioId });
}

/**
 * Copy every position (plus PII, component values and buyouts) from one
 * scenario into another — the "next year came around" roll-forward. The target
 * must be empty; the failure is surfaced rather than swallowed because the user
 * picked the target and needs to know it was rejected.
 */
export async function cloneScenario(
  ou: string,
  sourceScenarioId: string,
  targetScenarioId: string
): Promise<ScenarioCloneResponse> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.scenarioClone, {
    ou,
    sourceScenarioId,
    targetScenarioId,
  });
  if (!response?.success) {
    throw new Error(response?.error ?? "Failed to copy the scenario");
  }
  return response.data as ScenarioCloneResponse;
}
