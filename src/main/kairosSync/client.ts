/**
 * The `/kairos` HTTP client.
 * -----------------------------------------------------------
 * Everything the Kairos surface needs that the shared `ApiClient` does not do:
 * conditional requests, gzipped request bodies, mandatory idempotency keys,
 * machine-readable error codes, and backoff that respects the server's rate
 * limits instead of hammering through them.
 *
 * It wraps rather than extends `ApiClient` so the Bearer attachment and the
 * single-flight refresh-on-401 policy stay in exactly one place.
 *
 * ## Why the error type matters
 *
 * The server answers `{"detail": "<prose>", "error": "<machine_code>"}`. The
 * prose is for the user and stays a string so `extractDetail` keeps working;
 * the CODE is what the client branches on, and several codes carry a `context`
 * object the UI is required to render (the partial-overlap warning, the
 * unsynced-work warning, the revoked-delegation banner). Losing either to a
 * generic `Error` would make those flows impossible, which is why every call
 * here throws `KairosApiError`.
 *
 * ## Caching
 *
 * Kairos responses are `private, no-cache` — deliberately not `no-store`, which
 * would forbid keeping the entity to revalidate against and would silently kill
 * the 304 path. So this client never sets `cache: "no-store"` on a request.
 */

import { gzipSync } from "zlib";
import { randomUUID } from "crypto";
import { ApiClient, extractDetail } from "../auth/apiClient";

/** Base path for every endpoint in this module. */
const BASE = "/kairos";

/** Requests larger than this are worth compressing; below it, gzip costs more
 *  in CPU and framing than it saves on the wire. */
const GZIP_THRESHOLD_BYTES = 1024;

/** How many times a 429 or a transient 5xx is retried before giving up. */
const MAX_RETRIES = 3;

/** Backoff when the server sends no `Retry-After`. */
const BACKOFF_MS = [500, 2000, 8000];

/**
 * An error from the Kairos surface, carrying the machine code and any context.
 *
 * `code` is the thing to branch on. `context` is present on exactly the errors
 * whose recovery needs data the prose cannot carry — see §14 of the API guide.
 */
export class KairosApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "KairosApiError";
  }

  /** Convenience for the codes the UI treats as states rather than failures. */
  is(code: string): boolean {
    return this.code === code;
  }
}

/** Codes the client acts on rather than merely reporting. */
export const KAIROS_ERRORS = {
  SCOPE_EMPTY: "kairos_scope_empty",
  PLAN_NOT_FOUND: "kairos_plan_not_found",
  OWNER_NOT_ELIGIBLE: "kairos_owner_not_eligible",
  OWNER_ENTITLEMENT_LAPSED: "kairos_owner_entitlement_lapsed",
  DELEGATE_CANNOT: "kairos_delegate_cannot",
  STRUCTURE_OWNER_ONLY: "kairos_structure_owner_only",
  STRUCTURE_NOT_FOUND: "kairos_structure_not_found",
  STRUCTURE_PRECONDITION: "kairos_structure_precondition",
  DOC_HASH_MISMATCH: "kairos_doc_hash_mismatch",
  SYNC_EPOCH_CHANGED: "kairos_sync_epoch_changed",
  CURSOR_INVALID: "kairos_cursor_invalid",
  IDEMPOTENCY_KEY_MISMATCH: "kairos_idempotency_key_mismatch",
  IDEMPOTENCY_EXPIRED: "kairos_idempotency_expired",
  PLAN_LOCKED_BY_SUPPORT: "kairos_plan_locked_by_support",
  PLAN_NOT_EDITABLE: "kairos_plan_not_editable",
  DELEGATION_PARTIAL_OVERLAP: "kairos_delegation_partial_overlap",
  DELEGATION_NO_OVERLAP: "kairos_delegation_no_overlap",
  DELEGATION_REVOKED: "kairos_delegation_revoked",
  DELEGATE_HAS_UNSYNCED_WORK: "kairos_delegate_has_unsynced_work",
  DEPARTMENT_NOT_IN_PLAN: "kairos_department_not_in_plan",
  PII_DISABLED_FOR_OU: "kairos_pii_disabled_for_ou",
  PII_ERASE_UNCONFIRMED: "kairos_pii_erase_unconfirmed",
  BST_NOT_FOUND: "kairos_bst_not_found",
  BST_HASH_MISMATCH: "kairos_bst_hash_mismatch",
  ARTIFACT_NOT_FOUND: "kairos_artifact_not_found",
  UPLOAD_INCOMPLETE: "kairos_upload_incomplete",
  UPLOAD_EXPIRED: "kairos_upload_expired",
  REQUIRES_ADMIN_LEASE: "kairos_requires_admin_lease",
  REQUEST_TOO_LARGE: "request_too_large",
  /**
   * Client-side only: this caller's write scope is empty, so a publish would
   * send nothing. Raised before the request rather than after, because a
   * server-side "0 accepted" is indistinguishable from "nothing to do".
   */
  WRITE_SCOPE_EMPTY: "kairos_write_scope_empty",
} as const;

/** A conditional GET's answer: fresh data, or "you already have it". */
export type Conditional<T> =
  | { status: 200; body: T; etag: string | null }
  | { status: 304; body: null; etag: string | null };

export interface RequestOptions {
  /** Sent as `If-None-Match`. A 304 comes back as `{status: 304}`. */
  ifNoneMatch?: string | null;
  /** Sent as `If-Match` — the structure document's optimistic lock. */
  ifMatch?: string | null;
  /** Mandatory on commits. Reuse the SAME key when retrying the SAME chunk. */
  idempotencyKey?: string;
  /** Skip the retry loop, for calls where a stale answer is worse than none. */
  noRetry?: boolean;
}

/** Mint a key for one chunk. Persist it alongside the chunk so a retry reuses it. */
export function newIdempotencyKey(): string {
  return randomUUID();
}

/**
 * Hand raw bytes to `fetch` as a body.
 *
 * A `Buffer` is an `ArrayBufferView` at runtime and is a perfectly valid body,
 * but this project's `lib.dom` declares `BodyInit` against the pre-generic
 * `ArrayBufferView`, so TypeScript 5.7's `Uint8Array<ArrayBufferLike>` does not
 * structurally match it. One narrow, named cast is better than five inline ones
 * or than sending bodies as strings and losing gzip.
 */
function asBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before retrying, honouring `Retry-After` when present.
 *
 * `Retry-After` may be seconds or an HTTP date; both are accepted because
 * proxies rewrite one into the other.
 */
function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

/**
 * Turn a non-2xx response into a `KairosApiError`.
 *
 * Best-effort on the body: a proxy returning an HTML error page must still
 * produce a usable error rather than a JSON parse failure.
 */
async function toError(response: Response): Promise<KairosApiError> {
  let detail = "";
  let code = `http_${response.status}`;
  let context: Record<string, unknown> | undefined;
  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    if (typeof body.detail === "string") detail = body.detail;
    if (typeof body.error === "string") code = body.error;
    if (body.context && typeof body.context === "object") {
      context = body.context as Record<string, unknown>;
    }
  } catch {
    detail = await extractDetail(response);
  }
  if (!detail) detail = `Request failed with status ${response.status}`;
  return new KairosApiError(response.status, detail, code, context);
}

export class KairosClient {
  constructor(private api: ApiClient) {}

  /**
   * One request, with retry on 429 and on transient 5xx.
   *
   * 4xx other than 429 is never retried: the server has made a decision about
   * this exact request and repeating it changes nothing except the audit log.
   */
  private async send(
    path: string,
    init: RequestInit,
    options: RequestOptions = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string>) ?? {}),
      "Accept-Encoding": "gzip",
    };
    if (options.ifNoneMatch) headers["If-None-Match"] = options.ifNoneMatch;
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    let attempt = 0;
    for (;;) {
      const response = await this.api.request(`${BASE}${path}`, { ...init, headers });
      const retriable = response.status === 429 || response.status >= 500;
      if (!retriable || options.noRetry || attempt >= MAX_RETRIES) return response;
      await sleep(retryDelay(response, attempt));
      attempt += 1;
    }
  }

  /**
   * A JSON body, gzipped when it is big enough to be worth it.
   *
   * gzip and not brotli: the server accepts `gzip`/`deflate` only, and Node's
   * `zlib.gzipSync` needs no extra dependency. Two ceilings apply server-side —
   * 8 MiB on the wire and 32 MiB decompressed — so the chunker upstream is what
   * keeps a body inside them, not this.
   */
  private encodeBody(
    body: unknown
  ): { body: BodyInit; headers: Record<string, string> } {
    // Uint8Array rather than Buffer: a Buffer IS one at runtime, but `BodyInit`
    // does not name it, and casting at five call sites is worse than converting
    // once here.
    const raw = Buffer.from(JSON.stringify(body ?? null), "utf8");
    if (raw.byteLength < GZIP_THRESHOLD_BYTES) {
      return {
        body: asBody(raw),
        headers: { "Content-Type": "application/json" },
      };
    }
    return {
      body: asBody(gzipSync(raw)),
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    };
  }

  private async parse<T>(response: Response): Promise<T> {
    if (!response.ok) throw await toError(response);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ------------------------------------------------------------- verbs

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.parse<T>(await this.send(path, { method: "GET" }, options));
  }

  /**
   * A conditional GET. 304 is a success, not an error — it is the steady state.
   *
   * Note that an ETag also goes stale when the caller's GRANTS change, because
   * the server folds the authorisation digest into it. A 200 where a 304 was
   * expected means "your scope moved", not "something is wrong".
   */
  async getConditional<T>(
    path: string,
    etag: string | null,
    options: RequestOptions = {}
  ): Promise<Conditional<T>> {
    const response = await this.send(
      path,
      { method: "GET" },
      { ...options, ifNoneMatch: etag }
    );
    const nextEtag = response.headers.get("etag");
    if (response.status === 304) return { status: 304, body: null, etag: etag ?? nextEtag };
    if (!response.ok) throw await toError(response);
    const text = await response.text();
    return {
      status: 200,
      body: (text ? JSON.parse(text) : undefined) as T,
      etag: nextEtag,
    };
  }

  async post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const encoded = this.encodeBody(body);
    return this.parse<T>(
      await this.send(
        path,
        { method: "POST", body: encoded.body, headers: encoded.headers },
        options
      )
    );
  }

  async put<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const encoded = this.encodeBody(body);
    return this.parse<T>(
      await this.send(
        path,
        { method: "PUT", body: encoded.body, headers: encoded.headers },
        options
      )
    );
  }

  async patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const encoded = this.encodeBody(body);
    return this.parse<T>(
      await this.send(
        path,
        { method: "PATCH", body: encoded.body, headers: encoded.headers },
        options
      )
    );
  }

  async delete<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const init: RequestInit = { method: "DELETE" };
    if (body !== undefined) {
      const encoded = this.encodeBody(body);
      init.body = encoded.body;
      init.headers = encoded.headers;
    }
    return this.parse<T>(await this.send(path, init, options));
  }

  /** Raw bytes in, for artifact uploads and upload parts. */
  async putBytes<T>(
    path: string,
    bytes: Buffer,
    contentType = "application/octet-stream",
    options: RequestOptions = {}
  ): Promise<T> {
    return this.parse<T>(
      await this.send(
        path,
        {
          method: "PUT",
          body: asBody(bytes),
          headers: { "Content-Type": contentType },
        },
        options
      )
    );
  }

  /**
   * Raw bytes out, for artifact downloads. 304 returns a null body.
   *
   * `headers` is passed through because two of these responses carry meaning
   * outside the body: an artifact's `X-Kairos-Plan-Version` says whether it is
   * stale, and an admin bundle's `X-Kairos-Rows` is the only place the row count
   * appears at all.
   */
  async getBytes(
    path: string,
    etag: string | null
  ): Promise<{
    status: number;
    bytes: Buffer | null;
    etag: string | null;
    headers: Headers;
  }> {
    const response = await this.send(path, { method: "GET" }, { ifNoneMatch: etag });
    const nextEtag = response.headers.get("etag");
    if (response.status === 304) {
      return { status: 304, bytes: null, etag: etag ?? nextEtag, headers: response.headers };
    }
    if (!response.ok) throw await toError(response);
    return {
      status: 200,
      bytes: Buffer.from(await response.arrayBuffer()),
      etag: nextEtag,
      headers: response.headers,
    };
  }
}

/** Query-string helper that omits null/undefined rather than sending "null". */
export function query(params: Record<string, string | number | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
