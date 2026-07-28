import { safeStorage } from "electron";
import Database from "better-sqlite3-multiple-ciphers";
import {
  CalendarYear,
  DEFAULT_WEEKEND_MASK,
  normalizeCalendar,
} from "./shared/calendar";
import {
  DefaultField,
  DefaultKey,
  PositionDefaults,
  normalizePositionDefaults,
} from "./shared/positionDefaults";
import {
  POSITIONS_STRUCTURE_TABLES_SQL,
  applySsSchemeBaseColumns,
} from "./main/positions/schema";
import { MAPPING_TABLES_SQL } from "./main/mappingTables/schema";
import { BUDGET_IMPORT_SQL } from "./main/budgetImport/schema";
import {
  KPI_DRIVERS_SQL,
  applyKpiDriverMultiplier,
} from "./main/kpiDrivers/schema";
import { applyBlocksStructureV12 } from "./main/blocks/schema";
import { applyHotelClustersV13 } from "./main/hotelClusters/schema";
import {
  applyAllocationInjectAccount,
  applyAllocations,
} from "./main/allocations/schema";
import {
  LOCAL_DB_PATH,
  ensureDataDir,
  migrateLegacyDataDir,
} from "./main/paths";

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

// Both of these must run before the connection below: SQLite files can only be
// relocated while no process holds them open, and this module opens at import.
ensureDataDir();
migrateLegacyDataDir();

// Open the SQLite database. Files previously created by the libsql client are
// ordinary SQLite databases and open here unchanged.
const db = new Database(LOCAL_DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// Schema versioning.
//
// v1 is the BASELINE: the full plaintext schema in its final shape, created in
// one shot by applyBaselineSchema() below. Pre-launch, the former stepwise
// migrations 1–13 (settings + calendar; the positions structure store; safe
// position defaults; mapping reference tables; the bank-holiday premium columns;
// budget import tables; KPI drivers; the blocks feature; hotel clusters) were
// squashed into this baseline — there are no upgraded stores in the wild whose
// stepwise path had to be preserved.
//
// FROM LAUNCH ON, schema changes are APPEND-ONLY entries in MIGRATIONS below
// (v2, v3, …), each run in its own transaction and stamped as it lands. Never
// edit or renumber a shipped migration — the runner only executes versions
// ABOVE a database's stored number, so an edited body silently never re-runs.
// When the list grows unwieldy and every live store is at/above a known floor,
// squash back to a fresh baseline the same way.
const CURRENT_SCHEMA_VERSION = 2;

type LocalDb = InstanceType<typeof Database>;

const POSITION_DEFAULTS_TABLE_SQL = `
  -- Safe defaults that seed a new position's Contract columns, one row per
  -- (hotel OU, year). weekly_hours drives Daily Hours (÷ 5); fields_json holds
  -- the four defaults as { value, linked } so a field can be pinned away from
  -- the calendar it otherwise tracks.
  CREATE TABLE IF NOT EXISTS position_defaults (
      ou           TEXT NOT NULL,
      year         INTEGER NOT NULL,
      weekly_hours REAL NOT NULL DEFAULT 40,
      fields_json  TEXT NOT NULL,
      updated_at   TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ou, year)
  );
`;

// Append-only post-launch migrations, keyed by the version they produce
// (v2, v3, …). Empty today: the whole pre-launch history is folded into the v1
// baseline in applyBaselineSchema(). NEVER edit or renumber a shipped entry.
const MIGRATIONS: Record<number, (handle: LocalDb) => void> = {
  // Allocations can post their split into Results, so a definition needs to say
  // which account it posts to. '' = not posted, i.e. today's behaviour.
  2: applyAllocationInjectAccount,
};

/**
 * Create the entire plaintext feature/structure schema in its final shape (the
 * v1 baseline). Every statement is IF NOT EXISTS / column-guarded, so this is
 * idempotent — safe to run on every launch and to re-run from the Settings
 * "Rebuild database" action after the feature tables have been dropped.
 *
 * user_settings and schema_info are deliberately NOT touched here (they hold
 * app settings, the permanent device salt, and the DPAPI-wrapped secure-DB
 * key); initializeDatabase() creates them, and the rebuild path preserves them.
 */
function applyBaselineSchema(handle: LocalDb): void {
  // Budget/forecast calendar (former v2), one row per (hotel OU, year).
  // weekend_mask seeds the Weekends row; per-month counts in calendar_months
  // stay authoritative once edited. The bank_holiday_* columns are the
  // per-hotel-year premium config (former v6; off by default, an empty account
  // keeps the feature effectively inert).
  handle.exec(`
    CREATE TABLE IF NOT EXISTS calendar_years (
        ou TEXT NOT NULL,
        year INTEGER NOT NULL,
        weekend_mask INTEGER NOT NULL,
        bank_holiday_enabled INTEGER NOT NULL DEFAULT 0,
        bank_holiday_staff_fraction REAL NOT NULL DEFAULT 0.5,
        bank_holiday_premium_multiplier REAL NOT NULL DEFAULT 2,
        bank_holiday_account TEXT NOT NULL DEFAULT '',
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
  // Structure store: scenarios, cost component definitions, SS schemes, field
  // catalog, hotels cache (former v3).
  handle.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  // Safe defaults for new positions (former v4).
  handle.exec(POSITION_DEFAULTS_TABLE_SQL);
  // Mapping reference tables cached from the backend (former v5).
  handle.exec(MAPPING_TABLES_SQL);
  // Budget import tables pulled from a hotel's Excel BGT Spread File (v7/v8).
  handle.exec(BUDGET_IMPORT_SQL);
  // KPI drivers + precalc cache (v9; kpi_driver_id/description now in the
  // constants above).
  handle.exec(KPI_DRIVERS_SQL);
  // kpi_drivers.multiplier for stores predating it. Column-guarded, idempotent.
  applyKpiDriverMultiplier(handle);
  // Blocks: block_configs + the block_id / base_ref columns on
  // cost_component_definitions (former v12). Column-guarded, so idempotent.
  applyBlocksStructureV12(handle);
  // Hotel clusters: hotel_clusters + hotel_cluster_members (former v13).
  applyHotelClustersV13(handle);
  // Per-scheme SS contributory-base columns on ss_schemes. Column-guarded.
  applySsSchemeBaseColumns(handle);
  // Allocations: per-hotel spread definitions (departments × allocations grid is
  // computed on demand, nothing derived stored). Fresh table, IF NOT EXISTS.
  applyAllocations(handle);
}

/**
 * Apply stepwise migrations above the stored schema version. Shared shape with
 * secure_db.ts (deliberately duplicated — the two stores stay independent).
 */
function runMigrations(handle: LocalDb): void {
  const row = handle
    .prepare("SELECT value FROM schema_info WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  const stored = Number(row?.value ?? 0) || 0;

  for (let version = stored + 1; version <= CURRENT_SCHEMA_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (!migrate) continue; // versions <= 2 are covered by the baseline exec
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
    // The two tables the rebuild path preserves: schema_info (version stamp) and
    // user_settings (app settings, the permanent device salt, and the
    // DPAPI-wrapped secure-DB key). Created here, never dropped by a rebuild.
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
    `);

    // The full feature/structure schema (v1 baseline), idempotent.
    applyBaselineSchema(db);

    // Stamp the baseline (1) without ever downgrading a newer stamp — the
    // append-only runner below owns anything past the baseline.
    db.prepare(`
      INSERT INTO schema_info (key, value, updated_at)
      VALUES ('schema_version', '1', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
      WHERE CAST(schema_info.value AS INTEGER) < 1
    `).run();

    runMigrations(db);
  } catch (error) {
    console.error("Error initializing database:", error);
    throw error;
  }
}

/**
 * DESTRUCTIVE: drop every plaintext feature/structure table and recreate them
 * from the v1 baseline. Wipes all planning reference data — scenarios, cost
 * component definitions, SS schemes, field catalog, hotels cache, position
 * defaults, mapping tables, budget imports, KPI drivers, blocks, hotel clusters,
 * calendars — but PRESERVES user_settings and schema_info, so app settings, the
 * permanent device salt, and the DPAPI-wrapped secure-DB key survive (the
 * session and device identity are untouched).
 *
 * The plaintext half of the Settings "Rebuild database" escape hatch, for a
 * store whose schema has drifted from the code. See the note on
 * CURRENT_SCHEMA_VERSION. Surface only behind an explicit, data-loss-warned
 * confirmation.
 */
export function rebuildLocalSchema(): void {
  const PRESERVE = new Set(["user_settings", "schema_info"]);
  // FKs off so the drop order across referencing tables never matters.
  db.pragma("foreign_keys = OFF");
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as Array<{ name: string }>;
    db.transaction(() => {
      for (const { name } of tables) {
        if (!PRESERVE.has(name)) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      }
      applyBaselineSchema(db);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/** The open plaintext database handle — for main-process repositories only. */
export function localDbHandle(): LocalDb {
  return db;
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
    .prepare(
      `SELECT weekend_mask, updated_at,
              bank_holiday_enabled, bank_holiday_staff_fraction,
              bank_holiday_premium_multiplier, bank_holiday_account
         FROM calendar_years WHERE ou = ? AND year = ?`
    )
    .get(ou, year) as
    | {
        weekend_mask: number;
        updated_at: string;
        bank_holiday_enabled: number;
        bank_holiday_staff_fraction: number;
        bank_holiday_premium_multiplier: number;
        bank_holiday_account: string;
      }
    | undefined;

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
    })),
    {
      bankHolidayEnabled: !!head.bank_holiday_enabled,
      bankHolidayStaffFraction: head.bank_holiday_staff_fraction,
      bankHolidayPremiumMultiplier: head.bank_holiday_premium_multiplier,
      bankHolidayAccount: head.bank_holiday_account,
    }
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
    calendar.months ?? [],
    calendar
  );

  const upsertHead = db.prepare(`
    INSERT INTO calendar_years
      (ou, year, weekend_mask, updated_at,
       bank_holiday_enabled, bank_holiday_staff_fraction,
       bank_holiday_premium_multiplier, bank_holiday_account)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
    ON CONFLICT(ou, year) DO UPDATE SET
      weekend_mask = excluded.weekend_mask,
      updated_at = CURRENT_TIMESTAMP,
      bank_holiday_enabled = excluded.bank_holiday_enabled,
      bank_holiday_staff_fraction = excluded.bank_holiday_staff_fraction,
      bank_holiday_premium_multiplier = excluded.bank_holiday_premium_multiplier,
      bank_holiday_account = excluded.bank_holiday_account
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
      upsertHead.run(
        ou,
        year,
        normalized.weekendMask,
        normalized.bankHolidayEnabled ? 1 : 0,
        normalized.bankHolidayStaffFraction,
        normalized.bankHolidayPremiumMultiplier,
        normalized.bankHolidayAccount
      );
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
//--- POSITION SAFE DEFAULTS ---------------------------------------------------
// The numbers a new position's Contract columns start from, one row per
// (hotel OU, year). Stored beside the calendar since they are plain planning
// data that mostly track it.

/** Read one hotel-year's safe defaults, or null if never saved. */
export async function getPositionDefaults(
  ou: string,
  year: number
): Promise<PositionDefaults | null> {
  const row = db
    .prepare(
      "SELECT weekly_hours, fields_json, updated_at FROM position_defaults WHERE ou = ? AND year = ?"
    )
    .get(ou, year) as
    | { weekly_hours: number; fields_json: string; updated_at: string }
    | undefined;

  if (!row) return null;

  let fields: Partial<Record<DefaultKey, Partial<DefaultField>>> | undefined;
  try {
    fields = JSON.parse(row.fields_json);
  } catch (error) {
    console.error("Corrupt position_defaults.fields_json, using defaults:", error);
    fields = undefined;
  }

  const defaults = normalizePositionDefaults(ou, year, row.weekly_hours, fields);
  return { ...defaults, updatedAt: row.updated_at ?? null };
}

/** Upsert one hotel-year's safe defaults. */
export async function savePositionDefaults(
  defaults: PositionDefaults
): Promise<void> {
  const normalized = normalizePositionDefaults(
    defaults.ou,
    defaults.year,
    defaults.weeklyHours,
    defaults.fields
  );

  try {
    db.prepare(`
      INSERT INTO position_defaults (ou, year, weekly_hours, fields_json, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(ou, year) DO UPDATE SET
        weekly_hours = excluded.weekly_hours,
        fields_json = excluded.fields_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      normalized.ou,
      normalized.year,
      normalized.weeklyHours,
      JSON.stringify(normalized.fields)
    );
  } catch (error) {
    console.error("Error saving position defaults:", error);
    throw error;
  }
}

/**
 * Close the settings database — call on app quit.
 *
 * Closing the last connection is what makes SQLite checkpoint the WAL into the
 * main file and unlink the -wal/-shm sidecars. Without this the log is never
 * folded back in and grows across launches, leaving every startup to recover a
 * journal that should already have been retired.
 */
export function closeLocalDatabase(): void {
  try {
    if (db.open) db.close();
  } catch (error) {
    console.warn("[local_db] Failed to close cleanly:", error);
  }
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
