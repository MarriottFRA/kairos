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
  /**
   * Rows for a position this computer does not hold, skipped rather than
   * written. See `pullPii` for why one of these must not end the download.
   */
  orphaned: number;
  orphanedPositionIds: string[];
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
    orphaned: 0,
    orphanedPositionIds: [],
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

      const orphans = new Set<string>();
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
        /**
         * A record for a position we do not hold.
         *
         * `position_pii.position_id` is a foreign key, so the insert throws, and
         * one such row used to end the whole stream: every row before it landed,
         * nothing after it did, no watermark was recorded, and every later
         * download stopped at the same row. The server can hold one — a record
         * whose position was never stored, with a NULL department, which the
         * server treats as plan-wide and sends to every reader. Skipped, counted,
         * and kept out of the shadow, so a publish neither re-sends nor purges
         * a row this computer never had.
         */
        if (apply && !positionExists(secureDb, row.positionId)) {
          orphans.add(row.positionId);
          result.orphaned += 1;
          result.orphanedPositionIds.push(row.positionId);
          console.warn(
            `[kairosSync] PII for unknown position ${row.positionId} skipped ` +
              `(plan ${planId}, page ${result.pages}, department ${row.department ?? "none"})`
          );
          continue;
        }
        result.applied += 1;
        if (apply) {
          try {
            upsertPii(secureDb, piiFromPayload(row.payload));
          } catch (error) {
            throw new Error(
              `PII download stopped on page ${result.pages} at position ${row.positionId} ` +
                `after ${result.applied - 1} rows: ${(error as Error).message}`,
              { cause: error }
            );
          }
        }
      }

      if (apply) {
        writeShadow(
          db,
          planId,
          page.rows.filter((row) => !orphans.has(row.positionId)).map((row) => ({
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

function positionExists(db: Db, positionId: string): boolean {
  return prepared(db, `SELECT 1 FROM positions WHERE id = ?`).get(positionId) !== undefined;
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

/**
 * Flip the kill switch. Administrators only — deliberately not the hotel's owner.
 *
 * The switch exists for jurisdictions that refuse server-side storage of employee
 * details, so it is a compliance position taken by the organisation rather than a
 * preference an owner can turn back on the afternoon after legal turned it off.
 *
 * Turning it off erases nothing. `erasePii` is the separate, deliberate act that
 * destroys what is already there.
 */
export function putOuSettings(
  client: KairosClient,
  ou: string,
  piiEnabled: boolean,
  reason: string
): Promise<OuSettings> {
  return client.put<OuSettings>(`/ou/${encodeURIComponent(ou)}/settings`, {
    piiEnabled,
    reason,
  });
}
