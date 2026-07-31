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
  ArtifactList,
  BstPushEligibility,
  BstVersion,
  BstWorkbook,
  Cluster,
  ClusterDivergence,
  Delegation,
  DelegatableDepartments,
  DelegationCandidates,
  DepartmentOwnership,
  KpiSeriesRequest,
  KpiSeriesResponse,
  LeaseResponse,
  OuSettings,
  PiiSummary,
  PlanSummary,
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
): Promise<SyncOutcome<PullPreview & { applied: boolean; reset: boolean }>> {
  return call(KAIROS_SYNC_CHANNELS.previewPull, { ou, planId });
}

export function pull(
  ou: string,
  planId: string
): Promise<SyncOutcome<PullPreview & { applied: boolean; reset: boolean }>> {
  return call(KAIROS_SYNC_CHANNELS.pull, { ou, planId });
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
 */
export function departmentOwnership(
  ou: string,
  planId: string
): Promise<SyncOutcome<DepartmentOwnership | null>> {
  return call<DepartmentOwnership | null>(KAIROS_SYNC_CHANNELS.departmentOwnership, {
    ou,
    planId,
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

/** Across every hotel, including delegations revoked in the last 30 days. */
export function myDelegations(): Promise<SyncOutcome<{ delegations: Delegation[] }>> {
  return call(KAIROS_SYNC_CHANNELS.myDelegations, {});
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

/** "I'm done with this department." Keeps read access; the grant survives. */
export function handBack(
  ou: string,
  planId: string,
  departmentCode: string,
  note?: string
): Promise<SyncOutcome<unknown>> {
  return call(KAIROS_SYNC_CHANNELS.handBack, { ou, planId, departmentCode, note });
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

/** Readable by the hotel, so a 423 on save can be explained rather than retried. */
export function lease(
  ou: string,
  planId: string
): Promise<SyncOutcome<LeaseResponse | null>> {
  return call<LeaseResponse | null>(KAIROS_SYNC_CHANNELS.lease, { ou, planId });
}

export type { PlanSyncStatus, SyncOutcome };
