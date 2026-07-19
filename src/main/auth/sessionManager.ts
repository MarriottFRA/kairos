/**
 * SessionManager — the heart of the sliding-session client.
 * -----------------------------------------------------------
 * The ONLY place that holds the access token and knows session state.
 *
 * Responsibilities:
 *   - Hold the access token IN MEMORY ONLY (never written to disk).
 *   - Track access-token age via the local clock and refresh PROACTIVELY a few
 *     minutes before the known 30-min TTL (the server remains the authority — a
 *     401 always wins).
 *   - SINGLE-FLIGHT refresh: concurrent callers share one in-flight /auth/refresh
 *     so the rotating refresh token is never rotated twice (which would trip
 *     server-side reuse detection and revoke the session).
 *   - PERSIST-BEFORE-DISCARD rotation: write the NEW refresh token to encrypted
 *     storage BEFORE swapping in the new access token, so a crash mid-rotation
 *     cannot strand the session.
 *   - COLD-START RESUME: on launch, silently refresh from the stored refresh
 *     token to restore the device-verified session (Level 2) — no prompts.
 *
 * Transport note: /auth/refresh is the one call that must NOT carry an
 * Authorization header — the refresh token itself is the credential.
 */

import { net } from "electron";
import { SecureStore } from "./secureStore";
import { DeviceIdentity } from "./deviceIdentity";
import { TpmBinding } from "./tpmBinding";

/** Access token TTL (server-defined). Used only to schedule proactive refresh. */
const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** Refresh this long before expiry to tolerate clock skew / latency. */
const PROACTIVE_REFRESH_BUFFER_MS = 3 * 60 * 1000; // T-3 min
/** Server idle window: refresh token dies 60 min after it was last used. */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** Server absolute cap: session dies 8 h after it was created. */
const ABSOLUTE_SESSION_MS = 8 * 60 * 60 * 1000;

/** Thrown when the session is dead and a full re-login (SSO) is required. */
export class SessionExpiredError extends Error {
  constructor(reason: string) {
    super(`Session expired: ${reason}`);
    this.name = "SessionExpiredError";
  }
}

interface RefreshResponse {
  access_token: string;
  token_type: string;
  refresh_token: string;
}

export interface SessionManagerDeps {
  secureStore: SecureStore;
  deviceIdentity: DeviceIdentity;
  tpmBinding: TpmBinding;
  baseUrl: string;
}

export class SessionManager {
  private accessToken: string | null = null;
  private securityLevel = 0;
  private tokenReceivedAt: number | null = null;

  private refreshInFlight: Promise<void> | null = null;
  private proactiveTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeAttempted = false;

  /** Set by AuthController to project status to the renderer. */
  onChange: (() => void) | null = null;
  /** Set by AuthController to notify the renderer that re-auth is required. */
  onExpired: (() => void) | null = null;

  constructor(private deps: SessionManagerDeps) {}

  // ── Read accessors ──────────────────────────────────────────────

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getSecurityLevel(): number {
    return this.securityLevel;
  }

  /** True once a refresh-backed (sid) session exists at Level 2+. */
  isActive(): boolean {
    return this.accessToken !== null && this.securityLevel >= 2;
  }

  /**
   * Fast, LOCAL check for whether a resume is worth attempting: a token exists
   * and it is not already provably dead by the idle / absolute windows. No
   * network — lets the UI decide, without the doomed round-trip, whether to
   * offer "Continue session". The server remains the authority for anything
   * still inside the windows.
   */
  async hasResumableSession(): Promise<boolean> {
    if (!(await this.deps.secureStore.hasStored())) {
      return false;
    }
    const { createdAt, lastUsedAt } = await this.deps.secureStore.getSessionMeta();
    const now = Date.now();
    if (lastUsedAt !== null && now - lastUsedAt > IDLE_TIMEOUT_MS) return false;
    if (createdAt !== null && now - createdAt > ABSOLUTE_SESSION_MS) return false;
    return true;
  }

  // ── State transitions ───────────────────────────────────────────

  /**
   * Store the Level-1 login token (no refresh token, no sid yet). This token
   * cannot be refreshed — it only carries the flow until /devices/verify.
   */
  setLoginToken(accessToken: string): void {
    this.cancelProactiveRefresh();
    this.accessToken = accessToken;
    this.securityLevel = 1;
    this.tokenReceivedAt = Date.now();
    this.notifyChange();
  }

  /**
   * Establish the real session from /devices/verify: swap to the sid-bearing
   * access token and persist the refresh token. Persist-before-discard: the
   * refresh token hits encrypted storage BEFORE we adopt the new access token.
   * Device verification is now the finish line — this grants full access (Level 2).
   */
  async establishSession(session: {
    accessToken: string;
    refreshToken: string;
    securityLevel: number;
  }): Promise<void> {
    const now = Date.now();
    await this.deps.secureStore.setRefreshToken(session.refreshToken);
    // Stamp session timing for the local expiry pre-check on next launch.
    await this.deps.secureStore.setSessionCreatedAt(now);
    await this.deps.secureStore.touchRefreshUsed(now);
    this.accessToken = session.accessToken;
    this.securityLevel = session.securityLevel;
    this.tokenReceivedAt = now;
    this.scheduleProactiveRefresh();
    this.notifyChange();
  }

  // ── Refresh (single-flight) ─────────────────────────────────────

  /**
   * Refresh the access token, rotating the refresh token. SINGLE-FLIGHT: all
   * concurrent callers await the same in-flight request.
   */
  refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    const storedRefreshToken = await this.deps.secureStore.getRefreshToken();
    if (!storedRefreshToken) {
      throw new SessionExpiredError("no stored refresh token");
    }

    const { deviceId, deviceSecret } =
      await this.deps.deviceIdentity.getCredentials();

    // TPM-bound devices must prove liveness on every rotation. `undefined` on a
    // device that never enrolled — the field is simply omitted.
    const signature = await this.deps.tpmBinding.signNonce(deviceId, "refresh");

    const post = (sig: string | undefined) =>
      net.fetch(`${this.deps.baseUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // NO Authorization header
        body: JSON.stringify({
          refresh_token: storedRefreshToken,
          device_id: deviceId,
          device_secret: deviceSecret,
          ...(sig ? { signature: sig } : {}),
        }),
      });

    let response = await post(signature);

    // A 401 on a SIGNED refresh is ambiguous: it may just be a stale or already
    // burned nonce. Nonces burn on failed attempts too, so recovery needs a new
    // one. Retry exactly once with a fresh challenge BEFORE concluding the
    // session is dead — otherwise a transient nonce problem logs the user out.
    if (response.status === 401 && signature) {
      const retrySignature = await this.deps.tpmBinding.signNonce(
        deviceId,
        "refresh",
        { force: true }
      );
      if (retrySignature) {
        response = await post(retrySignature);
      }
    }

    if (response.status === 401) {
      // Any 401 here = session is dead (idle/absolute cap/revoked/reuse/device).
      await this.clear();
      this.emitExpired();
      throw new SessionExpiredError("refresh rejected (401)");
    }

    if (!response.ok) {
      // Transient (network/5xx): keep the session; caller may retry later.
      throw new Error(`Refresh failed with status ${response.status}`);
    }

    const data = (await response.json()) as RefreshResponse;

    // Persist-before-discard: new refresh token to disk BEFORE adopting new access token.
    const now = Date.now();
    await this.deps.secureStore.setRefreshToken(data.refresh_token);
    await this.deps.secureStore.touchRefreshUsed(now); // resets the idle window
    this.accessToken = data.access_token;
    // A refresh-backed session is device-verified: full access (Level 2). The
    // server no longer returns security_level, so we set it here.
    this.securityLevel = 2;
    this.tokenReceivedAt = now;
    this.scheduleProactiveRefresh();
    this.notifyChange();
  }

  /**
   * Cold-start resume: attempt a silent refresh from the stored refresh token.
   * Runs at most once per launch. Restores the Level-2 session when the
   * session is still within the idle + 8h windows; a 401 clears everything.
   */
  async resume(): Promise<void> {
    if (this.resumeAttempted) {
      return;
    }
    this.resumeAttempted = true;

    const storedRefreshToken = await this.deps.secureStore.getRefreshToken();
    if (!storedRefreshToken) {
      this.notifyChange(); // nothing to resume -> unauthenticated
      return;
    }

    // Local pre-check: if the token is provably dead by the idle/absolute
    // windows, skip the doomed /auth/refresh call, drop the dead token, and
    // report unauthenticated immediately (no "restoring" round-trip).
    if (!(await this.hasResumableSession())) {
      await this.clear();
      return;
    }

    try {
      // Silent resume: a successful refresh restores full access (Level 2) with
      // no further prompts — device verification already happened on this machine.
      await this.refresh();
    } catch (error) {
      // On 401, refresh() already cleared + emitted expiry. On transient errors
      // we stay unauthenticated for this launch; the user can log in normally.
      if (!(error instanceof SessionExpiredError)) {
        console.warn("[SessionManager] Cold-start resume failed (transient):", error);
        this.notifyChange();
      }
    }
  }

  /**
   * Tear down the session: clear in-memory token and the persisted refresh token.
   */
  async clear(): Promise<void> {
    this.cancelProactiveRefresh();
    this.accessToken = null;
    this.securityLevel = 0;
    this.tokenReceivedAt = null;
    await this.deps.secureStore.clear();
    this.notifyChange();
  }

  // ── Proactive refresh timer ─────────────────────────────────────

  private scheduleProactiveRefresh(): void {
    this.cancelProactiveRefresh();
    if (this.tokenReceivedAt === null) {
      return;
    }
    const fireAt = this.tokenReceivedAt + ACCESS_TOKEN_TTL_MS - PROACTIVE_REFRESH_BUFFER_MS;
    const delay = Math.max(0, fireAt - Date.now());
    this.proactiveTimer = setTimeout(() => {
      // Fire-and-forget: a real failure surfaces on the next authed call / 401.
      void this.refresh().catch(() => {
        /* swallowed — proactive refresh is best-effort */
      });
    }, delay);
  }

  private cancelProactiveRefresh(): void {
    if (this.proactiveTimer) {
      clearTimeout(this.proactiveTimer);
      this.proactiveTimer = null;
    }
  }

  // ── Notifications ───────────────────────────────────────────────

  private notifyChange(): void {
    this.onChange?.();
  }

  private emitExpired(): void {
    this.onExpired?.();
  }
}
