/**
 * Hotel-clusters IPC handlers.
 *
 * Unlike every other data domain these channels are NOT OU-gated (registered
 * without ouScopeMiddleware in ipc/index.ts): a cluster spans hotels by
 * definition — this is the "separate explicit multi-scope API" reserved by
 * src/main/positions/ouScope.ts. Definitions are non-sensitive reference data
 * in the plaintext store (same class as block configs); the channels that
 * touch positions across OUs (members-view, delete's assignment clear) are
 * gated by the secure store's session lock instead — locked → the
 * SECURE_DB_LOCKED sentinel, same as the positions handlers.
 */

import { IpcHandler, IpcResult } from "../types";
import { localDbHandle } from "../../local_db";
import { secureDb } from "../../secure_db";
import {
  clearAssignmentsAllOus,
  deleteCluster,
  listAssignedPositionsAllOus,
  listClusters,
  saveCluster,
  scenarioMetaById,
} from "../../main/hotelClusters/repo";
import {
  ClusterMembersViewResponse,
  ClusterPositionRefDto,
  HOTEL_CLUSTERS_CHANNELS,
  HotelClusterInput,
  HotelClustersListResponse,
} from "../../shared/hotelClusters/ipc";
import {
  clusterMapById,
  resolveHotelClusterWeight,
} from "../../shared/hotelClusters/resolve";
import {
  adoptIntoGroup,
  syncClusterMembership,
} from "../../main/positions/clusterSync";
import { SECURE_DB_LOCKED } from "../../shared/positions/ipc";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  let message = error instanceof Error ? error.message : "Unknown error";
  if (message.includes("Secure database is locked")) {
    message = SECURE_DB_LOCKED;
  }
  return { success: false, error: message, data, timestamp: Date.now() };
}

const EMPTY_LIST: HotelClustersListResponse = { clusters: [] };
const EMPTY_VIEW: ClusterMembersViewResponse = { positions: [] };

export function createHotelClustersHandlers(): Record<string, IpcHandler> {
  /** All non-deleted clusters with members. */
  const list: IpcHandler<any, IpcResult<HotelClustersListResponse>> = async () => {
    try {
      return ok({ clusters: listClusters(localDbHandle()) });
    } catch (error) {
      console.error("Hotel clusters list failed:", error);
      return fail(error, EMPTY_LIST);
    }
  };

  /** Create or update a cluster; returns the refreshed list. */
  const save: IpcHandler<any, IpcResult<HotelClustersListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const input = request?.cluster as HotelClusterInput | undefined;
      if (!input) throw new Error("Missing cluster payload.");
      const db = localDbHandle();
      const now = new Date().toISOString();
      const savedId = saveCluster(db, input, { now });

      // Reconcile the cluster's position groups with the new member list: a
      // hotel that just joined gets its mirrored rows, one that left has its
      // rows unlinked (never deleted). Best-effort — the definition is already
      // saved, and a locked secure store must not turn a rename into a failure.
      // The next write or save reconciles.
      try {
        syncClusterMembership(
          { structureDb: db, valuesDb: secureDb(), stamp: now },
          savedId
        );
      } catch (error) {
        console.warn("Cluster membership sync skipped:", error);
      }
      return ok({ clusters: listClusters(db) });
    } catch (error) {
      console.error("Hotel clusters save failed:", error);
      return fail(error, EMPTY_LIST);
    }
  };

  /**
   * Clear all assignments (encrypted store, ALL OUs — user-confirmed
   * behavior), then soft-delete the definition. Requires the unlocked secure
   * store; when locked nothing is deleted, so a cluster can never disappear
   * while positions still silently point at it.
   */
  const del: IpcHandler<any, IpcResult<HotelClustersListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const clusterId = String(request?.clusterId ?? "");
      if (!clusterId) throw new Error("Missing clusterId.");
      const now = new Date().toISOString();
      const valuesDb = secureDb(); // throws while locked — before any change
      clearAssignmentsAllOus(valuesDb, clusterId, { now });
      const db = localDbHandle();
      deleteCluster(db, clusterId, { now });
      return ok({ clusters: listClusters(db) });
    } catch (error) {
      console.error("Hotel clusters delete failed:", error);
      return fail(error, EMPTY_LIST);
    }
  };

  /** Assigned positions across ALL OUs (the explicit multi-scope read). */
  const membersView: IpcHandler<
    any,
    IpcResult<ClusterMembersViewResponse>
  > = async (_event, request) => {
    try {
      const clusterId = String(request?.clusterId ?? "");
      if (!clusterId) throw new Error("Missing clusterId.");
      const valuesDb = secureDb();
      const db = localDbHandle();
      const clusterById = clusterMapById(listClusters(db));
      const scenarioMeta = scenarioMetaById(db);

      // Positions of soft-deleted scenarios are filtered HERE, not in SQL —
      // scenarios live in the plaintext file, positions in the encrypted one,
      // and no cross-file JOIN exists. scenarioMetaById returns exactly the
      // live scenario ids.
      const positions: ClusterPositionRefDto[] = listAssignedPositionsAllOus(
        valuesDb,
        clusterId
      )
        .filter((row) => scenarioMeta.has(row.scenario_id))
        .map((row) => {
          const resolved = resolveHotelClusterWeight(
            row.ou,
            clusterId,
            row.cluster_multiplier_override,
            clusterById
          );
          const meta = scenarioMeta.get(row.scenario_id);
          return {
            positionId: row.id,
            ou: row.ou,
            scenarioId: row.scenario_id,
            scenarioLabel: meta?.label ?? "",
            year: meta?.year ?? 0,
            title: row.title,
            departmentCode: row.department_code,
            active: row.active === 1,
            headcount: row.headcount,
            override: row.cluster_multiplier_override,
            effectiveWeight: resolved.weight,
            warning: resolved.warning,
            clusterLinkId: row.cluster_link_id ?? "",
          };
        });
      return ok({ positions });
    } catch (error) {
      console.error("Hotel clusters members-view failed:", error);
      return fail(error, EMPTY_VIEW);
    }
  };

  /**
   * Adopt a standalone position into an existing cluster-position group.
   *
   * The escape hatch for rows created by hand in each hotel before this
   * feature — the one case the app deliberately will NOT resolve on its own,
   * because matching live cost data on a title string is a guess. Here the
   * user has pointed at the two rows, so it is their call, not ours.
   */
  const adopt: IpcHandler<any, IpcResult<ClusterMembersViewResponse>> = async (
    _event,
    request
  ) => {
    try {
      const linkId = String(request?.clusterLinkId ?? "");
      const positionId = String(request?.positionId ?? "");
      const ou = String(request?.ou ?? "");
      if (!linkId || !positionId || !ou) {
        throw new Error("Missing position, group or hotel.");
      }
      const valuesDb = secureDb();
      const db = localDbHandle();
      adoptIntoGroup(
        { structureDb: db, valuesDb, stamp: new Date().toISOString() },
        linkId,
        positionId,
        ou
      );
      return ok(EMPTY_VIEW);
    } catch (error) {
      console.error("Cluster position adopt failed:", error);
      return fail(error, EMPTY_VIEW);
    }
  };

  return {
    [HOTEL_CLUSTERS_CHANNELS.list]: list,
    [HOTEL_CLUSTERS_CHANNELS.save]: save,
    [HOTEL_CLUSTERS_CHANNELS.delete]: del,
    [HOTEL_CLUSTERS_CHANNELS.membersView]: membersView,
    [HOTEL_CLUSTERS_CHANNELS.adopt]: adopt,
  };
}
