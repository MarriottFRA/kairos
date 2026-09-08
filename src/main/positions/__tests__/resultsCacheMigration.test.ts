/**
 * Secure-store migration v8 (the results cache) — the "upgrade, never wipe"
 * guard, in the shape componentValueDepartmentMigration.test.ts set.
 *
 * Three things have to hold:
 *
 *   1. Applying the migration to a PRE-v8 store adds `encoding` to the lines in
 *      place, stamps the two sources that are LEVEL by construction, leaves
 *      every other value untouched, and creates results_cache empty.
 *   2. A migrated store and a fresh one end up with the same column sets.
 *   3. Re-running it never re-stamps: once a v8 run has written real encodings,
 *      a re-exec of the baseline must not flatten them back.
 *
 * Column ORDER is deliberately not asserted (secure-store convention).
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { ENGINE_OUTPUTS_SQL, applyResultsCacheV8 } from "../schema";

type Db = InstanceType<typeof Database>;

/**
 * engine_output_lines exactly as it stood before v8 (the v3 provenance shape).
 * Frozen on purpose: it models a real installed store, so it must NOT be
 * rebuilt from the current constant.
 */
const PRE_V8_ENGINE_OUTPUTS_SQL = `
  CREATE TABLE engine_runs (
      ou             TEXT NOT NULL,
      scenario_id    TEXT NOT NULL,
      fingerprint    TEXT NOT NULL,
      computed_at    TEXT NOT NULL,
      line_count     INTEGER NOT NULL DEFAULT 0,
      position_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ou, scenario_id)
  );
  CREATE TABLE engine_output_lines (
      ou               TEXT NOT NULL,
      scenario_id      TEXT NOT NULL,
      position_id      TEXT NOT NULL,
      component_def_id TEXT NOT NULL,
      label            TEXT NOT NULL DEFAULT '',
      dept             TEXT NOT NULL DEFAULT '',
      account          TEXT NOT NULL DEFAULT '',
      monthly_values   TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0]',
      total            REAL NOT NULL DEFAULT 0,
      source           TEXT NOT NULL DEFAULT 'ENGINE',
      source_ref       TEXT NOT NULL DEFAULT '',
      detail           TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (ou, scenario_id, position_id, component_def_id)
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

function tables(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const insertLine = (db: Db, id: string, source: string) =>
  db
    .prepare(
      `INSERT INTO engine_output_lines
         (ou, scenario_id, position_id, component_def_id, label, dept, account,
          monthly_values, total, source, source_ref, detail)
       VALUES ('OU1', 'sc-1', ?, 'c', 'L', 'D0410', 'A511000',
               '[1,0,0,0,0,0,0,0,0,0,0,0]', 1, ?, '', '{}')`
    )
    .run(id, source);

let legacy: Db;
let fresh: Db;

beforeEach(() => {
  legacy = new Database(":memory:");
  legacy.exec(PRE_V8_ENGINE_OUTPUTS_SQL);

  fresh = new Database(":memory:");
  fresh.exec(ENGINE_OUTPUTS_SQL);
});

describe("secure migration v8 — results cache", () => {
  it("adds encoding to a pre-v8 store, stamping only the sources that are LEVEL by construction", () => {
    insertLine(legacy, "engine", "ENGINE");
    insertLine(legacy, "manual", "MANUAL");
    insertLine(legacy, "buyout", "BUYOUT");
    insertLine(legacy, "alloc", "ALLOCATION");
    insertLine(legacy, "setup", "SETUP");
    expect(columns(legacy, "engine_output_lines").map((c) => c.name)).not.toContain(
      "encoding"
    );

    applyResultsCacheV8(legacy);

    const rows = legacy
      .prepare(
        `SELECT position_id, encoding, total, detail FROM engine_output_lines
          ORDER BY position_id`
      )
      .all() as Array<{ position_id: string; encoding: string; total: number; detail: string }>;
    expect(rows.map((r) => [r.position_id, r.encoding])).toEqual([
      ["alloc", "LEVEL"],
      ["buyout", "AMOUNT"],
      ["engine", "AMOUNT"],
      ["manual", "AMOUNT"],
      ["setup", "LEVEL"],
    ]);
    // Every other value is exactly as it was.
    expect(rows.every((r) => r.total === 1 && r.detail === "{}")).toBe(true);
  });

  it("creates results_cache, empty — the cache is never backfilled", () => {
    insertLine(legacy, "engine", "ENGINE");
    applyResultsCacheV8(legacy);
    expect(tables(legacy)).toContain("results_cache");
    expect(
      (legacy.prepare("SELECT COUNT(*) AS n FROM results_cache").get() as { n: number }).n
    ).toBe(0);
  });

  it("is idempotent and never re-stamps encodings a v8 run has written", () => {
    insertLine(legacy, "alloc", "ALLOCATION");
    applyResultsCacheV8(legacy);
    // A v8 run writes a real encoding; a later re-exec must leave it alone.
    legacy
      .prepare(`UPDATE engine_output_lines SET encoding = 'AMOUNT' WHERE position_id = 'alloc'`)
      .run();
    const before = columns(legacy, "engine_output_lines");

    expect(() => applyResultsCacheV8(legacy)).not.toThrow();
    expect(() => legacy.exec(ENGINE_OUTPUTS_SQL)).not.toThrow();

    expect(columns(legacy, "engine_output_lines")).toEqual(before);
    expect(
      (
        legacy
          .prepare(`SELECT encoding FROM engine_output_lines WHERE position_id = 'alloc'`)
          .get() as { encoding: string }
      ).encoding
    ).toBe("AMOUNT");
  });

  it("leaves a migrated store with the same columns as a fresh one", () => {
    applyResultsCacheV8(legacy);

    const describeColumn = (c: ColumnInfo) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
    });
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name);

    for (const table of ["engine_output_lines", "results_cache"]) {
      expect(columns(legacy, table).map(describeColumn).sort(byName)).toEqual(
        columns(fresh, table).map(describeColumn).sort(byName)
      );
    }
  });

  it("reaches a fresh install through the baseline, not just the migration", () => {
    // Rebuild database re-runs the baseline DDL, which must already carry both.
    expect(tables(fresh)).toContain("results_cache");
    const column = columns(fresh, "engine_output_lines").find(
      (c) => c.name === "encoding"
    );
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("'AMOUNT'");
  });

  it("does nothing when the output tables do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(() => applyResultsCacheV8(empty)).not.toThrow();
    expect(tables(empty)).toEqual([]);
  });
});
