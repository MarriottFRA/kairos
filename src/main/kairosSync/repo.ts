/**
 * Sync bookkeeping: the shadow and the per-plan state.
 * -----------------------------------------------------------
 * Thin SQL over the two tables in `schema.ts`. Nothing here decides anything —
 * the policy lives in `pull.ts`, `publish.ts` and `reconcile.ts` — so these
 * functions take a database handle rather than reaching for one, and the tests
 * drive them against an in-memory store.
 *
 * The one rule worth stating in code as well as in the docstring: the watermark
 * is only ever advanced by `completePull`, never by a per-page write. A
 * watermark recorded mid-pagination covers rows that were never received, and
 * because `/changes` is a delta, no future request will ever mention them again.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { prepared } from "../positions/stmtCache";

type Db = InstanceType<typeof Database>;

/** One row of what the server last confirmed it holds. */
export interface ShadowRow {
  entityType: string;
  entityId: string;
  hash: string;
  serverSeq: number;
  deleted: boolean;
}

/** Everything we remember about one plan's relationship with the server. */
export interface SyncState {
  planId: string;
  ou: string;
  watermark: number;
  syncEpoch: number;
  piiWatermark: number;
  structureVersion: number;
  relation: string | null;
  scopeKind: string | null;
  scopeDepartments: string[] | null;
  structureEditable: boolean;
  ownershipEtag: string | null;
  ownershipJson: string | null;
  lastPublishedAt: string | null;
  lastPulledAt: string | null;
  revokedJson: string | null;
}

// ------------------------------------------------------------------- state

export function getSyncState(db: Db, planId: string): SyncState | null {
  const row = prepared(db, `SELECT * FROM kairos_sync_state WHERE plan_id = ?`).get(
    planId
  ) as Record<string, unknown> | undefined;
  return row ? toState(row) : null;
}

export function listSyncStates(db: Db, ou: string): SyncState[] {
  const rows = prepared(
    db,
    `SELECT * FROM kairos_sync_state WHERE ou = ? ORDER BY plan_id`
  ).all(ou) as Array<Record<string, unknown>>;
  return rows.map(toState);
}

function toState(row: Record<string, unknown>): SyncState {
  return {
    planId: String(row.plan_id),
    ou: String(row.ou),
    watermark: Number(row.watermark ?? 0),
    syncEpoch: Number(row.sync_epoch ?? 0),
    piiWatermark: Number(row.pii_watermark ?? 0),
    structureVersion: Number(row.structure_version ?? 0),
    relation: (row.relation as string) ?? null,
    scopeKind: (row.scope_kind as string) ?? null,
    scopeDepartments: parseList(row.scope_departments),
    structureEditable: row.structure_editable === 1,
    ownershipEtag: (row.ownership_etag as string) ?? null,
    ownershipJson: (row.ownership_json as string) ?? null,
    lastPublishedAt: (row.last_published_at as string) ?? null,
    lastPulledAt: (row.last_pulled_at as string) ?? null,
    revokedJson: (row.revoked_json as string) ?? null,
  };
}

function parseList(value: unknown): string[] | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/** Create the state row if this is the first time we have seen the plan. */
export function ensureSyncState(db: Db, planId: string, ou: string): void {
  prepared(
    db,
    `INSERT INTO kairos_sync_state (plan_id, ou) VALUES (?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET ou = excluded.ou`
  ).run(planId, ou);
}

/**
 * Patch the state row. Only the named columns move — a partial update must not
 * silently reset a watermark it was not asked about.
 */
export function updateSyncState(
  db: Db,
  planId: string,
  patch: Partial<{
    watermark: number;
    syncEpoch: number;
    piiWatermark: number;
    structureVersion: number;
    relation: string | null;
    scopeKind: string | null;
    scopeDepartments: string[] | null;
    structureEditable: boolean;
    ownershipEtag: string | null;
    ownershipJson: string | null;
    lastPublishedAt: string | null;
    lastPulledAt: string | null;
    revokedJson: string | null;
  }>
): void {
  const columns: Record<string, unknown> = {};
  if (patch.watermark !== undefined) columns.watermark = patch.watermark;
  if (patch.syncEpoch !== undefined) columns.sync_epoch = patch.syncEpoch;
  if (patch.piiWatermark !== undefined) columns.pii_watermark = patch.piiWatermark;
  if (patch.structureVersion !== undefined) {
    columns.structure_version = patch.structureVersion;
  }
  if (patch.relation !== undefined) columns.relation = patch.relation;
  if (patch.scopeKind !== undefined) columns.scope_kind = patch.scopeKind;
  if (patch.scopeDepartments !== undefined) {
    columns.scope_departments =
      patch.scopeDepartments === null ? null : JSON.stringify(patch.scopeDepartments);
  }
  if (patch.structureEditable !== undefined) {
    columns.structure_editable = patch.structureEditable ? 1 : 0;
  }
  if (patch.ownershipEtag !== undefined) columns.ownership_etag = patch.ownershipEtag;
  if (patch.ownershipJson !== undefined) columns.ownership_json = patch.ownershipJson;
  if (patch.lastPublishedAt !== undefined) {
    columns.last_published_at = patch.lastPublishedAt;
  }
  if (patch.lastPulledAt !== undefined) columns.last_pulled_at = patch.lastPulledAt;
  if (patch.revokedJson !== undefined) columns.revoked_json = patch.revokedJson;

  const keys = Object.keys(columns);
  if (keys.length === 0) return;

  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  prepared(db, `UPDATE kairos_sync_state SET ${assignments} WHERE plan_id = ?`).run(
    ...keys.map((key) => columns[key] as never),
    planId
  );
}

/**
 * Record the end of a COMPLETE pull.
 *
 * Separate from `updateSyncState` so the watermark advance is one named,
 * greppable call rather than a field that any caller could set. `pull.ts` runs
 * it once, after the last page, and nowhere else.
 */
export function completePull(
  db: Db,
  planId: string,
  toVersion: number,
  syncEpoch: number,
  at: string
): void {
  prepared(
    db,
    `UPDATE kairos_sync_state
        SET watermark = ?, sync_epoch = ?, last_pulled_at = ?
      WHERE plan_id = ?`
  ).run(toVersion, syncEpoch, at, planId);
}

// ---------------------------------------------------------------- ou state

/** The last `/sync/heads` answer for a property: ETag and the body it validates. */
export interface OuState {
  ou: string;
  headsEtag: string | null;
  headsJson: string | null;
  fetchedAt: string | null;
}

export function getOuState(db: Db, ou: string): OuState | null {
  const row = prepared(db, `SELECT * FROM kairos_ou_state WHERE ou = ?`).get(ou) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    ou: String(row.ou),
    headsEtag: (row.heads_etag as string) ?? null,
    headsJson: (row.heads_json as string) ?? null,
    fetchedAt: (row.fetched_at as string) ?? null,
  };
}

/**
 * Store a 200 answer whole.
 *
 * ETag and body are written together and never separately: an ETag without the
 * body it validates is worse than no ETag at all, because the next request will
 * answer 304 to a client that has nothing to serve from.
 */
export function putOuHeads(
  db: Db,
  ou: string,
  etag: string | null,
  body: string,
  at: string
): void {
  prepared(
    db,
    `INSERT INTO kairos_ou_state (ou, heads_etag, heads_json, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ou) DO UPDATE SET
       heads_etag = excluded.heads_etag,
       heads_json = excluded.heads_json,
       fetched_at = excluded.fetched_at`
  ).run(ou, etag, body, at);
}

// ------------------------------------------------------------------ shadow

export function getShadow(
  db: Db,
  planId: string,
  entityType: string,
  entityId: string
): ShadowRow | null {
  const row = prepared(
    db,
    `SELECT entity_type, entity_id, hash, server_seq, deleted
       FROM kairos_sync_shadow
      WHERE plan_id = ? AND entity_type = ? AND entity_id = ?`
  ).get(planId, entityType, entityId) as Record<string, unknown> | undefined;
  return row ? toShadow(row) : null;
}

/**
 * The whole shadow for a plan, as a lookup keyed `"type id"`.
 *
 * One query and one map rather than a `getShadow` per row: a publish compares
 * every local row against its shadow, and 3,500 prepared-statement round trips
 * to answer questions a single scan already has is the difference between a
 * publish that feels instant and one that visibly stalls.
 */
export function loadShadowMap(db: Db, planId: string): Map<string, ShadowRow> {
  const rows = prepared(
    db,
    `SELECT entity_type, entity_id, hash, server_seq, deleted
       FROM kairos_sync_shadow WHERE plan_id = ?`
  ).all(planId) as Array<Record<string, unknown>>;

  const map = new Map<string, ShadowRow>();
  for (const row of rows) {
    const shadow = toShadow(row);
    map.set(shadowKey(shadow.entityType, shadow.entityId), shadow);
  }
  return map;
}

/** The map key. A space cannot occur in an entity type or a client-minted id. */
export function shadowKey(entityType: string, entityId: string): string {
  return `${entityType} ${entityId}`;
}

function toShadow(row: Record<string, unknown>): ShadowRow {
  return {
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    hash: String(row.hash),
    serverSeq: Number(row.server_seq ?? 0),
    deleted: row.deleted === 1,
  };
}

export interface ShadowWrite {
  entityType: string;
  entityId: string;
  hash: string;
  serverSeq: number;
  deleted: boolean;
}

/** Upsert a batch of shadow rows in one transaction. */
export function writeShadow(db: Db, planId: string, rows: ShadowWrite[], at: string): void {
  if (rows.length === 0) return;
  const statement = prepared(
    db,
    `INSERT INTO kairos_sync_shadow
       (plan_id, entity_type, entity_id, hash, server_seq, deleted, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(plan_id, entity_type, entity_id) DO UPDATE SET
       hash = excluded.hash,
       server_seq = excluded.server_seq,
       deleted = excluded.deleted,
       synced_at = excluded.synced_at`
  );
  db.transaction(() => {
    for (const row of rows) {
      statement.run(
        planId,
        row.entityType,
        row.entityId,
        row.hash,
        row.serverSeq,
        row.deleted ? 1 : 0,
        at
      );
    }
  })();
}

/**
 * Drop the whole shadow for a plan.
 *
 * Called on `409 kairos_sync_epoch_changed` — a support lease was handed back
 * and the server's copy wins outright, so every remembered hash is now a claim
 * about a history that no longer exists.
 */
export function clearShadow(db: Db, planId: string): void {
  prepared(db, `DELETE FROM kairos_sync_shadow WHERE plan_id = ?`).run(planId);
}

/** The client half of `POST /manifest/diff`: `[type, id, hash]` per live row. */
export function buildManifest(db: Db, planId: string): Array<[string, string, string]> {
  const rows = prepared(
    db,
    `SELECT entity_type, entity_id, hash FROM kairos_sync_shadow
      WHERE plan_id = ? AND deleted = 0
      ORDER BY entity_type, entity_id`
  ).all(planId) as Array<Record<string, unknown>>;
  return rows.map((row) => [
    String(row.entity_type),
    String(row.entity_id),
    String(row.hash),
  ]);
}

/** How many rows in this plan differ from what the server last confirmed. */
export function countShadow(db: Db, planId: string): number {
  const row = prepared(
    db,
    `SELECT COUNT(*) AS total FROM kairos_sync_shadow WHERE plan_id = ?`
  ).get(planId) as { total?: number } | undefined;
  return Number(row?.total ?? 0);
}
