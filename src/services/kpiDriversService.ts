/**
 * KPI Drivers Service
 * Renderer-side driver for the KPI-driver tab. Main owns storage and the
 * budget aggregation; this service relays the selected OU and the edited
 * definition. Every call carries `ou` (the selected hotel) so the OU-gate
 * middleware can scope it. Mutations return the full refreshed list.
 */

import {
  KPI_DRIVERS_CHANNELS,
  KpiDriverId,
  KpiDriverInput,
  KpiDriverWithSeries,
} from "../shared/kpiDrivers/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** All drivers (user + built-in) with their cached series for a hotel. */
export async function listKpiDrivers(
  ou: string
): Promise<KpiDriverWithSeries[]> {
  const response = await ipc().sendIpcRequest(KPI_DRIVERS_CHANNELS.list, { ou });
  return (response.data as KpiDriverWithSeries[]) ?? [];
}

/** Create or update a user driver (recomputes it); returns the refreshed list. */
export async function saveKpiDriver(
  ou: string,
  driver: KpiDriverInput,
  createdBy: string | null
): Promise<KpiDriverWithSeries[]> {
  const response = await ipc().sendIpcRequest(KPI_DRIVERS_CHANNELS.save, {
    ou,
    driver,
    createdBy,
  });
  return (response.data as KpiDriverWithSeries[]) ?? [];
}

/** Soft-delete a user driver; returns the refreshed list. */
export async function deleteKpiDriver(
  ou: string,
  driverId: KpiDriverId
): Promise<KpiDriverWithSeries[]> {
  const response = await ipc().sendIpcRequest(KPI_DRIVERS_CHANNELS.delete, {
    ou,
    driverId,
  });
  return (response.data as KpiDriverWithSeries[]) ?? [];
}

/** Recompute one driver (driverId given) or all drivers; returns refreshed list. */
export async function recalcKpiDrivers(
  ou: string,
  driverId?: KpiDriverId
): Promise<KpiDriverWithSeries[]> {
  const response = await ipc().sendIpcRequest(KPI_DRIVERS_CHANNELS.recalc, {
    ou,
    driverId: driverId ?? null,
  });
  return (response.data as KpiDriverWithSeries[]) ?? [];
}
