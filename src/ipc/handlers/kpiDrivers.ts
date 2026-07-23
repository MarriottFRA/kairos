/**
 * KPI-driver IPC handlers.
 *
 * CRUD over user-defined KPI drivers in the plaintext local store, plus
 * recompute of their cached series from budget_values. Every channel is
 * OU-gated (registered with ouScopeMiddleware in ipc/index.ts) and re-brands the
 * OU here via resolveOuScope, so a driver can only ever land in the selected
 * hotel's data. Mutations return the full current list (driver + series) so the
 * renderer refreshes in one round-trip.
 */

import { randomUUID } from "crypto";

import { IpcHandler, IpcResult } from "../types";
import { localDbHandle } from "../../local_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import {
  deleteDriver,
  getSeries,
  listDrivers,
  nextSortOrder,
  recomputeAllForOu,
  recomputeDriver,
  saveDriver,
} from "../../main/kpiDrivers/repo";
import {
  KPI_DRIVERS_CHANNELS,
  KpiDriverId,
  KpiDriverInput,
  KpiDriverWithSeries,
} from "../../shared/kpiDrivers/ipc";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

type LocalDb = ReturnType<typeof localDbHandle>;

/** The full read model for the OU: every driver with its cached series. */
function listWithSeries(db: LocalDb, ou: string): KpiDriverWithSeries[] {
  return listDrivers(db, ou).map((driver) => ({
    driver,
    series: getSeries(db, ou, driver.id),
  }));
}

export function createKpiDriversHandlers(): Record<string, IpcHandler> {
  /** All drivers (user + built-in) with their cached series. */
  const list: IpcHandler<any, IpcResult<KpiDriverWithSeries[]>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      return ok(listWithSeries(localDbHandle(), scope.ou));
    } catch (error) {
      console.error("KPI drivers list failed:", error);
      return fail(error, []);
    }
  };

  /** Create or update a user driver, recompute it, return the refreshed list. */
  const save: IpcHandler<any, IpcResult<KpiDriverWithSeries[]>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const input = request?.driver as KpiDriverInput | undefined;
      if (!input) throw new Error("Missing driver payload.");

      const db = localDbHandle();
      const now = new Date().toISOString();
      const id = input.id ?? (randomUUID() as unknown as KpiDriverId);
      const isNew = !input.id;
      const createdBy =
        typeof request?.createdBy === "string" && request.createdBy.trim()
          ? request.createdBy.trim()
          : null;

      saveDriver(db, {
        id,
        ou: scope.ou,
        label: input.label,
        description: input.description ?? "",
        deptMode: input.deptMode,
        deptPatterns: input.deptPatterns ?? [],
        accountPrefixes: input.accountPrefixes ?? [],
        bucketIndex: input.bucketIndex,
        sortOrder: isNew ? nextSortOrder(db, scope.ou) : 0,
        createdBy,
        now,
      });
      recomputeDriver(db, scope.ou, id, { computedAt: now });

      return ok(listWithSeries(db, scope.ou));
    } catch (error) {
      console.error("KPI drivers save failed:", error);
      return fail(error, []);
    }
  };

  /** Soft-delete a user driver, return the refreshed list. */
  const del: IpcHandler<any, IpcResult<KpiDriverWithSeries[]>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const driverId = String(request?.driverId ?? "");
      if (!driverId) throw new Error("Missing driverId.");
      const db = localDbHandle();
      deleteDriver(db, scope.ou, driverId, { now: new Date().toISOString() });
      return ok(listWithSeries(db, scope.ou));
    } catch (error) {
      console.error("KPI drivers delete failed:", error);
      return fail(error, []);
    }
  };

  /** Recompute one driver (driverId given) or all drivers for the OU. */
  const recalc: IpcHandler<any, IpcResult<KpiDriverWithSeries[]>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const db = localDbHandle();
      const now = new Date().toISOString();
      const driverId =
        typeof request?.driverId === "string" && request.driverId
          ? request.driverId
          : null;
      if (driverId) {
        recomputeDriver(db, scope.ou, driverId, { computedAt: now });
      } else {
        recomputeAllForOu(db, scope.ou, { computedAt: now });
      }
      return ok(listWithSeries(db, scope.ou));
    } catch (error) {
      console.error("KPI drivers recalc failed:", error);
      return fail(error, []);
    }
  };

  return {
    [KPI_DRIVERS_CHANNELS.list]: list,
    [KPI_DRIVERS_CHANNELS.save]: save,
    [KPI_DRIVERS_CHANNELS.delete]: del,
    [KPI_DRIVERS_CHANNELS.recalc]: recalc,
  };
}
