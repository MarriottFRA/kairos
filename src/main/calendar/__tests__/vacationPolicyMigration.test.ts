/**
 * Migration v5 (the hotel-year vacation policy) — the "upgrade, never wipe"
 * guard, in the same two-clause shape as v4:
 *
 *   1. Applying it to a PRE-v5 store adds the columns in place and leaves every
 *      existing row's data intact, with defaults that reproduce exactly what
 *      the engine did before (flat 1/30 day, vacation carved out of salary).
 *   2. A migrated store and a freshly-created one end up with the SAME schema,
 *      column order included.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { CALENDAR_TABLES_SQL, applyCalendarColumns, applyVacationPolicyV5 } from "../schema";

type Db = InstanceType<typeof Database>;

/**
 * calendar_years exactly as a v4 store has it — the baseline plus the three v4
 * columns, in the order ALTER appended them. Frozen on purpose: it models a
 * real installed store, so it must NOT be rebuilt from the current constants.
 */
const PRE_V5_CALENDAR_SQL = `
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
  ALTER TABLE calendar_years ADD COLUMN bank_holiday_applies_to TEXT NOT NULL DEFAULT 'HOURLY';
  ALTER TABLE calendar_years ADD COLUMN bank_holiday_paid_when_not_worked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE calendar_years ADD COLUMN bank_holiday_coverage_json TEXT NOT NULL DEFAULT '{}';
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
  legacy.exec(PRE_V5_CALENDAR_SQL);

  // A store created today, the way applyBaselineSchema does it — through the
  // composed helper, so this also pins that the helper includes v5.
  fresh = new Database(":memory:");
  fresh.exec(CALENDAR_TABLES_SQL);
  applyCalendarColumns(fresh);
});

describe("migration v5 — vacation policy columns", () => {
  it("adds the columns to a pre-v5 store without touching existing rows", () => {
    legacy
      .prepare(
        `INSERT INTO calendar_years
           (ou, year, weekend_mask, bank_holiday_enabled, bank_holiday_staff_fraction,
            bank_holiday_premium_multiplier, bank_holiday_account, updated_at,
            bank_holiday_applies_to, bank_holiday_paid_when_not_worked,
            bank_holiday_coverage_json)
         VALUES ('0410', 2026, 65, 1, 0.6, 1.5, 'A5120', 'then', 'ALL', 1, '{"D0410":0.2}')`
      )
      .run();

    expect(columns(legacy, "calendar_years").map((c) => c.name)).not.toContain(
      "vacation_day_basis"
    );

    applyVacationPolicyV5(legacy);

    const row = legacy
      .prepare(`SELECT * FROM calendar_years WHERE ou = '0410' AND year = 2026`)
      .get() as Record<string, unknown>;
    // Everything the hotel tuned is carried forward verbatim — and updated_at
    // is untouched, so stored Results are not marked stale by the upgrade.
    expect(row.bank_holiday_enabled).toBe(1);
    expect(row.bank_holiday_staff_fraction).toBe(0.6);
    expect(row.bank_holiday_applies_to).toBe("ALL");
    expect(row.bank_holiday_coverage_json).toBe('{"D0410":0.2}');
    expect(row.updated_at).toBe("then");
    // The new knobs default to the pre-v5 engine: flat 1/30 day, carve-out.
    expect(row.vacation_day_basis).toBe("FLAT");
    expect(row.vacation_additive).toBe(0);
  });

  it("is idempotent — re-running it is a no-op", () => {
    applyVacationPolicyV5(legacy);
    const after = columns(legacy, "calendar_years");
    expect(() => applyVacationPolicyV5(legacy)).not.toThrow();
    expect(columns(legacy, "calendar_years")).toEqual(after);
  });

  it("leaves a migrated store schema-identical to a fresh one", () => {
    applyVacationPolicyV5(legacy);

    const describeColumn = (c: ColumnInfo) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
    });

    // Ordered, not a set: ALTER appends, so a fresh install only matches an
    // upgraded one if the baseline runs the same helpers in the same order.
    expect(columns(legacy, "calendar_years").map(describeColumn)).toEqual(
      columns(fresh, "calendar_years").map(describeColumn)
    );
  });

  it("reaches a fresh install through the baseline, not just the migration", () => {
    const byName = new Map(columns(fresh, "calendar_years").map((c) => [c.name, c]));
    expect(byName.get("vacation_day_basis")?.dflt_value).toBe("'FLAT'");
    expect(byName.get("vacation_additive")?.dflt_value).toBe("0");
    for (const name of ["vacation_day_basis", "vacation_additive"]) {
      expect(byName.get(name)?.notnull, name).toBe(1);
    }
  });

  it("does nothing when the calendar tables do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(() => applyVacationPolicyV5(empty)).not.toThrow();
  });
});
