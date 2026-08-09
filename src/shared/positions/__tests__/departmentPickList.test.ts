/**
 * What the Department picker may offer.
 *
 * The bug this exists to stop: the picker offered every department in the
 * hotel's reference data, so a delegate could choose one they did not hold and
 * lock themselves out of the row they were editing — instantly, and with no way
 * back, because the lock covered the picker too.
 *
 * The two rules that are easy to get backwards:
 *
 * - A **delegate** should see what they hold, and nothing they have no business
 *   knowing about. Thirty departments narrowed to three.
 * - An **owner** should see everything EXCEPT what they have delegated away.
 *   Narrowing them to what `/department-ownership` enumerates would be a
 *   regression — a department nobody has put a row in yet must stay assignable.
 */

import { describe, expect, it } from "vitest";
import { departmentPickList } from "../departmentPickList";
import type { DepartmentOption } from "../../mappingTables/types";
import type { DepartmentOwnership } from "../../kairosSync/protocol";

const ALL: DepartmentOption[] = [
  { code: "D0410", name: "Rooms" },
  { code: "D0610", name: "Food & Beverage" },
  { code: "D0710", name: "Spa" },
  // In the reference data and unknown to the server — the new-outlet case.
  { code: "D0910", name: "Retail" },
];

function ownership(
  scopeKind: "FULL" | "PARTIAL",
  relation: "OWNER" | "DELEGATE",
  rows: Array<{ code: string; readable: boolean; writable: boolean; reason?: string }>
): DepartmentOwnership {
  return {
    planId: "plan-1",
    planVersion: 42,
    authzVersion: 7,
    me: { relation, scopeKind },
    structureEditableByMe: relation === "OWNER",
    departments: rows.map(
      (row): DepartmentOwnership["departments"][number] => ({
        code: row.code,
        readable: row.readable,
        writable: row.writable,
        reason: (row.reason ?? null) as never,
        assignedTo: [],
      })
    ),
  };
}

describe("departmentPickList", () => {
  it("offers everything when the plan was never published", () => {
    const picks = departmentPickList(ALL, null, null);
    expect(picks.selectable).toHaveLength(4);
    expect(picks.locked).toHaveLength(0);
  });

  it("narrows a delegate to what they hold, and greys what they may read", () => {
    const picks = departmentPickList(
      ALL,
      ownership("PARTIAL", "DELEGATE", [
        { code: "D0410", readable: true, writable: true },
        { code: "D0610", readable: true, writable: false, reason: "HANDED_BACK" },
      ]),
      "PARTIAL"
    );

    expect(picks.selectable.map((option) => option.code)).toEqual(["D0410"]);
    expect(picks.locked.map((option) => option.code)).toEqual(["D0610"]);
    expect(picks.locked[0].reason).toBe("Handed back to the owner");
    // Spa and Retail are neither readable nor writable for them. Listing those
    // would hand somebody scoped to one department the shape of the whole hotel.
    expect(picks.selectable.some((option) => option.code === "D0710")).toBe(false);
    expect(picks.locked.some((option) => option.code === "D0710")).toBe(false);
  });

  it("subtracts only what an owner has delegated away", () => {
    const picks = departmentPickList(
      ALL,
      ownership("FULL", "OWNER", [
        { code: "D0410", readable: true, writable: false, reason: "DELEGATED" },
        { code: "D0610", readable: true, writable: true },
        { code: "D0710", readable: true, writable: true },
      ]),
      "FULL"
    );

    expect(picks.locked.map((option) => option.code)).toEqual(["D0410"]);
    expect(picks.locked[0].reason).toBe("Delegated — withdraw it to edit this yourself");
    // Retail is in the reference data and unknown to the server. An owner opening
    // a new outlet must still be able to assign to it.
    expect(picks.selectable.map((option) => option.code)).toEqual([
      "D0610",
      "D0710",
      "D0910",
    ]);
  });

  it("offers nothing to a revoked delegate but still explains what it can see", () => {
    const picks = departmentPickList(
      ALL,
      ownership("PARTIAL", "DELEGATE", [
        { code: "D0410", readable: true, writable: false, reason: "HANDED_BACK" },
      ]),
      "PARTIAL"
    );

    expect(picks.selectable).toHaveLength(0);
    expect(picks.locked.map((option) => option.code)).toEqual(["D0410"]);
  });

  it("falls back to the reason code rather than an empty string", () => {
    const picks = departmentPickList(
      ALL,
      ownership("FULL", "OWNER", [
        { code: "D0410", readable: true, writable: false, reason: "SOMETHING_NEW" },
      ]),
      "FULL"
    );
    // The code itself, which is not a sentence but is the one thing that lets a
    // support call name what the server actually said. This used to flatten to
    // "Not yours to edit", against the intent this test's own title states.
    expect(picks.locked[0].reason).toBe("SOMETHING_NEW");
  });

  it("words HANDED_BACK for whoever is being refused", () => {
    // The same reason code, the two sides of the grant. "Handed back to the
    // owner" is a complete explanation on the delegate's screen and a
    // contradiction on the owner's, next to a chip saying they cannot edit it.
    const delegate = departmentPickList(
      ALL,
      ownership("PARTIAL", "DELEGATE", [
        { code: "D0410", readable: true, writable: true },
        { code: "D0610", readable: true, writable: false, reason: "HANDED_BACK" },
      ]),
      "PARTIAL"
    );
    expect(delegate.locked[0].reason).toBe("Handed back to the owner");

    const owner = departmentPickList(
      ALL,
      ownership("FULL", "OWNER", [
        { code: "D0410", readable: true, writable: false, reason: "HANDED_BACK" },
        { code: "D0610", readable: true, writable: true },
      ]),
      "FULL"
    );
    expect(owner.locked[0].reason).toContain("Handed back to you");
    expect(owner.locked[0].reason).toContain("withdraw the delegation");
  });
});
