/**
 * Kairos sync service (renderer side).
 * -----------------------------------------------------------
 * Relays the Sync and Delegation pages' calls to the main process. Unlike the
 * other services here, this one does NOT throw on failure: the interesting
 * errors on this surface carry a machine code and a `context` object that the UI
 * has to render — which departments will not take effect, whose unpublished work
 * is about to be stranded, who revoked your access and when — and an exception
 * flattens both away.
 *
 * So every call resolves to a `SyncOutcome`: `{ok: true, data}` or
 * `{ok: false, error: {code, status, message, context}}`. Callers branch on
 * `error.code`; `KAIROS_ERROR_CODES` below names the ones that mean something
 * other than "it failed".
 */

import {
  KAIROS_SYNC_CHANNELS,
  DelegationCreate,
  DelegationView,
  GrantOutcome,
  MyDelegationList,
  PendingByDepartment,
  PiiPullResponse,
  PlanSyncStatus,
  ProbeResponse,
  PublishPreviewResponse,
  PublishResponse,
  PullPreview,
  ReconcileResponse,
  RevokeOutcome,
  StructureDiffResponse,
  SyncOutcome,
  SyncStatusResponse,
} from "../shared/kairosSync/ipc";
import {
  AdminHotel,
  AdminPlanList,
  ArtifactList,
  AuditRow,
  BstPushEligibility,
  BstVersion,
  BstWorkbook,
  BundleOptions,
  BundleResult,
  Cluster,
  ClusterDivergence,
  Delegation,
  DelegatableDepartments,
  DelegationCandidates,
  DepartmentOwnership,
  HandbackResult,
  KpiSeriesRequest,
  KpiSeriesResponse,
  LeaseCreate,
  LeaseReleaseResult,
  LeaseResponse,
  OuSettings,
  PiiSummary,
  PlanSummary,
  PlanVersion,
  ScopeTrace,
  SupportDownload,
  Activity,
} from "../shared/kairosSync/protocol";

/**
 * Codes that are answers rather than failures. Anything not in here is worth
 * showing the user as an error; these need specific handling instead.
 */
export const KAIROS_ERROR_CODES = {
  /** Nothing published for this property yet — keep the local copy. */
  structureNotFound: "kairos_structure_not_found",
  bstNotFound: "kairos_bst_not_found",
  /** Show the owner which departments will not take effect, then retry. */
  partialOverlap: "kairos_delegation_partial_overlap",
  /** Retry with force, after telling the owner the work is not lost. */
  unsyncedWork: "kairos_delegate_has_unsynced_work",
  /** Persistent banner + Export. NEVER wipe local data. */
  revoked: "kairos_delegation_revoked",
  /** An administrator is holding the plan. Banner with the ticket reference. */
  lockedBySupport: "kairos_plan_locked_by_support",
  /** A full re-pull is required; the server's copy wins. */
  epochChanged: "kairos_sync_epoch_changed",
  /** The property refuses server-side storage of employee details. */
  piiDisabled: "kairos_pii_disabled_for_ou",
  /** Somebody else edited the hotel's columns. Reload and reapply. */
  structurePrecondition: "kairos_structure_precondition",
} as const;

function ipc() {
  const api = (window as unknown as { ipcApi?: { sendIpcRequest?: unknown } })?.ipcApi;
  if (!api?.sendIpcRequest) throw new Error("IPC API not available");
  return api as { sendIpcRequest: (channel: string, payload?: unknown) => Promise<unknown> };
}

/**
 * Send one request and normalise the two failure shapes into one.
 *
 * A handler that threw before it could build a `SyncOutcome` comes back as a
 * failed envelope; a handler that caught a server error comes back as a
 * successful envelope containing `{ok: false}`. Both are the same thing to a
 * caller, so they are flattened here rather than at every call site.
 */
async function call<T>(channel: string, payload?: unknown): Promise<SyncOutcome<T>> {
  try {
    const response = (await ipc().sendIpcRequest(channel, payload)) as {
      success?: boolean;
      error?: string;
      data?: SyncOutcome<T>;
    };
    if (response?.success === false) {
      return {
        ok: false,
        error: { code: "local", status: 0, message: response.error ?? "Sync failed" },
      };
    }
    return (
      response?.data ?? {
        ok: false,
        error: { code: "local", status: 0, message: "No response from the sync layer." },
      }
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "local",
        status: 0,
        message: error instanceof Error ? error.message : "Sync failed",
      },
    };
  }
}

// ------------------------------------------------------------------ the loop

/**
 * The probe. Call on app start, on window focus, and on a ~5-minute idle timer.
 *
 * Nothing else on this surface should be on a timer: `/changes` is triggered by
 * what this reports, and everything else is a user action.
 */
export function probe(ou: string): Promise<SyncOutcome<ProbeResponse>> {
  return call<ProbeResponse>(KAIROS_SYNC_CHANNELS.probe, { ou });
}

/** Everything the Sync page renders: local scenarios merged with server state. */
export function syncStatus(ou: string): Promise<SyncOutcome<SyncStatusResponse>> {
  return call<SyncStatusResponse>(KAIROS_SYNC_CHANNELS.status, { ou });
}

/** Register the current scenario as a plan. Idempotent on the scenario id. */
export function registerPlan(
  ou: string,
  planId: string
): Promise<SyncOutcome<PlanSummary>> {
  return call<PlanSummary>(KAIROS_SYNC_CHANNELS.registerPlan, { ou, planId });
}

/** Download and summarise, writing nothing. Show this before calling `pull`. */
export function previewPull(
  ou: string,
  planId: string
): Promise<
  SyncOutcome<
    PullPreview & { applied: boolean; reset: boolean; firstDownload: boolean }
  >
> {
  return call(KAIROS_SYNC_CHANNELS.previewPull, { ou, planId });
}

/**
 * Apply a pull.
 *
 * `replaceLocalPlanId` is the name-clash resolution and nothing else: pass the
 * `twinPlanId` the status call reported, and the local plan of that name is
 * soft-deleted once — and only once — the server's rows have landed.
 *
 * `createdLocalPlan` says the plan is now listed on this computer because this
 * download put it there — which can happen with `total: 0`, when the server
 * holds the plan but has no rows in it this caller had not already received.
 */
export function pull(
  ou: string,
  planId: string,
  replaceLocalPlanId?: string | null
): Promise<
  SyncOutcome<
    PullPreview & {
      applied: boolean;
      reset: boolean;
      replacedLocalPlan: boolean;
      createdLocalPlan: boolean;
      firstDownload: boolean;
      /**
       * Employee details, which travel on their own stream and are therefore
       * counted on their own. Null when the download was a preview.
       */
      pii: {
        applied: number;
        deleted: number;
        /** Records whose key has been erased. Not blanks — say so. */
        unreadable: number;
        /** The property has personal-data storage switched off. */
        disabled: boolean;
      } | null;
    }
  >
> {
  return call(KAIROS_SYNC_CHANNELS.pull, { ou, planId, replaceLocalPlanId });
}

/** What a publish would send, what it withholds, and what has no department. */
export function previewPublish(
  ou: string,
  planId: string
): Promise<SyncOutcome<PublishPreviewResponse>> {
  return call<PublishPreviewResponse>(KAIROS_SYNC_CHANNELS.previewPublish, {
    ou,
    planId,
  });
}

/**
 * Publish.
 *
 * A non-empty `rejected` is NOT a failed save — rejections are per row, and a
 * chunk carrying one illegal row still lands everything else. Report both, and
 * always surface `overrodeBase`.
 */
export function publish(
  ou: string,
  planId: string
): Promise<SyncOutcome<PublishResponse>> {
  return call<PublishResponse>(KAIROS_SYNC_CHANNELS.publish, { ou, planId });
}

/** Reconcile the shadow against the server. Weekly, and after any local rebuild. */
export function reconcile(
  ou: string,
  planId: string
): Promise<SyncOutcome<ReconcileResponse>> {
  return call<ReconcileResponse>(KAIROS_SYNC_CHANNELS.reconcile, { ou, planId });
}

/** Rebuild the shadow from the server — the recovery after a database rebuild. */
export function rebuildShadow(
  ou: string,
  planId: string
): Promise<SyncOutcome<{ planId: string; rows: number }>> {
  return call(KAIROS_SYNC_CHANNELS.rebuildShadow, { ou, planId });
}

// ----------------------------------------------------------------- structure

export function previewStructure(
  ou: string
): Promise<SyncOutcome<StructureDiffResponse & { applied: boolean }>> {
  return call(KAIROS_SYNC_CHANNELS.previewStructure, { ou });
}

export function pullStructure(
  ou: string
): Promise<SyncOutcome<StructureDiffResponse & { applied: boolean }>> {
  return call(KAIROS_SYNC_CHANNELS.pullStructure, { ou });
}

/** Owner-eligible only. Hide the action when `structureEditableByMe` is false. */
export function pushStructure(
  ou: string,
  structureVersion: number | null
): Promise<SyncOutcome<{ structureVersion: number; docHash: string }>> {
  return call(KAIROS_SYNC_CHANNELS.pushStructure, { ou, structureVersion });
}

// ---------------------------------------------------------------- delegation

/**
 * The grid's lock list. ETag'd server-side, so this is cheap enough to call on
 * every grid mount; `writable` is authoritative and cannot disagree with a save.
 *
 * `unconditional` bypasses `If-None-Match`, and belongs on a user action only.
 * It exists because the change that matters most here — a delegate handing a
 * department back — happens on somebody else's machine, so a viewer who
 * believes a lock is wrong has no other way to make this computer stop
 * believing its cache. Automatic paths must leave it off: the conditional
 * request is the cheapest thing in the feature and re-asking on every window
 * focus would make it the most expensive.
 */
export function departmentOwnership(
  ou: string,
  planId: string,
  options: { unconditional?: boolean } = {}
): Promise<SyncOutcome<DepartmentOwnership | null>> {
  return call<DepartmentOwnership | null>(KAIROS_SYNC_CHANNELS.departmentOwnership, {
    ou,
    planId,
    unconditional: options.unconditional === true,
  });
}

export function delegatableDepartments(
  ou: string,
  planId: string
): Promise<SyncOutcome<DelegatableDepartments>> {
  return call<DelegatableDepartments>(KAIROS_SYNC_CHANNELS.delegatableDepartments, {
    ou,
    planId,
  });
}

/** Candidates arrive WITH reasons when ineligible — render them, don't filter. */
export function delegationCandidates(
  ou: string,
  planId: string,
  q?: string
): Promise<SyncOutcome<DelegationCandidates>> {
  return call<DelegationCandidates>(KAIROS_SYNC_CHANNELS.delegationCandidates, {
    ou,
    planId,
    q,
  });
}

export function listDelegations(
  ou: string,
  planId: string
): Promise<SyncOutcome<{ planId: string; delegations: Delegation[] }>> {
  return call(KAIROS_SYNC_CHANNELS.listDelegations, { ou, planId });
}

/**
 * Across every hotel, including delegations revoked in the last 30 days.
 *
 * `MyDelegation`, NOT `Delegation` — a different shape for a different question.
 * This is the delegate's view, keyed by plan, so it carries `ou`, `year` and
 * `label` and is the only call that can say "that plan is at another hotel".
 */
export function myDelegations(): Promise<SyncOutcome<MyDelegationList>> {
  return call<MyDelegationList>(KAIROS_SYNC_CHANNELS.myDelegations, {});
}

/**
 * My unpublished rows, by department. Local read — no network, works offline.
 *
 * The check the handback routes do not do for a single department. Uses the same
 * hash comparison as the Publish badge, so the two cannot disagree.
 */
export function pendingByDepartment(
  ou: string,
  planId: string
): Promise<SyncOutcome<PendingByDepartment>> {
  return call<PendingByDepartment>(KAIROS_SYNC_CHANNELS.pendingByDepartment, {
    ou,
    planId,
  });
}

/**
 * Grant a delegation.
 *
 * `{outcome: "partial-overlap"}` is a QUESTION, not a failure: show the owner
 * `context.nonOverlapping` and re-call with `acknowledgeNonOverlap: true` only
 * if they confirm.
 */
export function grantDelegation(
  ou: string,
  planId: string,
  body: DelegationCreate
): Promise<SyncOutcome<GrantOutcome>> {
  return call<GrantOutcome>(KAIROS_SYNC_CHANNELS.grantDelegation, { ou, planId, body });
}

export function amendDelegation(
  ou: string,
  planId: string,
  delegationId: string,
  patch: Partial<DelegationCreate>
): Promise<SyncOutcome<{ delegations: Delegation[] }>> {
  return call(KAIROS_SYNC_CHANNELS.amendDelegation, {
    ou,
    planId,
    delegationId,
    patch,
  });
}

/**
 * Withdraw a delegation.
 *
 * `{outcome: "unsynced-work"}` means the delegate has unpublished changes. Tell
 * the owner plainly that the work is not lost but cannot be published unless
 * they re-grant, then re-call with `force: true` if they still want to.
 */
export function revokeDelegation(
  ou: string,
  planId: string,
  delegationId: string,
  reason: string,
  force = false
): Promise<SyncOutcome<RevokeOutcome>> {
  return call<RevokeOutcome>(KAIROS_SYNC_CHANNELS.revokeDelegation, {
    ou,
    planId,
    delegationId,
    reason,
    force,
  });
}

/**
 * Publish deliberately over the server's copy.
 *
 * Use only where the user has explicitly chosen "keep mine". It fetches the
 * server's current hashes first and sends those as `baseHash`, which is the
 * protocol's own two-step overwrite — there is no force flag, on purpose, so
 * that overwriting is an informed act rather than an accident.
 *
 * Two things it cannot override, whatever the user chose: a server tombstone
 * still wins over a live local row, and a delegate's writes still stay inside
 * their departments.
 */
export function publishOverServer(
  ou: string,
  planId: string
): Promise<SyncOutcome<PublishResponse>> {
  return call<PublishResponse>(KAIROS_SYNC_CHANNELS.publishOverServer, { ou, planId });
}

/** "I'm done with this department." Keeps read access; the grant survives. */
export function handBack(
  ou: string,
  planId: string,
  departmentCode: string,
  note?: string
): Promise<SyncOutcome<unknown>> {
  return call(KAIROS_SYNC_CHANNELS.handBack, { ou, planId, departmentCode, note });
}

/**
 * "I'm done with all of it." Every ACTIVE department, one handover.
 *
 * Unlike the per-department form this DOES check for unpublished work, because
 * handing everything back is the moment that work becomes unpublishable. A
 * `kairos_handback_with_unsynced_work` carries `dirtyEntities` and the
 * departments — show them, then re-call with `force: true` if they still want to.
 * The delegation survives either way; this is not a revocation.
 */
export function handBackAll(
  ou: string,
  planId: string,
  force = false
): Promise<SyncOutcome<HandbackResult>> {
  return call<HandbackResult>(KAIROS_SYNC_CHANNELS.handBackAll, { ou, planId, force });
}

export function reopenDepartment(
  ou: string,
  planId: string,
  delegationId: string,
  departmentCode: string,
  reason?: string
): Promise<SyncOutcome<unknown>> {
  return call(KAIROS_SYNC_CHANNELS.reopenDepartment, {
    ou,
    planId,
    delegationId,
    departmentCode,
    reason,
  });
}

/**
 * Report unpublished work, roughly every 60 seconds while there is any.
 *
 * Advisory and never a lock — but it is the only way the server can warn an
 * owner before a force-revoke, so it is not optional.
 */
export function presence(
  ou: string,
  planId: string,
  dirtyEntities: number,
  departments: string[],
  lastLocalEditAt: string | null
): Promise<SyncOutcome<{ sent: boolean }>> {
  return call(KAIROS_SYNC_CHANNELS.presence, {
    ou,
    planId,
    dirtyEntities,
    departments,
    lastLocalEditAt,
  });
}

export function activity(
  ou: string,
  planId: string
): Promise<SyncOutcome<Activity>> {
  return call<Activity>(KAIROS_SYNC_CHANNELS.activity, { ou, planId });
}

/** The Delegation page's whole view, in three calls resolved together. */
export async function delegationView(
  ou: string,
  planId: string
): Promise<DelegationView> {
  const [delegations, departments, ownership] = await Promise.all([
    listDelegations(ou, planId),
    delegatableDepartments(ou, planId),
    departmentOwnership(ou, planId),
  ]);
  return {
    planId,
    delegations: delegations.ok ? delegations.data.delegations : [],
    departments: departments.ok ? departments.data.departments : [],
    ownership: ownership.ok ? ownership.data : null,
  };
}

// ----------------------------------------------------------------------- pii

export function piiSummary(
  ou: string,
  planId: string
): Promise<SyncOutcome<PiiSummary>> {
  return call<PiiSummary>(KAIROS_SYNC_CHANNELS.piiSummary, { ou, planId });
}

export function pullPii(
  ou: string,
  planId: string,
  apply = false
): Promise<SyncOutcome<PiiPullResponse>> {
  return call<PiiPullResponse>(KAIROS_SYNC_CHANNELS.pullPii, { ou, planId, apply });
}

/** Owner-only and irreversible: it destroys the plan's data keys. */
export function erasePii(
  ou: string,
  planId: string,
  reason: string
): Promise<SyncOutcome<{ rowsErased: number; keysDestroyed: number }>> {
  return call(KAIROS_SYNC_CHANNELS.erasePii, { ou, planId, reason });
}

/** The property's personal-data kill switch. Check before a first publish. */
export function ouSettings(ou: string): Promise<SyncOutcome<OuSettings>> {
  return call<OuSettings>(KAIROS_SYNC_CHANNELS.ouSettings, { ou });
}

// ----------------------------------------------------------------------- bst

export function bstVersion(ou: string): Promise<SyncOutcome<BstVersion | null>> {
  return call<BstVersion | null>(KAIROS_SYNC_CHANNELS.bstVersion, { ou });
}

export function pushBst(
  ou: string,
  knownContentHash?: string | null
): Promise<SyncOutcome<{ outcome: string; rows?: number; max?: number }>> {
  return call(KAIROS_SYNC_CHANNELS.pushBst, { ou, knownContentHash });
}

export function pullBst(ou: string): Promise<SyncOutcome<BstWorkbook | null>> {
  return call<BstWorkbook | null>(KAIROS_SYNC_CHANNELS.pullBst, { ou });
}

/**
 * Twelve numbers for a KPI driver, computed server-side.
 *
 * `*` is the only wildcard in `deptPatterns` — `%` and `_` match literally. The
 * caller's department scope is ANDed in on top, so a partially-scoped user gets
 * a partial total; gate on `scope.kind`.
 */
export function kpiSeries(
  ou: string,
  request: KpiSeriesRequest
): Promise<SyncOutcome<KpiSeriesResponse>> {
  return call<KpiSeriesResponse>(KAIROS_SYNC_CHANNELS.kpiSeries, { ou, request });
}

/** Call before enabling the BST push page, and render every reason it returns. */
export function pushEligibility(
  ou: string,
  planId: string
): Promise<SyncOutcome<BstPushEligibility>> {
  return call<BstPushEligibility>(KAIROS_SYNC_CHANNELS.pushEligibility, { ou, planId });
}

export function logBstPush(
  ou: string,
  planId: string,
  entry: {
    targetFile: string;
    rowsWritten: number;
    backupTaken: boolean;
    monthPlan?: Record<string, unknown> | null;
  }
): Promise<SyncOutcome<{ logged: boolean }>> {
  return call(KAIROS_SYNC_CHANNELS.logBstPush, { ou, planId, ...entry });
}

// ----------------------------------------------------------------- artifacts

/** Null when the caller is a delegate — hide the surface rather than erroring. */
export function artifacts(
  ou: string,
  planId: string
): Promise<SyncOutcome<ArtifactList | null>> {
  return call<ArtifactList | null>(KAIROS_SYNC_CHANNELS.artifacts, { ou, planId });
}

export function pushEngineOutput(
  ou: string,
  planId: string
): Promise<SyncOutcome<{ outcome: string; bytes?: number }>> {
  return call(KAIROS_SYNC_CHANNELS.pushEngineOutput, { ou, planId });
}

// ------------------------------------------------------------------ clusters

export function clusters(): Promise<
  SyncOutcome<{ clusters: Cluster[] | null; version: number }>
> {
  return call(KAIROS_SYNC_CHANNELS.clusters, {});
}

/** Advisory. `omittedCount > 0` means this is about PART of the cluster. */
export function clusterDivergence(
  clusterId: string,
  year: number
): Promise<SyncOutcome<ClusterDivergence>> {
  return call<ClusterDivergence>(KAIROS_SYNC_CHANNELS.clusterDivergence, {
    clusterId,
    year,
  });
}

// --------------------------------------------------------------- plan admin

/** The cheapest single-plan probe: version, epoch, state and your relation. */
export function planVersion(
  ou: string,
  planId: string
): Promise<SyncOutcome<PlanVersion>> {
  return call<PlanVersion>(KAIROS_SYNC_CHANNELS.planVersion, { ou, planId });
}

/**
 * Hand the plan to somebody else. An OWNER capability — no administrator needed.
 *
 * The successor must meet the full ownership bar, and a refusal comes back as
 * `kairos_owner_not_eligible` carrying a `context.required` block naming exactly
 * what they are missing. Render it; a generic "no" is unactionable.
 */
export function transferPlan(
  ou: string,
  planId: string,
  newOwnerUserId: number,
  reason: string
): Promise<SyncOutcome<unknown>> {
  return call(KAIROS_SYNC_CHANNELS.transferPlan, {
    ou,
    planId,
    newOwnerUserId,
    reason,
  });
}

export function patchPlan(
  ou: string,
  planId: string,
  patch: { label?: string; state?: "ACTIVE" | "ARCHIVED" }
): Promise<SyncOutcome<PlanSummary>> {
  return call<PlanSummary>(KAIROS_SYNC_CHANNELS.patchPlan, { ou, planId, ...patch });
}

/** Soft delete — recoverable by support, which is why it is not a hard one. */
export function deletePlan(ou: string, planId: string): Promise<SyncOutcome<unknown>> {
  return call(KAIROS_SYNC_CHANNELS.deletePlan, { ou, planId });
}

/**
 * Purge this computer's copy of a plan the server will not share with us.
 *
 * The opposite of `deletePlan` in every respect: local rather than server-side,
 * hard rather than soft, and with no support-side undo — the server does not
 * acknowledge the plan to this user at all. Only offered on a copy the automatic
 * sweep spared because it holds unpublished work.
 */
export function discardLocalPlan(
  ou: string,
  planId: string
): Promise<SyncOutcome<{ planId: string }>> {
  return call(KAIROS_SYNC_CHANNELS.discardLocalPlan, { ou, planId });
}

// -------------------------------------------------------------------- lease

/** Readable by the hotel, so a 423 on save can be explained rather than retried. */
export function lease(
  ou: string,
  planId: string
): Promise<SyncOutcome<LeaseResponse | null>> {
  return call<LeaseResponse | null>(KAIROS_SYNC_CHANNELS.lease, { ou, planId });
}

/** `EXCLUSIVE` is the only mode that confers write, and it locks the owner out. */
export function acquireLease(
  ou: string,
  planId: string,
  request: LeaseCreate
): Promise<SyncOutcome<LeaseResponse>> {
  return call<LeaseResponse>(KAIROS_SYNC_CHANNELS.acquireLease, {
    ou,
    planId,
    lease: request,
  });
}

export function extendLease(
  ou: string,
  planId: string,
  minutes: number
): Promise<SyncOutcome<LeaseResponse>> {
  return call<LeaseResponse>(KAIROS_SYNC_CHANNELS.extendLease, { ou, planId, minutes });
}

/** Bumps `syncEpoch` — every client at the property will full-refresh. Say so. */
export function releaseLease(
  ou: string,
  planId: string,
  summary: string
): Promise<SyncOutcome<LeaseReleaseResult>> {
  return call<LeaseReleaseResult>(KAIROS_SYNC_CHANNELS.releaseLease, {
    ou,
    planId,
    summary,
  });
}

// ----------------------------------------------------------- administration

/**
 * Am I an administrator?
 *
 * Answered by making an admin-only request and reading the status code, because
 * this client has no other source of truth about the signed-in user's role. That
 * also makes the answer expire correctly: an administrator whose role is removed
 * fails the next probe rather than keeping an unlocked screen.
 */
export function adminProbe(): Promise<SyncOutcome<{ isAdmin: boolean }>> {
  return call<{ isAdmin: boolean }>(KAIROS_SYNC_CHANNELS.adminProbe, {});
}

export function adminHotels(): Promise<SyncOutcome<AdminHotel[]>> {
  return call<AdminHotel[]>(KAIROS_SYNC_CHANNELS.adminHotels, {});
}

export function adminPlans(filters: {
  ou?: string | null;
  year?: number | null;
  ownerIneligible?: boolean | null;
  limit?: number | null;
  offset?: number | null;
}): Promise<SyncOutcome<AdminPlanList>> {
  return call<AdminPlanList>(KAIROS_SYNC_CHANNELS.adminPlans, filters);
}

export function adminAudit(filters: {
  planId?: string | null;
  action?: string | null;
  limit?: number | null;
}): Promise<SyncOutcome<AuditRow[]>> {
  return call<AuditRow[]>(KAIROS_SYNC_CHANNELS.adminAudit, filters);
}

/** Deliberately readable by any administrator: a control only its own subject
 *  can inspect is not a control. */
export function adminDownloads(filters: {
  planId?: string | null;
  limit?: number | null;
}): Promise<SyncOutcome<SupportDownload[]>> {
  return call<SupportDownload[]>(KAIROS_SYNC_CHANNELS.adminDownloads, filters);
}

/** The resolver explaining itself, step by step, for one user. */
export function adminUserScope(
  userId: number,
  planId: string | null,
  capability: string | null
): Promise<SyncOutcome<ScopeTrace>> {
  return call<ScopeTrace>(KAIROS_SYNC_CHANNELS.adminUserScope, {
    userId,
    planId,
    capability,
  });
}

/** Saved to the Downloads folder. Rate limited to 20/day across the estate. */
export function adminBundle(
  options: BundleOptions
): Promise<SyncOutcome<BundleResult>> {
  return call<BundleResult>(KAIROS_SYNC_CHANNELS.adminBundle, options);
}

/** The property's personal-data kill switch. Administrators only. */
export function putOuSettings(
  ou: string,
  piiEnabled: boolean,
  reason: string
): Promise<SyncOutcome<OuSettings>> {
  return call<OuSettings>(KAIROS_SYNC_CHANNELS.putOuSettings, {
    ou,
    piiEnabled,
    reason,
  });
}

export type { PlanSyncStatus, SyncOutcome };
