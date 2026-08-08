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
    scopeKind: "FULL",
    departments: null,
    structureEditable: true,
    handbacksPending: 0,
    lastPublishedAt: "2026-08-01T10:00:00Z",
    lastPulledAt: "2026-08-01T10:00:00Z",
    pendingChanges: 0,
    revoked: null,
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

  describe("read-only relations", () => {
    it("names the administrator case, because it is the confusing one", () => {
      const state = planState(plan({ relation: "GLOBAL_ADMIN" }));
      expect(state.kind).toBe("READ_ONLY");
      expect(state.headline).toContain("not this plan's owner");
      expect(state.action).toBeNull();
    });

    it("still offers a download to a read-only member who is behind", () => {
      const state = planState(
        plan({ relation: "OU_MEMBER", serverVersion: 50, watermark: 42 })
      );
      expect(state.kind).toBe("READ_ONLY");
      expect(state.action).toBe("pull");
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
});
