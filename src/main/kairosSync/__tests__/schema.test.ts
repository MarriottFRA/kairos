/**
 * The one guarded ALTER the sync tables carry.
 *
 * `kairos_sync_state` shipped as a baseline `CREATE TABLE IF NOT EXISTS`, which
 * cannot add a column to a table that already exists on a user's machine. The
 * pulled-scope columns therefore arrive through `ensureKairosSyncColumns`, and
 * what matters is that it is safe to run on every unlock: it adds what is
 * missing, seeds it once, and does nothing the second time.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { KAIROS_SYNC_TABLES_SQL, ensureKairosSyncColumns } from "../schema";
import { getSyncState } from "../repo";

type Db = InstanceType<typeof Database>;

/** The table as a pre-upgrade install has it: no pulled_scope_* columns. */
const OLD_SHAPE_SQL = `
  CREATE TABLE kairos_sync_state (
      plan_id            TEXT PRIMARY KEY,
      ou                 TEXT NOT NULL,
      watermark          INTEGER NOT NULL DEFAULT 0,
      sync_epoch         INTEGER NOT NULL DEFAULT 0,
      pii_watermark      INTEGER NOT NULL DEFAULT 0,
      structure_version  INTEGER NOT NULL DEFAULT 0,
      relation           TEXT,
      scope_kind         TEXT,
      scope_departments  TEXT,
      structure_editable INTEGER NOT NULL DEFAULT 0,
      heads_etag         TEXT,
      ownership_etag     TEXT,
      ownership_json     TEXT,
      last_published_at  TEXT,
      last_pulled_at     TEXT,
      revoked_json       TEXT
  );
`;

function columns(db: Db): string[] {
  return (db.prepare("PRAGMA table_info(kairos_sync_state)").all() as Array<{ name: string }>)
    .map((column) => column.name)
    .sort();
}

describe("ensureKairosSyncColumns", () => {
  it("adds the pulled-scope columns to a pre-upgrade table", () => {
    const db = new Database(":memory:");
    db.exec(OLD_SHAPE_SQL);
    expect(columns(db)).not.toContain("pulled_scope_kind");

    ensureKairosSyncColumns(db);

    expect(columns(db)).toContain("pulled_scope_kind");
    expect(columns(db)).toContain("pulled_scope_departments");
  });

  it("seeds them from the current scope for plans that have been pulled, once", () => {
    const db = new Database(":memory:");
    db.exec(OLD_SHAPE_SQL);
    db.prepare(
      `INSERT INTO kairos_sync_state (plan_id, ou, watermark, scope_kind, scope_departments)
       VALUES ('pulled', 'OU25RJ2', 42, 'PARTIAL', '["D0010"]'),
              ('never-pulled', 'OU25RJ2', 0, 'FULL', NULL)`
    ).run();

    ensureKairosSyncColumns(db);

    // A plan with a watermark has a copy, and its recorded scope is the best
    // available statement of what that copy was taken under.
    expect(getSyncState(db, "pulled")?.pulledScopeKind).toBe("PARTIAL");
    expect(getSyncState(db, "pulled")?.pulledScopeDepartments).toEqual(["D0010"]);
    // A plan never pulled stays unprovable: `readScopeWidened` reads null as
    // "do nothing", which is the right answer for a copy that does not exist.
    expect(getSyncState(db, "never-pulled")?.pulledScopeKind).toBeNull();

    // Running again neither re-adds nor re-seeds. The current scope has moved
    // on; the pulled one must keep saying what it said.
    db.prepare(`UPDATE kairos_sync_state SET scope_kind = 'FULL' WHERE plan_id = 'pulled'`).run();
    ensureKairosSyncColumns(db);
    expect(getSyncState(db, "pulled")?.pulledScopeKind).toBe("PARTIAL");
  });

  it("is a no-op on a table created from the current baseline", () => {
    const db = new Database(":memory:");
    db.exec(KAIROS_SYNC_TABLES_SQL);
    const before = columns(db);

    ensureKairosSyncColumns(db);
    ensureKairosSyncColumns(db);

    expect(columns(db)).toEqual(before);
  });
});
