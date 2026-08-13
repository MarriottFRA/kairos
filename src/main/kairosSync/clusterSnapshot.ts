/**
 * The travelling cluster ratio — stamped into position payloads at hash time.
 * -----------------------------------------------------------
 * Cluster definitions are plaintext reference data on the machine that created
 * them; nothing syncs them (`/clusters` is read-only server reference data and
 * no client ever calls it). A plan downloaded on another machine therefore
 * resolved every assignment to DANGLING — weight ×1, no name — and computed
 * different totals than the machine that published it.
 *
 * The fix travels WITH the position: whenever a position row is mapped for the
 * sync protocol on a machine whose local store RESOLVES the assignment, the
 * effective weight and cluster name are stamped into
 * `cluster_weight_snapshot` / `cluster_name_snapshot` first. Machines without
 * the definition keep whatever arrived (their stored snapshot passes through
 * untouched, so a delegate's publish cannot strip the owner's ratio), and
 * `resolveHotelClusterWeight` falls back to the stored snapshot when the
 * definition is absent.
 *
 * Stamping at MAP time rather than at write time is what makes propagation
 * free: when the owner tweaks a weight on the Clusters page, every assigned
 * row's payload — and therefore its content hash — changes on the next
 * comparison, so the rows read as "changes to publish" through exactly the
 * machinery that already exists. No write-path hooks, no backfill.
 *
 * ONE RULE WITH TEETH: every site that hashes a position payload must stamp it
 * first, or the sites disagree and the user is told they have changes that
 * publishing does not clear. Today those sites are `collectLocalEntities` and
 * the three pending counters in `ipc/handlers/kairosSync.ts` — all four go
 * through {@link stampClusterSnapshot} with a context from
 * {@link clusterSnapshotContext}.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { listClusters } from "../hotelClusters/repo";
import {
  clusterMapById,
  resolveHotelClusterWeight,
} from "../../shared/hotelClusters/resolve";
import type { HotelClusterDto } from "../../shared/hotelClusters/ipc";
import type { Row } from "../../shared/kairosSync/entityMap";

type Db = InstanceType<typeof Database>;

export type ClusterSnapshotContext = ReadonlyMap<string, HotelClusterDto>;

/** The cluster definitions this machine holds, keyed by id. Build once per
 *  pass — every stamped row shares it. */
export function clusterSnapshotContext(localDb: Db): ClusterSnapshotContext {
  return clusterMapById(listClusters(localDb));
}

/**
 * Return the row with its snapshot columns brought up to date, where this
 * machine can know better than what is stored:
 *
 *  - assignment resolves here (CLUSTER / OVERRIDE) → stamp the live values;
 *  - no assignment → clear (no claim to carry);
 *  - NOT_MEMBER → clear: the effective weight here is 1-with-a-warning, and
 *    shipping an old number would make the one machine that can SEE the
 *    misconfiguration the one machine that hides it;
 *  - DANGLING (definition not on this machine) → pass through untouched: the
 *    stored snapshot is the best knowledge anyone has.
 */
export function stampClusterSnapshot(
  row: Row,
  clusters: ClusterSnapshotContext
): Row {
  const clusterId = typeof row.cluster === "string" ? row.cluster : "";
  const held =
    row.cluster_weight_snapshot != null || row.cluster_name_snapshot != null;

  if (!clusterId) {
    return held
      ? { ...row, cluster_weight_snapshot: null, cluster_name_snapshot: null }
      : row;
  }

  const resolved = resolveHotelClusterWeight(
    typeof row.ou === "string" ? row.ou : "",
    clusterId,
    typeof row.cluster_multiplier_override === "number"
      ? row.cluster_multiplier_override
      : null,
    clusters
  );

  if (resolved.source === "CLUSTER" || resolved.source === "OVERRIDE") {
    return {
      ...row,
      cluster_weight_snapshot: resolved.weight,
      cluster_name_snapshot: resolved.clusterName,
    };
  }
  if (resolved.source === "NOT_MEMBER") {
    return held
      ? { ...row, cluster_weight_snapshot: null, cluster_name_snapshot: null }
      : row;
  }
  return row;
}
