/**
 * AuthController — orchestrates the 3-step auth handshake and owns the public
 * status projected to the renderer. This is the only auth surface the IPC layer
 * (and therefore the renderer) can reach; it never returns a token.
 *
 * Ported from the former renderer AuthService (src/services/auth.ts). Request
 * shapes are preserved so the deployed backend and existing devices keep working.
 */

import os from "os";
import { app } from "electron";
import * as db from "../../local_db";
import { SessionManager } from "./sessionManager";
import { DeviceIdentity } from "./deviceIdentity";
import { SecureStore } from "./secureStore";
import { ApiClient, ApiError, extractDetail } from "./apiClient";
import { MsBroker, BrokerError } from "./msBroker";
import { gatherHardwareInfo } from "../system/hardwareInfo";

/** user_settings key holding the last-used login email (not a secret). */
const LAST_USER_EMAIL_KEY = "last_user_email";

/**
 * Re-mint the broker token when the held one is older than this. The token lives
 * ~5 min; refreshing at 4 min keeps a safety margin (plus ≤30s server skew).
 */
const BROKER_TOKEN_MAX_AGE_MS = 4 * 60 * 1000;

/** Decode the `email` claim from a broker JWT — DISPLAY / form-fill only, never a
 *  trust decision (FastAPI re-verifies the token and uses its own email). */
function decodeJwtEmail(token: string): string {
  try {
    const payload = token.split(".")[1];
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Token-free session status pushed to / polled by the renderer. */
export interface PublicAuthStatus {
  securityLevel: number; // 0 none, 1 login, 2 device-verified (full access)
  isActive: boolean; // refresh-backed session at Level 2+
  deviceId: string | null;
  devicePending: boolean; // device awaiting admin approval
  encryptionAvailable: boolean; // safeStorage/DPAPI usable -> resume across restarts
  lastUserEmail: string | null; // remembered for login prefill (not a secret)
}

/** Sentinels the renderer routes branch on (kept identical to the old flow). */
export const DEVICE_NOT_REGISTERED = "DEVICE_NOT_REGISTERED";
export const DEVICE_SECRET_INVALID = "DEVICE_SECRET_INVALID";

export interface AuthControllerDeps {
  sessionManager: SessionManager;
  deviceIdentity: DeviceIdentity;
  secureStore: SecureStore;
  apiClient: ApiClient;
  msBroker: MsBroker;
  sendToRenderer: (channel: string, payload?: unknown) => void;
}

export class AuthController {
  private deviceId: string | null = null;
  private devicePending = false;
  private lastUserEmail: string | null = null;

  /**
   * Transient Microsoft handshake state: the freshly minted broker JWT + the
   * verified email. Held IN MEMORY ONLY for the brief login/register handshake,
   * never persisted, never sent to the renderer. Cleared once consumed.
   */
  private msSession: { token: string; email: string; mintedAt: number } | null =
    null;

  constructor(private deps: AuthControllerDeps) {}

  /**
   * Wire session notifications to the renderer and preload the device id +
   * remembered email. Call once after app `ready` (and after DB init).
   */
  async init(): Promise<void> {
    this.deps.sessionManager.onChange = () => this.pushStatus();
    this.deps.sessionManager.onExpired = () =>
      this.deps.sendToRenderer("auth:session-expired");
    this.deviceId = await this.deps.deviceIdentity.getDeviceId();
    this.lastUserEmail = await this.loadLastUserEmail();
  }

  private async loadLastUserEmail(): Promise<string | null> {
    try {
      const raw = await db.getUserSettings(LAST_USER_EMAIL_KEY);
      return raw && raw !== "null" ? (raw as string) : null;
    } catch {
      return null;
    }
  }

  // ── Microsoft/Entra broker sign-in (identity gate) ──────────────

  /**
   * Open the SWA auth window, mint a broker token, and exchange it at
   * /auth/ms-exchange for the SERVER-VERIFIED company email. The token is held
   * transiently in main (never returned); the renderer only gets `{ email }` to
   * show in a locked field. `silent` skips showing the Microsoft window (used for
   * on-demand re-mints when the SWA cookie is expected to still be valid).
   */
  async beginMicrosoftSignIn(
    options: { silent?: boolean } = {}
  ): Promise<{ email: string }> {
    const token = await this.deps.msBroker.mintToken({ silent: options.silent });
    const email = await this.exchangeForEmail(token);
    this.msSession = { token, email, mintedAt: Date.now() };
    return { email };
  }

  /** Sign out of the SWA (switch-account) and drop any held handshake state. */
  async microsoftSignOut(): Promise<{ success: true }> {
    this.msSession = null;
    await this.deps.msBroker.signOut();
    return { success: true };
  }

  /** POST the broker token to /auth/ms-exchange; return the verified email. */
  private async exchangeForEmail(token: string): Promise<string> {
    const response = await this.deps.apiClient.rawFetch("/auth/ms-exchange", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      await this.throwFromResponse(response);
    }
    const data = await response.json();
    return typeof data.email === "string" ? data.email : decodeJwtEmail(token);
  }

  /**
   * Return a fresh broker JWT for an entrance call, re-minting if the held token
   * is stale/absent. Keeps `msSession.email` in sync with the token's email.
   *
   * NOTE: one broker token is currently reused across the entrance calls
   * (ms-exchange + login, and login -> auto-register on "not registered"). The
   * backend does not yet enforce single-use/jti replay protection. If that is
   * turned on later, each call will need a freshly minted token — mint per call
   * here instead of reusing the cached one within BROKER_TOKEN_MAX_AGE_MS.
   */
  private async ensureFreshBrokerToken(silent: boolean): Promise<string> {
    if (
      this.msSession &&
      Date.now() - this.msSession.mintedAt < BROKER_TOKEN_MAX_AGE_MS
    ) {
      return this.msSession.token;
    }
    const token = await this.deps.msBroker.mintToken({ silent });
    this.msSession = { token, email: decodeJwtEmail(token), mintedAt: Date.now() };
    return token;
  }

  /**
   * Throw the right error type from a failed entrance response: a `BrokerError`
   * (message `MS_BROKER:<code>`) for the broker `{error}` shape, or a plain
   * `Error(detail)` for the normal app `{detail}` shape — so the renderer can branch.
   */
  private async throwFromResponse(response: Response): Promise<never> {
    let body: { error?: string; detail?: string } | null = null;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    if (body && typeof body.error === "string") {
      throw new BrokerError(body.error);
    }
    if (body && typeof body.detail === "string") {
      throw new Error(body.detail);
    }
    throw new Error(text || `Request failed with status ${response.status}`);
  }

  // ── Account signup (broker-gated) ───────────────────────────────

  async register(_clientEmail: string): Promise<unknown> {
    // Identity comes from the verified broker token, NOT the client-supplied email.
    // Passwordless: no password field — the broker token is the credential.
    const token = await this.ensureFreshBrokerToken(false);
    const email = this.msSession?.email || decodeJwtEmail(token);

    const response = await this.deps.apiClient.rawFetch("/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      await this.throwFromResponse(response);
    }
    return response.json();
  }

  // ── Step 1: Login (Level 1) ─────────────────────────────────────

  async login(_clientEmail: string): Promise<{ settings: unknown }> {
    // Passwordless: identity comes entirely from the verified broker token. The
    // request carries the Bearer token only — no body. FastAPI reads the email
    // from the token itself.
    const token = await this.ensureFreshBrokerToken(false);
    const email = this.msSession?.email || decodeJwtEmail(token);

    const response = await this.deps.apiClient.rawFetch("/auth/login", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      // BrokerError (bad/expired token, wrong domain) vs app error (not a
      // registered user / pending approval) — thrown as distinguishable types.
      // The renderer branches on the app-error detail string.
      await this.throwFromResponse(response);
    }

    const data = await response.json(); // { access_token, token_type, settings }
    this.devicePending = false;
    this.deps.sessionManager.setLoginToken(data.access_token);
    this.msSession = null; // one-time handshake consumed

    // Remember the email for prefill on next launch (not a secret). Persisted
    // best-effort; the local SQLite DB already lives under the user's Documents.
    this.lastUserEmail = email;
    db.setUserSettings({ [LAST_USER_EMAIL_KEY]: email }).catch(() => {
      /* non-fatal */
    });

    return { settings: data.settings ?? null };
  }

  // ── Step 2: Device verify (Level 1 -> 2, mints the session — the finish line) ─────

  async verifyDevice(): Promise<{ deviceId: string; securityLevel: number }> {
    const { deviceId, deviceSecret } =
      await this.deps.deviceIdentity.getCredentials();

    const response = await this.deps.apiClient.fetchOnce("/devices/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, device_secret: deviceSecret }),
    });

    if (!response.ok) {
      const detail = await extractDetail(response);
      if (response.status === 404 || detail.toLowerCase().includes("not found")) {
        throw new Error(DEVICE_NOT_REGISTERED); // -> renderer triggers registration
      }
      if (response.status === 401) {
        throw new Error(DEVICE_SECRET_INVALID); // hardware changed -> re-register
      }
      if (response.status === 403) {
        this.devicePending = true;
        this.pushStatus();
        throw new Error(detail || "Device pending approval");
      }
      throw new Error(detail || "Device verification failed");
    }

    const data = await response.json();
    // CRITICAL: adopt the NEW sid-bearing token and persist the refresh token.
    // Device verification is the finish line: full access at Level 2. The server
    // no longer returns security_level, so we set it explicitly.
    await this.deps.sessionManager.establishSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      securityLevel: 2,
    });
    this.devicePending = false;
    return { deviceId, securityLevel: this.deps.sessionManager.getSecurityLevel() };
  }

  // ── First-run: register device (stays pending until admin approval) ──

  async registerDevice(): Promise<{ status: string; deviceId: string }> {
    const { deviceId } = await this.deps.deviceIdentity.getCredentials();
    const deviceSecret = await this.deps.deviceIdentity.getDeviceSecret();

    const [hw, permanentSalt, userEmail] = await Promise.all([
      gatherHardwareInfo(),
      this.getPermanentSaltSafe(),
      this.getCurrentUserEmailSafe(),
    ]);

    const hostname = hw.hostname || "localhost";
    const username = hw.username || "Unknown User";
    const osVersion = `${os.type()} ${os.release()}`; // e.g. "Windows_NT 10.0.26100"

    const hardwareInfo = {
      machine_id: hw.machineId || "UNKNOWN",
      processor_id: hw.cpuInfo.model || "UNKNOWN",
      bios_serial: hw.biosSerial || "UNKNOWN",
      motherboard_serial: hw.motherboardSerial || "UNKNOWN",
      disk_serial: hw.diskSerial || "UNKNOWN",
    };

    const deviceInfo = {
      device_name: `${userEmail} | ${hostname} | ${username} | ${osVersion}`,
      os_version: osVersion,
      hostname,
      user_agent: `PSLoader/${app.getVersion()} Electron/${process.versions.electron}`,
      username,
      details: `${userEmail}, ${hostname}, ${username}, Salt:${permanentSalt.substring(0, 8)}...`,
    };

    const response = await this.deps.apiClient.fetchOnce("/devices/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: deviceId,
        device_secret: deviceSecret,
        hardware_info: hardwareInfo,
        device_info: deviceInfo,
      }),
    });

    if (!response.ok) {
      throw new Error(await extractDetail(response));
    }

    const data = await response.json(); // { message, device_id, approval_status/status }
    this.devicePending = true;
    this.pushStatus();
    return { status: data.approval_status ?? data.status ?? "pending", deviceId };
  }

  // ── Logout ──────────────────────────────────────────────────────

  async logout(): Promise<{ success: true }> {
    try {
      await this.deps.apiClient.fetchOnce("/auth/logout", { method: "POST" });
    } catch (error) {
      // Best-effort server revoke; we clear locally regardless.
      console.warn("[AuthController] Logout request failed:", error);
    }
    this.devicePending = false;
    await this.deps.sessionManager.clear();
    return { success: true };
  }

  // ── Status / resume ─────────────────────────────────────────────

  /** Pure read of the current status. Does NOT trigger a resume. */
  getStatus(): PublicAuthStatus {
    return this.buildStatus();
  }

  /**
   * Fast local check (no network) for whether a "Continue session" option
   * should be offered — a token exists and isn't already provably expired.
   */
  hasResumableSession(): Promise<boolean> {
    return this.deps.sessionManager.hasResumableSession();
  }

  /** Attempt the (background) cold-start resume, then return resolved status. */
  async resume(): Promise<PublicAuthStatus> {
    await this.deps.sessionManager.resume();
    return this.buildStatus();
  }

  private buildStatus(): PublicAuthStatus {
    return {
      securityLevel: this.deps.sessionManager.getSecurityLevel(),
      isActive: this.deps.sessionManager.isActive(),
      deviceId: this.deviceId,
      devicePending: this.devicePending,
      encryptionAvailable: this.deps.secureStore.isAvailable(),
      lastUserEmail: this.lastUserEmail,
    };
  }

  private pushStatus(): void {
    this.deps.sendToRenderer("auth:status-changed", this.buildStatus());
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async getPermanentSaltSafe(): Promise<string> {
    try {
      // Reuse the same permanent salt used in device_secret derivation.
      const { getPermanentSalt } = await import("../../local_db");
      return await getPermanentSalt();
    } catch {
      return "UNKNOWN";
    }
  }

  private async getCurrentUserEmailSafe(): Promise<string> {
    try {
      const response = await this.deps.apiClient.fetchOnce("/auth/me", {
        method: "GET",
      });
      if (!response.ok) {
        return "Unknown";
      }
      const user = await response.json();
      return user.email ?? "Unknown";
    } catch {
      return "Unknown";
    }
  }
}

export { ApiError };
