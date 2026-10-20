/**
 * The PII stream must survive a record for a position we do not hold.
 *
 * `position_pii.position_id` is a foreign key. One server-side PII row whose
 * position was never stored (NULL department, so the server sends it to every
 * reader) used to throw on insert and end the stream: the rows before it
 * landed, the rows after it never did, no watermark was recorded, and the
 * caller swallowed the error. Every machine ended up holding a handful of
 * employee details while the download reported success.
 */

import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { POSITIONS_VALUE_TABLES_SQL } from "../../positions/schema";
import { KAIROS_SYNC_TABLES_SQL } from "../schema";
import { ensureSyncState, getSyncState } from "../repo";
import { pullPii } from "../pii";
import { PiiPage, PiiRow } from "../../../shared/kairosSync/protocol";

type Db = InstanceType<typeof Database>;

const PLAN = "plan-1";
const OU = "OU25RJ2";

function makeDb(): Db {
  const db = new Database(":memory:");
  // As in production: without this the constraint under test is not enforced.
  db.pragma("foreign_keys = ON");
  db.exec(POSITIONS_VALUE_TABLES_SQL);
  db.exec(KAIROS_SYNC_TABLES_SQL);
  ensureSyncState(db, PLAN, OU);
  return db;
}

function addPosition(db: Db, id: string): void {
  db.prepare(`INSERT INTO positions (id, ou, scenario_id, updated_at) VALUES (?, ?, ?, ?)`).run(
    id,
    OU,
    PLAN,
    "2026-07-01T00:00:00.000Z"
  );
}

function piiRow(positionId: string, serverSeq: number, department: string | null = "D0410"): PiiRow {
  return {
    entityType: "position_pii",
    positionId,
    department,
    hash: `h-${positionId}`,
    deleted: false,
    clientUpdatedAt: "2026-07-01T00:00:00.000Z",
    serverSeq,
    readable: true,
    payload: {
      positionId,
      ou: OU,
      scenarioId: PLAN,
      hiringDate: null,
      empNumber: `E-${positionId}`,
      lastName: "Last",
      firstName: "First",
      title: null,
      extraValues: {},
      updatedAt: "2026-07-01T00:00:00.000Z",
      deletedAt: null,
    },
  };
}

function stubClient(pages: Array<PiiRow[]>) {
  let call = 0;
  return {
    get: vi.fn(async (): Promise<PiiPage> => {
      const index = call++;
      return {
        planId: PLAN,
        fromVersion: 0,
        toVersion: 12,
        syncEpoch: 0,
        scope: { kind: "FULL", departments: null },
        nextCursor: index < pages.length - 1 ? `c${index + 1}` : null,
        rows: pages[index],
        unreadable: 0,
      };
    }),
  } as never;
}

const piiCount = (db: Db) =>
  (db.prepare(`SELECT COUNT(*) n FROM position_pii`).get() as { n: number }).n;

const shadowIds = (db: Db) =>
  (
    db
      .prepare(
        `SELECT entity_id FROM kairos_sync_shadow WHERE plan_id = ? AND entity_type = 'position_pii' ORDER BY 1`
      )
      .all(PLAN) as Array<{ entity_id: string }>
  ).map((row) => row.entity_id);

describe("pullPii with an orphan record", () => {
  it("skips the orphan, lands every other row across pages, and records the watermark", async () => {
    const db = makeDb();
    for (const id of ["p1", "p2", "p3", "p4"]) addPosition(db, id);

    const result = await pullPii(
      db,
      db,
      stubClient([
        [piiRow("p1", 1), piiRow("ghost", 2, null), piiRow("p2", 3)],
        [piiRow("p3", 4), piiRow("p4", 5)],
      ]),
      PLAN,
      0,
      { apply: true }
    );

    expect(result.applied).toBe(4);
    expect(result.orphaned).toBe(1);
    expect(result.orphanedPositionIds).toEqual(["ghost"]);
    expect(piiCount(db)).toBe(4);
    expect(getSyncState(db, PLAN)?.piiWatermark).toBe(12);
    // Kept out of the shadow: a publish must neither re-send nor purge a row
    // this computer never had.
    expect(shadowIds(db)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("does not check positions on a dry run", async () => {
    // A preview runs before the entities are applied, so "not local yet" is
    // the normal state there, not an orphan.
    const db = makeDb();

    const result = await pullPii(db, db, stubClient([[piiRow("p1", 1)]]), PLAN, 0);

    expect(result.applied).toBe(1);
    expect(result.orphaned).toBe(0);
    expect(piiCount(db)).toBe(0);
  });

  it("names the page and position when a write fails for any other reason", async () => {
    const db = makeDb();
    addPosition(db, "p1");
    addPosition(db, "p2");
    const bad = piiRow("p2", 2);
    (bad.payload as Record<string, unknown>).ou = null as never;
    db.exec(`DROP TABLE position_pii`);
    db.exec(`CREATE TABLE position_pii (
      position_id TEXT PRIMARY KEY REFERENCES positions(id), ou TEXT NOT NULL CHECK (ou <> ''),
      scenario_id TEXT NOT NULL, hiring_date TEXT, emp_number TEXT, last_name TEXT,
      first_name TEXT, title TEXT, extra_values TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL, deleted_at TEXT)`);

    await expect(
      pullPii(db, db, stubClient([[piiRow("p1", 1), bad]]), PLAN, 0, { apply: true })
    ).rejects.toThrow(/page 1 at position p2 after 1 rows/);
    // Nothing recorded: the next download retries from the same watermark.
    expect(getSyncState(db, PLAN)?.piiWatermark).toBe(0);
  });
});
