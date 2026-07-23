/**
 * ServerKeyHalf — retrieval of the device-bound half of the database key.
 * -----------------------------------------------------------
 * The server mints one random 32-byte half per device at registration and
 * releases it only to that authenticated device via `GET /devices/key-half`. It
 * never rotates: it is an identity-bound secret, not a rolling credential.
 *
 * The device is resolved server-side from the session token's `sid`, never from
 * a client-supplied id — the request carries no device id at all, so one device
 * can never ask for another's half.
 *
 * There is deliberately NO local cache. The app already requires a server round
 * trip to sign in, so a second one costs nothing in availability — and skipping
 * the cache is what makes revocation immediate: a revoked device gets a 403 and
 * the database is unreadable on the very next launch, with no stale copy to fall
 * back on. A 403 is therefore a hard failure here, never a fallback.
 */

import { parseKeyHalf } from "./dbKeyMaterial";

/** Endpoint that mints (on first call) and returns this device's server half. */
const KEY_HALF_PATH = "/devices/key-half";

/**
 * Minimal transport surface this module needs: an authenticated GET that runs a
 * single-flight refresh on 401. `ApiClient` satisfies this structurally; typing
 * against the narrow shape keeps `security/` from depending on `auth/`.
 */
export interface KeyHalfTransport {
  authedFetch(path: string, options?: RequestInit): Promise<Response>;
}

/**
 * The server refused the half because the device is revoked or not yet approved
 * (HTTP 403). This MUST NOT be recovered from a local value: no-cache is the
 * entire basis of immediate revocation.
 */
export class ServerKeyHalfRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerKeyHalfRevokedError";
  }
}

/**
 * Fetch this device's server key half.
 *
 * Requires a device-verified (tier-2) session: the endpoint is gated on the
 * session and identifies the device from the token itself, so `deviceId` is used
 * only for diagnostics — it is never sent in the request.
 *
 * The returned value is secret key material and is never logged.
 */
export async function fetchServerKeyHalf(
  transport: KeyHalfTransport,
  deviceId: string
): Promise<Buffer> {
  const response = await transport.authedFetch(KEY_HALF_PATH, { method: "GET" });

  if (response.status === 403) {
    // Revoked or awaiting approval. Hard failure — never fall back to a cache.
    throw new ServerKeyHalfRevokedError(
      `Server refused the database key half for device ${deviceId} (403) — the ` +
        "device is revoked or pending approval; the secure database stays locked."
    );
  }

  if (!response.ok) {
    throw new Error(
      `Server key half request failed for device ${deviceId} (HTTP ${response.status}).`
    );
  }

  const data = (await response.json()) as { key_half?: unknown };
  if (typeof data.key_half !== "string") {
    throw new Error(
      `Server key half response for device ${deviceId} is missing the ` +
        "`key_half` field."
    );
  }

  // parseKeyHalf enforces exactly 32 bytes (base64/hex) before it reaches the KEK.
  return parseKeyHalf(data.key_half, "server key half");
}
