/**
 * Engine output as an artifact, and the resumable upload channel.
 * -----------------------------------------------------------
 * `engine_output_lines` is ~10k rows of derived numbers — one per
 * (position, component) contribution to a dept × account. It is deliberately NOT
 * published as entities: the recipient's own engine reproduces it exactly from
 * the inputs, so syncing it row by row would multiply a plan's wire size for
 * data nobody merges. It goes up as one gzipped blob instead, and the metadata
 * (`engine_run`, carrying the fingerprint) travels as an entity so a puller can
 * tell whether the publisher's results were current when they published.
 *
 * `stale: true` on an artifact means it was computed against an older plan
 * version. Do not render it as current — that is the whole reason the flag
 * exists, and a stale result page looks exactly like a correct one.
 *
 * **A delegate can never read an artifact** (403). It aggregates every
 * department into one opaque file, so there is no column to filter on: it is all
 * thirty departments or none. This is the only Kairos read with no partial
 * answer, so hide the surface rather than letting them hit the error.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { gzipSync, gunzipSync } from "zlib";
import { prepared } from "../positions/stmtCache";
import { KairosApiError, KAIROS_ERRORS, KairosClient, query } from "./client";
import { bytesHash } from "./hash";
import {
  ArtifactList,
  UploadCreate,
  UploadStatus,
} from "../../shared/kairosSync/protocol";

type Db = InstanceType<typeof Database>;

const plan = (planId: string) => `/plans/${encodeURIComponent(planId)}`;

/** The only artifact kind today. */
export const ENGINE_OUTPUT = "engine_output";

/** Server cap. A bigger blob is a 413, so check before spending the CPU. */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** 1 MiB per part, 256 parts, 24-hour TTL — the resumable upload's shape. */
export const UPLOAD_PART_BYTES = 1024 * 1024;

/** Gzip the plan's engine output lines. Null when there is nothing to send. */
export function buildEngineOutputArtifact(
  secureDb: Db,
  ou: string,
  planId: string
): Buffer | null {
  const rows = prepared(
    secureDb,
    `SELECT position_id, component_def_id, label, dept, account,
            monthly_values, total, source, source_ref, detail
       FROM engine_output_lines
      WHERE ou = ? AND scenario_id = ?
      ORDER BY position_id, component_def_id`
  ).all(ou, planId) as Array<Record<string, unknown>>;

  if (rows.length === 0) return null;
  return gzipSync(Buffer.from(JSON.stringify({ ou, planId, rows }), "utf8"));
}

export type ArtifactPushResult =
  | { outcome: "pushed"; bytes: number }
  | { outcome: "nothing-local" }
  | { outcome: "too-large"; bytes: number; max: number };

/**
 * Publish the engine output.
 *
 * Sent as one PUT rather than through the resumable channel: 16 MiB is the cap
 * and a typical blob is a small fraction of it, so the extra round trips would
 * cost more than the occasional retry. The resumable path below exists for the
 * links where that stops being true.
 */
export async function pushEngineOutput(
  secureDb: Db,
  client: KairosClient,
  ou: string,
  planId: string
): Promise<ArtifactPushResult> {
  const bytes = buildEngineOutputArtifact(secureDb, ou, planId);
  if (!bytes) return { outcome: "nothing-local" };
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    return { outcome: "too-large", bytes: bytes.byteLength, max: MAX_ARTIFACT_BYTES };
  }

  await client.putBytes(
    `${plan(planId)}/artifacts/${ENGINE_OUTPUT}`,
    bytes,
    "application/gzip"
  );
  return { outcome: "pushed", bytes: bytes.byteLength };
}

/** What artifacts the plan has, and whether each is current. */
export async function listArtifacts(
  client: KairosClient,
  planId: string
): Promise<ArtifactList | null> {
  try {
    return await client.get<ArtifactList>(`${plan(planId)}/artifacts`);
  } catch (error) {
    // A delegate gets 403 here by design; an empty list is the honest answer to
    // "what can I see?" rather than an error banner they can do nothing about.
    if (error instanceof KairosApiError && error.status === 403) return null;
    throw error;
  }
}

/** Download an artifact's bytes, ungzipped. Null on 304 or when absent. */
export async function fetchArtifact(
  client: KairosClient,
  planId: string,
  kind: string,
  etag: string | null
): Promise<{ data: unknown | null; etag: string | null }> {
  try {
    const response = await client.getBytes(
      `${plan(planId)}/artifacts/${encodeURIComponent(kind)}`,
      etag
    );
    if (response.bytes === null) return { data: null, etag: response.etag };
    return {
      data: JSON.parse(gunzipSync(response.bytes).toString("utf8")),
      etag: response.etag,
    };
  } catch (error) {
    if (error instanceof KairosApiError && error.is(KAIROS_ERRORS.ARTIFACT_NOT_FOUND)) {
      return { data: null, etag: null };
    }
    throw error;
  }
}

// ------------------------------------------------------------ resumable upload

/**
 * Send a large body over a link that drops.
 *
 * Parts are idempotent by number, so a timeout is answered by re-sending that
 * part rather than restarting. Resuming means asking `GET /uploads/{id}` and
 * sending only `missingParts` — which is also what makes an interrupted upload
 * survive an app restart, since the upload id is all the state involved.
 *
 * Per-part checksums prove each part arrived intact; only `declaredHash` over
 * the whole assembled body proves they were the RIGHT parts in the right order.
 *
 * Authority is re-checked at completion, against the destination — on a slow
 * link a grant can be revoked between the first part and the last.
 */
export async function resumableUpload(
  client: KairosClient,
  bytes: Buffer,
  destination: Omit<UploadCreate, "totalParts" | "declaredHash" | "declaredBytes">,
  completeQuery: Record<string, string | null> = {}
): Promise<unknown> {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_PART_BYTES) {
    parts.push(bytes.subarray(offset, offset + UPLOAD_PART_BYTES));
  }

  const created = await client.post<{ uploadId: string }>(`/uploads`, {
    ...destination,
    totalParts: parts.length,
    declaredHash: bytesHash(bytes),
    declaredBytes: bytes.byteLength,
  } satisfies UploadCreate);

  const uploadId = created.uploadId;
  // Ask what is already there before sending anything. On a first attempt this
  // is one cheap request; on a resume it is the difference between re-sending
  // 200 MiB and re-sending 3 MiB.
  let missing = (await client.get<UploadStatus>(`/uploads/${uploadId}`)).missingParts;
  if (missing.length === 0) missing = parts.map((_, index) => index + 1);

  for (const number of missing) {
    const part = parts[number - 1];
    if (!part) continue;
    await client.putBytes(
      `/uploads/${uploadId}/parts/${number}${query({ checksum: bytesHash(part) })}`,
      part
    );
  }

  try {
    return await client.post(`/uploads/${uploadId}/complete${query(completeQuery)}`);
  } catch (error) {
    if (
      error instanceof KairosApiError &&
      error.is(KAIROS_ERRORS.UPLOAD_INCOMPLETE) &&
      Array.isArray(error.context?.missingParts)
    ) {
      // One more pass at whatever the server says it is still missing. Beyond
      // that the link is bad enough that retrying in a loop only wastes the
      // 24-hour TTL the user could otherwise resume inside.
      for (const number of error.context.missingParts as number[]) {
        const part = parts[number - 1];
        if (!part) continue;
        await client.putBytes(
          `/uploads/${uploadId}/parts/${number}${query({ checksum: bytesHash(part) })}`,
          part
        );
      }
      return client.post(`/uploads/${uploadId}/complete${query(completeQuery)}`);
    }
    throw error;
  }
}
