/**
 * One delegation, one sentence — and the precedence that decides which sentence.
 *
 * The cases worth pinning are the ones where a true statement is the wrong one
 * to lead with: telling an owner somebody is "working now" on a grant the server
 * has stopped honouring, or reporting presence over a handback that is sitting
 * on the server waiting to be collected. Both read as "all is well" and both
 * cost the owner the one action they needed to take.
 */

import { describe, expect, it } from "vitest";
import { delegationCardState } from "../delegationCardState";
import type { ActivityEntry, Delegation, DelegationDepartment } from "../protocol";

function delegation(overrides: Partial<Delegation> = {}): Delegation {
  const departments: DelegationDepartment[] = overrides.departments ?? [
    { code: "ROOMS", state: "ACTIVE", handedBackAt: null, handedBackNote: null },
  ];
  return {
    id: "del-1",
    delegateUserId: 42,
    delegateEmail: "bob@example.com",
    grantedAt: "2026-08-01T09:00:00Z",
    expiresAt: null,
    canEdit: true,
    canAddRows: true,
    canDeleteRows: false,
    canReadPii: true,
    generation: 1,
    requestedDepartments: departments.map((department) => department.code),
    effectiveDepartments: departments.map((department) => department.code),
    effective: true,
    reason: null,
    ...overrides,
    departments,
  };
}

const handedBack = (code: string): DelegationDepartment => ({
  code,
  state: "HANDED_BACK",
  handedBackAt: "2026-08-09T07:00:00Z",
  handedBackNote: "Done with this one",
});

const active = (code: string): DelegationDepartment => ({
  code,
  state: "ACTIVE",
  handedBackAt: null,
  handedBackNote: null,
});

const presence = (dirtyEntities: number): ActivityEntry => ({
  userId: 42,
  email: "bob@example.com",
  departments: ["ROOMS"],
  dirtyEntities,
  seenAt: "2026-08-09T08:00:00Z",
});

describe("delegationCardState", () => {
  it("leads with the reason a grant is not in effect", () => {
    const state = delegationCardState(
      delegation({ effective: false, reason: "OU_ACCESS_REVOKED" }),
      null
    );
    expect(state.tone).toBe("blocked");
    expect(state.headline).toBe("Their access to this hotel was removed");
  });

  it("falls back to a plain sentence when the server sends no reason", () => {
    // `reason` is nullable on the wire and an unrecognised code must not render
    // as an empty headline next to a red dot.
    const state = delegationCardState(delegation({ effective: false, reason: null }), null);
    expect(state.headline).toBe("This delegation is not in effect");
  });

  it("says everything is back when every department has been returned", () => {
    const state = delegationCardState(
      delegation({ departments: [handedBack("ROOMS"), handedBack("FB")] }),
      null
    );
    expect(state.tone).toBe("attention");
    expect(state.headline).toBe("Handed everything back — ready to download");
    expect(state.collectable).toBe(true);
  });

  it("names the departments when only some have come back", () => {
    const state = delegationCardState(
      delegation({ departments: [handedBack("ROOMS"), active("FB")] }),
      null
    );
    expect(state.headline).toBe("Handed back ROOMS — ready to download");
    expect(state.collectable).toBe(true);
  });

  it("summarises a long handback list rather than running off the card", () => {
    const state = delegationCardState(
      delegation({
        departments: [
          handedBack("ROOMS"),
          handedBack("FB"),
          handedBack("SPA"),
          handedBack("ENG"),
          active("HR"),
        ],
      }),
      null
    );
    expect(state.headline).toBe("Handed back ROOMS, FB and 2 more — ready to download");
  });

  it("reports unpublished work, because that is what a withdrawal would strand", () => {
    const state = delegationCardState(delegation(), presence(3));
    expect(state.tone).toBe("attention");
    expect(state.headline).toBe("Working now · 3 unpublished changes");
    expect(state.collectable).toBe(false);
  });

  it("counts one change in the singular", () => {
    const state = delegationCardState(delegation(), presence(1));
    expect(state.headline).toBe("Working now · 1 unpublished change");
  });

  it("is quietly good when they are present with nothing outstanding", () => {
    const state = delegationCardState(delegation(), presence(0));
    expect(state.tone).toBe("good");
    expect(state.headline).toBe("Working now");
  });

  it("describes a view-only grant as what it is", () => {
    const state = delegationCardState(delegation({ canEdit: false }), null);
    expect(state.tone).toBe("neutral");
    expect(state.headline).toBe("Can look, cannot change anything");
  });

  it("says Editing when there is nothing else to say", () => {
    const state = delegationCardState(delegation(), null);
    expect(state.tone).toBe("good");
    expect(state.headline).toBe("Editing");
  });

  // ---------------------------------------------------------- precedence

  it("ineffective outranks a handback", () => {
    // The work described by a handback on a dead grant cannot be published, so
    // "ready to download" would send the owner to fetch something that is not
    // coming. `collectable` stays true — the departments really are back.
    const state = delegationCardState(
      delegation({
        effective: false,
        reason: "EXPIRED",
        departments: [handedBack("ROOMS")],
      }),
      presence(4)
    );
    expect(state.tone).toBe("blocked");
    expect(state.headline).toBe("This delegation has expired");
    expect(state.collectable).toBe(true);
  });

  it("a handback outranks presence", () => {
    // "They are typing" is a thing to know; "you can collect this" is a thing to
    // do, and the card has room for one headline.
    const state = delegationCardState(
      delegation({ departments: [handedBack("ROOMS"), active("FB")] }),
      presence(2)
    );
    expect(state.headline).toBe("Handed back ROOMS — ready to download");
  });

  it("presence outranks view-only", () => {
    const state = delegationCardState(delegation({ canEdit: false }), presence(0));
    expect(state.headline).toBe("Working now");
  });

  // ------------------------------------------------- already collected

  it("stops offering the download once the work is on this computer", () => {
    // The bug this closes: a handback stands until the owner reopens the
    // department, so the card kept saying "ready to download" after the
    // download — and pressing it produced a dialog with nothing in it and no
    // way forward.
    const state = delegationCardState(
      delegation({ departments: [handedBack("ROOMS"), active("FB")] }),
      null,
      { serverAhead: false }
    );
    expect(state.collectable).toBe(false);
    expect(state.tone).toBe("neutral");
    expect(state.headline).toBe("Handed back ROOMS — you already have their work");
  });

  it("says the same about a delegation that handed everything back", () => {
    const state = delegationCardState(
      delegation({ departments: [handedBack("ROOMS"), handedBack("FB")] }),
      null,
      { serverAhead: false }
    );
    expect(state.collectable).toBe(false);
    expect(state.headline).toBe("Handed everything back — you already have their work");
  });

  it("offers it again the moment they publish something new", () => {
    const state = delegationCardState(
      delegation({ departments: [handedBack("ROOMS")] }),
      null,
      { serverAhead: true }
    );
    expect(state.collectable).toBe(true);
    expect(state.headline).toBe("Handed everything back — ready to download");
  });

  it("keeps offering the download when the caller cannot tell", () => {
    // Unknown must not read as collected. Offering a download that turns out to
    // be empty costs a dialog; hiding one that was not costs the work.
    const state = delegationCardState(delegation({ departments: [handedBack("ROOMS")] }), null);
    expect(state.collectable).toBe(true);
  });

  it("what they are doing now outranks a handback already collected", () => {
    // Reversed from the uncollected case on purpose: "you can collect this" is
    // a thing to do and outranks presence, but "you have collected this" is not.
    const state = delegationCardState(
      delegation({ departments: [handedBack("ROOMS"), active("FB")] }),
      presence(2),
      { serverAhead: false }
    );
    expect(state.headline).toBe("Working now · 2 unpublished changes");
    expect(state.collectable).toBe(false);
  });
});
