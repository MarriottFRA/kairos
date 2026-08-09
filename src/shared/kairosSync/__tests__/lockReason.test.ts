/**
 * A reason is written for whoever is being refused.
 *
 * `HANDED_BACK` shown to the delegate is a complete explanation of their own
 * lost write access. Shown to the OWNER it says the department was handed back
 * to them, next to a chip saying they cannot edit it — a contradiction rather
 * than an explanation, and the wording somebody would screenshot while asking
 * what the app means.
 */

import { describe, expect, it } from "vitest";
import { lockReasonText, lockReasonsByDepartment } from "../lockReason";
import type { DepartmentOwnership, Relation } from "../protocol";

function ownership(
  relation: Relation,
  rows: Array<{
    code: string;
    readable?: boolean;
    writable?: boolean;
    reason?: string | null;
  }>
): DepartmentOwnership {
  return {
    planId: "plan-1",
    planVersion: 42,
    authzVersion: 7,
    me: { relation, scopeKind: "FULL" },
    structureEditableByMe: relation !== "DELEGATE",
    departments: rows.map(
      (row): DepartmentOwnership["departments"][number] => ({
        code: row.code,
        readable: row.readable ?? true,
        writable: row.writable ?? false,
        reason: (row.reason ?? null) as never,
        assignedTo: [],
      })
    ),
  };
}

describe("lockReasonText", () => {
  it("never shows an owner the delegate's HANDED_BACK sentence", () => {
    expect(lockReasonText("HANDED_BACK", "DELEGATE")).toBe("Handed back to the owner");
    for (const relation of ["OWNER", "OWNER_DEGRADED", "ADMIN_LEASE"]) {
      const text = lockReasonText("HANDED_BACK", relation);
      expect(text).not.toBe("Handed back to the owner");
      expect(text).toContain("Handed back to you");
      // And it names the one reclaim the protocol offers: PATCH amends flags,
      // expiry and note, never the department list.
      expect(text).toContain("withdraw the delegation");
    }
  });

  it("points an owner at withdrawal for a department that is genuinely out", () => {
    expect(lockReasonText("DELEGATED", "OWNER")).toContain("withdraw");
    // A delegate has no such route, so telling them about one would be noise.
    expect(lockReasonText("DELEGATED", "DELEGATE")).toBe("Not yours to edit");
  });

  it("degrades an unknown code to the code, not to a generic sentence", () => {
    // Not a sentence, but the one thing that lets a support call name what the
    // server actually said. A reason added server-side must not vanish.
    expect(lockReasonText("SOME_NEW_REASON", "OWNER")).toBe("SOME_NEW_REASON");
    expect(lockReasonText("SOME_NEW_REASON", "DELEGATE")).toBe("SOME_NEW_REASON");
  });

  it("still produces a sentence when there is no reason at all", () => {
    // The Delegation page's tooltip used to render `?? ""` here, which is an
    // empty tooltip and reads as a UI fault rather than as a missing reason.
    expect(lockReasonText(null, "OWNER")).toBe("Not yours to edit");
    expect(lockReasonText(undefined, null)).toBe("Not yours to edit");
  });
});

describe("lockReasonsByDepartment", () => {
  it("is empty before the ownership call has ever run", () => {
    expect(lockReasonsByDepartment(null).size).toBe(0);
  });

  it("carries only the readable-but-not-writable departments", () => {
    const reasons = lockReasonsByDepartment(
      ownership("OWNER", [
        { code: "D0410", writable: false, reason: "DELEGATED" },
        { code: "D0610", writable: true, reason: null },
        // Neither readable nor writable: absent on purpose. Presence in this map
        // is what the picker uses to decide between greying something and not
        // listing it, and a delegate scoped to one department must not be handed
        // the shape of the whole hotel by way of a tooltip.
        { code: "D0710", readable: false, writable: false, reason: "NOT_IN_WRITE_SCOPE" },
      ])
    );

    expect([...reasons.keys()]).toEqual(["D0410"]);
    expect(reasons.get("D0410")).toContain("withdraw");
  });

  it("words every entry for the relation on the body it was given", () => {
    const asDelegate = lockReasonsByDepartment(
      ownership("DELEGATE", [{ code: "D0610", reason: "HANDED_BACK" }])
    );
    const asOwner = lockReasonsByDepartment(
      ownership("OWNER", [{ code: "D0610", reason: "HANDED_BACK" }])
    );

    expect(asDelegate.get("D0610")).toBe("Handed back to the owner");
    expect(asOwner.get("D0610")).toContain("Handed back to you");
  });
});
