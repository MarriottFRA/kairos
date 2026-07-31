/**
 * The BST workbook and the KPI series.
 * -----------------------------------------------------------
 * A hotel's budget-spread file is ~100k long-form rows locally
 * (`budget_values`, one per combo × bucket × month) and ~3k wide rows on the
 * wire (`{combo, dept, account, cells[36]}`). The client already pivots to
 * exactly that shape for its own grid — `getImportRows` in
 * `src/main/budgetImport/repo.ts` — with the same `bucket * 12 + month` index,
 * so this module reuses it rather than writing a second pivot that could drift.
 *
 * One index difference to keep straight: the local `bucket_index` is 1-based
 * (a CHECK constraint enforces 1..3) and the wire `bucket` is 0-based.
 *
 * ## Why the upload is owner-only
 *
 * BST is the shared baseline every plan's KPI drivers aggregate from. A
 * delegate's workbook would silently rewrite the numbers behind every other
 * department's KPI-driven blocks — including departments they cannot see.
 *
 * ## `POST /kpi-series` is the high-leverage call
 *
 * It turns a 100k-row dependency into twelve numbers: one indexed aggregate,
 * never touching the stored blob. The selector is sent BY us, so a new driver
 * field needs no server release. Two traps, both easy to miss:
 *
 *   - Department scope is ANDed in on top of the patterns. `["*"]` from a
 *     four-department user sums four departments, not thirty. Gate on `scope.kind`.
 *   - `*` is the ONLY wildcard. `%` and `_` match LITERALLY, so a pattern
 *     borrowed from SQL matches nothing rather than everything.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { KairosApiError, KAIROS_ERRORS, KairosClient } from "./client";
import { documentHash } from "./hash";
import {
  BstBucket,
  BstPushEligibility,
  BstPushLog,
  BstUpload,
  BstVersion,
  BstWorkbook,
  KpiSeriesRequest,
  KpiSeriesResponse,
  WideBudgetRow,
} from "../../shared/kairosSync/protocol";
import { getCurrentImport, getImportRows } from "../budgetImport/repo";

type Db = InstanceType<typeof Database>;

/** The server caps a workbook here; beyond it the upload is refused outright. */
export const MAX_BST_ROWS = 20000;

const ou = (value: string) => `/ou/${encodeURIComponent(value)}`;

/**
 * The stored workbook's identity, without downloading it.
 *
 * Call this first: it is ETag'd and tiny, and a matching `contentHash` means the
 * hotel's copy is already current. `/sync/heads` carries the same hash, so in
 * practice this is only needed when acting on BST alone.
 */
export async function fetchBstVersion(
  client: KairosClient,
  ouCode: string,
  etag: string | null
): Promise<{ version: BstVersion | null; etag: string | null; notModified: boolean }> {
  try {
    const response = await client.getConditional<BstVersion>(
      `${ou(ouCode)}/bst/version`,
      etag
    );
    if (response.status === 304) {
      return { version: null, etag: response.etag, notModified: true };
    }
    return { version: response.body, etag: response.etag, notModified: false };
  } catch (error) {
    if (error instanceof KairosApiError && error.is(KAIROS_ERRORS.BST_NOT_FOUND)) {
      // No workbook published for this property. Keep whatever was pulled
      // locally from Excel — the same "not an error" contract as the structure
      // document and the mapping tables.
      return { version: null, etag: null, notModified: false };
    }
    throw error;
  }
}

/**
 * Download the workbook.
 *
 * A full-scope caller gets the stored blob spliced in verbatim (no server CPU).
 * A partially-scoped one gets rows rebuilt from the projection: their
 * departments, PLUS rows with `dept: ""` — property-level lines belonging to no
 * department, which would otherwise make their totals disagree with the workbook
 * they can open in Excel.
 */
export async function fetchBst(
  client: KairosClient,
  ouCode: string
): Promise<BstWorkbook | null> {
  try {
    return await client.get<BstWorkbook>(`${ou(ouCode)}/bst`);
  } catch (error) {
    if (error instanceof KairosApiError && error.is(KAIROS_ERRORS.BST_NOT_FOUND)) {
      return null;
    }
    throw error;
  }
}

/** The local import, in the wire's wide shape. Null if nothing has been pulled. */
export function buildBstUpload(db: Db, ouCode: string): BstUpload | null {
  const summary = getCurrentImport(db, ouCode);
  if (!summary) return null;

  const rows = getImportRows(db, ouCode) as unknown as WideBudgetRow[];
  const buckets: BstBucket[] = summary.buckets.map((bucket, index) => ({
    // Local bucket indexes are 1-based; the wire is 0-based.
    index,
    type: bucket.type ?? "",
    year: bucket.year ?? 0,
  }));

  const upload: BstUpload = {
    importId: summary.id,
    buckets,
    rows,
    sourceFilename: summary.sourceFileName,
    hotelName: summary.hotelName,
    bu: summary.bu,
    currency: summary.currency,
    asOfPeriod: summary.asOfPeriod,
  };

  // Our own digest of exactly what is being sent. The server compares rather
  // than trusts it: a mismatch means the body was mangled in transit, and
  // re-sending now is far cheaper than discovering it in March.
  upload.contentHash = documentHash({ importId: upload.importId, rows, buckets });
  return upload;
}

export type BstUploadResult =
  | { outcome: "uploaded"; version: BstVersion }
  | { outcome: "nothing-local" }
  | { outcome: "too-many-rows"; rows: number; max: number }
  | { outcome: "unchanged" };

/**
 * Publish the workbook, unless the server already has this exact one.
 *
 * Re-sending an identical `contentHash` is a no-op that does NOT move the ETag,
 * so every other client at the property is spared a re-download. Checking here
 * as well saves the upload entirely.
 */
export async function pushBst(
  db: Db,
  client: KairosClient,
  ouCode: string,
  knownContentHash: string | null
): Promise<BstUploadResult> {
  const upload = buildBstUpload(db, ouCode);
  if (!upload) return { outcome: "nothing-local" };
  if (upload.rows.length > MAX_BST_ROWS) {
    return { outcome: "too-many-rows", rows: upload.rows.length, max: MAX_BST_ROWS };
  }
  if (knownContentHash && knownContentHash === upload.contentHash) {
    return { outcome: "unchanged" };
  }

  const version = await client.put<BstVersion>(`${ou(ouCode)}/bst`, upload);
  return { outcome: "uploaded", version };
}

/**
 * Twelve numbers for one KPI driver, computed server-side.
 *
 * `deptPatterns` uses `*` and nothing else — the local
 * `kpi_driver_dept_patterns` are matched with GLOB, which agrees. A driver in
 * `POSITION` department mode produces one series PER department, so it needs one
 * call per department rather than one call.
 */
export function fetchKpiSeries(
  client: KairosClient,
  ouCode: string,
  request: KpiSeriesRequest
): Promise<KpiSeriesResponse> {
  return client.post<KpiSeriesResponse>(`${ou(ouCode)}/kpi-series`, request);
}

/**
 * May this caller run a BST push?
 *
 * Call before enabling the push page and render the `reasons` — they need
 * different actions from the user. `PARTIAL_SCOPE` in particular is not a
 * permission nicety: the push zeroes rows before writing, so a partial push
 * destroys good numbers rather than producing incomplete ones.
 */
export function fetchPushEligibility(
  client: KairosClient,
  planId: string
): Promise<BstPushEligibility> {
  return client.get<BstPushEligibility>(
    `/plans/${encodeURIComponent(planId)}/bst-push/eligibility`
  );
}

/**
 * Record that the hotel's real workbook was written to.
 *
 * The push itself stays entirely client-side. This log is the only record that
 * Kairos changed the file, and it is what answers "why does the workbook
 * disagree with the plan?" months later. Failures are swallowed — a logging
 * outage must not make a successful push look like a failed one.
 */
export async function logBstPush(
  client: KairosClient,
  planId: string,
  entry: BstPushLog
): Promise<boolean> {
  try {
    await client.post(`/plans/${encodeURIComponent(planId)}/bst-push/log`, entry, {
      noRetry: true,
    });
    return true;
  } catch {
    return false;
  }
}
