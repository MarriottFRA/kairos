/**
 * The cached write scope must be able to correct itself.
 *
 * `/department-ownership` is the one route in the feature with a body cache, and
 * everything that decides whether a cell is editable — and what a publish sends
 * — reads it. Two defects made a wrong answer permanent:
 *
 * - a 200 carrying an EMPTY body was treated as "unchanged", so the stale body
 *   survived and a new ETag was stored for a document never received;
 * - a handback happens on the DELEGATE's machine, so the owner has no local
 *   event to invalidate on. If the server's ETag does not fold delegation state
 *   they are answered 304 for ever, locked out of a department nobody holds.
 *
 * So a self-contradictory replay buys exactly one unconditional retry — once per
 * (plan, ETag), never on a lock that is correct, and never turning a
 * `writable: false` into a writable department.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { KAIROS_SYNC_TABLES_SQL } from "../schema";
import { fetchOwnership, invalidateOwnership, resetOwnershipChallenges } from "../ownership";
import { ensureSyncState, getSyncState } from "../repo";
import {
  DepartmentOwnership,
  DepartmentOwnershipRow,
  Relation,
} from "../../../shared/kairosSync/protocol";

type Db = InstanceType<typeof Database>;

const OU = "OU25RJ2";
const PLAN = "plan-1";
const ETAG = 'W/"3f9a2c118bd4e770"';
const ETAG2 = 'W/"aa11bb22cc33dd44"';

function makeDb(): Db {
  const db = new Database(":memory:");
  db.exec(KAIROS_SYNC_TABLES_SQL);
  ensureSyncState(db, PLAN, OU);
  return db;
}

function ownership(
  relation: Relation,
  departments: DepartmentOwnershipRow[]
): DepartmentOwnership {
  return {
    planId: PLAN,
    planVersion: 42,
    authzVersion: 14,
    me: { relation, scopeKind: "FULL" },
    structureEditableByMe: relation !== "DELEGATE",
    departments,
  };
}

const holder = (state: "ACTIVE" | "HANDED_BACK") => ({
  userId: 7,
  email: "bob@example.com",
  delegationId: "del-1",
  state,
});

/** The correct owner-side answer once D0610 has come back. */
const CLEAN = ownership("OWNER", [
  {
    code: "D0610",
    readable: true,
    writable: true,
    reason: null,
    assignedTo: [holder("HANDED_BACK")],
  },
]);

/** The shape the guide forbids: a delegate's reason on the owner's answer. */
const CONTRADICTORY = ownership("OWNER", [
  {
    code: "D0610",
    readable: true,
    writable: false,
    reason: "HANDED_BACK",
    assignedTo: [holder("HANDED_BACK")],
  },
]);

/** A department genuinely held by somebody. Nothing to re-ask about. */
const LEGITIMATE_LOCK = ownership("OWNER", [
  {
    code: "D0610",
    readable: true,
    writable: false,
    reason: "DELEGATED",
    assignedTo: [holder("ACTIVE")],
  },
]);

type Answer =
  | { status: 200; body?: DepartmentOwnership; etag?: string }
  | { status: 304 };

/** Answers a scripted sequence, recording the ETag it was asked with each time. */
function stubClient(answers: Answer[]) {
  let call = 0;
  const seen: Array<string | null> = [];
  return {
    seen,
    calls: () => call,
    client: {
      getConditional: vi.fn(async (_path: string, etag: string | null) => {
        seen.push(etag);
        const answer = answers[Math.min(call++, answers.length - 1)];
        if (answer.status === 304) {
          return { status: 304 as const, body: null, etag: etag ?? ETAG };
        }
        return {
          status: 200 as const,
          body: answer.body,
          etag: answer.etag ?? ETAG,
        };
      }),
    } as never,
  };
}

describe("fetchOwnership", () => {
  // The retry memo is process-lifetime by design, so each test starts clean.
  beforeEach(() => resetOwnershipChallenges());

  it("stores the body alongside the ETag on a 200", async () => {
    const db = makeDb();
    const { client } = stubClient([{ status: 200, body: CLEAN }]);

    const result = await fetchOwnership(db, client, PLAN);

    expect(result.notModified).toBe(false);
    expect(result.ownership?.departments[0].writable).toBe(true);

    const stored = getSyncState(db, PLAN);
    expect(stored?.ownershipEtag).toBe(ETAG);
    expect(JSON.parse(String(stored?.ownershipJson)).departments[0].code).toBe("D0610");
    // The write scope the publish filter reads, derived from the same answer.
    expect(stored?.scopeDepartments).toEqual(["D0610"]);
  });

  it("replays the stored body on a 304 instead of answering null", async () => {
    const db = makeDb();
    const { client, seen } = stubClient([
      { status: 200, body: CLEAN },
      { status: 304 },
    ]);

    await fetchOwnership(db, client, PLAN);
    const second = await fetchOwnership(db, client, PLAN);

    expect(seen).toEqual([null, ETAG]);
    expect(second.notModified).toBe(true);
    // A caller handed null here reads it as "nothing is writable", which is the
    // opposite of what the server said.
    expect(second.ownership?.departments[0].writable).toBe(true);
    expect(getSyncState(db, PLAN)?.ownershipJson).toBeTruthy();
  });

  it("keeps the cached body and drops the ETag when a 200 carries nothing", async () => {
    const db = makeDb();
    const { client, seen } = stubClient([
      { status: 200, body: CLEAN },
      { status: 200, body: undefined, etag: ETAG2 },
    ]);

    await fetchOwnership(db, client, PLAN);
    const second = await fetchOwnership(db, client, PLAN);

    // Not a 304: the cached body is served, but the ETag for a document we
    // never received must NOT be stored, or the next request 304s into nothing.
    expect(second.notModified).toBe(false);
    expect(second.ownership?.departments[0].code).toBe("D0610");
    const stored = getSyncState(db, PLAN);
    expect(stored?.ownershipEtag).toBeNull();
    expect(JSON.parse(String(stored?.ownershipJson)).departments[0].code).toBe("D0610");

    // And so the call after it goes out unconditionally.
    await fetchOwnership(db, client, PLAN);
    expect(seen[2]).toBeNull();
  });

  it("sends no ETag when asked unconditionally", async () => {
    const db = makeDb();
    const { client, seen } = stubClient([
      { status: 200, body: CONTRADICTORY },
      { status: 200, body: CLEAN, etag: ETAG2 },
    ]);

    await fetchOwnership(db, client, PLAN);
    const forced = await fetchOwnership(db, client, PLAN, { unconditional: true });

    expect(seen).toEqual([null, null]);
    expect(forced.ownership?.departments[0].writable).toBe(true);
    expect(getSyncState(db, PLAN)?.ownershipEtag).toBe(ETAG2);
  });

  it("re-asks without the ETag when a replayed answer contradicts itself", async () => {
    const db = makeDb();
    const { client } = stubClient([{ status: 200, body: CONTRADICTORY }]);
    await fetchOwnership(db, client, PLAN);

    // As if the app had been restarted: the contradictory body is on disk and
    // the in-process memo of having already challenged it is gone. This is the
    // shape that matters — a cache carried across sessions is exactly what an
    // owner cannot clear by themselves, and a restart is the moment a
    // server-side fix is most likely to have shipped meanwhile.
    resetOwnershipChallenges();

    const { client: later, seen, calls } = stubClient([
      { status: 304 },
      { status: 200, body: CLEAN, etag: ETAG2 },
    ]);
    const second = await fetchOwnership(db, later, PLAN);

    // Two requests: the conditional one that 304'd, then the unconditional one
    // that settled it.
    expect(calls()).toBe(2);
    expect(seen).toEqual([ETAG, null]);
    expect(second.revalidated).toBe(true);
    expect(second.ownership?.departments[0].writable).toBe(true);
    expect(second.serverContradicts).toBe(false);
    // And the corrected answer replaces the bad one, so nothing replays it.
    expect(getSyncState(db, PLAN)?.ownershipEtag).toBe(ETAG2);
  });

  it("does not re-ask a 304 that replays a contradiction it has just been told", async () => {
    const db = makeDb();
    const { client, calls } = stubClient([
      { status: 200, body: CONTRADICTORY },
      { status: 304 },
    ]);

    await fetchOwnership(db, client, PLAN);
    const second = await fetchOwnership(db, client, PLAN);

    // The fresh 200 already WAS the unconditional answer for this ETag. Asking
    // again to hear it a second time would double the cost of every focus.
    expect(calls()).toBe(2);
    expect(second.revalidated).toBe(false);
    expect(second.ownership?.departments[0].writable).toBe(false);
  });

  it("stops re-asking once a fresh answer says the same thing", async () => {
    const db = makeDb();
    const { client, calls } = stubClient([{ status: 200, body: CONTRADICTORY }]);

    const first = await fetchOwnership(db, client, PLAN);
    expect(first.serverContradicts).toBe(true);
    expect(calls()).toBe(1);

    // The ETag the contradictory answer arrived under is remembered, so the
    // 304s that follow it do not each buy a second request to hear it again.
    const { client: conditional, calls: laterCalls } = stubClient([{ status: 304 }]);
    const second = await fetchOwnership(db, conditional, PLAN);
    expect(laterCalls()).toBe(1);
    expect(second.revalidated).toBe(false);
    // And it still reports what the server said. Never unlocked locally.
    expect(second.ownership?.departments[0].writable).toBe(false);
  });

  it("costs one request for a department somebody is actually holding", async () => {
    const db = makeDb();
    const { client, calls } = stubClient([
      { status: 200, body: LEGITIMATE_LOCK },
      { status: 304 },
    ]);

    await fetchOwnership(db, client, PLAN);
    const second = await fetchOwnership(db, client, PLAN);

    expect(calls()).toBe(2);
    expect(second.revalidated).toBe(false);
    expect(second.ownership?.departments[0].writable).toBe(false);
  });

  it("costs one request for a degraded owner whose access really did shrink", async () => {
    const db = makeDb();
    const degraded = ownership("OWNER_DEGRADED", [
      {
        code: "D0610",
        readable: true,
        writable: false,
        reason: "NOT_IN_WRITE_SCOPE",
        assignedTo: [],
      },
    ]);
    const { client, calls } = stubClient([
      { status: 200, body: degraded },
      { status: 304 },
    ]);

    await fetchOwnership(db, client, PLAN);
    const second = await fetchOwnership(db, client, PLAN);

    // No holder and no write is a legitimate answer for this relation. Firing
    // here would spend a request on every window focus for a correct lock.
    expect(calls()).toBe(2);
    expect(second.revalidated).toBe(false);
  });

  it("leaves nothing behind when a delegation mutation invalidates the cache", async () => {
    const db = makeDb();
    const { client } = stubClient([{ status: 200, body: LEGITIMATE_LOCK }]);
    await fetchOwnership(db, client, PLAN);

    invalidateOwnership(db, PLAN);

    const stored = getSyncState(db, PLAN);
    // Both, together: an ETag without a body 304s into an empty cache, and a
    // body without an ETag is validated by nothing.
    expect(stored?.ownershipEtag).toBeNull();
    expect(stored?.ownershipJson).toBeNull();
  });
});
