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

/**
 * A plan at this hotel that this caller may see and not read.
 *
 * Every field describing its contents is null — that is the shape the server
 * sends for `OU_VISITOR`, and it is the shape the arithmetic below has to
 * survive.
 */
const LOCKED_PLAN = "plan-2";
const WITH_LOCKED: SyncHeads = {
  ...HEADS,
  plans: [
    ...HEADS.plans,
    {
      id: LOCKED_PLAN,
      version: null,
      structureVersion: null,
      syncEpoch: null,
      state: "ACTIVE",
      relation: "OU_VISITOR",
      scopeKind: null,
      departments: null,
      handbacksPending: 0,
    },
  ],
};

/** A client that answers 200 once, then 304 to the ETag it just handed out. */
function stubClient(answers: Array<{ status: 200 | 304 }>, body: SyncHeads = HEADS) {
  let call = 0;
  const seen: Array<string | null> = [];
  return {
    seen,
    client: {
      getConditional: vi.fn(async (_path: string, etag: string | null) => {
        seen.push(etag);
        const answer = answers[Math.min(call++, answers.length - 1)];
        return answer.status === 200
          ? { status: 200 as const, body, etag: ETAG }
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

  /**
   * A plan this caller may see and not read.
   *
   * The server sends `version`, `syncEpoch`, `structureVersion` and `scopeKind`
   * as null for these, and the loop's arithmetic is not merely uninformative on
   * a null — it is wrong. `null !== 0` is true, so a locked plan with a state
   * row would set `epochMoved` and enter `stalePlans` on EVERY probe, for ever,
   * driving a full re-pull against an endpoint that only ever answers 403.
   */
  describe("a plan that is not shared with this caller", () => {
    it("is reported separately rather than treated as a plan to sync", async () => {
      const db = makeDb();
      const { client } = stubClient([{ status: 200 }], WITH_LOCKED);

      const result = await fetchHeads(db, client, OU);

      expect(result.lockedPlans.map((plan) => plan.id)).toEqual([LOCKED_PLAN]);
      expect(result.stalePlans.map((plan) => plan.id)).toEqual([PLAN]);
    });

    it("never moves the epoch, however many times it is probed", async () => {
      const db = makeDb();
      const { client } = stubClient([{ status: 200 }], WITH_LOCKED);

      await fetchHeads(db, client, OU);
      const second = await fetchHeads(db, client, OU);
      const third = await fetchHeads(db, client, OU);

      expect(second.epochMoved).toBe(false);
      expect(third.epochMoved).toBe(false);
      // plan-1 IS legitimately stale every time — a probe never advances a
      // watermark, only a completed pull does. The locked one must never be.
      expect(third.stalePlans.map((plan) => plan.id)).not.toContain(LOCKED_PLAN);
    });

    it("gets no sync state row — there is no watermark to keep", async () => {
      // Creating one is what made the epoch comparison reachable at all, and a
      // row here also makes the Sync page report the plan as "published" and
      // therefore local.
      const db = makeDb();
      const { client } = stubClient([{ status: 200 }], WITH_LOCKED);

      await fetchHeads(db, client, OU);

      expect(getSyncState(db, LOCKED_PLAN)).toBeNull();
      expect(getSyncState(db, PLAN)).not.toBeNull();
    });

    it("is still reported on a 304, because the ETag will not move on its own", async () => {
      // A visitor's probe ETag is stable precisely BECAUSE the fields that
      // change are the withheld ones. A purge gated on a 200 would wait for a
      // change that never comes.
      const db = makeDb();
      const { client } = stubClient([{ status: 200 }, { status: 304 }], WITH_LOCKED);

      await fetchHeads(db, client, OU);
      const second = await fetchHeads(db, client, OU);

      expect(second.notModified).toBe(true);
      expect(second.lockedPlans.map((plan) => plan.id)).toEqual([LOCKED_PLAN]);
    });
  });

  /**
   * The revoked-delegation banner is a claim the server is allowed to retract.
   *
   * It is written by whichever call happened to catch the 403, and until the
   * probe learned to clear it the ONLY thing that did was a successful publish
   * — so a delegate who was withdrawn and then re-granted, or handed the plan
   * outright, kept a blocking "your access was withdrawn" banner over a plan
   * they could read, with no action offered that would clear it.
   */
  describe("a recorded revocation", () => {
    function withRevocation(db: Db, planId: string): void {
      db.prepare(
        `INSERT INTO kairos_sync_state (plan_id, ou, revoked_json)
         VALUES (?, ?, ?)
         ON CONFLICT(plan_id) DO UPDATE SET revoked_json = excluded.revoked_json`
      ).run(planId, OU, JSON.stringify({ revokedAt: "2026-08-07T09:00:00Z" }));
    }

    it("is retracted once the plan comes back readable", async () => {
      const db = makeDb();
      withRevocation(db, PLAN);
      const { client } = stubClient([{ status: 200 }]);

      await fetchHeads(db, client, OU);

      expect(getSyncState(db, PLAN)?.revokedJson).toBeNull();
    });

    it("survives while the plan is still not shared", async () => {
      // The `canRead` gate skips these before the clear, which is what makes
      // the retraction safe: reaching it means the server is serving the plan
      // to this caller by SOME route, so the banner is contradicted.
      const db = makeDb();
      withRevocation(db, LOCKED_PLAN);
      const { client } = stubClient([{ status: 200 }], WITH_LOCKED);

      await fetchHeads(db, client, OU);

      expect(getSyncState(db, LOCKED_PLAN)?.revokedJson).not.toBeNull();
    });
  });
});
