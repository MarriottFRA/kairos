/**
 * The watermark has to land, and it can only land on a row that exists.
 *
 * `completePull` and `updateSyncState` are bare UPDATEs — deliberately, so that
 * a partial patch cannot conjure a state row for a plan the server has never
 * told us about. That leaves one question: is the row always there by the time
 * a pull finishes?
 *
 * It was not. The only INSERT was in `heads.ts`, which skips a plan the caller
 * cannot read and is skipped wholesale on a 304. Between those two gaps a pull
 * could apply every page and then record NOTHING — no watermark, no
 * `last_pulled_at`, no scope. The download reported success, the card never
 * moved, and every retry re-downloaded the entire plan, silently, for ever.
 */

import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { KAIROS_SYNC_TABLES_SQL } from "../schema";
import { getSyncState, updateSyncState, ensureSyncState } from "../repo";
import { pullPlan } from "../pull";
import { ChangesPage } from "../../../shared/kairosSync/protocol";

type Db = InstanceType<typeof Database>;

const PLAN = "plan-1";
const OU = "OU25RJ2";

function makeDb(): Db {
  const db = new Database(":memory:");
  db.exec(KAIROS_SYNC_TABLES_SQL);
  return db;
}

/**
 * One page carrying no entities.
 *
 * Nothing here is about applying rows — `apply.test.ts` covers that — so an
 * empty page keeps this test to the bookkeeping it is actually about and needs
 * no positions schema.
 */
function stubClient(page: Partial<ChangesPage> = {}) {
  const body: ChangesPage = {
    planId: PLAN,
    fromVersion: 0,
    toVersion: 42,
    syncEpoch: 3,
    structureVersion: 7,
    scope: { kind: "FULL", departments: null },
    entities: [],
    nextCursor: null,
    ...page,
  } as ChangesPage;
  return { get: vi.fn(async () => body) } as never;
}

const STORES = () => {
  const db = makeDb();
  return { localDb: db, secureDb: db };
};

describe("pullPlan bookkeeping", () => {
  it("records the watermark for a plan with no state row yet", async () => {
    const db = makeDb();
    const client = stubClient();

    await pullPlan(STORES(), db, client, {
      planId: PLAN,
      ou: OU,
      since: 0,
      apply: true,
    });

    const state = getSyncState(db, PLAN);
    expect(state).not.toBeNull();
    expect(state?.watermark).toBe(42);
    expect(state?.syncEpoch).toBe(3);
    expect(state?.lastPulledAt).not.toBeNull();
    // The scope the copy was taken under — the input to `readScopeWidened` on
    // every subsequent probe, and useless if it never lands.
    expect(state?.scopeKind).toBe("FULL");
    expect(state?.ou).toBe(OU);
  });

  it("advances an existing row rather than resetting it", async () => {
    const db = makeDb();
    ensureSyncState(db, PLAN, OU);
    updateSyncState(db, PLAN, { watermark: 10, piiWatermark: 9 });

    await pullPlan(STORES(), db, stubClient({ fromVersion: 10 }), {
      planId: PLAN,
      ou: OU,
      since: 10,
      apply: true,
    });

    const state = getSyncState(db, PLAN);
    expect(state?.watermark).toBe(42);
    // The PII stream keeps its own watermark and is pulled separately; the
    // entity pull must not touch it.
    expect(state?.piiWatermark).toBe(9);
  });

  it("writes nothing on a dry run", async () => {
    // The preview fetches the same pages to count them. Recording a watermark
    // for rows it deliberately did not apply would lose them permanently.
    const db = makeDb();
    ensureSyncState(db, PLAN, OU);

    await pullPlan(STORES(), db, stubClient(), {
      planId: PLAN,
      ou: OU,
      since: 0,
      apply: false,
    });

    expect(getSyncState(db, PLAN)?.watermark).toBe(0);
    expect(getSyncState(db, PLAN)?.lastPulledAt).toBeNull();
  });
});
