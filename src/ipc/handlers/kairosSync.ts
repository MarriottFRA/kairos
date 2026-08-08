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
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import { softDeleteScenario } from "../../main/positions/structureRepo";
import { prepared } from "../../main/positions/stmtCache";
import type { ApiClient } from "../../main/auth/apiClient";
import { KAIROS_ERRORS, KairosApiError, KairosClient } from "../../main/kairosSync/client";
import { fetchHeads, limitsFrom } from "../../main/kairosSync/heads";
import { contentHash } from "../../main/kairosSync/hash";
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
  getShadow,
  getSyncState,
  listSyncStates,
  updateSyncState,
} from "../../main/kairosSync/repo";
import {
  PublishedEntityType,
  Row,
  toEntity,
} from "../../shared/kairosSync/entityMap";
import { WriteScope } from "../../main/kairosSync/collect";
import {
  KAIROS_SYNC_CHANNELS,
  PlanSyncStatus,
  SyncError,
  SyncOutcome,
} from "../../shared/kairosSync/ipc";
import {
  BundleOptions,
  DelegationCreate,
  KpiSeriesRequest,
  LeaseCreate,
  PlanHead,
  PlanSummary,
  Relation,
  SyncHeads,
} from "../../shared/kairosSync/protocol";

function envelope<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

/** Flatten anything thrown into the shape the renderer branches on. */
function toSyncError(error: unknown): SyncError {
  if (error instanceof KairosApiError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      context: error.context,
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
function writeScopeFor(planId: string, head?: PlanHead | null): WriteScope {
  const state = getSyncState(secureDb(), planId);
  // `/department-ownership` is the more precise answer — its department list is
  // filtered to the ones actually writable — so it wins whenever it exists.
  const known = state?.relation != null;
  const relation = (known ? state?.relation : head?.relation ?? null) as Relation | null;
  const departments = known
    ? state?.scopeDepartments ?? null
    : head?.scopeKind === "PARTIAL"
      ? head.departments
      : null;

  return {
    // OWNER_DEGRADED keeps its departments but loses structure — exactly the
    // distinction this flag exists for. GLOBAL_ADMIN writes nothing at all.
    canWriteStructure: relation === "OWNER" || relation === "ADMIN_LEASE",
    departments: departments == null ? null : new Set(departments),
  };
}

/** The head for one plan out of a (possibly replayed) property answer. */
function headFor(heads: SyncHeads | null, planId: string): PlanHead | null {
  return heads?.plans.find((plan) => plan.id === planId) ?? null;
}

/** How each relation reads to somebody who is not holding the guide. */
const RELATION_PLAIN: Record<string, string> = {
  OWNER: "the owner of this plan",
  OWNER_DEGRADED: "the owner, but with lapsed access",
  DELEGATE: "a delegate on this plan",
  ADMIN_LEASE: "the holder of a support lease",
  GLOBAL_ADMIN: "an administrator with read-only access",
  OU_MEMBER: "a colleague with read-only access",
};

/**
 * Refuse a publish that could not send a single row, and say why.
 *
 * Without this the request goes out, every row is filtered off client-side, and
 * the result alert reports zero accepted — which looks exactly like a publish
 * that had nothing to do. The two are opposite situations and the second one
 * needs the user to go and fix something.
 *
 * Only ever raised when the scope is empty AND the relation cannot write. A
 * `null` department set means "no restriction" and must never land here.
 */
function assertCanPublish(planId: string, scope: WriteScope): void {
  if (scope.departments === null || scope.departments.size > 0) return;
  if (scope.canWriteStructure) return;

  const state = getSyncState(secureDb(), planId);
  const relation = state?.relation ?? null;
  const plain = relation ? RELATION_PLAIN[relation] ?? relation : null;

  throw new KairosApiError(
    0,
    plain
      ? `Nothing would be published. The server currently sees you as ${plain}, ` +
          "which gives you no departments to write to. If this plan is yours, its " +
          "ownership on the server does not match — ask an administrator to check it."
      : "Nothing would be published: the server has given you no departments to " +
          "write to on this plan.",
    KAIROS_ERRORS.WRITE_SCOPE_EMPTY,
    { relation }
  );
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
  if (head) return head.version;
  if (!getSyncState(db, planId)) return 0;
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
 * "Same plan" for the purposes of warning about a name clash.
 *
 * Year and label only, because that is all a human has to go on. The ids are
 * different — that is the whole problem — so this is a heuristic for a warning
 * and never a key anything is merged on.
 */
function nameKey(year: number, label: string): string {
  return `${year} ${label.trim().toLowerCase()}`;
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
          let remoteSummaries: PlanSummary[] = [];
          if (missingHeads.length > 0) {
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

          const plans: PlanSyncStatus[] = scenarios.map((scenario): PlanSyncStatus => {
            const head = headById.get(scenario.id);
            const state = states.get(scenario.id);
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
              relation: (head?.relation ?? state?.relation ?? null) as Relation | null,
              scopeKind: (head?.scopeKind ?? state?.scopeKind ?? null) as
                | "FULL"
                | "PARTIAL"
                | null,
              departments: head?.departments ?? state?.scopeDepartments ?? null,
              structureEditable: state?.structureEditable ?? false,
              handbacksPending: head?.handbacksPending ?? 0,
              lastPublishedAt: state?.lastPublishedAt ?? null,
              lastPulledAt: state?.lastPulledAt ?? null,
              pendingChanges: pendingCount(scenario.id, scope.ou),
              revoked: state?.revokedJson ? JSON.parse(state.revokedJson) : null,
              onThisComputer: true,
              ownerEmail: null,
              serverRows: 0,
              // Only meaningful while this copy is unpublished: once it has its
              // own plan on the server, the same name elsewhere is a coincidence.
              twinPlanId:
                head === undefined && state === undefined
                  ? remoteByName.get(nameKey(scenario.year, scenario.label)) ?? null
                  : null,
            };
          });

          for (const head of missingHeads) {
            const summary = summaryById.get(head.id);
            // No summary means `GET /plans` failed or did not list it. There is
            // nothing to call it on screen, so it stays out rather than being
            // rendered as an untitled row.
            if (!summary) continue;
            const state = states.get(head.id);
            plans.push({
              planId: head.id,
              ou: scope.ou,
              year: summary.year,
              label: summary.label,
              published: true,
              serverVersion: head.version,
              watermark: state?.watermark ?? 0,
              relation: head.relation,
              scopeKind: head.scopeKind,
              departments: head.departments,
              structureEditable: false,
              handbacksPending: head.handbacksPending,
              lastPublishedAt: null,
              lastPulledAt: state?.lastPulledAt ?? null,
              pendingChanges: 0,
              revoked: null,
              onThisComputer: false,
              ownerEmail: summary.ownerEmail,
              serverRows: summary.entityCount,
              twinPlanId: localByName.get(nameKey(summary.year, summary.label)) ?? null,
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
          const writeScope = writeScopeFor(
            request.planId,
            headFor(probe.heads, request.planId)
          );
          // Raised here as well as on publish so the refusal arrives at the
          // review step, before the user has confirmed anything.
          assertCanPublish(request.planId, writeScope);
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
          resolveOuScope(request.ou);
          const result = await reconcilePlan(secureDb(), client, request.planId);
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
      request: { ou: string; planId: string }
    ) => {
      return envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          const db = secureDb();
          const state = getSyncState(db, request.planId);
          const result = await delegation.fetchDepartmentOwnership(
            client,
            request.planId,
            state?.ownershipEtag ?? null
          );

          if (result.ownership) {
            updateSyncState(db, request.planId, {
              ownershipEtag: result.etag,
              ownershipJson: JSON.stringify(result.ownership),
              structureEditable: result.ownership.structureEditableByMe,
              relation: result.ownership.me.relation,
              scopeKind: result.ownership.me.scopeKind,
              // The write scope the grid locks against, and the same set the
              // publish filter uses — one answer, stored once.
              scopeDepartments: result.ownership.departments
                .filter((row) => row.writable)
                .map((row) => row.code),
            });
            return result.ownership;
          }

          // 304 — serve the cached body rather than a null the grid would read
          // as "nothing is writable".
          return state?.ownershipJson ? JSON.parse(state.ownershipJson) : null;
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
          return delegation.grantDelegation(client, request.planId, request.body);
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
          return delegation.amendDelegation(
            client,
            request.planId,
            request.delegationId,
            request.patch
          );
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
          return delegation.revokeDelegation(
            client,
            request.planId,
            request.delegationId,
            request.reason,
            request.force === true
          );
        })
      ),

    [KAIROS_SYNC_CHANNELS.handBack]: async (
      _event,
      request: { ou: string; planId: string; departmentCode: string; note?: string }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return delegation.handBack(
            client,
            request.planId,
            request.departmentCode,
            request.note
          );
        })
      ),

    [KAIROS_SYNC_CHANNELS.handBackAll]: async (
      _event,
      request: { ou: string; planId: string; force?: boolean }
    ) =>
      envelope(
        await attempt(async () => {
          resolveOuScope(request.ou);
          return delegation.handBackAll(client, request.planId, request.force === true);
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
          return delegation.reopen(
            client,
            request.planId,
            request.delegationId,
            request.departmentCode,
            request.reason
          );
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
    const writeScope = writeScopeFor(request.planId, headFor(probe.heads, request.planId));
    assertCanPublish(request.planId, writeScope);

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
    const since = onThisComputer ? state?.watermark ?? 0 : 0;

    const result = await pullPlan(stores(), db, client, {
      planId: request.planId,
      ou: scope.ou,
      since,
      applyOrder: probe.heads?.applyOrder,
      apply,
    });

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
      total: result.summary.total,
      deleted: result.summary.deleted,
      skippedTypes: result.skippedTypes,
      applied: result.applied,
      reset: result.reset,
    };
  }

  async function runStructurePull(ou: string, apply: boolean) {
    const scope = resolveOuScope(ou);
    const result = await pullStructure(localDbHandle(), client, scope.ou, { apply });
    return {
      ou: scope.ou,
      serverVersion: result.document?.structureVersion ?? null,
      changes: result.changes,
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
 * are genuinely pending.
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
  for (const source of PENDING_SOURCES) {
    const rows = prepared(db, candidateSql(source, "r.*")).all(ou, planId) as Row[];
    for (const row of rows) {
      const mapped = toEntity(source.entityType as PublishedEntityType, row);
      const known = getShadow(db, planId, source.entityType, mapped.entityId);
      // No shadow entry means the server has never confirmed this row, whatever
      // its hash happens to be. That genuinely is pending.
      if (!known || known.hash !== contentHash(mapped.payload)) {
        changed += 1;
        continue;
      }
      // Content agrees; a local delete the server has not been told about does
      // not, and is exactly the change a publish would carry.
      if (known.deleted !== mapped.deleted) changed += 1;
    }
  }

  return changed;
}
