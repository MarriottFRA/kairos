/**
 * Hotel-copy service — renderer-side access to the copy-hotel-setup channels.
 *
 * `listCopySources` returns the hotels whose setup exists in the LOCAL store;
 * the caller intersects it with the user's own hotel list before showing
 * anything, so only properties the user can see are ever offered. The copy
 * itself throws on refusal (target already has blocks, invalid source) so the
 * dialog can show the backend's reason — the cloneScenario pattern.
 */

import {
  HOTEL_COPY_CHANNELS,
  HotelCopySetupResponse,
  HotelCopySourceDto,
  HotelCopySourcesResponse,
} from "../shared/hotelCopy/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Hotels (other than `ou`) with blocks in the local store. */
export async function listCopySources(ou: string): Promise<HotelCopySourceDto[]> {
  const response = await ipc().sendIpcRequest(HOTEL_COPY_CHANNELS.listSources, { ou });
  return (response.data as HotelCopySourcesResponse | undefined)?.sources ?? [];
}

/**
 * Copy `sourceOu`'s whole setup (blocks, NI/SS schemes, KPI drivers,
 * allocations, columns, calendar, position defaults) into `ou`, which must
 * have no blocks yet. Positions are not copied.
 */
export async function copyHotelSetup(
  ou: string,
  sourceOu: string
): Promise<HotelCopySetupResponse> {
  const response = await ipc().sendIpcRequest(HOTEL_COPY_CHANNELS.copySetup, {
    ou,
    sourceOu,
  });
  if (!response?.success) {
    throw new Error(response?.error ?? "Failed to copy the hotel's setup");
  }
  return response.data as HotelCopySetupResponse;
}
