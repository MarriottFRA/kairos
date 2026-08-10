/**
 * Who holds what, derived once so two screens cannot disagree.
 *
 * The cases worth pinning are the ones where the wrong answer is reassuring:
 * `stale` reading as "nobody holds anything", and a handed-back department
 * reading as still delegated (or vice versa) on the card that decides whether an
 * owner is told to go and download somebody's finished work.
 */

import { describe, expect, it } from "vitest";
import { delegationSummary, delegationSummaryEmpty } from "../delegationSummary";
import type { DepartmentOwnership } from "../protocol";

function ownership(
  relation: "OWNER" | "DELEGATE",
  rows: DepartmentOwnership["departments"]
): DepartmentOwnership {
  return {
    planId: "plan-1",
    planVersion: 42,
    authzVersion: 7,
    me: { relation, scopeKind: relation === "OWNER" ? "FULL" : "PARTIAL" },
    structureEditableByMe: relation === "OWNER",
    departments: rows,
  };
}

/** Editing unless told otherwise — the default every case here was written for. */
const holder = (
  email: string,
  state: "ACTIVE" | "HANDED_BACK",
  canEdit = true
) => ({
  userId: 42,
  email,
  delegationId: "del-1",
  state,
  canEdit,
});

describe("delegationSummary", () => {
  it("is stale — not empty — when the ownership call has never run", () => {
    // The distinction is the whole point: every list being empty because it is
    // UNKNOWN must not render as "nobody holds anything", which is the more
    // reassuring reading and the wrong one.
    const summary = delegationSummary(null);
    expect(summary.stale).toBe(true);
    expect(summary.delegatedOut).toHaveLength(0);
    expect(delegationSummaryEmpty(summary)).toBe(true);
  });

  it("splits an owner's departments by holder state", () => {
    const summary = delegationSummary(
      ownership("OWNER", [
        {
          code: "D0410",
          readable: true,
          writable: false,
          reason: "DELEGATED",
          assignedTo: [holder("alice@example.com", "ACTIVE")],
        },
        // Writable, and with no reason. This fixture used to model
        // `writable: false, reason: "HANDED_BACK"` on an OWNER's answer — a
        // state the guide forbids, since `writable` flips back the moment the
        // last ACTIVE holder goes and `HANDED_BACK` as a reason is what the
        // DELEGATE is told. It passed, because this function reads only
        // `assignedTo` for an owner, so the wrong belief sat here uncaught and
        // any code written against it would have been written against a
        // fiction. See `ownershipContradiction`, which now detects the shape.
        {
          code: "D0610",
          readable: true,
          writable: true,
          reason: null,
          assignedTo: [holder("bob@example.com", "HANDED_BACK")],
        },
        { code: "D0710", readable: true, writable: true, reason: null, assignedTo: [] },
      ])
    );

    expect(summary.stale).toBe(false);
    expect(summary.delegatedOut).toEqual([
      { code: "D0410", email: "alice@example.com", delegationId: "del-1" },
    ]);
    // Derived from the HOLDER STATE, not from `writable` — which is what makes
    // the corrected fixture safe: a handed-back department the owner can once
    // again edit is still a handback, and still their cue to download.
    expect(summary.handedBack).toEqual([
      { code: "D0610", email: "bob@example.com", delegationId: "del-1" },
    ]);
    // An owner is never their own delegate, whatever the holder list says.
    expect(summary.mine).toHaveLength(0);
  });

  it("puts a read-only holder in readOnly, not delegatedOut", () => {
    // `delegatedOut` means "out of the owner's hands", and a read-only holder
    // displaces nobody — the department stays writable and a publish still
    // sends it. Reading them as delegated is what had the publish assurance
    // line telling an owner their whole plan was somebody else's.
    const summary = delegationSummary(
      ownership("OWNER", [
        {
          code: "D0410",
          readable: true,
          writable: true,
          reason: null,
          assignedTo: [holder("alice@example.com", "ACTIVE", false)],
        },
      ])
    );

    expect(summary.delegatedOut).toHaveLength(0);
    expect(summary.readOnly).toEqual([
      { code: "D0410", email: "alice@example.com", delegationId: "del-1" },
    ]);
    // Still SOMEBODY, though. This is the count the card gates its "nobody else
    // is working on this plan" empty state on, and after an ownership handover
    // the outgoing owner is exactly this holder.
    expect(delegationSummaryEmpty(summary)).toBe(false);
  });

  it("reads a holder with no canEdit flag as editing", () => {
    // The safe default against a server that predates the field: it can only
    // over-report who holds something, never unlock a department the server
    // locked.
    const summary = delegationSummary(
      ownership("OWNER", [
        {
          code: "D0410",
          readable: true,
          writable: false,
          reason: "DELEGATED",
          assignedTo: [
            { userId: 42, email: "alice@example.com", delegationId: "del-1", state: "ACTIVE" },
          ] as DepartmentOwnership["departments"][number]["assignedTo"],
        },
      ])
    );

    expect(summary.delegatedOut).toHaveLength(1);
    expect(summary.readOnly).toHaveLength(0);
  });

  it("separates the two holders of one department by whether they hold the pen", () => {
    // The state right after a handover on a plan that already had a delegate:
    // the existing delegate survives intact, and the previous owner is added
    // read-only alongside them.
    const summary = delegationSummary(
      ownership("OWNER", [
        {
          code: "D0410",
          readable: true,
          writable: false,
          reason: "DELEGATED",
          assignedTo: [
            holder("carol@example.com", "ACTIVE"),
            holder("previous.owner@example.com", "ACTIVE", false),
          ],
        },
      ])
    );

    expect(summary.delegatedOut).toEqual([
      { code: "D0410", email: "carol@example.com", delegationId: "del-1" },
    ]);
    expect(summary.readOnly).toEqual([
      { code: "D0410", email: "previous.owner@example.com", delegationId: "del-1" },
    ]);
  });

  it("counts one department held twice in two different states", () => {
    // A re-grant after a handback leaves both rows on the department. Both are
    // real and the owner needs to see both.
    const summary = delegationSummary(
      ownership("OWNER", [
        {
          code: "D0410",
          readable: true,
          writable: false,
          reason: "DELEGATED",
          assignedTo: [
            holder("alice@example.com", "HANDED_BACK"),
            holder("carol@example.com", "ACTIVE"),
          ],
        },
      ])
    );

    expect(summary.delegatedOut).toHaveLength(1);
    expect(summary.handedBack).toHaveLength(1);
  });

  it("derives a delegate's own side from writable, never from the holder list", () => {
    // `assignedTo` has userId and email and neither answers "is that me". There
    // is no cheap current-user id on the sync surface, and matching on email
    // fails silently when a login address differs from the granted one.
    const summary = delegationSummary(
      ownership("DELEGATE", [
        {
          code: "D0410",
          readable: true,
          writable: true,
          reason: null,
          assignedTo: [holder("someone.else@example.com", "ACTIVE")],
        },
        {
          code: "D0610",
          readable: true,
          writable: false,
          reason: "HANDED_BACK",
          assignedTo: [],
        },
        {
          code: "D0710",
          readable: true,
          writable: false,
          reason: "NOT_IN_WRITE_SCOPE",
          assignedTo: [],
        },
      ])
    );

    expect(summary.mine).toEqual(["D0410"]);
    // Only HANDED_BACK counts as "I gave this back". NOT_IN_WRITE_SCOPE is a
    // department they were never given.
    expect(summary.myHandedBack).toEqual(["D0610"]);
  });

  it("reports nothing worth drawing on a plan with no delegations", () => {
    const summary = delegationSummary(
      ownership("OWNER", [
        { code: "D0410", readable: true, writable: true, reason: null, assignedTo: [] },
      ])
    );
    expect(summary.stale).toBe(false);
    expect(delegationSummaryEmpty(summary)).toBe(true);
  });
});
