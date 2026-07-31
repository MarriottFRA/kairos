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

import { IpcHandler, IpcResult } from "../types";
import { localDbHandle } from "../../local_db";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import { prepared } from "../../main/positions/stmtCache";
import type { ApiClient } from "../../main/auth/apiClient";
import { KairosApiError, KairosClient } from "../../main/kairosSync/client";
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
  DelegationCreate,
  KpiSeriesRequest,
  PlanHead,
  Relation,
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

/** Run a handler body, turning any failure into `{ok: false, error}`. */
async function attempt<T>(run: () => Promise<T> | T): Promise<SyncOutcome<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: toSyncError(error) };
  }
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
            notModified: result.heads === null,
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
          // list — so the page is built from what we have stored, and the probe
          // only ever refreshes it.
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
              published: head !== undefined,
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
            upToDate: heads === null,
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
    ) => envelope(await attempt(() => runPull(request, false))),

    [KAIROS_SYNC_CHANNELS.pull]: async (
      _event,
      request: { ou: string; planId: string }
    ) => envelope(await attempt(() => runPull(request, true))),

    // ------------------------------------------------------------ publish

    [KAIROS_SYNC_CHANNELS.previewPublish]: async (
      _event,
      request: { ou: string; planId: string }
    ) => {
      return envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const probe = await fetchHeads(secureDb(), client, scope.ou);
          const preview = previewPublish(stores(), secureDb(), {
            planId: request.planId,
            ou: scope.ou,
            baseVersion: 0,
            scope: writeScopeFor(request.planId),
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
        })
      );
    },

    [KAIROS_SYNC_CHANNELS.publish]: async (
      _event,
      request: { ou: string; planId: string }
    ) => {
      return envelope(
        await attempt(async () => {
          const scope = resolveOuScope(request.ou);
          const db = secureDb();
          const probe = await fetchHeads(db, client, scope.ou);
          const head = probe.heads?.plans.find((plan) => plan.id === request.planId);

          const result = await publishPlan(stores(), db, client, {
            planId: request.planId,
            ou: scope.ou,
            baseVersion: head?.version ?? 0,
            scope: writeScopeFor(request.planId),
            limits: limitsFrom(probe.heads),
            includePii: await piiAllowed(scope.ou),
          });

          // Tell the server the local work is published, so an owner about to
          // revoke is not warned about work that no longer exists.
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
        })
      );
    },

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
        })
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
  };

  // ------------------------------------------------------------- helpers

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
