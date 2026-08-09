/**
 * Why a department this user can see is not theirs to edit.
 * -----------------------------------------------------------
 * Shared rather than duplicated because two screens explain the same three
 * server reasons — the Delegation page's ownership table and the positions
 * grid's picker and row menu — and a user who reads one wording in one place and
 * a different one in the other has to work out whether they mean the same thing.
 *
 * The keys are `NotWritableReason` from `/department-ownership`, with a fallback
 * so a reason added server-side degrades to its own code rather than to an empty
 * string. It used to be a bare record with the fallback left to the call site,
 * and the two call sites disagreed: the Delegation page's `?? ""` rendered a
 * tooltip with nothing in it, which reads as a UI fault rather than as an
 * unrecognised reason.
 *
 * ## Two sides of the same reason
 *
 * A reason is written for whoever is being refused, and the same code means
 * opposite things to the two of them. `HANDED_BACK` is the delegate's own lost
 * write access — correct and complete on their screen. Shown to the OWNER it
 * says the department was handed back to them next to a chip saying they cannot
 * edit it, which is not an explanation but a contradiction.
 *
 * Per the guide that owner-side case should not arise at all: the moment the
 * last ACTIVE holder goes the department returns to the owner as `writable:
 * true, reason: null`. It is worded here anyway, because a client that renders
 * nonsense when the server surprises it is a client that cannot be debugged from
 * a screenshot — and by the time anyone reads this sentence, `ownership.ts` has
 * already re-asked the server without its cache, so it is the server's answer.
 *
 * What must NOT happen is the client deciding it knows better and unlocking the
 * row. `filterToWriteScope` reads the same `writable` field at publish, so those
 * edits would be withheld with no rejection — data the user believes is saved and
 * is not. Withdrawal is the only reclaim the protocol offers, and that is what
 * the owner-side sentence points at: `PATCH` amends the four flags, expiry and
 * note, never the department list.
 */

import type { DepartmentOwnership } from "./protocol";
import { ownsPlan } from "./relations";

const GENERIC = "Not yours to edit";

/** What a holder — or anyone who is not the plan's own side — is told. */
const HOLDER_SIDE: Record<string, string> = {
  DELEGATED: GENERIC,
  HANDED_BACK: "Handed back to the owner",
  NOT_IN_WRITE_SCOPE: GENERIC,
};

/** What the owner, a degraded owner, or a lease holder is told. */
const OWNER_SIDE: Record<string, string> = {
  DELEGATED: "Delegated — withdraw it to edit this yourself",
  HANDED_BACK:
    "Handed back to you, but the server has not released it yet — " +
    "withdraw the delegation to take it back now.",
  NOT_IN_WRITE_SCOPE: GENERIC,
};

/**
 * The sentence for one reason, in the second person, for this caller.
 *
 * An unknown code degrades to the code itself: it is not a sentence, but it is
 * the one thing that lets a support call name what the server actually said.
 */
export function lockReasonText(
  reason: string | null | undefined,
  relation: string | null | undefined
): string {
  if (!reason) return GENERIC;
  const table = ownsPlan(relation) ? OWNER_SIDE : HOLDER_SIDE;
  return table[reason] ?? reason;
}

/**
 * Every locked department in one body, keyed by code. One derivation, so the
 * picker, the row menu and the Delegation table cannot drift apart.
 *
 * Writable departments are absent rather than mapped to an empty string — a
 * caller reading a `Map` wants "is there a reason", and a blank one is not. So
 * are departments this caller cannot even read: presence in this map is what
 * the picker uses to decide between showing something greyed and not showing it
 * at all, and a delegate scoped to one department must not be handed the shape
 * of the whole hotel by way of a tooltip.
 */
export function lockReasonsByDepartment(
  ownership: DepartmentOwnership | null | undefined
): Map<string, string> {
  const reasons = new Map<string, string>();
  if (!ownership) return reasons;
  for (const row of ownership.departments) {
    if (row.writable || !row.readable) continue;
    reasons.set(row.code, lockReasonText(row.reason, ownership.me.relation));
  }
  return reasons;
}
