/**
 * What the person who just gave a plan away is told about their own access.
 *
 * The cases worth pinning are the two ways of being wrong. Promising a view they
 * do not have sends them looking for a plan that is gone; saying nothing about
 * the view they DO have turns a deliberate design into what looks like an
 * irreversible loss — and that belief is what stops a handover happening at all,
 * leaving the plan stranded on a departing owner's account.
 */

import { describe, expect, it } from "vitest";
import { retainedReasonText, transferOutcome } from "../retainedAccess";
import type { RetainedReason, TransferResult } from "../protocol";

const REASONS: RetainedReason[] = [
  "SELF_TRANSFER",
  "PREVIOUS_OWNER_INACTIVE",
  "OU_ACCESS_REVOKED",
  "NO_KAIROS_APP",
  "NO_DEPARTMENT_ACCESS",
  "NO_GRANTABLE_DEPARTMENTS",
  "NO_OVERLAP",
  "ALREADY_DELEGATED",
];

function result(overrides: Partial<TransferResult> = {}): TransferResult {
  return {
    planId: "plan-1",
    ownerUserId: 42,
    ownerEmail: "successor@example.com",
    delegationsRevoked: 0,
    retainedDelegation: null,
    retainedReason: null,
    ...overrides,
  };
}

const RETAINED = (departments: string[]) => ({
  id: "del-9",
  delegateUserId: 7,
  departments,
  canEdit: false,
  canReadPii: true,
});

describe("retainedReasonText", () => {
  it("has a sentence for every documented reason", () => {
    for (const reason of REASONS) {
      const text = retainedReasonText(reason);
      expect(text.length).toBeGreaterThan(0);
      // A sentence, not the code echoed back through the fallback.
      expect(text).not.toContain(reason);
    }
  });

  it("names an unrecognised code rather than swallowing it", () => {
    // Same principle as `lockReasonText`: not a sentence, but the one thing
    // that lets a support call say what the server actually said.
    expect(retainedReasonText("SOME_NEW_REASON")).toContain("SOME_NEW_REASON");
  });
});

describe("transferOutcome", () => {
  it("says what was kept when a read-only delegation was retained", () => {
    const outcome = transferOutcome(
      result({ retainedDelegation: RETAINED(["ROOMS", "FB", "SPA"]) })
    );
    expect(outcome.severity).toBe("success");
    expect(outcome.message).toContain("successor@example.com");
    expect(outcome.message).toContain("3 departments");
    // Theirs to withdraw, and the person losing the plan should hear that from
    // the same sentence rather than discover it later.
    expect(outcome.message).toContain("withdraw");
  });

  it("uses the singular for one department", () => {
    const outcome = transferOutcome(
      result({ retainedDelegation: RETAINED(["ROOMS"]) })
    );
    expect(outcome.message).toContain("1 department —");
  });

  it("is info, not error, when nothing was retained", () => {
    // The transfer COMMITTED. A departed owner keeping nothing is the ordinary
    // outcome — the commonest reason to hand a plan over is that its owner is
    // leaving — and it must never read as a failure.
    const outcome = transferOutcome(
      result({ retainedReason: "PREVIOUS_OWNER_INACTIVE" })
    );
    expect(outcome.severity).toBe("info");
    expect(outcome.message).toContain("Ownership transferred");
    expect(outcome.message).toContain("no longer have access");
  });

  it("falls back to the plain confirmation when the body says neither", () => {
    // The invariant is that exactly one of the two is set. This does not trust
    // it: a transfer that actually committed must not look like it failed
    // because the response surprised us.
    const outcome = transferOutcome(result());
    expect(outcome.severity).toBe("success");
    expect(outcome.message).toContain("Ownership transferred");
  });

  it("prefers the delegation when a server sends both", () => {
    // Belt and braces on the same invariant, in the direction that is true:
    // they hold a row, so they have the access whatever the reason says.
    const outcome = transferOutcome(
      result({
        retainedDelegation: RETAINED(["ROOMS"]),
        retainedReason: "ALREADY_DELEGATED",
      })
    );
    expect(outcome.severity).toBe("success");
    expect(outcome.message).toContain("read-only access");
  });
});
