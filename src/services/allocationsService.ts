/**
 * Allocations Service
 * Renderer-side driver for the Allocations page. Main owns storage + the spread
 * computation; this relays the selected OU + scenario and the edited definition.
 * Every call carries `ou` (OU-gate middleware) and `scenarioId` (the grid is
 * computed from that scenario's active positions).
 *
 * THROWS on a failed envelope so the dialog can surface validation text and the
 * page can surface a locked-store message, rather than silently swallowing it.
 */

import {
  ALLOCATIONS_CHANNELS,
  AllocationInput,
  AllocationsViewResponse,
} from "../shared/allocations/ipc";

const EMPTY: AllocationsViewResponse = { allocations: [], departments: [] };

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

function unwrap(response: {
  success?: boolean;
  error?: string;
  data?: AllocationsViewResponse;
}): AllocationsViewResponse {
  if (response?.success === false) {
    throw new Error(response.error || "Unknown error");
  }
  return response.data ?? EMPTY;
}

/** Definitions + the computed department spread grid for a scenario. */
export async function listAllocations(
  ou: string,
  scenarioId: string
): Promise<AllocationsViewResponse> {
  const response = await ipc().sendIpcRequest(ALLOCATIONS_CHANNELS.list, {
    ou,
    scenarioId,
  });
  return unwrap(response);
}

/** Create or update an allocation; returns the refreshed view. */
export async function saveAllocation(
  ou: string,
  scenarioId: string,
  allocation: AllocationInput
): Promise<AllocationsViewResponse> {
  const response = await ipc().sendIpcRequest(ALLOCATIONS_CHANNELS.save, {
    ou,
    scenarioId,
    allocation,
  });
  return unwrap(response);
}

/** Soft-delete an allocation; returns the refreshed view. */
export async function deleteAllocation(
  ou: string,
  scenarioId: string,
  allocationId: string
): Promise<AllocationsViewResponse> {
  const response = await ipc().sendIpcRequest(ALLOCATIONS_CHANNELS.delete, {
    ou,
    scenarioId,
    allocationId,
  });
  return unwrap(response);
}
