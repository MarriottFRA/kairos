import { app, safeStorage } from "electron";
import path from "path";
import Database from "better-sqlite3-multiple-ciphers";
import fs from "fs";
import {
  CalendarYear,
  DEFAULT_WEEKEND_MASK,
  normalizeCalendar,
} from "./shared/calendar";

// Kairos local store. This is the unencrypted database that the auth stack and
// app settings depend on (refresh token, device salt, and user_settings).
//
// Driver note: this uses `better-sqlite3-multiple-ciphers` — the standard
// better-sqlite3 API with SQLite3MultipleCiphers compiled in. No `PRAGMA key`
// is issued here, so this file stays plain, readable SQLite. The same package
// backs the encrypted feature database (see secure_db.ts), which opens with a
// key; one native module serves both.
//
// The exported functions stay `async` even though better-sqlite3 is
// synchronous, so every existing caller is unaffected.

const documentsPath = app.getPath("documents");
const kairosFolderPath = path.join(documentsPath, "Kairos");
// Ensure the "Kairos" folder exists, create it if it doesn't
if (!fs.existsSync(kairosFolderPath)) {
  fs.mkdirSync(kairosFolderPath, { recursive: true });
}
const dbPath = path.join(kairosFolderPath, "kairos.db");

// Open the SQLite database. Files previously created by the libsql client are
// ordinary SQLite databases and open here unchanged.
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// Baseline schema version. Kairos is a fresh start, so there is no migration
// history to replay — initializeDatabase() just creates the tables and stamps
// this version.
//   1 - schema_info, user_settings
//   2 - budget/forecast calendar (calendar_years, calendar_months)
const CURRENT_SCHEMA_VERSION = 2;

interface UserSettings {
  themeMode?: "light" | "dark";
  selectedHotelOu?: string | null;
  permanentSalt?: string;
  [key: string]: any;
}

/** Shared upsert for the key/value settings table. */
const UPSERT_SETTING_SQL = `
  INSERT INTO user_settings (key, value, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = CURRENT_TIMESTAMP
`;

//------------------------------------------------------------------------------
//--- INITIALIZE DATABASE ------------------------------------------------------
export async function initializeDatabase(): Promise<void> {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      -- Budget/forecast calendar, one row per (hotel OU, year). weekend_mask is
      -- the weekday pattern used to seed the Weekends row; the per-month counts
      -- in calendar_months stay authoritative once the user edits them.
      CREATE TABLE IF NOT EXISTS calendar_years (
          ou TEXT NOT NULL,
          year INTEGER NOT NULL,
          weekend_mask INTEGER NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (ou, year)
      );
      CREATE TABLE IF NOT EXISTS calendar_months (
          ou TEXT NOT NULL,
          year INTEGER NOT NULL,
          month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
          calendar_days INTEGER NOT NULL,
          public_holidays INTEGER NOT NULL DEFAULT 0,
          weekend_days INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (ou, year, month),
          FOREIGN KEY (ou, year) REFERENCES calendar_years (ou, year) ON DELETE CASCADE
      );
    `);

    // Stamp the baseline schema version.
    db.prepare(`
      INSERT INTO schema_info (key, value, updated_at)
      VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(String(CURRENT_SCHEMA_VERSION));
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
function readSaltSetting(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM user_settings WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row ? row.value ?? null : null;
}

/** Upsert a user_settings value as a plain string (no JSON wrapping). */
function writeSaltSetting(key: string, value: string): void {
  db.prepare(UPSERT_SETTING_SQL).run(key, value);
}

// Raw (non-JSON-wrapped) accessors on user_settings. These exist for values that
// are already opaque strings — currently the DPAPI-wrapped key for the encrypted
// database (see secure_db.ts) — where the JSON round-trip in getUserSettings()
// would only get in the way.
export function readRawSetting(key: string): string | null {
  return readSaltSetting(key);
}

export function writeRawSetting(key: string, value: string): void {
  writeSaltSetting(key, value);
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
    const encRaw = readSaltSetting(PERMANENT_SALT_ENC_KEY);
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
    const plainRaw = readSaltSetting(PERMANENT_SALT_KEY);
    if (plainRaw) {
      const salt = normalizeSalt(plainRaw);
      // Opportunistically migrate to encrypted-at-rest when possible. The value
      // is unchanged, so device_secret is unaffected.
      if (dpapi) {
        try {
          const blob = safeStorage.encryptString(salt).toString("base64");
          writeSaltSetting(PERMANENT_SALT_ENC_KEY, blob);
          writeSaltSetting(PERMANENT_SALT_KEY, ""); // blank the plaintext
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
        writeSaltSetting(PERMANENT_SALT_ENC_KEY, blob);
      } catch (error) {
        // Encryption failed at mint time — persist plaintext so the value is
        // durable; a later launch can migrate it once encryption works.
        console.warn("[salt] Failed to encrypt new salt, storing plaintext:", error);
        writeSaltSetting(PERMANENT_SALT_KEY, newSalt);
      }
    } else {
      writeSaltSetting(PERMANENT_SALT_KEY, newSalt);
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
      const row = db
        .prepare("SELECT value FROM user_settings WHERE key = ?")
        .get(key) as { value?: string } | undefined;

      if (row) {
        const value = row.value as string;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return JSON.stringify(null);
    } else {
      // Get all settings
      const rows = db
        .prepare("SELECT key, value FROM user_settings")
        .all() as Array<{ key: string; value: string }>;

      const settings: UserSettings = {};
      for (const row of rows) {
        try {
          settings[row.key] = JSON.parse(row.value);
        } catch {
          settings[row.key] = row.value;
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
    const stmt = db.prepare(UPSERT_SETTING_SQL);
    // One transaction keeps a multi-key write atomic, matching the old batch().
    db.transaction((entries: Array<[string, any]>) => {
      for (const [key, value] of entries) {
        stmt.run(key, JSON.stringify(value));
      }
    })(Object.entries(settings));

    return JSON.stringify({ success: true, message: "Settings saved successfully" });
  } catch (error) {
    console.error("Error saving user settings:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------
//--- BUDGET / FORECAST CALENDAR -----------------------------------------------
// Plain planning data (day counts per month), so it lives here in the
// unencrypted store alongside settings rather than in secure_db.ts.

/** Read one hotel-year calendar, or null if it has never been saved. */
export async function getCalendarYear(
  ou: string,
  year: number
): Promise<CalendarYear | null> {
  const head = db
    .prepare("SELECT weekend_mask, updated_at FROM calendar_years WHERE ou = ? AND year = ?")
    .get(ou, year) as { weekend_mask: number; updated_at: string } | undefined;

  if (!head) return null;

  const rows = db
    .prepare(
      `SELECT month, calendar_days, public_holidays, weekend_days
         FROM calendar_months
        WHERE ou = ? AND year = ?
        ORDER BY month`
    )
    .all(ou, year) as Array<{
      month: number;
      calendar_days: number;
      public_holidays: number;
      weekend_days: number;
    }>;

  const calendar = normalizeCalendar(
    ou,
    year,
    head.weekend_mask,
    rows.map((row) => ({
      month: row.month,
      calendarDays: row.calendar_days,
      publicHolidays: row.public_holidays,
      weekendDays: row.weekend_days,
    }))
  );

  return { ...calendar, updatedAt: head.updated_at ?? null };
}

/** Upsert a whole hotel-year calendar in one transaction. */
export async function saveCalendarYear(calendar: CalendarYear): Promise<void> {
  const { ou, year } = calendar;
  const normalized = normalizeCalendar(
    ou,
    year,
    calendar.weekendMask ?? DEFAULT_WEEKEND_MASK,
    calendar.months ?? []
  );

  const upsertHead = db.prepare(`
    INSERT INTO calendar_years (ou, year, weekend_mask, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ou, year) DO UPDATE SET
      weekend_mask = excluded.weekend_mask,
      updated_at = CURRENT_TIMESTAMP
  `);
  const upsertMonth = db.prepare(`
    INSERT INTO calendar_months
      (ou, year, month, calendar_days, public_holidays, weekend_days)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ou, year, month) DO UPDATE SET
      calendar_days = excluded.calendar_days,
      public_holidays = excluded.public_holidays,
      weekend_days = excluded.weekend_days
  `);

  try {
    db.transaction(() => {
      upsertHead.run(ou, year, normalized.weekendMask);
      for (const row of normalized.months) {
        upsertMonth.run(
          ou,
          year,
          row.month,
          row.calendarDays,
          row.publicHolidays,
          row.weekendDays
        );
      }
    })();
  } catch (error) {
    console.error("Error saving calendar year:", error);
    throw error;
  }
}

/** Years that already have a saved calendar for this OU, newest first. */
export async function listCalendarYears(ou: string): Promise<number[]> {
  const rows = db
    .prepare("SELECT year FROM calendar_years WHERE ou = ? ORDER BY year DESC")
    .all(ou) as Array<{ year: number }>;
  return rows.map((row) => row.year);
}

/** Drop a saved calendar (months cascade). */
export async function deleteCalendarYear(ou: string, year: number): Promise<void> {
  db.prepare("DELETE FROM calendar_years WHERE ou = ? AND year = ?").run(ou, year);
}

//------------------------------------------------------------------------------
// Delete a specific setting
export async function deleteUserSetting(key: string): Promise<string> {
  try {
    db.prepare("DELETE FROM user_settings WHERE key = ?").run(key);
    return JSON.stringify({ success: true, message: "Setting deleted successfully" });
  } catch (error) {
    console.error("Error deleting user setting:", error);
    throw error;
  }
}
