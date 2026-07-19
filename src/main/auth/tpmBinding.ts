/**
 * TpmBinding — policy for the hardware-sealed device key.
 * -----------------------------------------------------------
 * Core rule: a device is TPM-bound IFF the server holds a public key for it.
 * The server decides whether a signature is required; this client can never opt
 * out, and can never hard-fail because a TPM step failed. Devices that never
 * enrolled keep working on device_secret alone.
 *
 * This module owns three things:
 *
 *  1. The nonce dance — /devices/challenge, sign, send. Nonces are single-use
 *     (burned on the first attempt, success or failure), expire in 120s, and are
 *     namespaced by purpose, so a challenge is always requested immediately
 *     before the call that consumes it, never in advance.
 *
 *  2. The local attempt record in user_settings, so a machine with no TPM is
 *     probed once and never again. Failures are classified: hardware problems
 *     and rejected signatures are permanent; network/server problems get a
 *     bounded number of retries across launches.
 *
 *  3. Binding an already-registered device (/devices/tpm/register).
 *
 * DEPENDENCIES: deliberately NOT ApiClient. /devices/challenge needs no auth and
 * /devices/tpm/register only needs a bearer, so taking a `getAccessToken` thunk
 * instead avoids the ApiClient -> SessionManager -> TpmBinding construction cycle.
 */

import { net } from "electron";
import * as db from "../../local_db";
import * as tpm from "../system/tpm";
import { TpmUnavailableError } from "../system/tpm";

/** user_settings key holding the local attempt record. */
const TPM_STATE_KEY = "tpmBinding";

/** Give up on transient failures after this many launches. */
const MAX_TRANSIENT_ATTEMPTS = 3;

/** /devices/challenge rate-limits the same device_id+purpose within 5s. */
const CHALLENGE_RETRY_DELAY_MS = 5500;

export type TpmPurpose = "enroll" | "verify" | "refresh";

export type TpmStatus =
  | "unknown" // never attempted, or attempted and worth retrying
  | "unsupported" // no usable TPM on this machine — permanent, never retried
  | "bound" // the server holds our public key
  | "failed"; // permanently given up (signature rejected, or retries exhausted)

export interface TpmState {
  status: TpmStatus;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

const INITIAL_STATE: TpmState = { status: "unknown", attempts: 0 };

export interface TpmBindingDeps {
  baseUrl: string;
  /** Bearer for /devices/tpm/register. Null before a session exists. */
  getAccessToken: () => string | null;
}

/** The enrollment pair — both fields or neither (the backend 422s on half). */
export interface TpmEnrollment {
  public_key: string;
  signature: string;
}

export class TpmBinding {
  private state: TpmState | null = null;

  constructor(private deps: TpmBindingDeps) {}

  // ── Local state ─────────────────────────────────────────────────

  async getState(): Promise<TpmState> {
    if (this.state) {
      return this.state;
    }
    try {
      const stored = await db.getUserSettings(TPM_STATE_KEY);
      // getUserSettings returns the PARSED value, or the string "null" if absent.
      if (stored && stored !== "null" && typeof stored === "object") {
        this.state = { ...INITIAL_STATE, ...(stored as unknown as TpmState) };
      } else {
        this.state = { ...INITIAL_STATE };
      }
    } catch {
      this.state = { ...INITIAL_STATE };
    }
    return this.state;
  }

  private async setState(patch: Partial<TpmState>): Promise<void> {
    const next: TpmState = {
      ...(await this.getState()),
      ...patch,
      lastAttemptAt: new Date().toISOString(),
    };
    this.state = next;
    try {
      await db.setUserSettings({ [TPM_STATE_KEY]: next });
    } catch (error) {
      // The in-memory copy still holds for this launch; we just lose the memo.
      console.warn("[TpmBinding] Failed to persist TPM state:", error);
    }
  }

  /** The server confirmed it holds our public key. */
  markBound(): Promise<void> {
    return this.setState({ status: "bound", lastError: undefined });
  }

  /** No usable TPM here. Permanent — this never changes without new hardware. */
  private markUnsupported(error: unknown): Promise<void> {
    console.warn("[TpmBinding] TPM unavailable, continuing without it:", error);
    return this.setState({
      status: "unsupported",
      lastError: (error as Error)?.message ?? String(error),
    });
  }

  /** Permanently give up (e.g. the server rejected our signature). */
  private markFailed(error: unknown): Promise<void> {
    console.warn("[TpmBinding] TPM binding permanently failed:", error);
    return this.setState({
      status: "failed",
      lastError: (error as Error)?.message ?? String(error),
    });
  }

  /** Network/server hiccup — retriable, but only so many times. */
  private async markTransient(error: unknown): Promise<void> {
    const { attempts } = await this.getState();
    const next = attempts + 1;
    console.warn(
      `[TpmBinding] TPM binding attempt ${next}/${MAX_TRANSIENT_ATTEMPTS} failed:`,
      error
    );
    await this.setState({
      status: next >= MAX_TRANSIENT_ATTEMPTS ? "failed" : "unknown",
      attempts: next,
      lastError: (error as Error)?.message ?? String(error),
    });
  }

  /** Record whichever kind of failure this was. */
  private recordFailure(error: unknown): Promise<void> {
    if (error instanceof TpmUnavailableError) {
      return this.markUnsupported(error);
    }
    if (error instanceof TpmRejectedError) {
      return this.markFailed(error);
    }
    return this.markTransient(error);
  }

  /** Is it worth spending round-trips trying to bind this device? */
  async shouldAttempt(): Promise<boolean> {
    const { status, attempts } = await this.getState();
    return status === "unknown" && attempts < MAX_TRANSIENT_ATTEMPTS;
  }

  /** Do we believe the server holds a key for us? Drives status projection. */
  async isBound(): Promise<boolean> {
    return (await this.getState()).status === "bound";
  }

  // ── Nonce + signing ─────────────────────────────────────────────

  /**
   * Fetch a one-time nonce. On 429 (another challenge issued for this
   * device_id+purpose within 5s) back off once and retry — never loop.
   */
  private async getChallenge(
    deviceId: string,
    purpose: TpmPurpose,
    allowRetry = true
  ): Promise<Buffer> {
    const response = await net.fetch(`${this.deps.baseUrl}/devices/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, purpose }),
    });

    if (response.status === 429 && allowRetry) {
      await delay(CHALLENGE_RETRY_DELAY_MS);
      return this.getChallenge(deviceId, purpose, false);
    }
    if (!response.ok) {
      throw new Error(`Challenge request failed (${response.status})`);
    }

    const data = (await response.json()) as { nonce?: string };
    if (!data.nonce) {
      throw new Error("Challenge response contained no nonce");
    }
    return Buffer.from(data.nonce, "base64");
  }

  /**
   * Create the sealed key (if needed) and sign a fresh enroll nonce.
   *
   * Returns `undefined` on ANY failure — after recording it — so the caller can
   * spread it into a request body and get nothing, with no branching:
   *
   *     { ...request, ...(await enrollmentPayload(id) ?? {}) }
   */
  async enrollmentPayload(deviceId: string): Promise<TpmEnrollment | undefined> {
    try {
      // Creates the key on first call; a no-TPM machine throws here.
      const publicKeyDer = tpm.exportPublicKeyDer(deviceId);
      // Requested immediately before use — the nonce lives 120s and burns once.
      const nonce = await this.getChallenge(deviceId, "enroll");
      return {
        public_key: publicKeyDer.toString("base64"),
        signature: tpm.sign(deviceId, nonce).toString("base64"),
      };
    } catch (error) {
      await this.recordFailure(error);
      return undefined;
    }
  }

  /**
   * Sign a fresh nonce for a gated call. Returns `undefined` when this machine
   * has nothing to sign with, so the field is simply omitted and the server
   * falls back to device_secret alone.
   *
   * `force` probes the hardware even when local state says we are not bound —
   * used on a 401 retry, where the server evidently disagrees with our record
   * (e.g. the local DB was reset but the sealed key survived).
   */
  async signNonce(
    deviceId: string,
    purpose: TpmPurpose,
    options: { force?: boolean } = {}
  ): Promise<string | undefined> {
    try {
      const { status } = await this.getState();
      // Avoid touching NCrypt at all on machines we already know can't sign.
      if (!options.force && status !== "bound") {
        return undefined;
      }
      if (status === "unsupported") {
        return undefined;
      }
      if (!tpm.hasKey(deviceId)) {
        return undefined;
      }
      const nonce = await this.getChallenge(deviceId, purpose);
      return tpm.sign(deviceId, nonce).toString("base64");
    } catch (error) {
      // A gated call must never fail because we couldn't produce a signature —
      // the server will reject it if a signature was genuinely required.
      console.warn(`[TpmBinding] Could not sign ${purpose} nonce:`, error);
      return undefined;
    }
  }

  // ── Binding an existing device ──────────────────────────────────

  /**
   * Bind a key to a device that is already registered (endpoint 3).
   *
   * Auth depends on the device's server-side status: a `pending` device needs
   * tier 1, an `approved` one needs a tier-2 token bound to this device. We only
   * ever call this straight after a successful /devices/verify, so the session
   * satisfies both cases.
   *
   * Returns true when the device ends up bound. NEVER throws — a failure here
   * only means the device stays on device_secret-only auth.
   */
  async bindExisting(deviceId: string, deviceSecret: string): Promise<boolean> {
    try {
      const enrollment = await this.enrollmentPayload(deviceId);
      if (!enrollment) {
        return false; // already recorded by enrollmentPayload
      }

      const token = this.deps.getAccessToken();
      const response = await net.fetch(`${this.deps.baseUrl}/devices/tpm/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          device_id: deviceId,
          device_secret: deviceSecret,
          ...enrollment,
        }),
      });

      if (response.ok) {
        await this.markBound();
        return true;
      }
      // 409 = a key is already bound to this device. That IS the desired end
      // state — our local record was just stale.
      if (response.status === 409) {
        await this.markBound();
        return true;
      }
      // 401 (bad secret/signature), 403 (tier or wrong-device session) and
      // 404 (unknown device) will not fix themselves by retrying.
      if ([401, 403, 404].includes(response.status)) {
        await this.markFailed(
          new Error(`tpm/register rejected (${response.status})`)
        );
        return false;
      }
      // 400 (stale nonce) / 5xx / anything else: worth another launch.
      await this.markTransient(
        new Error(`tpm/register failed (${response.status})`)
      );
      return false;
    } catch (error) {
      await this.recordFailure(error);
      return false;
    }
  }

  /** Classify a rejected-signature response from a caller-owned request. */
  async recordServerRejection(reason: string): Promise<void> {
    await this.markFailed(new TpmRejectedError(reason));
  }

  /** Classify a transient failure from a caller-owned request. */
  async recordTransient(reason: string): Promise<void> {
    await this.markTransient(new Error(reason));
  }

  /** Record that this machine cannot do TPM at all (probe result). */
  async recordUnsupported(reason: string): Promise<void> {
    await this.markUnsupported(new TpmUnavailableError(reason));
  }
}

/** The server refused our signature — permanent, not worth retrying. */
export class TpmRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TpmRejectedError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
