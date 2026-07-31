/**
 * Delegation: granting, listing, revoking, handing back.
 * -----------------------------------------------------------
 * An owner hands out departments; the delegate edits only those; either side can
 * give them back. The server owns every decision here — this module is the
 * transport plus the two error shapes the UI is obliged to render.
 *
 * ## The two errors that are not failures
 *
 * **`422 kairos_delegation_partial_overlap`.** The delegate holds only some of
 * the requested departments. Effective scope is `delegated ∩ (the delegate's own
 * departments, or ALL)` — both directions narrow. The owner must be shown
 * exactly which departments will not take effect before the grant is retried
 * with `acknowledgeNonOverlap: true`. The FULL requested set is stored as
 * intent, so if the delegate's access is widened later the grant widens with it.
 *
 * **`409 kairos_delegate_has_unsynced_work`.** The delegate has unpublished work
 * and the owner is about to lock them out of publishing it. Forcing is
 * legitimate — it is the escape hatch when someone is on leave — but it has to be
 * a decision, and the owner has to be told that the work is not lost and that
 * re-granting is how it gets published.
 *
 * ## A delegated department is not writable by the owner
 *
 * That is per the brief and it is not a bug. The owner's route back is to
 * withdraw the delegation, which is deliberate and audited, rather than a silent
 * override that leaves two people editing the same rows.
 *
 * ## Multi-hotel is a client-side loop
 *
 * A plan has exactly one OU, so "delegate this person across all my hotels" is N
 * grants on N plans, driven from here. Never a server-side fan-out: one request
 * must not write into properties it never named.
 */

import { KairosApiError, KAIROS_ERRORS, KairosClient, query } from "./client";
import {
  Activity,
  DelegatableDepartments,
  Delegation,
  DelegationCandidates,
  DelegationCreate,
  DelegationList,
  DepartmentOwnership,
  PartialOverlapContext,
  PresenceReport,
  RevokeResponse,
  UnsyncedWorkContext,
} from "../../shared/kairosSync/protocol";

const plan = (planId: string) => `/plans/${encodeURIComponent(planId)}`;

/**
 * Departments that can be delegated, and why some cannot.
 *
 * "Delegatable" means the department has at least one live department-scoped
 * row of ANY type — a position, a buyout row or a manual input row. A department
 * with none cannot be granted; the fix is to add a placeholder position, and the
 * server says so in its `note`. Codes present in the plan but missing from
 * `department_maps` come back as `UNKNOWN_DEPARTMENT_CODE` rather than being
 * quietly omitted, so "why can't I delegate D9999?" has an answer.
 *
 * Owner-only.
 */
export function listDelegatableDepartments(
  client: KairosClient,
  planId: string
): Promise<DelegatableDepartments> {
  return client.get<DelegatableDepartments>(`${plan(planId)}/departments`);
}

/**
 * Who this owner could delegate to.
 *
 * Already scoped server-side to users holding live OU access to THIS plan's
 * property, including all-OU holders — an above-property colleague is a valid
 * delegate and would be invisible under the obvious query. Do not filter the
 * list again client-side.
 *
 * Ineligible candidates arrive WITH a reason rather than filtered out. Render
 * them greyed with the reason; hiding them is what turns "why isn't Anna in the
 * list?" into a support ticket.
 */
export function listCandidates(
  client: KairosClient,
  planId: string,
  search?: string
): Promise<DelegationCandidates> {
  return client.get<DelegationCandidates>(
    `${plan(planId)}/delegation-candidates${query({ q: search ?? null })}`
  );
}

/**
 * Delegations on a plan.
 *
 * Who sees what depends on who is asking: an owner sees all of them, anyone else
 * sees only their own row. That is deliberate — the full list carries every
 * other delegate's email and the plan's whole department structure, which is a
 * real disclosure to somebody scoped to one department.
 */
export function listDelegations(
  client: KairosClient,
  planId: string
): Promise<DelegationList> {
  return client.get<DelegationList>(`${plan(planId)}/delegations`);
}

/** My delegations across every hotel, including ones revoked in the last 30 days. */
export function listMyDelegations(
  client: KairosClient
): Promise<{ delegations: Delegation[] }> {
  return client.get<{ delegations: Delegation[] }>(`/me/delegations`);
}

/** What a grant attempt produced, including the case the owner must confirm. */
export type GrantResult =
  | { outcome: "granted"; id: string; delegations: Delegation[] }
  | { outcome: "partial-overlap"; context: PartialOverlapContext };

/**
 * Grant a delegation.
 *
 * The partial-overlap 422 is returned as a RESULT, not thrown: it is a question
 * for the owner ("these two departments will not take effect — proceed?"), and
 * making the caller catch an exception to ask it invites the catch that just
 * logs and moves on.
 */
export async function grantDelegation(
  client: KairosClient,
  planId: string,
  body: DelegationCreate
): Promise<GrantResult> {
  try {
    const response = await client.post<{ id: string; delegations: Delegation[] }>(
      `${plan(planId)}/delegations`,
      body
    );
    return { outcome: "granted", id: response.id, delegations: response.delegations };
  } catch (error) {
    if (
      error instanceof KairosApiError &&
      error.is(KAIROS_ERRORS.DELEGATION_PARTIAL_OVERLAP) &&
      error.context
    ) {
      return {
        outcome: "partial-overlap",
        context: error.context as unknown as PartialOverlapContext,
      };
    }
    throw error;
  }
}

export type RevokeResult =
  | { outcome: "revoked"; response: RevokeResponse }
  | { outcome: "unsynced-work"; context: UnsyncedWorkContext };

/**
 * Withdraw a delegation.
 *
 * Without `force`, a delegate with unpublished work produces a 409 naming what
 * is about to be stranded — but only if they have been reporting presence, which
 * is why `sendPresence` below is not optional.
 */
export async function revokeDelegation(
  client: KairosClient,
  planId: string,
  delegationId: string,
  reason: string,
  force = false
): Promise<RevokeResult> {
  try {
    const response = await client.delete<RevokeResponse>(
      `${plan(planId)}/delegations/${encodeURIComponent(delegationId)}${query({
        force: force ? 1 : null,
      })}`,
      { reason }
    );
    return { outcome: "revoked", response };
  } catch (error) {
    if (
      error instanceof KairosApiError &&
      error.is(KAIROS_ERRORS.DELEGATE_HAS_UNSYNCED_WORK) &&
      error.context
    ) {
      return {
        outcome: "unsynced-work",
        context: error.context as unknown as UnsyncedWorkContext,
      };
    }
    throw error;
  }
}

/** Change what a live delegation permits, without regranting it. */
export function amendDelegation(
  client: KairosClient,
  planId: string,
  delegationId: string,
  patch: Partial<
    Pick<DelegationCreate, "canEdit" | "canAddRows" | "canDeleteRows" | "canReadPii">
  >
): Promise<{ id: string; delegations: Delegation[] }> {
  return client.patch<{ id: string; delegations: Delegation[] }>(
    `${plan(planId)}/delegations/${encodeURIComponent(delegationId)}`,
    patch
  );
}

/**
 * "I'm finished with Rooms" — the delegate's own action.
 *
 * Removes the department from their WRITE scope and keeps it in their READ
 * scope, so they can still see what they produced. The delegation row survives,
 * which means reopening is one call and the audit lineage stays intact.
 * Idempotent.
 */
export function handBack(
  client: KairosClient,
  planId: string,
  departmentCode: string,
  note?: string
): Promise<unknown> {
  return client.post(
    `${plan(planId)}/delegations/me/departments/${encodeURIComponent(
      departmentCode
    )}/handback`,
    { note: note ?? null }
  );
}

/** The owner giving a handed-back department back to the same delegate. */
export function reopen(
  client: KairosClient,
  planId: string,
  delegationId: string,
  departmentCode: string,
  reason?: string
): Promise<unknown> {
  return client.post(
    `${plan(planId)}/delegations/${encodeURIComponent(
      delegationId
    )}/departments/${encodeURIComponent(departmentCode)}/reopen`,
    { reason: reason ?? null }
  );
}

/**
 * The grid's lock list — which departments this caller may read and write.
 *
 * ETag'd and cheap, so it is safe to call per render. `writable` is
 * authoritative: it IS the server's write predicate, so the grid can never
 * disagree with what a save will actually do.
 */
export async function fetchDepartmentOwnership(
  client: KairosClient,
  planId: string,
  etag: string | null
): Promise<{ ownership: DepartmentOwnership | null; etag: string | null }> {
  const response = await client.getConditional<DepartmentOwnership>(
    `${plan(planId)}/department-ownership`,
    etag
  );
  return {
    ownership: response.status === 304 ? null : response.body,
    etag: response.etag,
  };
}

/**
 * Report unpublished work.
 *
 * Send roughly every 60 seconds while the user has unsaved changes, and once
 * with `dirtyEntities: 0` after a successful publish. It pays for itself twice:
 * it is the ONLY way the server can warn an owner before a force-revoke, and it
 * backs the soft presence display.
 *
 * Advisory, never a lock. An offline-capable desktop client cannot hold a
 * pessimistic lock honestly and a crashed one would strand it forever; two
 * people editing the same department is a conflict resolved at commit time on
 * content hashes, not prevented here.
 *
 * Failures are swallowed: presence is a courtesy, and a user who cannot report
 * it must still be able to work.
 */
export async function sendPresence(
  client: KairosClient,
  planId: string,
  report: PresenceReport
): Promise<boolean> {
  try {
    await client.post(`${plan(planId)}/presence`, report, { noRetry: true });
    return true;
  } catch {
    return false;
  }
}

/** Who else is working on this plan right now, and on what. */
export function fetchActivity(client: KairosClient, planId: string): Promise<Activity> {
  return client.get<Activity>(`${plan(planId)}/activity`);
}
