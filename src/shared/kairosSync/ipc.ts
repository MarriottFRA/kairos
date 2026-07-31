/**
 * Kairos sync — IPC channels and the renderer-facing shapes.
 * -----------------------------------------------------------
 * The single contract imported by both the renderer service and the
 * main-process handlers, same as every other feature here.
 *
 * The renderer never sees a `KairosApiError`: an IPC boundary flattens an
 * exception to its message, which would lose the machine code and the `context`
 * object that three flows are required to render. So the handlers catch and
 * return a `SyncError` shape, and the renderer branches on `code`.
 *
 * Nothing on this surface polls. `sync:probe` is called on app start, on window
 * focus and on a ~5-minute idle timer; everything else is a user action or is
 * triggered by what the probe reported.
 */

import {
  Activity,
  ArtifactList,
  BstPushEligibility,
  BstVersion,
  Cluster,
  CommitConflict,
  CommitRejection,
  DelegatableDepartment,
  Delegation,
  DelegationCandidate,
  DelegationCreate,
  DepartmentOwnership,
  KpiSeriesRequest,
  KpiSeriesResponse,
  LeaseResponse,
  PartialOverlapContext,
  PiiSummary,
  PlanHead,
  PlanSummary,
  Relation,
  ScopeReport,
  UnsyncedWorkContext,
} from "./protocol";
import { StructureChange } from "./structureDoc";

export const KAIROS_SYNC_CHANNELS = {
  /** GET /sync/heads — the probe. The ONLY thing that runs on a timer. */
  probe: "kairosSync:probe",
  /** Plans at the selected property, merged with what we hold locally. */
  status: "kairosSync:status",
  /** Register the current scenario as a plan. Idempotent on the scenario id. */
  registerPlan: "kairosSync:registerPlan",
  /** Preview a pull: counts and tombstones, nothing written. */
  previewPull: "kairosSync:previewPull",
  /** Apply a pull. */
  pull: "kairosSync:pull",
  /** Preview a publish: what would be sent, what is withheld and why. */
  previewPublish: "kairosSync:previewPublish",
  /** Publish. */
  publish: "kairosSync:publish",
  /** Reconcile the shadow against the server's manifest. */
  reconcile: "kairosSync:reconcile",
  /** Rebuild the shadow from the server — the post-rebuild recovery path. */
  rebuildShadow: "kairosSync:rebuildShadow",

  /** GET /ou/{ou}/structure, as a diff. */
  previewStructure: "kairosSync:previewStructure",
  /** Apply the pulled structure document. */
  pullStructure: "kairosSync:pullStructure",
  /** PUT /ou/{ou}/structure. Owner-eligible only. */
  pushStructure: "kairosSync:pushStructure",

  /** The grid's lock list. ETag'd — safe to call per render. */
  departmentOwnership: "kairosSync:departmentOwnership",
  delegatableDepartments: "kairosSync:delegatableDepartments",
  delegationCandidates: "kairosSync:delegationCandidates",
  listDelegations: "kairosSync:listDelegations",
  myDelegations: "kairosSync:myDelegations",
  grantDelegation: "kairosSync:grantDelegation",
  amendDelegation: "kairosSync:amendDelegation",
  revokeDelegation: "kairosSync:revokeDelegation",
  handBack: "kairosSync:handBack",
  reopenDepartment: "kairosSync:reopenDepartment",
  presence: "kairosSync:presence",
  activity: "kairosSync:activity",

  piiSummary: "kairosSync:piiSummary",
  pullPii: "kairosSync:pullPii",
  erasePii: "kairosSync:erasePii",
  ouSettings: "kairosSync:ouSettings",

  bstVersion: "kairosSync:bstVersion",
  pushBst: "kairosSync:pushBst",
  pullBst: "kairosSync:pullBst",
  kpiSeries: "kairosSync:kpiSeries",
  pushEligibility: "kairosSync:pushEligibility",
  logBstPush: "kairosSync:logBstPush",

  artifacts: "kairosSync:artifacts",
  pushEngineOutput: "kairosSync:pushEngineOutput",

  clusters: "kairosSync:clusters",
  clusterDivergence: "kairosSync:clusterDivergence",
  lease: "kairosSync:lease",
} as const;

/**
 * A failure that survived the IPC boundary with its meaning intact.
 *
 * `code` is the server's machine code (or `local` for something that never
 * reached the network). `context` carries the payload of the three errors the UI
 * must render in full.
 */
export interface SyncError {
  code: string;
  status: number;
  message: string;
  context?: Record<string, unknown>;
}

/** Every handler returns this so the renderer has one branch, not two. */
export type SyncOutcome<T> = { ok: true; data: T } | { ok: false; error: SyncError };

/**
 * Narrow a `SyncOutcome` to its failure arm.
 *
 * An explicit guard rather than a bare `if (!result.ok)`: this project compiles
 * without `strict`, and without `strictNullChecks` TypeScript does not reliably
 * narrow the union from the discriminant alone — so `result.error` reads as
 * possibly-absent at every call site. One guard fixes that everywhere instead of
 * a cast per consumer.
 */
export function syncFailed<T>(
  result: SyncOutcome<T>
): result is { ok: false; error: SyncError } {
  return result.ok === false;
}

/** One plan, as the Sync page sees it: the server's view plus ours. */
export interface PlanSyncStatus {
  planId: string;
  ou: string;
  year: number;
  label: string;
  /** Absent server-side — the scenario exists locally but was never published. */
  published: boolean;
  serverVersion: number;
  watermark: number;
  relation: Relation | null;
  scopeKind: "FULL" | "PARTIAL" | null;
  departments: string[] | null;
  /** false → a demoted owner: hide the blocks/allocations/KPI/SS editors. */
  structureEditable: boolean;
  handbacksPending: number;
  lastPublishedAt: string | null;
  lastPulledAt: string | null;
  /** Rows changed locally since the last publish. Drives the Publish button. */
  pendingChanges: number;
  /** Set while a revoked-delegation banner should be shown. Never auto-cleared. */
  revoked: Record<string, unknown> | null;
}

export interface SyncStatusResponse {
  ou: string;
  /** null when the property has never been probed in this session. */
  authzVersion: number | null;
  plans: PlanSyncStatus[];
  structureVersion: number;
  /** The property's personal-data kill switch, from GET /ou/{ou}/settings. */
  piiEnabled: boolean | null;
  bst: { importId: string; contentHash: string; importedAt: string } | null;
  clustersVersion: number;
  /** True when the last probe was a 304 — nothing at this property has moved. */
  upToDate: boolean;
}

export interface ProbeResponse {
  ou: string;
  notModified: boolean;
  authzVersion: number | null;
  /** Plans whose server version is ahead of our watermark. */
  stale: PlanHead[];
  /** A support lease was handed back somewhere; a full re-pull is coming. */
  epochMoved: boolean;
}

export interface PullPreview {
  planId: string;
  fromVersion: number;
  toVersion: number;
  scope: ScopeReport;
  byType: Record<string, number>;
  deletedByType: Record<string, number>;
  total: number;
  deleted: number;
  /** Types this build does not understand — the server is newer than we are. */
  skippedTypes: string[];
}

export interface PublishPreviewResponse {
  planId: string;
  byType: Record<string, number>;
  total: number;
  chunks: number;
  /** Rows outside the caller's write scope. Shown, not silently dropped. */
  withheld: Array<{ entityType: string; entityId: string; department: string | null }>;
  /** Rows with no department: owner-only, and never delegatable. */
  unclassified: Array<{ entityType: string; entityId: string }>;
}

export interface PublishResponse {
  planId: string;
  committedVersion: number;
  accepted: number;
  unchanged: number;
  /** Re-grant overrides. Render these — correct is not the same as silent. */
  overrodeBase: number;
  conflicts: CommitConflict[];
  rejected: CommitRejection[];
  withheld: number;
  purged: number;
  noop: boolean;
}

export interface StructureDiffResponse {
  ou: string;
  /** null when the property has published nothing — keep the local copy. */
  serverVersion: number | null;
  changes: StructureChange[];
  notModified: boolean;
}

export interface ReconcileResponse {
  planId: string;
  matched: number;
  needed: number;
  toPull: number;
  toPurge: number;
  tombstones: number;
  truncated: boolean;
  suggestFullPull: boolean;
}

export interface DelegationView {
  planId: string;
  delegations: Delegation[];
  departments: DelegatableDepartment[];
  ownership: DepartmentOwnership | null;
}

export type GrantOutcome =
  | { outcome: "granted"; delegations: Delegation[] }
  | { outcome: "partial-overlap"; context: PartialOverlapContext };

export type RevokeOutcome =
  | { outcome: "revoked"; unsyncedAtRevoke: boolean; warning: string | null }
  | { outcome: "unsynced-work"; context: UnsyncedWorkContext };

export interface PiiPullResponse {
  planId: string;
  rows: number;
  applied: number;
  deleted: number;
  /** Records whose key is gone. "Erased", never "empty". */
  unreadable: number;
  disabled: boolean;
}

// Request shapes, so the renderer service and the handlers agree on arguments.

export interface PlanRequest {
  ou: string;
  planId: string;
}

export interface PullRequest extends PlanRequest {
  apply?: boolean;
}

export interface GrantRequest extends PlanRequest {
  body: DelegationCreate;
}

export interface RevokeRequest extends PlanRequest {
  delegationId: string;
  reason: string;
  force?: boolean;
}

export interface HandbackRequest extends PlanRequest {
  departmentCode: string;
  note?: string;
}

export interface ReopenRequest extends PlanRequest {
  delegationId: string;
  departmentCode: string;
  reason?: string;
}

export interface PresenceRequest extends PlanRequest {
  dirtyEntities: number;
  departments: string[];
  lastLocalEditAt: string | null;
}

export interface KpiSeriesIpcRequest {
  ou: string;
  request: KpiSeriesRequest;
}

// Re-exported so the renderer imports one module rather than two.
export type {
  Activity,
  ArtifactList,
  BstPushEligibility,
  BstVersion,
  Cluster,
  DelegatableDepartment,
  Delegation,
  DelegationCandidate,
  DelegationCreate,
  DepartmentOwnership,
  KpiSeriesResponse,
  LeaseResponse,
  PiiSummary,
  PlanSummary,
  ScopeReport,
  StructureChange,
};
