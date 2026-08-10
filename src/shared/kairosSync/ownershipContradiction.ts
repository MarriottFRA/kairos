/**
 * When `/department-ownership` disagrees with itself.
 * ---------------------------------------------------------------------------
 * §"A HANDED_BACK department is writable by the owner again" of the client
 * guide: `writable` flips back to `true` and `reason` to `null` for the owner
 * the moment the last ACTIVE holder goes. `HANDED_BACK` as a REASON is what the
 * DELEGATE is told about their own lost write access; an owner never sees it.
 *
 * An owner-side answer that breaks that rule can be caught without asking the
 * server anything, because the holder states ride on the same row —
 * `DepartmentOwnershipRow.assignedTo[].state` is `ACTIVE | HANDED_BACK`. Two
 * shapes are provably wrong:
 *
 *   reason === "HANDED_BACK"                    — a delegate's sentence, to the owner
 *   reason === "DELEGATED", no EDITING holder   — the stated reason has no holder
 *
 * "Editing", not merely ACTIVE. A read-only delegate displaces nobody — the
 * department stays `writable: true, reason: null` — so a `DELEGATED` lock whose
 * only ACTIVE holder cannot edit is as unjustified as one with no holder at all.
 * Strictly stronger than the ACTIVE test it replaces, and safe: the only thing
 * this predicate ever triggers is asking the server again.
 *
 * Deliberately NOT included: `NOT_IN_WRITE_SCOPE` with no holders. That is
 * legitimate for an `OWNER_DEGRADED` whose hotel access shrank, and a predicate
 * that fired there would spend a request on every window focus to re-confirm a
 * lock that is correct.
 *
 * ## Why this exists at all
 *
 * A handback happens on the DELEGATE's machine. The owner has no local event to
 * hang a cache invalidation on, so the server's ETag is their only correction
 * path — and if it does not fold delegation state, the owner is answered 304
 * for ever and stays locked out of a department nobody holds. This predicate is
 * the trigger for asking again UNCONDITIONALLY, and, on the Delegation page,
 * for saying out loud that the server was asked again and said the same thing.
 *
 * ## It never unlocks anything
 *
 * Nothing here may turn a `writable: false` into a writable department. The
 * publish filter uses the same field, so a locally-unlocked cell produces edits
 * that `filterToWriteScope` withholds without a rejection — data the user
 * believes is saved and is not, which is a worse failure than the lock. The only
 * permitted response is to re-ask and believe the second answer.
 */

import type { DepartmentOwnership } from "./protocol";
import { holderEdits } from "./delegationSummary";
import { ownsPlan } from "./relations";

/**
 * The departments whose lock this body cannot justify, in `code` order as given.
 *
 * Empty for every delegate-side answer: a delegate is told `HANDED_BACK` about
 * their own lost write access and that is exactly correct, so the whole check is
 * gated on the caller being the plan's side of the grant.
 */
export function contradictoryDepartments(
  ownership: DepartmentOwnership | null | undefined
): string[] {
  if (!ownership || !ownsPlan(ownership.me.relation)) return [];

  const disputed: string[] = [];
  for (const row of ownership.departments) {
    if (row.writable) continue;
    if (row.reason === "HANDED_BACK") {
      disputed.push(row.code);
      continue;
    }
    if (row.reason === "DELEGATED" && !row.assignedTo.some(holderEdits)) {
      disputed.push(row.code);
    }
  }
  return disputed;
}

/** The same question when only the yes/no matters — a cache-replay decision. */
export function ownershipContradicted(
  ownership: DepartmentOwnership | null | undefined
): boolean {
  return contradictoryDepartments(ownership).length > 0;
}
