/**
 * What the outgoing owner is told they kept, after handing a plan over.
 *
 * Ownership transfer leaves the previous owner a read-only delegation over every
 * delegatable department, granted by the incoming owner. That is the whole point
 * of the handover being a handover rather than an eviction: without it the
 * person who built the numbers loses sight of them the instant the transfer
 * commits, with no route back except asking their successor for a grant.
 *
 * But retention is **best effort and never fails the transfer**. The commonest
 * reason to hand a plan over is that its owner is leaving, and a departed owner
 * is exactly the one who no longer qualifies to hold a delegation — so "nothing
 * was retained" is the ordinary outcome rather than the exotic one, and the
 * server reports it as a `retainedReason` instead of an error.
 *
 * ## Why this is a module and not two lines in the page
 *
 * Because the transfer succeeded either way, and the difference between the two
 * outcomes is the only thing the person who pressed the button cannot see for
 * themselves. Getting it wrong in either direction is bad in a specific way:
 * promising a view they do not have sends them looking for a plan that is gone,
 * and staying silent about the view they DO have makes a reversible-looking loss
 * out of a deliberate design. Pure, so it can be tested without a renderer.
 *
 * The unknown-code fallback is the same principle as `lockReasonText`: a reason
 * added server-side degrades to naming itself, which is not a sentence but is
 * the one thing that lets a support call say what the server actually said.
 */

import type { RetainedReason, TransferResult } from "./protocol";

/** Second person, addressed to the person who just gave the plan away. */
const RETAINED_REASON_TEXT: Record<RetainedReason, string> = {
  SELF_TRANSFER: "Ownership was already yours — nothing changed hands.",
  PREVIOUS_OWNER_INACTIVE:
    "You no longer have access to this plan — your account is not active at this hotel.",
  OU_ACCESS_REVOKED:
    "You no longer have access to this plan — you no longer have access to this hotel.",
  NO_KAIROS_APP:
    "You no longer have access to this plan — your account no longer has Kairos.",
  NO_DEPARTMENT_ACCESS:
    "You no longer have access to this plan — you hold no departments at this hotel.",
  NO_GRANTABLE_DEPARTMENTS:
    "You no longer have access to this plan — it has no department with any rows in it yet.",
  NO_OVERLAP:
    "You no longer have access to this plan — none of its departments is one you hold.",
  ALREADY_DELEGATED:
    "You keep the access you already had — you were already a delegate on this plan.",
};

/**
 * The sentence for a reason. Unknown codes name themselves.
 *
 * Not narrowed to `RetainedReason` in the signature: the value arrives off the
 * wire, and a client that only handled the eight codes it was compiled against
 * would silently say nothing about the ninth.
 */
export function retainedReasonText(reason: string): string {
  return (
    RETAINED_REASON_TEXT[reason as RetainedReason] ??
    `You no longer have access to this plan (${reason}).`
  );
}

export interface TransferOutcome {
  /** `success` when the handover left something behind; `info` when it did not. */
  severity: "success" | "info";
  message: string;
}

/**
 * One sentence covering both halves: ownership moved, and here is where that
 * leaves you.
 *
 * Reads the documented invariant — `retainedDelegation` is non-null exactly when
 * `retainedReason` is null — but does not TRUST it: a body with neither falls
 * through to the plain confirmation rather than to an empty string, because a
 * transfer that actually committed must never look like it failed.
 */
export function transferOutcome(result: TransferResult): TransferOutcome {
  const moved = `Ownership transferred to ${result.ownerEmail}.`;

  const retained = result.retainedDelegation;
  if (retained) {
    const count = retained.departments.length;
    return {
      severity: "success",
      message:
        `${moved} You keep read-only access to ` +
        `${count} ${count === 1 ? "department" : "departments"} — ` +
        "they can withdraw it whenever they like.",
    };
  }

  if (result.retainedReason) {
    return { severity: "info", message: `${moved} ${retainedReasonText(result.retainedReason)}` };
  }

  return { severity: "success", message: moved };
}
