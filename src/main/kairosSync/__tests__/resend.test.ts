/**
 * "Publish everything again" — resend against what the server REALLY holds.
 *
 * The case it exists for: this computer's shadow says every row is published,
 * the server holds something different, and an ordinary publish therefore sends
 * nothing, for ever. Resend compares against the server's manifest instead.
 *
 * The two promises that make it safe to put in a menu are tested as hard as the
 * fix itself: it never deletes anything on the server, and a preview that is
 * cancelled leaves nothing behind.
 */

import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { HOTEL_CLUSTERS_SQL } from "../../hotelClusters/schema";
import { KAIROS_SYNC_TABLES_SQL } from "../schema";
import { ShadowRow, ensureSyncState, loadShadowMap, shadowKey, writeShadow } from "../repo";
import { collectLocalEntities, WriteScope } from "../collect";
import { previewPublish, publishPlan } from "../publish";
import { CommitEntity, CommitResponse } from "../../../shared/kairosSync/protocol";
import { UNRESTRICTED_WRITE } from "../../../shared/kairosSync/writePolicy";

type Db = InstanceType<typeof Database>;

const OU = "OU25RJ2";
const PLAN = "plan-1";
const OWNER_SCOPE: WriteScope = { canWriteStructure: true, departmentPolicy: UNRESTRICTED_WRITE };
const LIMITS = {
  commitMaxBytes: 1024 * 1024,
  commitMaxEntities: 5000,
  changesMaxBytes: 256 * 1024,
  manifestMaxEntities: 10000,
};

function makeStores(): { localDb: Db; secureDb: Db } {
  const localDb = new Database(":memory:");
  localDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  localDb.exec(HOTEL_CLUSTERS_SQL);
  const secureDb = new Database(":memory:");
  secureDb.exec(POSITIONS_VALUE_TABLES_SQL);
  secureDb.exec(MANUAL_INPUT_TABLES_SQL);
  secureDb.exec(ENGINE_OUTPUTS_SQL);
  secureDb.exec(KAIROS_SYNC_TABLES_SQL);
  return { localDb, secureDb };
}

/**
 * A plan this computer believes is fully published, and a server that
 * disagrees about three rows in three different ways.
 */
function setup() {
  const stores = makeStores();
  stores.localDb
    .prepare(`INSERT INTO scenarios (id, ou, year, label, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(PLAN, OU, 2026, "Budget", "2026-07-01T00:00:00.000Z");
  const insert = stores.secureDb.prepare(
    `INSERT INTO positions (id, ou, scenario_id, department_code, updated_at) VALUES (?, ?, ?, ?, ?)`
  );
  insert.run("pos-rooms", OU, PLAN, "D0410", "2026-07-01T00:00:00.000Z");
  insert.run("pos-fb", OU, PLAN, "D0610", "2026-07-01T00:00:00.000Z");

  const { entities } = collectLocalEntities(stores, { ou: OU, planId: PLAN });
  const rows: ShadowRow[] = entities.map((entity) => ({
    entityType: entity.entityType,
    entityId: entity.entityId,
    hash: entity.hash,
    serverSeq: 5,
    deleted: false,
  }));

  // This computer's belief: every row is published exactly as it is here.
  ensureSyncState(stores.secureDb, PLAN, OU);
  writeShadow(stores.secureDb, PLAN, rows, "2026-07-02T00:00:00.000Z");

  // The server's truth.
  const server = new Map(rows.map((row) => [shadowKey(row.entityType, row.entityId), { ...row }]));
  // 1. Rooms never landed in the form this computer has — the case to fix.
  server.get(shadowKey("position", "pos-rooms"))!.hash = "stale-hash00";
  // 2. A row only the server has. Must NOT be purged: this copy may be the
  //    incomplete one.
  server.set(shadowKey("position", "pos-ghost"), {
    entityType: "position",
    entityId: "pos-ghost",
    hash: "ghost-hash00",
    serverSeq: 6,
    deleted: false,
  });
  // 3. Deleted here, live on the server. Must NOT be sent as a tombstone by a
  //    resend; that is an ordinary publish's job, with its own review.
  stores.secureDb
    .prepare(`UPDATE positions SET deleted_at = ?, updated_at = ? WHERE id = ?`)
    .run("2026-07-03T00:00:00.000Z", "2026-07-03T00:00:00.000Z", "pos-fb");

  return { stores, server };
}

/** A server that accepts everything and records what it was sent. */
function stubClient() {
  const sent: CommitEntity[] = [];
  const client = {
    post: vi.fn(async (_path: string, body: { entities: CommitEntity[] }) => {
      sent.push(...body.entities);
      return {
        committedVersion: 6,
        syncEpoch: 0,
        scope: { kind: "FULL", departments: null },
        accepted: body.entities.map((entity) => ({
          entityType: entity.entityType,
          entityId: entity.entityId,
          hash: entity.hash,
          serverSeq: 7,
          overrodeBase: false,
        })),
        unchanged: [],
        conflicts: [],
        rejected: [],
      } as unknown as CommitResponse;
    }),
  };
  return { client: client as never, sent };
}

describe("resend", () => {
  it("sends the row the server holds differently, which an ordinary publish cannot see", async () => {
    const { stores, server } = setup();
    const { client, sent } = stubClient();

    await publishPlan(stores, stores.secureDb, client, {
      planId: PLAN,
      ou: OU,
      baseVersion: 5,
      scope: OWNER_SCOPE,
      limits: LIMITS,
      serverShadow: server,
    });

    const rooms = sent.find((entity) => entity.entityId === "pos-rooms");
    expect(rooms).toBeDefined();
    // Based on the server's real hash, so it is an ordinary accepted update
    // rather than a STALE conflict.
    expect(rooms?.baseHash).toBe("stale-hash00");
  });

  it("never deletes anything on the server", async () => {
    const { stores, server } = setup();
    const { client, sent } = stubClient();

    await publishPlan(stores, stores.secureDb, client, {
      planId: PLAN,
      ou: OU,
      baseVersion: 5,
      scope: OWNER_SCOPE,
      limits: LIMITS,
      serverShadow: server,
    });

    expect(sent.some((entity) => entity.op === "purge")).toBe(false);
    expect(sent.some((entity) => entity.deleted)).toBe(false);
    expect(sent.some((entity) => entity.entityId === "pos-ghost")).toBe(false);
    expect(sent.some((entity) => entity.entityId === "pos-fb")).toBe(false);
  });

  it("is not what an ordinary publish does — that one trusts the stored belief", async () => {
    // The control: with the stored shadow, Rooms looks published and is not
    // sent, which is the bug. The local deletion IS sent, as it should be.
    const { stores } = setup();
    const { client, sent } = stubClient();

    await publishPlan(stores, stores.secureDb, client, {
      planId: PLAN,
      ou: OU,
      baseVersion: 5,
      scope: OWNER_SCOPE,
      limits: LIMITS,
    });

    expect(sent.some((entity) => entity.entityId === "pos-rooms")).toBe(false);
    expect(sent.find((entity) => entity.entityId === "pos-fb")?.deleted).toBe(true);
  });

  it("leaves the stored shadow untouched when only previewed", () => {
    const { stores, server } = setup();
    const before = [...loadShadowMap(stores.secureDb, PLAN).entries()];

    const preview = previewPublish(stores, stores.secureDb, {
      planId: PLAN,
      ou: OU,
      baseVersion: 0,
      scope: OWNER_SCOPE,
      limits: LIMITS,
      serverShadow: server,
    });

    expect(preview.byType.position).toBe(1);
    expect([...loadShadowMap(stores.secureDb, PLAN).entries()]).toEqual(before);
  });

  it("moves the shadow only for the rows the server confirmed", async () => {
    const { stores, server } = setup();
    const { client } = stubClient();

    await publishPlan(stores, stores.secureDb, client, {
      planId: PLAN,
      ou: OU,
      baseVersion: 5,
      scope: OWNER_SCOPE,
      limits: LIMITS,
      serverShadow: server,
    });

    const shadow = loadShadowMap(stores.secureDb, PLAN);
    expect(shadow.get(shadowKey("position", "pos-rooms"))?.serverSeq).toBe(7);
    // Never adopted wholesale: the ghost the server holds is not recorded as
    // something this computer published.
    expect(shadow.has(shadowKey("position", "pos-ghost"))).toBe(false);
  });
});
