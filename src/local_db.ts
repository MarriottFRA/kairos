import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import path from "path";
import { createClient, Client } from "@libsql/client";
import dotenv from "dotenv";
import fs from "fs";
import {
  PROTEA_CATEGORY_REPOINTS,
  PROTEA_CATEGORY_SORT_ORDER,
} from "./services/reports/proteaMovements";
import { daysInPeriod } from "./services/reports/periodUtils";

dotenv.config();
const secretKey = process.env.TEMP_DB_KEY; // will be pulled from the server and used for creation, encryption, and decryption of the database
const documentsPath = app.getPath("documents");
const psLoaderFolderPath = path.join(documentsPath, "PSLoader");
// Set the SQLite database file path
// Ensure the "PSLoader" folder exists, create it if it doesn't
if (!fs.existsSync(psLoaderFolderPath)) {
  fs.mkdirSync(psLoaderFolderPath, { recursive: true });
}
const dbPath = path.join(psLoaderFolderPath, "psloader.db");
// Enable secret key after testing
// Create a new SQLite client
const client = createClient({
  url: "file:" + dbPath,
  //encryptionKey: secretKey,
});

const dbExists = fs.existsSync(dbPath);

//------------------------------------------------------------------------------------------------------------------
//------DEFINE ALL INTERFACES -------------------------------------------------------------------------------------
// Interface for Financial Data Row used for front end mainly
interface FinancialDataRow {
  combo: string;
  department: string;
  account: string;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  p7: number;
  p8: number;
  p9: number;
  p10: number;
  p11: number;
  p12: number;
}

// base department interface matching the database
interface Department {
  department_id: string;
  d_easy_name: string;
  d_is_locked: number;
  d_level_1: string;
  d_level_2: string;
  d_level_3: string;
  d_level_4: string;
  d_level_5: string;
  d_level_6: string;
  d_level_7: string;
  d_level_8: string;
  d_level_9: string;
  d_level_10: string;
  d_level_11: string;
  d_level_12: string;
  d_level_13: string;
  d_level_14: string;
  d_level_15: string;
  d_level_16: string;
  d_level_17: string;
  d_level_18: string;
  d_level_19: string;
  d_level_20: string;
  d_level_21: string;
  d_level_22: string;
  d_level_23: string;
  d_level_24: string;
  d_level_25: string;
  d_level_26: string;
  d_level_27: string;
  d_level_28: string;
  d_level_29: string;
  d_level_30: string;
}

// Mapping Config interface
interface MappingConfig {
  config_id: number;
  version: string;
  is_locked: boolean;
  description: string;
  created_at: string;
  updated_at: string;
  last_synced?: string;
}

// Approval status type
type ApprovalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DRAFT';

// Mapping interface
interface Mapping {
  id: number;
  mapping_config_id: number;
  source_account: string | null;
  source_department: string | null;
  source_account_department: string | null;
  target_account: string | null;
  target_department: string | null;
  target_account_department: string | null;
  priority: number;
  is_active: boolean;
  approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
}

// Import Group interface
interface ImportGroup {
  id?: number;
  ou: string;
  group_name: string;
  cached_at?: string;
}

// Import interface
interface Import {
  id: number;
  import_group_id?: number;
  name: string;
  display_name: string;
  description: string;
  order_index: number;
  mapping_config_id: number | null;
  required: boolean;
  file_types: string[];
  required_columns: string[];
  optional_columns: string[];
  validation_rules: string[];
}

// Import Session interface
interface ImportSession {
  id?: number;
  ou: string;
  import_group_name: string;
  year: number;
  month: number;
  period_combo: string;
  started_at?: string;
  completed_at?: string;
  status: 'in_progress' | 'completed' | 'failed';
}

// base account interface matching the database
interface Account {
  account_id: string;
  a_easy_name: string;
  a_is_stat: number;
  a_is_locked: number;
  a_level_1: string;
  a_level_2: string;
  a_level_3: string;
  a_level_4: string;
  a_level_5: string;
  a_level_6: string;
  a_level_7: string;
  a_level_8: string;
  a_level_9: string;
  a_level_10: string;
  a_level_11: string;
  a_level_12: string;
  a_level_13: string;
  a_level_14: string;
  a_level_15: string;
  a_level_16: string;
  a_level_17: string;
  a_level_18: string;
  a_level_19: string;
  a_level_20: string;
  a_level_21: string;
  a_level_22: string;
  a_level_23: string;
  a_level_24: string;
  a_level_25: string;
  a_level_26: string;
  a_level_27: string;
  a_level_28: string;
  a_level_29: string;
  a_level_30: string;
}

// base department account interface matching the database
interface FinancialData {
  dep_acc_combo_id: string;
  month: number;
  year: number;
  period_combo: string;
  scenario: string;
  amount: number;
  currency: string;
  ou?: string;
  department?: string;
  account?: string;
  version?: string;
  last_modified: string;
  item_version: number;
}

// base department account interface matching the database
interface DepartmentAccount {
  dep_acc_combo_id: string;
  department_id: string;
  account_id: string;
  is_locked: number;
}

// Mapping Tables Version Tracking
interface MappingTablesVersion {
  id: number; // Always 1 for singleton row
  version: string;
  combo_version: string;
  last_updated: string;
}

// Account Map from API
interface AccountMap {
  base_account: string; // Primary key
  level_0: string;
  level_1: string;
  level_2: string;
  level_3: string;
  level_4: string;
  level_5: string;
  level_6: string;
  level_7: string;
  level_8: string;
  level_9: string;
  level_10: string;
  level_11: string;
  level_12: string;
  level_13: string;
  level_14: string;
  level_15: string;
  level_16: string;
  level_17: string;
  level_18: string;
  level_19: string;
  level_20: string;
  level_21: string;
  level_22: string;
  level_23: string;
  level_24: string;
  level_25: string;
  level_26: string;
  level_27: string;
  level_28: string;
  level_29: string;
  level_30: string;
  description: string;
}

// Department Map from API
interface DepartmentMap {
  base_department: string; // Primary key
  level_0: string;
  level_1: string;
  level_2: string;
  level_3: string;
  level_4: string;
  level_5: string;
  level_6: string;
  level_7: string;
  level_8: string;
  level_9: string;
  level_10: string;
  level_11: string;
  level_12: string;
  level_13: string;
  level_14: string;
  level_15: string;
  level_16: string;
  level_17: string;
  level_18: string;
  level_19: string;
  level_20: string;
  level_21: string;
  level_22: string;
  level_23: string;
  level_24: string;
  level_25: string;
  level_26: string;
  level_27: string;
  level_28: string;
  level_29: string;
  level_30: string;
  description: string;
}

// Account-Department Combo from API
interface AccountDepartmentCombo {
  id?: number;
  account: string;
  department: string;
  description: string;
}

//------------------------------------------------------------------------------------------------------------------
//--- SCHEMA VERSION & MIGRATIONS ---------------------------------------------------------------------------------

// Current schema version - increment this when adding new migrations
const CURRENT_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  name: string;
  up: () => Promise<void>;
}

/**
 * Get the current schema version from the database
 * Returns 0 if schema_info table doesn't exist (legacy/new database)
 */
async function getSchemaVersion(): Promise<number> {
  try {
    const result = await client.execute({
      sql: "SELECT value FROM schema_info WHERE key = 'version'",
      args: []
    });
    if (result.rows.length > 0) {
      return parseInt(result.rows[0].value as string, 10);
    }
    return 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Set the schema version in the database
 */
async function setSchemaVersion(version: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO schema_info (key, value, updated_at)
          VALUES ('version', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    args: [version.toString()]
  });
}

/**
 * Check if a table exists in the database
 */
async function tableExists(tableName: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [tableName]
  });
  return result.rows.length > 0;
}

/**
 * Check if a column exists in a table
 */
async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  try {
    const result = await client.execute({
      sql: `PRAGMA table_info(${tableName})`,
      args: []
    });
    return result.rows.some(row => row.name === columnName);
  } catch {
    return false;
  }
}

/**
 * Get the CREATE statement for a table to inspect its structure
 */
async function getTableSchema(tableName: string): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    args: [tableName]
  });
  if (result.rows.length > 0) {
    return result.rows[0].sql as string;
  }
  return null;
}

// ============================================================================
// MIGRATIONS - Add new migrations here
// ============================================================================

const migrations: Migration[] = [
  {
    version: 1,
    name: 'consolidate_to_current_schema',
    up: async () => {
      // This migration brings any existing database to the current schema
      // It handles all legacy cases and preserves existing data

      // --- financial_data table ---
      if (await tableExists('financial_data')) {
        const schema = await getTableSchema('financial_data');
        const needsRebuild = schema && !schema.includes('PRIMARY KEY (dep_acc_combo_id, period_combo, scenario, version, ou)');

        if (needsRebuild) {
          console.log('[Migration v1] Rebuilding financial_data table with correct schema...');

          await client.execute("PRAGMA foreign_keys = OFF");

          // Create new table with correct schema
          await client.execute(`
            CREATE TABLE IF NOT EXISTS financial_data_new (
              dep_acc_combo_id TEXT NOT NULL,
              month INTEGER NOT NULL,
              year INTEGER NOT NULL,
              period_combo TEXT NOT NULL,
              scenario TEXT NOT NULL,
              amount REAL NOT NULL,
              currency TEXT NOT NULL,
              ou TEXT NOT NULL DEFAULT '',
              department TEXT,
              account TEXT,
              version TEXT NOT NULL DEFAULT 'MAIN',
              last_modified TEXT DEFAULT CURRENT_TIMESTAMP,
              item_version INTEGER DEFAULT 1,
              FOREIGN KEY(dep_acc_combo_id) REFERENCES department_accounts(dep_acc_combo_id),
              PRIMARY KEY (dep_acc_combo_id, period_combo, scenario, version, ou)
            )
          `);

          // Copy data, handling potential missing/null columns
          const hasOu = await columnExists('financial_data', 'ou');
          const hasVersion = await columnExists('financial_data', 'version');
          const hasDepartment = await columnExists('financial_data', 'department');
          const hasAccount = await columnExists('financial_data', 'account');

          await client.execute(`
            INSERT OR IGNORE INTO financial_data_new (
              dep_acc_combo_id, month, year, period_combo, scenario, amount, currency,
              ou, department, account, version, last_modified, item_version
            )
            SELECT
              dep_acc_combo_id,
              month,
              year,
              period_combo,
              scenario,
              amount,
              currency,
              ${hasOu ? "COALESCE(ou, '')" : "''"} as ou,
              ${hasDepartment ? 'department' : 'NULL'} as department,
              ${hasAccount ? 'account' : 'NULL'} as account,
              ${hasVersion ? "COALESCE(version, 'MAIN')" : "'MAIN'"} as version,
              last_modified,
              item_version
            FROM financial_data
          `);

          await client.execute("DROP TABLE financial_data");
          await client.execute("ALTER TABLE financial_data_new RENAME TO financial_data");
          await client.execute("PRAGMA foreign_keys = ON");

          console.log('[Migration v1] financial_data table rebuilt successfully');
        }
      }

      // --- financial_data_staging table ---
      if (await tableExists('financial_data_staging')) {
        // Check for count column (should be removed) or missing columns
        const hasCount = await columnExists('financial_data_staging', 'count');
        const hasSourceAccount = await columnExists('financial_data_staging', 'source_account');
        const hasIsValidCombo = await columnExists('financial_data_staging', 'is_valid_combo');

        if (hasCount || !hasSourceAccount || !hasIsValidCombo) {
          console.log('[Migration v1] Rebuilding financial_data_staging table...');

          await client.execute(`
            CREATE TABLE IF NOT EXISTS financial_data_staging_new (
              dep_acc_combo_id TEXT NOT NULL,
              month INTEGER NOT NULL,
              year INTEGER NOT NULL,
              period_combo TEXT NOT NULL,
              scenario TEXT NOT NULL,
              amount REAL NOT NULL,
              currency TEXT NOT NULL,
              ou TEXT,
              department TEXT,
              account TEXT,
              version TEXT DEFAULT 'MAIN',
              source_account TEXT,
              source_department TEXT,
              source_description TEXT,
              mapping_status TEXT,
              import_batch_id TEXT,
              last_modified TEXT DEFAULT CURRENT_TIMESTAMP,
              item_version INTEGER DEFAULT 1,
              is_valid_combo INTEGER DEFAULT 1
            )
          `);

          // Build column list based on what exists
          const cols = ['dep_acc_combo_id', 'month', 'year', 'period_combo', 'scenario', 'amount', 'currency', 'ou', 'department', 'account', 'version'];
          if (hasSourceAccount) cols.push('source_account', 'source_department', 'source_description', 'mapping_status');
          cols.push('import_batch_id', 'last_modified', 'item_version');
          if (hasIsValidCombo) cols.push('is_valid_combo');

          const selectCols = cols.join(', ');
          const insertCols = hasIsValidCombo ? selectCols : selectCols + ', is_valid_combo';
          const selectExpr = hasIsValidCombo ? selectCols : selectCols + ', 1';

          await client.execute(`INSERT INTO financial_data_staging_new (${insertCols}) SELECT ${selectExpr} FROM financial_data_staging`);
          await client.execute("DROP TABLE financial_data_staging");
          await client.execute("ALTER TABLE financial_data_staging_new RENAME TO financial_data_staging");

          console.log('[Migration v1] financial_data_staging table rebuilt successfully');
        }
      }

      // --- clean up orphaned _new tables from interrupted migrations ---
      // These are created as temp tables during schema rebuilds and renamed at the end.
      // If a migration was interrupted they may be left behind. Only drop them when
      // the real table exists AND already has the correct schema, so we never lose data.
      for (const baseName of ['financial_data', 'financial_data_staging'] as const) {
        const tempName = `${baseName}_new`;
        if (await tableExists(tempName) && await tableExists(baseName)) {
          console.log(`[Migration v1] Dropping orphaned temp table: ${tempName}`);
          await client.execute({ sql: `DROP TABLE ${tempName}`, args: [] });
        }
      }

      // --- hotels_cache table - add missing columns ---
      if (await tableExists('hotels_cache')) {
        const missingCols = [];
        for (const col of ['currency', 'country', 'city', 'local_id_1', 'local_id_2', 'local_id_3']) {
          if (!(await columnExists('hotels_cache', col))) {
            missingCols.push(col);
          }
        }
        if (missingCols.length > 0) {
          console.log(`[Migration v1] Adding columns to hotels_cache: ${missingCols.join(', ')}`);
          for (const col of missingCols) {
            await client.execute({ sql: `ALTER TABLE hotels_cache ADD COLUMN ${col} TEXT`, args: [] });
          }
        }
      }

      // --- account_maps table - add missing column ---
      if (await tableExists('account_maps')) {
        if (!(await columnExists('account_maps', 'account_description_detail_level_max'))) {
          console.log('[Migration v1] Adding account_description_detail_level_max to account_maps');
          await client.execute({ sql: `ALTER TABLE account_maps ADD COLUMN account_description_detail_level_max TEXT`, args: [] });
        }
      }

      // --- department_maps table - add missing column ---
      if (await tableExists('department_maps')) {
        if (!(await columnExists('department_maps', 'department_description_detail_level_max'))) {
          console.log('[Migration v1] Adding department_description_detail_level_max to department_maps');
          await client.execute({ sql: `ALTER TABLE department_maps ADD COLUMN department_description_detail_level_max TEXT`, args: [] });
        }
      }

      // --- mappings table - add approval workflow columns ---
      if (await tableExists('mappings')) {
        if (!(await columnExists('mappings', 'approval_status'))) {
          console.log('[Migration v1] Adding approval workflow columns to mappings');
          await client.execute({ sql: `ALTER TABLE mappings ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'APPROVED'`, args: [] });
          await client.execute({ sql: `ALTER TABLE mappings ADD COLUMN approved_by TEXT`, args: [] });
          await client.execute({ sql: `ALTER TABLE mappings ADD COLUMN approved_at TEXT`, args: [] });
        }
      }

      console.log('[Migration v1] Schema consolidation complete');
    }
  },

  // ============================================================================
  // ADD NEW MIGRATIONS BELOW - Example:
  // ============================================================================
  // {
  //   version: 2,
  //   name: 'add_new_feature_table',
  //   up: async () => {
  //     await client.execute(`CREATE TABLE IF NOT EXISTS new_feature (...)`);
  //   }
  // },
];

/**
 * Run all pending migrations
 */
async function runMigrations(): Promise<void> {
  const currentVersion = await getSchemaVersion();
  const pendingMigrations = migrations.filter(m => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    // console.log(`Database schema is up to date (v${currentVersion})`);
    return;
  }

  console.log(`Running ${pendingMigrations.length} migration(s) from v${currentVersion} to v${CURRENT_SCHEMA_VERSION}...`);

  for (const migration of pendingMigrations.sort((a, b) => a.version - b.version)) {
    console.log(`Running migration v${migration.version}: ${migration.name}`);
    try {
      await migration.up();
      await setSchemaVersion(migration.version);
      console.log(`Migration v${migration.version} completed successfully`);
    } catch (error) {
      console.error(`Migration v${migration.version} failed:`, error);
      throw error; // Stop on failure
    }
  }

  console.log(`All migrations completed. Database is now at v${CURRENT_SCHEMA_VERSION}`);
}

//------------------------------------------------------------------------------------------------------------------
//--- INITIALIZE DATABASE ---------------------------------------------------------------------------------------
//create database if it doesn't exist
export async function initializeDatabase() {
  try {
    if (dbExists) {
      // console.log("Database opened successfully at:", dbPath);
    } else {
      // console.log("Database does not exist, creating a new one...");
    }

    // Set WAL mode (not required explicitly with libsql but mentioned here for behavior reference)
    // Equivalent operations to WAL and encryption key settings can be considered

    // Create necessary tables
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
      `
        CREATE TABLE IF NOT EXISTS hotels_cache (
            ou TEXT PRIMARY KEY,
            hotel_name TEXT NOT NULL,
            room_count INTEGER NOT NULL,
            currency TEXT,
            country TEXT,
            city TEXT,
            local_id_1 TEXT,
            local_id_2 TEXT,
            local_id_3 TEXT,
            cached_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS departments (
            department_id TEXT PRIMARY KEY,
            d_easy_name TEXT NOT NULL,
            d_is_locked BOOLEAN NOT NULL DEFAULT 0,
            d_level_1 TEXT,
            d_level_2 TEXT,
            d_level_3 TEXT,
            d_level_4 TEXT,
            d_level_5 TEXT,
            d_level_6 TEXT,
            d_level_7 TEXT,
            d_level_8 TEXT,
            d_level_9 TEXT,
            d_level_10 TEXT,
            d_level_11 TEXT,
            d_level_12 TEXT,
            d_level_13 TEXT,
            d_level_14 TEXT,
            d_level_15 TEXT,
            d_level_16 TEXT,
            d_level_17 TEXT,
            d_level_18 TEXT,
            d_level_19 TEXT,
            d_level_20 TEXT,
            d_level_21 TEXT,
            d_level_22 TEXT,
            d_level_23 TEXT,
            d_level_24 TEXT,
            d_level_25 TEXT,
            d_level_26 TEXT,
            d_level_27 TEXT,
            d_level_28 TEXT,
            d_level_29 TEXT,
            d_level_30 TEXT
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS accounts (
            account_id TEXT PRIMARY KEY,
            a_easy_name TEXT NOT NULL,
            a_is_stat BOOLEAN NOT NULL DEFAULT 0, 
            a_is_locked BOOLEAN NOT NULL DEFAULT 0, 
            a_level_1 TEXT,
            a_level_2 TEXT,
            a_level_3 TEXT,
            a_level_4 TEXT,
            a_level_5 TEXT,
            a_level_6 TEXT,
            a_level_7 TEXT,
            a_level_8 TEXT,
            a_level_9 TEXT,
            a_level_10 TEXT,
            a_level_11 TEXT,
            a_level_12 TEXT,
            a_level_13 TEXT,
            a_level_14 TEXT,
            a_level_15 TEXT,
            a_level_16 TEXT,
            a_level_17 TEXT,
            a_level_18 TEXT,
            a_level_19 TEXT,
            a_level_20 TEXT,
            a_level_21 TEXT,
            a_level_22 TEXT,
            a_level_23 TEXT,
            a_level_24 TEXT,
            a_level_25 TEXT,
            a_level_26 TEXT,
            a_level_27 TEXT,
            a_level_28 TEXT,
            a_level_29 TEXT,
            a_level_30 TEXT
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS department_accounts (
            dep_acc_combo_id TEXT PRIMARY KEY,  
            department_id TEXT NOT NULL,    
            account_id TEXT NOT NULL,
            is_locked BOOLEAN NOT NULL DEFAULT 0,    
            FOREIGN KEY(department_id) REFERENCES departments(department_id),
            FOREIGN KEY(account_id) REFERENCES accounts(account_id)
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS financial_data (
            dep_acc_combo_id TEXT NOT NULL,
            month INTEGER NOT NULL,
            year INTEGER NOT NULL,
            period_combo TEXT NOT NULL,
            scenario TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL,
            ou TEXT NOT NULL,
            department TEXT,
            account TEXT,
            version TEXT NOT NULL DEFAULT 'MAIN',
            last_modified TEXT DEFAULT CURRENT_TIMESTAMP,
            item_version INTEGER DEFAULT 1,
            FOREIGN KEY(dep_acc_combo_id) REFERENCES department_accounts(dep_acc_combo_id),
            PRIMARY KEY (dep_acc_combo_id, period_combo, scenario, version, ou)
        )
        `,
      // Locally-imported data only. Sync reconciliation NEVER touches this table —
      // see deleteSyncedFinancialDataForPeriods() for the synced-data counterpart.
      `
        CREATE TABLE IF NOT EXISTS financial_data_staging (
            dep_acc_combo_id TEXT NOT NULL,
            month INTEGER NOT NULL,
            year INTEGER NOT NULL,
            period_combo TEXT NOT NULL,
            scenario TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL,
            ou TEXT,
            department TEXT,
            account TEXT,
            version TEXT DEFAULT 'MAIN',
            source_account TEXT,
            source_department TEXT,
            source_description TEXT,
            mapping_status TEXT,
            import_batch_id TEXT,
            last_modified TEXT DEFAULT CURRENT_TIMESTAMP,
            item_version INTEGER DEFAULT 1,
            is_valid_combo INTEGER DEFAULT 1
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS mapping_configs (
            config_id INTEGER PRIMARY KEY,
            version TEXT NOT NULL,
            is_locked BOOLEAN NOT NULL DEFAULT 0,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_synced TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(config_id)
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS mappings (
            id INTEGER PRIMARY KEY,
            mapping_config_id INTEGER NOT NULL,
            source_account TEXT,
            source_department TEXT,
            source_account_department TEXT,
            target_account TEXT,
            target_department TEXT,
            target_account_department TEXT,
            priority INTEGER DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT 1,
            approval_status TEXT NOT NULL DEFAULT 'APPROVED',
            approved_by TEXT,
            approved_at TEXT,
            FOREIGN KEY(mapping_config_id) REFERENCES mapping_configs(config_id) ON DELETE CASCADE
        )
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_mapping_config ON mappings(mapping_config_id)
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_mapping_source ON mappings(source_account, source_department)
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_mapping_target ON mappings(target_account, target_department)
        `,
      `
        CREATE TABLE IF NOT EXISTS mapping_tables_version (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version TEXT NOT NULL,
            combo_version TEXT NOT NULL,
            last_updated TEXT DEFAULT CURRENT_TIMESTAMP
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS account_maps (
            base_account TEXT PRIMARY KEY,
            account_description_detail_level_max TEXT,
            level_0 TEXT,
            level_1 TEXT,
            level_2 TEXT,
            level_3 TEXT,
            level_4 TEXT,
            level_5 TEXT,
            level_6 TEXT,
            level_7 TEXT,
            level_8 TEXT,
            level_9 TEXT,
            level_10 TEXT,
            level_11 TEXT,
            level_12 TEXT,
            level_13 TEXT,
            level_14 TEXT,
            level_15 TEXT,
            level_16 TEXT,
            level_17 TEXT,
            level_18 TEXT,
            level_19 TEXT,
            level_20 TEXT,
            level_21 TEXT,
            level_22 TEXT,
            level_23 TEXT,
            level_24 TEXT,
            level_25 TEXT,
            level_26 TEXT,
            level_27 TEXT,
            level_28 TEXT,
            level_29 TEXT,
            level_30 TEXT,
            description TEXT
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS department_maps (
            base_department TEXT PRIMARY KEY,
            department_description_detail_level_max TEXT,
            level_0 TEXT,
            level_1 TEXT,
            level_2 TEXT,
            level_3 TEXT,
            level_4 TEXT,
            level_5 TEXT,
            level_6 TEXT,
            level_7 TEXT,
            level_8 TEXT,
            level_9 TEXT,
            level_10 TEXT,
            level_11 TEXT,
            level_12 TEXT,
            level_13 TEXT,
            level_14 TEXT,
            level_15 TEXT,
            level_16 TEXT,
            level_17 TEXT,
            level_18 TEXT,
            level_19 TEXT,
            level_20 TEXT,
            level_21 TEXT,
            level_22 TEXT,
            level_23 TEXT,
            level_24 TEXT,
            level_25 TEXT,
            level_26 TEXT,
            level_27 TEXT,
            level_28 TEXT,
            level_29 TEXT,
            level_30 TEXT,
            description TEXT
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS account_department_combos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account TEXT NOT NULL,
            department TEXT NOT NULL,
            description TEXT,
            UNIQUE(account, department)
        )
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_combo_account ON account_department_combos(account)
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_combo_department ON account_department_combos(department)
        `,
      `
        CREATE TABLE IF NOT EXISTS import_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ou TEXT NOT NULL,
            group_name TEXT NOT NULL,
            cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(ou, group_name)
        )
        `,
      `
        CREATE TABLE IF NOT EXISTS imports (
            id INTEGER PRIMARY KEY,
            import_group_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            description TEXT,
            order_index INTEGER DEFAULT 0,
            mapping_config_id INTEGER,
            required BOOLEAN DEFAULT 0,
            file_types TEXT,
            required_columns TEXT,
            optional_columns TEXT,
            validation_rules TEXT,
            FOREIGN KEY(import_group_id) REFERENCES import_groups(id) ON DELETE CASCADE,
            FOREIGN KEY(mapping_config_id) REFERENCES mapping_configs(config_id)
        )
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_imports_group ON imports(import_group_id)
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_imports_mapping_config ON imports(mapping_config_id)
        `,
      `
        CREATE TABLE IF NOT EXISTS import_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ou TEXT NOT NULL,
            import_group_name TEXT NOT NULL,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            period_combo TEXT NOT NULL,
            started_at TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT,
            status TEXT DEFAULT 'in_progress'
        )
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_import_sessions_ou ON import_sessions(ou)
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_import_sessions_period ON import_sessions(year, month)
        `,
      `
        CREATE TABLE IF NOT EXISTS cache_metadata (
            key TEXT PRIMARY KEY,
            last_fetched_at TEXT,
            fetch_status TEXT DEFAULT 'idle',
            error_message TEXT
        )
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_cache_metadata_status ON cache_metadata(fetch_status)
        `,
      `
        CREATE TABLE IF NOT EXISTS validations (
            id INTEGER PRIMARY KEY,
            ou TEXT NOT NULL,
            name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            is_required BOOLEAN DEFAULT 0,
            description TEXT,
            sequence INTEGER DEFAULT 0,
            cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(ou, name)
        )
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_validations_ou ON validations(ou)
        `,
      `
        CREATE INDEX IF NOT EXISTS idx_validations_sequence ON validations(sequence)
        `,
      `
        CREATE TABLE IF NOT EXISTS financial_data_sync_checks (
            ou TEXT PRIMARY KEY,
            last_check_date TEXT NOT NULL,
            last_check_timestamp TEXT NOT NULL,
            check_result TEXT
        )
        `,
    ]);

    // Run migrations for existing databases
    // Fresh installs: tables created with correct schema, migrations detect no changes needed
    // Existing installs: migrations bring schema up to date
    await runMigrations();

    // Mark fresh databases as current version (no migrations needed)
    const currentVersion = await getSchemaVersion();
    if (currentVersion === 0) {
      await setSchemaVersion(CURRENT_SCHEMA_VERSION);
      console.log(`Fresh database initialized at schema v${CURRENT_SCHEMA_VERSION}`);
    }
  } catch (error) {
    console.error("Error during database initialization:", error);
  }
}

// Helper function to generate periods
function generatePeriods(startPeriod: string, count: number): string[] {
  const periods = [];
  const [startYear, startMonth] = startPeriod.split("-").map(Number);

  for (let i = 0; i < count; i++) {
    const date = new Date(startYear, startMonth - 1 + i, 1);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    periods.push(`${year}-${month}`);
  }

  return periods;
}

//------------------------------------------------------------------------------------------------------------------
//----------------- GET 12 PERIODS ------------------------------------------------------------------------------
// interface defined in common area at the top
// Function to retrieve 12 periods of financial data
export async function get12Periods(...args: unknown[]): Promise<string> {
  // Validation
  const periodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
  const allowedScenarios = ["ACT", "BUD", "PY1", "PY2", "PY3", "FCST"];

  const period = args[0] as string;
  const scenario = args[1] as string;

  if (!periodRegex.test(period)) {
    throw new Error("Invalid period format. Expected 'YYYY-MM'.");
  }

  if (!allowedScenarios.includes(scenario)) {
    throw new Error("Invalid scenario. Expected one of 'ACT', 'BUD', 'PY1', 'PY2', 'PY3', or 'FCST'.");
  }

  const numberOfPeriods = 12;
  const periods = generatePeriods(period, numberOfPeriods); // Array of 'YYYY-MM' strings
  const params = [...periods, scenario];

  try {
    const query = `
        SELECT 
            fd.dep_acc_combo_id AS combo, 
            d.d_easy_name AS department, 
            a.a_easy_name AS account, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p1, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p2, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p3, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p4, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p5, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p6, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p7, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p8, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p9, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p10, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p11, 
            SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p12 
        FROM financial_data fd
        JOIN department_accounts da ON fd.dep_acc_combo_id = da.dep_acc_combo_id
        JOIN departments d ON da.department_id = d.department_id
        JOIN accounts a ON da.account_id = a.account_id
        WHERE fd.scenario = ?
        GROUP BY fd.dep_acc_combo_id, d.d_easy_name, a.a_easy_name
      `;

    // Execute the query
    const resultSet = await client.execute({ sql: query, args: params });

    // Access rows and assert their type
    const rows = resultSet.rows as unknown as FinancialDataRow[];

    let idCounter = 1;
    const result = rows.map((row) => ({
      id: idCounter++,
      combo: row.combo,
      department: row.department,
      account: row.account,
      p1: row.p1,
      p2: row.p2,
      p3: row.p3,
      p4: row.p4,
      p5: row.p5,
      p6: row.p6,
      p7: row.p7,
      p8: row.p8,
      p9: row.p9,
      p10: row.p10,
      p11: row.p11,
      p12: row.p12,
    }));

    return JSON.stringify(result);
  } catch (error) {
    console.error("Error fetching financial data:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- UPDATE 12 PERIODS ----------------------------------------------------------------------------
// Function to update 12 periods
export async function update12Periods(...args: unknown[]): Promise<string> {
  // Validation
  const periodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
  const allowedScenarios = ["ACT", "BUD", "PY1", "PY2", "PY3", "FCST"];

  const period = args[0] as string;
  const scenario = args[1] as string;

  if (!periodRegex.test(period)) {
    throw new Error("Invalid period format. Expected 'YYYY-MM'.");
  }

  if (!allowedScenarios.includes(scenario)) {
    throw new Error("Invalid scenario. Expected one of 'ACT', 'BUD', 'PY1', 'PY2', 'PY3', or 'FCST'.");
  }

  // Parse args[2] as JSON
  let data: Record<string, any>;
  try {
    data = JSON.parse(args[2] as string);
  } catch (e) {
    throw new Error("Invalid JSON data in args[2].");
  }

  const periods = generatePeriods(period, 12); // Generate 12 periods starting from `period`

  const upsertQuery = `
      INSERT INTO financial_data (
        dep_acc_combo_id, month, year, period_combo, scenario, amount, currency,
        ou, department, account, version, last_modified, item_version
      ) VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
      ON CONFLICT (dep_acc_combo_id, period_combo, scenario, version, ou) DO UPDATE SET
        amount = excluded.amount,
        department = excluded.department,
        account = excluded.account,
        last_modified = CURRENT_TIMESTAMP,
        item_version = financial_data.item_version + 1;
    `;

  const batchQueries: { sql: string; args: (string | number | null)[] }[] = [];

  for (let i = 0; i < periods.length; i++) {
    const currentPeriod = periods[i];
    const amount = data[`p${i + 1}`];

    // Skip if amount is zero or null
    if (!amount || amount === 0) {
      continue;
    }

    const dep_acc_combo_id = data.combo;

    const [yearStr, monthStr] = currentPeriod.split("-");
    const year = parseInt(yearStr);
    const month = parseInt(monthStr);

    batchQueries.push({
      sql: upsertQuery,
      args: [
        dep_acc_combo_id,
        month,
        year,
        currentPeriod,
        scenario,
        amount,
        data.ou || null,
        data.department || null,
        data.account || null,
        data.version || null
      ],
    });
  }

  try {
    await client.batch(batchQueries);
    return "Data updated successfully.";
  } catch (e) {
    throw new Error(`Failed to update data: ${e.message}`);
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- GET FINANCIAL REPORT DATA -----------------------------------------------------------------------
// Function to retrieve financial report data with actuals vs budget comparison
// Returns data with account and department mapping levels included
export async function getFinancialReportData(
  startPeriod: string,
  ou?: string,
  version: string = 'MAIN'
): Promise<string> {
  const periodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

  if (!periodRegex.test(startPeriod)) {
    throw new Error("Invalid period format. Expected 'YYYY-MM'.");
  }

  const numberOfPeriods = 12;
  const periods = generatePeriods(startPeriod, numberOfPeriods);

  try {
    // Get the latest period for staging data join optimization
    const latestPeriod = periods[periods.length - 1];

    const query = `
      WITH combined_actuals AS (
        SELECT
          COALESCE(fds.dep_acc_combo_id, fd.dep_acc_combo_id) AS combo,
          COALESCE(fds.department, fd.department) AS department,
          COALESCE(fds.account, fd.account) AS account,
          COALESCE(fds.amount, fd.amount) AS amount,
          COALESCE(fds.period_combo, fd.period_combo) AS period_combo
        FROM financial_data fd
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fds.period_combo = ?
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'ACT'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'ACT'
          AND fd.version = ?
          AND fd.period_combo IN (${periods.map(() => '?').join(', ')})
          ${ou ? 'AND fd.ou = ?' : ''}

        UNION ALL

        SELECT
          fds.dep_acc_combo_id AS combo,
          fds.department,
          fds.account,
          fds.amount,
          fds.period_combo
        FROM financial_data_staging fds
        WHERE fds.scenario = 'ACT'
          AND fds.period_combo IN (${periods.map(() => '?').join(', ')})
          ${ou ? 'AND fds.ou = ?' : ''}
      ),
      combined_budget AS (
        SELECT
          COALESCE(fds.dep_acc_combo_id, fd.dep_acc_combo_id) AS combo,
          COALESCE(fds.department, fd.department) AS department,
          COALESCE(fds.account, fd.account) AS account,
          COALESCE(fds.amount, fd.amount) AS amount,
          COALESCE(fds.period_combo, fd.period_combo) AS period_combo
        FROM financial_data fd
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fds.period_combo = ?
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'BUD'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'BUD'
          AND fd.version = ?
          AND fd.period_combo IN (${periods.map(() => '?').join(', ')})
          ${ou ? 'AND fd.ou = ?' : ''}

        UNION ALL

        SELECT
          fds.dep_acc_combo_id AS combo,
          fds.department,
          fds.account,
          fds.amount,
          fds.period_combo
        FROM financial_data_staging fds
        WHERE fds.scenario = 'BUD'
          AND fds.period_combo IN (${periods.map(() => '?').join(', ')})
          ${ou ? 'AND fds.ou = ?' : ''}
      ),
      actuals_data AS (
        SELECT
          combo,
          department,
          account,
          ${periods.map((_, i) => `SUM(CASE WHEN period_combo = ? THEN amount ELSE 0 END) AS act_p${i + 1}`).join(',\n          ')}
        FROM combined_actuals
        GROUP BY combo, department, account
      ),
      budget_data AS (
        SELECT
          combo,
          ${periods.map((_, i) => `SUM(CASE WHEN period_combo = ? THEN amount ELSE 0 END) AS bud_p${i + 1}`).join(',\n          ')}
        FROM combined_budget
        GROUP BY combo
      )
      SELECT
        a.combo,
        am.base_account,
        am.level_4 AS account_level_4,
        am.level_6 AS account_level_6,
        am.level_9 AS account_level_9,
        dm.level_4 AS department_level_4,
        dm.level_5 AS department_level_5,
        dm.level_7 AS department_level_7,
        ${periods.map((_, i) => `COALESCE(a.act_p${i + 1}, 0) AS act_p${i + 1}`).join(',\n        ')},
        ${periods.map((_, i) => `COALESCE(b.bud_p${i + 1}, 0) AS bud_p${i + 1}`).join(',\n        ')}
      FROM actuals_data a
      LEFT JOIN budget_data b ON a.combo = b.combo
      LEFT JOIN account_maps am ON a.account = am.base_account
      LEFT JOIN department_maps dm ON a.department = dm.base_department
      WHERE dm.level_2 = 'Lodging Operations'
        AND am.level_4 = 'Profit Amount'
        AND a.account NOT LIKE 'A1%' AND a.account NOT LIKE 'A2%'
        AND (${periods.map((_, i) => `(a.act_p${i + 1} != 0 OR b.bud_p${i + 1} != 0)`).join(' OR ')})
      ORDER BY dm.level_4, dm.level_5, dm.level_7, am.level_4, am.level_6, am.level_9
    `;

    // Build params array
    // Order: latestPeriod, version, periods for ACT WHERE, ou?, periods for ACT UNION, ou?,
    //        latestPeriod, version, periods for BUD WHERE, ou?, periods for BUD UNION, ou?,
    //        periods for actuals CASE, periods for budget CASE
    const params: any[] = [];

    // combined_actuals CTE params
    params.push(latestPeriod);           // LEFT JOIN condition
    params.push('MAIN');                  // actuals always use MAIN version
    params.push(...periods);              // WHERE clause
    if (ou) params.push(ou);
    params.push(...periods);              // UNION ALL WHERE clause
    if (ou) params.push(ou);

    // combined_budget CTE params
    params.push(latestPeriod);           // LEFT JOIN condition
    params.push(version);                 // budget uses user-selected version
    params.push(...periods);              // WHERE clause
    if (ou) params.push(ou);
    params.push(...periods);              // UNION ALL WHERE clause
    if (ou) params.push(ou);

    // actuals_data and budget_data CASE WHEN params
    params.push(...periods);              // actuals CASE WHEN
    params.push(...periods);              // budget CASE WHEN

    const resultSet = await client.execute({ sql: query, args: params });
    const rows = resultSet.rows as unknown as any[];

    let idCounter = 1;
    const result = rows.map((row) => {
      const record: any = {
        id: idCounter++,
        combo: row.combo,
        base_account: row.base_account,
        account_level_4: row.account_level_4,
        account_level_6: row.account_level_6,
        account_level_9: row.account_level_9,
        department_level_4: row.department_level_4,
        department_level_5: row.department_level_5,
        department_level_7: row.department_level_7,
      };

      // Add monthly actuals and budget
      for (let i = 1; i <= 12; i++) {
        record[`act_p${i}`] = row[`act_p${i}`] || 0;
        record[`bud_p${i}`] = row[`bud_p${i}`] || 0;
      }

      return record;
    });

    return JSON.stringify(result);
  } catch (error) {
    console.error("Error fetching financial report data:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- GET SUMMARY P&L DATA -----------------------------------------------------------------------------------------
export async function getSummaryPLData(
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  ou?: string,
  version: string = 'MAIN'
): Promise<string> {
  try {
    const {
      generatePeriods,
      generateLYPeriods,
      buildScenarioQuery,
      calculateSummaryPLRows
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);

    const actualsQuery = buildScenarioQuery('ACT', periods, ou, 'MAIN');
    const budgetQuery = buildScenarioQuery('BUD', periods, ou, version);
    const lyQuery = buildScenarioQuery('ACT', lyPeriods, ou, 'MAIN');

    const [actualsResult, budgetResult, lyResult] = await Promise.all([
      client.execute({ sql: actualsQuery.sql, args: actualsQuery.params }),
      client.execute({ sql: budgetQuery.sql, args: budgetQuery.params }),
      client.execute({ sql: lyQuery.sql, args: lyQuery.params })
    ]);

    const actualsData = actualsResult.rows[0] as any || {};
    const budgetData = budgetResult.rows[0] as any || {};
    const lyData = lyResult.rows[0] as any || {};

    const periodDays = daysInPeriod(startMonth, startYear, endMonth, endYear);
    const plRows = calculateSummaryPLRows(actualsData, budgetData, lyData, periodDays);

    return JSON.stringify(plRows);
  } catch (error) {
    console.error("Error generating summary P&L data:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- GET F90 P&L DATA -----------------------------------------------------------------------------------------
export async function getF90PLData(
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  ou?: string,
  version: string = 'MAIN',
  rowConfig?: any[]
): Promise<string> {
  try {
    const {
      generatePeriods,
      generateLYPeriods,
      buildScenarioQuery,
      calculateF90PLRows
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);

    const actualsQuery = buildScenarioQuery('ACT', periods, ou, 'MAIN');
    const budgetQuery = buildScenarioQuery('BUD', periods, ou, version);
    const lyQuery = buildScenarioQuery('ACT', lyPeriods, ou, 'MAIN');

    const [actualsResult, budgetResult, lyResult] = await Promise.all([
      client.execute({ sql: actualsQuery.sql, args: actualsQuery.params }),
      client.execute({ sql: budgetQuery.sql, args: budgetQuery.params }),
      client.execute({ sql: lyQuery.sql, args: lyQuery.params })
    ]);

    const actualsData = actualsResult.rows[0] as any || {};
    const budgetData = budgetResult.rows[0] as any || {};
    const lyData = lyResult.rows[0] as any || {};

    const periodDays = daysInPeriod(startMonth, startYear, endMonth, endYear);
    const plRows = calculateF90PLRows(actualsData, budgetData, lyData, rowConfig, false, periodDays);

    return JSON.stringify(plRows);
  } catch (error) {
    console.error("Error generating F90 P&L data:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- GET PROTEA F90 P&L DATA (with account movement mutation) -----------------------------------------------------
// Same as getF90PLData but applies applyProteaAccountMovement() to shift insurance/audit
// accounts from D0480/D0490 into Admin & General before measure evaluation.
export async function getProteaF90PLData(
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  ou?: string,
  version: string = 'MAIN',
  rowConfig?: any[],
  skipFilter: boolean = false
): Promise<string> {
  try {
    const {
      generatePeriods,
      generateLYPeriods,
      buildScenarioQuery,
      calculateF90PLRows,
      applyProteaAccountMovement
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);

    const actualsQuery = buildScenarioQuery('ACT', periods, ou, 'MAIN');
    const budgetQuery = buildScenarioQuery('BUD', periods, ou, version);
    const lyQuery = buildScenarioQuery('ACT', lyPeriods, ou, 'MAIN');

    const [actualsResult, budgetResult, lyResult] = await Promise.all([
      client.execute({ sql: actualsQuery.sql, args: actualsQuery.params }),
      client.execute({ sql: budgetQuery.sql, args: budgetQuery.params }),
      client.execute({ sql: lyQuery.sql, args: lyQuery.params })
    ]);

    const actualsData = actualsResult.rows[0] as any || {};
    const budgetData = budgetResult.rows[0] as any || {};
    const lyData = lyResult.rows[0] as any || {};

    // Apply Protea account movement before measure evaluation
    applyProteaAccountMovement(actualsData);
    applyProteaAccountMovement(budgetData);
    applyProteaAccountMovement(lyData);

    const periodDays = daysInPeriod(startMonth, startYear, endMonth, endYear);
    const plRows = calculateF90PLRows(actualsData, budgetData, lyData, rowConfig, true, periodDays);

    return JSON.stringify(plRows);
  } catch (error) {
    console.error("Error generating Protea F90 P&L data:", error);
    throw error;
  }
}

// ============================================================================
// PROTEA BUDGET PACK — F90 DATA WITH MONTHLY BREAKDOWN
// Slot remapping: actualsSlot=CurrentBudget, budgetSlot=LYBudget, lySlot=LYActuals
// ============================================================================

export async function getProteaBudgetF90PLData(
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  ou: string,
  version: string = 'MAIN',
  rowConfig?: any[],
  skipFilter: boolean = false
): Promise<{ total: string; monthly: Record<string, string> }> {
  try {
    const {
      generatePeriods,
      generateLYPeriods,
      buildScenarioQuery,
      calculateF90PLRows,
      applyProteaAccountMovement
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const currentPeriods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(currentPeriods);

    // 3 total queries + N monthly queries — all parallelised
    const curBudQuery = buildScenarioQuery('BUD', currentPeriods, ou, version);
    const lyBudQuery = buildScenarioQuery('BUD', lyPeriods, ou, version);
    const lyActQuery = buildScenarioQuery('ACT', lyPeriods, ou, 'MAIN');
    const monthlyQueries = currentPeriods.map(p => buildScenarioQuery('BUD', [p], ou, version));

    const allQueries = [
      client.execute({ sql: curBudQuery.sql, args: curBudQuery.params }),
      client.execute({ sql: lyBudQuery.sql, args: lyBudQuery.params }),
      client.execute({ sql: lyActQuery.sql, args: lyActQuery.params }),
      ...monthlyQueries.map(q => client.execute({ sql: q.sql, args: q.params }))
    ];

    const results = await Promise.all(allQueries);
    const curBudData = results[0].rows[0] as any || {};
    const lyBudData = results[1].rows[0] as any || {};
    const lyActData = results[2].rows[0] as any || {};

    // Apply Protea account movement to all datasets
    applyProteaAccountMovement(curBudData);
    applyProteaAccountMovement(lyBudData);
    applyProteaAccountMovement(lyActData);

    const totalPeriodDays = daysInPeriod(startMonth, startYear, endMonth, endYear);

    // Totals: slot remap — actuals=CurBud, budget=LYBud, ly=LYAct
    const totalRows = calculateF90PLRows(curBudData, lyBudData, lyActData, rowConfig, skipFilter, totalPeriodDays);

    // Monthly breakdown: one set of rows per period
    const monthly: Record<string, string> = {};
    for (let i = 0; i < currentPeriods.length; i++) {
      const monthData = results[3 + i].rows[0] as any || {};
      applyProteaAccountMovement(monthData);
      // Per-month period days for that single calendar month
      const [py, pm] = currentPeriods[i].split('-').map(Number);
      const monthDays = daysInPeriod(pm, py, pm, py);
      // Only the "actuals" slot is populated (= this month's budget)
      const monthRows = calculateF90PLRows(monthData, {}, {}, rowConfig, true, monthDays);
      monthly[currentPeriods[i]] = JSON.stringify(monthRows);
    }

    return { total: JSON.stringify(totalRows), monthly };
  } catch (error) {
    console.error("Error generating Protea Budget F90 P&L data:", error);
    throw error;
  }
}

// ============================================================================
// PROTEA BUDGET PACK — PER-PERIOD BUDGET BREAKDOWN FOR DEPARTMENT DETAIL
// Returns budget amount per account per period using a CASE-WHEN pivot.
// ============================================================================

export async function getProteaDepartmentBudgetByPeriod(
  ou: string,
  department: string,
  periods: string[],
  version: string = 'MAIN'
): Promise<Array<{ account: string; [period: string]: number }>> {
  try {
    if (periods.length === 0) return [];

    const periodColumns = periods.map((_, i) =>
      `SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p${i}`
    ).join(',\n      ');

    const periodPlaceholders = periods.map(() => '?').join(', ');

    const query = `
      SELECT
        fd.account,
        ${periodColumns}
      FROM financial_data fd
      WHERE fd.scenario = 'BUD'
        AND fd.ou = ?
        AND fd.version = ?
        AND fd.department = ?
        AND ${excludeBalanceSheet('fd.account')}
        AND fd.period_combo IN (${periodPlaceholders})
      GROUP BY fd.account
    `;

    const params: any[] = [
      ...periods,           // for CASE WHEN columns
      ou, version, department,
      ...periods            // for IN clause
    ];

    const result = await client.execute({ sql: query, args: params });

    return (result.rows as any[]).map(row => {
      const mapped: any = { account: row.account as string };
      for (let i = 0; i < periods.length; i++) {
        mapped[periods[i]] = Number(row[`p${i}`]) || 0;
      }
      return mapped;
    });
  } catch (error) {
    console.error(`Error getting budget by period for ${department}:`, error);
    throw error;
  }
}

export async function getProteaGroupDepartmentBudgetByPeriod(
  ou: string,
  departments: string[],
  periods: string[],
  version: string = 'MAIN'
): Promise<Array<{ account: string; [period: string]: number }>> {
  try {
    if (periods.length === 0 || departments.length === 0) return [];

    const periodColumns = periods.map((_, i) =>
      `SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p${i}`
    ).join(',\n      ');

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const deptPlaceholders = departments.map(() => '?').join(', ');

    const query = `
      SELECT
        fd.account,
        ${periodColumns}
      FROM financial_data fd
      WHERE fd.scenario = 'BUD'
        AND fd.ou = ?
        AND fd.version = ?
        AND fd.department IN (${deptPlaceholders})
        AND ${excludeBalanceSheet('fd.account')}
        AND fd.period_combo IN (${periodPlaceholders})
      GROUP BY fd.account
    `;

    const params: any[] = [
      ...periods,                  // for CASE WHEN columns
      ou, version, ...departments,
      ...periods                   // for IN clause
    ];

    const result = await client.execute({ sql: query, args: params });

    return (result.rows as any[]).map(row => {
      const mapped: any = { account: row.account as string };
      for (let i = 0; i < periods.length; i++) {
        mapped[periods[i]] = Number(row[`p${i}`]) || 0;
      }
      return mapped;
    });
  } catch (error) {
    console.error(`Error getting group budget by period:`, error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- GET STAGING VS BUDGET DATA TABLE ---------------------------------------------------------------------------------
export async function getStagingVsBudgetData(ou?: string, version: string = 'MAIN'): Promise<string> {
  try {
    // First, detect the period from staging table
    const periodQuery = `
      SELECT DISTINCT period_combo
      FROM financial_data_staging
      WHERE scenario = 'ACT'
        ${ou ? 'AND ou = ?' : ''}
      LIMIT 1
    `;

    const periodParams = ou ? [ou] : [];
    const periodResult = await client.execute({ sql: periodQuery, args: periodParams });

    if (periodResult.rows.length === 0) {
      return JSON.stringify([]);
    }

    const period = periodResult.rows[0].period_combo as string;

    // Now fetch staging actuals vs budget for this period
    const query = `
      WITH staging_actuals AS (
        SELECT
          fds.dep_acc_combo_id AS combo,
          fds.department,
          fds.account,
          SUM(fds.amount) AS staging_amount
        FROM financial_data_staging fds
        WHERE fds.scenario = 'ACT'
          ${ou ? 'AND fds.ou = ?' : ''}
        GROUP BY fds.dep_acc_combo_id, fds.department, fds.account
      ),
      budget_data AS (
        SELECT
          fd.dep_acc_combo_id AS combo,
          SUM(fd.amount) AS budget_amount
        FROM financial_data fd
        WHERE fd.scenario = 'BUD'
          AND fd.version = ?
          AND fd.period_combo = ?
          ${ou ? 'AND fd.ou = ?' : ''}
        GROUP BY fd.dep_acc_combo_id
      )
      SELECT
        sa.combo,
        am.account_description_detail_level_max AS account_desc,
        am.level_4 AS account_level_4,
        am.level_6 AS account_level_6,
        am.level_9 AS account_level_9,
        dm.level_4 AS department_level_4,
        dm.level_5 AS department_level_5,
        dm.level_7 AS department_level_7,
        COALESCE(sa.staging_amount, 0) AS staging_actual,
        COALESCE(bd.budget_amount, 0) AS budget,
        (COALESCE(sa.staging_amount, 0) - COALESCE(bd.budget_amount, 0)) AS variance
      FROM staging_actuals sa
      LEFT JOIN budget_data bd ON sa.combo = bd.combo
      LEFT JOIN account_maps am ON sa.account = am.base_account
      LEFT JOIN department_maps dm ON sa.department = dm.base_department
      WHERE dm.level_2 = 'Lodging Operations'
        AND am.level_4 = 'Profit Amount'
        AND (sa.staging_amount != 0 OR bd.budget_amount != 0)
      ORDER BY dm.level_4, dm.level_5, dm.level_7, am.level_4, am.level_6, am.level_9
    `;

    // Build params array
    const budgetParams = ou ? [version, period, ou] : [version, period];
    const params = ou ? [ou, ...budgetParams] : budgetParams;

    const resultSet = await client.execute({ sql: query, args: params });
    const rows = resultSet.rows as unknown as any[];

    let idCounter = 1;
    const result = rows.map((row) => ({
      id: idCounter++,
      combo: row.combo,
      account_desc: row.account_desc,
      account_level_4: row.account_level_4,
      account_level_6: row.account_level_6,
      account_level_9: row.account_level_9,
      department_level_4: row.department_level_4,
      department_level_5: row.department_level_5,
      department_level_7: row.department_level_7,
      staging_actual: row.staging_actual || 0,
      budget: row.budget || 0,
      variance: row.variance || 0,
      period: period,
    }));

    return JSON.stringify(result);
  } catch (error) {
    console.error("Error fetching staging vs budget data:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- INSERT BATCH DEPARTMENTS -----------------------------------------------------------------------------------------
// interface defined in common area at the top

export async function insertBatchDepartments(batchData: Department[]) {
  if (!Array.isArray(batchData) || batchData.length === 0) {
    console.error("Batch data must be a non-empty array.");
    return;
  }

  try {
    // Start a transaction for batch insertion
    const queries = batchData.map((item) => {
      return {
        sql: `
            INSERT INTO departments (
              department_id, d_easy_name, d_is_locked, d_level_1, d_level_2, d_level_3,
              d_level_4, d_level_5, d_level_6, d_level_7, d_level_8, d_level_9, d_level_10,
              d_level_11, d_level_12, d_level_13, d_level_14, d_level_15, d_level_16, d_level_17,
              d_level_18, d_level_19, d_level_20, d_level_21, d_level_22, d_level_23, d_level_24,
              d_level_25, d_level_26, d_level_27, d_level_28, d_level_29, d_level_30
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?
            )
          `,
        args: [
          item.department_id,
          item.d_easy_name,
          item.d_is_locked,
          item.d_level_1,
          item.d_level_2,
          item.d_level_3,
          item.d_level_4,
          item.d_level_5,
          item.d_level_6,
          item.d_level_7,
          item.d_level_8,
          item.d_level_9,
          item.d_level_10,
          item.d_level_11,
          item.d_level_12,
          item.d_level_13,
          item.d_level_14,
          item.d_level_15,
          item.d_level_16,
          item.d_level_17,
          item.d_level_18,
          item.d_level_19,
          item.d_level_20,
          item.d_level_21,
          item.d_level_22,
          item.d_level_23,
          item.d_level_24,
          item.d_level_25,
          item.d_level_26,
          item.d_level_27,
          item.d_level_28,
          item.d_level_29,
          item.d_level_30,
        ],
      };
    });

    await client.batch(queries);

    // console.log(`${batchData.length} records inserted successfully.`);
  } catch (error) {
    console.error("Error inserting batch data:", error);
  }
}

//interface defined in common area at the top
export async function insertBatchAccounts(batchData: Account[]) {
  if (!Array.isArray(batchData) || batchData.length === 0) {
    console.error("Batch data must be a non-empty array.");
    return;
  }

  try {
    // Start a transaction for batch insertion
    const queries = batchData.map((item) => {
      return {
        sql: `
            INSERT INTO accounts (
              account_id, a_easy_name, a_is_stat, a_is_locked, a_level_1, a_level_2, a_level_3,
              a_level_4, a_level_5, a_level_6, a_level_7, a_level_8, a_level_9, a_level_10,
              a_level_11, a_level_12, a_level_13, a_level_14, a_level_15, a_level_16, a_level_17,
              a_level_18, a_level_19, a_level_20, a_level_21, a_level_22, a_level_23, a_level_24,
              a_level_25, a_level_26, a_level_27, a_level_28, a_level_29, a_level_30
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?
            )
          `,
        args: [
          item.account_id,
          item.a_easy_name,
          item.a_is_stat,
          item.a_is_locked,
          item.a_level_1,
          item.a_level_2,
          item.a_level_3,
          item.a_level_4,
          item.a_level_5,
          item.a_level_6,
          item.a_level_7,
          item.a_level_8,
          item.a_level_9,
          item.a_level_10,
          item.a_level_11,
          item.a_level_12,
          item.a_level_13,
          item.a_level_14,
          item.a_level_15,
          item.a_level_16,
          item.a_level_17,
          item.a_level_18,
          item.a_level_19,
          item.a_level_20,
          item.a_level_21,
          item.a_level_22,
          item.a_level_23,
          item.a_level_24,
          item.a_level_25,
          item.a_level_26,
          item.a_level_27,
          item.a_level_28,
          item.a_level_29,
          item.a_level_30,
        ],
      };
    });

    await client.batch(queries);

    // console.log(`${batchData.length} records inserted successfully.`);
  } catch (error) {
    console.error("Error inserting batch data:", error);
  }
}

//interface defined in common area at the top

export async function insertBatchDepartmentAccounts(batchData: DepartmentAccount[]) {
  if (!Array.isArray(batchData) || batchData.length === 0) {
    console.error("Batch data must be a non-empty array.");
    return;
  }

  try {
    // Start a transaction for batch insertion
    const queries = batchData.map((item) => {
      return {
        sql: `
            INSERT INTO department_accounts (
              dep_acc_combo_id, department_id, account_id, is_locked
            ) VALUES (
              ?, ?, ?, ?
            )
          `,
        args: [item.dep_acc_combo_id, item.department_id, item.account_id, item.is_locked],
      };
    });

    await client.batch(queries);

    // console.log(`${batchData.length} records inserted successfully.`);
  } catch (error) {
    console.error("Error inserting batch data:", error);
  }
}

//interface defined in common area at the top
export async function insertBatchFinancialData(batchData: FinancialData[]) {
  if (!Array.isArray(batchData) || batchData.length === 0) {
    console.error("Batch data must be a non-empty array.");
    return;
  }

  try {
    // Start a transaction for batch insertion
    const queries = batchData.map((item) => {
      return {
        sql: `
            INSERT INTO financial_data (
              dep_acc_combo_id, month, year, period_combo, scenario, amount, currency,
              ou, department, account, version, last_modified, item_version
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
          `,
        args: [
          item.dep_acc_combo_id,
          item.month,
          item.year,
          item.period_combo,
          item.scenario,
          item.amount,
          item.currency,
          item.ou || null,
          item.department || null,
          item.account || null,
          item.version || null,
          item.last_modified || new Date().toISOString(),
          item.item_version || 1,
        ],
      };
    });

    await client.batch(queries);

    // console.log(`${batchData.length} records inserted successfully.`);
  } catch (error) {
    console.error("Error inserting batch data:", error);
  }
}

export async function GeneratedDummyData() {
  await insertBatchDepartments(departments);
  await insertBatchAccounts(accounts);
  await insertBatchDepartmentAccounts(department_accounts);
  await insertBatchFinancialData(financialData);
  // console.log("Dummy data inserted successfully.");
}

//------------------------------------------------------------------------------------------------------------------
//--- GET ALL ACCOUNTS ---------------------------------------------------------------------------------------------
export async function getAllAccounts(): Promise<string> {
  try {
    const query = `
      SELECT 
        account_id,
        a_easy_name,
        a_is_stat,
        a_is_locked,
        a_level_1, a_level_2, a_level_3, a_level_4, a_level_5,
        a_level_6, a_level_7, a_level_8, a_level_9, a_level_10,
        a_level_11, a_level_12, a_level_13, a_level_14, a_level_15,
        a_level_16, a_level_17, a_level_18, a_level_19, a_level_20,
        a_level_21, a_level_22, a_level_23, a_level_24, a_level_25,
        a_level_26, a_level_27, a_level_28, a_level_29, a_level_30
      FROM accounts
      ORDER BY account_id
    `;

    const resultSet = await client.execute({ sql: query, args: [] });
    const rows = resultSet.rows;

    return JSON.stringify(rows);
  } catch (error) {
    console.error("Error fetching accounts:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- GET ALL DEPARTMENTS ------------------------------------------------------------------------------------------
export async function getAllDepartments(): Promise<string> {
  try {
    const query = `
      SELECT 
        department_id,
        d_easy_name,
        d_is_locked,
        d_level_1, d_level_2, d_level_3, d_level_4, d_level_5,
        d_level_6, d_level_7, d_level_8, d_level_9, d_level_10,
        d_level_11, d_level_12, d_level_13, d_level_14, d_level_15,
        d_level_16, d_level_17, d_level_18, d_level_19, d_level_20,
        d_level_21, d_level_22, d_level_23, d_level_24, d_level_25,
        d_level_26, d_level_27, d_level_28, d_level_29, d_level_30
      FROM departments
      ORDER BY department_id
    `;

    const resultSet = await client.execute({ sql: query, args: [] });
    const rows = resultSet.rows;

    return JSON.stringify(rows);
  } catch (error) {
    console.error("Error fetching departments:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- GET ALL COMBO METADATA --------------------------------------------------------------------------------------
export async function getAllComboMetadata(): Promise<string> {
  try {
    const query = `
      SELECT 
        da.dep_acc_combo_id,
        da.department_id,
        da.account_id,
        da.is_locked,
        d.d_easy_name as department_name,
        a.a_easy_name as account_name,
        d.d_level_1 as dept_level_1, d.d_level_2 as dept_level_2, d.d_level_3 as dept_level_3,
        d.d_level_4 as dept_level_4, d.d_level_5 as dept_level_5, d.d_level_6 as dept_level_6,
        d.d_level_7 as dept_level_7, d.d_level_8 as dept_level_8, d.d_level_9 as dept_level_9,
        d.d_level_10 as dept_level_10, d.d_level_11 as dept_level_11, d.d_level_12 as dept_level_12,
        d.d_level_13 as dept_level_13, d.d_level_14 as dept_level_14, d.d_level_15 as dept_level_15,
        d.d_level_16 as dept_level_16, d.d_level_17 as dept_level_17, d.d_level_18 as dept_level_18,
        d.d_level_19 as dept_level_19, d.d_level_20 as dept_level_20, d.d_level_21 as dept_level_21,
        d.d_level_22 as dept_level_22, d.d_level_23 as dept_level_23, d.d_level_24 as dept_level_24,
        d.d_level_25 as dept_level_25, d.d_level_26 as dept_level_26, d.d_level_27 as dept_level_27,
        d.d_level_28 as dept_level_28, d.d_level_29 as dept_level_29, d.d_level_30 as dept_level_30,
        a.a_level_1 as acc_level_1, a.a_level_2 as acc_level_2, a.a_level_3 as acc_level_3,
        a.a_level_4 as acc_level_4, a.a_level_5 as acc_level_5, a.a_level_6 as acc_level_6,
        a.a_level_7 as acc_level_7, a.a_level_8 as acc_level_8, a.a_level_9 as acc_level_9,
        a.a_level_10 as acc_level_10, a.a_level_11 as acc_level_11, a.a_level_12 as acc_level_12,
        a.a_level_13 as acc_level_13, a.a_level_14 as acc_level_14, a.a_level_15 as acc_level_15,
        a.a_level_16 as acc_level_16, a.a_level_17 as acc_level_17, a.a_level_18 as acc_level_18,
        a.a_level_19 as acc_level_19, a.a_level_20 as acc_level_20, a.a_level_21 as acc_level_21,
        a.a_level_22 as acc_level_22, a.a_level_23 as acc_level_23, a.a_level_24 as acc_level_24,
        a.a_level_25 as acc_level_25, a.a_level_26 as acc_level_26, a.a_level_27 as acc_level_27,
        a.a_level_28 as acc_level_28, a.a_level_29 as acc_level_29, a.a_level_30 as acc_level_30
      FROM department_accounts da
      JOIN departments d ON da.department_id = d.department_id
      JOIN accounts a ON da.account_id = a.account_id
      ORDER BY da.dep_acc_combo_id
    `;

    const resultSet = await client.execute({ sql: query, args: [] });
    const rows = resultSet.rows;

    return JSON.stringify(rows);
  } catch (error) {
    console.error("Error fetching combo metadata:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- CREATE NEW ACCOUNT ------------------------------------------------------------------------------------------
export async function createAccount(accountData: Account): Promise<string> {
  try {
    const query = `
      INSERT INTO accounts (
        account_id, a_easy_name, a_is_stat, a_is_locked,
        a_level_1, a_level_2, a_level_3, a_level_4, a_level_5,
        a_level_6, a_level_7, a_level_8, a_level_9, a_level_10,
        a_level_11, a_level_12, a_level_13, a_level_14, a_level_15,
        a_level_16, a_level_17, a_level_18, a_level_19, a_level_20,
        a_level_21, a_level_22, a_level_23, a_level_24, a_level_25,
        a_level_26, a_level_27, a_level_28, a_level_29, a_level_30
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `;

    await client.execute({
      sql: query,
      args: [
        accountData.account_id,
        accountData.a_easy_name,
        accountData.a_is_stat,
        accountData.a_is_locked,
        accountData.a_level_1 || null,
        accountData.a_level_2 || null,
        accountData.a_level_3 || null,
        accountData.a_level_4 || null,
        accountData.a_level_5 || null,
        accountData.a_level_6 || null,
        accountData.a_level_7 || null,
        accountData.a_level_8 || null,
        accountData.a_level_9 || null,
        accountData.a_level_10 || null,
        accountData.a_level_11 || null,
        accountData.a_level_12 || null,
        accountData.a_level_13 || null,
        accountData.a_level_14 || null,
        accountData.a_level_15 || null,
        accountData.a_level_16 || null,
        accountData.a_level_17 || null,
        accountData.a_level_18 || null,
        accountData.a_level_19 || null,
        accountData.a_level_20 || null,
        accountData.a_level_21 || null,
        accountData.a_level_22 || null,
        accountData.a_level_23 || null,
        accountData.a_level_24 || null,
        accountData.a_level_25 || null,
        accountData.a_level_26 || null,
        accountData.a_level_27 || null,
        accountData.a_level_28 || null,
        accountData.a_level_29 || null,
        accountData.a_level_30 || null,
      ]
    });

    return JSON.stringify({ success: true, message: "Account created successfully" });
  } catch (error) {
    console.error("Error creating account:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- CREATE NEW DEPARTMENT ---------------------------------------------------------------------------------------
export async function createDepartment(departmentData: Department): Promise<string> {
  try {
    const query = `
      INSERT INTO departments (
        department_id, d_easy_name, d_is_locked,
        d_level_1, d_level_2, d_level_3, d_level_4, d_level_5,
        d_level_6, d_level_7, d_level_8, d_level_9, d_level_10,
        d_level_11, d_level_12, d_level_13, d_level_14, d_level_15,
        d_level_16, d_level_17, d_level_18, d_level_19, d_level_20,
        d_level_21, d_level_22, d_level_23, d_level_24, d_level_25,
        d_level_26, d_level_27, d_level_28, d_level_29, d_level_30
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `;

    await client.execute({
      sql: query,
      args: [
        departmentData.department_id,
        departmentData.d_easy_name,
        departmentData.d_is_locked,
        departmentData.d_level_1 || null,
        departmentData.d_level_2 || null,
        departmentData.d_level_3 || null,
        departmentData.d_level_4 || null,
        departmentData.d_level_5 || null,
        departmentData.d_level_6 || null,
        departmentData.d_level_7 || null,
        departmentData.d_level_8 || null,
        departmentData.d_level_9 || null,
        departmentData.d_level_10 || null,
        departmentData.d_level_11 || null,
        departmentData.d_level_12 || null,
        departmentData.d_level_13 || null,
        departmentData.d_level_14 || null,
        departmentData.d_level_15 || null,
        departmentData.d_level_16 || null,
        departmentData.d_level_17 || null,
        departmentData.d_level_18 || null,
        departmentData.d_level_19 || null,
        departmentData.d_level_20 || null,
        departmentData.d_level_21 || null,
        departmentData.d_level_22 || null,
        departmentData.d_level_23 || null,
        departmentData.d_level_24 || null,
        departmentData.d_level_25 || null,
        departmentData.d_level_26 || null,
        departmentData.d_level_27 || null,
        departmentData.d_level_28 || null,
        departmentData.d_level_29 || null,
        departmentData.d_level_30 || null,
      ]
    });

    return JSON.stringify({ success: true, message: "Department created successfully" });
  } catch (error) {
    console.error("Error creating department:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- USER SETTINGS FUNCTIONS -------------------------------------------------------------------------------------
// Interface for user settings
interface UserSettings {
  themeMode?: "light" | "dark";
  selectedHotelOu?: string | null;
  permanentSalt?: string;
  [key: string]: any;
}

// Storage keys for the permanent device salt.
//   - PERMANENT_SALT_KEY:     legacy plaintext (kept as a fallback for machines
//                             where OS-level encryption is unavailable).
//   - PERMANENT_SALT_ENC_KEY: base64 of the DPAPI (safeStorage) ciphertext.
const PERMANENT_SALT_KEY = 'permanentSalt';
const PERMANENT_SALT_ENC_KEY = 'permanentSaltEnc';

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
    if (typeof parsed === 'string') return parsed;
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
        const plaintext = safeStorage.decryptString(Buffer.from(encRaw, 'base64'));
        if (plaintext) return plaintext;
      } catch (error) {
        // Blob unreadable (e.g. Windows profile/credential loss). Fall through:
        // recover from a plaintext copy if one still exists, otherwise the
        // orphan guard below prevents silently minting a replacement.
        console.warn('[salt] Failed to decrypt permanentSaltEnc:', error);
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
          const blob = safeStorage.encryptString(salt).toString('base64');
          await writeSaltSetting(PERMANENT_SALT_ENC_KEY, blob);
          await writeSaltSetting(PERMANENT_SALT_KEY, ''); // blank the plaintext
          // console.log('[salt] Migrated permanent salt to DPAPI-encrypted storage.');
        } catch (error) {
          // Migration failed — keep serving the plaintext salt as-is.
          console.warn('[salt] Salt encryption migration failed:', error);
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
        'permanentSaltEnc present but undecryptable and no plaintext fallback'
      );
    }

    // 4) True first run on this machine: mint a new salt.
    const crypto = await import('crypto');
    const newSalt = crypto.randomBytes(16).toString('hex');

    if (dpapi) {
      try {
        const blob = safeStorage.encryptString(newSalt).toString('base64');
        await writeSaltSetting(PERMANENT_SALT_ENC_KEY, blob);
      } catch (error) {
        // Encryption failed at mint time — persist plaintext so the value is
        // durable; a later launch can migrate it once encryption works.
        console.warn('[salt] Failed to encrypt new salt, storing plaintext:', error);
        await writeSaltSetting(PERMANENT_SALT_KEY, newSalt);
      }
    } else {
      await writeSaltSetting(PERMANENT_SALT_KEY, newSalt);
    }

    return newSalt;
  } catch (error) {
    console.error('Error getting/creating permanent salt:', error);
    throw error;
  }
}

// Get a specific setting or all settings
export async function getUserSettings(key?: string): Promise<string> {
  try {
    if (key) {
      // Get specific setting
      const result = await client.execute({
        sql: "SELECT value FROM user_settings WHERE key = ?",
        args: [key]
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
        args: []
      });

      const settings: UserSettings = {};
      for (const row of result.rows) {
        const key = row.key as string;
        const value = row.value as string;
        try {
          settings[key] = JSON.parse(value);
        } catch {
          settings[key] = value;
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
      args: [key, JSON.stringify(value)]
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
      args: [key]
    });
    return JSON.stringify({ success: true, message: "Setting deleted successfully" });
  } catch (error) {
    console.error("Error deleting user setting:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- IMPORT COMPLETION STATE FUNCTIONS ---------------------------------------------------------------------------
// Get import completion state for a specific OU
export async function getImportCompletedState(ou: string): Promise<boolean> {
  try {
    const key = `import_completed_${ou}`;
    const result = await client.execute({
      sql: "SELECT value FROM user_settings WHERE key = ?",
      args: [key]
    });

    if (result.rows.length > 0) {
      const value = result.rows[0].value as string;
      return value === 'true';
    }
    return false; // Default to false if not set
  } catch (error) {
    console.error("Error getting import completed state:", error);
    return false;
  }
}

// Set import completion state for a specific OU
export async function setImportCompletedState(ou: string, completed: boolean): Promise<void> {
  try {
    const key = `import_completed_${ou}`;
    await client.execute({
      sql: `
        INSERT INTO user_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `,
      args: [key, completed.toString()]
    });
    // console.log(`Import completed state set to ${completed} for OU: ${ou}`);
  } catch (error) {
    console.error("Error setting import completed state:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- VALIDATION COMPLETION STATE FUNCTIONS -----------------------------------------------------------------------
// Get validation completion state for a specific OU
export async function getValidationCompletedState(ou: string): Promise<boolean> {
  try {
    const key = `validation_completed_${ou}`;
    const result = await client.execute({
      sql: "SELECT value FROM user_settings WHERE key = ?",
      args: [key]
    });

    if (result.rows.length > 0) {
      return result.rows[0].value === 'true';
    }
    return false; // Default to false if not set
  } catch (error) {
    console.error("Error getting validation completed state:", error);
    return false;
  }
}

// Set validation completion state for a specific OU
export async function setValidationCompletedState(ou: string, completed: boolean): Promise<void> {
  try {
    const key = `validation_completed_${ou}`;
    await client.execute({
      sql: `
        INSERT INTO user_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `,
      args: [key, completed.toString()]
    });
    // console.log(`Validation completed state set to ${completed} for OU: ${ou}`);
  } catch (error) {
    console.error("Error setting validation completed state:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- SIGN-OFF COMPLETION STATE FUNCTIONS -------------------------------------------------------------------------
// Get sign-off completion state for a specific OU
export async function getSignOffCompletedState(ou: string): Promise<boolean> {
  try {
    const key = `signoff_completed_${ou}`;
    const result = await client.execute({
      sql: "SELECT value FROM user_settings WHERE key = ?",
      args: [key]
    });

    if (result.rows.length > 0) {
      return result.rows[0].value === 'true';
    }
    return false; // Default to false if not set
  } catch (error) {
    console.error("Error getting sign-off completed state:", error);
    return false;
  }
}

// Set sign-off completion state for a specific OU
export async function setSignOffCompletedState(ou: string, completed: boolean): Promise<void> {
  try {
    const key = `signoff_completed_${ou}`;
    await client.execute({
      sql: `
        INSERT INTO user_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `,
      args: [key, completed.toString()]
    });
    // console.log(`Sign-off completed state set to ${completed} for OU: ${ou}`);
  } catch (error) {
    console.error("Error setting sign-off completed state:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- SELECTED PERIOD PER OU FUNCTIONS ----------------------------------------------------------------------------
// Get the selected period for a specific OU (persisted across app restarts)
export async function getSelectedPeriodForOU(ou: string): Promise<string | null> {
  try {
    const key = `selected_period_${ou}`;
    const result = await client.execute({
      sql: "SELECT value FROM user_settings WHERE key = ?",
      args: [key]
    });

    if (result.rows.length > 0) {
      const value = result.rows[0].value as string;
      return value || null;
    }
    return null;
  } catch (error) {
    console.error("Error getting selected period for OU:", error);
    return null;
  }
}

// Set the selected period for a specific OU
export async function setSelectedPeriodForOU(ou: string, period: string | null): Promise<void> {
  try {
    const key = `selected_period_${ou}`;
    if (period === null) {
      // Clear the period
      await client.execute({
        sql: "DELETE FROM user_settings WHERE key = ?",
        args: [key]
      });
    } else {
      await client.execute({
        sql: `
          INSERT INTO user_settings (key, value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        `,
        args: [key, period]
      });
    }
  } catch (error) {
    console.error("Error setting selected period for OU:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- RESET ALL COMPLETION STATES ---------------------------------------------------------------------------------
// Reset all completion states and clear cached data for a specific OU
export async function resetAllCompletionStates(ou: string): Promise<void> {
  try {
    // Clear all completion state flags
    await setImportCompletedState(ou, false);
    await setValidationCompletedState(ou, false);
    await setSignOffCompletedState(ou, false);

    // Clear the selected period for this OU
    await setSelectedPeriodForOU(ou, null);

    // Clear cached import data (staging table)
    await client.execute({
      sql: "DELETE FROM financial_data_staging WHERE ou = ?",
      args: [ou]
    });

    // console.log(`All completion states and cached data cleared for OU: ${ou}`);
  } catch (error) {
    console.error("Error resetting completion states:", error);
    throw error;
  }
}

export async function resetAllCompletionStatesAllOUs(): Promise<void> {
  try {
    // Get all distinct OUs from the staging table
    const result = await client.execute({
      sql: "SELECT DISTINCT ou FROM financial_data_staging",
      args: []
    });

    // Clear completion states and selected period for each OU
    for (const row of result.rows) {
      const ou = row.ou as string;
      await setImportCompletedState(ou, false);
      await setValidationCompletedState(ou, false);
      await setSignOffCompletedState(ou, false);
      await setSelectedPeriodForOU(ou, null);
    }

    // Clear entire staging table
    await client.execute({
      sql: "DELETE FROM financial_data_staging",
      args: []
    });
  } catch (error) {
    console.error("Error resetting completion states for all OUs:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- HOTELS CACHE FUNCTIONS --------------------------------------------------------------------------------------
// Interface for cached hotel data
interface CachedHotel {
  ou: string;
  hotel_name: string;
  room_count: number;
  currency?: string;
  country?: string;
  city?: string;
  local_id_1?: string;
  local_id_2?: string;
  local_id_3?: string;
  cached_at?: string;
}

// Get all cached hotels
export async function getCachedHotels(): Promise<string> {
  try {
    const result = await client.execute({
      sql: "SELECT ou, hotel_name, room_count, currency, country, city, local_id_1, local_id_2, local_id_3, cached_at FROM hotels_cache ORDER BY hotel_name",
      args: []
    });

    const hotels = result.rows.map(row => ({
      ou: row.ou as string,
      hotel_name: row.hotel_name as string,
      room_count: row.room_count as number,
      currency: row.currency as string | null,
      country: row.country as string | null,
      city: row.city as string | null,
      local_id_1: row.local_id_1 as string | null,
      local_id_2: row.local_id_2 as string | null,
      local_id_3: row.local_id_3 as string | null,
      cached_at: row.cached_at as string
    }));

    return JSON.stringify(hotels);
  } catch (error) {
    console.error("Error getting cached hotels:", error);
    // Return empty array if table doesn't exist or other error
    return JSON.stringify([]);
  }
}

// Get hotel name by OU from cache
export async function getHotelNameByOU(ou: string): Promise<string | null> {
  try {
    const result = await client.execute({
      sql: "SELECT hotel_name FROM hotels_cache WHERE ou = ?",
      args: [ou]
    });
    if (result.rows.length > 0) {
      return result.rows[0].hotel_name as string;
    }
    return null;
  } catch (error) {
    console.error("Error getting hotel name by OU:", error);
    return null;
  }
}

// Cache hotels data
export async function cacheHotels(hotels: CachedHotel[]): Promise<string> {
  try {
    // Clear existing cache first
    await client.execute({
      sql: "DELETE FROM hotels_cache",
      args: []
    });

    // Insert new data
    if (hotels.length > 0) {
      const queries = hotels.map(hotel => ({
        sql: `
          INSERT INTO hotels_cache (ou, hotel_name, room_count, currency, country, city, local_id_1, local_id_2, local_id_3, cached_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `,
        args: [
          hotel.ou,
          hotel.hotel_name,
          hotel.room_count,
          hotel.currency || null,
          hotel.country || null,
          hotel.city || null,
          hotel.local_id_1 || null,
          hotel.local_id_2 || null,
          hotel.local_id_3 || null
        ]
      }));

      await client.batch(queries);
    }

    return JSON.stringify({ success: true, message: "Hotels cached successfully" });
  } catch (error) {
    console.error("Error caching hotels:", error);
    throw error;
  }
}

// Clear hotels cache
export async function clearHotelsCache(): Promise<string> {
  try {
    await client.execute({
      sql: "DELETE FROM hotels_cache",
      args: []
    });
    return JSON.stringify({ success: true, message: "Hotels cache cleared" });
  } catch (error) {
    console.error("Error clearing hotels cache:", error);
    throw error;
  }
}

// Check if cache is expired (default: 24 hours)
export async function isHotelsCacheExpired(hoursThreshold: number = 24): Promise<boolean> {
  try {
    const result = await client.execute({
      sql: `
        SELECT cached_at FROM hotels_cache
        ORDER BY cached_at DESC
        LIMIT 1
      `,
      args: []
    });

    if (result.rows.length === 0) {
      return true; // No cache exists
    }

    const cachedAt = new Date(result.rows[0].cached_at as string);
    const now = new Date();
    const hoursDiff = (now.getTime() - cachedAt.getTime()) / (1000 * 60 * 60);

    return hoursDiff > hoursThreshold;
  } catch (error) {
    console.error("Error checking cache expiry:", error);
    return true; // Assume expired on error
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- CREATE NEW COMBO --------------------------------------------------------------------------------------------
export async function createCombo(comboData: DepartmentAccount): Promise<string> {
  try {
    const query = `
      INSERT INTO department_accounts (
        dep_acc_combo_id, department_id, account_id, is_locked
      ) VALUES (?, ?, ?, ?)
    `;

    await client.execute({
      sql: query,
      args: [
        comboData.dep_acc_combo_id,
        comboData.department_id,
        comboData.account_id,
        comboData.is_locked
      ]
    });

    return JSON.stringify({ success: true, message: "Combo created successfully" });
  } catch (error) {
    console.error("Error creating combo:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- DUMMY DATA ---------------------------------------------------------------------------------------------------

const department_accounts = [
  {
    dep_acc_combo_id: "D0010_A300001",
    department_id: "D0010",
    account_id: "A300001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0010_A300002",
    department_id: "D0010",
    account_id: "A300002",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0010_A400001",
    department_id: "D0010",
    account_id: "A400001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0010_A500001",
    department_id: "D0010",
    account_id: "A500001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0010_A600001",
    department_id: "D0010",
    account_id: "A600001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0011_A400001",
    department_id: "D0011",
    account_id: "A400001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0011_A500001",
    department_id: "D0011",
    account_id: "A500001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0011_A600001",
    department_id: "D0011",
    account_id: "A600001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0410_A500001",
    department_id: "D0410",
    account_id: "A500001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0410_A600001",
    department_id: "D0410",
    account_id: "A600001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0440_A600001",
    department_id: "D0440",
    account_id: "A600001",
    is_locked: 0,
  },
  {
    dep_acc_combo_id: "D0440_A500001",
    department_id: "D0440",
    account_id: "A500001",
    is_locked: 0,
  },
];

const accounts = [
  {
    account_id: "A300001",
    a_easy_name: "Rooms Revenue",
    a_is_stat: 0,
    a_is_locked: 0,
    a_level_1: "Accounts",
    a_level_2: "Revenue",
    a_level_3: "",
    a_level_4: "",
    a_level_5: "",
    a_level_6: "",
    a_level_7: "",
    a_level_8: "",
    a_level_9: "",
    a_level_10: "",
    a_level_11: "",
    a_level_12: "",
    a_level_13: "",
    a_level_14: "",
    a_level_15: "",
    a_level_16: "",
    a_level_17: "",
    a_level_18: "",
    a_level_19: "",
    a_level_20: "",
    a_level_21: "",
    a_level_22: "",
    a_level_23: "",
    a_level_24: "",
    a_level_25: "",
    a_level_26: "",
    a_level_27: "",
    a_level_28: "",
    a_level_29: "",
    a_level_30: "",
  },
  {
    account_id: "A300002",
    a_easy_name: "Food Revenue",
    a_is_stat: 0,
    a_is_locked: 0,
    a_level_1: "Accounts",
    a_level_2: "Revenue",
    a_level_3: "",
    a_level_4: "",
    a_level_5: "",
    a_level_6: "",
    a_level_7: "",
    a_level_8: "",
    a_level_9: "",
    a_level_10: "",
    a_level_11: "",
    a_level_12: "",
    a_level_13: "",
    a_level_14: "",
    a_level_15: "",
    a_level_16: "",
    a_level_17: "",
    a_level_18: "",
    a_level_19: "",
    a_level_20: "",
    a_level_21: "",
    a_level_22: "",
    a_level_23: "",
    a_level_24: "",
    a_level_25: "",
    a_level_26: "",
    a_level_27: "",
    a_level_28: "",
    a_level_29: "",
    a_level_30: "",
  },
  {
    account_id: "A400001",
    a_easy_name: "Cost of Food",
    a_is_stat: 0,
    a_is_locked: 0,
    a_level_1: "Accounts",
    a_level_2: "Costs",
    a_level_3: "",
    a_level_4: "",
    a_level_5: "",
    a_level_6: "",
    a_level_7: "",
    a_level_8: "",
    a_level_9: "",
    a_level_10: "",
    a_level_11: "",
    a_level_12: "",
    a_level_13: "",
    a_level_14: "",
    a_level_15: "",
    a_level_16: "",
    a_level_17: "",
    a_level_18: "",
    a_level_19: "",
    a_level_20: "",
    a_level_21: "",
    a_level_22: "",
    a_level_23: "",
    a_level_24: "",
    a_level_25: "",
    a_level_26: "",
    a_level_27: "",
    a_level_28: "",
    a_level_29: "",
    a_level_30: "",
  },
  {
    account_id: "A500001",
    a_easy_name: "Payroll",
    a_is_stat: 0,
    a_is_locked: 0,
    a_level_1: "Accounts",
    a_level_2: "Costs",
    a_level_3: "",
    a_level_4: "",
    a_level_5: "",
    a_level_6: "",
    a_level_7: "",
    a_level_8: "",
    a_level_9: "",
    a_level_10: "",
    a_level_11: "",
    a_level_12: "",
    a_level_13: "",
    a_level_14: "",
    a_level_15: "",
    a_level_16: "",
    a_level_17: "",
    a_level_18: "",
    a_level_19: "",
    a_level_20: "",
    a_level_21: "",
    a_level_22: "",
    a_level_23: "",
    a_level_24: "",
    a_level_25: "",
    a_level_26: "",
    a_level_27: "",
    a_level_28: "",
    a_level_29: "",
    a_level_30: "",
  },
  {
    account_id: "A600001",
    a_easy_name: "Controlables",
    a_is_stat: 0,
    a_is_locked: 0,
    a_level_1: "Accounts",
    a_level_2: "Costs",
    a_level_3: "",
    a_level_4: "",
    a_level_5: "",
    a_level_6: "",
    a_level_7: "",
    a_level_8: "",
    a_level_9: "",
    a_level_10: "",
    a_level_11: "",
    a_level_12: "",
    a_level_13: "",
    a_level_14: "",
    a_level_15: "",
    a_level_16: "",
    a_level_17: "",
    a_level_18: "",
    a_level_19: "",
    a_level_20: "",
    a_level_21: "",
    a_level_22: "",
    a_level_23: "",
    a_level_24: "",
    a_level_25: "",
    a_level_26: "",
    a_level_27: "",
    a_level_28: "",
    a_level_29: "",
    a_level_30: "",
  },
];

const departments = [
  {
    department_id: "D0010",
    d_easy_name: "Reception",
    d_is_locked: 0,
    d_level_1: "Departments",
    d_level_2: "Profit",
    d_level_3: "Rooms",
    d_level_4: "",
    d_level_5: "",
    d_level_6: "",
    d_level_7: "",
    d_level_8: "",
    d_level_9: "",
    d_level_10: "",
    d_level_11: "",
    d_level_12: "",
    d_level_13: "",
    d_level_14: "",
    d_level_15: "",
    d_level_16: "",
    d_level_17: "",
    d_level_18: "",
    d_level_19: "",
    d_level_20: "",
    d_level_21: "",
    d_level_22: "",
    d_level_23: "",
    d_level_24: "",
    d_level_25: "",
    d_level_26: "",
    d_level_27: "",
    d_level_28: "",
    d_level_29: "",
    d_level_30: "",
  },
  {
    department_id: "D0011",
    d_easy_name: "Housekeeping",
    d_is_locked: 0,
    d_level_1: "Departments",
    d_level_2: "Profit",
    d_level_3: "Rooms",
    d_level_4: "",
    d_level_5: "",
    d_level_6: "",
    d_level_7: "",
    d_level_8: "",
    d_level_9: "",
    d_level_10: "",
    d_level_11: "",
    d_level_12: "",
    d_level_13: "",
    d_level_14: "",
    d_level_15: "",
    d_level_16: "",
    d_level_17: "",
    d_level_18: "",
    d_level_19: "",
    d_level_20: "",
    d_level_21: "",
    d_level_22: "",
    d_level_23: "",
    d_level_24: "",
    d_level_25: "",
    d_level_26: "",
    d_level_27: "",
    d_level_28: "",
    d_level_29: "",
    d_level_30: "",
  },
  {
    department_id: "D0410",
    d_easy_name: "Admin & General",
    d_is_locked: 0,
    d_level_1: "Departments",
    d_level_2: "Profit",
    d_level_3: "Undistributed",
    d_level_4: "",
    d_level_5: "",
    d_level_6: "",
    d_level_7: "",
    d_level_8: "",
    d_level_9: "",
    d_level_10: "",
    d_level_11: "",
    d_level_12: "",
    d_level_13: "",
    d_level_14: "",
    d_level_15: "",
    d_level_16: "",
    d_level_17: "",
    d_level_18: "",
    d_level_19: "",
    d_level_20: "",
    d_level_21: "",
    d_level_22: "",
    d_level_23: "",
    d_level_24: "",
    d_level_25: "",
    d_level_26: "",
    d_level_27: "",
    d_level_28: "",
    d_level_29: "",
    d_level_30: "",
  },
  {
    department_id: "D0440",
    d_easy_name: "Finance",
    d_is_locked: 0,
    d_level_1: "Departments",
    d_level_2: "Profit",
    d_level_3: "Undistributed",
    d_level_4: "",
    d_level_5: "",
    d_level_6: "",
    d_level_7: "",
    d_level_8: "",
    d_level_9: "",
    d_level_10: "",
    d_level_11: "",
    d_level_12: "",
    d_level_13: "",
    d_level_14: "",
    d_level_15: "",
    d_level_16: "",
    d_level_17: "",
    d_level_18: "",
    d_level_19: "",
    d_level_20: "",
    d_level_21: "",
    d_level_22: "",
    d_level_23: "",
    d_level_24: "",
    d_level_25: "",
    d_level_26: "",
    d_level_27: "",
    d_level_28: "",
    d_level_29: "",
    d_level_30: "",
  },
];

const financialData = department_accounts.flatMap((depAcc) => {
  return [2023, 2024, 2025, 2026].flatMap((year) => {
    return Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
      const monthPadded = String(month).padStart(2, "0"); // Ensures months in period_combo are 01, 02, ..., 12
      return {
        dep_acc_combo_id: depAcc.dep_acc_combo_id,
        month, // Integer month: 1, 2, ..., 12
        year,
        period_combo: `${year}-${monthPadded}`, // Ensures YYYY-MM format
        scenario: "ACT",
        amount: Math.round(Math.random() * 1000),
        count: Math.round(Math.random() * 100),
        currency: "USD",
        last_modified: new Date().toISOString(),
        item_version: 1,
      };
    });
  });
});

//------------------------------------------------------------------------------------------------------------------
//----------------- MAPPING CONFIG FUNCTIONS ---------------------------------------------------------------------

// Store mapping config in database
export async function storeMappingConfig(config: {
  config_id: number;
  version: string;
  is_locked: boolean;
  description: string;
  created_at: string;
  updated_at: string;
}): Promise<void> {
  try {
    await client.execute({
      sql: `
        INSERT OR REPLACE INTO mapping_configs (
          config_id, version, is_locked, description,
          created_at, updated_at, last_synced
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
      args: [
        config.config_id,
        config.version,
        config.is_locked ? 1 : 0,
        config.description,
        config.created_at,
        config.updated_at,
      ],
    });
    // console.log("Mapping config stored successfully");
  } catch (error) {
    console.error("Error storing mapping config:", error);
    throw error;
  }
}

// Retrieve mapping config from database
export async function getMappingConfig(configId: number): Promise<MappingConfig | null> {
  try {
    const result = await client.execute({
      sql: `
        SELECT config_id, version, is_locked, description,
               created_at, updated_at, last_synced
        FROM mapping_configs
        WHERE config_id = ?
      `,
      args: [configId],
    });

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        config_id: row.config_id as number,
        version: row.version as string,
        is_locked: Boolean(row.is_locked),
        description: row.description as string,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        last_synced: row.last_synced as string,
      };
    }
    return null;
  } catch (error) {
    console.error("Error retrieving mapping config:", error);
    throw error;
  }
}

// Get all mapping configs
export async function getAllMappingConfigs(): Promise<MappingConfig[]> {
  try {
    const result = await client.execute({
      sql: `
        SELECT config_id, version, is_locked, description,
               created_at, updated_at, last_synced
        FROM mapping_configs
        ORDER BY config_id
      `,
      args: [],
    });

    return result.rows.map((row) => ({
      config_id: row.config_id as number,
      version: row.version as string,
      is_locked: Boolean(row.is_locked),
      description: row.description as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      last_synced: row.last_synced as string,
    }));
  } catch (error) {
    console.error("Error retrieving all mapping configs:", error);
    throw error;
  }
}

// Update last synced timestamp for a config
export async function updateMappingConfigSyncTime(configId: number): Promise<void> {
  try {
    await client.execute({
      sql: `
        UPDATE mapping_configs
        SET last_synced = CURRENT_TIMESTAMP
        WHERE config_id = ?
      `,
      args: [configId],
    });
  } catch (error) {
    console.error("Error updating mapping config sync time:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- MAPPING FUNCTIONS ----------------------------------------------------------------------------

// Replace all mappings for a specific config (deletes existing and inserts new)
export async function replaceMappings(configId: number, mappings: Array<{
  id: number;
  mapping_config_id: number;
  source_account: string | null;
  source_department: string | null;
  source_account_department: string | null;
  target_account: string | null;
  target_department: string | null;
  target_account_department: string | null;
  priority: number;
  is_active: boolean;
  approval_status?: ApprovalStatus;
  approved_by?: string | null;
  approved_at?: string | null;
}>): Promise<void> {
  try {
    // Start a transaction to ensure atomicity
    await client.execute("BEGIN TRANSACTION");

    try {
      // Delete existing mappings for this config
      await client.execute({
        sql: "DELETE FROM mappings WHERE mapping_config_id = ?",
        args: [configId],
      });

      // Insert new mappings
      for (const mapping of mappings) {
        await client.execute({
          sql: `
            INSERT INTO mappings (
              id, mapping_config_id, source_account, source_department,
              source_account_department, target_account, target_department,
              target_account_department, priority, is_active,
              approval_status, approved_by, approved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          args: [
            mapping.id,
            mapping.mapping_config_id,
            mapping.source_account,
            mapping.source_department,
            mapping.source_account_department,
            mapping.target_account,
            mapping.target_department,
            mapping.target_account_department,
            mapping.priority,
            mapping.is_active ? 1 : 0,
            mapping.approval_status || 'APPROVED',
            mapping.approved_by || null,
            mapping.approved_at || null,
          ],
        });
      }

      // Commit transaction
      await client.execute("COMMIT");
      // console.log(`Successfully replaced ${mappings.length} mappings for config ${configId}`);
    } catch (error) {
      // Rollback on error
      await client.execute("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error("Error replacing mappings:", error);
    throw error;
  }
}

// Get all mappings for a specific config
export async function getMappings(configId: number): Promise<Mapping[]> {
  try {
    const result = await client.execute({
      sql: `
        SELECT id, mapping_config_id, source_account, source_department,
               source_account_department, target_account, target_department,
               target_account_department, priority, is_active,
               approval_status, approved_by, approved_at
        FROM mappings
        WHERE mapping_config_id = ?
        ORDER BY priority DESC, id
      `,
      args: [configId],
    });

    return result.rows.map((row) => ({
      id: row.id as number,
      mapping_config_id: row.mapping_config_id as number,
      source_account: row.source_account as string | null,
      source_department: row.source_department as string | null,
      source_account_department: row.source_account_department as string | null,
      target_account: row.target_account as string | null,
      target_department: row.target_department as string | null,
      target_account_department: row.target_account_department as string | null,
      priority: row.priority as number,
      is_active: Boolean(row.is_active),
      approval_status: (row.approval_status as ApprovalStatus) || 'APPROVED',
      approved_by: row.approved_by as string | null,
      approved_at: row.approved_at as string | null,
    }));
  } catch (error) {
    console.error("Error retrieving mappings:", error);
    throw error;
  }
}

// Get mapping count for a specific config
export async function getMappingCount(configId: number): Promise<number> {
  try {
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) as count
        FROM mappings
        WHERE mapping_config_id = ?
      `,
      args: [configId],
    });

    return result.rows[0].count as number;
  } catch (error) {
    console.error("Error getting mapping count:", error);
    throw error;
  }
}

// Find mapping by source account and department
export async function findMapping(
  configId: number,
  sourceAccount: string | null,
  sourceDepartment: string | null,
  includeUnapproved: boolean = false
): Promise<Mapping | null> {
  try {
    // Build the approval status filter - by default only return APPROVED mappings
    const approvalFilter = includeUnapproved ? '' : "AND approval_status = 'APPROVED'";

    const result = await client.execute({
      sql: `
        SELECT id, mapping_config_id, source_account, source_department,
               source_account_department, target_account, target_department,
               target_account_department, priority, is_active,
               approval_status, approved_by, approved_at
        FROM mappings
        WHERE mapping_config_id = ?
          AND (source_account = ? OR (source_account IS NULL AND ? IS NULL))
          AND (source_department = ? OR (source_department IS NULL AND ? IS NULL))
          AND is_active = 1
          ${approvalFilter}
        ORDER BY priority DESC, id
        LIMIT 1
      `,
      args: [configId, sourceAccount, sourceAccount, sourceDepartment, sourceDepartment],
    });

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: row.id as number,
        mapping_config_id: row.mapping_config_id as number,
        source_account: row.source_account as string | null,
        source_department: row.source_department as string | null,
        source_account_department: row.source_account_department as string | null,
        target_account: row.target_account as string | null,
        target_department: row.target_department as string | null,
        target_account_department: row.target_account_department as string | null,
        priority: row.priority as number,
        is_active: Boolean(row.is_active),
        approval_status: (row.approval_status as ApprovalStatus) || 'APPROVED',
        approved_by: row.approved_by as string | null,
        approved_at: row.approved_at as string | null,
      };
    }
    return null;
  } catch (error) {
    console.error("Error finding mapping:", error);
    throw error;
  }
}

// Get mappings by approval status
export async function getMappingsByApprovalStatus(
  configId: number | null,
  approvalStatus: ApprovalStatus
): Promise<Mapping[]> {
  try {
    let sql = `
      SELECT id, mapping_config_id, source_account, source_department,
             source_account_department, target_account, target_department,
             target_account_department, priority, is_active,
             approval_status, approved_by, approved_at
      FROM mappings
      WHERE approval_status = ?
    `;
    const args: (number | string)[] = [approvalStatus];

    if (configId !== null) {
      sql += ' AND mapping_config_id = ?';
      args.push(configId);
    }

    sql += ' ORDER BY mapping_config_id, priority DESC, id';

    const result = await client.execute({ sql, args });

    return result.rows.map((row) => ({
      id: row.id as number,
      mapping_config_id: row.mapping_config_id as number,
      source_account: row.source_account as string | null,
      source_department: row.source_department as string | null,
      source_account_department: row.source_account_department as string | null,
      target_account: row.target_account as string | null,
      target_department: row.target_department as string | null,
      target_account_department: row.target_account_department as string | null,
      priority: row.priority as number,
      is_active: Boolean(row.is_active),
      approval_status: (row.approval_status as ApprovalStatus) || 'APPROVED',
      approved_by: row.approved_by as string | null,
      approved_at: row.approved_at as string | null,
    }));
  } catch (error) {
    console.error("Error retrieving mappings by approval status:", error);
    throw error;
  }
}

// Update mapping approval status
export async function updateMappingApprovalStatus(
  mappingId: number,
  approvalStatus: ApprovalStatus,
  approvedBy: string | null
): Promise<void> {
  try {
    const approvedAt = approvalStatus === 'APPROVED' || approvalStatus === 'REJECTED'
      ? new Date().toISOString()
      : null;

    await client.execute({
      sql: `
        UPDATE mappings
        SET approval_status = ?, approved_by = ?, approved_at = ?
        WHERE id = ?
      `,
      args: [approvalStatus, approvedBy, approvedAt, mappingId],
    });
  } catch (error) {
    console.error("Error updating mapping approval status:", error);
    throw error;
  }
}

// Update a mapping's fields (partial update)
export async function updateMapping(
  mappingId: number,
  updateData: {
    source_account?: string | null;
    source_department?: string | null;
    source_account_department?: string | null;
    target_account?: string | null;
    target_department?: string | null;
    target_account_department?: string | null;
    priority?: number;
    is_active?: boolean;
    approval_status?: ApprovalStatus;
    approved_by?: string | null;
    approved_at?: string | null;
  }
): Promise<void> {
  try {
    const setClauses: string[] = [];
    const args: any[] = [];

    if (updateData.source_account !== undefined) {
      setClauses.push('source_account = ?');
      args.push(updateData.source_account);
    }
    if (updateData.source_department !== undefined) {
      setClauses.push('source_department = ?');
      args.push(updateData.source_department);
    }
    if (updateData.source_account_department !== undefined) {
      setClauses.push('source_account_department = ?');
      args.push(updateData.source_account_department);
    }
    if (updateData.target_account !== undefined) {
      setClauses.push('target_account = ?');
      args.push(updateData.target_account);
    }
    if (updateData.target_department !== undefined) {
      setClauses.push('target_department = ?');
      args.push(updateData.target_department);
    }
    if (updateData.target_account_department !== undefined) {
      setClauses.push('target_account_department = ?');
      args.push(updateData.target_account_department);
    }
    if (updateData.priority !== undefined) {
      setClauses.push('priority = ?');
      args.push(updateData.priority);
    }
    if (updateData.is_active !== undefined) {
      setClauses.push('is_active = ?');
      args.push(updateData.is_active ? 1 : 0);
    }
    if (updateData.approval_status !== undefined) {
      setClauses.push('approval_status = ?');
      args.push(updateData.approval_status);
    }
    if (updateData.approved_by !== undefined) {
      setClauses.push('approved_by = ?');
      args.push(updateData.approved_by);
    }
    if (updateData.approved_at !== undefined) {
      setClauses.push('approved_at = ?');
      args.push(updateData.approved_at);
    }

    if (setClauses.length === 0) return;

    args.push(mappingId);

    await client.execute({
      sql: `UPDATE mappings SET ${setClauses.join(', ')} WHERE id = ?`,
      args,
    });
  } catch (error) {
    console.error("Error updating mapping:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- IMPORT GROUP FUNCTIONS -----------------------------------------------------------------------

// Store import groups and their imports
export async function storeImportGroups(ou: string, importGroups: Array<{
  group_name: string;
  imports: Array<{
    id: number;
    name: string;
    displayName: string;
    description: string;
    order: number;
    mapping_config_id: number;
    required: boolean;
    fileTypes: string[];
    requiredColumns: string[];
    optionalColumns: string[];
    validationRules: string[];
  }>;
}>): Promise<void> {
  try {
    await client.execute("BEGIN TRANSACTION");

    try {
      // Delete existing imports for this OU's import groups first (cascade may not be enabled)
      await client.execute({
        sql: "DELETE FROM imports WHERE import_group_id IN (SELECT id FROM import_groups WHERE ou = ?)",
        args: [ou],
      });

      // Delete existing import groups for this OU
      await client.execute({
        sql: "DELETE FROM import_groups WHERE ou = ?",
        args: [ou],
      });

      // Insert new import groups and their imports
      for (const group of importGroups) {
        // Insert the group
        const groupResult = await client.execute({
          sql: `
            INSERT INTO import_groups (ou, group_name, cached_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
          `,
          args: [ou, group.group_name],
        });

        const groupId = groupResult.lastInsertRowid;

        // Insert imports for this group (use INSERT OR REPLACE to handle same import IDs across OUs)
        for (const imp of group.imports) {
          await client.execute({
            sql: `
              INSERT OR REPLACE INTO imports (
                id, import_group_id, name, display_name, description,
                order_index, mapping_config_id, required,
                file_types, required_columns, optional_columns, validation_rules
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
              imp.id,
              groupId,
              imp.name,
              imp.displayName,
              imp.description,
              imp.order,
              imp.mapping_config_id,
              imp.required ? 1 : 0,
              JSON.stringify(imp.fileTypes),
              JSON.stringify(imp.requiredColumns),
              JSON.stringify(imp.optionalColumns),
              JSON.stringify(imp.validationRules),
            ],
          });
        }
      }

      await client.execute("COMMIT");
      // console.log(`Successfully stored ${importGroups.length} import groups for OU ${ou}`);
    } catch (error) {
      await client.execute("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error("Error storing import groups:", error);
    throw error;
  }
}

// Get import groups for an OU
export async function getImportGroups(ou: string): Promise<Array<{
  group_name: string;
  imports: Import[];
}>> {
  try {
    const groupsResult = await client.execute({
      sql: "SELECT id, group_name FROM import_groups WHERE ou = ?",
      args: [ou],
    });

    const groups = [];

    for (const groupRow of groupsResult.rows) {
      const importsResult = await client.execute({
        sql: `
          SELECT id, name, display_name, description, order_index,
                 mapping_config_id, required, file_types, required_columns,
                 optional_columns, validation_rules
          FROM imports
          WHERE import_group_id = ?
          ORDER BY order_index, id
        `,
        args: [groupRow.id],
      });

      const imports = importsResult.rows.map((row) => ({
        id: row.id as number,
        name: row.name as string,
        display_name: row.display_name as string,
        description: row.description as string,
        order_index: row.order_index as number,
        mapping_config_id: row.mapping_config_id as number | null,
        required: Boolean(row.required),
        file_types: JSON.parse(row.file_types as string),
        required_columns: JSON.parse(row.required_columns as string),
        optional_columns: JSON.parse(row.optional_columns as string),
        validation_rules: JSON.parse(row.validation_rules as string),
      }));

      groups.push({
        group_name: groupRow.group_name as string,
        imports,
      });
    }

    return groups;
  } catch (error) {
    console.error("Error retrieving import groups:", error);
    throw error;
  }
}

// Get all unique mapping config IDs from imports for an OU
export async function getMappingConfigIdsForOU(ou: string): Promise<number[]> {
  try {
    const result = await client.execute({
      sql: `
        SELECT DISTINCT i.mapping_config_id
        FROM imports i
        JOIN import_groups ig ON i.import_group_id = ig.id
        WHERE ig.ou = ? AND i.mapping_config_id IS NOT NULL
      `,
      args: [ou],
    });

    return result.rows
      .map((row) => row.mapping_config_id as number)
      .filter((id) => id !== null);
  } catch (error) {
    console.error("Error getting mapping config IDs for OU:", error);
    throw error;
  }
}

// Check if import groups are cached for an OU
export async function hasImportGroupsCached(ou: string): Promise<boolean> {
  try {
    const result = await client.execute({
      sql: "SELECT COUNT(*) as count FROM import_groups WHERE ou = ?",
      args: [ou],
    });

    return (result.rows[0].count as number) > 0;
  } catch (error) {
    console.error("Error checking import groups cache:", error);
    return false;
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- IMPORT SESSION FUNCTIONS ---------------------------------------------------------------------

// Create a new import session
export async function createImportSession(session: Omit<ImportSession, 'id'>): Promise<number> {
  try {
    const result = await client.execute({
      sql: `
        INSERT INTO import_sessions (
          ou, import_group_name, year, month, period_combo, started_at, status
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'in_progress')
      `,
      args: [
        session.ou,
        session.import_group_name,
        session.year,
        session.month,
        session.period_combo,
      ],
    });

    const sessionId = result.lastInsertRowid as number;
    // console.log(`Import session created with ID: ${sessionId} for period ${session.period_combo}`);
    return sessionId;
  } catch (error) {
    console.error("Error creating import session:", error);
    throw error;
  }
}

// Update import session status
export async function updateImportSessionStatus(
  sessionId: number,
  status: 'in_progress' | 'completed' | 'failed'
): Promise<void> {
  try {
    await client.execute({
      sql: `
        UPDATE import_sessions
        SET status = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [status, sessionId],
    });
    // console.log(`Import session ${sessionId} updated to status: ${status}`);
  } catch (error) {
    console.error("Error updating import session status:", error);
    throw error;
  }
}

// Get the most recent import session for an OU
export async function getLatestImportSession(ou: string): Promise<ImportSession | null> {
  try {
    const result = await client.execute({
      sql: `
        SELECT id, ou, import_group_name, year, month, period_combo,
               started_at, completed_at, status
        FROM import_sessions
        WHERE ou = ?
        ORDER BY started_at DESC
        LIMIT 1
      `,
      args: [ou],
    });

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: row.id as number,
        ou: row.ou as string,
        import_group_name: row.import_group_name as string,
        year: row.year as number,
        month: row.month as number,
        period_combo: row.period_combo as string,
        started_at: row.started_at as string,
        completed_at: row.completed_at as string | undefined,
        status: row.status as 'in_progress' | 'completed' | 'failed',
      };
    }
    return null;
  } catch (error) {
    console.error("Error getting latest import session:", error);
    throw error;
  }
}

// Get import session by ID
export async function getImportSession(sessionId: number): Promise<ImportSession | null> {
  try {
    const result = await client.execute({
      sql: `
        SELECT id, ou, import_group_name, year, month, period_combo,
               started_at, completed_at, status
        FROM import_sessions
        WHERE id = ?
      `,
      args: [sessionId],
    });

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: row.id as number,
        ou: row.ou as string,
        import_group_name: row.import_group_name as string,
        year: row.year as number,
        month: row.month as number,
        period_combo: row.period_combo as string,
        started_at: row.started_at as string,
        completed_at: row.completed_at as string | undefined,
        status: row.status as 'in_progress' | 'completed' | 'failed',
      };
    }
    return null;
  } catch (error) {
    console.error("Error getting import session:", error);
    throw error;
  }
}

// Get all import sessions for an OU
export async function getImportSessions(ou: string): Promise<ImportSession[]> {
  try {
    const result = await client.execute({
      sql: `
        SELECT id, ou, import_group_name, year, month, period_combo,
               started_at, completed_at, status
        FROM import_sessions
        WHERE ou = ?
        ORDER BY started_at DESC
      `,
      args: [ou],
    });

    return result.rows.map((row) => ({
      id: row.id as number,
      ou: row.ou as string,
      import_group_name: row.import_group_name as string,
      year: row.year as number,
      month: row.month as number,
      period_combo: row.period_combo as string,
      started_at: row.started_at as string,
      completed_at: row.completed_at as string | undefined,
      status: row.status as 'in_progress' | 'completed' | 'failed',
    }));
  } catch (error) {
    console.error("Error getting import sessions:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- STAGING TABLE FUNCTIONS ----------------------------------------------------------------------

// Interface for staging data
interface StagingData {
  dep_acc_combo_id: string | null;
  month: number;
  year: number;
  period_combo: string;
  scenario: string;
  amount: number;
  currency: string;
  ou: string;
  department: string | null;
  account: string | null;
  version: string;
  source_account: string | null;
  source_department: string | null;
  source_description: string | null;
  mapping_status: string;
  import_batch_id: string;
  is_valid_combo?: number; // 1 = valid, 0 = invalid (computed during insert)
}

// Clear staging table
export async function clearStagingTable(ou?: string): Promise<void> {
  try {
    if (ou) {
      await client.execute({
        sql: "DELETE FROM financial_data_staging WHERE ou = ?",
        args: [ou]
      });
    } else {
      await client.execute({
        sql: "DELETE FROM financial_data_staging",
        args: []
      });
    }
  } catch (error) {
    console.error("Error clearing staging table:", error);
    throw error;
  }
}

// Drop any staging row whose exact (combo, ou, period, scenario) is already in
// financial_data — those rows are invisible to reports anyway (the UNION's
// NOT EXISTS suppresses them) so deletion is pure storage hygiene and cannot
// alter report output. Designed to run ONCE per session at app init, not on
// the report read path. Single correlated DELETE — index-perfect against the
// financial_data PK; SQLite short-circuits when staging is empty.
export async function autoCleanStagingIfImported(): Promise<number> {
  try {
    const result = await client.execute({
      sql: `
        DELETE FROM financial_data_staging
        WHERE EXISTS (
          SELECT 1
          FROM financial_data fd
          WHERE fd.dep_acc_combo_id = financial_data_staging.dep_acc_combo_id
            AND fd.ou               = financial_data_staging.ou
            AND fd.period_combo     = financial_data_staging.period_combo
            AND fd.scenario         = financial_data_staging.scenario
        )
      `,
      args: []
    });
    const cleared = Number((result as any).rowsAffected ?? 0);
    if (cleared > 0) {
      console.log(`[AutoClean] Cleared ${cleared} superseded staging row(s) already present in financial_data`);
    }
    return cleared;
  } catch (error) {
    console.error("[AutoClean] Error during staging auto-cleanup:", error);
    return 0;
  }
}

// Get all staging data
export async function getStagingData(ou?: string): Promise<string> {
  try {
    let sql = `
      SELECT
        rowid,
        dep_acc_combo_id,
        month,
        year,
        period_combo,
        scenario,
        amount,
        currency,
        ou,
        department,
        account,
        version,
        source_account,
        source_department,
        source_description,
        mapping_status,
        import_batch_id,
        last_modified,
        is_valid_combo
      FROM financial_data_staging
    `;

    const args: any[] = [];

    if (ou) {
      sql += " WHERE ou = ?";
      args.push(ou);
    }

    sql += " ORDER BY last_modified DESC, period_combo, dep_acc_combo_id";

    const result = await client.execute({
      sql,
      args
    });

    return JSON.stringify(result.rows);
  } catch (error) {
    console.error("Error fetching staging data:", error);
    throw error;
  }
}

// Delete staging rows where source_account matches any of the provided values
export async function deleteStagingBySourceAccounts(sourceAccounts: (string | null)[]): Promise<number> {
  try {
    // Filter out null values and get unique non-empty values
    const validAccounts = sourceAccounts.filter((acc): acc is string => acc !== null && acc !== '');

    if (validAccounts.length === 0) {
      // console.log("No valid source accounts to delete, skipping");
      return 0;
    }

    // Build placeholders for SQL IN clause
    const placeholders = validAccounts.map(() => '?').join(', ');

    const result = await client.execute({
      sql: `DELETE FROM financial_data_staging WHERE source_account IN (${placeholders})`,
      args: validAccounts
    });

    const deletedCount = result.rowsAffected || 0;
    // console.log(`Deleted ${deletedCount} rows from staging table matching ${validAccounts.length} source accounts`);
    return deletedCount;
  } catch (error) {
    console.error("Error deleting staging rows by source accounts:", error);
    throw error;
  }
}

// Generate derived room stats entries (A960001, A960003, A960102) from source accounts (A960103, A960101)
// Called when the user clicks "Complete Import" to auto-populate derived stat accounts
export async function generateDerivedRoomStats(ou: string): Promise<number> {
  try {
    // Step 1: Delete any existing derived entries
    await deleteStagingBySourceAccounts(['DERIVED_A960001', 'DERIVED_A960003', 'DERIVED_A960102']);

    // Step 2: Query staging for source account totals
    const totalsResult = await client.execute({
      sql: `SELECT account, SUM(amount) as total
            FROM financial_data_staging
            WHERE department = 'D0010' AND ou = ? AND account IN ('A960103', 'A960101')
            GROUP BY account`,
      args: [ou]
    });

    const totals: Record<string, number> = {};
    for (const row of totalsResult.rows) {
      totals[row.account as string] = row.total as number;
    }

    // Step 3: Get period info from an existing staging entry
    const periodResult = await client.execute({
      sql: `SELECT period_combo, month, year, currency
            FROM financial_data_staging
            WHERE department = 'D0010' AND ou = ? LIMIT 1`,
      args: [ou]
    });

    if (periodResult.rows.length === 0) {
      return 0;
    }

    const period = periodResult.rows[0];
    const entries: StagingData[] = [];
    const batchId = `DERIVED_STATS_${new Date().toISOString().replace(/[:.]/g, '-')}`;

    // Step 4: A960001 = value of A960103
    if (totals['A960103'] !== undefined && totals['A960103'] !== 0) {
      entries.push({
        dep_acc_combo_id: 'D0010_A960001',
        month: period.month as number,
        year: period.year as number,
        period_combo: period.period_combo as string,
        scenario: 'ACT',
        amount: totals['A960103'],
        currency: period.currency as string,
        ou,
        department: 'D0010',
        account: 'A960001',
        version: 'MAIN',
        source_account: 'DERIVED_A960001',
        source_department: 'D0010',
        source_description: 'Derived from A960103 (Total SOLD Room Nights)',
        mapping_status: 'mapped',
        import_batch_id: batchId,
      });
    }

    // Step 5: A960003 and A960102 = value of A960101
    if (totals['A960101'] !== undefined && totals['A960101'] !== 0) {
      entries.push({
        dep_acc_combo_id: 'D0010_A960003',
        month: period.month as number,
        year: period.year as number,
        period_combo: period.period_combo as string,
        scenario: 'ACT',
        amount: totals['A960101'],
        currency: period.currency as string,
        ou,
        department: 'D0010',
        account: 'A960003',
        version: 'MAIN',
        source_account: 'DERIVED_A960003',
        source_department: 'D0010',
        source_description: 'Derived from A960101 (Total AVAILABLE Rooms)',
        mapping_status: 'mapped',
        import_batch_id: batchId,
      });

      entries.push({
        dep_acc_combo_id: 'D0010_A960102',
        month: period.month as number,
        year: period.year as number,
        period_combo: period.period_combo as string,
        scenario: 'ACT',
        amount: totals['A960101'],
        currency: period.currency as string,
        ou,
        department: 'D0010',
        account: 'A960102',
        version: 'MAIN',
        source_account: 'DERIVED_A960102',
        source_department: 'D0010',
        source_description: 'Derived from A960101 (Total AVAILABLE Rooms)',
        mapping_status: 'mapped',
        import_batch_id: batchId,
      });
    }

    // Step 6: Insert derived entries
    if (entries.length > 0) {
      await insertBatchStagingData(entries);
    }

    return entries.length;
  } catch (error) {
    console.error("Error generating derived room stats:", error);
    throw error;
  }
}

// Insert batch staging data
export async function insertBatchStagingData(batchData: StagingData[]): Promise<void> {
  if (!Array.isArray(batchData) || batchData.length === 0) {
    console.error("Batch data must be a non-empty array.");
    return;
  }

  try {
    // Build a set of valid combo IDs for fast lookup
    // Format: "D{department}_A{account}" to match dep_acc_combo_id format in staging
    // Note: In account_department_combos table, columns are swapped - "account" has dept values, "department" has account values
    const validCombosResult = await client.execute({
      sql: "SELECT 'D' || account || '_A' || department AS combo_id FROM account_department_combos",
      args: []
    });
    const validCombos = new Set(validCombosResult.rows.map(row => row.combo_id as string));

    const queries = batchData.map((item) => {
      // Check if this combo is valid (exists in master list)
      // If dep_acc_combo_id is null or not in the valid set, mark as invalid (0)
      const isValidCombo = item.dep_acc_combo_id && validCombos.has(item.dep_acc_combo_id) ? 1 : 0;

      return {
        sql: `
          INSERT INTO financial_data_staging (
            dep_acc_combo_id, month, year, period_combo, scenario,
            amount, currency, ou, department, account, version,
            source_account, source_department, source_description, mapping_status,
            import_batch_id, last_modified, item_version, is_valid_combo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
        `,
        args: [
          item.dep_acc_combo_id,
          item.month,
          item.year,
          item.period_combo,
          item.scenario,
          item.amount,
          item.currency,
          item.ou,
          item.department,
          item.account,
          item.version,
          item.source_account,
          item.source_department,
          item.source_description,
          item.mapping_status,
          item.import_batch_id,
          isValidCombo
        ]
      };
    });

    await client.batch(queries);
    // console.log(`${batchData.length} staging records inserted successfully.`);
  } catch (error) {
    console.error("Error inserting batch staging data:", error);
    throw error;
  }
}

// Interface for manual adjustment data
interface ManualAdjustmentData {
  dep_acc_combo_id: string;
  month: number;
  year: number;
  period_combo: string;
  scenario: string;
  amount: number;
  currency: string;
  ou: string;
  department: string;
  account: string;
  version: string;
  source_account: string;
  source_department: string;
  source_description: string;
  mapping_status: string;
  import_batch_id: string;
}

// Insert manual adjustments to staging table
// These are marked with a special import_batch_id prefix "ROOM_SEG_REVIEW_" for traceability
export async function insertManualAdjustments(adjustments: ManualAdjustmentData[]): Promise<number> {
  if (!Array.isArray(adjustments) || adjustments.length === 0) {
    console.error("Adjustments must be a non-empty array.");
    return 0;
  }

  try {
    // Build a set of valid combo IDs for fast lookup
    // Note: In account_department_combos table, columns are swapped - "account" has dept values, "department" has account values
    const validCombosResult = await client.execute({
      sql: "SELECT 'D' || account || '_A' || department AS combo_id FROM account_department_combos",
      args: []
    });
    const validCombos = new Set(validCombosResult.rows.map(row => row.combo_id as string));

    const queries = adjustments.map((item) => {
      // Check if this combo is valid
      const isValidCombo = item.dep_acc_combo_id && validCombos.has(item.dep_acc_combo_id) ? 1 : 0;

      return {
        sql: `
          INSERT INTO financial_data_staging (
            dep_acc_combo_id, month, year, period_combo, scenario,
            amount, currency, ou, department, account, version,
            source_account, source_department, source_description, mapping_status,
            import_batch_id, last_modified, item_version, is_valid_combo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
        `,
        args: [
          item.dep_acc_combo_id,
          item.month,
          item.year,
          item.period_combo,
          item.scenario,
          item.amount,
          item.currency,
          item.ou,
          item.department,
          item.account,
          item.version,
          item.source_account,
          item.source_department,
          item.source_description,
          item.mapping_status,
          item.import_batch_id,
          isValidCombo
        ]
      };
    });

    await client.batch(queries);
    console.log(`[ManualAdjustments] Inserted ${adjustments.length} manual adjustment(s) to staging table`);
    return adjustments.length;
  } catch (error) {
    console.error("Error inserting manual adjustments:", error);
    throw error;
  }
}

// Add a single staging row (for manual user entry)
export interface AddStagingRowData {
  month: number;
  year: number;
  period_combo: string;
  scenario: string;
  amount: number;
  currency: string;
  ou: string;
  department: string;
  account: string;
  version: string;
}

export async function addStagingRow(data: AddStagingRowData): Promise<number> {
  try {
    // Validate combo - in combo table, "account" column has dept values and "department" column has account values
    const comboId = `D${data.department}_A${data.account}`;
    const validCombosResult = await client.execute({
      sql: "SELECT COUNT(*) as count FROM account_department_combos WHERE account = ? AND department = ?",
      args: [data.department, data.account]
    });
    const isValidCombo = (validCombosResult.rows[0].count as number) > 0 ? 1 : 0;

    const result = await client.execute({
      sql: `
        INSERT INTO financial_data_staging (
          dep_acc_combo_id, month, year, period_combo, scenario,
          amount, currency, ou, department, account, version,
          source_account, source_department, source_description, mapping_status,
          import_batch_id, last_modified, item_version, is_valid_combo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
      `,
      args: [
        comboId,
        data.month,
        data.year,
        data.period_combo,
        data.scenario,
        data.amount,
        data.currency,
        data.ou,
        `D${data.department}`,  // Add D prefix for department
        `A${data.account}`,     // Add A prefix for account
        data.version,
        'MANUAL_USER_ENTRY',  // source_account
        'MANUAL_USER_ENTRY',  // source_department
        'Manual user entry',  // source_description
        'mapped',             // mapping_status (user provides mapped values directly)
        `MANUAL_ENTRY_${Date.now()}`,  // import_batch_id
        isValidCombo
      ]
    });

    console.log(`[AddStagingRow] Added manual staging row with combo ${comboId}`);

    // Reset validation state since data has changed
    await setValidationCompletedState(data.ou, false);

    return result.lastInsertRowid ? Number(result.lastInsertRowid) : 0;
  } catch (error) {
    console.error("Error adding staging row:", error);
    throw error;
  }
}

// Update a staging row by rowid
export interface UpdateStagingRowData {
  rowid: number;
  month: number;
  year: number;
  period_combo: string;
  scenario: string;
  amount: number;
  currency: string;
  department: string;
  account: string;
  version: string;
}

export async function updateStagingRow(data: UpdateStagingRowData): Promise<boolean> {
  try {
    // Validate combo - in combo table, "account" column has dept values and "department" column has account values
    const comboId = `D${data.department}_A${data.account}`;
    const validCombosResult = await client.execute({
      sql: "SELECT COUNT(*) as count FROM account_department_combos WHERE account = ? AND department = ?",
      args: [data.department, data.account]
    });
    const isValidCombo = (validCombosResult.rows[0].count as number) > 0 ? 1 : 0;

    // Get the current row data to append edit note and get OU for validation reset
    const currentRow = await client.execute({
      sql: "SELECT source_description, ou FROM financial_data_staging WHERE rowid = ?",
      args: [data.rowid]
    });

    let newSourceDescription = 'Edited by user';
    if (currentRow.rows.length > 0) {
      const currentDesc = currentRow.rows[0].source_description as string | null;
      if (currentDesc && !currentDesc.includes('[EDITED]')) {
        newSourceDescription = `${currentDesc} [EDITED]`;
      } else if (currentDesc) {
        newSourceDescription = currentDesc;
      }
    }

    const result = await client.execute({
      sql: `
        UPDATE financial_data_staging
        SET
          dep_acc_combo_id = ?,
          month = ?,
          year = ?,
          period_combo = ?,
          scenario = ?,
          amount = ?,
          currency = ?,
          department = ?,
          account = ?,
          version = ?,
          source_description = ?,
          mapping_status = 'mapped',
          last_modified = CURRENT_TIMESTAMP,
          is_valid_combo = ?
        WHERE rowid = ?
      `,
      args: [
        comboId,
        data.month,
        data.year,
        data.period_combo,
        data.scenario,
        data.amount,
        data.currency,
        `D${data.department}`,  // Add D prefix for department
        `A${data.account}`,     // Add A prefix for account
        data.version,
        newSourceDescription,
        isValidCombo,
        data.rowid
      ]
    });

    console.log(`[UpdateStagingRow] Updated staging row ${data.rowid}`);

    // Reset validation state since data has changed
    if (currentRow.rows.length > 0) {
      const ou = currentRow.rows[0].ou as string;
      if (ou) {
        await setValidationCompletedState(ou, false);
      }
    }

    return result.rowsAffected > 0;
  } catch (error) {
    console.error("Error updating staging row:", error);
    throw error;
  }
}

// Delete a staging row by rowid
export async function deleteStagingRow(rowid: number): Promise<boolean> {
  try {
    // Get the OU before deleting so we can reset validation completion state
    const rowData = await client.execute({
      sql: "SELECT ou FROM financial_data_staging WHERE rowid = ?",
      args: [rowid]
    });
    const ou = rowData.rows.length > 0 ? (rowData.rows[0].ou as string) : null;

    const result = await client.execute({
      sql: "DELETE FROM financial_data_staging WHERE rowid = ?",
      args: [rowid]
    });

    console.log(`[DeleteStagingRow] Deleted staging row ${rowid}, affected: ${result.rowsAffected}`);

    // Reset validation completion state (requires re-validation, but keeps all data)
    if (result.rowsAffected > 0 && ou) {
      await setValidationCompletedState(ou, false);
    }

    return result.rowsAffected > 0;
  } catch (error) {
    console.error("Error deleting staging row:", error);
    throw error;
  }
}

// Check if any imports exist for a given OU (to determine if Add New is available)
export async function checkImportsExist(ou: string): Promise<boolean> {
  try {
    const result = await client.execute({
      sql: "SELECT COUNT(*) as count FROM financial_data_staging WHERE ou = ?",
      args: [ou]
    });
    return (result.rows[0].count as number) > 0;
  } catch (error) {
    console.error("Error checking imports exist:", error);
    throw error;
  }
}

// Get unique accounts from account_department_combos for dropdown
// Note: In the combos table, what we call "account" is stored in the "department" column
// and what we call "department" is stored in the "account" column (API naming convention)
export async function getUniqueAccounts(): Promise<string[]> {
  try {
    const result = await client.execute({
      sql: "SELECT DISTINCT department FROM account_department_combos ORDER BY department",
      args: []
    });
    return result.rows.map(row => row.department as string);
  } catch (error) {
    console.error("Error getting unique accounts:", error);
    throw error;
  }
}

// Get unique departments from account_department_combos for dropdown
// Note: In the combos table, departments are stored in the "account" column
export async function getUniqueDepartments(): Promise<string[]> {
  try {
    const result = await client.execute({
      sql: "SELECT DISTINCT account FROM account_department_combos ORDER BY account",
      args: []
    });
    return result.rows.map(row => row.account as string);
  } catch (error) {
    console.error("Error getting unique departments:", error);
    throw error;
  }
}

// Get valid departments for a given account
// Note: account values are in "department" column, department values are in "account" column
export async function getDepartmentsForAccount(account: string): Promise<string[]> {
  try {
    const result = await client.execute({
      sql: "SELECT DISTINCT account FROM account_department_combos WHERE department = ? ORDER BY account",
      args: [account]
    });
    return result.rows.map(row => row.account as string);
  } catch (error) {
    console.error("Error getting departments for account:", error);
    throw error;
  }
}

// Get valid accounts for a given department
// Note: account values are in "department" column, department values are in "account" column
export async function getAccountsForDepartment(department: string): Promise<string[]> {
  try {
    const result = await client.execute({
      sql: "SELECT DISTINCT department FROM account_department_combos WHERE account = ? ORDER BY department",
      args: [department]
    });
    return result.rows.map(row => row.department as string);
  } catch (error) {
    console.error("Error getting accounts for department:", error);
    throw error;
  }
}

// Get staging mapping statistics
export async function getStagingMappingStats(): Promise<{ mapped: number; unmapped: number; partial: number; total: number }> {
  try {
    const result = await client.execute({
      sql: `
        SELECT
          mapping_status,
          COUNT(*) as count
        FROM financial_data_staging
        GROUP BY mapping_status
      `,
      args: []
    });

    const stats = {
      mapped: 0,
      unmapped: 0,
      partial: 0,
      total: 0
    };

    for (const row of result.rows) {
      const status = row.mapping_status as string;
      const count = row.count as number;

      stats.total += count;

      if (status === 'mapped') {
        stats.mapped = count;
      } else if (status === 'unmapped') {
        stats.unmapped = count;
      } else if (status === 'partial') {
        stats.partial = count;
      }
    }

    return stats;
  } catch (error) {
    console.error("Error getting staging mapping stats:", error);
    throw error;
  }
}

// Get unmapped accounts from staging
export async function getUnmappedAccounts(): Promise<Array<{ source_account: string; source_description: string; row_count: number; total_amount: number }>> {
  try {
    const result = await client.execute({
      sql: `
        SELECT
          source_account,
          source_description,
          COUNT(*) as row_count,
          SUM(amount) as total_amount
        FROM financial_data_staging
        WHERE mapping_status IN ('unmapped', 'partial')
        GROUP BY source_account, source_description
        ORDER BY row_count DESC
      `,
      args: []
    });

    return result.rows.map((row) => ({
      source_account: row.source_account as string,
      source_description: row.source_description as string,
      row_count: row.row_count as number,
      total_amount: row.total_amount as number
    }));
  } catch (error) {
    console.error("Error getting unmapped accounts:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- MAPPING TABLES FUNCTIONS (Account Maps, Department Maps, Combos) ------------------------------------------
//------------------------------------------------------------------------------------------------------------------

/**
 * Get the current mapping tables version
 */
export async function getMappingTablesVersion(): Promise<MappingTablesVersion | null> {
  try {
    const result = await client.execute({
      sql: "SELECT * FROM mapping_tables_version WHERE id = 1",
      args: []
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id as number,
      version: row.version as string,
      combo_version: row.combo_version as string,
      last_updated: row.last_updated as string
    };
  } catch (error) {
    console.error("Error getting mapping tables version:", error);
    throw error;
  }
}

/**
 * Update or insert the mapping tables version
 */
export async function setMappingTablesVersion(version: string, comboVersion: string): Promise<void> {
  try {
    await client.execute({
      sql: `
        INSERT INTO mapping_tables_version (id, version, combo_version, last_updated)
        VALUES (1, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version,
          combo_version = excluded.combo_version,
          last_updated = CURRENT_TIMESTAMP
      `,
      args: [version, comboVersion]
    });
    // console.log(`Updated mapping tables version to ${version}, combo version to ${comboVersion}`);
  } catch (error) {
    console.error("Error setting mapping tables version:", error);
    throw error;
  }
}

/**
 * Store account maps in bulk (replaces all existing data)
 */
export async function storeAccountMaps(accountMaps: AccountMap[]): Promise<void> {
  try {
    // Clear existing data
    await client.execute({
      sql: "DELETE FROM account_maps",
      args: []
    });

    if (accountMaps.length === 0) {
      // console.log("No account maps to store");
      return;
    }

    // Insert new data in batches
    const batchSize = 100;
    for (let i = 0; i < accountMaps.length; i += batchSize) {
      const batch = accountMaps.slice(i, i + batchSize);
      const insertStatements = batch.map(am => ({
        sql: `
          INSERT INTO account_maps (
            base_account, account_description_detail_level_max, level_0, level_1, level_2, level_3, level_4, level_5, level_6, level_7, level_8, level_9,
            level_10, level_11, level_12, level_13, level_14, level_15, level_16, level_17, level_18, level_19,
            level_20, level_21, level_22, level_23, level_24, level_25, level_26, level_27, level_28, level_29,
            level_30, description
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          am.base_account, am.account_description_detail_level_max ?? null, am.level_0 ?? null, am.level_1 ?? null, am.level_2 ?? null, am.level_3 ?? null, am.level_4 ?? null, am.level_5 ?? null, am.level_6 ?? null,
          am.level_7 ?? null, am.level_8 ?? null, am.level_9 ?? null, am.level_10 ?? null, am.level_11 ?? null, am.level_12 ?? null, am.level_13 ?? null, am.level_14 ?? null,
          am.level_15 ?? null, am.level_16 ?? null, am.level_17 ?? null, am.level_18 ?? null, am.level_19 ?? null, am.level_20 ?? null, am.level_21 ?? null, am.level_22 ?? null,
          am.level_23 ?? null, am.level_24 ?? null, am.level_25 ?? null, am.level_26 ?? null, am.level_27 ?? null, am.level_28 ?? null, am.level_29 ?? null, am.level_30 ?? null,
          am.description ?? null
        ]
      }));

      await client.batch(insertStatements);
    }

    // console.log(`Stored ${accountMaps.length} account maps`);
  } catch (error) {
    console.error("Error storing account maps:", error);
    throw error;
  }
}

/**
 * Store department maps in bulk (replaces all existing data)
 */
export async function storeDepartmentMaps(departmentMaps: DepartmentMap[]): Promise<void> {
  try {
    // Clear existing data
    await client.execute({
      sql: "DELETE FROM department_maps",
      args: []
    });

    if (departmentMaps.length === 0) {
      // console.log("No department maps to store");
      return;
    }

    // Insert new data in batches
    const batchSize = 100;
    for (let i = 0; i < departmentMaps.length; i += batchSize) {
      const batch = departmentMaps.slice(i, i + batchSize);
      const insertStatements = batch.map(dm => ({
        sql: `
          INSERT INTO department_maps (
            base_department, department_description_detail_level_max, level_0, level_1, level_2, level_3, level_4, level_5, level_6, level_7, level_8, level_9,
            level_10, level_11, level_12, level_13, level_14, level_15, level_16, level_17, level_18, level_19,
            level_20, level_21, level_22, level_23, level_24, level_25, level_26, level_27, level_28, level_29,
            level_30, description
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          dm.base_department, dm.department_description_detail_level_max ?? null, dm.level_0 ?? null, dm.level_1 ?? null, dm.level_2 ?? null, dm.level_3 ?? null, dm.level_4 ?? null, dm.level_5 ?? null, dm.level_6 ?? null,
          dm.level_7 ?? null, dm.level_8 ?? null, dm.level_9 ?? null, dm.level_10 ?? null, dm.level_11 ?? null, dm.level_12 ?? null, dm.level_13 ?? null, dm.level_14 ?? null,
          dm.level_15 ?? null, dm.level_16 ?? null, dm.level_17 ?? null, dm.level_18 ?? null, dm.level_19 ?? null, dm.level_20 ?? null, dm.level_21 ?? null, dm.level_22 ?? null,
          dm.level_23 ?? null, dm.level_24 ?? null, dm.level_25 ?? null, dm.level_26 ?? null, dm.level_27 ?? null, dm.level_28 ?? null, dm.level_29 ?? null, dm.level_30 ?? null,
          dm.description ?? null
        ]
      }));

      await client.batch(insertStatements);
    }

    // console.log(`Stored ${departmentMaps.length} department maps`);
  } catch (error) {
    console.error("Error storing department maps:", error);
    throw error;
  }
}

/**
 * Store account-department combos in bulk (replaces all existing data)
 */
export async function storeAccountDepartmentCombos(combos: AccountDepartmentCombo[]): Promise<void> {
  try {
    if (combos.length === 0) {
      // console.log("No combos to store");
      return;
    }

    // console.log(`Received ${combos.length} combos from API`);
    // Deduplicate combos from the API response (in case there are duplicates)
    // Using account+department as the unique key since that's the UNIQUE constraint
    const uniqueCombos = Array.from(
      new Map(combos.map(combo => [`${combo.account}|||${combo.department}`, combo])).values()
    );

    if (uniqueCombos.length < combos.length) {
      // console.log(`⚠️ Found and removed ${combos.length - uniqueCombos.length} duplicate combos from API response`);
    }

    // console.log(`Clearing existing combos table...`);
    // Clear existing data
    const deleteResult = await client.execute({
      sql: "DELETE FROM account_department_combos",
      args: []
    });
    // console.log(`Deleted ${deleteResult.rowsAffected || 0} existing combos`);
    // Verify table is empty
    const countResult = await client.execute({
      sql: "SELECT COUNT(*) as count FROM account_department_combos",
      args: []
    });
    const count = countResult.rows[0]?.count as number;
    // console.log(`Table now has ${count} rows (should be 0)`);
    if (count > 0) {
      console.error("⚠️ WARNING: Table still has rows after DELETE!");
    }

    // Insert new data in batches using INSERT OR REPLACE for extra safety
    const batchSize = 100;
    for (let i = 0; i < uniqueCombos.length; i += batchSize) {
      const batch = uniqueCombos.slice(i, i + batchSize);
      const insertStatements = batch.map(combo => ({
        sql: `
          INSERT OR REPLACE INTO account_department_combos (account, department, description)
          VALUES (?, ?, ?)
        `,
        args: [combo.account, combo.department, combo.description || null]
      }));

      await client.batch(insertStatements);
    }

    // console.log(`✅ Stored ${uniqueCombos.length} account-department combos`);
  } catch (error) {
    console.error("❌ Error storing account-department combos:", error);
    throw error;
  }
}

/**
 * Get all account maps
 */
export async function getAccountMaps(): Promise<AccountMap[]> {
  try {
    const result = await client.execute({
      sql: "SELECT * FROM account_maps ORDER BY base_account",
      args: []
    });

    return result.rows.map(row => ({
      base_account: row.base_account as string,
      level_0: row.level_0 as string,
      level_1: row.level_1 as string,
      level_2: row.level_2 as string,
      level_3: row.level_3 as string,
      level_4: row.level_4 as string,
      level_5: row.level_5 as string,
      level_6: row.level_6 as string,
      level_7: row.level_7 as string,
      level_8: row.level_8 as string,
      level_9: row.level_9 as string,
      level_10: row.level_10 as string,
      level_11: row.level_11 as string,
      level_12: row.level_12 as string,
      level_13: row.level_13 as string,
      level_14: row.level_14 as string,
      level_15: row.level_15 as string,
      level_16: row.level_16 as string,
      level_17: row.level_17 as string,
      level_18: row.level_18 as string,
      level_19: row.level_19 as string,
      level_20: row.level_20 as string,
      level_21: row.level_21 as string,
      level_22: row.level_22 as string,
      level_23: row.level_23 as string,
      level_24: row.level_24 as string,
      level_25: row.level_25 as string,
      level_26: row.level_26 as string,
      level_27: row.level_27 as string,
      level_28: row.level_28 as string,
      level_29: row.level_29 as string,
      level_30: row.level_30 as string,
      description: row.description as string
    }));
  } catch (error) {
    console.error("Error getting account maps:", error);
    throw error;
  }
}

/**
 * Get all department maps
 */
export async function getDepartmentMaps(): Promise<DepartmentMap[]> {
  try {
    const result = await client.execute({
      sql: "SELECT * FROM department_maps ORDER BY base_department",
      args: []
    });

    return result.rows.map(row => ({
      base_department: row.base_department as string,
      level_0: row.level_0 as string,
      level_1: row.level_1 as string,
      level_2: row.level_2 as string,
      level_3: row.level_3 as string,
      level_4: row.level_4 as string,
      level_5: row.level_5 as string,
      level_6: row.level_6 as string,
      level_7: row.level_7 as string,
      level_8: row.level_8 as string,
      level_9: row.level_9 as string,
      level_10: row.level_10 as string,
      level_11: row.level_11 as string,
      level_12: row.level_12 as string,
      level_13: row.level_13 as string,
      level_14: row.level_14 as string,
      level_15: row.level_15 as string,
      level_16: row.level_16 as string,
      level_17: row.level_17 as string,
      level_18: row.level_18 as string,
      level_19: row.level_19 as string,
      level_20: row.level_20 as string,
      level_21: row.level_21 as string,
      level_22: row.level_22 as string,
      level_23: row.level_23 as string,
      level_24: row.level_24 as string,
      level_25: row.level_25 as string,
      level_26: row.level_26 as string,
      level_27: row.level_27 as string,
      level_28: row.level_28 as string,
      level_29: row.level_29 as string,
      level_30: row.level_30 as string,
      description: row.description as string
    }));
  } catch (error) {
    console.error("Error getting department maps:", error);
    throw error;
  }
}

/**
 * Get all account-department combos
 */
export async function getAccountDepartmentCombos(): Promise<AccountDepartmentCombo[]> {
  try {
    const result = await client.execute({
      sql: "SELECT * FROM account_department_combos ORDER BY account, department",
      args: []
    });

    return result.rows.map(row => ({
      id: row.id as number,
      account: row.account as string,
      department: row.department as string,
      description: row.description as string
    }));
  } catch (error) {
    console.error("Error getting account-department combos:", error);
    throw error;
  }
}

/**
 * Validate if an account-department combination is valid
 */
export async function isValidCombo(account: string, department: string): Promise<boolean> {
  try {
    // Note: The account_department_combos table has swapped column names
    // The "account" column contains department values and "department" column contains account values
    const result = await client.execute({
      sql: "SELECT COUNT(*) as count FROM account_department_combos WHERE account = ? AND department = ?",
      args: [department, account]
    });

    const count = result.rows[0].count as number;
    return count > 0;
  } catch (error) {
    console.error("Error validating combo:", error);
    throw error;
  }
}

/**
 * Get account map by base_account
 */
export async function getAccountMapByBase(baseAccount: string): Promise<AccountMap | null> {
  try {
    const result = await client.execute({
      sql: "SELECT * FROM account_maps WHERE base_account = ?",
      args: [baseAccount]
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      base_account: row.base_account as string,
      level_0: row.level_0 as string,
      level_1: row.level_1 as string,
      level_2: row.level_2 as string,
      level_3: row.level_3 as string,
      level_4: row.level_4 as string,
      level_5: row.level_5 as string,
      level_6: row.level_6 as string,
      level_7: row.level_7 as string,
      level_8: row.level_8 as string,
      level_9: row.level_9 as string,
      level_10: row.level_10 as string,
      level_11: row.level_11 as string,
      level_12: row.level_12 as string,
      level_13: row.level_13 as string,
      level_14: row.level_14 as string,
      level_15: row.level_15 as string,
      level_16: row.level_16 as string,
      level_17: row.level_17 as string,
      level_18: row.level_18 as string,
      level_19: row.level_19 as string,
      level_20: row.level_20 as string,
      level_21: row.level_21 as string,
      level_22: row.level_22 as string,
      level_23: row.level_23 as string,
      level_24: row.level_24 as string,
      level_25: row.level_25 as string,
      level_26: row.level_26 as string,
      level_27: row.level_27 as string,
      level_28: row.level_28 as string,
      level_29: row.level_29 as string,
      level_30: row.level_30 as string,
      description: row.description as string
    };
  } catch (error) {
    console.error("Error getting account map:", error);
    throw error;
  }
}

export async function getAccountNamesByBase(
  baseAccounts: readonly string[]
): Promise<Map<string, string>> {
  if (baseAccounts.length === 0) return new Map();
  const placeholders = baseAccounts.map(() => '?').join(',');
  const result = await client.execute({
    sql: `SELECT base_account, account_description_detail_level_max
          FROM account_maps WHERE base_account IN (${placeholders})`,
    args: [...baseAccounts],
  });
  const out = new Map<string, string>();
  for (const r of result.rows) {
    const acct = r.base_account as string;
    const name = (r.account_description_detail_level_max as string) ?? acct;
    out.set(acct, name);
  }
  return out;
}

/**
 * Get department map by base_department
 */
export async function getDepartmentMapByBase(baseDepartment: string): Promise<DepartmentMap | null> {
  try {
    const result = await client.execute({
      sql: "SELECT * FROM department_maps WHERE base_department = ?",
      args: [baseDepartment]
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      base_department: row.base_department as string,
      level_0: row.level_0 as string,
      level_1: row.level_1 as string,
      level_2: row.level_2 as string,
      level_3: row.level_3 as string,
      level_4: row.level_4 as string,
      level_5: row.level_5 as string,
      level_6: row.level_6 as string,
      level_7: row.level_7 as string,
      level_8: row.level_8 as string,
      level_9: row.level_9 as string,
      level_10: row.level_10 as string,
      level_11: row.level_11 as string,
      level_12: row.level_12 as string,
      level_13: row.level_13 as string,
      level_14: row.level_14 as string,
      level_15: row.level_15 as string,
      level_16: row.level_16 as string,
      level_17: row.level_17 as string,
      level_18: row.level_18 as string,
      level_19: row.level_19 as string,
      level_20: row.level_20 as string,
      level_21: row.level_21 as string,
      level_22: row.level_22 as string,
      level_23: row.level_23 as string,
      level_24: row.level_24 as string,
      level_25: row.level_25 as string,
      level_26: row.level_26 as string,
      level_27: row.level_27 as string,
      level_28: row.level_28 as string,
      level_29: row.level_29 as string,
      level_30: row.level_30 as string,
      description: row.description as string
    };
  } catch (error) {
    console.error("Error getting department map:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- FINANCIAL DATA IMPORT FUNCTIONS ------------------------------------------------------------------------------

/**
 * Store financial data from API import
 * This truncates existing data for the OU and replaces with new data
 */
export async function storeFinancialData(ou: string, records: any[]) {
  if (!Array.isArray(records) || records.length === 0) {
    // console.log("No records to store");
    return;
  }

  try {
    // Disable foreign key constraints temporarily for this import
    await client.execute("PRAGMA foreign_keys = OFF");

    // Delete all existing data for this OU (truncate and replace approach)
    await client.execute({
      sql: "DELETE FROM financial_data WHERE ou = ?",
      args: [ou]
    });

    const batchQueries: { sql: string; args: any[] }[] = [];

    // Insert all new records
    for (const record of records) {
      // Parse period (YYYY-MM format)
      const [yearStr, monthStr] = record.period.split("-");
      const year = parseInt(yearStr);
      const month = parseInt(monthStr);

      // Create a combo ID from department and account
      const dep_acc_combo_id = `${record.department}_${record.account}`;

      // Insert query with ON CONFLICT to handle duplicate records in the incoming data
      // Use load_date from API if provided, otherwise fall back to current timestamp
      const lastModified = record.load_date || new Date().toISOString();

      const insertQuery = `
        INSERT INTO financial_data (
          dep_acc_combo_id, month, year, period_combo, scenario,
          amount, currency, ou, department, account, version, last_modified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (dep_acc_combo_id, period_combo, scenario, version, ou) DO UPDATE SET
          amount = excluded.amount,
          currency = excluded.currency,
          month = excluded.month,
          year = excluded.year,
          department = excluded.department,
          account = excluded.account,
          last_modified = excluded.last_modified
      `;

      batchQueries.push({
        sql: insertQuery,
        args: [
          dep_acc_combo_id,
          month,
          year,
          record.period,
          record.scenario,
          record.amount,
          record.currency,
          ou,
          record.department,
          record.account,
          record.version,
          lastModified
        ]
      });
    }

    // Execute batch insert
    await client.batch(batchQueries);

    // Re-enable foreign key constraints
    await client.execute("PRAGMA foreign_keys = ON");

    // console.log(`Successfully stored ${records.length} financial records for OU ${ou}`);
  } catch (error) {
    // Make sure to re-enable foreign keys even if there's an error
    try {
      await client.execute("PRAGMA foreign_keys = ON");
    } catch (pragmaError) {
      console.error("Error re-enabling foreign keys:", pragmaError);
    }
    console.error("Error storing financial data:", error);
    throw error;
  }
}

/**
 * Delete the listed periods from financial_data for an OU.
 * Used by sync reconciliation to drop orphan periods (present locally,
 * absent from the server's period manifest).
 *
 * SAFETY: this MUST NOT touch financial_data_staging — staging has a separate
 * lifecycle (locally-imported, sign-off driven) and is never reconciled here.
 */
export async function deleteSyncedFinancialDataForPeriods(
  ou: string,
  periods: string[]
): Promise<number> {
  if (!Array.isArray(periods) || periods.length === 0) return 0;
  const placeholders = periods.map(() => '?').join(', ');
  const result = await client.execute({
    sql: `DELETE FROM financial_data WHERE ou = ? AND period_combo IN (${placeholders})`,
    args: [ou, ...periods]
  });
  return (result as any).rowsAffected ?? 0;
}

/**
 * Get count of stored financial data records for an OU
 */
export async function getFinancialDataCount(ou: string): Promise<number> {
  try {
    const result = await client.execute({
      sql: `SELECT COUNT(*) as count FROM financial_data WHERE ou = ?`,
      args: [ou]
    });

    return result.rows[0]?.count as number || 0;
  } catch (error) {
    console.error("Error getting financial data count:", error);
    return 0;
  }
}

/**
 * Get last import timestamp for an OU
 */
export async function getFinancialDataLastImport(ou: string): Promise<string | null> {
  try {
    const result = await client.execute({
      sql: `SELECT MAX(last_modified) as last_import FROM financial_data WHERE ou = ?`,
      args: [ou]
    });

    return result.rows[0]?.last_import as string || null;
  } catch (error) {
    console.error("Error getting last import timestamp:", error);
    return null;
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- FINANCIAL DATA VERSION TRACKING FOR INCREMENTAL SYNC ----------------------------------------

export interface LocalPeriodVersion {
  period: string;
  last_modified: string;
}

/**
 * Get local version info (last_modified) for each period for an OU
 * Used to compare with server versions for incremental sync
 */
export async function getFinancialDataLocalVersions(ou: string): Promise<LocalPeriodVersion[]> {
  try {
    const result = await client.execute({
      sql: `
        SELECT period_combo as period, MAX(last_modified) as last_modified
        FROM financial_data
        WHERE ou = ?
        GROUP BY period_combo
        ORDER BY period_combo
      `,
      args: [ou]
    });

    return result.rows.map(row => ({
      period: row.period as string,
      last_modified: row.last_modified as string
    }));
  } catch (error) {
    console.error("Error getting local financial data versions:", error);
    return [];
  }
}

/**
 * Store financial data for specific periods only (incremental update)
 * Deletes existing data only for the specified periods, then inserts new records
 */
export async function storeFinancialDataForPeriods(
  ou: string,
  records: any[],
  periods: string[]
): Promise<void> {
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }

  if (!Array.isArray(periods) || periods.length === 0) {
    return;
  }

  try {
    await client.execute("PRAGMA foreign_keys = OFF");

    // Delete existing data only for the specified periods
    const placeholders = periods.map(() => '?').join(', ');
    await client.execute({
      sql: `DELETE FROM financial_data WHERE ou = ? AND period_combo IN (${placeholders})`,
      args: [ou, ...periods]
    });

    const batchQueries: { sql: string; args: any[] }[] = [];

    for (const record of records) {
      const [yearStr, monthStr] = record.period.split("-");
      const year = parseInt(yearStr);
      const month = parseInt(monthStr);
      const dep_acc_combo_id = `${record.department}_${record.account}`;

      // Use load_date from API if provided, otherwise fall back to current timestamp
      const lastModified = record.load_date || new Date().toISOString();

      const insertQuery = `
        INSERT INTO financial_data (
          dep_acc_combo_id, month, year, period_combo, scenario,
          amount, currency, ou, department, account, version, last_modified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (dep_acc_combo_id, period_combo, scenario, version, ou) DO UPDATE SET
          amount = excluded.amount,
          currency = excluded.currency,
          month = excluded.month,
          year = excluded.year,
          department = excluded.department,
          account = excluded.account,
          last_modified = excluded.last_modified
      `;

      batchQueries.push({
        sql: insertQuery,
        args: [
          dep_acc_combo_id,
          month,
          year,
          record.period,
          record.scenario,
          record.amount,
          record.currency,
          ou,
          record.department,
          record.account,
          record.version,
          lastModified
        ]
      });
    }

    await client.batch(batchQueries);
    await client.execute("PRAGMA foreign_keys = ON");

  } catch (error) {
    try {
      await client.execute("PRAGMA foreign_keys = ON");
    } catch (pragmaError) {
      console.error("Error re-enabling foreign keys:", pragmaError);
    }
    console.error("Error storing financial data for periods:", error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- CACHE METADATA FUNCTIONS ---------------------------------------------------------------------

/**
 * Update cache metadata for a specific key
 */
export async function updateCacheMetadata(
  key: string,
  status: 'idle' | 'fetching' | 'success' | 'failed',
  errorMessage?: string
): Promise<void> {
  try {
    await client.execute({
      sql: `
        INSERT INTO cache_metadata (key, last_fetched_at, fetch_status, error_message)
        VALUES (?, CURRENT_TIMESTAMP, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          last_fetched_at = CURRENT_TIMESTAMP,
          fetch_status = excluded.fetch_status,
          error_message = excluded.error_message
      `,
      args: [key, status, errorMessage || null],
    });
  } catch (error) {
    console.error(`Error updating cache metadata for ${key}:`, error);
    throw error;
  }
}

/**
 * Get cache metadata for a specific key
 */
export async function getCacheMetadata(key: string): Promise<{
  last_fetched_at: string | null;
  fetch_status: string;
  error_message: string | null;
} | null> {
  try {
    const result = await client.execute({
      sql: `SELECT last_fetched_at, fetch_status, error_message FROM cache_metadata WHERE key = ?`,
      args: [key],
    });

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        last_fetched_at: row.last_fetched_at as string | null,
        fetch_status: row.fetch_status as string,
        error_message: row.error_message as string | null,
      };
    }
    return null;
  } catch (error) {
    console.error(`Error getting cache metadata for ${key}:`, error);
    return null;
  }
}

/**
 * Check if cache needs refresh (older than specified minutes)
 */
export async function shouldRefreshCache(key: string, maxAgeMinutes: number = 60): Promise<boolean> {
  try {
    const metadata = await getCacheMetadata(key);

    if (!metadata || !metadata.last_fetched_at) {
      return true; // No cache, needs refresh
    }

    // Check if cache is too old
    const lastFetched = new Date(metadata.last_fetched_at);
    const now = new Date();
    const ageMinutes = (now.getTime() - lastFetched.getTime()) / (1000 * 60);

    return ageMinutes > maxAgeMinutes;
  } catch (error) {
    console.error(`Error checking cache age for ${key}:`, error);
    return true; // On error, assume refresh needed
  }
}

//------------------------------------------------------------------------------------------------------------------
//------VALIDATION FUNCTIONS --------------------------------------------------------------------------------------

/**
 * Store validations for an OU
 */
export async function storeValidations(ou: string, validations: Array<{
  id: number;
  name: string;
  display_name: string;
  is_required: boolean;
  description: string;
  sequence: number;
}>): Promise<void> {
  try {
    await client.execute("BEGIN TRANSACTION");

    try {
      // Delete existing validations for this OU
      await client.execute({
        sql: "DELETE FROM validations WHERE ou = ?",
        args: [ou],
      });

      // Insert new validations
      for (const validation of validations) {
        await client.execute({
          sql: `
            INSERT INTO validations (
              id, ou, name, display_name, is_required, description, sequence, cached_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `,
          args: [
            validation.id,
            ou,
            validation.name,
            validation.display_name,
            validation.is_required ? 1 : 0,
            validation.description,
            validation.sequence,
          ],
        });
      }

      await client.execute("COMMIT");
      // console.log(`Stored ${validations.length} validations for OU ${ou}`);
    } catch (error) {
      await client.execute("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error(`Error storing validations for OU ${ou}:`, error);
    throw error;
  }
}

/**
 * Get validations for an OU
 */
export async function getValidations(ou: string): Promise<Array<{
  id: number;
  name: string;
  display_name: string;
  is_required: boolean;
  description: string;
  sequence: number;
}> | null> {
  try {
    const result = await client.execute({
      sql: `
        SELECT id, name, display_name, is_required, description, sequence
        FROM validations
        WHERE ou = ?
        ORDER BY sequence ASC
      `,
      args: [ou],
    });

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows.map(row => ({
      id: row.id as number,
      name: row.name as string,
      display_name: row.display_name as string,
      is_required: row.is_required === 1,
      description: row.description as string,
      sequence: row.sequence as number,
    }));
  } catch (error) {
    console.error(`Error getting validations for OU ${ou}:`, error);
    return null;
  }
}

/**
 * Execute a raw SQL query for validation processors
 * @param query SQL query with placeholders
 * @param params Parameters for the query
 * @returns Query result
 */
export async function executeQuery(query: { sql: string; args: any[] }) {
  try {
    return await client.execute(query);
  } catch (error) {
    console.error('Error executing query:', error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//----------------- FINANCIAL DATA SYNC CHECK FUNCTIONS -----------------------------------------------------------

/**
 * Get the last successful sync check date for an OU
 * @param ou The organizational unit
 * @returns The last check date (YYYY-MM-DD) or null if never checked
 */
export async function getFinancialDataLastCheckDate(ou: string): Promise<string | null> {
  try {
    const result = await client.execute({
      sql: "SELECT last_check_date FROM financial_data_sync_checks WHERE ou = ?",
      args: [ou]
    });

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].last_check_date as string;
  } catch (error) {
    console.error(`Error getting financial data last check date for OU ${ou}:`, error);
    return null;
  }
}

/**
 * Get the last check timestamp for an OU (full ISO timestamp)
 * Used for cooldown enforcement
 */
export async function getFinancialDataLastCheckTimestamp(ou: string): Promise<string | null> {
  try {
    const result = await client.execute({
      sql: "SELECT last_check_timestamp FROM financial_data_sync_checks WHERE ou = ?",
      args: [ou]
    });

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].last_check_timestamp as string;
  } catch (error) {
    console.error(`Error getting financial data last check timestamp for OU ${ou}:`, error);
    return null;
  }
}

/**
 * Record a successful financial data sync check
 * @param ou The organizational unit
 * @param checkDate The date of the check (YYYY-MM-DD)
 * @param checkTimestamp Full ISO timestamp of the check
 * @param checkResult Result of the check ('up_to_date' or 'updated')
 */
export async function setFinancialDataSyncCheck(
  ou: string,
  checkDate: string,
  checkTimestamp: string,
  checkResult: string
): Promise<void> {
  try {
    await client.execute({
      sql: `
        INSERT INTO financial_data_sync_checks (ou, last_check_date, last_check_timestamp, check_result)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ou) DO UPDATE SET
          last_check_date = excluded.last_check_date,
          last_check_timestamp = excluded.last_check_timestamp,
          check_result = excluded.check_result
      `,
      args: [ou, checkDate, checkTimestamp, checkResult]
    });
  } catch (error) {
    console.error(`Error setting financial data sync check for OU ${ou}:`, error);
    throw error;
  }
}

//------------------------------------------------------------------------------------------------------------------
//--- EXCEL EXPORT QUERIES ----------------------------------------------------------------------------------------

/**
 * Get list of departments that have financial data for a specific OU.
 * ACT is always sourced from version='MAIN' (mirrors the actuals path in
 * getProteaGroupDepartmentDetailData). BUD uses the caller's version.
 * Also checks financial_data_staging for current period actuals.
 * Only includes departments where level_2 IN ('Lodging Operations', 'Lodging Non-Operating').
 * Uses department_description_detail_level_max for the display name.
 * Departments with no data rows are automatically excluded (JOIN behavior).
 */
export async function getDepartmentsWithDataForOU(
  ou: string,
  version: string = 'MAIN'
): Promise<Array<{ baseDepartment: string; departmentName: string; level7Group: string | null }>> {
  try {
    const query = `
      SELECT DISTINCT
        dm.base_department,
        dm.department_description_detail_level_max as department_name,
        dm.level_7 as level_7_group
      FROM financial_data fd
      JOIN department_maps dm ON fd.department = dm.base_department
      WHERE fd.ou = ?
        AND (
          (fd.scenario = 'ACT' AND fd.version = 'MAIN')
          OR (fd.scenario = 'BUD' AND fd.version = ?)
        )
        AND dm.level_2 IN ('Lodging Operations', 'Lodging Non-Operating')
      UNION
      SELECT DISTINCT
        dm.base_department,
        dm.department_description_detail_level_max as department_name,
        dm.level_7 as level_7_group
      FROM financial_data_staging fds
      JOIN department_maps dm ON fds.department = dm.base_department
      WHERE fds.ou = ?
        AND fds.scenario IN ('ACT', 'BUD')
        AND dm.level_2 IN ('Lodging Operations', 'Lodging Non-Operating')
      ORDER BY level_7_group, department_name
    `;

    const result = await client.execute({ sql: query, args: [ou, version, ou] });

    return result.rows.map(row => ({
      baseDepartment: row.base_department as string,
      departmentName: row.department_name as string || row.base_department as string,
      level7Group: (row.level_7_group as string) || null
    }));
  } catch (error) {
    console.error(`Error getting departments with data for OU ${ou}:`, error);
    throw error;
  }
}

/**
 * Interface for department detail row data
 */
export interface DepartmentDetailRow {
  account: string;
  accountName: string;
  category: string;
  level12Group: string | null;
  level13Group: string | null;
  level20Group: string | null;
  actuals: number;
  budget: number;
  vsBud: number;
  ly: number;
  vsLy: number;
}

/** Non-operating departments excluded from all report exports (Excel, Protea).
 *  TODO: Replace with a mapping table attribute (e.g., dm.is_reportable) in a future iteration. */
export const NON_OPERATING_EXCLUDED_DEPARTMENTS = new Set(['D1468', 'D3095', 'D0376', 'D0370', 'D3096', 'D0499']);

// ============================================================================
// DEPARTMENT DETAIL — SHARED INFRASTRUCTURE
// ============================================================================

/** Balance sheet accounts (A1xxx, A2xxx) are permanently excluded from all P&L reports.
 *  This is a fundamental accounting convention — these prefixes will never contain P&L data. */
function excludeBalanceSheet(alias: string): string {
  return `${alias} NOT LIKE 'A1%' AND ${alias} NOT LIKE 'A2%'`;
}

/** Standard category CASE clause — hierarchy-driven, no overrides. */
const STANDARD_CATEGORY_CASE = `
          WHEN am.level_6 = 'Revenue' THEN 'Revenue'
          WHEN am.level_9 = 'Cost Of Sales' THEN 'Cost of Sales'
          WHEN am.level_9 = 'Total Payroll' THEN 'Payroll'
          WHEN am.base_account LIKE 'A9%' THEN 'Stats'
          WHEN am.level_4 = 'Profit Amount' AND am.level_6 != 'Revenue' THEN 'Controllables'
          ELSE 'Other'`;

/** Standard sort order CASE clause — matches STANDARD_CATEGORY_CASE. */
const STANDARD_ORDER_CASE = `
          WHEN am.level_6 = 'Revenue' THEN 1
          WHEN am.level_9 = 'Cost Of Sales' THEN 2
          WHEN am.level_9 = 'Total Payroll' THEN 3
          WHEN am.level_4 = 'Profit Amount' AND am.level_6 != 'Revenue' THEN 4
          WHEN am.base_account LIKE 'A9%' THEN 6
          ELSE 5`;

function mapDetailRows(rows: any[]): DepartmentDetailRow[] {
  return rows.map(row => ({
    account: row.account as string,
    accountName: (row.account_name as string) || (row.account as string),
    category: row.category as string,
    level12Group: (row.level_12_group as string) || null,
    level13Group: (row.level_13_group as string) || null,
    level20Group: (row.level_20_group as string) || null,
    actuals: Number(row.actuals) || 0,
    budget: Number(row.budget) || 0,
    vsBud: Number(row.vs_bud) || 0,
    ly: Number(row.ly) || 0,
    vsLy: Number(row.vs_ly) || 0
  }));
}

// ============================================================================
// PROTEA-SPECIFIC CATEGORY REPOINTS
// Accounts whose detail-sheet category should differ from the standard
// hierarchy-based CASE logic. Protea-only — never applied to standard reports.
//
// PROTEA_CATEGORY_REPOINTS / PROTEA_CATEGORY_SORT_ORDER are imported from
// services/reports/proteaMovements.ts (single source of truth — also
// consumed by the measure engine to build Protea-aware totals).
// ============================================================================

/** Protea category CASE clause — standard hierarchy with repoint overrides. */
function buildProteaCategoryClauses(): { categoryCase: string; orderCase: string } {
  const repointCategory = PROTEA_CATEGORY_REPOINTS
    .map(r => `WHEN am.base_account = '${r.account}' THEN '${r.targetCategory}'`)
    .join('\n          ');
  const repointOrder = PROTEA_CATEGORY_REPOINTS
    .map(r => `WHEN am.base_account = '${r.account}' THEN ${PROTEA_CATEGORY_SORT_ORDER[r.targetCategory]}`)
    .join('\n          ');

  return {
    categoryCase: `
          ${repointCategory}${STANDARD_CATEGORY_CASE}`,
    orderCase: `
          ${repointOrder}${STANDARD_ORDER_CASE}`,
  };
}

// ============================================================================
// STANDARD DEPARTMENT DETAIL FUNCTIONS (non-Protea)
// Pure mapping-table-driven categorisation — no repoints or overrides.
// ============================================================================

/**
 * Get account-level detail data for a specific department.
 * Groups accounts by category using account_maps levels.
 */
export async function getDepartmentDetailData(
  ou: string,
  department: string,
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  version: string = 'MAIN'
): Promise<DepartmentDetailRow[]> {
  try {
    const {
      generatePeriods,
      generateLYPeriods
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);
    const latestStagingPeriod = periods[periods.length - 1];

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const lyPeriodPlaceholders = lyPeriods.map(() => '?').join(', ');

    const query = `
      WITH combined_actuals AS (
        SELECT
          COALESCE(fds.account, fd.account) AS account,
          SUM(COALESCE(
            CASE WHEN fds.period_combo = ? THEN fds.amount ELSE NULL END,
            fd.amount
          )) AS amount
        FROM financial_data fd
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'ACT'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department = ?
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY COALESCE(fds.account, fd.account)
        UNION ALL
        SELECT
          fds.account,
          SUM(fds.amount) AS amount
        FROM financial_data_staging fds
        LEFT JOIN financial_data fd
          ON fds.dep_acc_combo_id = fd.dep_acc_combo_id
          AND fds.period_combo = fd.period_combo
          AND fd.scenario = 'ACT'
          AND fd.version = ?
          AND fd.ou = fds.ou
        WHERE fds.scenario = 'ACT'
          AND fds.ou = ?
          AND fds.department = ?
          AND ${excludeBalanceSheet('fds.account')}
          AND fd.dep_acc_combo_id IS NULL
          AND fds.period_combo IN (${periodPlaceholders})
        GROUP BY fds.account
      ),
      actuals_totals AS (
        SELECT account, SUM(amount) AS actuals FROM combined_actuals
        WHERE ${excludeBalanceSheet('account')}
        GROUP BY account
      ),
      budget_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS budget
        FROM financial_data fd
        WHERE fd.scenario = 'BUD'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department = ?
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY fd.account
      ),
      ly_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS ly
        FROM financial_data fd
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department = ?
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${lyPeriodPlaceholders})
        GROUP BY fd.account
      )
      SELECT
        COALESCE(a.account, b.account, l.account) AS account,
        am.account_description_detail_level_max AS account_name,
        am.level_12 AS level_12_group,
        am.level_13 AS level_13_group,
        CASE ${STANDARD_CATEGORY_CASE}
        END AS category,
        COALESCE(a.actuals, 0) AS actuals,
        COALESCE(b.budget, 0) AS budget,
        COALESCE(a.actuals, 0) - COALESCE(b.budget, 0) AS vs_bud,
        COALESCE(l.ly, 0) AS ly,
        COALESCE(a.actuals, 0) - COALESCE(l.ly, 0) AS vs_ly
      FROM actuals_totals a
      FULL OUTER JOIN budget_totals b ON a.account = b.account
      FULL OUTER JOIN ly_totals l ON COALESCE(a.account, b.account) = l.account
      LEFT JOIN account_maps am ON COALESCE(a.account, b.account, l.account) = am.base_account
      WHERE COALESCE(a.account, b.account, l.account) IS NOT NULL
        AND ${excludeBalanceSheet('COALESCE(a.account, b.account, l.account)')}
      ORDER BY
        CASE ${STANDARD_ORDER_CASE}
        END,
        am.level_12,
        am.base_account
    `;

    // Actuals and LY always use 'MAIN' version; only budget uses user-selected version
    const params: any[] = [
      latestStagingPeriod,  // For COALESCE staging check
      ou, 'MAIN', department, // First combined_actuals WHERE - actuals always MAIN
      ...periods,  // First IN clause
      'MAIN',      // For LEFT JOIN check - actuals always MAIN
      ou, department,  // Second combined_actuals (staging-only)
      ...periods,  // Staging-only period filter
      ou, version, department,  // budget_totals - uses user selection
      ...periods,  // Budget periods
      ou, 'MAIN', department,  // ly_totals - last year always MAIN
      ...lyPeriods  // LY periods
    ];

    const result = await client.execute({ sql: query, args: params });
    return mapDetailRows(result.rows as any[]);
  } catch (error) {
    console.error(`Error getting department detail data for ${department}:`, error);
    throw error;
  }
}

/**
 * Get account-level detail data aggregated across multiple departments.
 * Used for department group summary sheets (e.g., all F&B departments combined).
 */
export async function getGroupDepartmentDetailData(
  ou: string,
  departments: string[],
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  version: string = 'MAIN'
): Promise<DepartmentDetailRow[]> {
  try {
    const {
      generatePeriods,
      generateLYPeriods
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);
    const latestStagingPeriod = periods[periods.length - 1];

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const lyPeriodPlaceholders = lyPeriods.map(() => '?').join(', ');
    const deptPlaceholders = departments.map(() => '?').join(', ');

    const query = `
      WITH combined_actuals AS (
        SELECT
          COALESCE(fds.account, fd.account) AS account,
          SUM(COALESCE(
            CASE WHEN fds.period_combo = ? THEN fds.amount ELSE NULL END,
            fd.amount
          )) AS amount
        FROM financial_data fd
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'ACT'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY COALESCE(fds.account, fd.account)
        UNION ALL
        SELECT
          fds.account,
          SUM(fds.amount) AS amount
        FROM financial_data_staging fds
        LEFT JOIN financial_data fd
          ON fds.dep_acc_combo_id = fd.dep_acc_combo_id
          AND fds.period_combo = fd.period_combo
          AND fd.scenario = 'ACT'
          AND fd.version = ?
          AND fd.ou = fds.ou
        WHERE fds.scenario = 'ACT'
          AND fds.ou = ?
          AND fds.department IN (${deptPlaceholders})
          AND ${excludeBalanceSheet('fds.account')}
          AND fd.dep_acc_combo_id IS NULL
          AND fds.period_combo IN (${periodPlaceholders})
        GROUP BY fds.account
      ),
      actuals_totals AS (
        SELECT account, SUM(amount) AS actuals FROM combined_actuals
        WHERE ${excludeBalanceSheet('account')}
        GROUP BY account
      ),
      budget_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS budget
        FROM financial_data fd
        WHERE fd.scenario = 'BUD'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY fd.account
      ),
      ly_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS ly
        FROM financial_data fd
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${lyPeriodPlaceholders})
        GROUP BY fd.account
      )
      SELECT
        COALESCE(a.account, b.account, l.account) AS account,
        am.account_description_detail_level_max AS account_name,
        am.level_12 AS level_12_group,
        am.level_13 AS level_13_group,
        CASE ${STANDARD_CATEGORY_CASE}
        END AS category,
        COALESCE(a.actuals, 0) AS actuals,
        COALESCE(b.budget, 0) AS budget,
        COALESCE(a.actuals, 0) - COALESCE(b.budget, 0) AS vs_bud,
        COALESCE(l.ly, 0) AS ly,
        COALESCE(a.actuals, 0) - COALESCE(l.ly, 0) AS vs_ly
      FROM actuals_totals a
      FULL OUTER JOIN budget_totals b ON a.account = b.account
      FULL OUTER JOIN ly_totals l ON COALESCE(a.account, b.account) = l.account
      LEFT JOIN account_maps am ON COALESCE(a.account, b.account, l.account) = am.base_account
      WHERE COALESCE(a.account, b.account, l.account) IS NOT NULL
        AND ${excludeBalanceSheet('COALESCE(a.account, b.account, l.account)')}
      ORDER BY
        CASE ${STANDARD_ORDER_CASE}
        END,
        am.level_12,
        am.base_account
    `;

    // Actuals and LY always use 'MAIN' version; only budget uses user-selected version
    const params: any[] = [
      latestStagingPeriod,
      ou, 'MAIN', ...departments,       // combined_actuals first part - actuals always MAIN
      ...periods,
      'MAIN',                            // combined_actuals LEFT JOIN - actuals always MAIN
      ou, ...departments,
      ...periods,  // Staging-only period filter
      ou, version, ...departments,       // budget_totals - uses user selection
      ...periods,
      ou, 'MAIN', ...departments,       // ly_totals - last year always MAIN
      ...lyPeriods
    ];

    const result = await client.execute({ sql: query, args: params });
    return mapDetailRows(result.rows as any[]);
  } catch (error) {
    console.error(`Error getting group department detail data:`, error);
    throw error;
  }
}

/**
 * Get account-level detail data aggregated across ALL lodging operations departments.
 * Used for the Hotel Total sheet in Excel export.
 */
export async function getAllDepartmentDetailData(
  ou: string,
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  version: string = 'MAIN',
  excludeDepartments: string[] = []
): Promise<DepartmentDetailRow[]> {
  try {
    const {
      generatePeriods,
      generateLYPeriods
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);
    const latestStagingPeriod = periods[periods.length - 1];

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const lyPeriodPlaceholders = lyPeriods.map(() => '?').join(', ');

    // Build optional department exclusion clause
    const hasExclusions = excludeDepartments.length > 0;
    const excludePlaceholders = hasExclusions
      ? `AND dm.base_department NOT IN (${excludeDepartments.map(() => '?').join(', ')})`
      : '';

    const query = `
      WITH combined_actuals AS (
        SELECT
          COALESCE(fds.account, fd.account) AS account,
          SUM(COALESCE(
            CASE WHEN fds.period_combo = ? THEN fds.amount ELSE NULL END,
            fd.amount
          )) AS amount
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'ACT'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND dm.level_2 IN ('Lodging Operations', 'Lodging Non-Operating')
          ${excludePlaceholders}
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY COALESCE(fds.account, fd.account)
        UNION ALL
        SELECT
          fds.account,
          SUM(fds.amount) AS amount
        FROM financial_data_staging fds
        JOIN department_maps dm ON fds.department = dm.base_department
        LEFT JOIN financial_data fd
          ON fds.dep_acc_combo_id = fd.dep_acc_combo_id
          AND fds.period_combo = fd.period_combo
          AND fd.scenario = 'ACT'
          AND fd.version = ?
          AND fd.ou = fds.ou
        WHERE fds.scenario = 'ACT'
          AND fds.ou = ?
          AND dm.level_2 IN ('Lodging Operations', 'Lodging Non-Operating')
          ${excludePlaceholders}
          AND ${excludeBalanceSheet('fds.account')}
          AND fd.dep_acc_combo_id IS NULL
          AND fds.period_combo IN (${periodPlaceholders})
        GROUP BY fds.account
      ),
      actuals_totals AS (
        SELECT account, SUM(amount) AS actuals FROM combined_actuals
        WHERE ${excludeBalanceSheet('account')}
        GROUP BY account
      ),
      budget_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS budget
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        WHERE fd.scenario = 'BUD'
          AND fd.ou = ?
          AND fd.version = ?
          AND dm.level_2 IN ('Lodging Operations', 'Lodging Non-Operating')
          ${excludePlaceholders}
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY fd.account
      ),
      ly_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS ly
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND dm.level_2 IN ('Lodging Operations', 'Lodging Non-Operating')
          ${excludePlaceholders}
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${lyPeriodPlaceholders})
        GROUP BY fd.account
      )
      SELECT
        COALESCE(a.account, b.account, l.account) AS account,
        am.account_description_detail_level_max AS account_name,
        am.level_12 AS level_12_group,
        am.level_13 AS level_13_group,
        CASE ${STANDARD_CATEGORY_CASE}
        END AS category,
        COALESCE(a.actuals, 0) AS actuals,
        COALESCE(b.budget, 0) AS budget,
        COALESCE(a.actuals, 0) - COALESCE(b.budget, 0) AS vs_bud,
        COALESCE(l.ly, 0) AS ly,
        COALESCE(a.actuals, 0) - COALESCE(l.ly, 0) AS vs_ly
      FROM actuals_totals a
      FULL OUTER JOIN budget_totals b ON a.account = b.account
      FULL OUTER JOIN ly_totals l ON COALESCE(a.account, b.account) = l.account
      LEFT JOIN account_maps am ON COALESCE(a.account, b.account, l.account) = am.base_account
      WHERE COALESCE(a.account, b.account, l.account) IS NOT NULL
        AND ${excludeBalanceSheet('COALESCE(a.account, b.account, l.account)')}
      ORDER BY
        CASE ${STANDARD_ORDER_CASE}
        END,
        am.level_12,
        am.base_account
    `;

    // Actuals and LY always use 'MAIN' version; only budget uses user-selected version
    const params: any[] = [
      latestStagingPeriod,
      ou, 'MAIN',           // combined_actuals first part - actuals always MAIN
      ...(hasExclusions ? excludeDepartments : []),
      ...periods,
      'MAIN',               // combined_actuals LEFT JOIN - actuals always MAIN
      ou,
      ...(hasExclusions ? excludeDepartments : []),
      ...periods,  // Staging-only period filter
      ou, version,           // budget_totals - uses user selection
      ...(hasExclusions ? excludeDepartments : []),
      ...periods,
      ou, 'MAIN',           // ly_totals - last year always MAIN
      ...(hasExclusions ? excludeDepartments : []),
      ...lyPeriods
    ];

    const result = await client.execute({ sql: query, args: params });
    return mapDetailRows(result.rows as any[]);
  } catch (error) {
    console.error(`Error getting all department detail data for hotel total:`, error);
    throw error;
  }
}

// ============================================================================
// PROTEA-SPECIFIC DEPARTMENT DETAIL FUNCTIONS
// Isolated from standard reports — includes Protea category repoints.
// These are separate functions (not flags) to ensure clean isolation and
// prevent Protea-specific logic from impacting the 500+ non-Protea hotels.
// ============================================================================

/**
 * Protea variant: Get account-level detail data for a specific department.
 * Includes Protea category repoints (e.g., A610112 → Payroll).
 */
export async function getProteaDepartmentDetailData(
  ou: string,
  department: string,
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  version: string = 'MAIN'
): Promise<DepartmentDetailRow[]> {
  try {
    const {
      generatePeriods,
      generateLYPeriods
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);
    const latestStagingPeriod = periods[periods.length - 1];

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const lyPeriodPlaceholders = lyPeriods.map(() => '?').join(', ');
    const proteaClauses = buildProteaCategoryClauses();

    const query = `
      WITH combined_actuals AS (
        SELECT
          COALESCE(fds.account, fd.account) AS account,
          SUM(COALESCE(
            CASE WHEN fds.period_combo = ? THEN fds.amount ELSE NULL END,
            fd.amount
          )) AS amount
        FROM financial_data fd
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'ACT'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department = ?
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY COALESCE(fds.account, fd.account)
        UNION ALL
        SELECT
          fds.account,
          SUM(fds.amount) AS amount
        FROM financial_data_staging fds
        LEFT JOIN financial_data fd
          ON fds.dep_acc_combo_id = fd.dep_acc_combo_id
          AND fds.period_combo = fd.period_combo
          AND fd.scenario = 'ACT'
          AND fd.version = ?
          AND fd.ou = fds.ou
        WHERE fds.scenario = 'ACT'
          AND fds.ou = ?
          AND fds.department = ?
          AND ${excludeBalanceSheet('fds.account')}
          AND fd.dep_acc_combo_id IS NULL
          AND fds.period_combo IN (${periodPlaceholders})
        GROUP BY fds.account
      ),
      actuals_totals AS (
        SELECT account, SUM(amount) AS actuals FROM combined_actuals
        WHERE ${excludeBalanceSheet('account')}
        GROUP BY account
      ),
      budget_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS budget
        FROM financial_data fd
        WHERE fd.scenario = 'BUD'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department = ?
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY fd.account
      ),
      ly_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS ly
        FROM financial_data fd
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department = ?
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${lyPeriodPlaceholders})
        GROUP BY fd.account
      )
      SELECT
        COALESCE(a.account, b.account, l.account) AS account,
        am.account_description_detail_level_max AS account_name,
        am.level_12 AS level_12_group,
        am.level_13 AS level_13_group,
        am.level_20 AS level_20_group,
        CASE ${proteaClauses.categoryCase}
        END AS category,
        COALESCE(a.actuals, 0) AS actuals,
        COALESCE(b.budget, 0) AS budget,
        COALESCE(a.actuals, 0) - COALESCE(b.budget, 0) AS vs_bud,
        COALESCE(l.ly, 0) AS ly,
        COALESCE(a.actuals, 0) - COALESCE(l.ly, 0) AS vs_ly
      FROM actuals_totals a
      FULL OUTER JOIN budget_totals b ON a.account = b.account
      FULL OUTER JOIN ly_totals l ON COALESCE(a.account, b.account) = l.account
      LEFT JOIN account_maps am ON COALESCE(a.account, b.account, l.account) = am.base_account
      WHERE COALESCE(a.account, b.account, l.account) IS NOT NULL
        AND ${excludeBalanceSheet('COALESCE(a.account, b.account, l.account)')}
      ORDER BY
        CASE ${proteaClauses.orderCase}
        END,
        am.level_12,
        am.base_account
    `;

    const params: any[] = [
      latestStagingPeriod,
      ou, 'MAIN', department,
      ...periods,
      'MAIN',
      ou, department,
      ...periods,
      ou, version, department,
      ...periods,
      ou, 'MAIN', department,
      ...lyPeriods
    ];

    const result = await client.execute({ sql: query, args: params });
    return mapDetailRows(result.rows as any[]);
  } catch (error) {
    console.error(`Error getting Protea department detail data for ${department}:`, error);
    throw error;
  }
}

/**
 * Protea variant: Get account-level detail data aggregated across multiple departments.
 * Includes Protea category repoints (e.g., A610112 → Payroll).
 */
export async function getProteaGroupDepartmentDetailData(
  ou: string,
  departments: string[],
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  version: string = 'MAIN'
): Promise<DepartmentDetailRow[]> {
  try {
    const {
      generatePeriods,
      generateLYPeriods
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);
    const latestStagingPeriod = periods[periods.length - 1];

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const lyPeriodPlaceholders = lyPeriods.map(() => '?').join(', ');
    const deptPlaceholders = departments.map(() => '?').join(', ');
    const proteaClauses = buildProteaCategoryClauses();

    const query = `
      WITH combined_actuals AS (
        SELECT
          COALESCE(fds.account, fd.account) AS account,
          SUM(COALESCE(
            CASE WHEN fds.period_combo = ? THEN fds.amount ELSE NULL END,
            fd.amount
          )) AS amount
        FROM financial_data fd
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'ACT'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY COALESCE(fds.account, fd.account)
        UNION ALL
        SELECT
          fds.account,
          SUM(fds.amount) AS amount
        FROM financial_data_staging fds
        LEFT JOIN financial_data fd
          ON fds.dep_acc_combo_id = fd.dep_acc_combo_id
          AND fds.period_combo = fd.period_combo
          AND fd.scenario = 'ACT'
          AND fd.version = ?
          AND fd.ou = fds.ou
        WHERE fds.scenario = 'ACT'
          AND fds.ou = ?
          AND fds.department IN (${deptPlaceholders})
          AND ${excludeBalanceSheet('fds.account')}
          AND fd.dep_acc_combo_id IS NULL
          AND fds.period_combo IN (${periodPlaceholders})
        GROUP BY fds.account
      ),
      actuals_totals AS (
        SELECT account, SUM(amount) AS actuals FROM combined_actuals
        WHERE ${excludeBalanceSheet('account')}
        GROUP BY account
      ),
      budget_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS budget
        FROM financial_data fd
        WHERE fd.scenario = 'BUD'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${periodPlaceholders})
        GROUP BY fd.account
      ),
      ly_totals AS (
        SELECT
          fd.account,
          SUM(fd.amount) AS ly
        FROM financial_data fd
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND ${excludeBalanceSheet('fd.account')}
          AND fd.period_combo IN (${lyPeriodPlaceholders})
        GROUP BY fd.account
      )
      SELECT
        COALESCE(a.account, b.account, l.account) AS account,
        am.account_description_detail_level_max AS account_name,
        am.level_12 AS level_12_group,
        am.level_13 AS level_13_group,
        am.level_20 AS level_20_group,
        CASE ${proteaClauses.categoryCase}
        END AS category,
        COALESCE(a.actuals, 0) AS actuals,
        COALESCE(b.budget, 0) AS budget,
        COALESCE(a.actuals, 0) - COALESCE(b.budget, 0) AS vs_bud,
        COALESCE(l.ly, 0) AS ly,
        COALESCE(a.actuals, 0) - COALESCE(l.ly, 0) AS vs_ly
      FROM actuals_totals a
      FULL OUTER JOIN budget_totals b ON a.account = b.account
      FULL OUTER JOIN ly_totals l ON COALESCE(a.account, b.account) = l.account
      LEFT JOIN account_maps am ON COALESCE(a.account, b.account, l.account) = am.base_account
      WHERE COALESCE(a.account, b.account, l.account) IS NOT NULL
        AND ${excludeBalanceSheet('COALESCE(a.account, b.account, l.account)')}
      ORDER BY
        CASE ${proteaClauses.orderCase}
        END,
        am.level_12,
        am.base_account
    `;

    const params: any[] = [
      latestStagingPeriod,
      ou, 'MAIN', ...departments,
      ...periods,
      'MAIN',
      ou, ...departments,
      ...periods,
      ou, version, ...departments,
      ...periods,
      ou, 'MAIN', ...departments,
      ...lyPeriods
    ];

    const result = await client.execute({ sql: query, args: params });
    return mapDetailRows(result.rows as any[]);
  } catch (error) {
    console.error(`Error getting Protea group department detail data:`, error);
    throw error;
  }
}

/**
 * Discovers the bottom-level Payroll Burden base_accounts that have data
 * within the Protea Payroll tab's scope (Lodging Operations level_2 ×
 * (level_12 'Associate Benefits' OR repointed NOT BENEFITS accounts)).
 *
 * "Has data" = any non-zero row in ACT/BUD/LY across either the selected
 * month or the custom range. Includes financial_data and the latest
 * staging period; the precise staging-vs-actual reconciliation isn't
 * needed here — we only care about account existence.
 *
 * Returns accounts sorted: Associate Benefits accounts alphabetically by
 * description first, then the 3 NOT BENEFITS lines at the bottom (also
 * alphabetical). Consumer (proteaReportPackService) uses this list to
 * (a) dynamically register `payroll_burden_acct_<base>` measures and
 * (b) build the Payroll-tab burden rows — replacing the previous static
 * 15-line list + 'Other' catch-all.
 */
export interface PayrollBurdenAccount {
  account: string;
  name: string;
  isAssocBenefit: boolean;
}

export async function getProteaPayrollBurdenAccounts(
  ou: string,
  version: string,
  monthRange: { startMonth: number; startYear: number; endMonth: number; endYear: number },
  customRange: { startMonth: number; startYear: number; endMonth: number; endYear: number },
  repointAccounts: readonly string[]
): Promise<PayrollBurdenAccount[]> {
  try {
    const {
      generatePeriods,
      generateLYPeriods,
    } = await import('./services/reports/plCalculationEngine');

    // Union all relevant periods (month + range) and their LY equivalents.
    const monthPeriods = generatePeriods(monthRange);
    const rangePeriods = generatePeriods(customRange);
    const actPeriods = Array.from(new Set([...monthPeriods, ...rangePeriods]));
    const lyPeriods = Array.from(new Set([
      ...generateLYPeriods(monthPeriods),
      ...generateLYPeriods(rangePeriods),
    ]));
    const latestStagingPeriod = actPeriods[actPeriods.length - 1];

    const actPlaceholders = actPeriods.map(() => '?').join(', ');
    const lyPlaceholders = lyPeriods.map(() => '?').join(', ');
    const repointPlaceholders = repointAccounts.map(() => '?').join(', ');
    const burdenScopeClause = repointAccounts.length > 0
      ? `(am.level_12 = 'Associate Benefits' OR fd.account IN (${repointPlaceholders}))`
      : `am.level_12 = 'Associate Benefits'`;
    const burdenScopeClauseStaging = repointAccounts.length > 0
      ? `(am.level_12 = 'Associate Benefits' OR fds.account IN (${repointPlaceholders}))`
      : `am.level_12 = 'Associate Benefits'`;

    // Union of fd ACT (current version path = MAIN, mirrors detail query) +
    // fd BUD (caller version) + fd ACT for LY periods + staging for latest period.
    // amount != 0 in each subquery keeps the set tight; a SELECT DISTINCT outer
    // wrap is unnecessary — the GROUP BY does it.
    const query = `
      WITH burden_hits AS (
        SELECT fd.account
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        JOIN account_maps am ON fd.account = am.base_account
        WHERE fd.ou = ?
          AND fd.scenario = 'ACT'
          AND fd.version = 'MAIN'
          AND dm.level_2 = 'Lodging Operations'
          AND ${burdenScopeClause}
          AND fd.period_combo IN (${actPlaceholders})
          AND fd.amount != 0

        UNION ALL

        SELECT fd.account
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        JOIN account_maps am ON fd.account = am.base_account
        WHERE fd.ou = ?
          AND fd.scenario = 'BUD'
          AND fd.version = ?
          AND dm.level_2 = 'Lodging Operations'
          AND ${burdenScopeClause}
          AND fd.period_combo IN (${actPlaceholders})
          AND fd.amount != 0

        UNION ALL

        SELECT fd.account
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        JOIN account_maps am ON fd.account = am.base_account
        WHERE fd.ou = ?
          AND fd.scenario = 'ACT'
          AND fd.version = 'MAIN'
          AND dm.level_2 = 'Lodging Operations'
          AND ${burdenScopeClause}
          AND fd.period_combo IN (${lyPlaceholders})
          AND fd.amount != 0

        UNION ALL

        SELECT fds.account
        FROM financial_data_staging fds
        JOIN department_maps dm ON fds.department = dm.base_department
        JOIN account_maps am ON fds.account = am.base_account
        WHERE fds.ou = ?
          AND fds.scenario = 'ACT'
          AND dm.level_2 = 'Lodging Operations'
          AND ${burdenScopeClauseStaging}
          AND fds.period_combo = ?
          AND fds.amount != 0
      )
      SELECT
        am.base_account AS account,
        am.account_description_detail_level_max AS name,
        CASE WHEN am.level_12 = 'Associate Benefits' THEN 1 ELSE 0 END AS is_assoc_benefit
      FROM burden_hits bh
      JOIN account_maps am ON bh.account = am.base_account
      GROUP BY am.base_account, am.account_description_detail_level_max, am.level_12
      ORDER BY is_assoc_benefit DESC, name ASC
    `;

    const params: any[] = [
      // ACT block
      ou,
      ...repointAccounts,
      ...actPeriods,
      // BUD block
      ou, version,
      ...repointAccounts,
      ...actPeriods,
      // LY block
      ou,
      ...repointAccounts,
      ...lyPeriods,
      // Staging block
      ou,
      ...repointAccounts,
      latestStagingPeriod,
    ];

    const result = await client.execute({ sql: query, args: params });
    return result.rows.map(r => ({
      account: r.account as string,
      name: (r.name as string) || (r.account as string),
      isAssocBenefit: Number(r.is_assoc_benefit) === 1,
    }));
  } catch (error) {
    console.error(`Error getting Protea payroll burden accounts:`, error);
    throw error;
  }
}

/**
 * Interface for per-unit denominator values (rooms sold or covers)
 */
export interface PerUnitDenominator {
  actuals: number;
  budget: number;
  ly: number;
}

/**
 * Get rooms sold (A960103) for a given period range.
 * Used as the per-unit denominator for non-F&B department sheets.
 */
export async function getRoomsSoldForPeriod(
  ou: string,
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  version: string = 'MAIN'
): Promise<PerUnitDenominator> {
  try {
    const {
      generatePeriods,
      generateLYPeriods
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);
    const latestStagingPeriod = periods[periods.length - 1];

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const lyPeriodPlaceholders = lyPeriods.map(() => '?').join(', ');

    const query = `
      WITH combined_actuals AS (
        SELECT
          SUM(COALESCE(
            CASE WHEN fds.period_combo = ? THEN fds.amount ELSE NULL END,
            fd.amount
          )) AS amount
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'ACT'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.account = 'A960103'
          AND dm.level_10 = 'Rooms'
          AND fd.period_combo IN (${periodPlaceholders})
        UNION ALL
        SELECT
          SUM(fds.amount) AS amount
        FROM financial_data_staging fds
        JOIN department_maps dm ON fds.department = dm.base_department
        LEFT JOIN financial_data fd
          ON fds.dep_acc_combo_id = fd.dep_acc_combo_id
          AND fds.period_combo = fd.period_combo
          AND fd.scenario = 'ACT'
          AND fd.version = ?
          AND fd.ou = fds.ou
        WHERE fds.scenario = 'ACT'
          AND fds.ou = ?
          AND fds.account = 'A960103'
          AND dm.level_10 = 'Rooms'
          AND fd.dep_acc_combo_id IS NULL
      ),
      budget_total AS (
        SELECT SUM(fd.amount) AS budget
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        WHERE fd.scenario = 'BUD'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.account = 'A960103'
          AND dm.level_10 = 'Rooms'
          AND fd.period_combo IN (${periodPlaceholders})
      ),
      ly_total AS (
        SELECT SUM(fd.amount) AS ly
        FROM financial_data fd
        JOIN department_maps dm ON fd.department = dm.base_department
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.account = 'A960103'
          AND dm.level_10 = 'Rooms'
          AND fd.period_combo IN (${lyPeriodPlaceholders})
      )
      SELECT
        COALESCE((SELECT SUM(amount) FROM combined_actuals), 0) AS actuals,
        COALESCE((SELECT budget FROM budget_total), 0) AS budget,
        COALESCE((SELECT ly FROM ly_total), 0) AS ly
    `;

    // Actuals and LY always use 'MAIN' version; only budget uses user-selected version
    const params: any[] = [
      latestStagingPeriod,
      ou, 'MAIN',           // combined_actuals first part - actuals always MAIN
      ...periods,
      'MAIN',               // combined_actuals LEFT JOIN - actuals always MAIN
      ou,
      ou, version,           // budget_total - uses user selection
      ...periods,
      ou, 'MAIN',           // ly_total - last year always MAIN
      ...lyPeriods
    ];

    const result = await client.execute({ sql: query, args: params });
    const row = result.rows[0];

    return {
      actuals: Number(row?.actuals) || 0,
      budget: Number(row?.budget) || 0,
      ly: Number(row?.ly) || 0
    };
  } catch (error) {
    console.error('Error getting rooms sold for period:', error);
    throw error;
  }
}

/**
 * Get department volume (covers) for F&B departments for a given period range.
 * Queries accounts where account_maps.level_4 = 'Department Volume'.
 * Used as the per-unit denominator for F&B department sheets.
 */
export async function getDepartmentVolumeForPeriod(
  ou: string,
  departments: string[],
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  version: string = 'MAIN'
): Promise<PerUnitDenominator> {
  try {
    const {
      generatePeriods,
      generateLYPeriods
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);
    const latestStagingPeriod = periods[periods.length - 1];

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const lyPeriodPlaceholders = lyPeriods.map(() => '?').join(', ');
    const deptPlaceholders = departments.map(() => '?').join(', ');

    const query = `
      WITH combined_actuals AS (
        SELECT
          SUM(COALESCE(
            CASE WHEN fds.period_combo = ? THEN fds.amount ELSE NULL END,
            fd.amount
          )) AS amount
        FROM financial_data fd
        JOIN account_maps am ON fd.account = am.base_account
        LEFT JOIN financial_data_staging fds
          ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
          AND fd.period_combo = fds.period_combo
          AND fds.scenario = 'ACT'
          AND fds.ou = fd.ou
          AND fds.version = fd.version
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND am.level_4 = 'Department Volume'
          AND fd.period_combo IN (${periodPlaceholders})
        UNION ALL
        SELECT
          SUM(fds.amount) AS amount
        FROM financial_data_staging fds
        JOIN account_maps am ON fds.account = am.base_account
        LEFT JOIN financial_data fd
          ON fds.dep_acc_combo_id = fd.dep_acc_combo_id
          AND fds.period_combo = fd.period_combo
          AND fd.scenario = 'ACT'
          AND fd.version = ?
          AND fd.ou = fds.ou
        WHERE fds.scenario = 'ACT'
          AND fds.ou = ?
          AND fds.department IN (${deptPlaceholders})
          AND am.level_4 = 'Department Volume'
          AND fd.dep_acc_combo_id IS NULL
      ),
      budget_total AS (
        SELECT SUM(fd.amount) AS budget
        FROM financial_data fd
        JOIN account_maps am ON fd.account = am.base_account
        WHERE fd.scenario = 'BUD'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND am.level_4 = 'Department Volume'
          AND fd.period_combo IN (${periodPlaceholders})
      ),
      ly_total AS (
        SELECT SUM(fd.amount) AS ly
        FROM financial_data fd
        JOIN account_maps am ON fd.account = am.base_account
        WHERE fd.scenario = 'ACT'
          AND fd.ou = ?
          AND fd.version = ?
          AND fd.department IN (${deptPlaceholders})
          AND am.level_4 = 'Department Volume'
          AND fd.period_combo IN (${lyPeriodPlaceholders})
      )
      SELECT
        COALESCE((SELECT SUM(amount) FROM combined_actuals), 0) AS actuals,
        COALESCE((SELECT budget FROM budget_total), 0) AS budget,
        COALESCE((SELECT ly FROM ly_total), 0) AS ly
    `;

    // Actuals and LY always use 'MAIN' version; only budget uses user-selected version
    const params: any[] = [
      latestStagingPeriod,
      ou, 'MAIN', ...departments,       // combined_actuals first part - actuals always MAIN
      ...periods,
      'MAIN',                            // combined_actuals LEFT JOIN - actuals always MAIN
      ou, ...departments,
      ou, version, ...departments,       // budget_total - uses user selection
      ...periods,
      ou, 'MAIN', ...departments,       // ly_total - last year always MAIN
      ...lyPeriods
    ];

    const result = await client.execute({ sql: query, args: params });
    const row = result.rows[0];

    return {
      actuals: Number(row?.actuals) || 0,
      budget: Number(row?.budget) || 0,
      ly: Number(row?.ly) || 0
    };
  } catch (error) {
    console.error('Error getting department volume for period:', error);
    throw error;
  }
}

/**
 * Room segment account configuration — shared between aggregated export
 * (getRoomSegmentExportData) and per-month pivot (getRoomSegmentBudgetByMonth).
 */
export interface RoomSegmentConfig {
  revenueAccount: string;
  statAccount: string;
  description: string;
  category: string;
  consolidatedName: string;
  consolidatedCategory: string;
}

export const ROOM_SEGMENTS_CONFIG: RoomSegmentConfig[] = [
  // Sun-Thur Transient
  { revenueAccount: "A361010", statAccount: "A961010", description: "Premium Retail Sun-Thur", category: "Sun-Thur", consolidatedName: "Premium Retail", consolidatedCategory: "Transient" },
  { revenueAccount: "A361011", statAccount: "A961011", description: "Regular Sun-Thur", category: "Sun-Thur", consolidatedName: "Regular", consolidatedCategory: "Transient" },
  { revenueAccount: "A361012", statAccount: "A961012", description: "Standard Retail Sun-Thur", category: "Sun-Thur", consolidatedName: "Standard Retail", consolidatedCategory: "Transient" },
  { revenueAccount: "A361013", statAccount: "A961013", description: "Spec Corp Sun-Thur", category: "Sun-Thur", consolidatedName: "Spec Corp", consolidatedCategory: "Transient" },
  { revenueAccount: "A361014", statAccount: "A961014", description: "Stay For Breakfast Sun-Thurs", category: "Sun-Thur", consolidatedName: "Stay For Breakfast", consolidatedCategory: "Transient" },
  { revenueAccount: "A361015", statAccount: "A961015", description: "Oth Disc Sun-Thur", category: "Sun-Thur", consolidatedName: "Oth Disc", consolidatedCategory: "Transient" },
  { revenueAccount: "A361016", statAccount: "A961016", description: "Adv Purch Sun-Thu", category: "Sun-Thur", consolidatedName: "Adv Purch", consolidatedCategory: "Transient" },
  { revenueAccount: "A361017", statAccount: "A961017", description: "Wholesalr Sun-Thu", category: "Sun-Thur", consolidatedName: "Wholesaler", consolidatedCategory: "Transient" },
  { revenueAccount: "A361018", statAccount: "A961018", description: "Packages Sun-Thu", category: "Sun-Thur", consolidatedName: "Packages", consolidatedCategory: "Transient" },
  { revenueAccount: "A361019", statAccount: "A961019", description: "Leisure Sun-Thu", category: "Sun-Thur", consolidatedName: "Leisure", consolidatedCategory: "Transient" },
  { revenueAccount: "A361020", statAccount: "A961020", description: "Weekend Sun-Thu", category: "Sun-Thur", consolidatedName: "Weekend", consolidatedCategory: "Transient" },
  { revenueAccount: "A361021", statAccount: "A961021", description: "Aaa Sun-Thurs", category: "Sun-Thur", consolidatedName: "Aaa", consolidatedCategory: "Transient" },
  { revenueAccount: "A361026", statAccount: "A961026", description: "Govt / Military Sun-Thur", category: "Sun-Thur", consolidatedName: "Govt / Military", consolidatedCategory: "Transient" },
  { revenueAccount: "A361027", statAccount: "A961027", description: "Senior Discount Sun-Thurs", category: "Sun-Thur", consolidatedName: "Senior Discount", consolidatedCategory: "Transient" },
  { revenueAccount: "A361028", statAccount: "A961028", description: "Travel Industry Sun-Thu", category: "Sun-Thur", consolidatedName: "Travel Industry", consolidatedCategory: "Transient" },
  { revenueAccount: "A361029", statAccount: "A961029", description: "Associate Leisure Sun-Thur", category: "Sun-Thur", consolidatedName: "Associate Leisure", consolidatedCategory: "Transient" },
  { revenueAccount: "A361030", statAccount: "A961030", description: "Echannel Retail Sun-Thur", category: "Sun-Thur", consolidatedName: "Echannel Retail", consolidatedCategory: "Transient" },
  { revenueAccount: "A361031", statAccount: "A961031", description: "Reward Redem/Upgrades Sun-Thur", category: "Sun-Thur", consolidatedName: "Reward Redem/Upgrades", consolidatedCategory: "Transient" },
  { revenueAccount: "A361032", statAccount: "A961032", description: "Natl Rooms Rev Sun-Thur", category: "Sun-Thur", consolidatedName: "Natl Rooms Rev", consolidatedCategory: "Transient" },
  { revenueAccount: "A361033", statAccount: "A961033", description: "Volume Rms Rev Sun Thurs", category: "Sun-Thur", consolidatedName: "Volume Rms Rev", consolidatedCategory: "Transient" },
  { revenueAccount: "A361318", statAccount: "A961318", description: "Contract Sun-Thur", category: "Sun-Thur", consolidatedName: "Contract", consolidatedCategory: "Transient" },
  // Sun-Thur Groups
  { revenueAccount: "A361334", statAccount: "A961334", description: "Corp Grp Sun-Thur", category: "Groups", consolidatedName: "Corp Grp", consolidatedCategory: "Groups" },
  { revenueAccount: "A361335", statAccount: "A961335", description: "Assoc Grp Sun-Thur", category: "Groups", consolidatedName: "Assoc Grp", consolidatedCategory: "Groups" },
  { revenueAccount: "A361336", statAccount: "A961336", description: "Other Grp Sun-Thur", category: "Groups", consolidatedName: "Other Grp", consolidatedCategory: "Groups" },
  { revenueAccount: "A361337", statAccount: "A961337", description: "Tour Wholesale Grp Sun Thur", category: "Groups", consolidatedName: "Tour Wholesale Grp", consolidatedCategory: "Groups" },
  { revenueAccount: "A361338", statAccount: "A961338", description: "Government Grp Sun Thurs", category: "Groups", consolidatedName: "Government Grp", consolidatedCategory: "Groups" },
  // Fri-Sat Transient
  { revenueAccount: "A361510", statAccount: "A961510", description: "Premium Retail Fri-Sat", category: "Fri-Sat", consolidatedName: "Premium Retail", consolidatedCategory: "Transient" },
  { revenueAccount: "A361511", statAccount: "A961511", description: "Regular Fri-Sat", category: "Fri-Sat", consolidatedName: "Regular", consolidatedCategory: "Transient" },
  { revenueAccount: "A361512", statAccount: "A961512", description: "Standard Retail Fri-Sat", category: "Fri-Sat", consolidatedName: "Standard Retail", consolidatedCategory: "Transient" },
  { revenueAccount: "A361513", statAccount: "A961513", description: "Spec Corp Fri-Sat", category: "Fri-Sat", consolidatedName: "Spec Corp", consolidatedCategory: "Transient" },
  { revenueAccount: "A361514", statAccount: "A961514", description: "Stay For Breakfast Fri-Sat", category: "Fri-Sat", consolidatedName: "Stay For Breakfast", consolidatedCategory: "Transient" },
  { revenueAccount: "A361515", statAccount: "A961515", description: "Oth Disc Fri-Sat", category: "Fri-Sat", consolidatedName: "Oth Disc", consolidatedCategory: "Transient" },
  { revenueAccount: "A361516", statAccount: "A961516", description: "Adv Purch Fri-Sat", category: "Fri-Sat", consolidatedName: "Adv Purch", consolidatedCategory: "Transient" },
  { revenueAccount: "A361517", statAccount: "A961517", description: "Wholesaler Fri-Sat", category: "Fri-Sat", consolidatedName: "Wholesaler", consolidatedCategory: "Transient" },
  { revenueAccount: "A361518", statAccount: "A961518", description: "Packages Fri-Sat", category: "Fri-Sat", consolidatedName: "Packages", consolidatedCategory: "Transient" },
  { revenueAccount: "A361519", statAccount: "A961519", description: "Leisure Fri-Sat", category: "Fri-Sat", consolidatedName: "Leisure", consolidatedCategory: "Transient" },
  { revenueAccount: "A361520", statAccount: "A961520", description: "Weekend Fri-Sat", category: "Fri-Sat", consolidatedName: "Weekend", consolidatedCategory: "Transient" },
  { revenueAccount: "A361521", statAccount: "A961521", description: "Aaa Fri-Sat", category: "Fri-Sat", consolidatedName: "Aaa", consolidatedCategory: "Transient" },
  { revenueAccount: "A361526", statAccount: "A961526", description: "Govt / Military Fri-Sat", category: "Fri-Sat", consolidatedName: "Govt / Military", consolidatedCategory: "Transient" },
  { revenueAccount: "A361527", statAccount: "A961527", description: "Senior Discount Fri-Sat", category: "Fri-Sat", consolidatedName: "Senior Discount", consolidatedCategory: "Transient" },
  { revenueAccount: "A361528", statAccount: "A961528", description: "Travel Industry Fri-Sat", category: "Fri-Sat", consolidatedName: "Travel Industry", consolidatedCategory: "Transient" },
  { revenueAccount: "A361529", statAccount: "A961529", description: "Associate Leisure Fri-Sat", category: "Fri-Sat", consolidatedName: "Associate Leisure", consolidatedCategory: "Transient" },
  { revenueAccount: "A361530", statAccount: "A961530", description: "Echannel Retail Fri-Sat", category: "Fri-Sat", consolidatedName: "Echannel Retail", consolidatedCategory: "Transient" },
  { revenueAccount: "A361531", statAccount: "A961531", description: "Reward Redem/Upgrades Fri-Sat", category: "Fri-Sat", consolidatedName: "Reward Redem/Upgrades", consolidatedCategory: "Transient" },
  { revenueAccount: "A361533", statAccount: "A961533", description: "Volume Rms Rev Fri Sat", category: "Fri-Sat", consolidatedName: "Volume Rms Rev", consolidatedCategory: "Transient" },
  // Complimentary
  { revenueAccount: "A361601", statAccount: "A961601", description: "Assoc CMP Sun-Thu", category: "Complimentary", consolidatedName: "Assoc CMP", consolidatedCategory: "Complimentary" },
  { revenueAccount: "A361602", statAccount: "A961602", description: "Assoc CMP Fri-Sat", category: "Complimentary", consolidatedName: "Assoc CMP", consolidatedCategory: "Complimentary" },
  { revenueAccount: "A361603", statAccount: "A961603", description: "Corp CMP Sun-Thu", category: "Complimentary", consolidatedName: "Corp CMP", consolidatedCategory: "Complimentary" },
  { revenueAccount: "A361604", statAccount: "A961604", description: "Corp CMP Fri-Sat", category: "Complimentary", consolidatedName: "Corp CMP", consolidatedCategory: "Complimentary" },
  { revenueAccount: "A361607", statAccount: "A961607", description: "Other CMP Sun-Thu", category: "Complimentary", consolidatedName: "Other CMP", consolidatedCategory: "Complimentary" },
  { revenueAccount: "A361608", statAccount: "A961608", description: "Other Cmp Fri-Sat", category: "Complimentary", consolidatedName: "Other CMP", consolidatedCategory: "Complimentary" },
  // Fri-Sat Groups
  { revenueAccount: "A361734", statAccount: "A961734", description: "Corp Grp Fri-Sat", category: "Groups", consolidatedName: "Corp Grp", consolidatedCategory: "Groups" },
  { revenueAccount: "A361735", statAccount: "A961735", description: "Assoc Grp Fri-Sat", category: "Groups", consolidatedName: "Assoc Grp", consolidatedCategory: "Groups" },
  { revenueAccount: "A361736", statAccount: "A961736", description: "Other Grp Fri-Sat", category: "Groups", consolidatedName: "Other Grp", consolidatedCategory: "Groups" },
  { revenueAccount: "A361737", statAccount: "A961737", description: "Tour Wholesales Grp Fri Sat", category: "Groups", consolidatedName: "Tour Wholesale Grp", consolidatedCategory: "Groups" },
  { revenueAccount: "A361738", statAccount: "A961738", description: "Government Grp Fri Sat", category: "Groups", consolidatedName: "Government Grp", consolidatedCategory: "Groups" },
  // Fri-Sat extras
  { revenueAccount: "A361818", statAccount: "A961818", description: "Contract Fri-Sat", category: "Fri-Sat", consolidatedName: "Contract", consolidatedCategory: "Transient" },
  { revenueAccount: "A361532", statAccount: "A961532", description: "Natl Rooms Rev Fri-Sat", category: "Fri-Sat", consolidatedName: "Natl Rooms Rev", consolidatedCategory: "Transient" },
];

/**
 * Interface for room segment export row
 */
export interface RoomSegmentExportRow {
  description: string;
  category: string;
  consolidatedName: string;
  consolidatedCategory: string;
  revenueActuals: number;
  revenueBudget: number;
  revenueLy: number;
  nightsActuals: number;
  nightsBudget: number;
  nightsLy: number;
}

/**
 * Get room segment data for Excel export
 * Uses the SEGMENTS_CONFIG account mappings
 */
export async function getRoomSegmentExportData(
  ou: string,
  startMonth: number,
  startYear: number,
  endMonth: number,
  endYear: number,
  version: string = 'MAIN'
): Promise<RoomSegmentExportRow[]> {
  try {
    const {
      generatePeriods,
      generateLYPeriods
    } = await import('./services/reports/plCalculationEngine');

    const periodRange = { startMonth, startYear, endMonth, endYear };
    const periods = generatePeriods(periodRange);
    const lyPeriods = generateLYPeriods(periods);
    const latestStagingPeriod = periods[periods.length - 1];

    const SEGMENTS_CONFIG = ROOM_SEGMENTS_CONFIG;

    const periodPlaceholders = periods.map(() => '?').join(', ');
    const lyPeriodPlaceholders = lyPeriods.map(() => '?').join(', ');
    const results: RoomSegmentExportRow[] = [];

    for (const segment of SEGMENTS_CONFIG) {
      // Actuals and LY always use 'MAIN' version; only budget uses user-selected version
      const revenueParams = [
        latestStagingPeriod,
        ou, 'MAIN',                      // actuals_combined - actuals always MAIN
        segment.revenueAccount,
        ...periods,
        segment.revenueAccount,
        ...periods,
        ou,
        'MAIN',                           // NOT EXISTS — actuals existence check always MAIN
        ou, version,                      // budget - uses user selection
        segment.revenueAccount,
        ...periods,
        ou, 'MAIN',                       // ly - last year always MAIN
        segment.revenueAccount,
        ...lyPeriods
      ];

      const revenueQuery = `
        WITH actuals_combined AS (
          SELECT
            COALESCE(fds.account, fd.account) AS account,
            COALESCE(fds.amount, fd.amount) AS amount
          FROM financial_data fd
          LEFT JOIN financial_data_staging fds
            ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
            AND fds.period_combo = ?
            AND fd.period_combo = fds.period_combo
            AND fds.scenario = 'ACT'
            AND fds.ou = fd.ou
            AND fds.version = fd.version
          WHERE fd.scenario = 'ACT'
            AND fd.ou = ?
            AND fd.version = ?
            AND fd.account = ?
            AND fd.period_combo IN (${periodPlaceholders})

          UNION ALL

          SELECT
            fds.account,
            fds.amount
          FROM financial_data_staging fds
          WHERE fds.scenario = 'ACT'
            AND fds.account = ?
            AND fds.period_combo IN (${periodPlaceholders})
            AND fds.ou = ?
            AND NOT EXISTS (
              SELECT 1 FROM financial_data fd2
              WHERE fd2.dep_acc_combo_id = fds.dep_acc_combo_id
                AND fd2.period_combo = fds.period_combo
                AND fd2.scenario = 'ACT'
                AND fd2.version = ?
                AND fd2.ou = fds.ou
            )
        ),
        actuals AS (
          SELECT account, SUM(amount) AS amount
          FROM actuals_combined
          GROUP BY account
        ),
        budget AS (
          SELECT account, SUM(amount) AS amount
          FROM financial_data
          WHERE scenario = 'BUD'
            AND ou = ?
            AND version = ?
            AND account = ?
            AND period_combo IN (${periodPlaceholders})
          GROUP BY account
        ),
        ly AS (
          SELECT account, SUM(amount) AS amount
          FROM financial_data
          WHERE scenario = 'ACT'
            AND ou = ?
            AND version = ?
            AND account = ?
            AND period_combo IN (${lyPeriodPlaceholders})
          GROUP BY account
        )
        SELECT
          COALESCE(act.amount, 0) AS actuals,
          COALESCE(bud.amount, 0) AS budget,
          COALESCE(l.amount, 0) AS ly
        FROM (SELECT 1) dummy
        LEFT JOIN actuals act ON 1=1
        LEFT JOIN budget bud ON 1=1
        LEFT JOIN ly l ON 1=1
      `;

      const revenueResult = await client.execute({ sql: revenueQuery, args: revenueParams });
      const revenueData = revenueResult.rows[0] || { actuals: 0, budget: 0, ly: 0 };

      let nightsData = { actuals: 0, budget: 0, ly: 0 };

      if (segment.statAccount) {
        // Actuals and LY always use 'MAIN' version; only budget uses user-selected version
        const nightsParams = [
          latestStagingPeriod,
          ou, 'MAIN',                      // actuals_combined - actuals always MAIN
          segment.statAccount,
          ...periods,
          segment.statAccount,
          ...periods,
          ou,
          'MAIN',                           // NOT EXISTS — actuals existence check always MAIN
          ou, version,                      // budget - uses user selection
          segment.statAccount,
          ...periods,
          ou, 'MAIN',                       // ly - last year always MAIN
          segment.statAccount,
          ...lyPeriods
        ];

        const nightsResult = await client.execute({ sql: revenueQuery, args: nightsParams });
        nightsData = nightsResult.rows[0] as any || { actuals: 0, budget: 0, ly: 0 };
      }

      results.push({
        description: segment.description,
        category: segment.category,
        consolidatedName: segment.consolidatedName,
        consolidatedCategory: segment.consolidatedCategory,
        revenueActuals: Number(revenueData.actuals) || 0,
        revenueBudget: Number(revenueData.budget) || 0,
        revenueLy: Number(revenueData.ly) || 0,
        nightsActuals: Number(nightsData.actuals) || 0,
        nightsBudget: Number(nightsData.budget) || 0,
        nightsLy: Number(nightsData.ly) || 0
      });
    }

    return results;
  } catch (error) {
    console.error(`Error getting room segment export data for OU ${ou}:`, error);
    throw error;
  }
}

/**
 * Returns per-month budget values for all room-segment revenue and stat
 * accounts in a single pivoted query. Keys: account code. Values: number[]
 * aligned index-for-index with the supplied `periods` array.
 *
 * Revenue amounts retain their stored sign (negative for revenue) — callers
 * negate as needed.
 */
export async function getRoomSegmentBudgetByMonth(
  ou: string,
  periods: string[],
  version: string = 'MAIN'
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (periods.length === 0) return result;

  try {
    const accounts: string[] = [];
    for (const seg of ROOM_SEGMENTS_CONFIG) {
      accounts.push(seg.revenueAccount);
      if (seg.statAccount) accounts.push(seg.statAccount);
    }

    const periodColumns = periods.map((_, i) =>
      `SUM(CASE WHEN fd.period_combo = ? THEN fd.amount ELSE 0 END) AS p${i}`
    ).join(',\n        ');

    const accountPlaceholders = accounts.map(() => '?').join(', ');
    const periodPlaceholders = periods.map(() => '?').join(', ');

    const query = `
      SELECT fd.account,
        ${periodColumns}
      FROM financial_data fd
      WHERE fd.scenario = 'BUD'
        AND fd.ou = ?
        AND fd.version = ?
        AND fd.account IN (${accountPlaceholders})
        AND fd.period_combo IN (${periodPlaceholders})
      GROUP BY fd.account
    `;

    const params: any[] = [
      ...periods,           // CASE WHEN bindings
      ou, version,
      ...accounts,
      ...periods            // IN (...) bindings
    ];

    const rows = (await client.execute({ sql: query, args: params })).rows as any[];

    // Seed every requested account with zeros so callers can index safely
    for (const acct of accounts) {
      result.set(acct, new Array(periods.length).fill(0));
    }

    for (const row of rows) {
      const arr = result.get(row.account as string);
      if (!arr) continue;
      for (let i = 0; i < periods.length; i++) {
        arr[i] = Number(row[`p${i}`]) || 0;
      }
    }

    return result;
  } catch (error) {
    console.error(`Error getting room segment budget by month for OU ${ou}:`, error);
    throw error;
  }
}

// ============================================================================
// BST EXTRACT — flat per-(dept,acct) values for the mapped (period, scenario, version)
// tuples. Reads financial_data ONLY (no staging reconciliation by design —
// downstream BST consumes the committed GL). Balance-sheet accounts excluded.
// ============================================================================

export interface BSTExtractTuple {
  period_combo: string;   // zero-padded, e.g. "2024-01"
  scenario: 'ACT' | 'BUD';
  version: 'MAIN' | 'OWNR';
}

export interface BSTExtractRow {
  department: string;     // e.g. "D0010"
  account: string;        // e.g. "A361011"
  account_desc: string;
  /** key = `${period_combo}|${scenario}|${version}` → amount */
  amounts: Map<string, number>;
}

export async function getBSTExtractData(
  ou: string,
  tuples: BSTExtractTuple[]
): Promise<BSTExtractRow[]> {
  if (tuples.length === 0) return [];

  // Dedupe to distinct (period, scenario, version) — multiple CSV columns can
  // map to the same tuple, but the DB only needs to fetch each once.
  const distinct = new Map<string, BSTExtractTuple>();
  for (const t of tuples) distinct.set(`${t.period_combo}|${t.scenario}|${t.version}`, t);
  const uniq = Array.from(distinct.values());

  // Group by (scenario, version) → one `scenario=? AND version=? AND period_combo IN (...)`
  // clause per group. Keeps the composite PK
  // (dep_acc_combo_id, period_combo, scenario, version, ou) usable.
  const groups = new Map<string, { scenario: string; version: string; periods: string[] }>();
  for (const t of uniq) {
    const k = `${t.scenario}|${t.version}`;
    let g = groups.get(k);
    if (!g) { g = { scenario: t.scenario, version: t.version, periods: [] }; groups.set(k, g); }
    g.periods.push(t.period_combo);
  }

  const fdGroupClauses: string[] = [];
  const fdParams: any[] = [];
  for (const g of groups.values()) {
    fdGroupClauses.push(`(fd.scenario = ? AND fd.version = ? AND fd.period_combo IN (${g.periods.map(() => '?').join(', ')}))`);
    fdParams.push(g.scenario, g.version, ...g.periods);
  }

  // Departments to drop from the BST extract entirely. Stored verbatim in
  // financial_data.department — 'CORP' and 'TTHTL' have no 'D' prefix.
  const BST_EXCLUDED_DEPARTMENTS = ['CORP', 'TTHTL', 'D1468'];
  const excludedPh = BST_EXCLUDED_DEPARTMENTS.map(() => '?').join(', ');

  const sql = `
    SELECT
      fd.department,
      fd.account,
      am.account_description_detail_level_max AS account_desc,
      fd.period_combo,
      fd.scenario,
      fd.version,
      SUM(fd.amount) AS amount
    FROM financial_data fd
    LEFT JOIN account_maps am ON fd.account = am.base_account
    WHERE fd.ou = ?
      AND ${excludeBalanceSheet('fd.account')}
      AND fd.department NOT IN (${excludedPh})
      AND (${fdGroupClauses.join(' OR ')})
    GROUP BY fd.department, fd.account, fd.period_combo, fd.scenario, fd.version
  `;

  const result = await client.execute({ sql, args: [ou, ...BST_EXCLUDED_DEPARTMENTS, ...fdParams] });

  // Pivot rows → Map keyed by (department, account)
  const byKey = new Map<string, BSTExtractRow>();
  for (const r of result.rows as any[]) {
    const dept = r.department as string;
    const acct = r.account as string;
    if (!dept || !acct) continue;
    const k = `${dept}|${acct}`;
    let row = byKey.get(k);
    if (!row) {
      row = {
        department: dept,
        account: acct,
        account_desc: (r.account_desc as string) || acct,
        amounts: new Map(),
      };
      byKey.set(k, row);
    }
    const amtKey = `${r.period_combo}|${r.scenario}|${r.version}`;
    row.amounts.set(amtKey, Number(r.amount) || 0);
  }
  return Array.from(byKey.values());
}

// ============================================================================
// X-ACCOUNT RESOLUTION
// Maps "template" accounts that end in literal Xs (e.g. A610XXX, A6100XX,
// A61000X) to a real account from account_maps. Deterministic:
//   1. lower = replace Xs with 0; upper = replace Xs with 9
//   2. Primary  = smallest base_account in [lower, upper] with no X
//   3. Fallback = smallest base_account >= lower with no X
// Account ids are fixed 7 chars (A + 6 digits), so lexicographic BETWEEN on the
// account_maps.base_account PK is equivalent to numeric ordering. Single
// batched query for the whole result set — no N+1, no temp tables.
// ============================================================================

export interface XAccountResolution {
  account: string;            // real base_account, e.g. "A610001"
  description: string | null; // account_maps.account_description_detail_level_max
}

export async function resolveXAccounts(
  xAccounts: string[]
): Promise<Map<string, XAccountResolution>> {
  const result = new Map<string, XAccountResolution>();
  if (xAccounts.length === 0) return result;

  // Dedupe — same X-template can appear under many departments.
  const uniq = Array.from(new Set(xAccounts));

  // Build the VALUES list for the bounds CTE.
  const valuesPh = uniq.map(() => '(?, ?, ?)').join(', ');
  const args: any[] = [];
  for (const x of uniq) {
    args.push(x, x.replace(/X/g, '0'), x.replace(/X/g, '9'));
  }

  const sql = `
    WITH bounds(x_acct, lower_b, upper_b) AS (VALUES ${valuesPh}),
    chosen AS (
      SELECT
        b.x_acct,
        (SELECT am.base_account FROM account_maps am
          WHERE am.base_account BETWEEN b.lower_b AND b.upper_b
            AND am.base_account NOT LIKE '%X%'
          ORDER BY am.base_account
          LIMIT 1) AS in_range_acct,
        (SELECT am.base_account FROM account_maps am
          WHERE am.base_account >= b.lower_b
            AND am.base_account NOT LIKE '%X%'
          ORDER BY am.base_account
          LIMIT 1) AS upward_acct
      FROM bounds b
    )
    SELECT
      c.x_acct,
      c.in_range_acct,
      ir.account_description_detail_level_max AS in_range_desc,
      c.upward_acct,
      up.account_description_detail_level_max AS upward_desc
    FROM chosen c
    LEFT JOIN account_maps ir ON ir.base_account = c.in_range_acct
    LEFT JOIN account_maps up ON up.base_account = c.upward_acct
  `;

  const rs = await client.execute({ sql, args });

  for (const r of rs.rows as any[]) {
    const xAcct = r.x_acct as string;
    const inRange = r.in_range_acct as string | null;
    const upward = r.upward_acct as string | null;

    if (inRange) {
      result.set(xAcct, { account: inRange, description: (r.in_range_desc as string) ?? null });
    } else if (upward) {
      result.set(xAcct, { account: upward, description: (r.upward_desc as string) ?? null });
    } else {
      console.warn(`[BST Extract] No real account found in account_maps for X-template '${xAcct}'`);
    }
  }
  return result;
}
