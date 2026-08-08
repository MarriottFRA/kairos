/**
 * The administrator surface: estate triage, the audit trail, and the bundle.
 * -----------------------------------------------------------
 * Everything here is reachable only by a user the server resolves as an
 * administrator. There is no client-side gate worth the name and none is
 * attempted: the "Support tools" switch in Settings is a preference about what
 * to *render*, and it is turned on by making `probeAdmin` and seeing whether the
 * server allows it. A hotel user who flips the same switch gets a 403 and the
 * UI stays exactly as it was.
 *
 * ## Why the probe is a real request rather than a claim
 *
 * The renderer has no idea what access the signed-in user holds — there is no
 * `/me` on this surface, only a per-plan `relation`. So "am I an administrator"
 * is answered the only honest way available: ask for something only an
 * administrator may have, and believe the status code. That also means the
 * answer expires correctly. An administrator whose role is removed loses the UI
 * on the next probe rather than keeping a stale unlocked screen.
 *
 * ## The bundle is written to disk, not returned
 *
 * `GET /admin/plans/{id}/bundle` answers with a gzipped NDJSON attachment, and
 * the gzip is part of the payload rather than `Content-Encoding` — the file an
 * administrator saves is a `.ndjson.gz`. Passing megabytes back across IPC to be
 * re-saved by the renderer would be pointless, so it lands on disk here and only
 * the path travels. It is also rate limited to twenty per day estate-wide, and
 * every call writes a row somebody can be asked about, which is why `reason` is
 * mandatory on the way in.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KairosApiError, KairosClient, query } from "./client";
import {
  AdminHotel,
  AdminPlanList,
  AuditRow,
  BundleOptions,
  BundleResult,
  ScopeTrace,
  SupportDownload,
} from "../../shared/kairosSync/protocol";

/**
 * Is this caller an administrator?
 *
 * `/admin/hotels` is the cheapest of the admin reads and is `no-dept`, so it
 * answers for a user who holds the role but has no department grant anywhere —
 * which is the normal shape of an estate administrator.
 */
export async function probeAdmin(client: KairosClient): Promise<boolean> {
  try {
    await client.get<AdminHotel[]>(`/admin/hotels`);
    return true;
  } catch (error) {
    // 403 is the answer, not a failure. Anything else — offline, 500 — is not
    // evidence of anything, and must not silently deny a real administrator.
    if (error instanceof KairosApiError && error.status === 403) return false;
    throw error;
  }
}

/**
 * The admin list endpoints do not agree on whether a list is the body.
 *
 * `/admin/plans` answers `{plans, total}`, and at least `/admin/hotels` and
 * `/admin/downloads` answer with a wrapper of their own rather than the bare
 * array their description implies. Unwrapping here means the renderer only ever
 * holds an array — the alternative was every table guarding `Array.isArray`, and
 * a wrapper we failed to unwrap would then render as "no hotels to show", which
 * is a lie support would act on.
 *
 * The named key wins; otherwise a lone array-valued property is taken as the
 * list, which covers a wrapper key we have not seen. Anything else throws with
 * the keys that did arrive, because an unreadable answer has to be visible.
 */
function asList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record[key])) return record[key] as T[];
    const arrays = Object.values(record).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as T[];
    throw new Error(
      `Unexpected /admin/${key} response — no list found in {${Object.keys(record).join(", ")}}`
    );
  }
  throw new Error(`Unexpected /admin/${key} response — ${typeof payload}, expected a list`);
}

export async function fetchAdminHotels(client: KairosClient): Promise<AdminHotel[]> {
  return asList<AdminHotel>(await client.get(`/admin/hotels`), "hotels");
}

export function fetchAdminPlans(
  client: KairosClient,
  filters: {
    ou?: string | null;
    year?: number | null;
    ownerIneligible?: boolean | null;
    limit?: number | null;
    offset?: number | null;
  } = {}
): Promise<AdminPlanList> {
  return client.get<AdminPlanList>(
    `/admin/plans${query({
      ou: filters.ou ?? null,
      year: filters.year ?? null,
      ownerIneligible:
        filters.ownerIneligible === null || filters.ownerIneligible === undefined
          ? null
          : filters.ownerIneligible
            ? 1
            : 0,
      limit: filters.limit ?? null,
      offset: filters.offset ?? null,
    })}`
  );
}

export async function fetchAdminAudit(
  client: KairosClient,
  filters: { planId?: string | null; action?: string | null; limit?: number | null } = {}
): Promise<AuditRow[]> {
  return asList<AuditRow>(
    await client.get(
      `/admin/audit${query({
        planId: filters.planId ?? null,
        action: filters.action ?? null,
        limit: filters.limit ?? null,
      })}`
    ),
    "audit"
  );
}

export async function fetchAdminDownloads(
  client: KairosClient,
  filters: { planId?: string | null; limit?: number | null } = {}
): Promise<SupportDownload[]> {
  return asList<SupportDownload>(
    await client.get(
      `/admin/downloads${query({
        planId: filters.planId ?? null,
        limit: filters.limit ?? null,
      })}`
    ),
    "downloads"
  );
}

/**
 * Why does this user see what they see?
 *
 * `capability` narrows the trace to one decision; omitted, the answer covers the
 * caller's whole relation to the plan. `planId` is optional for the same reason
 * — "why can Anna not reach this hotel at all" is a question with no plan in it.
 */
export function fetchUserScope(
  client: KairosClient,
  userId: number,
  planId: string | null,
  capability: string | null
): Promise<ScopeTrace> {
  return client.get<ScopeTrace>(
    `/admin/users/${encodeURIComponent(String(userId))}/scope${query({
      planId,
      capability,
    })}`
  );
}

/**
 * Export a whole plan as a repro bundle, saved to `directory`.
 *
 * `reason` rides in the query string rather than a body because this is a GET
 * and the justification has to be impossible to omit. `raw` PII is break-glass
 * and the server refuses it without a lease — that refusal is left to travel
 * rather than being pre-empted here, so the message the administrator sees is
 * the server's own.
 */
export async function downloadBundle(
  client: KairosClient,
  directory: string,
  options: BundleOptions
): Promise<BundleResult> {
  const path =
    `/admin/plans/${encodeURIComponent(options.planId)}/bundle` +
    query({
      pii: options.pii,
      reason: options.reason,
      ticketRef: options.ticketRef ?? null,
      outputs: options.outputs ? 1 : 0,
    });

  const response = await client.getBytes(path, null);
  const bytes = response.bytes ?? Buffer.alloc(0);
  const savedTo = join(directory, `kairos-${options.planId}.ndjson.gz`);
  await writeFile(savedTo, bytes);

  return {
    planId: options.planId,
    savedTo,
    // The row count exists only as a header. Absent, the file is still valid and
    // the count is simply unknown — reported as 0 rather than guessed.
    rows: Number(response.headers.get("x-kairos-rows") ?? 0),
    piiMode: response.headers.get("x-kairos-pii-mode") ?? options.pii,
    byteSize: bytes.byteLength,
  };
}
