/**
 * Migration v4 (the bank-holiday premium's second-generation knobs) — the
 * "upgrade, never wipe" guard.
 *
 * The tool is published, so an update has to carry an existing store forward
 * rather than rebuild it. Two things have to hold, and both are easy to break
 * by touching only one side:
 *
 *   1. Applying the migration to a PRE-v4 store adds the columns in place and
 *      leaves every existing row's data intact — a hotel that already tuned its
 *      premium must not see its numbers move.
 *   2. A migrated store and a freshly-created one end up with the SAME schema.
 *      The columns have to be written twice — once through the baseline, once
 *      through the migration — and a half-done dual-write silently produces two
 *      different shapes in the wild.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { CALENDAR_TABLES_SQL, applyBankHolidayV4 } from "../schema";

type Db = InstanceType<typeof Database>;

/**
 * calendar_years exactly as it stood before v4 — i.e. the shipped baseline with
 * the three new columns removed. Frozen on purpose: it models a real installed
 * store, so it must NOT be rebuilt from the current constant.
 */
const PRE_V4_CALENDAR_SQL = `
  CREATE TABLE calendar_years (
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
`;

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columns(db: Db, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

let legacy: Db;
let fresh: Db;

beforeEach(() => {
  legacy = new Database(":memory:");
  legacy.exec(PRE_V4_CALENDAR_SQL);

  // A store created today, the way applyBaselineSchema does it.
  fresh = new Database(":memory:");
  fresh.exec(CALENDAR_TABLES_SQL);
  applyBankHolidayV4(fresh);
});

describe("migration v4 — bank-holiday premium columns", () => {
  it("adds the columns to a pre-v4 store without touching existing rows", () => {
    legacy
      .prepare(
        `INSERT INTO calendar_years
           (ou, year, weekend_mask, bank_holiday_enabled, bank_holiday_staff_fraction,
            bank_holiday_premium_multiplier, bank_holiday_account, updated_at)
         VALUES ('0410', 2026, 65, 1, 0.5, 1.5, 'A5120', 'then')`
      )
      .run();

    expect(columns(legacy, "calendar_years").map((c) => c.name)).not.toContain(
      "bank_holiday_applies_to"
    );

    applyBankHolidayV4(legacy);

    const row = legacy
      .prepare(`SELECT * FROM calendar_years WHERE ou = '0410' AND year = 2026`)
      .get() as Record<string, unknown>;
    // The hotel's own tuning is carried forward verbatim — in particular the
    // 0.5 staff fraction it saved, NOT the new 0.7 default for fresh calendars.
    expect(row.bank_holiday_enabled).toBe(1);
    expect(row.bank_holiday_staff_fraction).toBe(0.5);
    expect(row.bank_holiday_premium_multiplier).toBe(1.5);
    expect(row.bank_holiday_account).toBe("A5120");
    expect(row.updated_at).toBe("then");
    // And the new knobs default to the pre-v4 behaviour: hourly staff only, the
    // holiday not paid unless worked, no department overrides.
    expect(row.bank_holiday_applies_to).toBe("HOURLY");
    expect(row.bank_holiday_paid_when_not_worked).toBe(0);
    expect(row.bank_holiday_coverage_json).toBe("{}");
  });

  it("is idempotent — re-running it is a no-op", () => {
    applyBankHolidayV4(legacy);
    const after = columns(legacy, "calendar_years");
    expect(() => applyBankHolidayV4(legacy)).not.toThrow();
    expect(columns(legacy, "calendar_years")).toEqual(after);
  });

  it("leaves a migrated store schema-identical to a fresh one", () => {
    applyBankHolidayV4(legacy);

    const describeColumn = (c: ColumnInfo) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
    });

    // Compared as an ORDERED list, not a set: ALTER appends, so a fresh install
    // only matches an upgraded one if it runs the same helper in the same place.
    expect(columns(legacy, "calendar_years").map(describeColumn)).toEqual(
      columns(fresh, "calendar_years").map(describeColumn)
    );
  });

  it("reaches a fresh install through the baseline, not just the migration", () => {
    // A rebuilt database must not lose the columns — Danger Zone → Rebuild
    // database re-runs the baseline, which is why it calls the helper too.
    const byName = new Map(columns(fresh, "calendar_years").map((c) => [c.name, c]));
    expect(byName.get("bank_holiday_applies_to")?.dflt_value).toBe("'HOURLY'");
    expect(byName.get("bank_holiday_paid_when_not_worked")?.dflt_value).toBe("0");
    expect(byName.get("bank_holiday_coverage_json")?.dflt_value).toBe("'{}'");
    for (const name of [
      "bank_holiday_applies_to",
      "bank_holiday_paid_when_not_worked",
      "bank_holiday_coverage_json",
    ]) {
      expect(byName.get(name)?.notnull, name).toBe(1);
    }
  });

  it("does nothing when the calendar tables do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(() => applyBankHolidayV4(empty)).not.toThrow();
  });
});
