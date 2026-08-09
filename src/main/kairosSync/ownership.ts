/**
 * `GET /plans/{id}/department-ownership` — the authority answer, cached.
 * -----------------------------------------------------------
 * `writable` here IS the server's write predicate, so the grid can never
 * disagree with what a save will actually do. Four consumers read the body this
 * module stores: `usePlanScope`, the Delegation page, the Sync page's overview,
 * and — the silent one — `writeScopeFor`, which decides what a publish sends.
 *
 * Lifted out of the IPC handler because it had grown two copies of the same
 * cache-write block (the channel, and `refreshOwnership` before a publish) and
 * they had drifted into the same defect: both branched on the BODY being truthy
 * rather than on the status, so a 200 carrying an empty body degraded silently
 * to the stale cache AND kept an ETag for a document this computer had never
 * received. One cache, one writer, one place to read.
 *
 * Same shape as `fetchHeads`, and for the same reason: ETag and body are stored
 * together, and a 304 replays the body rather than answering null. A caller
 * handed null on a 304 reads it as "nothing is writable", which is the opposite
 * of what the server said.
 *
 * ## The correction path, and why it has to be here
 *
 * A handback happens on the DELEGATE's machine. The owner has no local event to
 * hang an invalidation on, so the server's ETag is their only route back to a
 * department that has been returned to them — and if it does not fold delegation
 * state, they are answered 304 for ever and stay locked out of a department
 * nobody holds, with nothing to press. So when a replayed body contradicts
 * itself (see `ownershipContradiction`), this module spends one unconditional
 * request to settle it.
 *
 * The renderer cannot do this. The cache and the ETag live here, so a renderer
 * that decided the answer was wrong would still have to ask main to bypass
 * `If-None-Match` — and a renderer-side fix would repair the grid while leaving
 * the publish filter reading the same stale body.
 *
 * ## This module never invents write access
 *
 * Nothing here may flip a `writable: false` to true, however obviously wrong the
 * answer looks. `filterToWriteScope` uses the same field at publish, so a
 * locally-unlocked cell produces edits that are withheld without a rejection —
 * data the user believes is saved and is not, which is a worse failure than the
 * lock it was meant to fix. The only correction available is to ASK AGAIN,
 * unconditionally, and believe the second answer.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { KairosClient } from "./client";
import { DepartmentOwnership } from "../../shared/kairosSync/protocol";
import { ownershipContradicted } from "../../shared/kairosSync/ownershipContradiction";
import { getSyncState, updateSyncState } from "./repo";

type Db = InstanceType<typeof Database>;

export interface OwnershipResult {
  /**
   * The current answer — from the network on a 200, from the store on a 304.
   * Null only when we have genuinely never had a 200 for this plan.
   */
  ownership: DepartmentOwnership | null;
  /** True when the server answered 304 and this is the replayed body. */
  notModified: boolean;
  etag: string | null;
  /** The cached answer contradicted itself and we re-asked without the ETag. */
  revalidated: boolean;
  /**
   * A FRESH answer that still contradicts the guide.
   *
   * The distinction the whole module exists to draw: this is the server's own
   * answer, asked without a cache in the way, so no amount of client work will
   * change it and the user should be told so rather than left guessing.
   */
  serverContradicts: boolean;
}

/**
 * Plans whose contradictory answer we have already challenged, and the ETag we
 * challenged it under.
 *
 * A process-lifetime memo is the right lifetime. It stops a self-contradictory
 * answer costing two requests on every window focus for ever, and a restart
 * re-costs exactly one — which is the correct price to pay for a server-side fix
 * possibly having shipped in the meantime.
 *
 * Rejected: an `ownership_challenged_etag` column. `kairos_sync_state` has no
 * migration path today, and persisting it would suppress the retry across the
 * restart that most deserves it.
 */
const challenged = new Map<string, string>();

/** Only for tests, which need a fresh process's behaviour more than once. */
export function resetOwnershipChallenges(): void {
  challenged.clear();
}

export async function fetchOwnership(
  db: Db,
  client: KairosClient,
  planId: string,
  options: { unconditional?: boolean } = {}
): Promise<OwnershipResult> {
  const state = getSyncState(db, planId);
  const etag = options.unconditional ? null : state?.ownershipEtag ?? null;
  const response = await client.getConditional<DepartmentOwnership>(
    `/plans/${encodeURIComponent(planId)}/department-ownership`,
    etag
  );

  if (response.status === 304) {
    const replayed = readCachedOwnership(state?.ownershipJson ?? null);

    // Bounded by construction: only on a 304, only when the body we are about to
    // replay cannot justify its own lock, and once per (plan, ETag) per process.
    // If the fresh answer says the same thing, it is the server's answer and we
    // stop asking — the `challenged` entry set below is what stops the loop.
    if (
      !options.unconditional &&
      ownershipContradicted(replayed) &&
      challenged.get(planId) !== (state?.ownershipEtag ?? "")
    ) {
      challenged.set(planId, state?.ownershipEtag ?? "");
      const fresh = await fetchOwnership(db, client, planId, { unconditional: true });
      return { ...fresh, revalidated: true };
    }

    return {
      ownership: replayed,
      notModified: true,
      etag: state?.ownershipEtag ?? response.etag,
      revalidated: false,
      serverContradicts: false,
    };
  }

  if (!response.body) {
    // A 200 that carried nothing. NOT a 304 — the server intended to send a
    // document and did not — so the cached body is not "still correct", and the
    // new ETag would validate a document this computer does not hold. An ETag
    // without its body is worse than no ETag, because the next request is
    // answered 304 to a client with nothing to serve. Drop the ETag, keep the
    // body, and let the next call go out unconditionally.
    updateSyncState(db, planId, { ownershipEtag: null });
    return {
      ownership: readCachedOwnership(state?.ownershipJson ?? null),
      notModified: false,
      etag: null,
      revalidated: false,
      serverContradicts: false,
    };
  }

  const ownership = response.body;
  updateSyncState(db, planId, {
    ownershipEtag: response.etag,
    ownershipJson: JSON.stringify(ownership),
    structureEditable: ownership.structureEditableByMe,
    relation: ownership.me.relation,
    scopeKind: ownership.me.scopeKind,
    // The write scope the grid locks against, and the same set the publish
    // filter uses — one answer, stored once.
    scopeDepartments: ownership.departments
      .filter((row) => row.writable)
      .map((row) => row.code),
  });

  const serverContradicts = ownershipContradicted(ownership);
  // Remember the ETag a contradictory answer arrived under, so the 304s that
  // follow it do not each buy a second request to hear the same thing. A clean
  // answer clears the memo: the next contradiction is a new event.
  if (serverContradicts) challenged.set(planId, response.etag ?? "");
  else challenged.delete(planId);

  return {
    ownership,
    notModified: false,
    etag: response.etag,
    revalidated: false,
    serverContradicts,
  };
}

/**
 * Forget the cached authority answer after a call that changed it.
 *
 * `transferPlan`, `acquireLease` and `releaseLease` have always done this; the
 * six delegation mutations did not, and they are the ones that change this
 * answer most often. The visible cost was a toast reading "Delegation withdrawn.
 * You can edit those departments again." over a grid still locked from the
 * cache — correct only if the server's ETag folds delegation state, which is not
 * something this client can verify.
 *
 * ETag AND body together. Nulling only the ETag leaves a body nothing
 * validates; nulling only the body 304s into an empty cache. `relation` and
 * `scopeKind` are deliberately left alone — a grant does not change who you are,
 * and `writeScopeFor` already degrades a missing ownership body to the head's
 * scope, which errs wide and is resolved server-side per row.
 */
export function invalidateOwnership(db: Db, planId: string): void {
  updateSyncState(db, planId, { ownershipEtag: null, ownershipJson: null });
  challenged.delete(planId);
}

/**
 * A stored body is a cache, so a corrupt one is a cache miss and not a crash.
 * Returning null degrades to "we have never had a 200", which every caller
 * already handles.
 */
function readCachedOwnership(json: string | null): DepartmentOwnership | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as DepartmentOwnership;
  } catch {
    return null;
  }
}
