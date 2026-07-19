/**
 * Renderer auth client (thin facade over the main-process auth domain).
 * -----------------------------------------------------------
 * The renderer holds NO token and performs NO device/crypto work — all of that
 * now lives in the Node main process. This client:
 *   - delegates auth actions to window.authApi (login / verify / TOTP / logout);
 *   - keeps a CACHED projection of the public session status so that
 *     ProtectedRoute and other callers can read securityLevel synchronously;
 *   - exposes a few business reads (hotels / me / OU access) that route through
 *     the main-process authenticated transport via the `api` seam.
 *
 * The public method names match the previous renderer AuthService so existing
 * screens (login, device-verify, profile) keep working. Passwordless: identity
 * comes from the Microsoft broker token; there is no password or email-TOTP step.
 */

import api from "./api";
import { MS_BROKER_ERROR_PREFIX } from "../config";

/**
 * Classify an auth error: broker-gate failures carry a `MS_BROKER:<code>`
 * message; everything else is a normal app error (FastAPI `detail` text).
 * Returns the broker code (e.g. "no_principal") or null for an app error.
 */
export function brokerErrorCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.startsWith(MS_BROKER_ERROR_PREFIX)
    ? msg.slice(MS_BROKER_ERROR_PREFIX.length)
    : null;
}

/** User-facing copy for a broker-gate error code. */
export function describeBrokerError(code: string): string {
  switch (code) {
    case "domain_not_allowed":
      return "This Microsoft account isn't authorized for Kairos. Please sign in with your company account.";
    case "no_principal":
      return "Microsoft sign-in didn't complete. Please try again.";
    case "cancelled":
      return "Microsoft sign-in was cancelled.";
    case "timeout":
      return "Microsoft sign-in timed out. Please try again.";
    case "server_misconfigured":
    case "server_error":
    case "mint_failed":
    default:
      return "Microsoft sign-in is temporarily unavailable. Please try again.";
  }
}

// ── Public status projected from main (never contains a token) ──
export interface PublicAuthStatus {
  securityLevel: number; // 0 none, 1 login, 2 device-verified (full access)
  isActive: boolean;
  deviceId: string | null;
  devicePending: boolean;
  encryptionAvailable: boolean;
  lastUserEmail: string | null;
  tpmBound: boolean; // the server holds a hardware-sealed key for this device
}

// ── Domain types re-exported for consumers (unchanged shapes) ──
export interface AuthTokenResponse {
  access_token?: string;
  token_type?: string;
  settings: unknown;
}

export interface DeviceVerifyResponse {
  deviceId: string;
  securityLevel: number;
}

export interface UserInfo {
  email: string;
  id: number;
}

export interface OUAccess {
  id: number;
  user_id: number;
  ou: string;
  granted_by: number;
  granted_at: string;
  expires_at: string;
  access_level: string;
  is_active: boolean;
}

export interface Hotel {
  ou: string;
  hotel_name: string;
  room_count: number;
  currency?: string;
  country?: string;
  city?: string;
  local_id_1?: string;
  local_id_2?: string;
  local_id_3?: string;
}

export interface DeviceRegisterResponse {
  status: string;
  deviceId: string;
}

// ── Window augmentation for the typed auth bridge ──
import type { AuthApi, DeviceProgressEvent } from "../preload";
export type { DeviceProgressEvent };
declare global {
  interface Window {
    authApi?: AuthApi;
  }
}

const EMPTY_STATUS: PublicAuthStatus = {
  securityLevel: 0,
  isActive: false,
  deviceId: null,
  devicePending: false,
  encryptionAvailable: false,
  lastUserEmail: null,
  tpmBound: false,
};

class AuthClient {
  private status: PublicAuthStatus = { ...EMPTY_STATUS };
  private bootstrapped: Promise<void> | null = null;

  // Background cold-start resume state (drives the login "Continue session" UI).
  private resumable = false; // a token worth trying exists (fast local check)
  private resolving = false; // the background /auth/refresh is still in flight
  private resolved = false; // the resume attempt has completed

  private listeners = new Set<() => void>();

  constructor() {
    // Keep the cached status in sync with main-pushed changes (e.g. proactive
    // refresh level changes, session expiry).
    if (typeof window !== "undefined" && window.authApi) {
      window.authApi.onAuthStatusChanged((status) => {
        this.status = status;
        this.notify();
      });
    }
  }

  /** Subscribe to status/resume-state changes (for reactive components). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  /**
   * Load the initial status and kick off the cold-start resume in the
   * BACKGROUND (non-blocking). Returns as soon as the fast local checks are
   * done, so the app renders immediately (no splash). The actual /auth/refresh
   * resolves later and updates the cached status + notifies subscribers, which
   * drives the login page's "Continue session" affordance.
   */
  bootstrap(): Promise<void> {
    if (!this.bootstrapped) {
      this.bootstrapped = (async () => {
        try {
          if (!window.authApi) {
            this.resolved = true;
            return;
          }
          this.status = await window.authApi.getStatus(); // pure read, no network
          this.resumable = await window.authApi.hasResumableSession(); // fast, local

          if (this.resumable) {
            this.resolving = true;
            this.notify();
            // Fire the real resume without awaiting — the app renders now.
            window.authApi
              .resume()
              .then((status) => {
                this.status = status;
              })
              .catch((error) => {
                console.error("[auth] Background resume failed:", error);
              })
              .finally(() => {
                this.resolving = false;
                this.resolved = true;
                this.notify();
              });
          } else {
            this.resolved = true;
          }
        } catch (error) {
          console.error("[auth] Failed to bootstrap auth status:", error);
          this.resolved = true;
        } finally {
          this.notify();
        }
      })();
    }
    return this.bootstrapped;
  }

  /** True while the background resume is still checking the token. */
  isResolving(): boolean {
    return this.resolving;
  }

  /** True when a token worth resuming exists (fast local pre-check passed). */
  hasResumableSession(): boolean {
    return this.resumable;
  }

  /** True once the resume attempt has completed (success or failure). */
  isResumeResolved(): boolean {
    return this.resolved;
  }

  // ── Synchronous cached reads (used by route guards / UI) ──
  getSecurityLevel(): number {
    return this.status.securityLevel;
  }

  isAuthenticated(): boolean {
    // Device verification (Level 2) is the finish line — full access.
    return this.status.securityLevel >= 2;
  }

  getDeviceId(): string | null {
    return this.status.deviceId;
  }

  /** Remembered email from a previous login, for prefilling the login form. */
  getLastUserEmail(): string | null {
    return this.status.lastUserEmail;
  }

  getStatusSnapshot(): PublicAuthStatus {
    return this.status;
  }

  onSessionExpired(cb: () => void): void {
    window.authApi?.onSessionExpired(cb);
  }

  offSessionExpired(cb: () => void): void {
    window.authApi?.offSessionExpired(cb);
  }

  /** True when the server holds a hardware-sealed key for this device. */
  isTpmBound(): boolean {
    return this.status.tpmBound;
  }

  /** Per-step progress from the main-process device verify/register flows. */
  onDeviceProgress(cb: (event: DeviceProgressEvent) => void): void {
    window.authApi?.onDeviceProgress(cb);
  }

  offDeviceProgress(cb: (event: DeviceProgressEvent) => void): void {
    window.authApi?.offDeviceProgress(cb);
  }

  private setLevel(securityLevel: number): void {
    this.status = {
      ...this.status,
      securityLevel,
      isActive: securityLevel >= 2,
    };
    this.notify();
  }

  // ── Microsoft/Entra broker sign-in (identity gate) ──
  /**
   * Run the SWA/Microsoft sign-in and return the server-verified company email
   * (to show in a locked field). The broker token stays in main. `silent` avoids
   * showing the Microsoft window when the SWA cookie is expected to be valid.
   */
  async beginMicrosoftSignIn(silent = false): Promise<{ email: string }> {
    return this.requireAuthApi().beginMicrosoftSignIn({ silent });
  }

  /** Sign out of the SWA (switch-account). */
  async microsoftSignOut(): Promise<void> {
    await this.requireAuthApi().microsoftSignOut();
  }

  // ── Auth handshake (delegates to main; updates cached status from results) ──
  async login(email: string): Promise<AuthTokenResponse> {
    const result = await this.requireAuthApi().login({ email });
    this.setLevel(1);
    return { settings: (result as any)?.settings ?? null };
  }

  /**
   * `phase: "register"` marks the follow-up approval check that runs straight
   * after a registration, so main reports it on the register progress bar.
   */
  async verifyDevice(
    options: { phase?: "verify" | "register" } = {}
  ): Promise<DeviceVerifyResponse> {
    const result = await this.requireAuthApi().verifyDevice(options);
    this.setLevel(result.securityLevel);
    this.status = { ...this.status, deviceId: result.deviceId, devicePending: false };
    this.notify();
    return result;
  }

  /**
   * Request an account (passwordless): the broker token verifies identity. Used
   * both by the explicit Register screen and by the login screen when /auth/login
   * reports the user isn't registered yet.
   */
  async register(email: string): Promise<unknown> {
    return this.requireAuthApi().register({ email });
  }

  async registerDevice(): Promise<DeviceRegisterResponse> {
    const result = await this.requireAuthApi().registerDevice();
    this.status = { ...this.status, deviceId: result.deviceId, devicePending: true };
    this.notify();
    return result;
  }

  async logout(): Promise<void> {
    try {
      await this.requireAuthApi().logout();
    } finally {
      // Keep non-secret hints (encryption availability, remembered email) so the
      // next login can still prefill; only the session/level is cleared.
      this.status = {
        ...EMPTY_STATUS,
        encryptionAvailable: this.status.encryptionAvailable,
        lastUserEmail: this.status.lastUserEmail,
        deviceId: this.status.deviceId,
        // Hardware binding is a property of the machine, not the session.
        tpmBound: this.status.tpmBound,
      };
      // Signing out removes the on-disk token, so there's nothing to resume.
      this.resumable = false;
      this.resolving = false;
      this.resolved = true;
      this.notify();
    }
  }

  /** Local-only reset (main owns real teardown; kept for legacy call sites). */
  clearAuth(): void {
    this.setLevel(0);
  }

  // ── Business reads (routed through the main-process authed transport) ──
  async getCurrentUser(): Promise<UserInfo> {
    const response = await api.get("/auth/me");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to get user info");
    }
    return response.json();
  }

  async getUserOUAccess(): Promise<OUAccess[]> {
    const response = await api.get("/users/ou-access/my-access");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to get OU access");
    }
    return response.json();
  }

  async getHotels(): Promise<Hotel[]> {
    const response = await api.get("/hotels/");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to get hotels");
    }
    return response.json();
  }

  async refreshHotelsCache(): Promise<Hotel[]> {
    // No local hotel cache in the skeleton — just re-read live.
    return this.getHotels();
  }

  private requireAuthApi(): AuthApi {
    if (typeof window === "undefined" || !window.authApi) {
      throw new Error("Auth bridge unavailable");
    }
    return window.authApi;
  }
}

export default new AuthClient();
