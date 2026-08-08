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
import { prepared } from "../../main/positions/stmtCache";
import type { ApiClient } from "../../main/auth/apiClient";
import { KAIROS_ERRORS, KairosApiError, KairosClient } from "../../main/kairosSync/client";
import { fetchHeads, limitsFrom } from "../../main/kairosSync/heads";
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
  getSyncState,
  listSyncStates,
  updateSyncState,
} from "../../main/kairosSync/repo";
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
 */
function writeScopeFor(planId: string): WriteScope {
  const state = getSyncState(secureDb(), planId);
  const relation = (state?.relation ?? null) as Relation | null;
  return {
    // OWNER_DEGRADED keeps its departments but loses structure — exactly the
    // distinction this flag exists for. GLOBAL_ADMIN writes nothing at all.
    canWriteStructure: relation === "OWNER" || relation === "ADMIN_LEASE",
    departments:
      state?.scopeDepartments === null || state?.scopeDepartments === undefined
        ? null
        : new Set(state.scopeDepartments),
  };
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
  const head = heads?.plans.find((plan) => plan.id === planId);
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

          const plans: PlanSyncStatus[] = localScenarios(scope.ou).map((scenario) => {
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
            };
          });

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
      request: { ou: string; planId: string }
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
          const writeScope = writeScopeFor(request.planId);
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
    const writeScope = writeScopeFor(request.planId);
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

  async function runPull(request: { ou: string; planId: string }, apply: boolean) {
    const scope = resolveOuScope(request.ou);
    const db = secureDb();
    const probe = await fetchHeads(db, client, scope.ou);
    const state = getSyncState(db, request.planId);

    const result = await pullPlan(stores(), db, client, {
      planId: request.planId,
      ou: scope.ou,
      since: state?.watermark ?? 0,
      applyOrder: probe.heads?.applyOrder,
      apply,
    });

    return {
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
 * Rows changed locally since the last publish — the Publish button's badge.
 *
 * Deliberately an approximation. The exact figure comes from `previewPublish`,
 * which hashes every row in the plan; running that behind a badge that refreshes
 * on every window focus would make the app stutter for a number nobody acts on
 * until they open the Sync page anyway.
 *
 * A plan that has never been published counts every live row, because that is
 * genuinely what a first publish would send.
 */
function pendingCount(planId: string, ou: string): number {
  const db = secureDb();
  const state = getSyncState(db, planId);
  const since = state?.lastPublishedAt ?? "";

  const row = prepared(
    secureDb(),
    `SELECT
       (SELECT COUNT(*) FROM positions
         WHERE ou = ? AND scenario_id = ? AND updated_at > ?) +
       (SELECT COUNT(*) FROM component_values
         WHERE ou = ? AND scenario_id = ? AND updated_at > ?) +
       (SELECT COUNT(*) FROM buyout_rows
         WHERE ou = ? AND scenario_id = ? AND updated_at > ?) +
       (SELECT COUNT(*) FROM manual_input_rows
         WHERE ou = ? AND scenario_id = ? AND updated_at > ?) AS total`
  ).get(
    ou, planId, since,
    ou, planId, since,
    ou, planId, since,
    ou, planId, since
  ) as { total?: number } | undefined;

  return Number(row?.total ?? 0);
}
