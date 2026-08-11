/**
 * When a delta stops being a complete answer.
 *
 * The cases worth pinning down are the asymmetric ones: this must fire for a
 * scope that grew and stay silent for one that shrank, was re-ordered, or is
 * simply unknown — because firing is a full re-download of the whole plan and
 * doing that speculatively on every card at every hotel is worse than the bug.
 */

import { describe, expect, it } from "vitest";
import { readScopeWidened } from "../scopeWidening";

describe("readScopeWidened", () => {
  it("fires when a partial scope becomes full", () => {
    // The reported bug: a delegate holding one department is made the plan's
    // owner. Every counter says level; most of the plan is missing.
    expect(
      readScopeWidened(
        { scopeKind: "PARTIAL", scopeDepartments: ["D0010"] },
        { scopeKind: "FULL", departments: null }
      )
    ).toBe(true);
  });

  it("fires on a partial scope that gained a department", () => {
    expect(
      readScopeWidened(
        { scopeKind: "PARTIAL", scopeDepartments: ["D0010"] },
        { scopeKind: "PARTIAL", departments: ["D0010", "D0610"] }
      )
    ).toBe(true);
  });

  it("fires when one department is swapped for another", () => {
    // Same length on both sides, and rows we have never seen are now readable.
    // A count comparison would miss this, which is why the check is a subset
    // test rather than an arithmetic one.
    expect(
      readScopeWidened(
        { scopeKind: "PARTIAL", scopeDepartments: ["D0010"] },
        { scopeKind: "PARTIAL", departments: ["D0610"] }
      )
    ).toBe(true);
  });

  it("is silent when the scope is unchanged, however it is ordered", () => {
    expect(
      readScopeWidened(
        { scopeKind: "PARTIAL", scopeDepartments: ["D0610", "D0010"] },
        { scopeKind: "PARTIAL", departments: ["D0010", "D0610"] }
      )
    ).toBe(false);
  });

  it("is silent on a NARROWING, which needs no download", () => {
    // Losing a department is already handled: the server refuses the rows and
    // the local copy is deliberately left alone so the work is not lost. There
    // is nothing on the server to fetch.
    expect(
      readScopeWidened(
        { scopeKind: "PARTIAL", scopeDepartments: ["D0010", "D0610"] },
        { scopeKind: "PARTIAL", departments: ["D0010"] }
      )
    ).toBe(false);
  });

  it("is silent for an owner, which is the steady state of every probe", () => {
    expect(
      readScopeWidened(
        { scopeKind: "FULL", scopeDepartments: null },
        { scopeKind: "FULL", departments: null }
      )
    ).toBe(false);
  });

  it("never treats a full scope as widenable, even offered a list", () => {
    expect(
      readScopeWidened(
        { scopeKind: "FULL", scopeDepartments: null },
        { scopeKind: "PARTIAL", departments: ["D0010"] }
      )
    ).toBe(false);
  });

  it("is silent when we never recorded a scope", () => {
    // The ordinary state of a plan pulled by a build predating the column.
    // Guessing here would full-pull every plan on the machine the first time
    // somebody opened the Sync page after upgrading.
    expect(
      readScopeWidened(
        { scopeKind: null, scopeDepartments: null },
        { scopeKind: "FULL", departments: null }
      )
    ).toBe(false);
  });

  it("is silent when the offered scope is withheld", () => {
    // An `OU_VISITOR` head nulls everything describing the plan's contents.
    // That plan is about to be purged from this machine, not downloaded.
    expect(
      readScopeWidened(
        { scopeKind: "PARTIAL", scopeDepartments: ["D0010"] },
        { scopeKind: null, departments: null }
      )
    ).toBe(false);
  });

  it("is silent when either partial list is missing", () => {
    // `ScopeReport` documents a null list as "all departments", which cannot
    // occur beside PARTIAL — so it means the list was not recorded, and an
    // unrecorded list proves nothing in either direction.
    expect(
      readScopeWidened(
        { scopeKind: "PARTIAL", scopeDepartments: null },
        { scopeKind: "PARTIAL", departments: ["D0010"] }
      )
    ).toBe(false);
    expect(
      readScopeWidened(
        { scopeKind: "PARTIAL", scopeDepartments: ["D0010"] },
        { scopeKind: "PARTIAL", departments: null }
      )
    ).toBe(false);
  });

  it("is silent with no state row and no head", () => {
    expect(readScopeWidened(null, { scopeKind: "FULL", departments: null })).toBe(false);
    expect(
      readScopeWidened({ scopeKind: "PARTIAL", scopeDepartments: [] }, null)
    ).toBe(false);
    expect(readScopeWidened(null, null)).toBe(false);
  });
});
