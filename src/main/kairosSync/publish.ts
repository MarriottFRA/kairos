/**
 * `POST /plans/{id}/commits` — publishing local work.
 * -----------------------------------------------------------
 * Collect, filter to what this caller may write, diff against the shadow,
 * chunk, and send. Every chunk carries its own `Idempotency-Key`, and the reply
 * moves the shadow forward.
 *
 * ## A partial result is a success
 *
 * The server answers 200 even when rows conflicted or were rejected, and that
 * is the correct shape rather than a leniency: two delegates on different
 * departments are permanently stale relative to each other, so `baseVersion`
 * disagreeing is the normal case, not an error. The real gate is per row, on the
 * content hash. A chunk containing one illegal PII row still lands its
 * positions — so a non-empty `rejected` must never be reported as a failed save.
 *
 * ## Idempotency
 *
 * A fresh key per chunk, the SAME key on a retry of that chunk. Keys are minted
 * once, up front, and held for the duration of the publish, so a network failure
 * mid-flight retries into a replay (`Idempotency-Replayed: true`, the stored
 * response verbatim) rather than double-writing. Reusing a key with a different
 * body is a client bug and the server says so — `409
 * kairos_idempotency_key_mismatch` — because replaying it would silently discard
 * the new writes.
 *
 * ## Bootstrap
 *
 * `?bootstrap=1` skips the stored-row lookup: one bulk insert rather than a few
 * thousand index probes. Only ever set when the plan is genuinely empty
 * server-side, which we know from the shadow being empty AND the plan's version
 * being zero — either alone is not enough, because a rebuilt local store has an
 * empty shadow for a plan the server is full of.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  KairosApiError,
  KAIROS_ERRORS,
  KairosClient,
  newIdempotencyKey,
  query,
} from "./client";
import {
  CommitEntity,
  CommitLimits,
  CommitResponse,
  CommitConflict,
  CommitRejection,
  ScopeReport,
} from "../../shared/kairosSync/protocol";
import {
  CollectDeps,
  LocalEntity,
  PLAN_WIDE_ENTITY_TYPES,
  UnpublishableReason,
  UnpublishableRow,
  WriteScope,
  chunkEntities,
  collectLocalEntities,
  filterToWriteScope,
  purgesFor,
  toCommitEntities,
} from "./collect";
import {
  advanceWatermarkAfterPublish,
  countShadow,
  getSyncState,
  loadShadowMap,
  shadowKey,
  updateSyncState,
  writeShadow,
} from "./repo";

type Db = InstanceType<typeof Database>;

/**
 * A `synced_at` that keeps a row in the pending set.
 *
 * Written for a hash we adopted from a conflict rather than one the server
 * confirmed it holds for us. Every local `updated_at` sorts after it, so the row
 * stays a candidate and the badge keeps counting it until the two sides really
 * do agree.
 */
const NEVER_AGREED = "";

export interface PublishOptions {
  planId: string;
  ou: string;
  /** The plan's server version, from `/sync/heads`. Used as `baseVersion`. */
  baseVersion: number;
  scope: WriteScope;
  limits: CommitLimits;
  /** False when the property has personal-data storage switched off. */
  includePii?: boolean;
  /** Preview only: collect and chunk, send nothing. */
  dryRun?: boolean;
}

export interface PublishResult {
  planId: string;
  committedVersion: number;
  syncEpoch: number;
  scope: ScopeReport | null;
  accepted: number;
  unchanged: number;
  /** Rows accepted under a re-grant override. MUST be surfaced to the user. */
  overrodeBase: number;
  conflicts: CommitConflict[];
  rejected: CommitRejection[];
  chunks: number;
  /** Rows outside this caller's write scope, never sent. */
  withheld: number;
  /**
   * Rows the server actually deleted for us, having been sent `op: "purge"`.
   *
   * Counted from the response, not from what was sent. A purge the server
   * refused deleted nothing, and reporting it as "1 deletion recorded" told the
   * user their publish had removed data it had not touched.
   */
  purged: number;
  /**
   * `ALREADY_EXISTS` conflicts whose server hash we have now adopted.
   *
   * These resolve themselves on the next publish; the alert says so rather than
   * repeating an instruction the user has already followed.
   */
  adopted: number;
  /** Broken rows on THIS computer that were never sent. Not server refusals. */
  localProblems: LocalProblem[];
  /** True when nothing was sent because nothing had changed. */
  noop: boolean;
  dryRun: boolean;
}

/** One kind of local damage, counted. Individual ids are of no use to a user. */
export interface LocalProblem {
  entityType: string;
  reason: UnpublishableReason;
  count: number;
}

function summariseUnpublishable(rows: UnpublishableRow[]): LocalProblem[] {
  const byKey = new Map<string, LocalProblem>();
  for (const row of rows) {
    const key = `${row.entityType}:${row.reason}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { entityType: row.entityType, reason: row.reason, count: 1 });
    }
  }
  return [...byKey.values()];
}

/** What a dry run reports, so the Sync page can say "12 positions, 1 deletion". */
export interface PublishPreview {
  byType: Record<string, number>;
  total: number;
  chunks: number;
  withheld: LocalEntity[];
  localProblems: LocalProblem[];
  /** Rows with no department: owner-only, and invisible to any delegate. */
  unclassified: LocalEntity[];
}

/**
 * Work out what would be sent, without sending it.
 *
 * Also surfaces the rows with no department code. Those are legitimate — the
 * column defaults to `''` on both `positions` and `manual_input_rows` — but they
 * land in the owner-only branch server-side and can never be delegated, so a
 * hotel wondering why Rooms cannot be handed over needs to see them.
 */
export function previewPublish(
  deps: CollectDeps,
  db: Db,
  options: PublishOptions
): PublishPreview {
  const { entities, unpublishable, scannedTypes } = collectLocalEntities(deps, {
    ou: options.ou,
    planId: options.planId,
    includePii: options.includePii,
  });
  const { publishable, withheld } = filterToWriteScope(entities, options.scope);
  const shadow = loadShadowMap(db, options.planId);
  const commits = [
    ...toCommitEntities(publishable, shadow),
    // The FULL collected set, not `publishable` — a row withheld by write scope
    // is one we hold and may not send, which is the opposite of one we deleted.
    // See the header on `purgesFor`.
    ...purgesFor(entities, shadow, {
      scannedTypes,
      unpublishable,
      canWriteStructure: options.scope.canWriteStructure,
    }),
  ];

  const byType: Record<string, number> = {};
  for (const entity of commits) {
    byType[entity.entityType] = (byType[entity.entityType] ?? 0) + 1;
  }

  return {
    byType,
    total: commits.length,
    chunks: chunkEntities(commits, options.limits).length,
    // The plan's own rows were never this caller's to send, so listing them as
    // "left behind" turned an entirely normal delegate publish into a report of
    // things going wrong. Counted in `localProblems` if they are broken; simply
    // not their business otherwise.
    withheld: withheld.filter(
      (entity) => !PLAN_WIDE_ENTITY_TYPES.has(entity.entityType)
    ),
    localProblems: summariseUnpublishable(unpublishable),
    unclassified: publishable.filter(
      (entity) =>
        entity.department === null &&
        (entity.entityType === "position" || entity.entityType === "manual_input_row")
    ),
  };
}

/**
 * Publish a plan.
 *
 * The shadow is advanced from `accepted` AND `unchanged` — `unchanged` means the
 * server already holds this exact hash, which is precisely the fact the shadow
 * is supposed to record. Conflicts and rejections leave it alone, so the next
 * publish tries again rather than believing a row landed.
 *
 * The watermark moves too, under the narrow conditions set out on
 * `advanceWatermarkAfterPublish`. Without that, publishing left the plan
 * reading as "changes waiting for you to download" — the changes being the ones
 * that had just gone up from this machine.
 */
export async function publishPlan(
  deps: CollectDeps,
  db: Db,
  client: KairosClient,
  options: PublishOptions
): Promise<PublishResult> {
  const { planId, ou } = options;
  // Captured before the chunk loop reassigns `options` to chain baseVersions.
  const startBaseVersion = options.baseVersion;
  const watermarkBefore = getSyncState(db, planId)?.watermark ?? 0;

  const { entities, unpublishable, scannedTypes } = collectLocalEntities(deps, {
    ou,
    planId,
    includePii: options.includePii,
  });
  const { publishable, withheld } = filterToWriteScope(entities, options.scope);
  const shadow = loadShadowMap(db, planId);

  const updates = toCommitEntities(publishable, shadow);
  // The FULL collected set — see the header on `purgesFor`.
  const purges = purgesFor(entities, shadow, {
    scannedTypes,
    unpublishable,
    canWriteStructure: options.scope.canWriteStructure,
  });
  const commits = [...updates, ...purges];

  const result: PublishResult = {
    planId,
    committedVersion: options.baseVersion,
    syncEpoch: 0,
    scope: null,
    accepted: 0,
    unchanged: 0,
    overrodeBase: 0,
    conflicts: [],
    rejected: [],
    chunks: 0,
    // Plan-wide rows excluded: see the same filter in `previewPublish`.
    withheld: withheld.filter(
      (entity) => !PLAN_WIDE_ENTITY_TYPES.has(entity.entityType)
    ).length,
    purged: 0,
    adopted: 0,
    localProblems: summariseUnpublishable(unpublishable),
    noop: commits.length === 0,
    dryRun: options.dryRun === true,
  };

  if (commits.length === 0 || options.dryRun) {
    result.chunks = chunkEntities(commits, options.limits).length;
    return result;
  }

  // Empty shadow AND a server version of zero. Either alone is a trap: a rebuilt
  // local store has an empty shadow for a plan the server is full of, and
  // bootstrapping into it would insert duplicates of rows already there.
  const bootstrap = countShadow(db, planId) === 0 && options.baseVersion === 0;

  const chunks = chunkEntities(commits, options.limits);
  result.chunks = chunks.length;

  // Minted up front so a retry of chunk N reuses chunk N's key. A key generated
  // inside the send loop would be a new key on every attempt, which turns a
  // timeout-then-success into a double write.
  const keys = chunks.map(() => newIdempotencyKey());

  for (let index = 0; index < chunks.length; index += 1) {
    const response = await sendChunk(client, planId, {
      entities: chunks[index],
      baseVersion: options.baseVersion,
      idempotencyKey: keys[index],
      // Only the first chunk can legitimately claim the plan is empty; by the
      // second, this publish has already put rows in it.
      bootstrap: bootstrap && index === 0,
    });

    const now = new Date().toISOString();
    // Keyed through shadowKey so the publish path and the shadow can never
    // disagree about what identifies a row. Built before the tallies, because
    // "was this accepted row a deletion?" is a question only the sent entity
    // can answer.
    const byKey = new Map(
      chunks[index].map((entity) => [
        shadowKey(entity.entityType, entity.entityId),
        entity,
      ])
    );

    result.committedVersion = response.committedVersion;
    result.syncEpoch = response.syncEpoch;
    result.scope = response.scope;
    result.accepted += response.accepted.length;
    result.unchanged += response.unchanged.length;
    result.overrodeBase += response.accepted.filter((row) => row.overrodeBase).length;
    result.purged += response.accepted.filter(
      (row) => byKey.get(shadowKey(row.entityType, row.entityId))?.op === "purge"
    ).length;
    result.conflicts.push(...response.conflicts);
    result.rejected.push(...response.rejected);

    /**
     * `ALREADY_EXISTS` is the one conflict that never clears itself.
     *
     * It means we sent a row as new — `baseHash: null`, because the shadow had
     * no entry — and the server already had it. Leaving the shadow alone leaves
     * it with no entry, so the next publish sends the same row as new again and
     * gets the same answer, for ever. Downloading does not help either: it is
     * how `position_pii` behaves by construction, because PII is never served by
     * `/changes` and so a pull cannot teach the shadow about it.
     *
     * §5 of the API guide says what to do — adopt the server's hash and send it
     * as an ordinary update — and the conflict carries exactly that. One
     * deliberate exception to "conflicts leave the shadow alone", and it is the
     * difference between a warning that means something and one the user has no
     * way to clear.
     */
    const adopted = response.conflicts.filter(
      (row) => row.reason === "ALREADY_EXISTS" && row.serverHash !== null
    );
    result.adopted += adopted.length;
    writeShadow(
      db,
      planId,
      adopted.map((row) => ({
        entityType: row.entityType,
        entityId: row.entityId,
        hash: row.serverHash as string,
        serverSeq: row.serverSeq ?? 0,
        deleted: false,
      })),
      // NOT `now`. `synced_at` is what the Publish badge's candidate query
      // compares `updated_at` against, and a current timestamp would drop these
      // rows out of the count while the two sides still disagree about their
      // contents — the row would be silently pending. They are adopted, not
      // agreed.
      NEVER_AGREED
    );

    writeShadow(
      db,
      planId,
      [
        ...response.accepted.map((row) => ({
          entityType: row.entityType,
          entityId: row.entityId,
          hash: row.hash ?? "",
          serverSeq: row.serverSeq,
          deleted:
            byKey.get(shadowKey(row.entityType, row.entityId))?.deleted === true ||
            byKey.get(shadowKey(row.entityType, row.entityId))?.op === "purge",
        })),
        ...response.unchanged.map((row) => {
          const sent = byKey.get(shadowKey(row.entityType, row.entityId));
          return {
            entityType: row.entityType,
            entityId: row.entityId,
            hash: sent?.hash ?? "",
            // `unchanged` carries no seq — the server did not write, so the row's
            // seq is whatever it already was. Keeping the remembered one avoids
            // inventing a number that the reconcile tri-state would then compare
            // against a watermark.
            serverSeq:
              shadow.get(shadowKey(row.entityType, row.entityId))?.serverSeq ?? 0,
            deleted: sent?.deleted === true,
          };
        }),
      ],
      now
    );

    // Later chunks publish against the version this one produced. Sending the
    // original base for all of them would make every chunk after the first look
    // stale to a server that has just moved the plan on our behalf.
    options = { ...options, baseVersion: response.committedVersion };
  }

  updateSyncState(db, planId, { lastPublishedAt: new Date().toISOString() });

  // Everything between the base we committed against and the version we
  // produced is our own work, and we already hold it. Anything else in that gap
  // — somebody else's commit, a row we overrode, a row that conflicted — and the
  // watermark stays where it is, because then the plan really has moved beyond
  // what this machine has seen.
  const soleAuthor =
    watermarkBefore === startBaseVersion &&
    result.conflicts.length === 0 &&
    result.overrodeBase === 0;
  if (soleAuthor && result.committedVersion > watermarkBefore) {
    advanceWatermarkAfterPublish(db, planId, result.committedVersion);
  }

  return result;
}

async function sendChunk(
  client: KairosClient,
  planId: string,
  chunk: {
    entities: CommitEntity[];
    baseVersion: number;
    idempotencyKey: string;
    bootstrap: boolean;
  }
): Promise<CommitResponse> {
  const path = `/plans/${encodeURIComponent(planId)}/commits${query({
    bootstrap: chunk.bootstrap ? 1 : null,
  })}`;

  try {
    return await client.post<CommitResponse>(
      path,
      { baseVersion: chunk.baseVersion, entities: chunk.entities },
      { idempotencyKey: chunk.idempotencyKey }
    );
  } catch (error) {
    if (error instanceof KairosApiError && error.is(KAIROS_ERRORS.IDEMPOTENCY_EXPIRED)) {
      // Past the seven-day replay window. The body is unchanged and still
      // correct; it just needs a key the server has never seen.
      return client.post<CommitResponse>(
        path,
        { baseVersion: chunk.baseVersion, entities: chunk.entities },
        { idempotencyKey: newIdempotencyKey() }
      );
    }
    throw error;
  }
}
