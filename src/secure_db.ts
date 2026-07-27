import { app } from "electron";
import fs from "fs";
import Database from "better-sqlite3-multiple-ciphers";
import { clearWrappedDbKey, resolveDbKey } from "./main/security/dbKeyMaterial";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_VALUE_TABLES_SQL,
  applyValueStoreV12,
} from "./main/positions/schema";
import { MANUAL_INPUT_TABLES_SQL } from "./main/manualInput/schema";
import { SECURE_DB_PATH, ensureDataDir } from "./main/paths";

// Kairos secure store: the encrypted-at-rest database for feature data.
//
// Driver: `better-sqlite3-multiple-ciphers` — the same native module that backs
// the plaintext settings database (local_db.ts), here opened with a key. Page
// level encryption uses ChaCha20-Poly1305, which is authenticated (tampering
// with the file is detected, not silently decrypted into garbage).
//
// Key handling lives in main/security/dbKeyMaterial.ts. In short: the database
// key is 32 random bytes wrapped under a KEK derived from two halves — one held
// locally as a DPAPI blob, one released by the server per device. Both are
// required, so the database file is inert without an authenticated session.
//
// LIFECYCLE. This database is session-scoped, unlike the settings DB which is
// open for the whole run. It cannot be opened until sign-in has produced the
// server key half, so:
//
//     sign in  -> unlockSecureDatabase(serverHalf)  -> secureDb() works
//     sign out -> lockSecureDatabase()              -> secureDb() throws
//
// secureDb() deliberately does NOT open on demand. An implicit open is
// impossible here anyway (there is no key to open with), and throwing makes a
// "read the DB before login" bug obvious instead of intermittent.
//
// NOTE: the two databases are separate files with separate connections, so you
// cannot ATTACH or JOIN across the settings DB and this one. Keep the boundary
// clean: settings and auth state on one side, feature data on the other.

const securePath = SECURE_DB_PATH;

// Schema versioning for the encrypted database, tracked independently of the
// settings DB.
//
// v1 is the BASELINE: the entire feature schema in its final shape, created in
// one shot by createSchema(). Pre-launch, the former stepwise migrations 1–11
// (positions value store; the lineage/active/hourly_rate/vacation-cost/cluster
// column churn on positions; manual_input_rows and its hours→stats reshaping;
// per-row account overrides on component_values; the persisted engine output
// tables) were squashed into this baseline — there are no upgraded stores in
// the wild whose stepwise path had to be preserved, so the accumulated history
// was collapsed into the final-state DDL constants it produced.
//
// FROM LAUNCH ON, schema changes are APPEND-ONLY entries in MIGRATIONS below
// (v2, v3, …): a new numbered step that ALTERs/creates and is stamped as it
// lands. Never edit or renumber a shipped migration — the runner only executes
// versions ABOVE a database's stored number, so an edited body silently never
// re-runs (exactly the drift that motivated this squash). When the list grows
// unwieldy again and every live store is known to be at/above some floor, it
// can be squashed back to a fresh baseline the same way.
//
// Migrations for this store can only ever run inside createSchema() — that is
// the one moment the file is decryptable (post-unlock). Each step runs in its
// own transaction and stamps its version as it lands.
const CURRENT_SCHEMA_VERSION = 2;

type SecureDb = InstanceType<typeof Database>;

let db: SecureDb | null = null;

// Retained ONLY to power the dev-mode key reveal below; dropped on lock.
let unlockedKeyHex: string | null = null;

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
 * Call once sign-in has yielded the device's server key half. Idempotent — later
 * calls return the existing connection without re-deriving the key.
 *
 * @param serverHalf 32 bytes released by the API for this device.
 */
export function unlockSecureDatabase(serverHalf: Buffer): SecureDb {
  if (db) return db;

  ensureDataDir();

  const key = resolveDbKey(serverHalf);
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
  unlockedKeyHex = key;
  createSchema(handle);
  return handle;
}

/**
 * TEMP / DEV ONLY: reveal the derived database key so the developer can open
 * kairos_secure.db in an external SQLite tool for review. Hard-blocked in
 * packaged builds (same gate as the dev server key half) — this must never
 * ship as a way to extract a production key.
 */
export function revealSecureDbKeyForDev(): { keyHex: string; cipher: string } {
  if (app.isPackaged) {
    throw new Error("Key reveal is not available in packaged builds");
  }
  if (!db || !unlockedKeyHex) {
    throw new Error("Secure database is locked — sign in first");
  }
  return { keyHex: unlockedKeyHex, cipher: "chacha20" };
}

/**
 * Accessor for the open connection.
 *
 * Throws when the database is locked — see the lifecycle note at the top of this
 * file. There is no on-demand open because there is no key available outside a
 * signed-in session.
 */
export function secureDb(): SecureDb {
  if (!db) {
    throw new Error(
      "Secure database is locked — unlockSecureDatabase() must run after sign-in before feature data is available"
    );
  }
  return db;
}

/** Whether the secure database is currently unlocked. */
export function isSecureDatabaseUnlocked(): boolean {
  return db !== null;
}

/**
 * DESTRUCTIVE: drop every table in the encrypted store and recreate the schema
 * from the current v1 baseline. Wipes all encrypted feature data (positions,
 * PII, component values, buyouts, manual input, cached engine outputs) but
 * keeps the database file and its key, so NO re-authentication is needed and
 * the plaintext key material is untouched.
 *
 * Requires the store to be unlocked — throws otherwise. The encrypted half of
 * the Settings "Rebuild database" escape hatch, for a store whose schema has
 * drifted from the code (e.g. a column added to the baseline after the store
 * was already stamped, which createSchema's IF NOT EXISTS DDL cannot heal).
 * Surface only behind an explicit, data-loss-warned confirmation.
 */
export function rebuildSecureSchema(): void {
  const handle = secureDb(); // throws if locked — a rebuild needs an open store
  // FKs off so the drop order across referencing tables never matters.
  handle.pragma("foreign_keys = OFF");
  try {
    const tables = handle
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as Array<{ name: string }>;
    handle.transaction(() => {
      for (const { name } of tables) {
        handle.exec(`DROP TABLE IF EXISTS "${name}"`);
      }
    })();
  } finally {
    handle.pragma("foreign_keys = ON");
  }
  // Recreate schema_info + the full baseline and re-stamp v1.
  createSchema(handle);
}

/**
 * Close the connection, dropping the key from memory. Call on sign-out.
 *
 * The database file stays on disk and is readable again after the next
 * successful sign-in; only the in-memory key is discarded.
 */
export function lockSecureDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
  unlockedKeyHex = null;
}

/** Close the connection — call on app quit so WAL is checkpointed cleanly. */
export function closeSecureDatabase(): void {
  lockSecureDatabase();
}

//------------------------------------------------------------------------------
//--- SCHEMA -------------------------------------------------------------------

// Append-only post-launch migrations, keyed by the version they produce
// (v2, v3, …). The pre-launch history is folded into the v1 baseline in
// createSchema(). NEVER edit or renumber a shipped entry.
const MIGRATIONS: Record<number, (handle: SecureDb) => void> = {
  // Cluster-position groups: positions.cluster_link_id.
  2: applyValueStoreV12,
};

function createSchema(handle: SecureDb): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_info (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Baseline (v1): the entire encrypted feature schema in its final shape. Every
  // statement is IF NOT EXISTS, so this is safe to run on every unlock and also
  // re-asserts any table a drifted store happens to be missing. Column-level
  // drift is NOT healed here (a plain CREATE cannot add a column to an existing
  // table) — that is what the Settings "Rebuild database" action is for.
  handle.exec(POSITIONS_VALUE_TABLES_SQL);
  handle.exec(MANUAL_INPUT_TABLES_SQL);
  handle.exec(ENGINE_OUTPUTS_SQL);

  // Stamp the baseline (1) without downgrading; the runner owns anything above.
  handle
    .prepare(`
      INSERT INTO schema_info (key, value, updated_at)
      VALUES ('schema_version', '1', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
      WHERE CAST(schema_info.value AS INTEGER) < 1
    `)
    .run();

  runMigrations(handle);
}

/** Apply stepwise migrations above the stored schema version. */
function runMigrations(handle: SecureDb): void {
  const row = handle
    .prepare("SELECT value FROM schema_info WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  const stored = Number(row?.value ?? 0) || 0;

  for (let version = stored + 1; version <= CURRENT_SCHEMA_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (!migrate) continue; // version 1 is the baseline above
    handle.transaction(() => {
      migrate(handle);
      handle
        .prepare(`
          INSERT INTO schema_info (key, value, updated_at)
          VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        `)
        .run(String(version));
    })();
  }
}

//------------------------------------------------------------------------------
//--- MAINTENANCE --------------------------------------------------------------

/**
 * DESTRUCTIVE: drop the encrypted database and its wrapped key, then rebuild both
 * from scratch under the supplied server half.
 *
 * This is the *only* path that deletes encrypted data. Key-resolution failures
 * deliberately throw rather than reset (see resolveDbKey), because a wrong server
 * half is indistinguishable from corruption and auto-resetting would turn a
 * recoverable server-side mistake into permanent data loss. Call this only on an
 * explicit user action — "forget this device", or a prompt after a fault has been
 * surfaced.
 */
export function resetSecureDatabase(serverHalf: Buffer): SecureDb {
  lockSecureDatabase();
  destroySecureDatabaseFiles();
  clearWrappedDbKey();
  return unlockSecureDatabase(serverHalf);
}
