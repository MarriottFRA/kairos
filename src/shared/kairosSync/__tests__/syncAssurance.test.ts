/**
 * The card's pre-click reassurance.
 *
 * The case worth pinning hardest: a handed-back department must DROP OUT of the
 * publish line, because the owner has regained write there and an ordinary
 * publish will now overwrite what the delegate published. A line that kept
 * naming it would be reassuring and wrong.
 */

import { describe, expect, it } from "vitest";
import { syncAssurance } from "../syncAssurance";
import { PlanSyncStatus } from "../ipc";
import { PlanDelegationSummary } from "../delegationSummary";

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
    delegation: null,
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

function summary(overrides: Partial<PlanDelegationSummary> = {}): PlanDelegationSummary {
  return {
    delegatedOut: [],
    handedBack: [],
    mine: [],
    myHandedBack: [],
    stale: false,
    ...overrides,
  };
}

const HELD = (code: string, email = "bob@example.com") => ({
  code,
  email,
  delegationId: "d-1",
});

describe("syncAssurance — the download line", () => {
  it("says nothing when there is no unpublished work to be anxious about", () => {
    expect(syncAssurance(plan({ pendingChanges: 0 }), summary()).download).toBeNull();
  });

  it("promises the review rather than the outcome", () => {
    const line = syncAssurance(plan({ pendingChanges: 8 }), summary()).download;
    expect(line).toContain("merges");
    expect(line).toContain("before it happens");
    // The card cannot know `collides` until the preview runs, so it must not
    // claim nothing is replaced.
    expect(line).not.toMatch(/nothing .*replace/i);
  });

  it("is withheld on a plan that was never published", () => {
    expect(
      syncAssurance(plan({ published: false, pendingChanges: 162 }), summary()).download
    ).toBeNull();
  });
});

describe("syncAssurance — the publish line, as an owner", () => {
  it("names the departments currently delegated out", () => {
    const line = syncAssurance(
      plan(),
      summary({ delegatedOut: [HELD("ROOMS"), HELD("FB")] })
    ).publish;
    expect(line).toContain("your departments only");
    expect(line).toContain("FB and ROOMS");
    expect(line).toContain("stay theirs");
  });

  it("uses the singular for one department", () => {
    const line = syncAssurance(plan(), summary({ delegatedOut: [HELD("ROOMS")] })).publish;
    expect(line).toContain("ROOMS stays theirs");
  });

  it("caps the names and counts the rest", () => {
    const line = syncAssurance(
      plan(),
      summary({
        delegatedOut: [HELD("ROOMS"), HELD("FB"), HELD("SPA"), HELD("GOLF")],
      })
    ).publish;
    expect(line).toContain("and 2 more");
  });

  it("does not repeat a department two people were given", () => {
    const line = syncAssurance(
      plan(),
      summary({ delegatedOut: [HELD("ROOMS", "a@x.com"), HELD("ROOMS", "b@x.com")] })
    ).publish;
    expect(line).toContain("ROOMS stays theirs");
    expect(line).not.toContain("and 1 more");
  });

  it("DROPS a handed-back department — the owner can overwrite it again", () => {
    // The whole point of reading `delegatedOut` and never `handedBack`.
    const line = syncAssurance(
      plan(),
      summary({ delegatedOut: [HELD("FB")], handedBack: [HELD("ROOMS")] })
    ).publish;
    expect(line).toContain("FB stays theirs");
    expect(line).not.toContain("ROOMS");
  });

  it("says nothing once everything has been handed back", () => {
    expect(
      syncAssurance(plan(), summary({ handedBack: [HELD("ROOMS")] })).publish
    ).toBeNull();
  });

  it("says nothing when nobody holds anything", () => {
    expect(syncAssurance(plan(), summary()).publish).toBeNull();
  });

  it("says nothing while ownership is unknown, rather than implying no delegation", () => {
    expect(syncAssurance(plan(), summary({ stale: true })).publish).toBeNull();
    expect(syncAssurance(plan(), null).publish).toBeNull();
  });
});

describe("syncAssurance — the publish line, as a delegate", () => {
  it("reassures a delegate that the rest of the plan is untouched", () => {
    const line = syncAssurance(
      plan({ relation: "DELEGATE", writeScope: "PARTIAL", scopeKind: "PARTIAL" }),
      summary({ mine: ["ROOMS"] })
    ).publish;
    expect(line).toContain("your departments only");
  });

  it("is withheld for a view-only share, where there is no Publish button", () => {
    expect(
      syncAssurance(
        plan({ relation: "DELEGATE", writeScope: "NONE" }),
        summary({ myHandedBack: ["ROOMS"] })
      ).publish
    ).toBeNull();
  });

  it("is withheld for a reader who is not a delegate at all", () => {
    expect(
      syncAssurance(plan({ relation: "GLOBAL_ADMIN", writeScope: "NONE" }), summary()).publish
    ).toBeNull();
  });
});
