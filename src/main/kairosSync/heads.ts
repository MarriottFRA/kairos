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
import { ensureSyncState, getOuState, getSyncState, putOuHeads, updateSyncState } from "./repo";

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
  /**
   * The current heads for the property — from the network on a 200, from the
   * store on a 304. Null only when we have genuinely never had a 200 here.
   *
   * It is deliberately NOT null on a 304. A 304 means "what you already hold is
   * still correct", and a caller handed null instead reads it as "this property
   * has no plans", which is the opposite answer.
   */
  heads: SyncHeads | null;
  /** True when the server answered 304 — nothing at this property has moved. */
  notModified: boolean;
  etag: string | null;
  /** Plans whose `version` is ahead of our watermark, or whose epoch moved. */
  stalePlans: PlanHead[];
  /** True when a support lease handback forces a full re-pull somewhere. */
  epochMoved: boolean;
}

/**
 * Probe the property, and work out what actually needs pulling.
 *
 * ETag and body are both stored, per-OU, because `heads` is one answer about a
 * whole hotel. Storing only the ETag is the bug this shape exists to prevent:
 * every sync after the first answers 304, and a client with no body then
 * believes nothing is published — offering to register plans that already
 * exist and publishing them at `baseVersion: 0`.
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
  const cached = getOuState(db, ou);
  const response = await client.getConditional<SyncHeads>(
    `/sync/heads${query({ ou })}`,
    cached?.headsEtag ?? null
  );

  if (response.status === 304) {
    return {
      heads: readCachedHeads(cached?.headsJson ?? null),
      notModified: true,
      etag: cached?.headsEtag ?? response.etag,
      stalePlans: [],
      epochMoved: false,
    };
  }

  const heads = response.body;
  const stalePlans: PlanHead[] = [];
  let epochMoved = false;

  putOuHeads(db, ou, response.etag, JSON.stringify(heads), new Date().toISOString());

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
    });
  }

  return { heads, notModified: false, etag: response.etag, stalePlans, epochMoved };
}

/**
 * A stored body is a cache, so a corrupt one is a cache miss and not a crash.
 * Returning null here degrades to "we have never had a 200", which every caller
 * already handles.
 */
function readCachedHeads(json: string | null): SyncHeads | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as SyncHeads;
  } catch {
    return null;
  }
}

/** The limits to chunk against: the server's if we have them, else the fallback. */
export function limitsFrom(heads: SyncHeads | null): CommitLimits {
  return heads?.limits ?? FALLBACK_LIMITS;
}
