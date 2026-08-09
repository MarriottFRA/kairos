/**
 * The state machine behind the Sync page's one-line summary.
 *
 * The cases worth pinning down are the ones that are awkward to produce by hand
 * and expensive to get wrong: both sides ahead at once, a support lease, a
 * withdrawn delegation, and the difference between "never published" and
 * "published and level".
 */

import { describe, expect, it } from "vitest";
import { planState } from "../planState";
import { PlanSyncStatus } from "../ipc";
import { Lease } from "../protocol";

function plan(overrides: Partial<PlanSyncStatus> = {}): PlanSyncStatus {
  return {
    planId: "plan-1",
    ou: "OU25RJ2",
    year: 2026,
    label: "Budget 2026",
    published: true,
    serverVersion: 42,
    watermark: 42,
    relation: "OWNER",
    readable: true,
    scopeKind: "FULL",
    departments: null,
    writeScope: "FULL",
    structureEditable: true,
    handbacksPending: 0,
    lastPublishedAt: "2026-08-01T10:00:00Z",
    lastPulledAt: "2026-08-01T10:00:00Z",
    pendingChanges: 0,
    revoked: null,
    onThisComputer: true,
    ownerEmail: null,
    serverRows: 0,
    twinPlanId: null,
    twinReadable: true,
    ...overrides,
  };
}

const EXCLUSIVE: Lease = {
  leaseId: "lease-1",
  mode: "EXCLUSIVE",
  adminEmail: "support@example.com",
  acquiredAt: "2026-08-08T12:00:00Z",
  expiresAt: "2026-08-08T13:00:00Z",
  ticketRef: "INC-4182",
};

describe("planState", () => {
  it("is LOCAL_ONLY before the first publish, whatever the counters say", () => {
    const state = planState(plan({ published: false, pendingChanges: 162 }));
    expect(state.kind).toBe("LOCAL_ONLY");
    expect(state.action).toBe("register");
    // Never published is not a problem to solve — it is how the app works
    // without a server at all.
    expect(state.needsAttention).toBe(false);
    expect(state.detail).toContain("162 rows");
  });

  it("is UP_TO_DATE when both sides agree", () => {
    const state = planState(plan());
    expect(state.kind).toBe("UP_TO_DATE");
    expect(state.action).toBeNull();
    expect(state.tone).toBe("good");
  });

  it("is LOCAL_AHEAD with unpublished work", () => {
    const state = planState(plan({ pendingChanges: 162 }));
    expect(state.kind).toBe("LOCAL_AHEAD");
    expect(state.action).toBe("publish");
    expect(state.headline).toContain("162 changes");
  });

  it("is SERVER_AHEAD when the watermark is behind", () => {
    const state = planState(plan({ serverVersion: 47, watermark: 42 }));
    expect(state.kind).toBe("SERVER_AHEAD");
    expect(state.action).toBe("pull");
    expect(state.headline).toContain("5 changes");
  });

  it("is DIVERGED when both are ahead, and sends the user to the review", () => {
    const state = planState(plan({ serverVersion: 47, watermark: 42, pendingChanges: 3 }));
    expect(state.kind).toBe("DIVERGED");
    expect(state.action).toBe("review");
    expect(state.needsAttention).toBe(true);
  });

  it("singularises a count of one", () => {
    const state = planState(plan({ pendingChanges: 1 }));
    expect(state.headline).toContain("1 change ");
  });

  describe("blocking states win over the counters", () => {
    it("reports a withdrawn delegation ahead of anything else", () => {
      const state = planState(
        plan({
          pendingChanges: 40,
          serverVersion: 50,
          watermark: 42,
          revoked: { revokedAt: "2026-08-07T09:00:00Z" },
        })
      );
      expect(state.kind).toBe("REVOKED");
      expect(state.action).toBeNull();
      // The one thing the user actually needs to hear.
      expect(state.detail).toContain("not lost");
    });

    it("reports an exclusive lease held by somebody else", () => {
      const state = planState(plan({ pendingChanges: 12 }), EXCLUSIVE);
      expect(state.kind).toBe("LOCKED");
      expect(state.detail).toContain("INC-4182");
      expect(state.action).toBeNull();
    });

    it("does not block the administrator who is holding that lease", () => {
      const state = planState(
        plan({ relation: "ADMIN_LEASE", pendingChanges: 12 }),
        EXCLUSIVE
      );
      expect(state.kind).toBe("LOCAL_AHEAD");
    });

    it("treats a read-only lease as no obstacle at all", () => {
      const state = planState(plan({ pendingChanges: 12 }), {
        ...EXCLUSIVE,
        mode: "READ_ONLY_SUPPORT",
      });
      expect(state.kind).toBe("LOCAL_AHEAD");
    });
  });

  describe("plans this computer does not hold", () => {
    it("is CLOUD_ONLY, and the action is to download it", () => {
      // The case that made a delegate's Sync page empty: the server lists the
      // plan, the local scenarios table does not, so it was dropped entirely.
      const state = planState(
        plan({ onThisComputer: false, relation: "DELEGATE", watermark: 0 })
      );
      expect(state.kind).toBe("CLOUD_ONLY");
      expect(state.action).toBe("download");
      expect(state.needsAttention).toBe(true);
    });

    it("says plainly that downloading replaces the local plan of the same name", () => {
      const state = planState(plan({ onThisComputer: false, twinPlanId: "local-1" }));
      expect(state.kind).toBe("CLOUD_ONLY");
      expect(state.detail).toContain("removes the other");
    });

    it("wins over the version counters, which mean nothing without a local copy", () => {
      const state = planState(
        plan({ onThisComputer: false, serverVersion: 50, watermark: 0 })
      );
      expect(state.kind).toBe("CLOUD_ONLY");
    });

    it("still yields to a lease and a revocation", () => {
      expect(planState(plan({ onThisComputer: false }), EXCLUSIVE).kind).toBe("LOCKED");
      expect(planState(plan({ onThisComputer: false, revoked: {} })).kind).toBe("REVOKED");
    });
  });

  describe("a local plan whose name is already taken on the server", () => {
    it("is NAME_TAKEN and offers no publish", () => {
      // Publishing here mints a SECOND plan of the same name rather than
      // linking to the first — the ids differ and the id is the plan.
      const state = planState(
        plan({ published: false, pendingChanges: 162, twinPlanId: "cloud-1" })
      );
      expect(state.kind).toBe("NAME_TAKEN");
      expect(state.action).toBeNull();
      expect(state.needsAttention).toBe(true);
    });

    it("does not fire once this copy has a plan of its own on the server", () => {
      const state = planState(plan({ published: true, twinPlanId: "cloud-1" }));
      expect(state.kind).toBe("UP_TO_DATE");
    });
  });

  describe("read-only relations", () => {
    it("names the administrator case, because it is the confusing one", () => {
      const state = planState(plan({ relation: "GLOBAL_ADMIN" }));
      expect(state.kind).toBe("READ_ONLY");
      expect(state.headline).toContain("not this plan's owner");
      expect(state.action).toBeNull();
    });

    it("keeps a degraded owner writable — they still hold their departments", () => {
      const state = planState(plan({ relation: "OWNER_DEGRADED", pendingChanges: 5 }));
      expect(state.kind).toBe("LOCAL_AHEAD");
    });

    it("treats an unknown relation as writable rather than locking the user out", () => {
      // `relation` is null until the first server answer arrives. Failing closed
      // here would make the page read-only for a moment on every load.
      const state = planState(plan({ relation: null, pendingChanges: 5 }));
      expect(state.kind).toBe("LOCAL_AHEAD");
    });
  });

  /**
   * `canEdit: false` on the delegation. The relation on the wire is a plain
   * DELEGATE and the server strips the write capabilities underneath it, so the
   * ONLY signal is the write scope — which is why offering Publish on the
   * relation alone hands somebody a button that can only ever 403.
   */
  describe("a read-only delegation", () => {
    const viewOnly = { relation: "DELEGATE", writeScope: "NONE" } as const;

    it("is READ_ONLY even though the relation says DELEGATE", () => {
      const state = planState(plan(viewOnly));
      expect(state.kind).toBe("READ_ONLY");
      expect(state.action).toBeNull();
    });

    it("says the owner is still working on it, not that access is broken", () => {
      const state = planState(plan(viewOnly));
      expect(state.headline).toContain("look at");
      expect(state.detail).toContain("owner is still working");
    });

    it("still downloads — reading is the entire point of the grant", () => {
      const state = planState(plan({ ...viewOnly, serverVersion: 50, watermark: 42 }));
      expect(state.action).toBe("pull");
    });

    it("never offers publish, however much is pending locally", () => {
      // Reachable: the grant can be narrowed from editable to view-only while
      // the delegate has unpublished rows sitting on their machine.
      const state = planState(plan({ ...viewOnly, pendingChanges: 14 }));
      expect(state.kind).toBe("READ_ONLY");
      expect(state.action).not.toBe("publish");
    });

    it("leaves an ordinary delegate alone before ownership has been fetched", () => {
      // UNKNOWN is "not asked", not "nothing writable". Treating it as read-only
      // would accuse a working delegate of having lost their access.
      const state = planState(
        plan({ relation: "DELEGATE", writeScope: "UNKNOWN", pendingChanges: 5 })
      );
      expect(state.kind).toBe("LOCAL_AHEAD");
    });
  });

  /**
   * The relation formerly known as OU_MEMBER, which could read the plan filtered
   * to the caller's own departments. It can no longer read anything.
   */
  describe("a plan that is not shared with you", () => {
    const visitor = { relation: "OU_VISITOR", onThisComputer: false } as const;

    it("is NOT_SHARED rather than a read-only plan you happen to be behind on", () => {
      const state = planState(
        plan({ ...visitor, serverVersion: 50, watermark: 0, ownerEmail: "bob@example.com" })
      );
      expect(state.kind).toBe("NOT_SHARED");
      expect(state.action).toBe("request");
    });

    it("beats CLOUD_ONLY — 'download it' is the one thing that cannot happen", () => {
      const state = planState(plan(visitor));
      expect(state.kind).toBe("NOT_SHARED");
      expect(state.action).not.toBe("download");
    });

    it("names the owner, because asking them is the only way forward", () => {
      const state = planState(plan({ ...visitor, ownerEmail: "bob@example.com" }));
      expect(state.detail).toContain("bob@example.com");
      expect(state.detail).toContain("read-only");
    });

    it("does not count as needing attention", () => {
      // Every hotel with two budget owners has one of these permanently. Marking
      // it would leave the page's attention badge lit for ever.
      const state = planState(plan(visitor));
      expect(state.needsAttention).toBe(false);
      expect(state.tone).toBe("neutral");
    });

    it("yields to a lease and to a revocation, as every other state does", () => {
      expect(planState(plan(visitor), EXCLUSIVE).kind).toBe("LOCKED");
      expect(planState(plan({ ...visitor, revoked: {} })).kind).toBe("REVOKED");
    });

    describe("with a copy still on this computer", () => {
      // Only reachable with unpublished work in it: anything clean is purged by
      // the status call before the page is built.
      const frozen = {
        relation: "OU_VISITOR",
        onThisComputer: true,
        pendingChanges: 14,
        ownerEmail: "bob@example.com",
      } as const;

      it("leads with the work rather than with the lock", () => {
        const state = planState(plan(frozen));
        expect(state.kind).toBe("NOT_SHARED");
        expect(state.detail).toContain("14 changes");
        expect(state.detail).toContain("not lost");
      });

      it("offers nothing to press — download and publish are both refused", () => {
        expect(planState(plan(frozen)).action).toBeNull();
      });

      it("says a re-delegation makes the work publishable again", () => {
        // True, and load-bearing: the server stamps `override_base_until` on a
        // re-grant precisely so these rows still land.
        expect(planState(plan(frozen)).detail).toContain("delegate again");
      });

      it("does draw attention, unlike a colleague's plan you merely noticed", () => {
        expect(planState(plan(frozen)).needsAttention).toBe(true);
      });
    });
  });

  describe("the name clash", () => {
    it("points at the server's copy when it can actually be downloaded", () => {
      const state = planState(
        plan({ published: false, twinPlanId: "other-1", twinReadable: true })
      );
      expect(state.kind).toBe("NAME_TAKEN");
      expect(state.detail).toContain("Download");
    });

    it("says rename instead when the clashing plan is not shared with you", () => {
      // "Download the server's copy" is advice that cannot be followed, and
      // sending somebody to a locked tile to discover that is worse than saying
      // so here.
      const state = planState(
        plan({ published: false, twinPlanId: "other-1", twinReadable: false })
      );
      expect(state.kind).toBe("NAME_TAKEN");
      expect(state.detail).toContain("Rename");
      expect(state.detail).not.toContain("Download");
    });
  });
});
