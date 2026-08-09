/**
 * Publish-side decisions: what gets sent, in what order, in what batches.
 *
 * Each of these is a rule the server enforces and the client has to satisfy in
 * advance, because the failure mode is a save that silently did less than the
 * user thinks it did.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { KAIROS_SYNC_TABLES_SQL } from "../schema";
import { contentHash } from "../hash";
import { ShadowRow, shadowKey } from "../repo";
import {
  PUBLISH_ORDER,
  chunkEntities,
  collectLocalEntities,
  filterToWriteScope,
  purgesFor,
  toCommitEntities,
  LocalEntity,
} from "../collect";
import { CommitEntity, DepartmentOwnership } from "../../../shared/kairosSync/protocol";
import {
  UNRESTRICTED_WRITE,
  allowOnly,
  departmentWritePolicy,
} from "../../../shared/kairosSync/writePolicy";

type Db = InstanceType<typeof Database>;

const OU = "OU25RJ2";
const PLAN = "plan-1";

function makeStores(): { localDb: Db; secureDb: Db } {
  const localDb = new Database(":memory:");
  localDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);

  const secureDb = new Database(":memory:");
  secureDb.exec(POSITIONS_VALUE_TABLES_SQL);
  secureDb.exec(MANUAL_INPUT_TABLES_SQL);
  secureDb.exec(ENGINE_OUTPUTS_SQL);
  secureDb.exec(KAIROS_SYNC_TABLES_SQL);

  return { localDb, secureDb };
}

function seed(stores: { localDb: Db; secureDb: Db }): void {
  stores.localDb
    .prepare(
      `INSERT INTO scenarios (id, ou, year, label, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(PLAN, OU, 2026, "Budget", "2026-07-01T00:00:00.000Z");

  const insertPosition = stores.secureDb.prepare(
    `INSERT INTO positions (id, ou, scenario_id, department_code, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  insertPosition.run("pos-rooms", OU, PLAN, "D0410", "2026-07-01T00:00:00.000Z");
  insertPosition.run("pos-fb", OU, PLAN, "D0610", "2026-07-01T00:00:00.000Z");
  // Deliberately unclassified: the column defaults to '' and such a row is
  // owner-only server-side.
  insertPosition.run("pos-none", OU, PLAN, "", "2026-07-01T00:00:00.000Z");

  stores.secureDb
    .prepare(
      `INSERT INTO component_values
         (position_id, component_def_id, ou, scenario_id, rate, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run("pos-rooms", "def-1", OU, PLAN, 0.07, "2026-07-01T00:00:00.000Z");

  stores.secureDb
    .prepare(
      `INSERT INTO position_pii (position_id, ou, scenario_id, last_name, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("pos-rooms", OU, PLAN, "Nowak", "2026-07-01T00:00:00.000Z");
}

describe("collectLocalEntities", () => {
  it("returns positions before the rows that name them as a parent", () => {
    // A child in a LATER chunk than its parent is an ORPHAN_ENTITY. Ordering
    // here is what lets the chunker preserve that guarantee by simply not
    // reordering.
    const stores = makeStores();
    seed(stores);
    const { entities } = collectLocalEntities(stores, { ou: OU, planId: PLAN });

    const firstOf = (type: string) =>
      entities.findIndex((entity) => entity.entityType === type);
    expect(firstOf("position")).toBeLessThan(firstOf("position_pii"));
    expect(firstOf("position")).toBeLessThan(firstOf("component_value"));
    expect(firstOf("scenario")).toBeLessThan(firstOf("position"));
  });

  it("resolves an inherited row's department from its parent position", () => {
    const stores = makeStores();
    seed(stores);
    const { entities } = collectLocalEntities(stores, { ou: OU, planId: PLAN });

    const pii = entities.find((entity) => entity.entityType === "position_pii");
    const componentValue = entities.find(
      (entity) => entity.entityType === "component_value"
    );
    expect(pii?.department).toBe("D0410");
    expect(componentValue?.department).toBe("D0410");
  });

  it("publishes soft-deleted rows as tombstones rather than skipping them", () => {
    // Dropping them means every other client keeps a row its owner deleted.
    const stores = makeStores();
    seed(stores);
    stores.secureDb
      .prepare(`UPDATE positions SET deleted_at = ? WHERE id = ?`)
      .run("2026-07-02T00:00:00.000Z", "pos-fb");

    const { entities } = collectLocalEntities(stores, { ou: OU, planId: PLAN });
    const deleted = entities.find((entity) => entity.entityId === "pos-fb");
    expect(deleted).toBeDefined();
    expect(deleted?.deleted).toBe(true);
  });

  it("omits personal details when the property forbids storing them", () => {
    const stores = makeStores();
    seed(stores);
    const { entities } = collectLocalEntities(stores, {
      ou: OU,
      planId: PLAN,
      includePii: false,
    });
    expect(entities.some((entity) => entity.entityType === "position_pii")).toBe(false);
    // Everything else still goes.
    expect(entities.some((entity) => entity.entityType === "position")).toBe(true);
  });

  it("stays inside its own hotel and scenario", () => {
    const stores = makeStores();
    seed(stores);
    stores.secureDb
      .prepare(
        `INSERT INTO positions (id, ou, scenario_id, department_code, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("pos-other", "OU99999", "plan-2", "D0410", "2026-07-01T00:00:00.000Z");

    const { entities } = collectLocalEntities(stores, { ou: OU, planId: PLAN });
    expect(entities.some((entity) => entity.entityId === "pos-other")).toBe(false);
  });

  /**
   * The two shapes of local damage that used to reach the server looking like a
   * permission problem.
   *
   * `str()` in `entityMap` turns a NULL column into `""`, and `position_pii`
   * derives BOTH its id and its parent id from `position_id` — so a row with a
   * null key became `entityId: ""` with a non-null (empty) parent, which read
   * downstream as "has a parent, department unknown" and therefore as plan-wide.
   * The delegate who saw `PII_KEY_MISMATCH` and `STRUCTURE_OWNER_ONLY` after an
   * ordinary afternoon's editing was seeing exactly this.
   */
  it("drops a personal-details row with no position id, and says why", () => {
    const stores = makeStores();
    seed(stores);
    stores.secureDb
      .prepare(
        `INSERT INTO position_pii (position_id, ou, scenario_id, last_name, updated_at)
         VALUES (NULL, ?, ?, ?, ?)`
      )
      .run(OU, PLAN, "Orphan", "2026-07-02T00:00:00.000Z");

    const { entities, unpublishable } = collectLocalEntities(stores, {
      ou: OU,
      planId: PLAN,
    });

    expect(entities.some((entity) => entity.entityId === "")).toBe(false);
    expect(unpublishable).toContainEqual(
      expect.objectContaining({ entityType: "position_pii", reason: "EMPTY_KEY" })
    );
  });

  it("drops an inherited row whose parent position is gone, and says why", () => {
    /**
     * Reachable, but only through a gap in the constraint.
     *
     * `position_pii.position_id` is `REFERENCES positions(id) ON DELETE CASCADE`
     * and `foreign_keys` is ON in both live stores, so the ordinary delete path
     * cannot strand one. What can is any window where enforcement is off — the
     * Settings rebuild, a migration, a store restored from before the
     * constraint — which is exactly when nobody is watching. Hence the pragma
     * here: the state is contrived on purpose, and the point is that publish
     * classifies it as local damage rather than letting the server call it a
     * permission failure.
     */
    const stores = makeStores();
    seed(stores);
    stores.secureDb.pragma("foreign_keys = OFF");
    stores.secureDb
      .prepare(
        `INSERT INTO position_pii (position_id, ou, scenario_id, last_name, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("pos-vanished", OU, PLAN, "Ghost", "2026-07-02T00:00:00.000Z");
    stores.secureDb.pragma("foreign_keys = ON");

    const { entities, unpublishable } = collectLocalEntities(stores, {
      ou: OU,
      planId: PLAN,
    });

    // An absent parent and a parent with no department are opposite situations.
    // The old `.get(...) ?? null` collapsed them and classified this plan-wide.
    expect(entities.some((entity) => entity.entityId === "pos-vanished")).toBe(false);
    expect(unpublishable).toContainEqual(
      expect.objectContaining({
        entityType: "position_pii",
        reason: "ORPHANED_LOCALLY",
      })
    );
  });

  it("keeps an inherited row whose parent simply has no department", () => {
    // The other side of the same distinction: `pos-none` exists and is
    // unclassified, so its children travel and are judged as owner-only rows.
    const stores = makeStores();
    seed(stores);
    stores.secureDb
      .prepare(
        `INSERT INTO position_pii (position_id, ou, scenario_id, last_name, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("pos-none", OU, PLAN, "Unclassified", "2026-07-02T00:00:00.000Z");

    const { entities, unpublishable } = collectLocalEntities(stores, {
      ou: OU,
      planId: PLAN,
    });

    const pii = entities.find((entity) => entity.entityId === "pos-none");
    expect(pii).toBeDefined();
    expect(pii?.department).toBeNull();
    expect(unpublishable).toHaveLength(0);
  });
});

describe("filterToWriteScope", () => {
  const entities: LocalEntity[] = [
    entity("position", "a", "D0410"),
    entity("position", "b", "D0610"),
    entity("position", "c", null),
    entity("scenario", PLAN, null),
  ];

  it("lets an owner send everything", () => {
    const { publishable, withheld } = filterToWriteScope(entities, {
      canWriteStructure: true,
      departmentPolicy: UNRESTRICTED_WRITE,
    });
    expect(publishable).toHaveLength(4);
    expect(withheld).toHaveLength(0);
  });

  it("holds back departments a delegate does not hold", () => {
    // Not for safety — the server would reject them anyway — but because a wall
    // of DEPARTMENT_OUT_OF_SCOPE rejections looks exactly like a failed save.
    const { publishable, withheld } = filterToWriteScope(entities, {
      canWriteStructure: false,
      departmentPolicy: allowOnly(["D0410"]),
    });
    expect(publishable.map((e) => e.entityId)).toEqual(["a"]);
    expect(withheld.map((e) => e.entityId).sort()).toEqual(["b", "c", PLAN]);
  });

  it("treats a row with no department as owner-only", () => {
    // Matches the server: '' collapses to NULL and lands in the plan-wide branch.
    const { publishable } = filterToWriteScope([entity("position", "c", null)], {
      canWriteStructure: false,
      departmentPolicy: allowOnly(["D0410"]),
    });
    expect(publishable).toHaveLength(0);
  });

  it("never sends the plan's own rows without structure rights, even wide open", () => {
    /**
     * The invariant, stated where it is cheapest.
     *
     * An open ceiling means "no restriction", which is what `writeScopeFor`
     * falls back to when `/department-ownership` has never been cached. Deciding
     * plan-wide rows on the TYPE rather than on a null department code is what
     * stops that fallback putting a delegate's name on the scenario row.
     */
    const planWide: LocalEntity[] = [
      entity("scenario", PLAN, null),
      entity("engine_run", `run:${PLAN}`, null),
      entity("position", "a", "D0410"),
    ];
    const { publishable, withheld } = filterToWriteScope(planWide, {
      canWriteStructure: false,
      departmentPolicy: UNRESTRICTED_WRITE,
    });
    expect(publishable.map((e) => e.entityId)).toEqual(["a"]);
    expect(withheld.map((e) => e.entityType).sort()).toEqual(["engine_run", "scenario"]);
  });

  /**
   * The half of the fix that is invisible until it is missing.
   *
   * Unlocking the grid for a department the server never enumerated, while this
   * filter still withheld it, would swap a visible lock for a silent lost write
   * — and it would be self-perpetuating: the department cannot be enumerated
   * until it has rows, and it cannot get rows while they are withheld. The grid
   * and this filter therefore consume the SAME `departmentWritePolicy`.
   */
  it("sends a full-scope owner's row in a department the server never listed", () => {
    const ownership: DepartmentOwnership = {
      planId: PLAN,
      planVersion: 1,
      authzVersion: 1,
      me: { relation: "OWNER" as const, scopeKind: "FULL" as const },
      structureEditableByMe: true,
      departments: [
        // Rooms is delegated away; F&B is theirs. Retail is the new outlet and
        // has no rows on the server yet, so it is not here at all.
        { code: "D0410", readable: true, writable: false, reason: null, assignedTo: [] },
        { code: "D0610", readable: true, writable: true, reason: null, assignedTo: [] },
      ],
    };

    const { publishable, withheld } = filterToWriteScope(
      [
        entity("position", "rooms", "D0410"),
        entity("position", "fb", "D0610"),
        entity("position", "retail", "D0910"),
      ],
      { canWriteStructure: true, departmentPolicy: departmentWritePolicy(ownership) }
    );

    expect(publishable.map((e) => e.entityId).sort()).toEqual(["fb", "retail"]);
    // The delegated one is still held back — an explicit refusal, not an absence.
    expect(withheld.map((e) => e.entityId)).toEqual(["rooms"]);
  });

  it("withholds the same row from a delegate", () => {
    const ownership: DepartmentOwnership = {
      planId: PLAN,
      planVersion: 1,
      authzVersion: 1,
      me: { relation: "DELEGATE" as const, scopeKind: "FULL" as const },
      structureEditableByMe: false,
      departments: [
        { code: "D0610", readable: true, writable: true, reason: null, assignedTo: [] },
      ],
    };

    const { publishable } = filterToWriteScope(
      [entity("position", "retail", "D0910"), entity("position", "fb", "D0610")],
      { canWriteStructure: false, departmentPolicy: departmentWritePolicy(ownership) }
    );

    expect(publishable.map((e) => e.entityId)).toEqual(["fb"]);
  });
});

describe("toCommitEntities", () => {
  it("skips rows whose hash already matches the shadow", () => {
    // The server would answer `unchanged` either way; not sending them is the
    // difference between a 400-byte request and a two-megabyte one.
    const row = entity("position", "a", "D0410");
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("position", "a"),
        { entityType: "position", entityId: "a", hash: row.hash, serverSeq: 5, deleted: false },
      ],
    ]);
    expect(toCommitEntities([row], shadow)).toHaveLength(0);
  });

  it("sends a null baseHash for a row the server has never seen", () => {
    const row = entity("position", "a", "D0410");
    const commits = toCommitEntities([row], new Map());
    expect(commits[0].baseHash).toBeNull();
  });

  it("sends the remembered hash as baseHash for a known row", () => {
    const row = entity("position", "a", "D0410");
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("position", "a"),
        { entityType: "position", entityId: "a", hash: "old-hash", serverSeq: 5, deleted: false },
      ],
    ]);
    const commits = toCommitEntities([row], shadow);
    expect(commits[0].baseHash).toBe("old-hash");
    expect(commits[0].hash).toBe(row.hash);
  });

  it("re-sends a row whose deletion state changed even at the same hash", () => {
    const row = { ...entity("position", "a", "D0410"), deleted: true };
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("position", "a"),
        { entityType: "position", entityId: "a", hash: row.hash, serverSeq: 5, deleted: false },
      ],
    ]);
    expect(toCommitEntities([row], shadow)).toHaveLength(1);
  });

  it("never puts a department on an inherited row", () => {
    // The server derives it from the parent. Sending ours would be a second
    // source of truth for an authorization input.
    const pii = entity("position_pii", "pos-1", "D0410");
    const commits = toCommitEntities([pii], new Map());
    expect(commits[0].department).toBeNull();
  });
});

describe("purgesFor", () => {
  it("emits a purge for a published row that is now gone locally", () => {
    // The 30-day tombstone cleanup hard-deletes rows. A plain absence is
    // indistinguishable from "never existed", so the server keeps serving it and
    // every client resurrects it.
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("position", "gone"),
        { entityType: "position", entityId: "gone", hash: "h", serverSeq: 3, deleted: false },
      ],
    ]);
    const purges = purgesFor([], shadow);
    expect(purges).toHaveLength(1);
    expect(purges[0]).toMatchObject({ op: "purge", entityId: "gone", baseHash: "h" });
  });

  it("does not re-purge a row already recorded as a tombstone", () => {
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("position", "gone"),
        { entityType: "position", entityId: "gone", hash: "h", serverSeq: 3, deleted: true },
      ],
    ]);
    expect(purgesFor([], shadow)).toHaveLength(0);
  });

  it("leaves rows that still exist locally alone", () => {
    const row = entity("position", "here", "D0410");
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("position", "here"),
        { entityType: "position", entityId: "here", hash: "h", serverSeq: 3, deleted: false },
      ],
    ]);
    expect(purgesFor([row], shadow)).toHaveLength(0);
  });

  /**
   * The three ways an absence used to be misread as a deletion.
   *
   * Each one produced a purge on every publish, for ever — the server refused
   * them, so nothing was destroyed, but each was still counted and announced to
   * the user as "N deletions recorded" on a publish that deleted nothing.
   */
  it("does not purge a row that is here but outside this caller's write scope", () => {
    // The bug: `publishPlan` passed the POST-scope `publishable` set. A
    // delegate's every publish therefore proposed deleting the plan's own
    // rows and every position in a department they may read but not write.
    const mine = entity("position", "mine", "D0410");
    const theirs = entity("position", "theirs", "D0610");
    const shadow = new Map<string, ShadowRow>(
      ["mine", "theirs"].map((id) => [
        shadowKey("position", id),
        { entityType: "position", entityId: id, hash: "h", serverSeq: 3, deleted: false },
      ])
    );
    expect(purgesFor([mine, theirs], shadow)).toHaveLength(0);
  });

  it("does not purge personal details the property told us not to send", () => {
    // "Stop collecting" is not "destroy the archive" — erasure is its own
    // deliberate act. Switching PII storage off used to delete every record
    // already on the server, one publish later.
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("position_pii", "pos-1"),
        {
          entityType: "position_pii",
          entityId: "pos-1",
          hash: "h",
          serverSeq: 3,
          deleted: false,
        },
      ],
    ]);
    const scannedTypes = new Set(["scenario", "position", "component_value"]);
    expect(purgesFor([], shadow, { scannedTypes })).toHaveLength(0);
    // Still purges a type that WAS looked at and genuinely is not here.
    expect(purgesFor([], shadow, { scannedTypes: new Set(["position_pii"]) })).toHaveLength(
      1
    );
  });

  it("does not purge a row that is present but broken", () => {
    // An orphaned sidecar is damage on this computer. Answering it by deleting
    // the server's copy destroys the only intact one left.
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("position_pii", "pos-gone"),
        {
          entityType: "position_pii",
          entityId: "pos-gone",
          hash: "h",
          serverSeq: 3,
          deleted: false,
        },
      ],
    ]);
    const purges = purgesFor([], shadow, {
      unpublishable: [
        {
          entityType: "position_pii",
          entityId: "pos-gone",
          parentId: "pos-gone",
          reason: "ORPHANED_LOCALLY",
        },
      ],
    });
    expect(purges).toHaveLength(0);
  });

  it("does not let a delegate purge the plan's own rows", () => {
    // Re-running the engine replaces `engine_run` rows under new ids, so the
    // old ones are absent locally and look exactly like a deletion — of a
    // plan-wide row that was never a delegate's to delete.
    const shadow = new Map<string, ShadowRow>([
      [
        shadowKey("engine_run", "run-1"),
        { entityType: "engine_run", entityId: "run-1", hash: "h", serverSeq: 3, deleted: false },
      ],
    ]);
    expect(purgesFor([], shadow, { canWriteStructure: false })).toHaveLength(0);
    expect(purgesFor([], shadow, { canWriteStructure: true })).toHaveLength(1);
  });
});

describe("chunkEntities", () => {
  const limits = { commitMaxEntities: 3, commitMaxBytes: 1_000_000 };

  it("respects the entity ceiling", () => {
    const chunks = chunkEntities(commits(7), limits);
    expect(chunks.map((chunk) => chunk.length)).toEqual([3, 3, 1]);
  });

  it("respects the byte ceiling", () => {
    const one = commits(1)[0];
    const size = Buffer.byteLength(JSON.stringify(one), "utf8");
    const chunks = chunkEntities(commits(5), {
      commitMaxEntities: 1000,
      commitMaxBytes: size * 2,
    });
    expect(chunks.every((chunk) => chunk.length <= 2)).toBe(true);
    expect(chunks.flat()).toHaveLength(5);
  });

  it("preserves order, so a parent is never in a later chunk than its child", () => {
    const ordered = commits(10);
    const flat = chunkEntities(ordered, limits).flat();
    expect(flat.map((entity) => entity.entityId)).toEqual(
      ordered.map((entity) => entity.entityId)
    );
  });

  it("gives an oversized entity its own chunk rather than dropping it", () => {
    // The server rejects it as PAYLOAD_TOO_LARGE and says so, which is far
    // better than the row silently vanishing on the client.
    const big: CommitEntity = {
      ...commits(1)[0],
      payload: { blob: "x".repeat(5000) },
    };
    const chunks = chunkEntities([big], { commitMaxEntities: 10, commitMaxBytes: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it("returns nothing for nothing", () => {
    expect(chunkEntities([], limits)).toEqual([]);
  });
});

describe("PUBLISH_ORDER", () => {
  it("puts every parent ahead of the types that reference it", () => {
    const index = (type: string) => PUBLISH_ORDER.indexOf(type as never);
    expect(index("position")).toBeLessThan(index("position_pii"));
    expect(index("position")).toBeLessThan(index("component_value"));
  });
});

// ------------------------------------------------------------------ helpers

function entity(
  entityType: LocalEntity["entityType"],
  entityId: string,
  department: string | null
): LocalEntity {
  const payload = { id: entityId, departmentCode: department };
  return {
    entityType,
    entityId,
    parentId: entityType === "position_pii" ? entityId : null,
    department,
    deleted: false,
    clientUpdatedAt: "2026-07-01T00:00:00.000Z",
    hash: contentHash(payload),
    payload,
  };
}

function commits(count: number): CommitEntity[] {
  return Array.from({ length: count }, (_unused, index): CommitEntity => ({
    entityType: "position",
    entityId: `id-${index}`,
    op: "upsert" as const,
    parentId: null,
    department: "D0410",
    baseHash: null,
    hash: `h-${index}`,
    deleted: false,
    clientUpdatedAt: "2026-07-01T00:00:00.000Z",
    payload: { id: `id-${index}`, departmentCode: "D0410" },
  }));
}
