/**
 * The 304 must not erase what the property looks like.
 *
 * `GET /sync/heads` answers 304 in the steady state, and a 304 carries no plan
 * list. A client that stores only the ETag therefore knows, from the second sync
 * onwards, nothing about which plans exist on the server — and everything
 * downstream reads that absence as "never published". The visible result is a
 * Sync page that offers to register plans it already registered, shows dashes
 * where the server version should be, and publishes at `baseVersion: 0` against
 * a live plan, which conflicts on every row.
 *
 * So: ETag and body are stored together, and a 304 replays the body.
 */

import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { KAIROS_SYNC_TABLES_SQL } from "../schema";
import { fetchHeads } from "../heads";
import { getOuState, getSyncState } from "../repo";
import { SyncHeads } from "../../../shared/kairosSync/protocol";

type Db = InstanceType<typeof Database>;

const OU = "OU25RJ2";
const PLAN = "plan-1";
const ETAG = 'W/"3f9a2c118bd4e770"';

function makeDb(): Db {
  const db = new Database(":memory:");
  db.exec(KAIROS_SYNC_TABLES_SQL);
  return db;
}

const HEADS: SyncHeads = {
  ou: OU,
  authzVersion: 14,
  plans: [
    {
      id: PLAN,
      version: 42,
      structureVersion: 7,
      syncEpoch: 0,
      state: "ACTIVE",
      relation: "OWNER",
      scopeKind: "FULL",
      departments: null,
      handbacksPending: 0,
    },
  ],
  structureVersion: 7,
  bst: null,
  clustersVersion: 3,
  mappingTablesVersion: "v24",
  limits: {
    commitMaxBytes: 1048576,
    commitMaxEntities: 5000,
    changesMaxBytes: 1048576,
    manifestMaxEntities: 10000,
  },
  applyOrder: ["calendar", "position"],
} as SyncHeads;

/** A client that answers 200 once, then 304 to the ETag it just handed out. */
function stubClient(answers: Array<{ status: 200 | 304 }>) {
  let call = 0;
  const seen: Array<string | null> = [];
  return {
    seen,
    client: {
      getConditional: vi.fn(async (_path: string, etag: string | null) => {
        seen.push(etag);
        const answer = answers[Math.min(call++, answers.length - 1)];
        return answer.status === 200
          ? { status: 200 as const, body: HEADS, etag: ETAG }
          : { status: 304 as const, body: null, etag: ETAG };
      }),
    } as never,
  };
}

describe("fetchHeads", () => {
  it("stores the body alongside the ETag on a 200", async () => {
    const db = makeDb();
    const { client } = stubClient([{ status: 200 }]);

    const result = await fetchHeads(db, client, OU);

    expect(result.notModified).toBe(false);
    expect(result.heads?.plans).toHaveLength(1);

    const stored = getOuState(db, OU);
    expect(stored?.headsEtag).toBe(ETAG);
    expect(JSON.parse(String(stored?.headsJson)).plans[0].id).toBe(PLAN);
  });

  it("replays the stored body on a 304 instead of answering null", async () => {
    const db = makeDb();
    const { client, seen } = stubClient([{ status: 200 }, { status: 304 }]);

    await fetchHeads(db, client, OU);
    const second = await fetchHeads(db, client, OU);

    // The ETag was sent back, so this really was the conditional path.
    expect(seen).toEqual([null, ETAG]);
    expect(second.notModified).toBe(true);
    // The whole point: a 304 still knows the plan and its version.
    expect(second.heads?.plans[0].id).toBe(PLAN);
    expect(second.heads?.plans[0].version).toBe(42);
  });

  it("reports no heads at all only when there has never been a 200", async () => {
    const db = makeDb();
    const { client } = stubClient([{ status: 304 }]);

    const result = await fetchHeads(db, client, OU);

    expect(result.notModified).toBe(true);
    expect(result.heads).toBeNull();
  });

  it("survives a corrupt cached body by degrading to a cache miss", async () => {
    const db = makeDb();
    const { client } = stubClient([{ status: 200 }, { status: 304 }]);
    await fetchHeads(db, client, OU);
    db.prepare(`UPDATE kairos_ou_state SET heads_json = 'not json' WHERE ou = ?`).run(OU);

    const result = await fetchHeads(db, client, OU);

    expect(result.heads).toBeNull();
  });

  it("caches the authorisation answer per plan on a 200", async () => {
    const db = makeDb();
    const { client } = stubClient([{ status: 200 }]);

    await fetchHeads(db, client, OU);

    const state = getSyncState(db, PLAN);
    expect(state?.relation).toBe("OWNER");
    expect(state?.scopeKind).toBe("FULL");
  });
});
