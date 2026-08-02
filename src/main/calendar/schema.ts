/**
 * Budget/forecast calendar DDL, shared between local_db.ts and the tests. Must
 * stay free of Electron imports — tests exec this against in-memory databases.
 *
 * One `calendar_years` row per (hotel OU, year) carries the weekend pattern and
 * the bank-holiday premium configuration; `calendar_months` carries the twelve
 * day counts. Four of the `bank_holiday_*` columns are in the v1 baseline; the
 * three added by v4 arrive through applyBankHolidayV4 below.
 */

import type Database from "better-sqlite3-multiple-ciphers";

type Db = InstanceType<typeof Database>;

export const CALENDAR_TABLES_SQL = `
  -- Budget/forecast calendar (former v2), one row per (hotel OU, year).
  -- weekend_mask seeds the Weekends row; per-month counts in calendar_months
  -- stay authoritative once edited. The bank_holiday_* columns are the
  -- per-hotel-year premium config (former v6; off by default, an empty account
  -- keeps the feature effectively inert). Their DEFAULTs are never actually
  -- reached — the columns are NOT NULL and saveCalendarYear always supplies a
  -- value — so the staff-fraction default here deliberately stays at the
  -- historical 0.5 rather than tracking DEFAULT_BANK_HOLIDAY_STAFF_FRACTION.
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
`;

/**
 * Migration v4 — the bank-holiday premium's second generation of knobs: who it
 * applies to, whether the holiday is paid when not worked, and per-department
 * coverage overrides. The defaults reproduce exactly what the two-knob feature
 * did before, so an upgraded store's numbers do not move.
 *
 * Column-guarded ALTERs, so this is idempotent. It is applied from the baseline
 * as well as from MIGRATIONS — the columns are added by ALTER either way, which
 * is what keeps a fresh store's COLUMN ORDER identical to an upgraded one's.
 */
export function applyBankHolidayV4(handle: Db): void {
  const columns = handle
    .prepare("PRAGMA table_info(calendar_years)")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // calendar tables not created yet
  const present = new Set(columns.map((column) => column.name));

  if (!present.has("bank_holiday_applies_to")) {
    handle.exec(
      `ALTER TABLE calendar_years ADD COLUMN bank_holiday_applies_to TEXT NOT NULL DEFAULT 'HOURLY'`
    );
  }
  if (!present.has("bank_holiday_paid_when_not_worked")) {
    handle.exec(
      `ALTER TABLE calendar_years ADD COLUMN bank_holiday_paid_when_not_worked INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!present.has("bank_holiday_coverage_json")) {
    handle.exec(
      `ALTER TABLE calendar_years ADD COLUMN bank_holiday_coverage_json TEXT NOT NULL DEFAULT '{}'`
    );
  }
}
