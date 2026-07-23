/**
 * DbKeyMaterial — split-key provisioning for the encrypted feature database.
 * -----------------------------------------------------------
 * The SQLite key is never derived directly from the two halves. Instead:
 *
 *   local half   (32 random bytes, DPAPI-wrapped, this Windows user + machine)
 *   server half  (32 random bytes, minted per device, held by the API)
 *        |
 *        +--> HKDF-SHA256 --> KEK --> AES-256-GCM unwraps --> DB key --> PRAGMA key
 *
 * This is envelope encryption, and the indirection earns its keep: the DB key is
 * minted once and never changes, so re-provisioning a device or reissuing either
 * half only re-wraps a 32-byte blob. Deriving `PRAGMA key` straight from the two
 * halves would instead force a full `PRAGMA rekey` — a whole-file rewrite — every
 * time either half changed, with the database left in an unknown state if that
 * rewrite were interrupted.
 *
 * Threat model. Both halves are required, and neither is sufficient:
 *   - Database file alone (stolen laptop, backup, file share): useless.
 *   - File + local half (attacker running as this Windows user): still useless
 *     without the server half, which is only released to an authenticated device.
 *   - Revocation: refuse to release the server half and the data is unreadable on
 *     the next launch. There is no local cache, so this takes effect immediately.
 *
 * What it does NOT defend against: an attacker running code as this Windows user
 * *while the user is signed in*, who can read the assembled key from process
 * memory exactly as we do.
 */

import { safeStorage } from "electron";
import crypto from "crypto";
import { readRawSetting, writeRawSetting } from "../../local_db";

/** user_settings key: base64 DPAPI blob wrapping the local key half. */
const LOCAL_HALF_ENC_KEY = "secureDbLocalHalfEnc";
/** user_settings key: base64 AES-GCM blob wrapping the database key. */
const WRAPPED_DB_KEY = "secureDbKeyWrapped";

/** Every piece of key material here is 32 bytes. */
export const KEY_BYTES = 32;

/** Domain separation for the KEK derivation. Bump the suffix if the scheme changes. */
const HKDF_INFO = "kairos:secure-db:kek:v1";
/**
 * Fixed HKDF salt. A random per-install salt would buy nothing here: both inputs
 * are already full-entropy random keys, not passwords, so there is no dictionary
 * to defend against — and a salt is one more thing that could be lost.
 */
const HKDF_SALT = "kairos:secure-db:salt:v1";

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

//------------------------------------------------------------------------------
//--- LOCAL HALF ---------------------------------------------------------------

/**
 * Fetch this machine's local key half, minting one on first run.
 *
 * Stored as a DPAPI blob, which binds it to this Windows user on this machine:
 * copying the database *and* the settings DB to another box still yields nothing.
 */
export function getOrCreateLocalKeyHalf(): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    // Without DPAPI there is nowhere safe to put the local half. Writing it in
    // plaintext beside the database would make this half decorative, so refuse
    // rather than pretend. In practice this only trips on a broken Windows
    // profile or an unsupported platform.
    throw new Error(
      "OS encryption (safeStorage/DPAPI) unavailable — refusing to store the local key half unprotected"
    );
  }

  const stored = readRawSetting(LOCAL_HALF_ENC_KEY);
  if (stored) {
    try {
      return Buffer.from(safeStorage.decryptString(Buffer.from(stored, "base64")), "base64");
    } catch (error) {
      // Almost always a lost Windows profile or a credential reset. The local
      // half is gone, and with it the database — but we must NOT mint a
      // replacement here, because that would silently orphan readable data and
      // present as "empty database" rather than as a fault. Fail loudly; the
      // deliberate recovery path is resetSecureDatabase().
      throw new Error(
        `Local key half is present but undecryptable (${(error as Error).message}) — ` +
          "the encrypted database cannot be opened; a reset is required to start clean"
      );
    }
  }

  const half = crypto.randomBytes(KEY_BYTES);
  writeRawSetting(
    LOCAL_HALF_ENC_KEY,
    safeStorage.encryptString(half.toString("base64")).toString("base64")
  );
  return half;
}

//------------------------------------------------------------------------------
//--- KEK + ENVELOPE -----------------------------------------------------------

/** Combine the two halves into a key-encryption key. */
function deriveKek(localHalf: Buffer, serverHalf: Buffer): Buffer {
  assertKeyLength(localHalf, "local key half");
  assertKeyLength(serverHalf, "server key half");

  // Concatenation is safe as HKDF input material because both halves are
  // fixed-length, so there is no ambiguity about where one ends and the next
  // begins.
  const ikm = Buffer.concat([localHalf, serverHalf]);
  return Buffer.from(crypto.hkdfSync("sha256", ikm, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

/** Wrap the database key under the KEK. Output is base64 of iv || tag || ciphertext. */
function wrapDbKey(kek: Buffer, dbKey: Buffer): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dbKey), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/**
 * Unwrap the database key. Throws if either half is wrong — GCM is authenticated,
 * so a bad KEK fails the tag check rather than yielding a plausible-looking key.
 */
function unwrapDbKey(kek: Buffer, blob: string): Buffer {
  const raw = Buffer.from(blob, "base64");
  if (raw.length <= GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error("wrapped database key is truncated");
  }

  const iv = raw.subarray(0, GCM_IV_BYTES);
  const tag = raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);

  const decipher = crypto.createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

//------------------------------------------------------------------------------
//--- PUBLIC API ---------------------------------------------------------------

/**
 * Resolve the database key for `PRAGMA key`, minting and wrapping one on first run.
 *
 * Returns hex, which is handed to SQLite3MultipleCiphers as a passphrase.
 *
 * IMPORTANT: an unwrap failure throws and never destroys data. A wrong server
 * half — a stale API response, a device re-registered against the wrong record,
 * a bad .env value in development — is indistinguishable here from real
 * corruption, and deleting the database on that signal would turn a recoverable
 * server-side mistake into permanent data loss. Destruction happens only when a
 * caller explicitly asks for it.
 */
export function resolveDbKey(serverHalf: Buffer): string {
  const localHalf = getOrCreateLocalKeyHalf();
  const kek = deriveKek(localHalf, serverHalf);

  const wrapped = readRawSetting(WRAPPED_DB_KEY);
  if (wrapped) {
    try {
      return unwrapDbKey(kek, wrapped).toString("hex");
    } catch (error) {
      throw new Error(
        `Database key could not be unwrapped (${(error as Error).message}) — ` +
          "the server key half does not match the one this database was provisioned with. " +
          "Data has been left untouched."
      );
    }
  }

  const dbKey = crypto.randomBytes(KEY_BYTES);
  writeRawSetting(WRAPPED_DB_KEY, wrapDbKey(kek, dbKey));
  return dbKey.toString("hex");
}

/** Forget the wrapped database key. The local half survives — see resetSecureDatabase(). */
export function clearWrappedDbKey(): void {
  writeRawSetting(WRAPPED_DB_KEY, "");
}

/** Parse 32 bytes of key material supplied as hex or base64. */
export function parseKeyHalf(value: string, label: string): Buffer {
  const trimmed = value.trim();

  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  assertKeyLength(buffer, label);
  return buffer;
}

function assertKeyLength(buffer: Buffer, label: string): void {
  if (buffer.length !== KEY_BYTES) {
    throw new Error(
      `${label} must be ${KEY_BYTES} bytes (64 hex chars or 44 base64 chars), got ${buffer.length}`
    );
  }
}
