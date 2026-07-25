/**
 * Hotel-clusters repository — CRUD, validation, the fingerprint invariant
 * (every member change stamps the parent's updated_at), and the explicit
 * multi-scope reads/writes against the encrypted store. In-memory databases
 * throughout (the blocksRepo.test pattern).
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  applyHotelClustersV13,
  HOTEL_CLUSTERS_SQL,
} from "../schema";
import {
  applyValueStoreV11,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import {
  clearAssignmentsAllOus,
  deleteCluster,
  listAssignedPositionsAllOus,
  listClusters,
  saveCluster,
} from "../repo";

type Db = InstanceType<typeof Database>;

const NOW = { now: "2026-07-23T00:00:00.000Z" };
const LATER = { now: "2026-07-24T00:00:00.000Z" };
const HOTEL_A = "OU11111";
const HOTEL_B = "OU22222";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  applyHotelClustersV13(db);
});

const twoHotels = () => [
  { ou: HOTEL_A, weight: 0.5 },
  { ou: HOTEL_B, weight: 0.5 },
];

describe("save + list", () => {
  it("round-trips a cluster with ordered members", () => {
    const id = saveCluster(db, { name: "Main", members: twoHotels() }, NOW);
    const clusters = listClusters(db);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].id).toBe(id);
    expect(clusters[0].name).toBe("Main");
    expect(clusters[0].members).toEqual(twoHotels());
    expect(clusters[0].updatedAt).toBe(NOW.now);
  });

  it("updates in place and rewrites the member set", () => {
    const id = saveCluster(db, { name: "Main", members: twoHotels() }, NOW);
    saveCluster(
      db,
      { id, name: "Main Cluster", members: [{ ou: HOTEL_A, weight: 1 }] },
      LATER
    );
    const clusters = listClusters(db);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].name).toBe("Main Cluster");
    expect(clusters[0].members).toEqual([{ ou: HOTEL_A, weight: 1 }]);
  });

  it("stamps the parent's updated_at on EVERY member change — the staleness fingerprint depends on it", () => {
    const id = saveCluster(db, { name: "Main", members: twoHotels() }, NOW);
    // Same name, only a weight moved: the head stamp must still advance.
    saveCluster(
      db,
      {
        id,
        name: "Main",
        members: [
          { ou: HOTEL_A, weight: 0.7 },
          { ou: HOTEL_B, weight: 0.3 },
        ],
      },
      LATER
    );
    expect(listClusters(db)[0].updatedAt).toBe(LATER.now);
  });

  it("canonicalizes member OUs (bare / lowercase forms)", () => {
    saveCluster(
      db,
      { name: "Main", members: [{ ou: " ou11111 ", weight: 0.5 }, { ou: "22222", weight: 0.5 }] },
      NOW
    );
    expect(listClusters(db)[0].members.map((member) => member.ou)).toEqual([
      HOTEL_A,
      HOTEL_B,
    ]);
  });
});

describe("validation", () => {
  it("rejects a blank name", () => {
    expect(() => saveCluster(db, { name: "  ", members: twoHotels() }, NOW)).toThrow(
      /name is required/
    );
  });

  it("rejects a duplicate name case-insensitively, excluding self", () => {
    const id = saveCluster(db, { name: "Main", members: twoHotels() }, NOW);
    expect(() => saveCluster(db, { name: "  main ", members: twoHotels() }, NOW)).toThrow(
      /already exists/
    );
    // Renaming a cluster to its own name is not a clash.
    expect(() => saveCluster(db, { id, name: "MAIN", members: twoHotels() }, LATER)).not.toThrow();
  });

  it("rejects zero members, duplicate OUs and invalid OUs", () => {
    expect(() => saveCluster(db, { name: "A", members: [] }, NOW)).toThrow(
      /at least one hotel/
    );
    expect(() =>
      saveCluster(
        db,
        { name: "A", members: [{ ou: HOTEL_A, weight: 0.5 }, { ou: "ou11111", weight: 0.5 }] },
        NOW
      )
    ).toThrow(/more than once/);
    expect(() =>
      saveCluster(db, { name: "A", members: [{ ou: "not-an-ou", weight: 1 }] }, NOW)
    ).toThrow(/not a valid hotel OU/);
  });

  it("rejects out-of-range weights (0, negative, >1, NaN) but allows sums ≠ 1", () => {
    for (const weight of [0, -0.1, 1.5, Number.NaN]) {
      expect(() =>
        saveCluster(db, { name: "A", members: [{ ou: HOTEL_A, weight }] }, NOW),
        String(weight)
      ).toThrow(/weight/);
    }
    // Weights not summing to 1 are a UI warning, never a save error.
    expect(() =>
      saveCluster(
        db,
        { name: "A", members: [{ ou: HOTEL_A, weight: 0.9 }, { ou: HOTEL_B, weight: 0.9 }] },
        NOW
      )
    ).not.toThrow();
  });

  it("refuses to update a deleted or unknown cluster", () => {
    const id = saveCluster(db, { name: "Main", members: twoHotels() }, NOW);
    deleteCluster(db, id, LATER);
    expect(() => saveCluster(db, { id, name: "Main", members: twoHotels() }, LATER)).toThrow(
      /no longer exists/
    );
    expect(() =>
      saveCluster(db, { id: "missing", name: "X", members: twoHotels() }, NOW)
    ).toThrow(/no longer exists/);
  });
});

describe("delete", () => {
  it("soft-deletes (row kept, list hides it) and throws on a second delete", () => {
    const id = saveCluster(db, { name: "Main", members: twoHotels() }, NOW);
    deleteCluster(db, id, LATER);
    expect(listClusters(db)).toHaveLength(0);
    const raw = db
      .prepare("SELECT deleted_at FROM hotel_clusters WHERE id = ?")
      .get(id) as { deleted_at: string };
    expect(raw.deleted_at).toBe(LATER.now);
    expect(() => deleteCluster(db, id, LATER)).toThrow(/no longer exists/);
  });

  it("frees the name for reuse after a soft delete", () => {
    const id = saveCluster(db, { name: "Main", members: twoHotels() }, NOW);
    deleteCluster(db, id, LATER);
    expect(() => saveCluster(db, { name: "Main", members: twoHotels() }, LATER)).not.toThrow();
  });
});

describe("migration idempotency", () => {
  it("applyHotelClustersV13 and the DDL can run repeatedly", () => {
    applyHotelClustersV13(db);
    db.exec(HOTEL_CLUSTERS_SQL);
    applyHotelClustersV13(db);
    expect(listClusters(db)).toEqual([]);
  });

  it("applyValueStoreV11 adds the override column once and clears legacy cluster strings only then", () => {
    // A pre-v11 store: cluster column exists (old free-text groupings), the
    // override column does not.
    const legacy = new Database(":memory:") as Db;
    legacy.exec(`
      CREATE TABLE positions (
        id TEXT PRIMARY KEY, ou TEXT NOT NULL, scenario_id TEXT NOT NULL,
        cluster TEXT NOT NULL DEFAULT '',
        extra_values TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL, deleted_at TEXT
      );
      INSERT INTO positions (id, ou, scenario_id, cluster, updated_at)
      VALUES ('p1', 'OU11111', 's1', 'Rooms', '2026-01-01');
    `);
    applyValueStoreV11(legacy);
    const first = legacy
      .prepare("SELECT cluster, cluster_multiplier_override FROM positions")
      .get() as { cluster: string; cluster_multiplier_override: number | null };
    expect(first.cluster).toBe(""); // legacy department string cleared
    expect(first.cluster_multiplier_override).toBeNull();

    // Once upgraded, re-running must never wipe a real assignment.
    legacy
      .prepare("UPDATE positions SET cluster = 'cluster-id-1', cluster_multiplier_override = 0.5")
      .run();
    applyValueStoreV11(legacy);
    const second = legacy
      .prepare("SELECT cluster, cluster_multiplier_override FROM positions")
      .get() as { cluster: string; cluster_multiplier_override: number | null };
    expect(second.cluster).toBe("cluster-id-1");
    expect(second.cluster_multiplier_override).toBe(0.5);
    legacy.close();
  });
});

describe("explicit multi-scope reads/writes (encrypted store)", () => {
  let valuesDb: Db;

  beforeEach(() => {
    valuesDb = new Database(":memory:");
    valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
    applyValueStoreV11(valuesDb);
    const insert = valuesDb.prepare(`
      INSERT INTO positions (id, ou, scenario_id, cluster, cluster_multiplier_override,
                             department_code, headcount, active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01')
    `);
    insert.run("p1", HOTEL_A, "s1", "cl-1", null, "0410", 1, 1);
    insert.run("p2", HOTEL_B, "s2", "cl-1", 0.4, "1310", 2, 0);
    insert.run("p3", HOTEL_B, "s2", "cl-2", null, "1310", 1, 1);
    valuesDb
      .prepare(
        `INSERT INTO position_pii (position_id, ou, scenario_id, title, first_name, last_name, updated_at)
         VALUES ('p1', ?, 's1', 'HR Manager', 'Ada', 'Lovelace', '2026-01-01')`
      )
      .run(HOTEL_A);
  });

  it("lists assigned positions across ALL OUs, exposing only non-personal PII (title)", () => {
    const rows = listAssignedPositionsAllOus(valuesDb, "cl-1");
    expect(rows.map((row) => [row.id, row.ou])).toEqual([
      ["p1", HOTEL_A],
      ["p2", HOTEL_B],
    ]);
    expect(rows[0].title).toBe("HR Manager");
    expect(rows[1].title).toBeNull();
    expect(rows[1].cluster_multiplier_override).toBe(0.4);
    // The row shape carries nothing personal — names never leave position_pii.
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("first_name");
      expect(Object.keys(row)).not.toContain("last_name");
      expect(Object.keys(row)).not.toContain("emp_number");
    }
  });

  it("clears one cluster's assignments across OUs, stamping updated_at, leaving others alone", () => {
    const changed = clearAssignmentsAllOus(valuesDb, "cl-1", LATER);
    expect(changed).toBe(2);
    const rows = valuesDb
      .prepare("SELECT id, cluster, cluster_multiplier_override, updated_at FROM positions ORDER BY id")
      .all() as Array<{ id: string; cluster: string; cluster_multiplier_override: number | null; updated_at: string }>;
    expect(rows[0]).toEqual({ id: "p1", cluster: "", cluster_multiplier_override: null, updated_at: LATER.now });
    expect(rows[1]).toEqual({ id: "p2", cluster: "", cluster_multiplier_override: null, updated_at: LATER.now });
    // cl-2 untouched, stamp untouched.
    expect(rows[2].cluster).toBe("cl-2");
    expect(rows[2].updated_at).toBe("2026-01-01");
  });
});
