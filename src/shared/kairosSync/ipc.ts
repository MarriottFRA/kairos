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
  MyDelegation,
  MyDelegationList,
  PartialOverlapContext,
  PiiSummary,
  PlanHead,
  PlanSummary,
  Relation,
  ScopeReport,
  UnsyncedWorkContext,
  WriteScopeKind,
} from "./protocol";
import { PlanDelegationSummary } from "./delegationSummary";
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
  /**
   * Publish deliberately over the server's copy.
   *
   * The protocol has no client-asserted force flag, on purpose. To overwrite you
   * fetch the server's current hashes and send those as `baseHash`, which makes
   * an overwrite two informed steps rather than one accidental one. That is
   * exactly what this does — adopt the manifest, then publish — so it is a
   * sequence of ordinary calls, not a privilege.
   */
  publishOverServer: "kairosSync:publishOverServer",
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
  /** Every ACTIVE department at once. Unlike the single form, this checks for
   *  unpublished work and 409s unless forced. */
  handBackAll: "kairosSync:handBackAll",
  reopenDepartment: "kairosSync:reopenDepartment",
  /** My unpublished rows by department. Local read, no network. */
  pendingByDepartment: "kairosSync:pendingByDepartment",
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

  // ----------------------------------------------------------------- plan admin
  /** GET /plans/{id}/version — the cheapest single-plan probe. */
  planVersion: "kairosSync:planVersion",
  /** Owner-callable, not admin-only: `plan:transfer` is an OWNER capability. */
  transferPlan: "kairosSync:transferPlan",
  /** Label and ACTIVE/ARCHIVED. LOCKED_BY_SUPPORT is set by the lease, not here. */
  patchPlan: "kairosSync:patchPlan",
  /** Soft delete — the rows survive server-side so support can recover it. */
  deletePlan: "kairosSync:deletePlan",
  /**
   * Purge this computer's copy of a plan the server no longer shares with us.
   *
   * Local only — it sends no request, and could not: the server refuses to
   * discuss the plan at all, which is precisely why the copy has to go. A hard
   * purge, not the soft delete `deletePlan` performs, because a soft delete
   * leaves every position and PII sidecar live in the encrypted store.
   *
   * Normally automatic: the status call sweeps any unreadable plan with no
   * unpublished work. This channel is the manual form for the one case the sweep
   * spares — a copy with local changes in it, kept in case the owner delegates
   * again.
   */
  discardLocalPlan: "kairosSync:discardLocalPlan",

  // --------------------------------------------------------------------- lease
  lease: "kairosSync:lease",
  acquireLease: "kairosSync:acquireLease",
  extendLease: "kairosSync:extendLease",
  releaseLease: "kairosSync:releaseLease",

  // ------------------------------------------------------------- administration
  /**
   * "Am I an administrator?" — answered by making an admin-only request and
   * believing the status code. There is no client-side claim to forge, which is
   * what makes the Settings switch safe to expose to everybody.
   */
  adminProbe: "kairosSync:adminProbe",
  adminHotels: "kairosSync:adminHotels",
  adminPlans: "kairosSync:adminPlans",
  adminAudit: "kairosSync:adminAudit",
  adminDownloads: "kairosSync:adminDownloads",
  adminUserScope: "kairosSync:adminUserScope",
  adminBundle: "kairosSync:adminBundle",
  /** PUT /ou/{ou}/settings — the PII kill switch. Administrators only. */
  putOuSettings: "kairosSync:putOuSettings",
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
  /**
   * The server will answer every read of this plan with 403.
   *
   * Derived once, here, from the relation's capability entry — so no card
   * re-derives it and no two disagree. False means an `OU_VISITOR` entry: the
   * plan is discoverable and nothing about its contents is populated, which is
   * why the counters above it are all zero rather than merely small.
   */
  readable: boolean;
  scopeKind: "FULL" | "PARTIAL" | null;
  departments: string[] | null;
  /**
   * How much of the plan this user may WRITE, which the relation cannot answer.
   *
   * A `canEdit: false` delegation resolves as a plain `DELEGATE` server-side and
   * strips every write capability underneath it, so the relation alone would
   * offer a Publish button that only ever 403s. `NONE` on a `DELEGATE` is a
   * read-only share; on an owner it means every department is delegated away.
   * `UNKNOWN` means `/department-ownership` has not been consulted yet.
   */
  writeScope: WriteScopeKind;
  /** false → a demoted owner: hide the blocks/allocations/KPI/SS editors. */
  structureEditable: boolean;
  handbacksPending: number;
  /**
   * Who holds what, from the LAST `/department-ownership` answer.
   *
   * Derived in the status handler from the cache it already reads for
   * `writeScope`, so this costs no request. `stale: true` means that call has
   * never run for this plan; see `PlanDelegationSummary`.
   *
   * Deliberately carries no timestamp. `/department-ownership` reports who holds
   * a department and in what state, and nothing about when it moved —
   * `handedBackAt` lives on `Delegation.departments[]`, which only an owner can
   * fetch. A guessed time here would be the one fact on the card that could be
   * wrong, so the Sync page says who and which, and the Delegation page says
   * when.
   */
  delegation: PlanDelegationSummary | null;
  lastPublishedAt: string | null;
  lastPulledAt: string | null;
  /** Rows changed locally since the last publish. Drives the Publish button. */
  pendingChanges: number;
  /** Set while a revoked-delegation banner should be shown. Never auto-cleared. */
  revoked: Record<string, unknown> | null;
  /**
   * False when the server holds this plan and this computer does not.
   *
   * A new machine, or a delegation on a plan somebody else created. The page
   * used to be built from the local `scenarios` table alone, so such a plan was
   * invisible and the only action on offer was "publish" — which for a delegate
   * means POST /plans, a create they are not eligible to make.
   */
  onThisComputer: boolean;
  /** Who owns it. Only resolved for plans this computer does not hold. */
  ownerEmail: string | null;
  /** Rows the server holds. Only resolved for plans this computer does not hold. */
  serverRows: number;
  /**
   * A DIFFERENT plan of the same year and name on the other side.
   *
   * Set on both halves of the pair. The ids differ, so these are two plans and
   * no amount of matching makes them one — but publishing the local one would
   * put a second plan of the same name on the server, which is never what
   * somebody who has just moved machine wants.
   */
  twinPlanId: string | null;
  /**
   * Whether the twin on the other side can actually be downloaded.
   *
   * The name-clash advice is "download the server's copy instead — it replaces
   * this one". When the clashing plan belongs to somebody else and is not shared
   * with you, that advice cannot be followed and the only way out is to rename
   * this one. Two different sentences, so the card has to know which.
   */
  twinReadable: boolean;
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
  /**
   * Plans removed from this computer because the server no longer shares them.
   *
   * Access to the hotel is no longer access to a colleague's plan, so a copy
   * pulled under the old rules — or one whose delegation has been withdrawn — is
   * data this machine has no business holding. It is purged outright, not
   * soft-deleted, unless there is unpublished work in it, in which case it is
   * left alone and frozen instead.
   *
   * Reported so the page can say what happened. A plan disappearing with no
   * explanation reads to a user as data loss.
   */
  removed: Array<{ planId: string; label: string; ownerEmail: string | null }>;
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
  /**
   * Incoming rows that would land on top of local work that is not published.
   *
   * The case this exists for is routine and looks alarming without it: an owner
   * who has delegated Rooms edits F&B, the delegate publishes Rooms, and both
   * sides are now "ahead". The plan reads as DIVERGED and the user is offered a
   * two-way review — but the two sets cannot touch, because a delegate writes
   * only inside their own departments. Intersecting the ids proves it, so a
   * download that overwrites nothing can say so instead of implying a choice.
   *
   * Zero with `total > 0` is the safe case. Non-zero is the one that deserves
   * the warning the dialog currently gives unconditionally.
   */
  collides: number;
  /** Departments the colliding rows are in, for naming them. */
  collidingDepartments: string[];
  /**
   * Incoming rows by department — WHERE the download lands, not just how much.
   *
   * The question an owner collecting a delegate's finished work is actually
   * asking. Rows with no department are counted under `UNCLASSIFIED_DEPARTMENT`
   * rather than dropped, so the breakdown always sums to `total`; a list that
   * silently does not add up is worse than no list.
   */
  byDepartment: Record<string, number>;
  deletedByDepartment: Record<string, number>;
}

/**
 * The bucket for rows that carry no department of their own.
 *
 * The plan's own row, engine metadata, and the PII sidecar — which inherits its
 * parent's department server-side and does not carry one on the wire. The
 * parentheses cannot collide with a real department code.
 */
export const UNCLASSIFIED_DEPARTMENT = "(none)";

/**
 * The error codes the RENDERER branches on.
 *
 * The full list lives in `main/kairosSync/client.ts`, beside the HTTP layer that
 * raises them — and that module reaches the network, so the renderer cannot
 * import it. This is the handful a screen actually makes a decision about,
 * restated where a screen can see them.
 *
 * Anything currently matched by a bare string literal in a component belongs
 * here instead. A literal is what lets a typo in a 409 handler fall through to a
 * generic error toast, and the 409s on this surface are the ones carrying the
 * context the user is supposed to read.
 */
export const SYNC_ERROR_CODES = {
  HANDBACK_WITH_UNSYNCED_WORK: "kairos_handback_with_unsynced_work",
  DELEGATE_HAS_UNSYNCED_WORK: "kairos_delegate_has_unsynced_work",
  DELEGATION_PARTIAL_OVERLAP: "kairos_delegation_partial_overlap",
  DELEGATION_REVOKED: "kairos_delegation_revoked",
  PLAN_NOT_SHARED: "kairos_plan_not_shared",
  STRUCTURE_PRECONDITION: "kairos_structure_precondition",
  WRITE_SCOPE_EMPTY: "kairos_write_scope_empty",
} as const;

/**
 * My unpublished rows, by department.
 *
 * Answers the one question a handback has to ask and the server does not:
 * "does giving this department back strand anything of mine?" Computed from the
 * local store with the same hash refinement `pendingChanges` uses, so the two
 * can never disagree — and with no network, so a delegate on a train still gets
 * a straight answer.
 */
export interface PendingByDepartment {
  planId: string;
  byDepartment: Record<string, number>;
  total: number;
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
  localProblems: LocalProblem[];
}

/**
 * A row this computer could not publish because the row itself is broken.
 *
 * Kept apart from `rejected` on purpose. A rejection is the server declining
 * something you asked for; this is a leftover here that nothing on the server
 * could ever have matched, and presenting the two the same way is what made an
 * ordinary publish read as a permission failure.
 */
export interface LocalProblem {
  entityType: string;
  reason: "EMPTY_KEY" | "ORPHANED_LOCALLY";
  count: number;
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
  /** Rows the server actually deleted. Not rows we asked it to. */
  purged: number;
  /**
   * Conflicts that resolved themselves — the server's hash is now in the shadow,
   * so the next publish sends these as ordinary updates.
   */
  adopted: number;
  localProblems: LocalProblem[];
  /**
   * What the server currently thinks this caller is, and whether they may write
   * the hotel's structure.
   *
   * Both exist so the result alert can tell "you need to do something" apart
   * from "the app sent something only an owner may send". A reason code this
   * caller's role could not have caused is counted, never explained — accusing
   * somebody of a rejection they had no way to cause sends them to their
   * administrator over a working system.
   */
  relation: Relation | null;
  structureEditable: boolean;
  noop: boolean;
}

export interface StructureDiffResponse {
  ou: string;
  /** null when the property has published nothing — keep the local copy. */
  serverVersion: number | null;
  /**
   * Whether the hotel has EVER published its setup.
   *
   * Distinct from an empty diff. A hotel with nothing on the server has nothing
   * to differ FROM, so both lists come back empty and the card would otherwise
   * claim the local setup matches a copy that does not exist.
   */
  published: boolean;
  /** What downloading the hotel's setup would change here. */
  changes: StructureChange[];
  /**
   * What publishing this machine's setup would change for everybody else.
   *
   * Publishing sends the WHOLE local document, so this is the only place the
   * blast radius is visible before the button is pressed — and it is a hotel-
   * wide one: every plan at the property renders through these columns and
   * blocks.
   */
  outgoing: StructureChange[];
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
  /**
   * Soft-delete this local scenario once the pull has applied.
   *
   * The name-clash resolution: the server's copy takes over as the plan of that
   * name, and the local one it replaced stops being listed. Only ever the id the
   * status call reported as `twinPlanId`, and only after the rows have landed.
   */
  replaceLocalPlanId?: string | null;
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
  MyDelegation,
  MyDelegationList,
  PiiSummary,
  PlanDelegationSummary,
  PlanSummary,
  ScopeReport,
  StructureChange,
};
