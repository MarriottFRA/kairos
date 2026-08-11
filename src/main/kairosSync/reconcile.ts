/**
 * `POST /plans/{id}/manifest/diff` — self-healing.
 * -----------------------------------------------------------
 * The shadow is a fast path, never the source of truth. Too many things write
 * to the local stores without going through the sync layer: cluster
 * propagation, the legacy Excel importer, the Oracle importer, the 30-day
 * tombstone cleanup, scenario cloning, and Settings → Rebuild database (which
 * drops the shadow outright along with every other secure table). After any of
 * those, "what have I published?" and "what does the server hold?" can disagree
 * in either direction.
 *
 * Reconciliation compares hashes both ways and returns work, rather than doing
 * it: the Sync page shows what it found and the user decides, for the same
 * reason a pull is review-then-apply.
 *
 * ## The `serverOnly` tri-state
 *
 * This is the part worth reading twice. The server sends
 * `[type, id, hash, serverSeq, deleted]` for rows it holds that our manifest did
 * not mention, and the last two elements are what make it usable:
 *
 * | `deleted` | `serverSeq` vs watermark | Meaning | Action |
 * |---|---|---|---|
 * | 1 | any | a tombstone we already applied | record it; do NOT re-pull |
 * | 0 | `> watermark` | genuinely new to us | pull it |
 * | 0 | `<= watermark` | we saw it and purged it locally | send `op: "purge"` |
 *
 * Without `deleted`, every reconcile re-downloads every tombstone forever.
 * Without `serverSeq`, "I already deleted this" is indistinguishable from "I
 * have never seen this", and a purge would resurrect-then-kill rows on a loop.
 *
 * ## The third reading of an absent row
 *
 * That table has one unstated premise: that our manifest is missing a row
 * because we DELETED it. There is a second reason it can be missing — we were
 * never allowed to download it. A delegate holds a slice of the plan, so every
 * row in every other department is `serverOnly` with a `serverSeq` far below
 * their watermark, and the bottom row of the table reads all of them as
 * deletions.
 *
 * That never mattered while scope only narrowed. It does now: a delegate can
 * become the plan's OWNER, and their next reconcile would report every row in
 * the twenty-nine departments they never held as a pending purge — while
 * `suggestFullPull` stayed false, because `toPull` is zero, so the one remedy
 * that fixes it was the one thing not offered. `scopeWidened` is how the caller
 * says the premise does not hold, and the whole bottom row flips to `pull`.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { KairosClient } from "./client";
import {
  ManifestDiffResponse,
  ServerOnlyRow,
  CommitEntity,
} from "../../shared/kairosSync/protocol";
import { buildManifest, getSyncState, writeShadow } from "./repo";

type Db = InstanceType<typeof Database>;

/** One row the server has and we do not, with what to do about it. */
export interface ServerOnlyAction {
  entityType: string;
  entityId: string;
  hash: string;
  serverSeq: number;
  action: "record-tombstone" | "pull" | "purge";
}

export interface ReconcileResult {
  planId: string;
  version: number;
  syncEpoch: number;
  /** Rows where our hash and the server's already agree. */
  matched: number;
  /** Rows we hold that the server does not have at our hash — republish these. */
  needed: Array<{ entityType: string; entityId: string; serverHash: string | null }>;
  serverOnly: ServerOnlyAction[];
  /** The server capped `serverOnly`; run again after acting on this batch. */
  truncated: boolean;
  /** Ready-to-send purges, derived from the tri-state. */
  purges: CommitEntity[];
  /** True if a full `?since=0` re-pull is the cheaper fix. */
  suggestFullPull: boolean;
}

/**
 * Rows above this proportion of the manifest being server-only means the local
 * copy is not stale, it is absent — a rebuilt store, or a plan pulled on a
 * device that has never had it. A full `since=0` pull is one request rather
 * than thousands of individual decisions.
 */
const FULL_PULL_RATIO = 0.5;

/**
 * @param scopeWidened The caller may now read more of this plan than the
 * manifest was built from, so an absent row is not evidence of a deletion. See
 * the module docstring, and `readScopeWidened` for how it is decided.
 */
export async function reconcilePlan(
  db: Db,
  client: KairosClient,
  planId: string,
  scopeWidened = false
): Promise<ReconcileResult> {
  const manifest = buildManifest(db, planId);
  const watermark = getSyncState(db, planId)?.watermark ?? 0;

  const response = await client.post<ManifestDiffResponse>(
    `/plans/${encodeURIComponent(planId)}/manifest/diff`,
    { entities: manifest }
  );

  const serverOnly = response.serverOnly.map((row) =>
    classify(row, watermark, scopeWidened)
  );
  const purges = serverOnly
    .filter((row) => row.action === "purge")
    .map<CommitEntity>((row) => ({
      entityType: row.entityType,
      entityId: row.entityId,
      op: "purge",
      baseHash: row.hash,
      hash: null,
      deleted: true,
      clientUpdatedAt: null,
    }));

  // Tombstones the server holds and we have already applied: write them into the
  // shadow so the NEXT reconcile does not report them again. This is the whole
  // point of the `deleted` element — without it, a plan with 200 deleted rows
  // reports 200 differences on every single sync, forever.
  const tombstones = serverOnly.filter((row) => row.action === "record-tombstone");
  if (tombstones.length > 0) {
    writeShadow(
      db,
      planId,
      tombstones.map((row) => ({
        entityType: row.entityType,
        entityId: row.entityId,
        hash: row.hash,
        serverSeq: row.serverSeq,
        deleted: true,
      })),
      new Date().toISOString()
    );
  }

  const toPull = serverOnly.filter((row) => row.action === "pull").length;
  const denominator = Math.max(1, manifest.length + toPull);

  return {
    planId,
    version: response.version,
    syncEpoch: response.syncEpoch,
    matched: response.matched,
    needed: response.needed.map(([entityType, entityId, serverHash]) => ({
      entityType: String(entityType),
      entityId: String(entityId),
      serverHash: serverHash === null ? null : String(serverHash),
    })),
    serverOnly,
    truncated: response.truncated,
    purges,
    // A widened scope is a full pull by definition — the rows we have just been
    // given sight of are older than our watermark to a row, so the ratio below
    // can only ever measure them at zero and conclude there is nothing to do.
    suggestFullPull: scopeWidened || toPull / denominator > FULL_PULL_RATIO,
  };
}

/** The tri-state from §3.4, as one function so the table has exactly one home. */
function classify(
  row: ServerOnlyRow,
  watermark: number,
  scopeWidened: boolean
): ServerOnlyAction {
  const [entityType, entityId, hash, serverSeq, deleted] = row;
  const seq = Number(serverSeq ?? 0);
  return {
    entityType: String(entityType),
    entityId: String(entityId),
    hash: String(hash ?? ""),
    serverSeq: seq,
    action:
      deleted === 1
        ? "record-tombstone"
        : // Below the watermark normally means "we saw it and deleted it". Under
          // a widened scope it means "we were not allowed to see it", and the
          // difference between those two readings is a purge of somebody else's
          // department against a download of it.
          seq > watermark || scopeWidened
          ? "pull"
          : "purge",
  };
}

/**
 * Rebuild the shadow from the server's own manifest.
 *
 * The recovery path after Settings → Rebuild database, which drops every secure
 * table including the shadow. Without this, the next publish sends every row
 * with `baseHash: null` and gets a wall of `ALREADY_EXISTS` conflicts; with it,
 * the client learns what the server holds in one request and carries on.
 */
export async function rebuildShadowFromServer(
  db: Db,
  client: KairosClient,
  planId: string
): Promise<number> {
  const response = await client.get<ManifestDiffResponse>(
    `/plans/${encodeURIComponent(planId)}/manifest`
  );

  writeShadow(
    db,
    planId,
    response.serverOnly.map(([entityType, entityId, hash, serverSeq, deleted]) => ({
      entityType: String(entityType),
      entityId: String(entityId),
      hash: String(hash ?? ""),
      serverSeq: Number(serverSeq ?? 0),
      deleted: deleted === 1,
    })),
    new Date().toISOString()
  );

  return response.serverOnly.length;
}
