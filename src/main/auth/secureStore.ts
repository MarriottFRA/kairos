/**
 * SecureStore — encrypted-at-rest storage for the refresh token.
 * -----------------------------------------------------------
 * Uses Electron `safeStorage` (DPAPI on Windows) to encrypt the refresh token,
 * then persists the ciphertext (base64) in the existing libsql `user_settings`
 * table via the shared local_db helpers.
 *
 * Invariants:
 *   - Only ciphertext ever touches disk — never the plaintext refresh token.
 *   - safeStorage requires the app to be `ready`; construct/use this only after
 *     `app.on('ready')`.
 *   - The access token and device_secret are NEVER stored here (access token is
 *     memory-only; device_secret is re-derived from hardware each launch).
 */

import { safeStorage } from "electron";
import * as db from "../../local_db";

/** user_settings key holding the base64 DPAPI ciphertext of the refresh token. */
const REFRESH_TOKEN_KEY = "refresh_token_enc";
/** Non-secret session timing metadata, used for the local expiry pre-check. */
const SESSION_CREATED_AT_KEY = "session_created_at";
const REFRESH_LAST_USED_AT_KEY = "refresh_last_used_at";

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value && value !== "null") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class SecureStore {
  /**
   * Whether OS-level encryption (DPAPI) is available. Must be true to persist
   * the refresh token. When false we run in "no-resume" mode: the session works
   * for the current run but cannot survive a restart (we refuse to write
   * plaintext secrets to disk).
   */
  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Encrypt and persist the refresh token. No-op (with warning) when encryption
   * is unavailable — callers should treat that as "session won't survive restart".
   */
  async setRefreshToken(refreshToken: string): Promise<void> {
    if (!this.isAvailable()) {
      console.warn(
        "[SecureStore] Encryption unavailable — refresh token NOT persisted (no cold-start resume)."
      );
      return;
    }
    const ciphertext = safeStorage.encryptString(refreshToken); // Buffer (DPAPI)
    const base64 = ciphertext.toString("base64");
    await db.setUserSettings({ [REFRESH_TOKEN_KEY]: base64 });
  }

  /**
   * Read and decrypt the persisted refresh token, or null if none/undecryptable.
   */
  async getRefreshToken(): Promise<string | null> {
    if (!this.isAvailable()) {
      return null;
    }
    try {
      // getUserSettings(key) returns the parsed value, or the string "null" when absent.
      const raw = await db.getUserSettings(REFRESH_TOKEN_KEY);
      if (!raw || raw === "null") {
        return null;
      }
      const ciphertext = Buffer.from(raw as string, "base64");
      return safeStorage.decryptString(ciphertext);
    } catch (error) {
      // Ciphertext unreadable (e.g. different OS user / corrupted) — treat as no token.
      console.warn("[SecureStore] Failed to decrypt stored refresh token:", error);
      return null;
    }
  }

  /** True if an encrypted refresh token is present on disk (no decryption). */
  async hasStored(): Promise<boolean> {
    try {
      const raw = await db.getUserSettings(REFRESH_TOKEN_KEY);
      return !!raw && raw !== "null";
    } catch {
      return false;
    }
  }

  /** Record when the session was created (at /devices/verify). */
  async setSessionCreatedAt(ts: number): Promise<void> {
    try {
      await db.setUserSettings({ [SESSION_CREATED_AT_KEY]: ts });
    } catch {
      /* non-fatal */
    }
  }

  /** Record when the refresh token was last used (resets the idle window). */
  async touchRefreshUsed(ts: number): Promise<void> {
    try {
      await db.setUserSettings({ [REFRESH_LAST_USED_AT_KEY]: ts });
    } catch {
      /* non-fatal */
    }
  }

  /** Read the session timing metadata (nulls if absent). */
  async getSessionMeta(): Promise<{
    createdAt: number | null;
    lastUsedAt: number | null;
  }> {
    try {
      const [created, used] = await Promise.all([
        db.getUserSettings(SESSION_CREATED_AT_KEY),
        db.getUserSettings(REFRESH_LAST_USED_AT_KEY),
      ]);
      return { createdAt: toNumber(created), lastUsedAt: toNumber(used) };
    } catch {
      return { createdAt: null, lastUsedAt: null };
    }
  }

  /**
   * Remove the persisted refresh token + timing metadata (logout / death).
   */
  async clear(): Promise<void> {
    try {
      await Promise.all([
        db.deleteUserSetting(REFRESH_TOKEN_KEY),
        db.deleteUserSetting(SESSION_CREATED_AT_KEY),
        db.deleteUserSetting(REFRESH_LAST_USED_AT_KEY),
      ]);
    } catch (error) {
      console.warn("[SecureStore] Failed to clear refresh token:", error);
    }
  }
}
