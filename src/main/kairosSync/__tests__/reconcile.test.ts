/**
 * Reconciliation: the `serverOnly` tri-state.
 *
 * The table from §3.4 of the API guide, which is the part of the protocol most
 * easily got wrong and most expensive to get wrong:
 *
 *   deleted=1                → a tombstone we already applied; record it, do not
 *                              re-pull it on every single sync
 *   deleted=0, seq > mark    → genuinely new to us; pull it
 *   deleted=0, seq <= mark   → we saw it and purged it locally; send op:"purge"
 *
 * Without `deleted`, every reconcile re-downloads every tombstone forever.
 * Without `serverSeq`, "already deleted" is indistinguishable from "never seen",
 * and a purge would resurrect-then-kill rows on a loop.
 */

import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { KAIROS_SYNC_TABLES_SQL } from "../schema";
import { ensureSyncState, updateSyncState, writeShadow } from "../repo";
import { reconcilePlan, rebuildShadowFromServer } from "../reconcile";
import { ManifestDiffResponse } from "../../../shared/kairosSync/protocol";

type Db = InstanceType<typeof Database>;

const PLAN = "plan-1";
const OU = "OU25RJ2";

function makeDb(watermark: number): Db {
  const db = new Database(":memory:");
  db.exec(KAIROS_SYNC_TABLES_SQL);
  ensureSyncState(db, PLAN, OU);
  updateSyncState(db, PLAN, { watermark });
  return db;
}

/** A KairosClient stand-in that answers one canned diff. */
function stubClient(response: Partial<ManifestDiffResponse>) {
  const body: ManifestDiffResponse = {
    planId: PLAN,
    version: 100,
    syncEpoch: 0,
    scope: { kind: "FULL", departments: null },
    matched: 0,
    needed: [],
    serverOnly: [],
    truncated: false,
    ...response,
  };
  return {
    post: vi.fn(async () => body),
    get: vi.fn(async () => body),
  } as never;
}

describe("serverOnly tri-state", () => {
  it("records a tombstone rather than queueing it for download", () => {
    const db = makeDb(50);
    const client = stubClient({
      serverOnly: [["position", "dead", "h1", 20, 1]],
    });

    return reconcilePlan(db, client, PLAN).then((result) => {
      expect(result.serverOnly[0].action).toBe("record-tombstone");
      expect(result.purges).toHaveLength(0);

      // And it is written to the shadow, so the NEXT reconcile does not report
      // it again. That is the whole reason the `deleted` element exists.
      const stored = db
        .prepare(
          `SELECT deleted FROM kairos_sync_shadow
            WHERE plan_id = ? AND entity_type = 'position' AND entity_id = 'dead'`
        )
        .get(PLAN) as { deleted: number } | undefined;
      expect(stored?.deleted).toBe(1);
    });
  });

  it("queues a row newer than the watermark for download", async () => {
    const db = makeDb(50);
    const client = stubClient({
      serverOnly: [["position", "fresh", "h2", 80, 0]],
    });
    const result = await reconcilePlan(db, client, PLAN);
    expect(result.serverOnly[0].action).toBe("pull");
    expect(result.purges).toHaveLength(0);
  });

  it("purges a row at or below the watermark that we no longer hold", async () => {
    // We saw it, we deleted it locally, and the server still has it. A pull
    // would resurrect it; a purge records the death.
    const db = makeDb(50);
    const client = stubClient({
      serverOnly: [["position", "purged", "h3", 30, 0]],
    });
    const result = await reconcilePlan(db, client, PLAN);
    expect(result.serverOnly[0].action).toBe("purge");
    expect(result.purges).toEqual([
      expect.objectContaining({ entityId: "purged", op: "purge", baseHash: "h3" }),
    ]);
  });

  it("treats a row exactly at the watermark as already seen", async () => {
    const db = makeDb(50);
    const client = stubClient({
      serverOnly: [["position", "edge", "h4", 50, 0]],
    });
    const result = await reconcilePlan(db, client, PLAN);
    expect(result.serverOnly[0].action).toBe("purge");
  });

  it("reports rows the server does not have at our hash", async () => {
    const db = makeDb(50);
    const client = stubClient({
      matched: 12,
      needed: [
        ["position", "stale", "server-hash"],
        ["position", "unknown", null],
      ],
    });
    const result = await reconcilePlan(db, client, PLAN);
    expect(result.matched).toBe(12);
    expect(result.needed).toEqual([
      { entityType: "position", entityId: "stale", serverHash: "server-hash" },
      { entityType: "position", entityId: "unknown", serverHash: null },
    ]);
  });
});

describe("the manifest we send", () => {
  it("omits our own tombstones", () => {
    // We never claim to hold a deleted row, so the server always reports its
    // tombstones back — which is what the tri-state is for.
    const db = makeDb(50);
    writeShadow(
      db,
      PLAN,
      [
        { entityType: "position", entityId: "live", hash: "a", serverSeq: 1, deleted: false },
        { entityType: "position", entityId: "dead", hash: "b", serverSeq: 2, deleted: true },
      ],
      "2026-07-01T00:00:00.000Z"
    );

    const client = stubClient({});
    return reconcilePlan(db, client, PLAN).then(() => {
      const sent = (client as unknown as { post: ReturnType<typeof vi.fn> }).post.mock
        .calls[0][1] as { entities: string[][] };
      expect(sent.entities).toEqual([["position", "live", "a"]]);
    });
  });
});

describe("suggestFullPull", () => {
  it("prefers one full download when most of the plan is missing locally", async () => {
    // A rebuilt store, or a plan pulled on a device that never had it. Thousands
    // of individual decisions cost more than one `since=0`.
    const db = makeDb(0);
    const client = stubClient({
      serverOnly: Array.from({ length: 10 }, (_unused, index) => [
        "position",
        `p${index}`,
        `h${index}`,
        100 + index,
        0,
      ]) as never,
    });
    const result = await reconcilePlan(db, client, PLAN);
    expect(result.suggestFullPull).toBe(true);
  });

  it("does not suggest it when only a couple of rows differ", async () => {
    const db = makeDb(50);
    writeShadow(
      db,
      PLAN,
      Array.from({ length: 20 }, (_unused, index) => ({
        entityType: "position",
        entityId: `known-${index}`,
        hash: `h${index}`,
        serverSeq: index,
        deleted: false,
      })),
      "2026-07-01T00:00:00.000Z"
    );
    const client = stubClient({
      serverOnly: [["position", "new", "h", 90, 0]],
    });
    const result = await reconcilePlan(db, client, PLAN);
    expect(result.suggestFullPull).toBe(false);
  });
});

describe("rebuildShadowFromServer", () => {
  it("repopulates the shadow after a local database rebuild", async () => {
    // Settings → Rebuild database drops every secure table, shadow included.
    // Without this, the next publish sends everything with baseHash null and
    // gets a wall of ALREADY_EXISTS conflicts.
    const db = makeDb(0);
    const client = stubClient({
      serverOnly: [
        ["position", "a", "h1", 10, 0],
        ["position", "b", "h2", 11, 1],
      ],
    });

    const count = await rebuildShadowFromServer(db, client, PLAN);
    expect(count).toBe(2);

    const rows = db
      .prepare(
        `SELECT entity_id, hash, server_seq, deleted FROM kairos_sync_shadow
          WHERE plan_id = ? ORDER BY entity_id`
      )
      .all(PLAN);
    expect(rows).toEqual([
      { entity_id: "a", hash: "h1", server_seq: 10, deleted: 0 },
      { entity_id: "b", hash: "h2", server_seq: 11, deleted: 1 },
    ]);
  });
});
