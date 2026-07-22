/**
 * Position Safe-Defaults Service
 * Renderer-side access to the per-(hotel OU, year) defaults that seed a new
 * position's Contract columns, stored in the local SQLite database.
 *
 * `sendIpcRequest` returns the full { success, data } envelope and throws when
 * the main process reports a failure, so these helpers just unwrap `data`.
 */

import { PositionDefaults } from "../shared/positionDefaults";

interface LoadedDefaults {
  defaults: PositionDefaults;
  /** false when nothing has been saved yet and linked values are showing. */
  saved: boolean;
}

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Load a hotel-year's safe defaults; linked fields come resolved from the calendar. */
export async function loadPositionDefaults(
  ou: string,
  year: number
): Promise<LoadedDefaults> {
  const response = await ipc().sendIpcRequest("position-defaults:get", { ou, year });
  return response.data as LoadedDefaults;
}

/** Upsert a hotel-year's safe defaults and return what was persisted (resolved). */
export async function savePositionDefaults(
  defaults: PositionDefaults
): Promise<PositionDefaults> {
  const response = await ipc().sendIpcRequest("position-defaults:save", defaults);
  return response.data as PositionDefaults;
}
