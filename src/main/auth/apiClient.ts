/**
 * ApiClient — the single authenticated transport to the backend.
 * -----------------------------------------------------------
 * Every request to the API goes through here so that Bearer attachment and the
 * refresh-on-401 policy live in exactly one place (no per-endpoint copy-paste).
 *
 *   - rawFetch:    no app Authorization header (ms-exchange, login, register —
 *                  these carry the broker token, set by the caller).
 *   - fetchOnce:   attach the current access token; no refresh (auth handshake:
 *                  verify / logout — there is nothing to refresh before the
 *                  session exists, and the handshake is explicitly ordered).
 *   - authedFetch: attach the access token AND, on 401, run ONE single-flight
 *                  refresh and retry the request once (steady-state business
 *                  calls). /auth/refresh itself is owned by SessionManager.
 */

import { net } from "electron";
import { SessionManager } from "./sessionManager";

/** Error carrying the HTTP status + server `detail` for level/approval mapping. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientDeps {
  sessionManager: SessionManager;
  baseUrl: string;
}

export class ApiClient {
  constructor(private deps: ApiClientDeps) {}

  private buildUrl(path: string): string {
    return `${this.deps.baseUrl}${path}`;
  }

  private withAuth(headers?: HeadersInit): Record<string, string> {
    const merged: Record<string, string> = { ...(headers as Record<string, string>) };
    const token = this.deps.sessionManager.getAccessToken();
    if (token) {
      merged["Authorization"] = `Bearer ${token}`;
    }
    return merged;
  }

  /** Unauthenticated request (no Authorization header). */
  rawFetch(path: string, options: RequestInit = {}): Promise<Response> {
    // Electron's net.fetch uses Chromium's network stack, so it honours the
    // system (Windows) certificate store and proxy config — matching how the
    // renderer's fetch behaved. Node's global fetch (undici) would reject
    // corporate SSL-inspection certs with SELF_SIGNED_CERT_IN_CHAIN.
    return net.fetch(this.buildUrl(path), options);
  }

  /** Authenticated request with NO refresh-retry (auth handshake calls). */
  fetchOnce(path: string, options: RequestInit = {}): Promise<Response> {
    return net.fetch(this.buildUrl(path), {
      ...options,
      headers: this.withAuth(options.headers),
    });
  }

  /**
   * Authenticated request with lazy refresh: on 401, run one single-flight
   * refresh and retry once. If the session is dead, SessionManager.refresh()
   * throws SessionExpiredError (already cleared + emitted expiry) and it bubbles.
   */
  async authedFetch(path: string, options: RequestInit = {}): Promise<Response> {
    let response = await this.fetchOnce(path, options);
    if (response.status === 401) {
      await this.deps.sessionManager.refresh(); // single-flight; throws if dead
      response = await this.fetchOnce(path, options); // retry once with new token
    }
    return response;
  }

  // ── JSON convenience (business data handlers) ───────────────────

  /** GET a JSON resource through the refresh-aware path. */
  async getJson<T>(path: string): Promise<T> {
    return this.parse<T>(await this.authedFetch(path, { method: "GET" }));
  }

  /** POST JSON through the refresh-aware path. */
  async postJson<T>(path: string, body?: unknown): Promise<T> {
    return this.parse<T>(
      await this.authedFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    );
  }

  /** Throw ApiError(status, detail) on non-2xx; otherwise parse the JSON body. */
  async parse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new ApiError(response.status, await extractDetail(response));
    }
    // Some endpoints (204) may have no body.
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** Pull the FastAPI `detail` message from an error response, best-effort. */
export async function extractDetail(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (body && typeof body.detail === "string") {
      return body.detail;
    }
    return JSON.stringify(body);
  } catch {
    return `Request failed with status ${response.status}`;
  }
}
