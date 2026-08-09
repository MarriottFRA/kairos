/**
 * When the write scope disagrees with itself.
 *
 * This predicate is the only thing standing between an owner and a permanent
 * lock on a department nobody holds: a handback happens on the delegate's
 * machine, so the ETag is the owner's only correction path, and if it does not
 * fold delegation state they are answered 304 for ever. Catching the
 * contradiction is what buys the one unconditional re-ask that settles it.
 *
 * Both halves matter equally. A predicate that misses the real case leaves the
 * lock in place; a predicate that fires on a correct lock spends a request on
 * every window focus, for ever, to hear the same answer.
 */

import { describe, expect, it } from "vitest";
import {
  contradictoryDepartments,
  ownershipContradicted,
} from "../ownershipContradiction";
import type {
  DelegatedHolder,
  DepartmentOwnership,
  DepartmentOwnershipRow,
  Relation,
} from "../protocol";

const holder = (state: DelegatedHolder["state"]): DelegatedHolder => ({
  userId: 7,
  email: "bob@example.com",
  delegationId: "del-1",
  state,
});

function ownership(
  relation: Relation,
  rows: Array<Partial<DepartmentOwnershipRow> & { code: string }>
): DepartmentOwnership {
  return {
    planId: "plan-1",
    planVersion: 42,
    authzVersion: 7,
    me: { relation, scopeKind: "FULL" },
    structureEditableByMe: relation !== "DELEGATE",
    departments: rows.map(
      (row): DepartmentOwnershipRow => ({
        readable: true,
        writable: false,
        reason: null,
        assignedTo: [] as DelegatedHolder[],
        ...row,
      })
    ),
  };
}

describe("contradictoryDepartments", () => {
  it("says nothing about an answer that has never arrived", () => {
    expect(contradictoryDepartments(null)).toEqual([]);
    expect(ownershipContradicted(undefined)).toBe(false);
  });

  it("names a HANDED_BACK department the owner is refused", () => {
    // The shape the guide forbids: `writable` should have flipped back to true
    // and `reason` to null the moment the last ACTIVE holder went.
    const result = contradictoryDepartments(
      ownership("OWNER", [
        { code: "D0610", reason: "HANDED_BACK", assignedTo: [holder("HANDED_BACK")] },
      ])
    );
    expect(result).toEqual(["D0610"]);
  });

  it("names a DELEGATED department with nobody holding it", () => {
    // The reason states a holder and the holder list has none. Either the reason
    // is stale or the list is; either way it cannot be acted on as given.
    expect(
      contradictoryDepartments(
        ownership("OWNER", [{ code: "D0410", reason: "DELEGATED", assignedTo: [] }])
      )
    ).toEqual(["D0410"]);
  });

  it("accepts a department somebody is actually holding", () => {
    expect(
      ownershipContradicted(
        ownership("OWNER", [
          { code: "D0410", reason: "DELEGATED", assignedTo: [holder("ACTIVE")] },
        ])
      )
    ).toBe(false);
  });

  it("accepts a re-grant after a handback, where both holder rows survive", () => {
    // One ACTIVE holder is enough to justify the lock, however many handed-back
    // rows sit beside it.
    expect(
      ownershipContradicted(
        ownership("OWNER", [
          {
            code: "D0410",
            reason: "DELEGATED",
            assignedTo: [holder("HANDED_BACK"), holder("ACTIVE")],
          },
        ])
      )
    ).toBe(false);
  });

  it("accepts a degraded owner whose hotel access shrank", () => {
    // NOT_IN_WRITE_SCOPE with no holders is legitimate here, and deliberately
    // not treated as a contradiction: firing on it would buy a request per focus
    // to re-confirm a lock that is correct.
    expect(
      ownershipContradicted(
        ownership("OWNER_DEGRADED", [
          { code: "D0410", reason: "NOT_IN_WRITE_SCOPE", assignedTo: [] },
        ])
      )
    ).toBe(false);
  });

  it("says nothing about a delegate's own answer", () => {
    // HANDED_BACK is exactly what a delegate should be told about their own lost
    // write access — the reason is written for them. Every delegate-side answer
    // is silent here, whatever it says.
    expect(
      ownershipContradicted(
        ownership("DELEGATE", [
          { code: "D0610", reason: "HANDED_BACK", assignedTo: [holder("HANDED_BACK")] },
          { code: "D0710", reason: "DELEGATED", assignedTo: [] },
          { code: "D0810", reason: "NOT_IN_WRITE_SCOPE", assignedTo: [] },
        ])
      )
    ).toBe(false);
  });

  it("says nothing about a GLOBAL_ADMIN, who writes nothing by design", () => {
    expect(
      ownershipContradicted(
        ownership("GLOBAL_ADMIN", [
          { code: "D0610", reason: "HANDED_BACK", assignedTo: [holder("HANDED_BACK")] },
        ])
      )
    ).toBe(false);
  });

  it("ignores departments the owner can write", () => {
    expect(
      contradictoryDepartments(
        ownership("OWNER", [
          { code: "D0610", writable: true, reason: null, assignedTo: [holder("HANDED_BACK")] },
        ])
      )
    ).toEqual([]);
  });

  it("holds for a lease holder too, who is the plan's side while the lease lasts", () => {
    expect(
      contradictoryDepartments(
        ownership("ADMIN_LEASE", [
          { code: "D0610", reason: "HANDED_BACK", assignedTo: [holder("HANDED_BACK")] },
        ])
      )
    ).toEqual(["D0610"]);
  });
});
