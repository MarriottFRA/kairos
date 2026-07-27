/**
 * Hotel clusters — shared types + IPC channel names.
 *
 * A hotel cluster is a NAMED, CROSS-HOTEL group of OUs, each member carrying a
 * weight (two hotels sharing a person equally → 0.5 each). A position assigned
 * to a cluster (the repurposed `positions.cluster` column stores the cluster
 * id) is flexed by its own hotel's weight: every cost/hours/FTE line scales
 * down, headcount never does — a shared person still counts as one head in
 * each hotel. Definitions live in the PLAINTEXT structure store (non-PII
 * reference data, like block_configs); assignment + the manual override live
 * on the encrypted positions table.
 *
 * Unlike every other data domain these channels are NOT OU-gated — a cluster
 * spans hotels by definition (the "separate explicit multi-scope API"
 * reserved by src/main/positions/ouScope.ts).
 *
 * This module is the single contract imported by both the renderer service
 * and the main-process repo/handlers.
 */

/** One member hotel of a cluster. */
export interface HotelClusterMember {
  /** Canonical OU ("OU" + 5 alphanumerics, e.g. OU25RJ2). */
  ou: string;
  /** This hotel's share of an assigned person, 0 < weight <= 1. */
  weight: number;
}

/** A cluster as seen by the renderer. */
export interface HotelClusterDto {
  id: string;
  name: string;
  /** Ordered by sort_order, then OU. */
  members: HotelClusterMember[];
  sortOrder: number;
  updatedAt: string;
}

/** The payload the renderer sends to create/update a cluster. */
export interface HotelClusterInput {
  /** Omit to create; present to update an existing cluster. */
  id?: string;
  name: string;
  members: HotelClusterMember[];
}

/** Every mutation returns the refreshed list (one round-trip, blocks idiom). */
export interface HotelClustersListResponse {
  clusters: HotelClusterDto[];
}

/**
 * Weight bounds shared by save-validation, the override rule and the
 * resolver: finite and 0 < w <= 1. A zero weight would silently zero a
 * position's whole cost; > 1 would inflate it.
 */
export function isValidClusterWeight(weight: unknown): weight is number {
  return (
    typeof weight === "number" &&
    Number.isFinite(weight) &&
    weight > 0 &&
    weight <= 1
  );
}

/**
 * One assigned position from the explicit cross-OU membership view. PII is
 * deliberately minimal: `title` names the post, not the person (the field
 * seed documents it as non-masked), and nothing else leaves position_pii.
 */
export interface ClusterPositionRefDto {
  positionId: string;
  ou: string;
  scenarioId: string;
  /** Enriched from the plaintext scenarios table ("" when unknown). */
  scenarioLabel: string;
  year: number;
  title: string | null;
  departmentCode: string;
  active: boolean;
  headcount: number;
  override: number | null;
  effectiveWeight: number;
  /** Set when the assignment is broken — the row resolves to weight 1. */
  warning?: "NOT_MEMBER" | "DANGLING";
  /** The cluster-position group this row belongs to ("" = a standalone row
   *  that happens to carry the assignment). Rows sharing a link id are ONE
   *  person: the Clusters screen groups them into a single line, and a
   *  standalone row in a member hotel is a candidate to be adopted into a
   *  group (the hand-made-duplicate fix). */
  clusterLinkId: string;
}

export interface ClusterMembersViewResponse {
  positions: ClusterPositionRefDto[];
}

export const HOTEL_CLUSTERS_CHANNELS = {
  /** All non-deleted clusters with members. */
  list: "hotelClusters:list",
  /** Create or update a cluster; returns the refreshed list. */
  save: "hotelClusters:save",
  /**
   * Clear all assignments across OUs (requires the unlocked secure store),
   * then soft-delete the cluster; returns the refreshed list.
   */
  delete: "hotelClusters:delete",
  /** Assigned positions across ALL OUs (the one explicit multi-scope read). */
  membersView: "hotelClusters:members-view",
  /**
   * Adopt a standalone position into an existing cluster-position group — the
   * fix for rows created by hand in each hotel before the cluster existed.
   * Links the row and converges it onto the group's shared values.
   */
  adopt: "hotelClusters:adopt-position",
} as const;
