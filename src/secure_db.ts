import { app, safeStorage } from "electron";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import Database from "better-sqlite3-multiple-ciphers";
import { readRawSetting, writeRawSetting } from "./local_db";

// Kairos secure store: the encrypted-at-rest database for feature data.
//
// Driver: `better-sqlite3-multiple-ciphers` — the same native module that backs
// the plaintext settings database (local_db.ts), here opened with a key. Page
// level encryption uses ChaCha20-Poly1305, which is authenticated (tampering
// with the file is detected, not silently decrypted into garbage).
//
// Key handling is the part that actually matters. The key is 32 random bytes
// minted on first run, never derived from anything guessable and never present
// in the source, the bundle, or .env. At rest it lives as a DPAPI blob (Electron
// safeStorage) in the *unencrypted* settings DB, which binds it to this Windows
// user on this machine: copying kairos_secure.db to another box yields nothing.
//
// Threat model, stated plainly: this defends against the database file being
// lifted off the machine — backup, stolen laptop, someone browsing the Documents
// folder. It does NOT defend against an attacker already running code as this
// Windows user, who can simply ask DPAPI to unwrap the key exactly as we do.
//
// NOTE: the two databases are separate files with separate connections, so you
// cannot ATTACH or JOIN across the settings DB and this one. Keep the boundary
// clean: settings and auth state on one side, feature data on the other.

/** user_settings key holding the base64 DPAPI-wrapped database key. */
const SECURE_DB_KEY_ENC = "secureDbKeyEnc";

const documentsPath = app.getPath("documents");
const kairosFolderPath = path.join(documentsPath, "Kairos");
const securePath = path.join(kairosFolderPath, "kairos_secure.db");

// Baseline schema version for the encrypted database, tracked independently of
// the settings DB.
const CURRENT_SCHEMA_VERSION = 1;

type SecureDb = InstanceType<typeof Database>;

let db: SecureDb | null = null;

//------------------------------------------------------------------------------
//--- KEY PROVISIONING ---------------------------------------------------------

/**
 * Fetch the database key, minting and persisting one on first run.
 *
 * Returns the key as a hex string; it is handed to SQLite3MultipleCiphers as a
 * passphrase, so the cipher's KDF runs over it once per connection open.
 */
function getOrCreateDbKey(): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Without DPAPI we have nowhere safe to put the key. Storing it in plaintext
    // beside the database would make the encryption decorative, so refuse
    // instead of pretending. In practice this only trips on a broken Windows
    // profile or an unsupported platform.
    throw new Error(
      "OS encryption (safeStorage/DPAPI) unavailable — refusing to open the secure database with an unprotectable key"
    );
  }

  const stored = readRawSetting(SECURE_DB_KEY_ENC);
  if (stored) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch (error) {
      // The wrapped key is unreadable — almost always a lost Windows profile or
      // credential reset. The encrypted data is now permanently unrecoverable;
      // no key exists anywhere else by design.
      //
      // Unlike the device salt (whose value must never change), this database
      // holds re-syncable feature data, so the recoverable move is to discard it
      // and start clean rather than block the launch forever.
      console.error(
        "[secure_db] Wrapped database key is undecryptable — discarding the encrypted database and re-keying:",
        error
      );
      destroySecureDatabaseFiles();
    }
  }

  const newKey = crypto.randomBytes(32).toString("hex");
  writeRawSetting(SECURE_DB_KEY_ENC, safeStorage.encryptString(newKey).toString("base64"));
  return newKey;
}

/** Remove the encrypted database and its WAL sidecars from disk. */
function destroySecureDatabaseFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = securePath + suffix;
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch (error) {
      console.warn(`[secure_db] Failed to remove ${target}:`, error);
    }
  }
}

//------------------------------------------------------------------------------
//--- CONNECTION ---------------------------------------------------------------

/**
 * Open the encrypted database, creating it on first use.
 *
 * Idempotent — later calls return the existing connection.
 */
export function initializeSecureDatabase(): SecureDb {
  if (db) return db;

  if (!fs.existsSync(kairosFolderPath)) {
    fs.mkdirSync(kairosFolderPath, { recursive: true });
  }

  const key = getOrCreateDbKey();
  const handle = new Database(securePath);

  // Cipher must be selected BEFORE the key: `key` runs the KDF for whichever
  // scheme is active. ChaCha20-Poly1305 is already the default, but pinning it
  // means a future upstream default change cannot orphan existing files.
  handle.pragma("cipher='chacha20'");
  handle.pragma(`key='${key}'`);

  // Force a read of the schema. On a wrong or corrupt key this throws
  // SQLITE_NOTADB here rather than at some arbitrary later query.
  try {
    handle.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    handle.close();
    throw new Error(
      `Secure database could not be decrypted with the stored key: ${(error as Error).message}`
    );
  }

  handle.pragma("journal_mode = WAL");
  handle.pragma("synchronous = NORMAL");
  handle.pragma("foreign_keys = ON");
  // Memory-mapped I/O is incompatible with page-level encryption — mmap would
  // hand out raw ciphertext pages. Explicitly off so no future tuning re-enables
  // it by accident.
  handle.pragma("mmap_size = 0");
  // Keep spill files for large sorts/joins in RAM. The main file and its WAL are
  // encrypted, but temp b-trees are the one place SQLite can otherwise put row
  // data on disk outside that protection.
  handle.pragma("temp_store = MEMORY");

  db = handle;
  createSchema(handle);
  return handle;
}

/** Accessor for the open connection; opens it on first use. */
export function secureDb(): SecureDb {
  return db ?? initializeSecureDatabase();
}

/** Close the connection — call on app quit so WAL is checkpointed cleanly. */
export function closeSecureDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

//------------------------------------------------------------------------------
//--- SCHEMA -------------------------------------------------------------------

function createSchema(handle: SecureDb): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_info (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  handle
    .prepare(`
      INSERT INTO schema_info (key, value, updated_at)
      VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(String(CURRENT_SCHEMA_VERSION));

  // Feature tables go here as they land.
}

//------------------------------------------------------------------------------
//--- MAINTENANCE --------------------------------------------------------------

/**
 * Drop the encrypted database and its key, then rebuild both from scratch.
 *
 * For sign-out / "forget this device" style flows, and the recovery path when
 * the data is known to be unusable.
 */
export function resetSecureDatabase(): void {
  closeSecureDatabase();
  destroySecureDatabaseFiles();
  writeRawSetting(SECURE_DB_KEY_ENC, "");
  initializeSecureDatabase();
}
