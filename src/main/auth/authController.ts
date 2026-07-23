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
import { TpmBinding, TpmState } from "./tpmBinding";
import { EmitDeviceProgress, DeviceProgressPhase } from "./deviceProgress";
import { gatherHardwareInfo } from "../system/hardwareInfo";
import {
  unlockSecureDatabase,
  lockSecureDatabase,
  isSecureDatabaseUnlocked,
} from "../../secure_db";
import { fetchServerKeyHalf } from "../security/serverKeyHalf";

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
  tpmBound: boolean; // the server holds a hardware-sealed key for this device
}

/** Sentinels the renderer routes branch on (kept identical to the old flow). */
export const DEVICE_NOT_REGISTERED = "DEVICE_NOT_REGISTERED";
export const DEVICE_SECRET_INVALID = "DEVICE_SECRET_INVALID";
/**
 * The server holds a sealed key we can no longer satisfy (TPM cleared, firmware
 * reset). There is deliberately no unbind endpoint, so re-registering will NOT
 * fix this — the device must be deleted server-side first. The screen shows an
 * admin-contact message rather than silently looping through registration.
 */
export const DEVICE_TPM_MISMATCH = "DEVICE_TPM_MISMATCH";

export interface AuthControllerDeps {
  sessionManager: SessionManager;
  deviceIdentity: DeviceIdentity;
  secureStore: SecureStore;
  apiClient: ApiClient;
  msBroker: MsBroker;
  tpmBinding: TpmBinding;
  emitProgress: EmitDeviceProgress;
  sendToRenderer: (channel: string, payload?: unknown) => void;
}

/** Short note shown under a TPM step, derived from the local attempt record. */
function tpmDetail(state: TpmState): string {
  switch (state.status) {
    case "unsupported":
      return "Not available";
    case "bound":
      return "Hardware-bound";
    case "failed":
      return "Unavailable";
    default:
      return "Skipped";
  }
}

export class AuthController {
  private deviceId: string | null = null;
  private devicePending = false;
  private lastUserEmail: string | null = null;
  /** Cached projection of TpmBinding state (buildStatus is synchronous). */
  private tpmBound = false;

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
    this.tpmBound = await this.deps.tpmBinding.isBound();
  }

  /** Re-read the TPM record into the cached status and push it to the renderer. */
  private async syncTpmStatus(): Promise<void> {
    const bound = await this.deps.tpmBinding.isBound();
    if (bound !== this.tpmBound) {
      this.tpmBound = bound;
      this.pushStatus();
    }
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
    // best-effort; the local SQLite DB already lives in the app's data dir.
    this.lastUserEmail = email;
    db.setUserSettings({ [LAST_USER_EMAIL_KEY]: email }).catch(() => {
      /* non-fatal */
    });

    return { settings: data.settings ?? null };
  }

  // ── Step 2: Device verify (Level 1 -> 2, mints the session — the finish line) ─────

  /**
   * `phase: "register"` marks this as the follow-up approval check that runs
   * straight after a registration. It reports into the register bar's single
   * `check` notch instead of restarting the verify bar, and skips the binding
   * step (registration already attempted enrollment inline).
   */
  async verifyDevice(
    options: { phase?: DeviceProgressPhase } = {}
  ): Promise<{ deviceId: string; securityLevel: number }> {
    const asRegisterCheck = options.phase === "register";
    const emit: EmitDeviceProgress = asRegisterCheck
      ? () => undefined
      : this.deps.emitProgress;

    if (asRegisterCheck) {
      this.deps.emitProgress("register", "check", "active");
    }
    try {
      const result = await this.runVerify(emit, { bind: !asRegisterCheck });
      if (asRegisterCheck) {
        this.deps.emitProgress("register", "check", "done", "Approved");
      }
      return result;
    } catch (error) {
      if (asRegisterCheck) {
        this.deps.emitProgress("register", "check", "failed");
      }
      throw error;
    }
  }

  private async runVerify(
    emit: EmitDeviceProgress,
    options: { bind: boolean }
  ): Promise<{ deviceId: string; securityLevel: number }> {
    emit("verify", "identify", "active");
    const { deviceId, deviceSecret } =
      await this.deps.deviceIdentity.getCredentials();
    emit("verify", "identify", "done");

    // ── Sign a verify nonce, if this device has a sealed key ──
    emit("verify", "sign", "active");
    const signature = await this.deps.tpmBinding.signNonce(deviceId, "verify");
    if (signature) {
      emit("verify", "sign", "done", "Signed");
    } else {
      emit("verify", "sign", "skipped", tpmDetail(await this.deps.tpmBinding.getState()));
    }

    emit("verify", "validate", "active");
    const post = (sig: string | undefined) =>
      this.deps.apiClient.fetchOnce("/devices/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: deviceId,
          device_secret: deviceSecret,
          ...(sig ? { signature: sig } : {}),
        }),
      });

    let response = await post(signature);

    // Nonces burn on failed attempts, so a 401 may just mean the nonce was
    // stale or already consumed. Retry ONCE with a fresh challenge before
    // concluding anything — otherwise a transient blip triggers a spurious
    // re-registration. If we sent no signature but the server rejected us, try
    // once WITH one anyway: the local record may have been lost while the sealed
    // key survived (e.g. the SQLite DB was reset).
    if (response.status === 401) {
      const retrySignature = await this.deps.tpmBinding.signNonce(
        deviceId,
        "verify",
        { force: true }
      );
      if (retrySignature) {
        response = await post(retrySignature);
      }
    }

    if (!response.ok) {
      const detail = await extractDetail(response);
      emit("verify", "validate", "failed");

      if (response.status === 404 || detail.toLowerCase().includes("not found")) {
        throw new Error(DEVICE_NOT_REGISTERED); // -> renderer triggers registration
      }
      if (response.status === 401) {
        // Deliberately keyed on the FIRST attempt's signature, not the retry:
        // that one is only sent when we believe the server holds our key. The
        // forced retry above is a speculative recovery, and its failure proves
        // nothing about binding — treating it as a mismatch would strand a
        // device whose secret simply changed behind an admin-contact screen.
        if (signature) {
          // We proved possession of a sealed key and were still refused. There
          // is no unbind endpoint, so re-registering cannot recover this.
          await this.deps.tpmBinding.recordServerRejection(
            "verify rejected a TPM signature"
          );
          await this.syncTpmStatus();
          throw new Error(DEVICE_TPM_MISMATCH);
        }
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
    emit("verify", "validate", "done");

    // CRITICAL: adopt the NEW sid-bearing token and persist the refresh token.
    // Device verification is the finish line: full access at Level 2. The server
    // no longer returns security_level, so we set it explicitly.
    await this.deps.sessionManager.establishSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      securityLevel: 2,
    });
    this.devicePending = false;

    // ── Adopt a sealed key, now that we hold a tier-2 token for this device ──
    if (options.bind) {
      await this.bindIfNeeded(emit, deviceId, deviceSecret);
    }

    // ── Unlock the encrypted feature database for this session ──
    await this.unlockSecureDbSafe(deviceId);

    emit("verify", "secure", "done");
    return { deviceId, securityLevel: this.deps.sessionManager.getSecurityLevel() };
  }

  /**
   * Bind a sealed key to an already-approved device. /devices/tpm/register needs
   * a tier-2 token bound to THIS device, so this can only run after a successful
   * verify. Best-effort throughout: binding only hardens an already-working
   * session, so nothing here may throw.
   */
  private async bindIfNeeded(
    emit: EmitDeviceProgress,
    deviceId: string,
    deviceSecret: string
  ): Promise<void> {
    emit("verify", "bind", "active");

    if (await this.deps.tpmBinding.isBound()) {
      emit("verify", "bind", "done", "Hardware-bound");
      return;
    }
    if (!(await this.deps.tpmBinding.shouldAttempt())) {
      // Already known to be impossible here — no round-trips wasted.
      const state = await this.deps.tpmBinding.getState();
      emit("verify", "bind", "skipped", tpmDetail(state));
      return;
    }

    const bound = await this.deps.tpmBinding.bindExisting(deviceId, deviceSecret);
    await this.syncTpmStatus();
    if (bound) {
      emit("verify", "bind", "done", "Hardware-bound");
    } else {
      const state = await this.deps.tpmBinding.getState();
      emit(
        "verify",
        "bind",
        state.status === "unsupported" ? "skipped" : "failed",
        tpmDetail(state)
      );
    }
  }

  // ── First-run: register device (stays pending until admin approval) ──

  async registerDevice(): Promise<{ status: string; deviceId: string }> {
    const emit = this.deps.emitProgress;

    emit("register", "identify", "active");
    const { deviceId } = await this.deps.deviceIdentity.getCredentials();
    const deviceSecret = await this.deps.deviceIdentity.getDeviceSecret();
    emit("register", "identify", "done");

    emit("register", "profile", "active");
    const [hw, permanentSalt, userEmail] = await Promise.all([
      gatherHardwareInfo(),
      this.getPermanentSaltSafe(),
      this.getCurrentUserEmailSafe(),
    ]);
    emit("register", "profile", "done");

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
      // Prefix with the app name so admins can tell Kairos device registrations
      // apart from other tools that authenticate against the same backend.
      device_name: `Kairos | ${userEmail} | ${hostname} | ${username} | ${osVersion}`,
      os_version: osVersion,
      hostname,
      user_agent: `Kairos/${app.getVersion()} Electron/${process.versions.electron}`,
      username,
      details: `Kairos, ${userEmail}, ${hostname}, ${username}, Salt:${permanentSalt.substring(0, 8)}...`,
    };

    // ── Create the sealed key and sign an enroll nonce (register + bind in one) ──
    emit("register", "sign", "active");
    const enrollment = await this.deps.tpmBinding.enrollmentPayload(deviceId);
    if (enrollment) {
      emit("register", "sign", "done", "Key created");
    } else {
      emit("register", "sign", "skipped", tpmDetail(await this.deps.tpmBinding.getState()));
    }

    emit("register", "submit", "active");
    const post = (withTpm: boolean) =>
      this.deps.apiClient.fetchOnce("/devices/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: deviceId,
          device_secret: deviceSecret,
          hardware_info: hardwareInfo,
          device_info: deviceInfo,
          ...(withTpm && enrollment ? enrollment : {}),
        }),
      });

    let response = await post(true);

    // A rejection of the OPTIONAL binding is not a registration failure — the
    // device is registered either way, just unbound. Re-post without the TPM
    // fields (registration is idempotent for the same secret) so the user still
    // reaches the pending screen, and let the post-verify bind step retry later.
    if (enrollment && !response.ok && [400, 401, 403, 409].includes(response.status)) {
      await this.classifyRegisterBindFailure(response.status);
      emit(
        "register",
        "sign",
        response.status === 409 ? "done" : "failed",
        response.status === 409 ? "Already bound" : "Binding deferred"
      );
      response = await post(false);
    }

    if (!response.ok) {
      emit("register", "submit", "failed");
      throw new Error(await extractDetail(response));
    }

    // { message, device_id, approval_status/status, tpm_enrolled }
    const data = await response.json();
    if (data.tpm_enrolled) {
      await this.deps.tpmBinding.markBound();
    }
    await this.syncTpmStatus();
    emit("register", "submit", "done");

    this.devicePending = true;
    this.pushStatus();
    return { status: data.approval_status ?? data.status ?? "pending", deviceId };
  }

  /** Record why an inline binding at /devices/register was refused. */
  private async classifyRegisterBindFailure(status: number): Promise<void> {
    if (status === 409) {
      // A key is already bound to this device — the desired end state.
      await this.deps.tpmBinding.markBound();
      return;
    }
    if (status === 401) {
      // Signature verification failed; retrying will not change that.
      await this.deps.tpmBinding.recordServerRejection(
        "register rejected the enrollment signature"
      );
      return;
    }
    if (status === 403) {
      // "Already approved — use /devices/tpm/register instead". Leave the record
      // retriable so the post-verify bind step picks it up on the correct endpoint.
      return;
    }
    // 400: bad or expired nonce. Worth another launch.
    await this.deps.tpmBinding.recordTransient("register rejected the enroll nonce");
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
    lockSecureDatabase();
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
    // A resumed Level-2 session is as good as a fresh verify for the encrypted
    // store — without this, feature data would stay locked until the next full
    // device verification.
    if (
      this.deps.sessionManager.getSecurityLevel() >= 2 &&
      this.deps.sessionManager.isActive() &&
      this.deviceId
    ) {
      await this.unlockSecureDbSafe(this.deviceId);
    }
    return this.buildStatus();
  }

  /**
   * Best-effort unlock of the encrypted feature database. Failure here must
   * never fail auth — the session is still valid, feature pages just see
   * SECURE_DB_LOCKED until the next successful unlock.
   */
  private async unlockSecureDbSafe(deviceId: string): Promise<void> {
    if (isSecureDatabaseUnlocked()) return;
    try {
      const serverHalf = await fetchServerKeyHalf(this.deps.apiClient, deviceId);
      unlockSecureDatabase(serverHalf);
      console.info("[AuthController] Secure database unlocked");
    } catch (error) {
      console.warn(
        "[AuthController] Secure database unlock failed — feature data unavailable this session:",
        error
      );
    }
  }

  private buildStatus(): PublicAuthStatus {
    return {
      securityLevel: this.deps.sessionManager.getSecurityLevel(),
      isActive: this.deps.sessionManager.isActive(),
      deviceId: this.deviceId,
      devicePending: this.devicePending,
      encryptionAvailable: this.deps.secureStore.isAvailable(),
      lastUserEmail: this.lastUserEmail,
      tpmBound: this.tpmBound,
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
