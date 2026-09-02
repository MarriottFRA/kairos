/**
 * Copy-hotel-setup IPC handlers.
 *
 * Two channels: list the hotels the current one could copy its setup from
 * (any OTHER OU with live blocks in the local store), and run the copy itself
 * (see src/main/hotelCopy/copySetup.ts). Both are registered with the OU gate,
 * which validates the TARGET — the currently selected hotel in `request.ou`.
 * The source OU is re-branded explicitly here, the same discipline the
 * cluster channels follow for their second scope.
 */

import { IpcHandler, IpcResult } from "../types";
import { localDbHandle } from "../../local_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import {
  copyHotelSetup,
  listLocalSetupSources,
} from "../../main/hotelCopy/copySetup";
import {
  HOTEL_COPY_CHANNELS,
  HotelCopySetupResponse,
  HotelCopySourcesResponse,
} from "../../shared/hotelCopy/ipc";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

const NO_SOURCES: HotelCopySourcesResponse = { sources: [] };
const NOTHING_COPIED: HotelCopySetupResponse = {
  blocks: 0,
  ssSchemes: 0,
  kpiDrivers: 0,
  allocations: 0,
  customFields: 0,
  calendarYears: 0,
};

export function createHotelCopyHandlers(): Record<string, IpcHandler> {
  /** Hotels with local blocks the selected hotel could copy from. */
  const listSources: IpcHandler<any, IpcResult<HotelCopySourcesResponse>> = async (
    _event,
    request
  ) => {
    try {
      const target = resolveOuScope(request);
      return ok({ sources: listLocalSetupSources(localDbHandle(), target) });
    } catch (error) {
      console.error("Hotel-copy source list failed:", error);
      return fail(error, NO_SOURCES);
    }
  };

  /** Copy the source hotel's whole setup into the (block-less) target. */
  const copySetup: IpcHandler<any, IpcResult<HotelCopySetupResponse>> = async (
    _event,
    request
  ) => {
    try {
      const target = resolveOuScope(request);
      const source = resolveOuScope({ ou: request?.sourceOu });
      const counts = copyHotelSetup(localDbHandle(), target, source, {
        now: new Date().toISOString(),
      });
      return ok(counts);
    } catch (error) {
      console.error("Hotel-copy setup failed:", error);
      return fail(error, NOTHING_COPIED);
    }
  };

  return {
    [HOTEL_COPY_CHANNELS.listSources]: listSources,
    [HOTEL_COPY_CHANNELS.copySetup]: copySetup,
  };
}
