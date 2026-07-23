/**
 * Mapping-tables IPC handlers.
 *
 * These own the whole sync round-trip in main: the ~5000-row payloads are
 * fetched through the authenticated ApiClient and written straight into the
 * plaintext local store, so the bulk data never crosses the IPC boundary. The
 * renderer only drives sync/rebuild and reads back status.
 *
 * Auth is handled by ApiClient.authedFetch (attaches the device-session Bearer,
 * refreshes on 401) — same transport as every other business call.
 */

import { IpcHandler, IpcResult } from "../types";
import { ApiClient } from "../../main/auth/apiClient";
import { localDbHandle } from "../../local_db";
import {
  clearAllTables,
  getStatus,
  listAccounts,
  listDepartments,
} from "../../main/mappingTables/repo";
import { syncMappingTables } from "../../main/mappingTables/sync";
import {
  AccountOption,
  DepartmentOption,
  MAPPING_TABLES_CHANNELS,
  MappingSyncResult,
  MappingTablesStatus,
} from "../../shared/mappingTables/types";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

export function createMappingTablesHandlers(
  apiClient: ApiClient
): Record<string, IpcHandler> {
  /** Version-gated sync — pull only when the server version differs. */
  const sync: IpcHandler<unknown, IpcResult<MappingSyncResult>> = async () => {
    const db = localDbHandle();
    try {
      const result = await syncMappingTables(
        db,
        apiClient,
        new Date().toISOString()
      );
      return ok(result);
    } catch (error) {
      console.error("Mapping tables sync failed:", error);
      return fail(error, {
        outcome: "error" as const,
        status: getStatus(db),
      });
    }
  };

  /** Clear all three tables + stored version, then force a full re-pull. */
  const rebuild: IpcHandler<unknown, IpcResult<MappingSyncResult>> = async () => {
    const db = localDbHandle();
    try {
      clearAllTables(db);
      const result = await syncMappingTables(
        db,
        apiClient,
        new Date().toISOString(),
        { force: true }
      );
      return ok(result);
    } catch (error) {
      console.error("Mapping tables rebuild failed:", error);
      return fail(error, {
        outcome: "error" as const,
        status: getStatus(db),
      });
    }
  };

  /** Local cache metadata + counts (no network). */
  const status: IpcHandler<unknown, IpcResult<MappingTablesStatus>> = async () => {
    const db = localDbHandle();
    try {
      return ok(getStatus(db));
    } catch (error) {
      console.error("Mapping tables status failed:", error);
      return fail(error, {
        version: null,
        lastSyncedAt: null,
        counts: { accountMaps: 0, departmentMaps: 0, combos: 0 },
      });
    }
  };

  /** Department options (code + name) for the positions dropdown — no network. */
  const departments: IpcHandler<
    unknown,
    IpcResult<DepartmentOption[]>
  > = async () => {
    try {
      return ok(listDepartments(localDbHandle()));
    } catch (error) {
      console.error("Listing departments failed:", error);
      return fail(error, [] as DepartmentOption[]);
    }
  };

  /** Account options (code + description) for the account dropdowns — no network. */
  const accounts: IpcHandler<unknown, IpcResult<AccountOption[]>> = async () => {
    try {
      return ok(listAccounts(localDbHandle()));
    } catch (error) {
      console.error("Listing accounts failed:", error);
      return fail(error, [] as AccountOption[]);
    }
  };

  return {
    [MAPPING_TABLES_CHANNELS.sync]: sync,
    [MAPPING_TABLES_CHANNELS.rebuild]: rebuild,
    [MAPPING_TABLES_CHANNELS.status]: status,
    [MAPPING_TABLES_CHANNELS.listDepartments]: departments,
    [MAPPING_TABLES_CHANNELS.listAccounts]: accounts,
  };
}
