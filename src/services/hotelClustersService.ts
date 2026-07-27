/**
 * Hotel Clusters Service
 * Renderer-side driver for the Clusters tab and the positions grid's cluster
 * column. Main owns storage. Unlike the OU-gated services no `ou` is sent —
 * clusters are cross-hotel reference data.
 *
 * Unlike the older list-only services these THROW on a failed envelope: the
 * callers branch on the message (validation text for the dialog,
 * SECURE_DB_LOCKED for the members view / delete) instead of silently
 * receiving an unchanged list.
 */

import {
  ClusterMembersViewResponse,
  HOTEL_CLUSTERS_CHANNELS,
  HotelClusterDto,
  HotelClusterInput,
  HotelClustersListResponse,
} from "../shared/hotelClusters/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

function unwrap<T>(response: { success?: boolean; error?: string; data?: T }): T {
  if (response?.success === false) {
    throw new Error(response.error || "Unknown error");
  }
  return response.data as T;
}

/** All clusters with their member hotels + weights. */
export async function listClusters(): Promise<HotelClusterDto[]> {
  const response = await ipc().sendIpcRequest(HOTEL_CLUSTERS_CHANNELS.list, {});
  return unwrap<HotelClustersListResponse>(response)?.clusters ?? [];
}

/** Create or update a cluster; returns the refreshed list. */
export async function saveCluster(
  cluster: HotelClusterInput
): Promise<HotelClusterDto[]> {
  const response = await ipc().sendIpcRequest(HOTEL_CLUSTERS_CHANNELS.save, {
    cluster,
  });
  return unwrap<HotelClustersListResponse>(response)?.clusters ?? [];
}

/**
 * Clear every position assignment of the cluster (all hotels), then delete
 * it; returns the refreshed list. Throws SECURE_DB_LOCKED while signed out.
 */
export async function deleteCluster(
  clusterId: string
): Promise<HotelClusterDto[]> {
  const response = await ipc().sendIpcRequest(HOTEL_CLUSTERS_CHANNELS.delete, {
    clusterId,
  });
  return unwrap<HotelClustersListResponse>(response)?.clusters ?? [];
}

/**
 * Positions assigned to the cluster across ALL hotels (title/department only
 * — no personal data). Throws SECURE_DB_LOCKED while signed out.
 */
export async function clusterMembersView(
  clusterId: string
): Promise<ClusterMembersViewResponse> {
  const response = await ipc().sendIpcRequest(
    HOTEL_CLUSTERS_CHANNELS.membersView,
    { clusterId }
  );
  return unwrap<ClusterMembersViewResponse>(response) ?? { positions: [] };
}

/**
 * Link a standalone position into an existing cluster-position group, then
 * converge it onto that group's shared values — the fix for the same person
 * having been typed into each hotel by hand. Throws SECURE_DB_LOCKED while
 * signed out.
 */
export async function adoptClusterPosition(
  clusterLinkId: string,
  positionId: string,
  ou: string
): Promise<void> {
  const response = await ipc().sendIpcRequest(HOTEL_CLUSTERS_CHANNELS.adopt, {
    clusterLinkId,
    positionId,
    ou,
  });
  unwrap(response);
}
