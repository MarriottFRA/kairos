/**
 * Kairos sync IPC handlers.
 * -----------------------------------------------------------
 * The bridge between the renderer and `src/main/kairosSync/*`. Every handler is
 * thin: resolve the OU scope, open the two stores, call the module that owns the
 * policy, and flatten the answer.
 *
 * ## Why every handler returns `SyncOutcome` rather than throwing
 *
 * An exception crossing the IPC boundary arrives as a bare message. That is fine
 * for "the disk is full" and useless for `kairos_delegation_partial_overlap`,
 * whose `context` names the departments the owner has to be shown before they
 * can retry. The three flows that depend on that context — partial overlap,
 * unsynced-work-on-revoke, and the revoked-delegation banner — would be
 * impossible to build on a flattened error, so the code and the context are
 * carried through deliberately.
 *
 * ## OU gating
 *
 * Registered with `ouScopeMiddleware` in `src/ipc/index.ts`, except the three
 * cross-property reads (`myDelegations`, `clusters`, `clusterDivergence`) which
 * span hotels by definition. Those are gated by the secure-DB session lock
 * instead — the same split hotel clusters already makes.
 */

import { app } from "electron";
import { IpcHandler, IpcResult } from "../types";
import { localDbHandle } from "../../local_db";
import { isSecureDatabaseUnlocked, secureDb } from "../../secure_db";
import { SessionExpiredError } from "../../main/auth/sessionManager";
import { resolveOuScope } from "../../main/positions/ouScope";
import { softDeleteScenario } from "../../main/positions/structureRepo";
import { prepared } from "../../main/positions/stmtCache";
import type { ApiClient } from "../../main/auth/apiClient";
import { KAIROS_ERRORS, KairosApiError, KairosClient } from "../../main/kairosSync/client";
import { fetchHeads, limitsFrom } from "../../main/kairosSync/heads";
import { contentHash } from "../../main/kairosSync/hash";
import { fetchOwnership, invalidateOwnership } from "../../main/kairosSync/ownership";
import { pullPlan } from "../../main/kairosSync/pull";
import { previewPublish, publishPlan } from "../../main/kairosSync/publish";
import { rebuildShadowFromServer, reconcilePlan } from "../../main/kairosSync/reconcile";
import { pullStructure, pushStructure } from "../../main/kairosSync/structure";
import * as delegation from "../../main/kairosSync/delegation";
import * as pii from "../../main/kairosSync/pii";
import * as bst from "../../main/kairosSync/bst";
import * as artifacts from "../../main/kairosSync/artifacts";
import * as plansApi from "../../main/kairosSync/plans";
import * as admin from "../../main/kairosSync/admin";
import {
  clearShadow,
  countShadow,
  deleteSyncState,
  getShadow,
  getSyncState,
  listSyncStates,
  updateSyncState,
} from "../../main/kairosSync/repo";
import { purgeScenario } from "../../main/maintenance/cleanupRepo";
import {
  normalizeDepartment,
  PublishedEntityType,
  Row,
  toEntity,
} from "../../shared/kairosSync/entityMap";
import { WriteScope, isUnsent, shadowIsComplete } from "../../main/kairosSync/collect";
import {
  clusterSnapshotContext,
  stampClusterSnapshot,
} from "../../main/kairosSync/clusterSnapshot";
import {
  KAIROS_SYNC_CHANNELS,
  PendingByDepartment,
  PlanSyncStatus,
  SyncError,
  SyncOutcome,
  SyncStatusResponse,
  SYNC_LOCAL_ERROR_CODES,
  UNCLASSIFIED_DEPARTMENT,
} from "../../shared/kairosSync/ipc";
import { delegationSummary } from "../../shared/kairosSync/delegationSummary";
import {
  BundleOptions,
  DelegationCreate,
  DepartmentOwnership,
  KpiSeriesRequest,
  LeaseCreate,
  PlanHead,
  PlanSummary,
  Relation,
  SyncHeads,
} from "../../shared/kairosSync/protocol";
import {
  canRead,
  canWrite,
  canWriteStructure,
  RELATION_PLAIN,
  WriteScopeKind,
} from "../../shared/kairosSync/relations";
import { readScopeWidened } from "../../shared/kairosSync/scopeWidening";
import {
  NO_DEPARTMENT_WRITE,
  UNRESTRICTED_WRITE,
  allowOnly,
  departmentWritePolicy,
  enumeratedWritableDepartments,
  holdsAnyDepartment,
} from "../../shared/kairosSync/writePolicy";

function envelope<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

/**
 * Flatten anything thrown into the shape the renderer branches on.
 *
 * `local` is a promise, not a shrug: the Sync page renders it as no error at
 * all, because a laptop on a train is the normal state of an app whose whole
 * premise is that it works without the server. That is right for a failed
 * socket and wrong for everything else that used to land here — a signed-out
 * session and a locked secure store are both conditions the user can act on,
 * and both were being shown as an empty page with no message of any kind. They
 * get their own codes so the page can say what happened.
 */
function toSyncError(error: unknown): SyncError {
  if (error instanceof KairosApiError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      context: error.context,
    };
  }
  if (error instanceof SessionExpiredError) {
    return {
      code: SYNC_LOCAL_ERROR_CODES.SESSION_EXPIRED,
      status: 0,
      message: "You have been signed out. Sign in again to sync.",
    };
  }
  // Identified by the accessor that raises it rather than by a bespoke error
  // class, because `secureDb()` is called from every handler in this file and
  // a new class would have to be threaded through all of them.
  if (!isSecureDatabaseUnlocked()) {
    return {
      code: SYNC_LOCAL_ERROR_CODES.SECURE_DB_LOCKED,
      status: 0,
      message:
        "This computer's encrypted store is locked, so there is nothing to sync " +
        "against. Sign in again to unlock it.",
    };
  }
  return {
    code: "local",
    status: 0,
    message: error instanceof Error ? error.message : "Sync failed",
  };
}

/**
 * Run a handler body, turning any failure into `{ok: false, error}`.
 *
 * Pass `planId` on plan-scoped calls so a `kairos_delegation_revoked` is
 * recorded on the way past. That 403 is the only notice a delegate ever gets
 * that their access was withdrawn, and it arrives on whichever call happened to
 * run next — so it has to be caught wherever it lands, not on one designated
 * endpoint, and persisted so the banner survives a restart.
 */
async function attempt<T>(
  run: () => Promise<T> | T,
  planId?: string
): Promise<SyncOutcome<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (planId) recordRevocation(planId, error);
    return { ok: false, error: toSyncError(error) };
  }
}

/** Persist the revoked-delegation context so the banner outlives the session. */
function recordRevocation(planId: string, error: unknown): void {
  if (
    !(error instanceof KairosApiError) ||
    !error.is(KAIROS_ERRORS.DELEGATION_REVOKED)
  ) {
    return;
  }
  try {
    updateSyncState(secureDb(), planId, {
      revokedJson: JSON.stringify(error.context ?? {}),
    });
  } catch {
    // The banner is a courtesy; failing to store it must not replace the 403
    // the caller actually needs to see.
  }
}

/** Drop the banner once the delegation is working again. */
function clearRevocation(planId: string): void {
  updateSyncState(secureDb(), planId, { revokedJson: null });
}

/**
 * The last known relation for a plan, as a write scope.
 *
 * Cached from `/department-ownership` and `/sync/heads`, so it can be stale by
 * one request. That is safe in this direction: the filter only ever WITHHOLDS
 * rows, and the server re-resolves authority on the commit regardless. A scope
 * that has widened since the cache costs one extra publish, not a lost write.
 *
 * ## Why the head is consulted, and not only the cached state
 *
 * `state.relation` is written by ONE call — `/department-ownership` — and that
 * call is only ever made by the Delegation page. An owner who publishes without
 * having opened it has `relation === null`, which used to resolve to
 * `canWriteStructure: false`. The consequence was not theoretical: the plan's
 * own `scenario` row carries no department (`entityMap` gives it
 * `departmentOf: () => null`), so it lands in the owner-only branch and was
 * withheld from the publish — silently, since a withheld row is not a rejection.
 *
 * The result was a plan on the server with every position in it and no record of
 * the plan itself. A colleague downloading it received the rows and never got a
 * `scenarios` row, so it stayed listed as "in the cloud, not on this computer"
 * for good — while the watermark advanced, which made every later download
 * answer "nothing has changed on the server since your last download".
 *
 * `/sync/heads` carries a relation for every plan and the publish has just
 * fetched it, so an unknown relation is now answered rather than assumed.
 */
/**
 * The cached `/department-ownership` body, which is the only authoritative
 * answer to "which departments may I WRITE".
 *
 * Read from `ownershipJson` rather than the `scopeDepartments` column, and that
 * distinction is load-bearing. Three calls write that column and they do not
 * mean the same thing by it: `/department-ownership` stores the WRITABLE subset,
 * while `/sync/heads` and a completed pull both store the caller's READ scope.
 * Read scope is a superset — it includes departments handed back, and for a
 * delegation granted with `canEdit: false` it is everything they hold while the
 * writable set is empty. Deriving the publish filter from it therefore lets rows
 * through that the server refuses, and makes a read-only share look writable the
 * moment its holder downloads it.
 *
 * `ownershipJson` has exactly one writer, so its presence also answers "has the
 * authoritative call ever run?" — which `relation` cannot, since heads sets that
 * too.
 */
function cachedOwnership(planId: string): DepartmentOwnership | null {
  const json = getSyncState(secureDb(), planId)?.ownershipJson;
  if (!json) return null;
  try {
    return JSON.parse(json) as DepartmentOwnership;
  } catch {
    // A corrupt cache is a cache miss, never a crash: every caller already
    // handles "not asked yet".
    return null;
  }
}

function writeScopeFor(planId: string, head?: PlanHead | null): WriteScope {
  const state = getSyncState(secureDb(), planId);
  // The relation itself comes from the head, which is refreshed on every probe;
  // the cached ownership body is only written when the Delegation page or the
  // grid has run, so it can be arbitrarily old.
  const relation = (head?.relation ?? state?.relation ?? null) as Relation | null;

  // Capability first. A relation with no write at all must not fall through to
  // an open ceiling, which every caller reads as "no restriction" — for an
  // OU_VISITOR that is exactly backwards, and would have the client filter
  // nothing out of a publish the server refuses in its entirety.
  if (!canWrite(relation)) {
    return { canWriteStructure: false, departmentPolicy: NO_DEPARTMENT_WRITE };
  }

  const ownership = cachedOwnership(planId);
  const departmentPolicy = ownership
    ? // The SAME derivation the grid locks against, so a cell the user was
      // allowed to edit cannot be withheld here without a word. For a full-scope
      // owner that is a deny-list: `/department-ownership` enumerates only
      // departments that already have rows, and withholding a brand-new one
      // would keep it from ever gaining any.
      departmentWritePolicy(ownership)
    : // Never asked. The head's department list is the read scope, which is the
      // best available guess and errs wide — the server still resolves authority
      // per row, so the cost is a rejection rather than a lost write.
      head?.scopeKind === "PARTIAL"
      ? allowOnly(head.departments)
      : UNRESTRICTED_WRITE;

  return {
    /**
     * AND, not "cache if present, capability otherwise".
     *
     * A cached ownership body may TAKE structure rights away from an owner — a
     * demotion is exactly what `structureEditableByMe: false` reports — but it
     * must never hand them to a relation the server's own matrix gives none to,
     * and neither may the no-cache fallback. Written as a conjunction, a
     * DELEGATE resolves false however stale or absent the cache is, while a
     * genuine owner publishing a brand-new plan (nothing cached yet, and the
     * `scenario` row is the first thing that has to go up) still resolves true.
     *
     * OWNER_DEGRADED keeps its departments and loses structure, which is the
     * distinction this flag exists for. GLOBAL_ADMIN writes nothing at all.
     */
    canWriteStructure:
      (ownership ? ownership.structureEditableByMe : true) &&
      canWriteStructure(relation),
    departmentPolicy,
  };
}

/** The head for one plan out of a (possibly replayed) property answer. */
function headFor(heads: SyncHeads | null, planId: string): PlanHead | null {
  return heads?.plans.find((plan) => plan.id === planId) ?? null;
}

/**
 * Refuse a publish that could not send a single row, and say why.
 *
 * Without this the request goes out, every row is filtered off client-side, and
 * the result alert reports zero accepted — which looks exactly like a publish
 * that had nothing to do. The two are opposite situations and the second one
 * needs the user to go and fix something.
 *
 * Only ever raised when the scope is empty AND the relation cannot write. An
 * open ceiling means "no restriction" and must never land here — including a
 * full-scope owner who has delegated every department away, who still holds the
 * right to open a new one.
 */
function assertCanPublish(planId: string, scope: WriteScope, head?: PlanHead | null): void {
  if (holdsAnyDepartment(scope.departmentPolicy)) return;
  if (scope.canWriteStructure) return;

  const state = getSyncState(secureDb(), planId);
  const relation = (head?.relation ?? state?.relation ?? null) as Relation | null;

  throw new KairosApiError(
    0,
    emptyScopeMessage(relation),
    KAIROS_ERRORS.WRITE_SCOPE_EMPTY,
    { relation }
  );
}

/**
 * Why this publish would send nothing, in the second person.
 *
 * Three genuinely different situations reach here and the wrong sentence in any
 * of them sends somebody to their administrator over a working system.
 */
function emptyScopeMessage(relation: Relation | null): string {
  // Not a fault at all: an ordinary read-only share, working as the owner
  // intended. `canEdit: false` strips every write capability while leaving the
  // relation a plain DELEGATE, so an empty scope here is the normal state.
  if (relation === "DELEGATE") {
    return (
      "This plan was shared with you to look at, not to change. Everything you " +
      "have done stays on this computer. Ask its owner if you need to edit a " +
      "department — they can change that without re-sharing the plan."
    );
  }

  // Discovery only. There is nothing to publish because there is nothing shared.
  if (relation !== null && !canRead(relation)) {
    return (
      "This plan has not been shared with you, so nothing can be published to " +
      "it. Ask its owner to delegate the departments you need."
    );
  }

  const plain = relation ? RELATION_PLAIN[relation] ?? relation : null;
  return plain
    ? `Nothing would be published. The server currently sees you as ${plain}, ` +
        "which gives you no departments to write to. If this plan is yours, its " +
        "ownership on the server does not match — ask an administrator to check it."
    : "Nothing would be published: the server has given you no departments to " +
        "write to on this plan.";
}

/**
 * The version to commit against — never a guess.
 *
 * `0` is not a neutral default: it asserts "this plan is new", and against a
 * plan the server already holds every row comes back `ALREADY_EXISTS`. So it is
 * only used when we have positive evidence the plan is unregistered, meaning no
 * head in the (possibly cached) property answer AND no local state row. When the
 * two disagree — a plan registered since the last 200 heads — one cheap
 * `/plans/{id}/version` settles it.
 */
async function resolveBaseVersion(
  db: ReturnType<typeof secureDb>,
  client: KairosClient,
  heads: SyncHeads | null,
  planId: string
): Promise<number> {
  const head = headFor(heads, planId);
  // A null version means the head is a discovery-only entry, which has no
  // version to commit against. Falling through to `/plans/{id}/version` gets the
  // 403 that is the honest answer, rather than asserting `0` at a live plan.
  if (head && head.version !== null) return head.version;
  if (!head && !getSyncState(db, planId)) return 0;
  return (await plansApi.fetchPlanVersion(client, planId)).version;
}

/** Local scenarios at a property, so unpublished ones still appear on the page. */
function localScenarios(ou: string): Array<{ id: string; year: number; label: string }> {
  return prepared(
    localDbHandle(),
    `SELECT id, year, label FROM scenarios
      WHERE ou = ? AND deleted_at IS NULL ORDER BY year DESC, label`
  ).all(ou) as Array<{ id: string; year: number; label: string }>;
}

/**
 * A single scenario's name, read before it is destroyed.
 *
 * The purge takes the row with it, so the label has to be captured first or the
 * message afterwards has nothing to call the plan it just removed.
 */
function scenarioLabel(ou: string, planId: string): string | null {
  const row = prepared(
    localDbHandle(),
    `SELECT label FROM scenarios WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(planId, ou) as { label: string } | undefined;
  return row?.label ?? null;
}

/**
 * "Same plan" for the purposes of warning about a name clash.
 *
 * Year and label only, because that is all a human has to go on. The ids are
 * different — that is the whole problem — so this is a heuristic for a warning
 * and never a key anything is merged on.
 *
 * The separator is NUL because a label cannot contain one, so no pair of
 * (year, label) values can collide by straddling it. It must stay written as
 * the ESCAPE and never as the character itself: a raw 0x00 in the source makes
 * ripgrep and `git grep` classify this file as binary and skip it in silence,
 * which is how the largest file in this feature became unsearchable without
 * anything appearing to be wrong.
 */
function nameKey(year: number, label: string): string {
  return `${year}\u0000${label.trim().toLowerCase()}`;
}

/**
 * How much of this plan the user may write, as the card needs to say it.
 *
 * `UNKNOWN` until `/department-ownership` has answered once, because until then
 * there is no honest way to tell "no departments" from "not asked". The
 * distinction matters: `NONE` on a DELEGATE is a read-only share and the card
 * must withdraw Publish, while `UNKNOWN` must leave it alone rather than accuse
 * a working delegate of having lost their access.
 *
 * The head cannot answer this. Its `scopeKind` describes what you may READ, and
 * a read-only delegate reads everything they were given — `canEdit: false`
 * strips the write capabilities underneath a relation that stays plain
 * `DELEGATE` on the wire.
 */
function writeScopeKindFor(
  relation: Relation | null,
  ownership: DepartmentOwnership | null
): WriteScopeKind {
  if (!canWrite(relation)) return "NONE";
  if (!ownership) return "UNKNOWN";
  const writable = enumeratedWritableDepartments(ownership);
  if (writable.length === 0) return "NONE";
  return writable.length < ownership.departments.length ? "PARTIAL" : "FULL";
}

/**
 * Remove a plan this computer is no longer entitled to hold.
 *
 * Hard, not soft: a soft delete leaves every position, PII sidecar and component
 * value live in the encrypted store — exactly the data the server has just
 * stopped serving. See `purgeScenario`.
 *
 * Never called when there is unpublished work in it. A withdrawn delegation is
 * frequently temporary — the owner re-grants, and the server stamps
 * `override_base_until` precisely so the returning delegate's held-back writes
 * win — and the app already promises on screen that the work is not lost.
 */
function removeUnsharedPlan(planId: string, ou: string): void {
  purgeScenario(localDbHandle(), secureDb(), { id: planId, ou });
  clearShadow(secureDb(), planId);
  deleteSyncState(secureDb(), planId);
}

export function createKairosSyncHandlers(
  apiClient: ApiClient
): Record<string, IpcHandler> {
  const client = new KairosClient(apiClient);
  const stores = () => ({ localDb: localDbHandle(), secureDb: secureDb() });

  return {
    // ------------------------------------------------------------- the probe

    [KAIROS_SYNC_CHANNELS.probe]: async (_event, request: { ou: string }) => {
      return envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const result = await fetchHeads(secureDb(), client, scope.ou);
          return {
            ou: scope.ou,
            notModified: result.notModified,
            authzVersion: result.heads?.authzVersion ?? null,
            stale: result.stalePlans,
            epochMoved: result.epochMoved,
          };
        })
      );
    },

    [KAIROS_SYNC_CHANNELS.status]: async (_event, request: { ou: string }) => {
      return envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const db = secureDb();

          // The probe answers 304 in the steady state, which carries no plan
          // list — so `fetchHeads` replays the stored body and the page is built
          // from that. `notModified` is the only thing that distinguishes the
          // two cases here, and it drives the "Up to date" chip and nothing else.
          const probe = await fetchHeads(db, client, scope.ou);
          const heads = probe.heads;
          const headById = new Map<string, PlanHead>(
            (heads?.plans ?? []).map((plan) => [plan.id, plan])
          );
          const states = new Map(
            listSyncStates(db, scope.ou).map((state) => [state.planId, state])
          );

          let piiEnabled: boolean | null = null;
          try {
            piiEnabled = (await pii.fetchOuSettings(client, scope.ou)).piiEnabled;
          } catch {
            // The kill switch is advisory to the UI; a failure to read it must
            // not stop the page rendering.
            piiEnabled = null;
          }

          /**
           * Plans this computer holds that the server will no longer show us.
           *
           * Access to a hotel used to confer `plan:read`, so a colleague's plan
           * could be downloaded in full by anybody at the property. It no longer
           * can, and a copy taken under the old rules — or one whose delegation
           * has since been withdrawn — is data with nothing justifying it. It is
           * purged outright rather than left to rot behind a disabled button.
           *
           * The exception is unpublished work, which is left strictly alone. A
           * withdrawal is often temporary and the server has machinery
           * (`override_base_until`) specifically so a re-granted delegate's
           * held-back writes still land. Destroying it here would make a liar of
           * the banner that promises it survives.
           *
           * Runs here rather than in the probe timer on purpose: something that
           * removes a plan should happen on a page somebody is looking at.
           */
          const removed: SyncStatusResponse["removed"] = [];
          for (const locked of probe.lockedPlans) {
            if (!hasLocalScenario(scope.ou, locked.id)) continue;
            if (pendingCount(locked.id, scope.ou) > 0) continue;
            const local = scenarioLabel(scope.ou, locked.id);
            try {
              removeUnsharedPlan(locked.id, scope.ou);
            } catch {
              // A locked plan we failed to remove is not a reason to fail the
              // page. It stays listed, frozen, and the next status call retries.
              continue;
            }
            removed.push({
              planId: locked.id,
              label: local ?? "A plan",
              ownerEmail: null,
            });
          }

          const scenarios = localScenarios(scope.ou);
          const localIds = new Set(scenarios.map((scenario) => scenario.id));

          /**
           * Plans the server holds that this computer has no scenario for.
           *
           * `/sync/heads` already lists them — it is resolved through the same
           * resolver as the routes, so it covers plans owned from another
           * machine and plans delegated to this caller. They used to be
           * discarded because the page was built from the local table alone.
           *
           * `GET /plans` is what carries the label and year (a head has neither),
           * and it is called ONLY when there is such a plan, so the steady state
           * where every plan is already local costs nothing extra. ARCHIVED
           * plans are left out: they are not something to start working on.
           */
          const missingHeads = (heads?.plans ?? []).filter(
            (head) => !localIds.has(head.id) && head.state === "ACTIVE"
          );
          /**
           * Frozen copies: held here, and unreadable.
           *
           * Only reachable with unpublished work in them — the sweep above took
           * everything else. They need the listing for the same reason a locked
           * tile does: naming the owner is what turns "you have lost access" into
           * something the reader can act on, and a head carries no email.
           */
          const frozenLocalHeads = (heads?.plans ?? []).filter(
            (head) => localIds.has(head.id) && !canRead(head.relation)
          );
          /**
           * A plan held here that somebody else owns.
           *
           * A delegate's copy, in other words. `GET /plans` is the only place
           * the owner's address lives, and it is the one fact that turns every
           * "ask the plan's owner" sentence in the app from advice into an
           * action — the Delegation page header, the read-only setup card, the
           * refusal on a structure edit. Cheap: one listing per property, and
           * only where such a plan exists.
           */
          const nonOwnedLocal = scenarios.some((scenario) => {
            const relation = (headById.get(scenario.id)?.relation ??
              states.get(scenario.id)?.relation ??
              null) as Relation | null;
            return (
              relation !== null &&
              relation !== "OWNER" &&
              relation !== "OWNER_DEGRADED"
            );
          });
          let remoteSummaries: PlanSummary[] = [];
          if (
            missingHeads.length > 0 ||
            frozenLocalHeads.length > 0 ||
            removed.length > 0 ||
            nonOwnedLocal
          ) {
            try {
              remoteSummaries = await plansApi.listPlans(client, scope.ou);
            } catch {
              // A page that renders the local plans is better than no page.
              remoteSummaries = [];
            }
          }
          const summaryById = new Map(
            remoteSummaries.map((summary) => [summary.id, summary])
          );

          const localByName = new Map(
            scenarios.map((scenario) => [
              nameKey(scenario.year, scenario.label),
              scenario.id,
            ])
          );
          const remoteByName = new Map<string, string>();
          for (const head of missingHeads) {
            const summary = summaryById.get(head.id);
            if (summary) remoteByName.set(nameKey(summary.year, summary.label), head.id);
          }
          /** Can the plan on the other side of a name clash actually be pulled? */
          const readableById = new Map(
            (heads?.plans ?? []).map((head) => [head.id, canRead(head.relation)])
          );

          // Now that the listing has been fetched, the purge notices can name the
          // owner — which is the one fact that makes the message actionable
          // rather than merely alarming.
          for (const notice of removed) {
            notice.ownerEmail = summaryById.get(notice.planId)?.ownerEmail ?? null;
          }

          const plans: PlanSyncStatus[] = scenarios.map((scenario): PlanSyncStatus => {
            const head = headById.get(scenario.id);
            const state = states.get(scenario.id);
            const relation = (head?.relation ?? state?.relation ?? null) as Relation | null;
            const ownership = cachedOwnership(scenario.id);
            const twinPlanId =
              head === undefined && state === undefined
                ? remoteByName.get(nameKey(scenario.year, scenario.label)) ?? null
                : null;
            return {
              planId: scenario.id,
              ou: scope.ou,
              year: scenario.year,
              label: scenario.label,
              // A state row only ever exists for a plan that appeared in a 200
              // heads, so its presence is itself proof the server knows this
              // plan — the fallback for the window between registering and the
              // next probe, where the head is not in the cached body yet.
              published: head !== undefined || state !== undefined,
              serverVersion: head?.version ?? 0,
              watermark: state?.watermark ?? 0,
              relation,
              readable: canRead(relation),
              scopeKind: (head?.scopeKind ?? state?.scopeKind ?? null) as
                | "FULL"
                | "PARTIAL"
                | null,
              departments: head?.departments ?? state?.scopeDepartments ?? null,
              // The head, never the cached state: the question is whether what
              // the server is offering now is wider than what we last pulled
              // under, and answering it from the same cached row on both sides
              // can only ever say no.
              scopeWidened: readScopeWidened(state, head),
              writeScope: writeScopeKindFor(relation, ownership),
              structureEditable: state?.structureEditable ?? false,
              handbacksPending: head?.handbacksPending ?? 0,
              // Free: `cachedOwnership` was already read for `writeScope` above.
              delegation: delegationSummary(ownership),
              lastPublishedAt: state?.lastPublishedAt ?? null,
              lastPulledAt: state?.lastPulledAt ?? null,
              pendingChanges: pendingCount(scenario.id, scope.ou),
              revoked: state?.revokedJson ? JSON.parse(state.revokedJson) : null,
              onThisComputer: true,
              // Null only for an owner: printing your own address back at you
              // is noise. Everybody else needs it — a delegate's Delegation
              // page header names who to ask, the read-only setup card names
              // who can publish it, and a frozen copy names who could restore
              // it. Gating this on `canRead` withheld it from exactly the
              // people the address exists for.
              ownerEmail:
                relation === "OWNER" || relation === "OWNER_DEGRADED"
                  ? null
                  : summaryById.get(scenario.id)?.ownerEmail ?? null,
              serverRows: 0,
              // Only meaningful while this copy is unpublished: once it has its
              // own plan on the server, the same name elsewhere is a coincidence.
              twinPlanId,
              twinReadable: twinPlanId === null || (readableById.get(twinPlanId) ?? false),
            };
          });

          for (const head of missingHeads) {
            const summary = summaryById.get(head.id);
            // No summary means `GET /plans` failed or did not list it. There is
            // nothing to call it on screen, so it stays out rather than being
            // rendered as an untitled row.
            if (!summary) continue;
            const state = states.get(head.id);
            const readable = canRead(head.relation);
            const twinPlanId =
              localByName.get(nameKey(summary.year, summary.label)) ?? null;
            plans.push({
              planId: head.id,
              ou: scope.ou,
              year: summary.year,
              label: summary.label,
              published: true,
              // Null on a discovery-only entry, and a null version is not
              // version 0 — `readable` is what carries that, so the zero here is
              // never read as "an empty plan".
              serverVersion: head.version ?? 0,
              watermark: state?.watermark ?? 0,
              relation: head.relation,
              readable,
              scopeKind: head.scopeKind,
              departments: head.departments,
              // No local copy, so there is no narrower scope for this to be
              // wider than — and `runPull` full-pulls a plan we do not hold
              // regardless. `CLOUD_ONLY` already says "download it".
              scopeWidened: false,
              // Nothing local to write, whatever the relation says.
              writeScope: readable ? "UNKNOWN" : "NONE",
              structureEditable: false,
              handbacksPending: head.handbacksPending,
              // Nothing local, so nothing has ever asked `/department-ownership`
              // about it. `stale`, not empty — see `delegationSummary`.
              delegation: null,
              lastPublishedAt: null,
              lastPulledAt: state?.lastPulledAt ?? null,
              pendingChanges: 0,
              revoked: null,
              onThisComputer: false,
              ownerEmail: summary.ownerEmail,
              serverRows: summary.entityCount ?? 0,
              twinPlanId,
              // A local plan is always downloadable-over by its own owner; the
              // question only arises in the other direction.
              twinReadable: true,
            });
          }

          return {
            ou: scope.ou,
            authzVersion: heads?.authzVersion ?? null,
            plans,
            structureVersion: heads?.structureVersion ?? 0,
            piiEnabled,
            bst: heads?.bst ?? null,
            clustersVersion: heads?.clustersVersion ?? 0,
            upToDate: probe.notModified,
            removed,
          };
        })
      );
    },

    // -------------------------------------------------------------- plans

    [KAIROS_SYNC_CHANNELS.registerPlan]: async (
      _event,
      request: { ou: string; planId: string }
    ) => {
      return envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const scenario = prepared(
            localDbHandle(),
            `SELECT id, year, label FROM scenarios WHERE id = ? AND ou = ?`
          ).get(request.planId, scope.ou) as
            | { id: string; year: number; label: string }
            | undefined;
          if (!scenario) throw new Error("That planning scenario no longer exists.");

          // The scenario id IS the plan id, so a retry of this call returns the
          // existing plan rather than creating a second one.
          return plansApi.createPlan(client, {
            id: scenario.id,
            ou: scope.ou,
            year: scenario.year,
            label: scenario.label,
            clientUpdatedAt: new Date().toISOString(),
          });
        })
      );
    },

    // --------------------------------------------------------------- pull

    [KAIROS_SYNC_CHANNELS.previewPull]: async (
      _event,
      request: { ou: string; planId: string }
    ) => envelope(await attempt(() => runPull(request, false), request.planId)),

    [KAIROS_SYNC_CHANNELS.pull]: async (
      _event,
      request: { ou: string; planId: string; replaceLocalPlanId?: string | null }
    ) => envelope(await attempt(() => runPull(request, true), request.planId)),

    // ------------------------------------------------------------ publish

    [KAIROS_SYNC_CHANNELS.previewPublish]: async (
      _event,
      request: { ou: string; planId: string }
    ) => {
      return envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const probe = await fetchHeads(secureDb(), client, scope.ou);
          const head = headFor(probe.heads, request.planId);
          // Before deciding what is withheld, not after being told by the
          // server. A department delegated away is not writable by its owner,
          // and only this call knows that.
          if (canRead(head?.relation ?? null)) await refreshOwnership(request.planId);
          const writeScope = writeScopeFor(request.planId, head);
          // Raised here as well as on publish so the refusal arrives at the
          // review step, before the user has confirmed anything.
          assertCanPublish(request.planId, writeScope, head);
          const preview = previewPublish(stores(), secureDb(), {
            planId: request.planId,
            ou: scope.ou,
            baseVersion: 0,
            scope: writeScope,
            limits: limitsFrom(probe.heads),
            includePii: await piiAllowed(scope.ou),
          });
          return {
            planId: request.planId,
            byType: preview.byType,
            total: preview.total,
            chunks: preview.chunks,
            withheld: preview.withheld.map((entity) => ({
              entityType: entity.entityType,
              entityId: entity.entityId,
              department: entity.department,
            })),
            unclassified: preview.unclassified.map((entity) => ({
              entityType: entity.entityType,
              entityId: entity.entityId,
            })),
            localProblems: preview.localProblems,
          };
        }, request.planId)
      );
    },

    [KAIROS_SYNC_CHANNELS.publish]: async (
      _event,
      request: { ou: string; planId: string }
    ) => envelope(await attempt(() => runPublish(request, false), request.planId)),

    [KAIROS_SYNC_CHANNELS.publishOverServer]: async (
      _event,
      request: { ou: string; planId: string }
    ) => envelope(await attempt(() => runPublish(request, true), request.planId)),

    // -------------------------------------------------------- reconcile

    [KAIROS_SYNC_CHANNELS.reconcile]: async (
      _event,
      request: { ou: string; planId: string }
    ) => {
      return envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const db = secureDb();
          // Whether an absent row means "deleted here" or "never shared with
          // me". Costs the probe, which is cached and usually a 304.
          const probe = await fetchHeads(db, client, scope.ou);
          const widened = readScopeWidened(
            getSyncState(db, request.planId),
            headFor(probe.heads, request.planId)
          );
          const result = await reconcilePlan(db, client, request.planId, widened);
          return {
            planId: result.planId,
            matched: result.matched,
            needed: result.needed.length,
            toPull: result.serverOnly.filter((row) => row.action === "pull").length,
            toPurge: result.purges.length,
            tombstones: result.serverOnly.filter(
              (row) => row.action === "record-tombstone"
            ).length,
            truncated: result.truncated,
            suggestFullPull: result.suggestFullPull,
          };
        })
      );
    },

    [KAIROS_SYNC_CHANNELS.rebuildShadow]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const rows = await rebuildShadowFromServer(
            secureDb(),
            client,
            request.planId
          );
          return { planId: request.planId, rows };
        })
      ),

    // -------------------------------------------------------- structure

    [KAIROS_SYNC_CHANNELS.previewStructure]: async (
      _event,
      request: { ou: string }
    ) => envelope(await attempt(() => runStructurePull(request.ou, false))),

    [KAIROS_SYNC_CHANNELS.pullStructure]: async (_event, request: { ou: string }) =>
      envelope(await attempt(() => runStructurePull(request.ou, true))),

    [KAIROS_SYNC_CHANNELS.pushStructure]: async (
      _event,
      request: { ou: string; structureVersion?: number | null }
    ) =>
      envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          return pushStructure(
            localDbHandle(),
            client,
            scope.ou,
            request.structureVersion ?? null
          );
        })
      ),

    // -------------------------------------------------------- delegation

    [KAIROS_SYNC_CHANNELS.departmentOwnership]: async (
      _event,
      request: { ou: string; planId: string; unconditional?: boolean }
    ) => {
      return envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          // `unconditional` is the human escape hatch, and it is on no automatic
          // path: it bypasses `If-None-Match` so somebody staring at a lock
          // nobody holds can settle in one click whether this computer is
          // serving a stale body or the server really is saying no. Every other
          // caller stays conditional — see `fetchOwnership`, which spends the
          // same request by itself when the cached answer contradicts itself.
          const result = await fetchOwnership(secureDb(), client, request.planId, {
            unconditional: request.unconditional === true,
          });
          return result.ownership;
        }, request.planId)
      );
    },

    [KAIROS_SYNC_CHANNELS.delegatableDepartments]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return delegation.listDelegatableDepartments(client, request.planId);
        })
      ),

    [KAIROS_SYNC_CHANNELS.delegationCandidates]: async (
      _event,
      request: { ou: string; planId: string; q?: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return delegation.listCandidates(client, request.planId, request.q);
        })
      ),

    [KAIROS_SYNC_CHANNELS.listDelegations]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return delegation.listDelegations(client, request.planId);
        })
      ),

    // Deliberately NOT OU-gated: my delegations span every hotel I work at.
    [KAIROS_SYNC_CHANNELS.myDelegations]: async () =>
      envelope(await attempt(() => delegation.listMyDelegations(client))),

    [KAIROS_SYNC_CHANNELS.grantDelegation]: async (
      _event,
      request: { ou: string; planId: string; body: DelegationCreate }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await delegation.grantDelegation(
            client,
            request.planId,
            request.body
          );
          forgetOwnership(request.planId);
          return result;
        })
      ),

    [KAIROS_SYNC_CHANNELS.amendDelegation]: async (
      _event,
      request: {
        ou: string;
        planId: string;
        delegationId: string;
        patch: Partial<DelegationCreate>;
      }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await delegation.amendDelegation(
            client,
            request.planId,
            request.delegationId,
            request.patch
          );
          forgetOwnership(request.planId);
          return result;
        })
      ),

    [KAIROS_SYNC_CHANNELS.revokeDelegation]: async (
      _event,
      request: {
        ou: string;
        planId: string;
        delegationId: string;
        reason: string;
        force?: boolean;
      }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await delegation.revokeDelegation(
            client,
            request.planId,
            request.delegationId,
            request.reason,
            request.force === true
          );
          forgetOwnership(request.planId);
          return result;
        })
      ),

    [KAIROS_SYNC_CHANNELS.handBack]: async (
      _event,
      request: { ou: string; planId: string; departmentCode: string; note?: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await delegation.handBack(
            client,
            request.planId,
            request.departmentCode,
            request.note
          );
          forgetOwnership(request.planId);
          return result;
        })
      ),

    [KAIROS_SYNC_CHANNELS.handBackAll]: async (
      _event,
      request: { ou: string; planId: string; force?: boolean }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await delegation.handBackAll(
            client,
            request.planId,
            request.force === true
          );
          forgetOwnership(request.planId);
          return result;
        }, request.planId)
      ),

    [KAIROS_SYNC_CHANNELS.reopenDepartment]: async (
      _event,
      request: {
        ou: string;
        planId: string;
        delegationId: string;
        departmentCode: string;
        reason?: string;
      }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await delegation.reopen(
            client,
            request.planId,
            request.delegationId,
            request.departmentCode,
            request.reason
          );
          forgetOwnership(request.planId);
          return result;
        })
      ),

    // Local only — no client call at all, so it works offline, which is the
    // point: the handback confirmation that depends on it must not be the thing
    // that fails when the network does.
    [KAIROS_SYNC_CHANNELS.pendingByDepartment]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt((): PendingByDepartment => {
          const scope = resolveOuScope(request.ou);
          const byDepartment = pendingByDepartment(request.planId, scope.ou);
          return {
            planId: request.planId,
            byDepartment,
            total: Object.values(byDepartment).reduce((sum, n) => sum + n, 0),
          };
        })
      ),

    [KAIROS_SYNC_CHANNELS.presence]: async (
      _event,
      request: {
        ou: string;
        planId: string;
        dirtyEntities: number;
        departments: string[];
        lastLocalEditAt: string | null;
      }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return {
            sent: await delegation.sendPresence(client, request.planId, {
              dirtyEntities: request.dirtyEntities,
              departments: request.departments,
              lastLocalEditAt: request.lastLocalEditAt,
            }),
          };
        })
      ),

    [KAIROS_SYNC_CHANNELS.activity]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return delegation.fetchActivity(client, request.planId);
        })
      ),

    // --------------------------------------------------------------- pii

    [KAIROS_SYNC_CHANNELS.piiSummary]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return pii.fetchPiiSummary(client, request.planId);
        })
      ),

    [KAIROS_SYNC_CHANNELS.pullPii]: async (
      _event,
      request: { ou: string; planId: string; apply?: boolean }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const db = secureDb();
          const state = getSyncState(db, request.planId);
          return pii.pullPii(db, db, client, request.planId, state?.piiWatermark ?? 0, {
            apply: request.apply === true,
          });
        })
      ),

    [KAIROS_SYNC_CHANNELS.erasePii]: async (
      _event,
      request: { ou: string; planId: string; reason: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return pii.erasePii(client, request.planId, request.reason);
        })
      ),

    [KAIROS_SYNC_CHANNELS.ouSettings]: async (_event, request: { ou: string }) =>
      envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          return pii.fetchOuSettings(client, scope.ou);
        })
      ),

    // --------------------------------------------------------------- bst

    [KAIROS_SYNC_CHANNELS.bstVersion]: async (_event, request: { ou: string }) =>
      envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const result = await bst.fetchBstVersion(client, scope.ou, null);
          return result.version;
        })
      ),

    [KAIROS_SYNC_CHANNELS.pushBst]: async (
      _event,
      request: { ou: string; knownContentHash?: string | null }
    ) =>
      envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          return bst.pushBst(
            localDbHandle(),
            client,
            scope.ou,
            request.knownContentHash ?? null
          );
        })
      ),

    [KAIROS_SYNC_CHANNELS.pullBst]: async (_event, request: { ou: string }) =>
      envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          return bst.fetchBst(client, scope.ou);
        })
      ),

    [KAIROS_SYNC_CHANNELS.kpiSeries]: async (
      _event,
      request: { ou: string; request: KpiSeriesRequest }
    ) =>
      envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          return bst.fetchKpiSeries(client, scope.ou, request.request);
        })
      ),

    [KAIROS_SYNC_CHANNELS.pushEligibility]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return bst.fetchPushEligibility(client, request.planId);
        })
      ),

    [KAIROS_SYNC_CHANNELS.logBstPush]: async (
      _event,
      request: {
        ou: string;
        planId: string;
        targetFile: string;
        rowsWritten: number;
        backupTaken: boolean;
        monthPlan?: Record<string, unknown> | null;
      }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return {
            logged: await bst.logBstPush(client, request.planId, {
              targetFile: request.targetFile,
              rowsWritten: request.rowsWritten,
              backupTaken: request.backupTaken,
              monthPlan: request.monthPlan ?? null,
            }),
          };
        })
      ),

    // --------------------------------------------------------- artifacts

    [KAIROS_SYNC_CHANNELS.artifacts]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return artifacts.listArtifacts(client, request.planId);
        })
      ),

    [KAIROS_SYNC_CHANNELS.pushEngineOutput]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          return artifacts.pushEngineOutput(
            secureDb(),
            client,
            scope.ou,
            request.planId
          );
        })
      ),

    // ---------------------------------------------------------- clusters

    // Cross-OU by definition, like the rest of the hotel-clusters surface.
    [KAIROS_SYNC_CHANNELS.clusters]: async () =>
      envelope(await attempt(() => plansApi.fetchClusters(client, null))),

    [KAIROS_SYNC_CHANNELS.clusterDivergence]: async (
      _event,
      request: { clusterId: string; year: number }
    ) =>
      envelope(
        await attempt(() =>
          plansApi.fetchClusterDivergence(client, request.clusterId, request.year)
        )
      ),

    // -------------------------------------------------------- plan admin

    [KAIROS_SYNC_CHANNELS.planVersion]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return plansApi.fetchPlanVersion(client, request.planId);
        }, request.planId)
      ),

    /**
     * Hand the plan to a new owner.
     *
     * Not an administrator action: `plan:transfer` is an OWNER capability, so an
     * owner calls this directly with no lease and nobody else involved. It is
     * also the answer to "the person who builds the plan is not the person who
     * pushes it to the workbook" — a delegate can never push, however many
     * departments they hold, so that hand-off has to be a transfer.
     */
    [KAIROS_SYNC_CHANNELS.transferPlan]: async (
      _event,
      request: { ou: string; planId: string; newOwnerUserId: number; reason: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await plansApi.transferPlan(
            client,
            request.planId,
            request.newOwnerUserId,
            request.reason
          );
          // Ownership just moved, so every cached authorization answer for this
          // plan is now a claim about the past. Drop them rather than let the
          // grid keep locking rows against the previous relation.
          //
          // On THIS computer that relation has usually inverted outright: the
          // caller was the owner a moment ago and is now a read-only delegate,
          // holding the read-only delegation the transfer left them. Nothing
          // short of re-reading can discover that, and `relation` has to go with
          // the ownership body or the next read is answered from a cache that
          // still thinks this machine owns the plan.
          //
          // `revokedJson` goes with them, for the same reason: it is an
          // authorization answer, and after a handover it can only be a claim
          // about a grant that no longer describes this machine's relationship
          // to the plan. The probe retracts it too — doing it here as well means
          // the page is right on the render straight after the transfer rather
          // than one probe later.
          updateSyncState(secureDb(), request.planId, {
            relation: null,
            scopeKind: null,
            scopeDepartments: null,
            ownershipEtag: null,
            ownershipJson: null,
            revokedJson: null,
          });
          return result;
        }, request.planId)
      ),

    [KAIROS_SYNC_CHANNELS.patchPlan]: async (
      _event,
      request: { ou: string; planId: string; label?: string; state?: "ACTIVE" | "ARCHIVED" }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const patch: Record<string, unknown> = {};
          if (request.label !== undefined) patch.label = request.label;
          if (request.state !== undefined) patch.state = request.state;
          return plansApi.patchPlan(client, request.planId, patch);
        }, request.planId)
      ),

    [KAIROS_SYNC_CHANNELS.deletePlan]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return plansApi.deletePlan(client, request.planId);
        }, request.planId)
      ),

    /**
     * Throw away a local copy of a plan that is no longer shared with us.
     *
     * No request goes out, and none could: the server refuses every read of this
     * plan, which is the reason the copy has to go. Local only, and hard.
     *
     * Guarded on readability rather than trusted from the renderer. This is the
     * one channel in the feature that destroys data with no server-side undo, so
     * "is this plan really unreadable?" is answered here, from the probe, not
     * from a flag the caller passed in.
     */
    [KAIROS_SYNC_CHANNELS.discardLocalPlan]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const probe = await fetchHeads(secureDb(), client, scope.ou);
          const head = headFor(probe.heads, request.planId);
          if (head && canRead(head.relation)) {
            throw new Error(
              "This plan is shared with you again. Download it instead of " +
                "discarding your copy — refresh the page to see the change."
            );
          }
          removeUnsharedPlan(request.planId, scope.ou);
          return { planId: request.planId };
        })
      ),

    // ------------------------------------------------------------- lease

    [KAIROS_SYNC_CHANNELS.lease]: async (
      _event,
      request: { ou: string; planId: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return plansApi.fetchLease(client, request.planId);
        })
      ),

    [KAIROS_SYNC_CHANNELS.acquireLease]: async (
      _event,
      request: { ou: string; planId: string; lease: LeaseCreate }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await plansApi.acquireLease(client, request.planId, request.lease);
          // An EXCLUSIVE lease changes what this caller may write, and the grid
          // reads that from the cached ownership. Invalidate so the next render
          // asks rather than staying read-only under a lease that grants write.
          updateSyncState(secureDb(), request.planId, {
            ownershipEtag: null,
            ownershipJson: null,
            relation: request.lease.mode === "EXCLUSIVE" ? "ADMIN_LEASE" : null,
          });
          return result;
        }, request.planId)
      ),

    [KAIROS_SYNC_CHANNELS.extendLease]: async (
      _event,
      request: { ou: string; planId: string; minutes: number }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return plansApi.extendLease(client, request.planId, request.minutes);
        }, request.planId)
      ),

    /**
     * Release, and accept the consequence: handback bumps `syncEpoch`, so every
     * client at the property full-refreshes and the server wins outright. The
     * local shadow is therefore a set of claims about a history that no longer
     * applies, and the caller's own relation reverts.
     */
    [KAIROS_SYNC_CHANNELS.releaseLease]: async (
      _event,
      request: { ou: string; planId: string; summary: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const result = await plansApi.releaseLease(
            client,
            request.planId,
            request.summary
          );
          updateSyncState(secureDb(), request.planId, {
            relation: null,
            scopeKind: null,
            scopeDepartments: null,
            ownershipEtag: null,
            ownershipJson: null,
          });
          return result;
        }, request.planId)
      ),

    // ---------------------------------------------------- administration

    [KAIROS_SYNC_CHANNELS.adminProbe]: async () =>
      envelope(await attempt(async () => ({ isAdmin: await admin.probeAdmin(client) }))),

    [KAIROS_SYNC_CHANNELS.adminHotels]: async () =>
      envelope(await attempt(() => admin.fetchAdminHotels(client))),

    [KAIROS_SYNC_CHANNELS.adminPlans]: async (
      _event,
      request: {
        ou?: string | null;
        year?: number | null;
        ownerIneligible?: boolean | null;
        limit?: number | null;
        offset?: number | null;
      } = {}
    ) => envelope(await attempt(() => admin.fetchAdminPlans(client, request))),

    [KAIROS_SYNC_CHANNELS.adminAudit]: async (
      _event,
      request: { planId?: string | null; action?: string | null; limit?: number | null } = {}
    ) => envelope(await attempt(() => admin.fetchAdminAudit(client, request))),

    [KAIROS_SYNC_CHANNELS.adminDownloads]: async (
      _event,
      request: { planId?: string | null; limit?: number | null } = {}
    ) => envelope(await attempt(() => admin.fetchAdminDownloads(client, request))),

    [KAIROS_SYNC_CHANNELS.adminUserScope]: async (
      _event,
      request: { userId: number; planId?: string | null; capability?: string | null }
    ) =>
      envelope(
        await attempt(() =>
          admin.fetchUserScope(
            client,
            request.userId,
            request.planId ?? null,
            request.capability ?? null
          )
        )
      ),

    /**
     * Export a plan. Saved to the user's Downloads folder rather than returned:
     * the payload is a whole hotel's plan and moving it across IPC only to write
     * it out again buys nothing.
     */
    [KAIROS_SYNC_CHANNELS.adminBundle]: async (_event, request: BundleOptions) =>
      envelope(
        await attempt(() =>
          admin.downloadBundle(client, app.getPath("downloads"), request)
        )
      ),

    [KAIROS_SYNC_CHANNELS.putOuSettings]: async (
      _event,
      request: { ou: string; piiEnabled: boolean; reason: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return pii.putOuSettings(client, request.ou, request.piiEnabled, request.reason);
        })
      ),
  };

  // ------------------------------------------------------------- helpers

  /**
   * Publish, optionally over the top of whatever the server holds.
   *
   * `adoptServerHashes` is the deliberate-overwrite path from §5 of the API
   * guide. There is no force flag in the protocol and this does not invent one:
   * it re-reads the server's manifest into the shadow, so the commit that
   * follows carries the server's own current hashes as `baseHash` and is
   * therefore accepted as an ordinary update rather than refused as STALE.
   *
   * Two rules survive it, because they are not the client's to decide:
   * **delete wins** (a live local row over a server tombstone is still
   * `DELETED_REMOTELY`), and a delegate's writes still stay inside their
   * departments. Everything else genuinely is the user's call, which is why this
   * exists as a choice offered next to "download and lose local" rather than as
   * a hidden default.
   */
  async function runPublish(
    request: { ou: string; planId: string },
    adoptServerHashes: boolean
  ) {
    const scope = resolveOuScope(request.ou);
    const db = secureDb();
    const probe = await fetchHeads(db, client, scope.ou);
    const head = headFor(probe.heads, request.planId);
    // The same refresh the preview does. Publishing straight from the card
    // without previewing is a supported path, and it must not send rows the
    // preview would have withheld.
    if (canRead(head?.relation ?? null)) await refreshOwnership(request.planId);
    const writeScope = writeScopeFor(request.planId, head);
    assertCanPublish(request.planId, writeScope, head);

    if (adoptServerHashes) {
      await rebuildShadowFromServer(db, client, request.planId);
    }

    const result = await publishPlan(stores(), db, client, {
      planId: request.planId,
      ou: scope.ou,
      baseVersion: await resolveBaseVersion(db, client, probe.heads, request.planId),
      scope: writeScope,
      limits: limitsFrom(probe.heads),
      includePii: await piiAllowed(scope.ou),
    });

    // A publish that got through means the delegation is working again, so the
    // "your access was withdrawn" banner has to go — it is never auto-cleared
    // anywhere else, by design.
    clearRevocation(request.planId);

    // Tell the server the local work is published, so an owner about to revoke
    // is not warned about work that no longer exists.
    if (!result.noop) {
      await delegation.sendPresence(client, request.planId, {
        dirtyEntities: 0,
        departments: [],
        lastLocalEditAt: null,
      });
    }

    return {
      planId: result.planId,
      committedVersion: result.committedVersion,
      accepted: result.accepted,
      unchanged: result.unchanged,
      overrodeBase: result.overrodeBase,
      conflicts: result.conflicts,
      rejected: result.rejected,
      withheld: result.withheld,
      purged: result.purged,
      adopted: result.adopted,
      localProblems: result.localProblems,
      // Both carried so the result alert can tell "you did something wrong"
      // apart from "the app sent something only an owner may send". A reason
      // code this caller's role could not have caused is counted, never
      // explained — see PublishResultAlert.
      relation: (head?.relation ?? null) as Relation | null,
      structureEditable: writeScope.canWriteStructure,
      noop: result.noop,
    };
  }

  /**
   * Bring a cloud-only plan onto this computer even when the delta is empty.
   *
   * A plan is "on this computer" if and only if it has a live `scenarios` row —
   * that is what the Positions page lists and what the Sync page counts. The row
   * normally arrives as part of the download, because `scenario` is a published
   * entity type; but it only arrives if somebody managed to publish it, and
   * until the write-scope fix above they frequently could not.
   *
   * Rather than leave those plans permanently un-downloadable, the row is
   * synthesised from `GET /plans/{id}` — which is the same year and label the
   * cloud card was already displaying. Only ever called when there is no live
   * local row, so it can neither overwrite a scenario the pull just wrote nor
   * rename one the user already has.
   */
  async function ensureLocalScenario(ou: string, planId: string): Promise<boolean> {
    const summary = await plansApi.getPlan(client, planId);
    const now = new Date().toISOString();
    prepared(
      localDbHandle(),
      `INSERT INTO scenarios (id, ou, year, label, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         ou = excluded.ou,
         year = excluded.year,
         label = excluded.label,
         updated_at = excluded.updated_at,
         -- Un-deletes a scenario the user had removed locally. That is the
         -- point: they have just asked for the server's copy back.
         deleted_at = NULL`
    ).run(planId, ou, summary.year, summary.label, now);
    return true;
  }

  /**
   * Make sure the write scope is current before we decide what to send.
   *
   * `/department-ownership` is the only call that knows which departments this
   * caller may WRITE, and until now nothing but the Delegation page and the
   * positions grid ever made it. An owner who delegated Rooms from another
   * machine — or simply granted it and went straight to Sync — therefore
   * published against a scope derived from the plan head, which describes what
   * they may READ and says FULL. Every Rooms row in that publish comes back
   * `DEPARTMENT_OUT_OF_SCOPE`, and the preview that was supposed to warn them
   * listed nothing as withheld.
   *
   * It is ETag'd server-side and cached here, so in the steady state this is a
   * 304 and a few hundred bytes. A failure is not fatal: the cached answer, or
   * the head fallback, is what `writeScopeFor` already degrades to.
   *
   * This used to carry its own copy of the cache-write block, which is how the
   * publish path came to share the channel's defect — a 200 with an empty body
   * read as "unchanged" and left the filter on a stale scope, withholding rows
   * with nothing on screen to say so. One implementation now, in `ownership.ts`.
   */
  async function refreshOwnership(planId: string): Promise<void> {
    try {
      await fetchOwnership(secureDb(), client, planId);
    } catch {
      // Offline, or a plan the server will not discuss. Both are already
      // handled downstream — this is an accuracy improvement, not a gate.
    }
  }

  /**
   * Drop the cached write scope after a call that just changed it.
   *
   * `transferPlan`, `acquireLease` and `releaseLease` have always done this. The
   * six delegation mutations did not — and they are the ones that change this
   * answer most often — so the client depended entirely on the server folding
   * delegation state into the ETag, with no fallback and nothing to press. The
   * visible cost was a toast reading "Delegation withdrawn. You can edit those
   * departments again." over a grid still locked from the cache.
   *
   * `handBack` and `handBackAll` run on the DELEGATE's machine and invalidate
   * theirs: the mirror-image bug, where a grid stays editable after its holder
   * has given the department away.
   *
   * Note the knock-on: with the ETag gone, the `refreshOwnership` before the
   * next publish makes an unconditional request and cannot be answered 304, so
   * the publish filter self-heals after any locally-initiated grant change.
   */
  function forgetOwnership(planId: string): void {
    invalidateOwnership(secureDb(), planId);
  }

  /** Does this computer hold a live scenario row for the plan? */
  function hasLocalScenario(ou: string, planId: string): boolean {
    return (
      prepared(
        localDbHandle(),
        `SELECT 1 FROM scenarios WHERE id = ? AND ou = ? AND deleted_at IS NULL`
      ).get(planId, ou) !== undefined
    );
  }

  async function runPull(
    request: { ou: string; planId: string; replaceLocalPlanId?: string | null },
    apply: boolean
  ) {
    const scope = resolveOuScope(request.ou);
    const db = secureDb();
    const probe = await fetchHeads(db, client, scope.ou);
    const state = getSyncState(db, request.planId);

    /**
     * A delta is only meaningful against a copy we hold.
     *
     * For a plan this computer does not have, `since = watermark` is the wrong
     * question — and a stale watermark from an earlier download that landed rows
     * but never produced a `scenarios` row made it a trap: the server correctly
     * answers "nothing since then", the download applies nothing, and the plan
     * can never become local. Downloading a plan we do not hold is always a full
     * pull, whatever we think we saw last time.
     */
    const onThisComputer = hasLocalScenario(scope.ou, request.planId);

    /**
     * ...and it is only meaningful against a copy of the same SHAPE.
     *
     * A delta answers "what changed since N", which is a complete answer only
     * while "what I may read" has not moved. When it widens — a delegation
     * amended to cover more departments, or the delegate made this plan's owner
     * — the newly-visible rows were written long before N and no future delta
     * will ever mention them again. See `readScopeWidened` for why the scope
     * itself has to be the signal: `version` and `syncEpoch` are both untouched
     * by a grant change, and `authzVersion` cannot name the plan.
     *
     * Deliberately not a `clearShadow`. The epoch path in `pull.ts` discards the
     * local view because there the server wins outright; here the copy we hold
     * is correct, only incomplete, and the shadow is what stops `purgesFor`
     * reading the rows we never had as rows we deleted.
     */
    const widened = readScopeWidened(state, headFor(probe.heads, request.planId));
    const since = onThisComputer && !widened ? state?.watermark ?? 0 : 0;

    const result = await pullPlan(stores(), db, client, {
      planId: request.planId,
      ou: scope.ou,
      since,
      applyOrder: probe.heads?.applyOrder,
      apply,
      // Only worth computing for the preview — by the time we apply, the user
      // has already been shown the answer and decided.
      collidesWith: apply ? undefined : pendingEntityKeys(request.planId, scope.ou),
    });

    /**
     * The other half of the download.
     *
     * `/changes` never carries `position_pii` — it is sealed per plan and served
     * by its own paginated stream with its own watermark (see `pii.ts`). Nothing
     * called that stream, so employee names and numbers went UP with every
     * publish and never came back DOWN: a delegate's details reached the server
     * and neither the owner nor any other delegate ever saw them, and the plan
     * looked like "everything syncs except the people".
     *
     * It also left the shadow with no `position_pii` entry, ever. A publish
     * therefore sent every local PII row as new, the server answered
     * `ALREADY_EXISTS` because it had them, and the count never moved however
     * many times the user downloaded and published — the one conflict a download
     * could not settle, because the download was not fetching the rows.
     *
     * Only on apply. A dry run would double the reads, and every PII read writes
     * an audit row server-side.
     */
    let piiResult: Awaited<ReturnType<typeof pii.pullPii>> | null = null;
    if (apply) {
      try {
        const state = getSyncState(db, request.planId);
        piiResult = await pii.pullPii(
          db,
          db,
          client,
          request.planId,
          // A full pull of entities is a full pull of details too, or the two
          // halves of the plan end up describing different moments. That covers
          // a widened scope as much as a first download: the details of a
          // department we could not read are exactly as absent as its rows.
          onThisComputer && !widened ? state?.piiWatermark ?? 0 : 0,
          { apply: true }
        );
      } catch {
        // Not fatal, and deliberately not a failed download: the rows that did
        // arrive are written and the watermark is already recorded. The next
        // download picks the details up from the same watermark.
      }
    }

    // The plan's own row, if the server never had one to send. Before the twin
    // is soft-deleted below, so a failure here cannot leave the property with
    // the local plan gone and the downloaded one still not listed.
    let createdLocalPlan = false;
    if (apply && !onThisComputer && !hasLocalScenario(scope.ou, request.planId)) {
      createdLocalPlan = await ensureLocalScenario(scope.ou, request.planId);
    }

    /**
     * The name clash, resolved in the only direction that is safe.
     *
     * The server's plan arrives with its own scenario row — `scenario` is a
     * published entity type, so the pull creates it — and the local plan of the
     * same name is soft-deleted, exactly as deleting it from the Positions page
     * would. Nothing is merged and no id is rewritten: they are two plans, and
     * the user has said which one they want to keep working on.
     *
     * Only after the rows have landed. A soft delete before a pull that then
     * failed would leave the property with neither plan.
     */
    let replacedLocalPlan = false;
    if (apply && request.replaceLocalPlanId && result.applied) {
      softDeleteScenario(localDbHandle(), scope, request.replaceLocalPlanId);
      replacedLocalPlan = true;
    }

    return {
      replacedLocalPlan,
      /** The plan is now listed here, whether or not any rows came with it. */
      createdLocalPlan,
      /** True when this download is what puts the plan on this computer. */
      firstDownload: !onThisComputer,
      planId: result.planId,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      scope: result.scope,
      byType: result.summary.byType,
      deletedByType: result.summary.deletedByType,
      byDepartment: result.summary.byDepartment,
      deletedByDepartment: result.summary.deletedByDepartment,
      total: result.summary.total,
      deleted: result.summary.deleted,
      skippedTypes: result.skippedTypes,
      collides: result.summary.collides,
      collidingDepartments: result.summary.collidingDepartments,
      applied: result.applied,
      reset: result.reset,
      /**
       * Employee details, counted separately because they arrive separately.
       *
       * `unreadable` is not a blank: it is a record whose key has been erased.
       * Rendering those as empty name fields would look like a hotel that never
       * entered anybody.
       */
      pii: piiResult
        ? {
            applied: piiResult.applied,
            deleted: piiResult.deleted,
            unreadable: piiResult.unreadable,
            disabled: piiResult.disabled,
          }
        : null,
    };
  }

  async function runStructurePull(ou: string, apply: boolean) {
    const scope = resolveOuScope(ou);
    const result = await pullStructure(localDbHandle(), client, scope.ou, { apply });
    return {
      ou: scope.ou,
      serverVersion: result.document?.structureVersion ?? null,
      published: result.published,
      changes: result.changes,
      outgoing: result.outgoing,
      notModified: result.notModified,
      applied: result.applied,
    };
  }

  /**
   * Whether personal details may be published to this property.
   *
   * Checked BEFORE a publish rather than discovered as a wall of
   * `PII_NOT_PERMITTED` rejections. A failure to read the switch is treated as
   * "allowed" — the server rejects the rows individually anyway, and the rest of
   * the chunk still lands, so a network hiccup must not silently stop names
   * syncing for a hotel that wants them.
   */
  async function piiAllowed(ou: string): Promise<boolean> {
    try {
      return (await pii.fetchOuSettings(client, ou)).piiEnabled;
    } catch {
      return true;
    }
  }
}

/**
 * Rows changed locally since this machine and the server last agreed about them
 * — the Publish button's badge.
 *
 * ## Why this is per row and not per plan
 *
 * It used to be `updated_at > last_published_at`, one cutoff for the whole plan.
 * That counts a row DOWNLOADED from a colleague as a local change: applying a
 * pull writes the publisher's own `updated_at` onto the row (see
 * `entityMap.fromPayload`) and moves `last_pulled_at`, never `last_published_at`
 * — so every row that had just arrived was newer than the cutoff. A download
 * therefore left the card reading "3,412 changes not published yet", and the
 * only thing that cleared it was publishing the colleague's own work straight
 * back at them.
 *
 * The shadow already records, per row, when the server last confirmed it holds
 * that exact row — written by a pull as each page lands and by a publish as each
 * chunk is accepted. Comparing against that answers the question actually being
 * asked: has this row been touched HERE since the last time the two sides
 * agreed about it?
 *
 * ## Two stages, because a timestamp is not a change
 *
 * The timestamp comparison alone still over-counts, and in a way the user
 * cannot clear: a row re-typed to the value it already had, or touched by a
 * recalculation, an importer or a cluster propagation, has a newer `updated_at`
 * and identical content. "Check for differences" reports — correctly — that
 * everything agrees, and publishing sends nothing, because the publish path
 * compares hashes and skips it. So the number sat there with nothing that could
 * move it. Clock skew between two machines lands in the same trap.
 *
 * So the SQL narrows to CANDIDATES, and when there are few enough of them each
 * one is hashed and compared against the shadow — the same comparison a publish
 * makes, which is what makes the two agree. Above `PENDING_REFINE_LIMIT` the
 * candidate count is reported unrefined: that is a first publish or a fresh
 * download, where the set is the whole plan and the exact figure changes
 * nothing. The precise number always comes from `previewPublish`, which hashes
 * everything; running that behind a badge that refreshes on every window focus
 * would make the app stutter.
 *
 * A row with no shadow entry counts however it hashes — never published, or
 * withheld from a publish for being outside this caller's write scope, and both
 * are genuinely pending. The exception is a row that is BOTH unknown to the
 * server and deleted here, which a publish deliberately does not send: see
 * `pendingShadowIsComplete`.
 *
 * `kairos_sync_shadow` lives in the encrypted store alongside all four of these
 * tables, so stage one is a join rather than a second round trip.
 */
/**
 * The four published types that live in the encrypted store, with the SQL
 * expression that reproduces each one's entity id. Kept beside the ids in
 * `entityMap` — if one of those ever changes, this is the other place.
 */
const PENDING_SOURCES = [
  { entityType: "position", table: "positions", entityId: "r.id" },
  {
    entityType: "component_value",
    table: "component_values",
    // The composite id, exactly as `componentValueId` mints it.
    entityId: "r.position_id || ':' || r.component_def_id",
  },
  { entityType: "buyout_row", table: "buyout_rows", entityId: "r.id" },
  { entityType: "manual_input_row", table: "manual_input_rows", entityId: "r.id" },
] as const;

/**
 * Rows whose timestamp has moved since the server last confirmed them.
 *
 * `select` picks the rows themselves and is only ever run on a small candidate
 * set; `count` is the one that runs on every plan, every refresh.
 */
function candidateSql(
  source: (typeof PENDING_SOURCES)[number],
  projection: "COUNT(*) AS total" | "r.*"
): string {
  return `
    SELECT ${projection} FROM ${source.table} r
      LEFT JOIN kairos_sync_shadow s
        ON s.plan_id = r.scenario_id
       AND s.entity_type = '${source.entityType}'
       AND s.entity_id = ${source.entityId}
     WHERE r.ou = ? AND r.scenario_id = ?
       AND r.updated_at > COALESCE(s.synced_at, '')`;
}

/**
 * Above this many candidates the count is reported as-is.
 *
 * Hashing is what makes the number exact, and it is worth doing for the handful
 * of rows a working day produces. It is not worth doing for a first publish or a
 * fresh download, where the candidate set is the whole plan — and where the
 * exact number would not change what the user does anyway.
 */
const PENDING_REFINE_LIMIT = 500;

/**
 * Whether "no shadow entry" may be read here as "the server has never held it".
 *
 * The publish path drops a tombstone for a row the server never had — there is
 * no fact in it for anybody else to learn (see `toCommitEntities`). Counting one
 * here would then be a change the user is told to publish that publishing does
 * not clear: a plan stuck on "1 change not published yet" for ever, on a row no
 * longer in the grid.
 *
 * Same test as the publish path, with the watermark standing in for the base
 * version — it is the last server version this machine has taken in, so an empty
 * shadow beside a non-zero one is a shadow that has been lost rather than one
 * that was never needed. That way round the tombstone is counted AND sent, which
 * is the safe disagreement to have.
 */
function pendingShadowIsComplete(planId: string): boolean {
  const db = secureDb();
  return shadowIsComplete(countShadow(db, planId), getSyncState(db, planId)?.watermark ?? 0);
}

/**
 * WHICH rows are pending, not how many — `entityType:entityId`, the same key a
 * `/changes` page can be matched on.
 *
 * Used to answer "would this download overwrite anything of mine?". Unlike
 * `pendingCount` this always hashes, with no candidate ceiling: the answer is
 * consumed by a preview the user is waiting on rather than a badge that
 * refreshes on every window focus, and a ceiling here would silently under-report
 * a collision, which is the one direction this must never err in.
 */
function pendingEntityKeys(planId: string, ou: string): ReadonlySet<string> {
  const db = secureDb();
  const complete = pendingShadowIsComplete(planId);
  const keys = new Set<string>();
  // Positions are stamped with their effective cluster ratio before hashing —
  // the SAME transform the collector applies, or the two disagree about what
  // is pending. See clusterSnapshot.ts.
  const clusters = clusterSnapshotContext(localDbHandle());
  for (const source of PENDING_SOURCES) {
    const rows = prepared(db, candidateSql(source, "r.*")).all(ou, planId) as Row[];
    for (const row of rows) {
      const mapped = toEntity(
        source.entityType as PublishedEntityType,
        source.entityType === "position" ? stampClusterSnapshot(row, clusters) : row
      );
      const known = getShadow(db, planId, source.entityType, mapped.entityId);
      const local = { hash: contentHash(mapped.payload), deleted: mapped.deleted };
      if (isUnsent(known, local, complete)) keys.add(`${source.entityType}:${mapped.entityId}`);
    }
  }
  return keys;
}

/**
 * WHICH departments my unpublished rows are in, and how many in each.
 *
 * Answers the question a handback has to ask and the server does not: giving
 * ROOMS back removes it from my write scope, so anything of mine still sitting
 * in ROOMS becomes unpublishable the moment I press the button. The single
 * department handback route deliberately does not check this (handing back one
 * of five with four still open is routine), so the client has to.
 *
 * The same two-stage comparison as `pendingCount` — candidates by timestamp,
 * then hashed against the shadow — so this cannot disagree with the number on
 * the card. Always hashed, no `PENDING_REFINE_LIMIT` ceiling, for the same
 * reason `pendingEntityKeys` has none: the answer is consumed by a confirmation
 * somebody is waiting on, and under-reporting is the one direction it must
 * never err in.
 *
 * Local read, no network. A delegate deciding whether to publish before handing
 * back may well be on a train.
 */
function pendingByDepartment(planId: string, ou: string): Record<string, number> {
  const db = secureDb();
  const complete = pendingShadowIsComplete(planId);
  const byDepartment: Record<string, number> = {};
  // Same stamp as the collector — see pendingEntityKeys.
  const clusters = clusterSnapshotContext(localDbHandle());

  for (const source of PENDING_SOURCES) {
    const rows = prepared(db, candidateSql(source, "r.*")).all(ou, planId) as Row[];
    if (rows.length === 0) continue;

    /**
     * `component_value` is the one that needs a join.
     *
     * Its `departmentOf` returns null (entityMap.ts) because the server infers
     * the department from the parent position and a second copy on the wire
     * would be a second source of truth for an authorization input. True there,
     * useless here — the question being asked is "does handing ROOMS back
     * strand anything of mine?", and the answer lives on the parent.
     *
     * Built once per type rather than joined in SQL: the candidate set is small,
     * and the positions map is usually already needed for the position pass.
     */
    const parentDepartments =
      source.entityType === "component_value"
        ? new Map(
            (
              prepared(
                db,
                `SELECT id, department_code FROM positions WHERE ou = ? AND scenario_id = ?`
              ).all(ou, planId) as Row[]
            ).map((row) => [String(row.id), normalizeDepartment(row.department_code)])
          )
        : null;

    for (const row of rows) {
      const mapped = toEntity(
        source.entityType as PublishedEntityType,
        source.entityType === "position" ? stampClusterSnapshot(row, clusters) : row
      );
      const known = getShadow(db, planId, source.entityType, mapped.entityId);
      const local = { hash: contentHash(mapped.payload), deleted: mapped.deleted };
      if (!isUnsent(known, local, complete)) continue;

      const department =
        mapped.department ??
        (mapped.parentId !== null
          ? parentDepartments?.get(mapped.parentId) ?? null
          : null);
      const key = department ?? UNCLASSIFIED_DEPARTMENT;
      byDepartment[key] = (byDepartment[key] ?? 0) + 1;
    }
  }

  return byDepartment;
}

function pendingCount(planId: string, ou: string): number {
  const db = secureDb();

  const counts = PENDING_SOURCES.map((source) => {
    const row = prepared(db, candidateSql(source, "COUNT(*) AS total")).get(ou, planId) as
      | { total?: number }
      | undefined;
    return Number(row?.total ?? 0);
  });
  const candidates = counts.reduce((sum, value) => sum + value, 0);
  if (candidates === 0 || candidates > PENDING_REFINE_LIMIT) return candidates;

  /**
   * A newer timestamp is not a change.
   *
   * Re-typing a value that was already there, a recalculation touching a row,
   * an importer or a cluster propagation all move `updated_at` while leaving the
   * content identical. Those rows are then permanently stuck in the badge:
   * "Check for differences" correctly reports that everything agrees, and
   * publishing them is a no-op that returns before recording anything, so
   * nothing the user can press ever clears the number.
   *
   * Hashing the candidates settles it the same way a publish would — the hash
   * IS the comparison the protocol makes — and the candidate set is small by
   * construction, so this costs a few hundred hashes at most.
   */
  let changed = 0;
  const complete = pendingShadowIsComplete(planId);
  // Same stamp as the collector — see pendingEntityKeys.
  const clusters = clusterSnapshotContext(localDbHandle());
  for (const source of PENDING_SOURCES) {
    const rows = prepared(db, candidateSql(source, "r.*")).all(ou, planId) as Row[];
    for (const row of rows) {
      const mapped = toEntity(
        source.entityType as PublishedEntityType,
        source.entityType === "position" ? stampClusterSnapshot(row, clusters) : row
      );
      const known = getShadow(db, planId, source.entityType, mapped.entityId);
      // No shadow entry means the server has never confirmed this row, whatever
      // its hash happens to be — genuinely pending, unless the row is a deletion
      // of something the server never had. See `pendingShadowIsComplete`.
      const local = { hash: contentHash(mapped.payload), deleted: mapped.deleted };
      if (isUnsent(known, local, complete)) changed += 1;
    }
  }

  return changed;
}
