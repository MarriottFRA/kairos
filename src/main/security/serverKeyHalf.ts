/**
 * ServerKeyHalf — retrieval of the device-bound half of the database key.
 * -----------------------------------------------------------
 * The server mints one random 32-byte half per device at registration and
 * releases it only to that authenticated device. It never rotates: it is an
 * identity-bound secret, not a rolling credential.
 *
 * There is deliberately NO local cache. The app already requires a server round
 * trip to sign in, so a second one costs nothing in availability — and skipping
 * the cache is what makes revocation immediate: stop releasing the half and the
 * database is unreadable on the very next launch.
 *
 * STATUS: the production path is not built yet. Development reads a fixed half
 * from `.env` so the storage layer can be finished and exercised ahead of the
 * API. The dev path is hard-blocked in packaged builds — see below.
 */

import { app } from "electron";
import { parseKeyHalf } from "./dbKeyMaterial";

/** .env variable holding a stand-in server half during development. */
const DEV_ENV_VAR = "KAIROS_DEV_SERVER_KEY_HALF";

/**
 * Fetch this device's server key half.
 *
 * @param deviceId The device_id the half is bound to (see DeviceIdentity).
 */
export async function fetchServerKeyHalf(deviceId: string): Promise<Buffer> {
  if (isDevKeyPermitted()) {
    const raw = process.env[DEV_ENV_VAR];
    if (!raw) {
      throw new Error(
        `${DEV_ENV_VAR} is not set. The secure database needs a server key half; ` +
          "generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` " +
          "and put it in .env (see .env.example)."
      );
    }

    console.warn(
      "[serverKeyHalf] DEVELOPMENT: using the fixed key half from .env — " +
        "not device-bound and not revocable."
    );
    return parseKeyHalf(raw, DEV_ENV_VAR);
  }

  // TODO(api): GET the device-bound half from the backend, authenticated with the
  // access token and device_secret, in the same manner as the other authenticated
  // calls in src/main/auth/apiClient.ts. On first call for an unregistered device
  // the server mints and stores the half; afterwards it returns the same value.
  //
  // Expected shape: { key_half: "<base64, 32 bytes>" } -> parseKeyHalf(...)
  //
  // A 403 here means the device was revoked. That must propagate as a hard
  // failure, NOT a fallback to any locally held value — no-cache is the entire
  // basis of immediate revocation.
  throw new Error(
    `Server key half retrieval is not implemented yet (device ${deviceId}). ` +
      "The secure database cannot be opened in a packaged build until the API endpoint exists."
  );
}

/**
 * Whether the .env stand-in may be used.
 *
 * Gated on the app being unpackaged, not on NODE_ENV. A packaged build must never
 * silently fall back to a shared, non-device-bound key just because an env var
 * happened to be present in the launch environment — that would quietly downgrade
 * every install to the same key half.
 */
function isDevKeyPermitted(): boolean {
  return !app.isPackaged;
}
