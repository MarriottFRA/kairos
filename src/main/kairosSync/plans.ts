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
  LeaseCreate,
  LeaseReleaseResult,
  LeaseResponse,
  PlanCreate,
  PlanPatch,
  PlanSummary,
  PlanVersion,
  TransferResult,
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
 * The cheapest single-plan probe: version, epoch and this caller's relation.
 *
 * Exists for one job — resolving `baseVersion` before a commit when `/sync/heads`
 * answered 304 and the cached body predates a registration. Sending a guessed
 * `0` against a live plan is not a near miss; it makes every row in the chunk
 * come back `ALREADY_EXISTS`.
 */
export function fetchPlanVersion(
  client: KairosClient,
  planId: string
): Promise<PlanVersion> {
  return client.get<PlanVersion>(`${plan(planId)}/version`);
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
 *
 * ## The outgoing owner keeps a read-only view
 *
 * Not a separate call. The same transaction leaves the previous owner a
 * read-only delegation over every delegatable department, granted BY the
 * incoming owner, who can withdraw it with the ordinary DELETE whenever they
 * like. It is why the result is worth typing rather than discarding: retention
 * is best effort and never fails the transfer, so the only way to know whether
 * the person who just gave the plan away can still see it is to read
 * `retainedDelegation` / `retainedReason` off this response. Exactly one of the
 * two is non-null.
 */
export function transferPlan(
  client: KairosClient,
  planId: string,
  newOwnerUserId: number,
  reason: string
): Promise<TransferResult> {
  return client.post<TransferResult>(`${plan(planId)}/transfer`, {
    newOwnerUserId,
    reason,
  });
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

/**
 * Take a support lease. The only path by which an administrator gains write.
 *
 * `READ_ONLY_SUPPORT` grants reads only — to its holder as much as to anybody
 * else — and exists so that looking at a hotel's data is a decision somebody
 * recorded. `EXCLUSIVE` is the only mode that confers write, and it locks the
 * owner out for as long as it is held, which is why it is a separate, deliberate
 * choice rather than a flag on the first one.
 */
export function acquireLease(
  client: KairosClient,
  planId: string,
  body: LeaseCreate
): Promise<LeaseResponse> {
  return client.post<LeaseResponse>(`${plan(planId)}/lease`, body);
}

/** Extend. Only the holder may extend, and 1440 minutes is the overall ceiling. */
export function extendLease(
  client: KairosClient,
  planId: string,
  minutes: number
): Promise<LeaseResponse> {
  return client.patch<LeaseResponse>(`${plan(planId)}/lease`, { minutes });
}

/**
 * Release, with a summary of what was done.
 *
 * Releasing restores the plan's state from before the lease, so a lease taken on
 * an ARCHIVED plan does not quietly un-archive it. An administrator may release
 * a lease they do not hold — a colleague who went home with a hotel locked is
 * exactly the situation this resolves — and that is audited as such.
 */
export function releaseLease(
  client: KairosClient,
  planId: string,
  summary: string
): Promise<LeaseReleaseResult> {
  return client.delete<LeaseReleaseResult>(`${plan(planId)}/lease`, { summary });
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
