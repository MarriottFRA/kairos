/**
 * Business Data IPC Handler
 * -----------------------------------------------------------
 * A SINGLE authenticated transport for business API calls, routed through the
 * main-process ApiClient (so the access token, refresh-on-401, single-flight
 * refresh and rotation all stay in main — the renderer never holds a token).
 *
 * This is NOT a generic passthrough: every request is validated against an
 * explicit ALLOWLIST of {method, path} patterns below. The renderer cannot reach
 * an arbitrary host or path — only these pre-approved business endpoints on the
 * configured base URL. Adding an endpoint = adding one allowlist row.
 *
 * The handler returns { ok, status, body } (raw text) so the renderer's api.ts
 * can reconstruct a real Response and the existing per-endpoint error handling
 * in each service keeps working unchanged.
 */

import { IpcHandler } from "../types";
import { ApiClient } from "../../main/auth/apiClient";

export const DATA_FETCH_CHANNEL = "data:fetch";

interface DataFetchRequest {
  method?: string;
  path: string; // path (may include a query string), e.g. "/hotels/" or "/act-bud-fcst-data/?ou=A01"
  body?: string; // pre-serialised JSON string, or undefined
}

interface DataFetchResponse {
  ok: boolean;
  status: number;
  body: string; // raw response text (may be empty)
}

/**
 * Explicit allowlist of permitted business endpoints. Patterns match the URL
 * PATHNAME only (query string is ignored for matching). Keep in sync with the
 * renderer services under src/services/.
 */
const ALLOWLIST: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  // Hotels + import groups
  { method: "GET", pattern: /^\/hotels\/$/ },
  { method: "GET", pattern: /^\/hotels\/[^/]+\/import_groups$/ },
  // Financial (actuals/budget/forecast) data
  { method: "GET", pattern: /^\/act-bud-fcst-data\/$/ },
  { method: "GET", pattern: /^\/act-bud-fcst-data\/versions\/$/ },
  { method: "POST", pattern: /^\/act-bud-fcst-data\/owner-budget$/ },
  // Submitted data
  { method: "POST", pattern: /^\/submitted-data\/bulk$/ },
  // Mapping configs + mappings
  { method: "GET", pattern: /^\/mappings\/configs\/[^/]+$/ },
  { method: "PATCH", pattern: /^\/mappings\/configs\/[^/]+$/ },
  { method: "GET", pattern: /^\/mappings\/configs\/[^/]+\/mappings$/ },
  { method: "POST", pattern: /^\/mappings\/configs\/[^/]+\/mappings$/ },
  { method: "GET", pattern: /^\/mappings\/mappings\/pending$/ },
  { method: "POST", pattern: /^\/mappings\/mappings\/[^/]+\/approve$/ },
  // Mapping tables (account/department maps + combos)
  { method: "GET", pattern: /^\/mapping-tables\/(version|data|combos)$/ },
  // Validations + overrides
  { method: "GET", pattern: /^\/validations\/ou\/[^/]+$/ },
  { method: "POST", pattern: /^\/validation-override\/request$/ },
  { method: "GET", pattern: /^\/validation-override\/status\/.+$/ },
  // Upload periods + submission windows
  { method: "GET", pattern: /^\/upload-periods\/$/ },
  { method: "GET", pattern: /^\/submission-windows\/$/ },
  // User context
  { method: "GET", pattern: /^\/users\/ou-access\/my-access$/ },
  { method: "GET", pattern: /^\/auth\/me$/ },
];

function isAllowed(method: string, path: string): boolean {
  const pathname = path.split("?")[0];
  return ALLOWLIST.some(
    (entry) => entry.method === method && entry.pattern.test(pathname)
  );
}

export function createDataHandlers(apiClient: ApiClient): Record<string, IpcHandler> {
  const dataFetch: IpcHandler<DataFetchRequest, DataFetchResponse> = async (
    _event,
    request
  ) => {
    const method = (request?.method || "GET").toUpperCase();
    const path = request?.path;

    if (!path || !isAllowed(method, path)) {
      throw new Error(`Endpoint not allowed: ${method} ${path}`);
    }

    const init: RequestInit = { method };
    if (request.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = request.body;
    }

    // authedFetch attaches the Bearer token and refreshes+retries once on 401.
    const response = await apiClient.authedFetch(path, init);
    const body = await response.text();

    return { ok: response.ok, status: response.status, body };
  };

  return {
    [DATA_FETCH_CHANNEL]: dataFetch,
  };
}
