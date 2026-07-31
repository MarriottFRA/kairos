/**
 * `GET /sync/heads` — the probe, and the only thing that should ever be polled.
 * -----------------------------------------------------------
 * One conditional request covers plans, structure, BST, clusters, mapping
 * tables and the caller's authorisation version. It exists so the client never
 * asks five endpoints a question whose answer is almost always "no".
 *
 * A steady-state sync is therefore two requests, one of which is a 304.
 *
 * Nothing else in this feature polls. `/changes` is triggered by a plan version
 * moving here; `/plans` is a user action. That is the whole cadence, and it is
 * what keeps a few thousand desktops off the server's back.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { KairosClient, query } from "./client";
import { SyncHeads, PlanHead, CommitLimits } from "../../shared/kairosSync/protocol";
import { ensureSyncState, getSyncState, updateSyncState } from "./repo";

type Db = InstanceType<typeof Database>;

/**
 * Fallback ceilings, used only before the first successful `heads` call.
 *
 * Deliberately conservative: too small wastes a round trip, too large is a 413.
 * The real values ride on every `heads` and every commit response, so these are
 * live for one request at most.
 */
export const FALLBACK_LIMITS: CommitLimits = {
  commitMaxBytes: 1024 * 1024,
  commitMaxEntities: 5000,
  changesMaxBytes: 256 * 1024,
  manifestMaxEntities: 10000,
};

export interface HeadsResult {
  /** null when the server answered 304 — nothing at this property has moved. */
  heads: SyncHeads | null;
  etag: string | null;
  /** Plans whose `version` is ahead of our watermark, or whose epoch moved. */
  stalePlans: PlanHead[];
  /** True when a support lease handback forces a full re-pull somewhere. */
  epochMoved: boolean;
}

/**
 * Probe the property, and work out what actually needs pulling.
 *
 * The ETag is stored per-OU rather than per-plan, on the state row of any plan
 * at that property — `heads` is one answer about the whole hotel. It is kept on
 * every row so a plan that is later removed does not orphan the ETag.
 *
 * Note the server folds the caller's authorisation digest into the ETag, so a
 * changed grant invalidates it even when no data moved. A 200 where a 304 was
 * expected means "your scope changed", not "something is wrong".
 */
export async function fetchHeads(
  db: Db,
  client: KairosClient,
  ou: string
): Promise<HeadsResult> {
  const etag = readOuEtag(db, ou);
  const response = await client.getConditional<SyncHeads>(
    `/sync/heads${query({ ou })}`,
    etag
  );

  if (response.status === 304) {
    return { heads: null, etag: response.etag, stalePlans: [], epochMoved: false };
  }

  const heads = response.body;
  const stalePlans: PlanHead[] = [];
  let epochMoved = false;

  for (const plan of heads.plans) {
    ensureSyncState(db, plan.id, ou);
    const state = getSyncState(db, plan.id);
    const known = state?.watermark ?? 0;
    const knownEpoch = state?.syncEpoch ?? plan.syncEpoch;

    if (plan.syncEpoch !== knownEpoch) epochMoved = true;
    if (plan.version > known || plan.syncEpoch !== knownEpoch) stalePlans.push(plan);

    // Cache the authorization answer so the UI can render before the first
    // round trip. Advisory only — a 403 always wins over anything stored here.
    updateSyncState(db, plan.id, {
      relation: plan.relation,
      scopeKind: plan.scopeKind,
      scopeDepartments: plan.departments,
      headsEtag: response.etag,
    });
  }

  return { heads, etag: response.etag, stalePlans, epochMoved };
}

/**
 * The stored `heads` ETag for a property.
 *
 * Every plan row at the OU holds the same value, so any one of them answers.
 * Taking the first means a property with no plans yet simply has no ETag, which
 * is correct — there is nothing to revalidate against.
 */
function readOuEtag(db: Db, ou: string): string | null {
  const row = db
    .prepare(
      `SELECT heads_etag FROM kairos_sync_state
        WHERE ou = ? AND heads_etag IS NOT NULL LIMIT 1`
    )
    .get(ou) as { heads_etag?: string } | undefined;
  return row?.heads_etag ?? null;
}

/** The limits to chunk against: the server's if we have them, else the fallback. */
export function limitsFrom(heads: SyncHeads | null): CommitLimits {
  return heads?.limits ?? FALLBACK_LIMITS;
}
