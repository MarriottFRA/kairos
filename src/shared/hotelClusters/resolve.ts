/**
 * The one place the effective hotel-cluster multiplier rule lives. Consumed by
 * BOTH engine input paths (loadScenarioInput in main, runLiveSim in the
 * renderer — they must resolve identically or liveSimParity breaks), by the
 * members-view handler, and by the positions grid (badge/warning/gating).
 *
 * Resolution order (the spec):
 *   1. No cluster id ('' / null)            → weight 1, NONE
 *   2. Unknown / deleted cluster            → weight 1, DANGLING  (+ warning)
 *   3. Position's OU not a member           → weight 1, NOT_MEMBER (+ warning)
 *      — membership is checked BEFORE the override: an override never
 *        rescues a broken assignment.
 *   4. Single-member cluster + valid override → override, OVERRIDE
 *      — the manual override is only honored while the cluster has exactly
 *        one member hotel; with several members the weights ARE the spread.
 *   5. Otherwise                            → the member's weight, CLUSTER
 */

import { isValidClusterWeight, type HotelClusterDto } from "./ipc";

export type ClusterWeightSource =
  | "NONE"
  | "CLUSTER"
  | "OVERRIDE"
  | "DANGLING"
  | "NOT_MEMBER";

export interface ResolvedClusterWeight {
  weight: number;
  source: ClusterWeightSource;
  /** The engine still gets weight 1 for these; the UI surfaces them. */
  warning?: "DANGLING" | "NOT_MEMBER";
  /** Cluster name for display / the engine's stat grouping ("" when none). */
  clusterName: string;
}

/** Stored OUs are canonical, but this also runs in the renderer against
 *  service data — normalize defensively so equality is plain string compare. */
function canonicalOu(ou: string): string {
  return ou.trim().toUpperCase();
}

export function resolveHotelClusterWeight(
  ou: string,
  clusterId: string | null | undefined,
  override: number | null | undefined,
  clusterById: ReadonlyMap<string, HotelClusterDto>
): ResolvedClusterWeight {
  if (!clusterId) return { weight: 1, source: "NONE", clusterName: "" };

  const cluster = clusterById.get(clusterId);
  if (!cluster) {
    return {
      weight: 1,
      source: "DANGLING",
      warning: "DANGLING",
      clusterName: "",
    };
  }

  const positionOu = canonicalOu(ou);
  const member = cluster.members.find(
    (candidate) => canonicalOu(candidate.ou) === positionOu
  );
  if (!member) {
    return {
      weight: 1,
      source: "NOT_MEMBER",
      warning: "NOT_MEMBER",
      clusterName: cluster.name,
    };
  }

  if (cluster.members.length === 1 && isValidClusterWeight(override)) {
    return { weight: override, source: "OVERRIDE", clusterName: cluster.name };
  }

  return {
    weight: member.weight,
    source: "CLUSTER",
    clusterName: cluster.name,
  };
}

/** Convenience map for resolver consumers. */
export function clusterMapById(
  clusters: readonly HotelClusterDto[]
): Map<string, HotelClusterDto> {
  return new Map(clusters.map((cluster) => [cluster.id, cluster]));
}
