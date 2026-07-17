/**
 * Renderer API seam.
 * -----------------------------------------------------------
 * The renderer holds NO token and never calls the network directly. Every
 * business request is forwarded over IPC to the main-process ApiClient
 * (`data:fetch`), which attaches the Bearer token and transparently refreshes
 * on 401. Main returns { ok, status, body }; we reconstruct a real `Response`
 * so the existing per-endpoint error handling in each service keeps working
 * unchanged.
 *
 * Only endpoints on the main-process allowlist (src/ipc/handlers/data.ts) are
 * permitted — this is not an open passthrough.
 */

interface MainFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

// Statuses that must not carry a response body when reconstructing a Response.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

class ApiService {
  /**
   * Fetch-compatible wrapper. Returns a real `Response` reconstructed from the
   * main-process result. Rejects (like `fetch`) if the transport itself fails.
   */
  async fetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    if (typeof window === "undefined" || !window.ipcApi) {
      throw new Error("IPC bridge unavailable");
    }

    const method = (options.method || "GET").toUpperCase();
    const body =
      options.body === undefined || options.body === null
        ? undefined
        : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);

    const envelope: any = await window.ipcApi.sendIpcRequest("data:fetch", {
      method,
      path: endpoint,
      body,
    });

    // Preload returns the { success, data, ... } envelope; data is the result.
    const result: MainFetchResult = envelope?.data ?? envelope;
    const responseBody = NULL_BODY_STATUSES.has(result.status)
      ? null
      : result.body ?? "";

    return new Response(responseBody, { status: result.status });
  }

  /** Convenience method for GET requests. */
  async get(endpoint: string, options: RequestInit = {}): Promise<Response> {
    return this.fetch(endpoint, { ...options, method: "GET" });
  }

  /** Convenience method for POST requests. */
  async post(
    endpoint: string,
    body?: any,
    options: RequestInit = {}
  ): Promise<Response> {
    return this.fetch(endpoint, {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json", ...options.headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
}

export default new ApiService();
