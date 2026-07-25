/**
 * Social Security / NI service.
 * Renderer-side driver for the SS/NI scheme configurator. Main owns storage +
 * validation; this relays the selected OU and the edited scheme. Every call
 * carries `ou` so the OU-gate middleware can scope it. Mutations return the
 * refreshed scheme list.
 */

import {
  RecomputeOpeningsResponse,
  SOCIAL_SECURITY_CHANNELS,
  SsSchemeInput,
  SsSchemesListResponse,
} from "../shared/socialSecurity/ipc";

const EMPTY: SsSchemesListResponse = { schemes: [] };

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** All non-deleted schemes (with brackets) for a hotel. */
export async function listSsSchemes(ou: string): Promise<SsSchemesListResponse> {
  const response = await ipc().sendIpcRequest(SOCIAL_SECURITY_CHANNELS.list, { ou });
  return (response.data as SsSchemesListResponse) ?? EMPTY;
}

/** Create or update a scheme; returns the refreshed list. */
export async function saveSsScheme(
  ou: string,
  scheme: SsSchemeInput
): Promise<SsSchemesListResponse> {
  const response = await ipc().sendIpcRequest(SOCIAL_SECURITY_CHANNELS.save, {
    ou,
    scheme,
  });
  return (response.data as SsSchemesListResponse) ?? EMPTY;
}

/** Soft-delete a scheme; returns the refreshed list. */
export async function deleteSsScheme(
  ou: string,
  id: string
): Promise<SsSchemesListResponse> {
  const response = await ipc().sendIpcRequest(SOCIAL_SECURITY_CHANNELS.delete, {
    ou,
    id,
  });
  return (response.data as SsSchemesListResponse) ?? EMPTY;
}

/** Recompute + persist one scheme's NI opening balances for a scenario (the
 *  pre-sim). Scoped to the scheme being edited so other schemes' overrides are
 *  left untouched. */
export async function recomputeNiOpenings(
  ou: string,
  scenarioId: string,
  ssSchemeId: string
): Promise<RecomputeOpeningsResponse> {
  const response = await ipc().sendIpcRequest(
    SOCIAL_SECURITY_CHANNELS.recomputeOpenings,
    { ou, scenarioId, ssSchemeId }
  );
  return (response.data as RecomputeOpeningsResponse) ?? { updated: 0 };
}
