/**
 * `GET /plans/{id}/changes` — the delta download.
 * -----------------------------------------------------------
 * `since=0` IS the full pull; there is no separate bootstrap endpoint, because
 * a full pull is a delta from nothing and two code paths would mean two sets of
 * scope bugs.
 *
 * ## The two rules that make this correct
 *
 * 1. **Follow `nextCursor` until it is null, keeping `since` identical.** The
 *    server pins `toVersion` and `syncEpoch` into the cursor on the first page.
 *    That pin is what stops a commit landing mid-download from widening the
 *    range under us.
 * 2. **Record the watermark as `toVersion`, and only after the LAST page.** This
 *    is the one irrecoverable mistake available here: a watermark that covers
 *    rows we never received means no future delta will ever mention them, and
 *    they are simply gone. Every page is applied inside its own transaction and
 *    the watermark is written once, at the end, by `completePull`.
 *
 * ## Review before apply
 *
 * The default is `dryRun`, which downloads and summarises without writing. The
 * Sync page shows that summary — counts by type, and every tombstone by name —
 * and only then calls again with `apply: true`. A pull that silently overwrote a
 * delegate's unpublished afternoon would be indistinguishable from data loss.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { KairosApiError, KAIROS_ERRORS, KairosClient, query } from "./client";
import { ChangesPage, ChangeEntity, ScopeReport } from "../../shared/kairosSync/protocol";
import { FALLBACK_APPLY_ORDER } from "../../shared/kairosSync/entityMap";
import { ApplyDeps, applyEntities } from "./apply";
import { contentHash } from "./hash";
import { clearShadow, completePull, updateSyncState, writeShadow } from "./repo";

type Db = InstanceType<typeof Database>;

/** A per-type tally, for the review screen. */
export interface PullSummary {
  /** entityType → how many rows arrived. */
  byType: Record<string, number>;
  /** entityType → how many of those were tombstones. */
  deletedByType: Record<string, number>;
  total: number;
  deleted: number;
  pages: number;
  /**
   * Incoming rows that would land on a row this machine has changed and not
   * published. See `collidesWith` on {@link PullOptions}.
   */
  collides: number;
  /** Which departments those are in, so the warning can name them. */
  collidingDepartments: string[];
}

export interface PullResult {
  planId: string;
  fromVersion: number;
  toVersion: number;
  syncEpoch: number;
  structureVersion: number;
  scope: ScopeReport;
  summary: PullSummary;
  /** True when rows were written. False for a dry run. */
  applied: boolean;
  /** Types the server sent that this client build does not understand. */
  skippedTypes: string[];
  /** Set when the epoch moved and local state for this plan was discarded. */
  reset: boolean;
}

export interface PullOptions {
  planId: string;
  ou: string;
  /** Our current watermark. 0 is a full pull. */
  since: number;
  /** The server's `applyOrder` from `/sync/heads`. */
  applyOrder?: readonly string[];
  /** Page size hint. Floors at 32 KiB and caps at 1 MiB server-side. */
  maxBytes?: number;
  /** Write the rows. Omit or pass false to preview only. */
  apply?: boolean;
  /**
   * `entityType:entityId` for every row changed here and not yet published.
   *
   * Supplied so a preview can say whether the download would actually overwrite
   * anything. The case this exists for is routine and looks alarming without it:
   * an owner who has delegated Rooms edits F&B, the delegate publishes Rooms,
   * and the plan now reads as DIVERGED — "you and the server have both changed
   * things" — with a two-way review in front of it. Those two sets cannot touch,
   * because a delegate writes only inside their own departments. Intersecting
   * the ids proves it, and a download that overwrites nothing should not be
   * presented as a choice between two versions.
   *
   * Omitted on an apply: the decision has already been made by then.
   */
  collidesWith?: ReadonlySet<string>;
}

function tally(
  summary: PullSummary,
  entities: ChangeEntity[],
  collidesWith?: ReadonlySet<string>
): void {
  for (const entity of entities) {
    summary.byType[entity.entityType] = (summary.byType[entity.entityType] ?? 0) + 1;
    summary.total += 1;
    if (collidesWith?.has(`${entity.entityType}:${entity.entityId}`)) {
      summary.collides += 1;
      // Inherited rows carry their parent position's department, so a component
      // value collides in the department its position lives in — which is the
      // one the user recognises.
      if (entity.department && !summary.collidingDepartments.includes(entity.department)) {
        summary.collidingDepartments.push(entity.department);
      }
    }
    if (entity.deleted) {
      summary.deletedByType[entity.entityType] =
        (summary.deletedByType[entity.entityType] ?? 0) + 1;
      summary.deleted += 1;
    }
  }
}

/**
 * Download (and optionally apply) every page of a plan's delta.
 *
 * On `409 kairos_sync_epoch_changed` the whole local view of this plan is
 * discarded and the pull restarts from zero: an administrator held a support
 * lease, and on handback the server's copy wins outright. That is signalled
 * back as `reset: true` so the UI can say why the download was larger than the
 * user expected.
 */
export async function pullPlan(
  deps: ApplyDeps,
  db: Db,
  client: KairosClient,
  options: PullOptions
): Promise<PullResult> {
  try {
    return await runPull(deps, db, client, options, false);
  } catch (error) {
    if (error instanceof KairosApiError && error.is(KAIROS_ERRORS.SYNC_EPOCH_CHANGED)) {
      // Everything we remember about this plan is a claim about a history the
      // server no longer has. Drop it and take their copy whole.
      clearShadow(db, options.planId);
      updateSyncState(db, options.planId, { watermark: 0 });
      return runPull(deps, db, client, { ...options, since: 0 }, true);
    }
    throw error;
  }
}

async function runPull(
  deps: ApplyDeps,
  db: Db,
  client: KairosClient,
  options: PullOptions,
  reset: boolean
): Promise<PullResult> {
  const { planId, since } = options;
  const apply = options.apply === true;
  const order = options.applyOrder ?? FALLBACK_APPLY_ORDER;

  const summary: PullSummary = {
    byType: {},
    deletedByType: {},
    total: 0,
    deleted: 0,
    pages: 0,
    collides: 0,
    collidingDepartments: [],
  };
  const skippedTypes = new Set<string>();

  let cursor: string | null = null;
  let last: ChangesPage | null = null;

  do {
    const page: ChangesPage = await client.get<ChangesPage>(
      `/plans/${encodeURIComponent(planId)}/changes${query({
        // `since` must be identical on every page or the server 400s — the
        // cursor carries the range, `since` only identifies which range it is.
        since,
        cursor,
        maxBytes: options.maxBytes ?? null,
      })}`
    );

    summary.pages += 1;
    tally(summary, page.entities, options.collidesWith);

    if (apply) {
      const result = applyEntities(deps, page.entities, order);
      result.skippedTypes.forEach((type) => skippedTypes.add(type));

      // The shadow moves with the rows, page by page. This is safe to do
      // incrementally — unlike the watermark — because a shadow entry only ever
      // claims "the server had this hash at this seq", which stays true whether
      // or not the rest of the pages arrive.
      writeShadow(
        db,
        planId,
        page.entities.map((entity) => ({
          entityType: entity.entityType,
          entityId: entity.entityId,
          hash: hashOf(entity),
          serverSeq: entity.serverSeq,
          deleted: entity.deleted,
        })),
        new Date().toISOString()
      );
    }

    cursor = page.nextCursor;
    last = page;
  } while (cursor !== null);

  if (last === null) {
    throw new Error("The server returned no pages for this plan.");
  }

  if (apply) {
    // THE watermark write. Once, here, after the last page — see the module
    // docstring. Nothing else in this feature advances it.
    completePull(db, planId, last.toVersion, last.syncEpoch, new Date().toISOString());
    updateSyncState(db, planId, {
      structureVersion: last.structureVersion,
      scopeKind: last.scope.kind,
      scopeDepartments: last.scope.departments,
    });
  }

  return {
    planId,
    fromVersion: last.fromVersion,
    toVersion: last.toVersion,
    syncEpoch: last.syncEpoch,
    structureVersion: last.structureVersion,
    scope: last.scope,
    summary,
    applied: apply,
    skippedTypes: [...skippedTypes],
    reset,
  };
}

/**
 * The hash to remember for a pulled row.
 *
 * `/changes` deliberately does not send content hashes: the payload is what it
 * sends, and the hash of that payload is by definition what the server holds,
 * because it stored OUR hash of it when somebody published it. Recomputing
 * keeps one hash function in the system rather than two that must agree.
 *
 * The one case where the recomputed value differs is a row killed by
 * `op: "purge"`, which the server stores with an empty hash. Resurrecting such
 * a row will therefore come back `STALE` on the first attempt — and the
 * conflict carries `serverHash`, which is exactly what to retry with.
 */
function hashOf(entity: ChangeEntity): string {
  return entity.payload === null ? "" : contentHash(entity.payload);
}
