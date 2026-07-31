/**
 * Employee personal details over the wire.
 * -----------------------------------------------------------
 * `position_pii` is published in the ordinary commit chunk like any other
 * entity, but the server diverts it into a separate table, sealed with
 * AES-256-GCM under a per-plan key and bound to `(planId, positionId)` as
 * associated data — so a ciphertext moved to another position will not open. It
 * is never served by `/changes`; it comes back through its own paginated stream
 * with its own watermark.
 *
 * ## Two rules the commit path already enforces, restated because they bite
 *
 * 1. `entityId` MUST equal `parentId`, both being the position id. The sidecar
 *    is 1:1 with its position and is stored under the position's id; anything
 *    else is `PII_KEY_MISMATCH`, and the client's manifest would key the row one
 *    way and the server's storage the other — reporting it missing on one side
 *    forever.
 * 2. Check `GET /ou/{ou}/settings` BEFORE a first publish. A property with
 *    personal-data storage switched off rejects every PII row (the rest of the
 *    chunk still lands), and discovering that as a wall of rejections is a much
 *    worse experience than being told up front.
 *
 * ## `payload: null` means two different things
 *
 * - with `deleted: true` — a tombstone; apply the delete.
 * - with `deleted: false` — **unreadable**: the key is gone (erasure) or a
 *   rotation left it un-openable. Treat as "no record" and surface the
 *   `unreadable` count; silently rendering blanks would look like a hotel that
 *   never entered any names.
 *
 * Every read writes an audit row server-side, which is another reason not to
 * poll this.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { prepared } from "../positions/stmtCache";
import { KairosApiError, KAIROS_ERRORS, KairosClient, query } from "./client";
import {
  OuSettings,
  PiiEraseResponse,
  PiiPage,
  PiiSummary,
} from "../../shared/kairosSync/protocol";
import { piiFromPayload } from "../../shared/kairosSync/entityMap";
import { updateSyncState, writeShadow } from "./repo";

type Db = InstanceType<typeof Database>;

const plan = (planId: string) => `/plans/${encodeURIComponent(planId)}`;

export interface PiiPullResult {
  planId: string;
  fromVersion: number;
  toVersion: number;
  rows: number;
  applied: number;
  deleted: number;
  /** Rows whose key is gone. Not blanks — say so in the UI. */
  unreadable: number;
  pages: number;
  /** The property has personal-data storage switched off. */
  disabled: boolean;
}

/**
 * Download personal details for a plan.
 *
 * Same cursor discipline as `/changes`: follow `nextCursor` to null, and record
 * the watermark only after the last page. The watermark is a SEPARATE column
 * from the entity one because these are two independent streams — sharing one
 * would skip rows on whichever side moved second.
 */
export async function pullPii(
  secureDb: Db,
  db: Db,
  client: KairosClient,
  planId: string,
  since: number,
  options: { apply?: boolean } = {}
): Promise<PiiPullResult> {
  const apply = options.apply === true;
  const result: PiiPullResult = {
    planId,
    fromVersion: since,
    toVersion: since,
    rows: 0,
    applied: 0,
    deleted: 0,
    unreadable: 0,
    pages: 0,
    disabled: false,
  };

  let cursor: string | null = null;
  let last: PiiPage | null = null;

  try {
    do {
      const page: PiiPage = await client.get<PiiPage>(
        `${plan(planId)}/pii${query({ since, cursor })}`
      );
      result.pages += 1;
      result.rows += page.rows.length;
      result.unreadable += page.unreadable;

      for (const row of page.rows) {
        if (row.payload === null) {
          // Tombstone, or a record whose key no longer exists. Either way there
          // is nothing to write; only the tombstone is a state change.
          if (row.deleted) {
            result.deleted += 1;
            if (apply) markPiiDeleted(secureDb, row.positionId);
          }
          continue;
        }
        result.applied += 1;
        if (apply) upsertPii(secureDb, piiFromPayload(row.payload));
      }

      if (apply) {
        writeShadow(
          db,
          planId,
          page.rows.map((row) => ({
            entityType: "position_pii",
            entityId: row.positionId,
            hash: row.hash,
            serverSeq: row.serverSeq,
            deleted: row.deleted,
          })),
          new Date().toISOString()
        );
      }

      cursor = page.nextCursor;
      last = page;
    } while (cursor !== null);
  } catch (error) {
    if (error instanceof KairosApiError && error.is(KAIROS_ERRORS.PII_DISABLED_FOR_OU)) {
      return { ...result, disabled: true };
    }
    throw error;
  }

  if (last) {
    result.fromVersion = last.fromVersion;
    result.toVersion = last.toVersion;
    // Only after the last page — the same rule as the entity watermark, for the
    // same reason.
    if (apply) updateSyncState(db, planId, { piiWatermark: last.toVersion });
  }

  return result;
}

function upsertPii(db: Db, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const assignments = columns
    .filter((column) => column !== "position_id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  prepared(
    db,
    `INSERT INTO position_pii (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})
     ON CONFLICT(position_id) DO UPDATE SET ${assignments}`
  ).run(...(columns.map((column) => row[column]) as never[]));
}

function markPiiDeleted(db: Db, positionId: string): void {
  prepared(
    db,
    `UPDATE position_pii SET deleted_at = COALESCE(deleted_at, ?) WHERE position_id = ?`
  ).run(new Date().toISOString(), positionId);
}

/**
 * How many records exist, and whether the key still does.
 *
 * Gated on `plan:read` rather than `pii:read`: a count is not a disclosure, and
 * whoever decides on an erasure needs the number even if they may not read the
 * contents. `keyPresent: false` with `rows > 0` means ERASED, not empty — two
 * very different things to tell a data-protection officer.
 */
export function fetchPiiSummary(
  client: KairosClient,
  planId: string
): Promise<PiiSummary> {
  return client.get<PiiSummary>(`${plan(planId)}/pii/summary`);
}

/**
 * Right to erasure, exercised on one plan.
 *
 * Owner-only and irreversible: it destroys the plan's data keys, so every
 * existing record becomes permanently unreadable. `confirmPlanId` must match the
 * path — a deliberate speed bump, not a security control (the caller already
 * holds the capability).
 *
 * The plan version bumps so other clients see the tombstones; `syncEpoch` does
 * NOT, because nobody needs a full re-download over it.
 */
export function erasePii(
  client: KairosClient,
  planId: string,
  reason: string
): Promise<PiiEraseResponse> {
  return client.delete<PiiEraseResponse>(`${plan(planId)}/pii`, {
    reason,
    confirmPlanId: planId,
  });
}

/**
 * The property's personal-data kill switch.
 *
 * For jurisdictions that refuse server-side storage of employee details. When
 * off, PII rows in a commit are rejected individually and the rest of the chunk
 * still lands; erasure still works, because "stop collecting" and "destroy the
 * archive" are separate decisions.
 *
 * Readable by anyone at the property; only administrators can change it.
 */
export function fetchOuSettings(client: KairosClient, ou: string): Promise<OuSettings> {
  return client.get<OuSettings>(`/ou/${encodeURIComponent(ou)}/settings`);
}
