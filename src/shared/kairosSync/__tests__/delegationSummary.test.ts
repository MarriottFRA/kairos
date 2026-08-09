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

const holder = (email: string, state: "ACTIVE" | "HANDED_BACK") => ({
  userId: 42,
  email,
  delegationId: "del-1",
  state,
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
        {
          code: "D0610",
          readable: true,
          writable: false,
          reason: "HANDED_BACK",
          assignedTo: [holder("bob@example.com", "HANDED_BACK")],
        },
        { code: "D0710", readable: true, writable: true, reason: null, assignedTo: [] },
      ])
    );

    expect(summary.stale).toBe(false);
    expect(summary.delegatedOut).toEqual([
      { code: "D0410", email: "alice@example.com", delegationId: "del-1" },
    ]);
    expect(summary.handedBack).toEqual([
      { code: "D0610", email: "bob@example.com", delegationId: "del-1" },
    ]);
    // An owner is never their own delegate, whatever the holder list says.
    expect(summary.mine).toHaveLength(0);
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
