/**
 * Plans, clusters and the support lease.
 * -----------------------------------------------------------
 * The small surfaces: registering a plan, listing what the server has, reading
 * the cluster reference data, and finding out why a save came back 423.
 *
 * ## A plan IS a scenario
 *
 * `POST /plans` takes a client-minted id, and we send the local scenario's id.
 * Registering a plan whose id already exists and belongs to us returns the
 * existing plan rather than an error, so a retried first publish costs nothing
 * and cannot fork into two plans for the same scenario.
 *
 * ## Clusters never propagate server-side
 *
 * `/clusters` is reference data — which properties belong together and with what
 * weights — and `/divergence` is advisory reporting on top of it. Propagation
 * stays in `src/main/positions/clusterSync.ts`, client-side, under the user's
 * own credentials, publishing to each property as themselves. Doing it
 * server-side with system privileges would let a delegate holding one department
 * at one hotel write into a sibling's budget with no grant anywhere.
 */

import { KairosApiError, KAIROS_ERRORS, KairosClient, query } from "./client";
import {
  Cluster,
  ClusterDivergence,
  ClusterList,
  LeaseResponse,
  PlanCreate,
  PlanPatch,
  PlanSummary,
} from "../../shared/kairosSync/protocol";

const plan = (planId: string) => `/plans/${encodeURIComponent(planId)}`;

/** Plans at a property. Filters rather than 403s — an empty list is an answer. */
export function listPlans(
  client: KairosClient,
  ou: string,
  year?: number
): Promise<PlanSummary[]> {
  return client.get<PlanSummary[]>(`/plans${query({ ou, year: year ?? null })}`);
}

export function getPlan(client: KairosClient, planId: string): Promise<PlanSummary> {
  return client.get<PlanSummary>(plan(planId));
}

/**
 * Register a plan; the caller becomes its owner.
 *
 * Owning requires all four of: the `kairos` app grant, an `access_type` of
 * hotel_admin / above_property / admin, OU access at write or admin, and
 * `all_departments = true`. The last is what makes delegation coherent — an
 * owner hands out slices, so they must be able to see the whole. A refusal comes
 * back as `kairos_owner_not_eligible` with a `context` listing exactly what is
 * required, which is what the UI should show rather than a generic "no".
 */
export function createPlan(
  client: KairosClient,
  body: PlanCreate
): Promise<PlanSummary> {
  return client.post<PlanSummary>(`/plans`, body);
}

export function patchPlan(
  client: KairosClient,
  planId: string,
  body: PlanPatch
): Promise<PlanSummary> {
  return client.patch<PlanSummary>(plan(planId), body);
}

/** Soft delete. The rows survive server-side; the plan stops being listed. */
export function deletePlan(client: KairosClient, planId: string): Promise<unknown> {
  return client.delete(plan(planId));
}

/**
 * Hand a plan to a new owner.
 *
 * The successor is validated against the full ownership bar before anything
 * moves (`422 kairos_owner_not_eligible` otherwise), and any delegation they
 * held on this plan is revoked — an owner delegating to themselves is not a
 * coherent state.
 */
export function transferPlan(
  client: KairosClient,
  planId: string,
  newOwnerUserId: number,
  reason: string
): Promise<unknown> {
  return client.post(`${plan(planId)}/transfer`, { newOwnerUserId, reason });
}

/**
 * The support lease, if one is held.
 *
 * Readable by the hotel, not just by support: when a commit comes back
 * `423 kairos_plan_locked_by_support`, the user needs to be told who and until
 * when. The internal `reason` is never returned — it can name a defect, a
 * customer or another property — so `ticketRef` is the handle to show.
 *
 * On release the plan's `syncEpoch` moves ONLY if the plan actually changed. An
 * administrator who looked and changed nothing does not force a full
 * re-download.
 */
export async function fetchLease(
  client: KairosClient,
  planId: string
): Promise<LeaseResponse | null> {
  try {
    return await client.get<LeaseResponse>(`${plan(planId)}/lease`);
  } catch (error) {
    if (error instanceof KairosApiError && error.is(KAIROS_ERRORS.PLAN_NOT_FOUND)) {
      return null;
    }
    throw error;
  }
}

// ------------------------------------------------------------------ clusters

export function fetchClusterVersion(
  client: KairosClient
): Promise<{ version: number }> {
  return client.get<{ version: number }>(`/clusters/version`);
}

export async function fetchClusters(
  client: KairosClient,
  etag: string | null
): Promise<{ clusters: Cluster[] | null; version: number; etag: string | null }> {
  const response = await client.getConditional<ClusterList>(`/clusters`, etag);
  if (response.status === 304) {
    return { clusters: null, version: 0, etag: response.etag };
  }
  return {
    clusters: response.body.clusters,
    version: response.body.version,
    etag: response.etag,
  };
}

/**
 * Structural drift across a cluster's member properties.
 *
 * Advisory only — it reports and never propagates. The number that matters to
 * the UI is `omittedCount`: greater than zero means this answer is about PART of
 * the cluster, and a user shown one row of a four-hotel cluster must not read it
 * as "we are consistent".
 */
export function fetchClusterDivergence(
  client: KairosClient,
  clusterId: string,
  year: number
): Promise<ClusterDivergence> {
  return client.get<ClusterDivergence>(
    `/clusters/${encodeURIComponent(clusterId)}/divergence${query({ year })}`
  );
}
