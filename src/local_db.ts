import { app, safeStorage } from "electron";
import path from "path";
import { createClient, Client } from "@libsql/client";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// Kairos local store. This is the minimal, unencrypted libsql database that the
// auth stack and app settings depend on (refresh token, device salt, and
// user_settings). Encryption-at-rest and any feature tables are intentionally
// deferred — see TODO below.
//
// TODO: enable encryption-at-rest. libsql supports whole-file encryption via
// `encryptionKey` on createClient(); the key would come from process.env
// (currently TEMP_DB_KEY) or a server-provisioned secret. A future second,
// encrypted DB may hold feature data separately from these local settings.

const documentsPath = app.getPath("documents");
const kairosFolderPath = path.join(documentsPath, "Kairos");
// Ensure the "Kairos" folder exists, create it if it doesn't
if (!fs.existsSync(kairosFolderPath)) {
  fs.mkdirSync(kairosFolderPath, { recursive: true });
}
const dbPath = path.join(kairosFolderPath, "kairos.db");

// Create the SQLite (libsql) client
const client: Client = createClient({
  url: "file:" + dbPath,
  // encryptionKey: process.env.TEMP_DB_KEY,   // deferred — see TODO above
});

// Baseline schema version. Kairos is a fresh start, so there is no migration
// history to replay — initializeDatabase() just creates the tables and stamps
// this version.
const CURRENT_SCHEMA_VERSION = 1;

interface UserSettings {
  themeMode?: "light" | "dark";
  selectedHotelOu?: string | null;
  permanentSalt?: string;
  [key: string]: any;
}

//------------------------------------------------------------------------------
//--- INITIALIZE DATABASE ------------------------------------------------------
export async function initializeDatabase(): Promise<void> {
  try {
    await client.batch([
      `
        CREATE TABLE IF NOT EXISTS schema_info (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS user_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        `,
    ]);

    // Stamp the baseline schema version.
    await client.execute({
      sql: `
        INSERT INTO schema_info (key, value, updated_at)
        VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `,
      args: [String(CURRENT_SCHEMA_VERSION)],
    });
  } catch (error) {
    console.error("Error initializing database:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------
//--- PERMANENT DEVICE SALT ----------------------------------------------------
// Storage keys for the permanent device salt.
//   - PERMANENT_SALT_KEY:     legacy plaintext (kept as a fallback for machines
//                             where OS-level encryption is unavailable).
//   - PERMANENT_SALT_ENC_KEY: base64 of the DPAPI (safeStorage) ciphertext.
const PERMANENT_SALT_KEY = "permanentSalt";
const PERMANENT_SALT_ENC_KEY = "permanentSaltEnc";

/** Whether OS-level encryption (Windows DPAPI via Electron safeStorage) is usable. */
function saltEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Unwrap a salt that may have been persisted JSON-stringified (with quotes).
 * The returned value is exactly what device_secret hashes, so it MUST match the
 * historical return value of getPermanentSalt() to keep device_secret stable.
 */
function normalizeSalt(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {
    // Not JSON — use as-is.
  }
  return raw;
}

/** Read a raw user_settings value (plain string), or null if the key is absent. */
async function readSaltSetting(key: string): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT value FROM user_settings WHERE key = ?",
    args: [key],
  });
  if (result.rows.length > 0) {
    return (result.rows[0].value as string) ?? null;
  }
  return null;
}

/** Upsert a user_settings value as a plain string (no JSON wrapping). */
async function writeSaltSetting(key: string, value: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO user_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    args: [key, value],
  });
}

// Get or create the permanent device salt.
//
// Storage hardening: when OS-level encryption (Electron safeStorage / Windows
// DPAPI) is available the salt is kept as an encrypted blob under
// `permanentSaltEnc` and the legacy plaintext `permanentSalt` is blanked. When
// encryption is unavailable we transparently fall back to plaintext storage.
//
// IMPORTANT: the salt *value* never changes across this migration — only how it
// is stored at rest — so device_secret (SHA-256 over hardware || salt) stays
// byte-for-byte identical and already-registered devices keep verifying.
export async function getPermanentSalt(): Promise<string> {
  try {
    const dpapi = saltEncryptionAvailable();

    // 1) Preferred path: an encrypted blob already exists.
    const encRaw = await readSaltSetting(PERMANENT_SALT_ENC_KEY);
    const encExists = !!encRaw;
    if (encRaw && dpapi) {
      try {
        const plaintext = safeStorage.decryptString(Buffer.from(encRaw, "base64"));
        if (plaintext) return plaintext;
      } catch (error) {
        // Blob unreadable (e.g. Windows profile/credential loss). Fall through:
        // recover from a plaintext copy if one still exists, otherwise the
        // orphan guard below prevents silently minting a replacement.
        console.warn("[salt] Failed to decrypt permanentSaltEnc:", error);
      }
    }

    // 2) Legacy / fallback path: plaintext salt.
    const plainRaw = await readSaltSetting(PERMANENT_SALT_KEY);
    if (plainRaw) {
      const salt = normalizeSalt(plainRaw);
      // Opportunistically migrate to encrypted-at-rest when possible. The value
      // is unchanged, so device_secret is unaffected.
      if (dpapi) {
        try {
          const blob = safeStorage.encryptString(salt).toString("base64");
          await writeSaltSetting(PERMANENT_SALT_ENC_KEY, blob);
          await writeSaltSetting(PERMANENT_SALT_KEY, ""); // blank the plaintext
        } catch (error) {
          // Migration failed — keep serving the plaintext salt as-is.
          console.warn("[salt] Salt encryption migration failed:", error);
        }
      }
      return salt;
    }

    // 3) Orphan guard: an encrypted salt exists but we could neither decrypt it
    // nor find a plaintext fallback. Do NOT mint a new salt — that would change
    // device_secret and orphan an already-registered device. Fail this launch
    // instead; it self-heals once encryption is available again.
    if (encExists) {
      throw new Error(
        "permanentSaltEnc present but undecryptable and no plaintext fallback"
      );
    }

    // 4) True first run on this machine: mint a new salt.
    const crypto = await import("crypto");
    const newSalt = crypto.randomBytes(16).toString("hex");

    if (dpapi) {
      try {
        const blob = safeStorage.encryptString(newSalt).toString("base64");
        await writeSaltSetting(PERMANENT_SALT_ENC_KEY, blob);
      } catch (error) {
        // Encryption failed at mint time — persist plaintext so the value is
        // durable; a later launch can migrate it once encryption works.
        console.warn("[salt] Failed to encrypt new salt, storing plaintext:", error);
        await writeSaltSetting(PERMANENT_SALT_KEY, newSalt);
      }
    } else {
      await writeSaltSetting(PERMANENT_SALT_KEY, newSalt);
    }

    return newSalt;
  } catch (error) {
    console.error("Error getting/creating permanent salt:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------
//--- USER SETTINGS ------------------------------------------------------------
// Get a specific setting or all settings
export async function getUserSettings(key?: string): Promise<string> {
  try {
    if (key) {
      // Get specific setting
      const result = await client.execute({
        sql: "SELECT value FROM user_settings WHERE key = ?",
        args: [key],
      });

      if (result.rows.length > 0) {
        const value = result.rows[0].value as string;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return JSON.stringify(null);
    } else {
      // Get all settings
      const result = await client.execute({
        sql: "SELECT key, value FROM user_settings",
        args: [],
      });

      const settings: UserSettings = {};
      for (const row of result.rows) {
        const rowKey = row.key as string;
        const value = row.value as string;
        try {
          settings[rowKey] = JSON.parse(value);
        } catch {
          settings[rowKey] = value;
        }
      }
      return JSON.stringify(settings);
    }
  } catch (error) {
    console.error("Error getting user settings:", error);
    throw error;
  }
}

// Set a specific setting or multiple settings
export async function setUserSettings(settings: UserSettings): Promise<string> {
  try {
    const queries = Object.entries(settings).map(([key, value]) => ({
      sql: `
        INSERT INTO user_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `,
      args: [key, JSON.stringify(value)],
    }));

    await client.batch(queries);
    return JSON.stringify({ success: true, message: "Settings saved successfully" });
  } catch (error) {
    console.error("Error saving user settings:", error);
    throw error;
  }
}

// Delete a specific setting
export async function deleteUserSetting(key: string): Promise<string> {
  try {
    await client.execute({
      sql: "DELETE FROM user_settings WHERE key = ?",
      args: [key],
    });
    return JSON.stringify({ success: true, message: "Setting deleted successfully" });
  } catch (error) {
    console.error("Error deleting user setting:", error);
    throw error;
  }
}
