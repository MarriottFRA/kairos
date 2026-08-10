/**
 * The `/kairos` wire contract, as TypeScript.
 * -----------------------------------------------------------
 * A transcription of KAIROS_API_FOR_DESKTOP.md and the server's own
 * `api/src/kairos/schemas.py`. Types only — no logic, no Electron, no imports —
 * so the main process, the renderer and the tests all read the same shapes.
 *
 * The envelope is camelCase both ways (the server aliases its snake_case models
 * for exactly this reason). Entity `payload` is opaque to the server and must
 * round-trip character-identical, so it is typed as an index signature rather
 * than being narrowed here; the per-type DTOs live in `entityMap.ts`.
 *
 * The server refuses unknown keys on request bodies (`extra="forbid"`), so a
 * misspelled field is a 422 rather than a silently dropped value. Keep the
 * request types exact.
 *
 * The one import is `Relation`, which lives with the capability table it decides
 * rather than here: the enum and "what may they do?" have to move together, and
 * a relation added here alone would inherit whichever branch it fell into.
 */

import type { Relation } from "./relations";

// --------------------------------------------------------------------- shared

/** An opaque entity document. The server stores and returns it verbatim. */
export type EntityPayload = Record<string, unknown>;

/**
 * Which departments this caller can see, and whether that is all of them.
 *
 * `PARTIAL` is a hard gate, not a hint — see §5.4. Allocations renormalise to
 * 100%, results totals under-report, and a partial BST push zeroes rows it then
 * cannot refill. All three must be disabled rather than shown with a caveat.
 */
export interface ScopeReport {
  kind: "FULL" | "PARTIAL";
  /** null means all departments. */
  departments: string[] | null;
}

/**
 * Server-declared ceilings. Ride on `/sync/heads` and on every commit response
 * so a server change is enough — never hard-code these client-side.
 */
export interface CommitLimits {
  commitMaxBytes: number;
  commitMaxEntities: number;
  changesMaxBytes: number;
  manifestMaxEntities: number;
}

/**
 * What the caller is on a given plan. Told to us; never sent.
 *
 * Re-exported so consumers that already import their wire shapes from here keep
 * working; it is defined in `relations.ts` with the capability table.
 */
export type { Relation, WriteScopeKind } from "./relations";

// ---------------------------------------------------------------------- plans

export interface PlanCreate {
  /** Client-minted, and equal to the local scenario id — this is what makes a
   *  retried first publish idempotent rather than a duplicate plan. */
  id: string;
  ou: string;
  year: number;
  label: string;
  clientUpdatedAt?: string | null;
  appVersion?: string | null;
  engineVersion?: string | null;
  schemaEpoch?: number;
}

export interface PlanPatch {
  label?: string | null;
  state?: "ACTIVE" | "ARCHIVED" | null;
}

/**
 * A plan in `GET /plans`, which filters and never 403s for scope.
 *
 * Everything describing the plan's CONTENTS is nullable, because an `OU_VISITOR`
 * entry has them all nulled — the listing is resolved for `plan:discover`, not
 * `plan:read`. What survives is what a locked tile needs: `label`, `state`,
 * `ownerUserId` and `ownerEmail`, the last being who to ask for a delegation.
 *
 * A null `version` is NOT version 0. Coercing it makes the client believe it has
 * a plan to download for ever, against an endpoint that will only ever 403.
 */
export interface PlanSummary {
  id: string;
  ou: string;
  year: number;
  label: string;
  ownerUserId: number;
  ownerEmail: string | null;
  state: string;
  version: number | null;
  syncEpoch: number | null;
  structureVersion: number | null;
  entityCount: number | null;
  relation: Relation | null;
  scopeKind: "FULL" | "PARTIAL" | null;
  departments: string[] | null;
  /** The owner's access has lapsed; they are OWNER_DEGRADED and cannot write structure. */
  ownerIneligible: boolean;
  updatedAt: string | null;
}

/** `GET /plans/{id}/version` — the cheapest answer about one plan. */
export interface PlanVersion {
  planId: string;
  version: number;
  syncEpoch: number;
  structureVersion: number;
  state: string;
  relation: Relation | null;
  scope: ScopeReport;
}

// ---------------------------------------------------------------------- heads

/**
 * One plan on the probe.
 *
 * Same two shapes as the listing: an entry you hold `plan:read` on is complete,
 * and an `OU_VISITOR` entry has `version`, `structureVersion`, `syncEpoch` and
 * `scopeKind` all null. **Gate the sync loop on `relation`, before anything
 * else** — `canRead()` in `relations.ts` is that gate. A client that compares a
 * null version against a watermark with `>` does nothing, which is correct by
 * luck; one that coerces it to 0 pulls for ever against a 403.
 */
export interface PlanHead {
  id: string;
  version: number | null;
  structureVersion: number | null;
  syncEpoch: number | null;
  state: string;
  relation: Relation;
  scopeKind: "FULL" | "PARTIAL" | null;
  departments: string[] | null;
  /** Departments a delegate has handed back and the owner has not yet reopened. */
  handbacksPending: number;
}

export interface BstHead {
  importId: string;
  contentHash: string;
  importedAt: string;
}

/**
 * The probe. Covers plans, structure, BST, clusters and mapping tables in one
 * round trip, so we never poll five endpoints whose answer is almost always no.
 */
export interface SyncHeads {
  ou: string;
  /** `users.permissions_version`. Changed → re-read scope, ETags are stale. */
  authzVersion: number;
  plans: PlanHead[];
  structureVersion: number;
  bst: BstHead | null;
  clustersVersion: number;
  mappingTablesVersion: string | null;
  limits: CommitLimits;
  /** The dependency order a downloaded plan must be applied in. */
  applyOrder: string[];
}

// -------------------------------------------------------------------- changes

/** One row as it arrives from `/changes`. */
export interface ChangeEntity {
  entityType: string;
  entityId: string;
  parentId: string | null;
  department: string | null;
  deleted: boolean;
  clientUpdatedAt: string | null;
  serverSeq: number;
  payload: EntityPayload | null;
}

export interface ChangesPage {
  planId: string;
  fromVersion: number;
  /** The watermark to record — but only after the LAST page. */
  toVersion: number;
  syncEpoch: number;
  structureVersion: number;
  schemaEpoch: number;
  scope: ScopeReport;
  /** Pass back as `?cursor=`; keep `since` identical across pages. */
  nextCursor: string | null;
  limits: CommitLimits;
  entities: ChangeEntity[];
}

// -------------------------------------------------------------------- commits

/** Rejection reasons that apply per row; a chunk with one is still a good save. */
export type RejectionReason =
  | "UNKNOWN_ENTITY_TYPE"
  | "DEPARTMENT_OUT_OF_SCOPE"
  | "DEPARTMENT_MISMATCH"
  | "DEPARTMENT_UNASSIGNED"
  | "STRUCTURE_OWNER_ONLY"
  | "ORPHAN_ENTITY"
  | "PII_NOT_PERMITTED"
  | "PII_KEY_MISMATCH"
  | "PAYLOAD_TOO_LARGE"
  | "MISSING_PAYLOAD";

export type ConflictReason = "STALE" | "ALREADY_EXISTS" | "DELETED_REMOTELY";

export interface CommitEntity {
  entityType: string;
  entityId: string;
  /** `purge` is a force-tombstone for a row we hard-deleted locally after
   *  publishing it — without it, every other client resurrects the row. */
  op: "upsert" | "purge";
  parentId?: string | null;
  department?: string | null;
  /** What we last saw from the server. null = "I believe this is new". */
  baseHash: string | null;
  hash: string | null;
  deleted: boolean;
  clientUpdatedAt: string | null;
  payload?: EntityPayload | null;
}

export interface CommitRequest {
  baseVersion: number;
  commitGroupId?: string | null;
  entities: CommitEntity[];
}

export interface CommitAccepted {
  entityType: string;
  entityId: string;
  hash: string | null;
  serverSeq: number;
  /** A re-granted delegate's write overwrote a row changed while they were
   *  locked out. Correct, but it must never be silent — render it. */
  overrodeBase: boolean;
}

export interface CommitUnchanged {
  entityType: string;
  entityId: string;
}

export interface CommitConflict {
  entityType: string;
  entityId: string;
  reason: ConflictReason;
  serverHash: string | null;
  serverSeq: number | null;
  serverPayload: EntityPayload | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface CommitRejection {
  entityType: string;
  entityId: string;
  reason: RejectionReason;
  department: string | null;
  detail: string | null;
}

export interface CommitResponse {
  planId: string;
  baseVersion: number;
  committedVersion: number;
  syncEpoch: number;
  structureVersion: number;
  scope: ScopeReport;
  accepted: CommitAccepted[];
  unchanged: CommitUnchanged[];
  conflicts: CommitConflict[];
  rejected: CommitRejection[];
  limits: CommitLimits;
}

// ------------------------------------------------------------------- manifest

/** Positional `[entityType, entityId, contentHash]` — ~55% smaller than objects. */
export type ManifestTriple = [string, string, string];

/** `[entityType, entityId, serverHash | null]` */
export type NeededTriple = [string, string, string | null];

/** `[entityType, entityId, hash, serverSeq, deleted01]` — see §3.4. */
export type ServerOnlyRow = [string, string, string, number, 0 | 1];

export interface ManifestDiffRequest {
  entities: ManifestTriple[];
}

export interface ManifestDiffResponse {
  planId: string;
  version: number;
  syncEpoch: number;
  scope: ScopeReport;
  matched: number;
  needed: NeededTriple[];
  serverOnly: ServerOnlyRow[];
  truncated: boolean;
}

// ------------------------------------------------------------------ structure

export interface StructureDocument {
  ou?: string;
  structureVersion: number;
  docHash: string;
  doc: Record<string, unknown>;
}

export interface StructurePut {
  doc: Record<string, unknown>;
  docHash: string;
}

// ------------------------------------------------------------------------ pii

export interface PiiRow {
  entityType: "position_pii";
  positionId: string;
  department: string | null;
  hash: string;
  deleted: boolean;
  clientUpdatedAt: string | null;
  serverSeq: number;
  /** null + deleted → tombstone. null + !deleted → unreadable (key destroyed). */
  payload: EntityPayload | null;
  readable: boolean;
}

export interface PiiPage {
  planId: string;
  fromVersion: number;
  toVersion: number;
  syncEpoch: number;
  scope: ScopeReport;
  nextCursor: string | null;
  rows: PiiRow[];
  /** How many rows came back null-but-not-deleted. */
  unreadable: number;
}

export interface PiiSummary {
  planId: string;
  rows: number;
  live: number;
  /** false with rows > 0 means ERASED, not empty. */
  keyPresent: boolean;
  piiEnabled: boolean;
  scope: ScopeReport;
}

export interface PiiEraseRequest {
  reason: string;
  /** Must equal the plan id in the path — a deliberate speed bump. */
  confirmPlanId: string;
}

export interface PiiEraseResponse {
  planId: string;
  rowsErased: number;
  keysDestroyed: number;
  version: number;
  syncEpoch: number;
}

export interface OuSettings {
  ou: string;
  piiEnabled: boolean;
  updatedAt: string | null;
}

// ------------------------------------------------------------------------ bst

export interface BstBucket {
  /** 0-based on the wire. The local `budget_values.bucket_index` is 1-based. */
  index: number;
  type: string;
  year: number;
}

/** Wide form: `cells[bucket * 12 + month]`, 36 entries. */
export interface WideBudgetRow {
  id: string;
  combo: string;
  dept: string;
  account: string;
  description: string;
  cells: number[];
  [extra: string]: unknown;
}

export interface BstUpload {
  importId: string;
  buckets: BstBucket[];
  rows: WideBudgetRow[];
  sourceFilename?: string | null;
  hotelName?: string | null;
  bu?: string | null;
  currency?: string | null;
  asOfPeriod?: string | null;
  contentHash?: string | null;
}

export interface BstVersion {
  ou: string;
  importId: string | null;
  contentHash: string | null;
  rowCount: number;
  byteSize: number;
  importedAt: string | null;
  asOfPeriod: string | null;
  currency: string | null;
  buckets: BstBucket[];
  scope: ScopeReport | null;
}

export interface BstWorkbook extends BstVersion {
  rows: WideBudgetRow[];
}

export interface KpiSeriesRequest {
  /** Opaque label, for audit and caching only — the server never opens it. */
  driverId?: string | null;
  bucket: number;
  /** `*` is the ONLY wildcard. `%` and `_` match literally. */
  deptPatterns: string[];
  accountPrefixes: string[];
}

export interface KpiSeriesResponse {
  ou: string;
  importId: string;
  contentHash: string;
  bucket: number;
  months: number[];
  total: number;
  rowsMatched: number;
  scope: ScopeReport;
  driverId: string | null;
}

export type BstPushBlockReason =
  | "NOT_PLAN_OWNER"
  | "PARTIAL_SCOPE"
  | "ADMIN_LEASE_ACTIVE"
  | "NEVER_PUBLISHED"
  | "NO_BST_IMPORT";

export interface BstPushEligibility {
  allowed: boolean;
  reasons: BstPushBlockReason[];
  planId: string;
  scopeKind: "FULL" | "PARTIAL";
  importId: string | null;
  contentHash: string | null;
}

export interface BstPushLog {
  targetFile: string;
  rowsWritten: number;
  backupTaken: boolean;
  monthPlan?: Record<string, unknown> | null;
}

// ----------------------------------------------------------------- delegation

export type DelegatableReason = "NO_LIVE_ROWS" | "UNKNOWN_DEPARTMENT_CODE";

export interface DelegatedHolder {
  userId: number;
  email: string;
  delegationId: string;
  state: "ACTIVE" | "HANDED_BACK";
}

/**
 * A holder as `/department-ownership` discloses them, which is the one route
 * that says whether they hold the pen.
 *
 * Narrower than `DelegatedHolder` on purpose. `/plans/{id}/departments` returns
 * the same people in `delegatedTo` and does not document the flag, and a type
 * that claimed it there would be a lie the compiler enforces.
 */
export interface OwnershipHolder extends DelegatedHolder {
  /**
   * false → they can look and change nothing, and they displace nobody: the
   * department stays `writable: true, reason: null` for the owner. Read through
   * `holderEdits`, never directly — a server that omits the field must read as
   * editing, and that default belongs in one place.
   */
  canEdit: boolean;
}

export interface DelegatableDepartment {
  code: string;
  positionCount: number;
  activeCount: number;
  /** Which entity types put rows in this department — position, buyout_row, … */
  presentIn: string[];
  grantable: boolean;
  reason: DelegatableReason | null;
  delegatedTo: DelegatedHolder[];
}

export interface DelegatableDepartments {
  planId: string;
  version: number;
  departments: DelegatableDepartment[];
  note: string;
}

export interface DelegationCandidate {
  userId: number;
  email: string;
  accessType: string;
  deptScope: { mode: "ALL" | "LIST"; departments: string[] };
  eligible: boolean;
  /** Present even when eligible is false — render the reason, don't hide the row. */
  reasons: string[];
  existingDelegationId: string | null;
}

export interface DelegationCandidates {
  planId: string;
  candidates: DelegationCandidate[];
}

export type DelegationIneffectiveReason =
  | "OU_ACCESS_REVOKED"
  | "DEPARTMENT_ACCESS_SHRUNK"
  | "EXPIRED"
  | "NO_OVERLAP";

export interface DelegationDepartment {
  code: string;
  state: "ACTIVE" | "HANDED_BACK";
  handedBackAt: string | null;
  handedBackNote: string | null;
}

export interface Delegation {
  id: string;
  delegateUserId: number;
  delegateEmail: string;
  grantedAt: string;
  expiresAt: string | null;
  canEdit: boolean;
  canAddRows: boolean;
  canDeleteRows: boolean;
  canReadPii: boolean;
  /** Bumps on re-grant; the override-base window is keyed to it. */
  generation: number;
  /** What the owner asked for — stored as intent, so a widened grant re-widens. */
  requestedDepartments: string[];
  /** requested ∩ what the delegate actually holds. */
  effectiveDepartments: string[];
  departments: DelegationDepartment[];
  effective: boolean;
  reason: DelegationIneffectiveReason | null;
}

export interface DelegationList {
  planId: string;
  delegations: Delegation[];
}

/**
 * One plan delegated to ME, from `GET /me/delegations`.
 *
 * NOT a `Delegation`, and the difference is not cosmetic. That one is the
 * owner's view of a grant they made and is keyed by delegate; this is the
 * delegate's view of a grant they received and is keyed by plan — which is why
 * it carries `ou`, `year` and `label` and no `delegateEmail`.
 *
 * It is also the only surface that lists plans at OTHER hotels, and the only one
 * that still lists a delegation after it was withdrawn (30 days). Both matter:
 * the first is how a deep link can say "that plan is at another hotel, switch to
 * it" rather than "not found", and the second is what "your work is not lost"
 * looks like in a UI.
 */
export interface MyDelegation {
  delegationId: string;
  planId: string;
  ou: string;
  year: number;
  label: string;
  state: "ACTIVE" | "REVOKED";
  revokedAt: string | null;
  revokedWithUnsynced: boolean;
  generation: number;
  departments: Array<{ code: string; state: HandbackState }>;
  /** Present on a REVOKED entry: who to talk to, and about what. */
  remedy: { kind: string; ownerUserId: number | null } | null;
}

export interface MyDelegationList {
  delegations: MyDelegation[];
}

export interface DelegationCreate {
  delegateUserId: number;
  departments: string[];
  canEdit: boolean;
  canAddRows: boolean;
  canDeleteRows: boolean;
  canReadPii: boolean;
  expiresAt?: string | null;
  note?: string | null;
  /** Only set after the owner has SEEN the partial-overlap warning (§7.2). */
  acknowledgeNonOverlap?: boolean;
}

/** `context` of a 422 `kairos_delegation_partial_overlap`. Must be rendered. */
export interface PartialOverlapContext {
  requested: string[];
  effective: string[];
  nonOverlapping: string[];
  remedy: string;
  retryWith: { acknowledgeNonOverlap: boolean };
}

/** `context` of a 409 `kairos_delegate_has_unsynced_work`. */
export interface UnsyncedWorkContext {
  delegateEmail: string;
  dirtyEntities: number;
  departments: string[];
  lastSeenAt: string | null;
  retryWith: { force: boolean };
}

/** `context` of a 403 `kairos_delegation_revoked` — banner + Export, never wipe. */
export interface RevokedContext {
  revokedAt: string;
  revokedByEmail: string;
  reasonPublic: string | null;
  exportAdvised: boolean;
}

/** `context` of a 409 `kairos_handback_with_unsynced_work`. */
export interface HandbackUnsyncedContext {
  dirtyEntities: number;
  departments: string[];
  retryWith: { force: boolean };
}

export type HandbackState = "ACTIVE" | "HANDED_BACK";

export interface HandbackDepartment {
  department: string;
  state: HandbackState;
  handedBackAt: string | null;
  /**
   * The plan version at handover. Every department moved in one call shares it,
   * so the owner's audit trail shows one handover rather than five coincidental
   * ones.
   */
  handedBackAtVersion: number | null;
}

export interface HandbackResult {
  planId: string;
  delegationId: string;
  departments: HandbackDepartment[];
}

export interface RevokeResponse {
  id: string;
  revokedAt: string;
  unsyncedAtRevoke: boolean;
  warning: string | null;
}

// ---------------------------------------------------- department ownership

export type NotWritableReason = "DELEGATED" | "HANDED_BACK" | "NOT_IN_WRITE_SCOPE";

export interface DepartmentOwnershipRow {
  code: string;
  readable: boolean;
  /** Authoritative — it IS the server's write predicate, so the grid cannot
   *  disagree with what a save will do. */
  writable: boolean;
  reason: NotWritableReason | null;
  assignedTo: OwnershipHolder[];
}

export interface DepartmentOwnership {
  planId: string;
  planVersion: number;
  authzVersion: number;
  me: { relation: Relation; scopeKind: "FULL" | "PARTIAL" };
  /** false → a demoted owner. Disable blocks/allocations/KPI/SS/field-catalog. */
  structureEditableByMe: boolean;
  departments: DepartmentOwnershipRow[];
}

// ------------------------------------------------------- presence & activity

export interface PresenceReport {
  dirtyEntities: number;
  departments: string[];
  lastLocalEditAt: string | null;
}

export interface ActivityEntry {
  userId: number;
  email: string;
  departments: string[];
  dirtyEntities: number;
  seenAt: string;
}

export interface Activity {
  planId: string;
  present: ActivityEntry[];
}

// ----------------------------------------------------------- ownership transfer

/**
 * Why the outgoing owner was left nothing.
 *
 * Retention is best effort and never fails the transfer. The commonest reason to
 * hand a plan over is that its owner is leaving, so `PREVIOUS_OWNER_INACTIVE` is
 * the ordinary outcome rather than the exotic one — which is exactly why the
 * transfer must not 4xx on it.
 */
export type RetainedReason =
  | "SELF_TRANSFER"
  | "PREVIOUS_OWNER_INACTIVE"
  | "OU_ACCESS_REVOKED"
  | "NO_KAIROS_APP"
  | "NO_DEPARTMENT_ACCESS"
  | "NO_GRANTABLE_DEPARTMENTS"
  | "NO_OVERLAP"
  | "ALREADY_DELEGATED";

/**
 * The read-only delegation the incoming owner grants the outgoing one.
 *
 * Deliberately NOT a `Delegation` — the transfer response carries five fields,
 * with no `generation`, `canAddRows` or department states. Modelling them as one
 * type would invite a screen to read a field that is not there. The full row
 * arrives in the ordinary `GET .../delegations` list, and that is where any
 * screen that needs the rest should get it.
 */
export interface RetainedDelegation {
  id: string;
  delegateUserId: number;
  departments: string[];
  canEdit: boolean;
  canReadPii: boolean;
}

export interface TransferResult {
  planId: string;
  ownerUserId: number;
  ownerEmail: string;
  /** The incoming owner's own delegation, revoked in the same transaction. */
  delegationsRevoked: number;
  /** Non-null exactly when `retainedReason` is null, and vice versa. */
  retainedDelegation: RetainedDelegation | null;
  retainedReason: RetainedReason | null;
}

// ---------------------------------------------------------------------- lease

/**
 * The two lease modes, and the distinction that matters.
 *
 * `READ_ONLY_SUPPORT` changes nothing about anybody else's access. It exists so
 * that reading a hotel's data — break-glass PII included — is a decision
 * somebody recorded, and it grants its holder no writes at all.
 *
 * `EXCLUSIVE` is the deliberate second step and the ONLY mode that confers
 * write. It sets the plan to LOCKED_BY_SUPPORT and locks the owner out, so every
 * other commit comes back 423.
 */
export type LeaseMode = "READ_ONLY_SUPPORT" | "EXCLUSIVE";

export interface Lease {
  leaseId: string;
  mode: LeaseMode;
  adminEmail: string;
  acquiredAt: string;
  expiresAt: string;
  /** The safe handle. The internal `reason` is deliberately never returned. */
  ticketRef: string | null;
}

export interface LeaseResponse {
  planId: string;
  lease: Lease | null;
}

export interface LeaseCreate {
  mode: LeaseMode;
  /** Recorded, never returned to the hotel — it can name a defect or a customer. */
  reason: string;
  ticketRef: string;
  /** 5–240 per acquisition, 1440 in total across extensions. */
  minutes: number;
}

/**
 * What the release moved.
 *
 * Handback bumps `syncEpoch`, which forces every client at the property to
 * full-refresh — so the numbers here are what lets the UI say "the server moved
 * 812 → 847 while support held this plan" instead of showing an unexplained pile
 * of conflicts.
 */
export interface LeaseReleaseResult {
  planId: string;
  syncEpoch: number;
  versionAtAcquire: number;
  version: number;
  entitiesChanged: number;
}

// ---------------------------------------------------------------- administration

/** A property with Kairos activity, for support triage. */
export interface AdminHotel {
  ou: string;
  name: string | null;
  plans: number;
  entities: number;
  lastPublishedAt: string | null;
}

/** One row of the estate-wide plan list, with the flags support triages on. */
export interface AdminPlanRow {
  id: string;
  ou: string;
  year: number;
  label: string;
  state: string;
  version: number;
  syncEpoch: number;
  entityCount: number;
  ownerUserId: number;
  ownerEmail: string | null;
  /** The owner no longer meets the bar — they are OWNER_DEGRADED on their own plan. */
  ownerIneligible: boolean;
  leaseHeldBy: string | null;
  updatedAt: string | null;
}

export interface AdminPlanList {
  plans: AdminPlanRow[];
  total: number;
}

export interface AuditRow {
  id: number;
  at: string;
  actorEmail: string | null;
  action: string;
  planId: string | null;
  ou: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * An administrator's export, with the reason they gave.
 *
 * Readable by ANY administrator, not only the one who made it: a control that
 * only its own subject can inspect is not a control.
 */
export interface SupportDownload {
  id: number;
  at: string;
  adminEmail: string;
  planId: string;
  piiMode: string;
  reason: string;
  ticketRef: string | null;
  rows: number;
}

/**
 * `GET /admin/users/{id}/scope` — the resolver explaining itself.
 *
 * Produced by the same function that enforces the decision, with a trace
 * attached, rather than by a second implementation of the rules. "Anna has no
 * access" is not something anybody can act on; "Anna's OU grant expired on 3
 * June" is.
 */
export interface ScopeTraceStep {
  step: string;
  outcome: string;
  detail?: string | null;
}

export interface ScopeTrace {
  userId: number;
  email: string | null;
  planId: string | null;
  capability: string | null;
  inputs: Record<string, unknown>;
  steps: ScopeTraceStep[];
  outcome: Record<string, unknown>;
}

/** `pii=raw` is break-glass and requires a lease; it is never a bare admin read. */
export type BundlePiiMode = "omit" | "pseudonymize" | "raw";

export interface BundleOptions {
  planId: string;
  pii: BundlePiiMode;
  /** Mandatory. A bundle with no recorded justification is unexplainable later. */
  reason: string;
  ticketRef?: string | null;
  outputs?: boolean;
}

export interface BundleResult {
  planId: string;
  /** Where the .ndjson.gz was written on this machine. */
  savedTo: string;
  rows: number;
  piiMode: string;
  byteSize: number;
}

// ------------------------------------------------------------------ artifacts

export interface ArtifactEntry {
  kind: string;
  contentHash: string;
  byteSize: number;
  planVersion: number;
  /** Computed against an older plan version — do NOT render as current. */
  stale: boolean;
  updatedAt: string;
}

export interface ArtifactList {
  planId: string;
  artifacts: ArtifactEntry[];
}

// -------------------------------------------------------------------- uploads

export interface UploadCreate {
  kind: "BST_IMPORT" | "ARTIFACT";
  ou?: string | null;
  planId?: string | null;
  totalParts: number;
  declaredHash: string;
  declaredBytes: number;
}

export interface UploadStatus {
  uploadId: string;
  kind: string;
  totalParts: number;
  receivedParts: number[];
  /** Resume by sending only these. Parts are idempotent by number. */
  missingParts: number[];
  bytesReceived: number;
  expiresAt: string;
}

// ------------------------------------------------------------------- clusters

export interface ClusterMember {
  ou: string;
  weight: number;
  sortOrder: number;
}

export interface Cluster {
  id: string;
  name: string;
  sortOrder: number;
  members: ClusterMember[];
}

export interface ClusterList {
  version: number;
  clusters: Cluster[];
}

export interface DivergenceFinding {
  kind: string;
  ous: string[];
  detail?: string;
}

export interface ClusterDivergence {
  memberCount: number;
  visibleCount: number;
  /** > 0 → this answer is about PART of the cluster. Say so in the UI. */
  omittedCount: number;
  members: unknown[];
  findings: DivergenceFinding[];
  advisoryOnly: true;
}
