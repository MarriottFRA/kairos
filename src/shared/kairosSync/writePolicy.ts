/**
 * Which departments this user may WRITE — one derivation, one predicate.
 * ---------------------------------------------------------------------------
 * This used to be a bare `ReadonlySet<string> | undefined` passed around by
 * hand, and the nullable carried three meanings: `undefined` was "everything",
 * a populated set was "only these", an empty set was "nothing". Three long
 * comment blocks in three files warned readers not to confuse the first and the
 * third, which is what a type does when it is the wrong shape.
 *
 * What it could not express is the fourth meaning, and it is the one the server
 * actually sends an owner: **everything EXCEPT these**.
 *
 * ## Why that fourth case exists
 *
 * `/department-ownership` enumerates only departments that already have rows in
 * the plan — the Delegation page says so in its own empty state ("Add positions
 * with a department code first"), and `/plans/{id}/departments` has a
 * `NO_LIVE_ROWS` reason built on the same model. So a department nobody has
 * used yet is ABSENT from the answer, and absent is not the same as refused.
 *
 * Read as an allow-list, absence locked a full-scope owner out of any
 * department they had just opened — and the lock covered the department picker
 * itself, so there was no way back from a mis-click. Worse, the publish filter
 * reads the same answer, so the row was withheld silently, the department never
 * gained rows on the server, and it was therefore never enumerated. A deadlock
 * that repaired itself only by never happening.
 *
 * `departmentPickList` already knew this: its FULL branch starts from reference
 * data and only ever SUBTRACTS. That was the correct rule living in one of the
 * two places that needed it. It now lives here, and both read it.
 *
 * ## The shape
 *
 * One object, no union to discriminate at the call site:
 *
 * | situation                          | `allow`        | `deny`               |
 * | ---------------------------------- | -------------- | -------------------- |
 * | unpublished / never asked          | `null`         | `∅`                  |
 * | owner, FULL scope                  | `null`         | explicitly refused   |
 * | PARTIAL scope, or any delegate     | writable codes | `∅`                  |
 * | revoked, read-only share, locked   | `∅`            | `∅`                  |
 *
 * `null` is "no ceiling"; `deny` is the floor. Both are needed: an owner who has
 * delegated Rooms away really cannot write Rooms, so dropping `deny` and
 * publishing everything would push a delegate's whole department into a wall of
 * 403s.
 *
 * ## This still never invents write access
 *
 * The rule `ownership.ts` states — never flip a `writable: false` to true — is
 * untouched, and `deny` is what enforces it. What changed is the treatment of a
 * code the server did not mention at all, which was never a `false` to begin
 * with. Sets and empty sets both survive round-tripping through here unchanged.
 *
 * Forward-compatible on purpose. If `/department-ownership` is ever changed to
 * enumerate every readable department, a deny-list returns identical answers —
 * so nothing here is betting on which behaviour the server ships.
 */

import type { DepartmentOwnership } from "./protocol";
import { ownsPlan } from "./relations";

const NONE: ReadonlySet<string> = new Set<string>();

export interface DepartmentWritePolicy {
  /**
   * The ceiling. `null` means every department, including ones this plan has
   * never used. A `Set` means only these.
   */
  allow: ReadonlySet<string> | null;
  /**
   * The floor: codes the server has explicitly refused, whatever `allow` says.
   * Populated only for a full-scope owner, who is the only caller whose ceiling
   * is open.
   */
  deny: ReadonlySet<string>;
}

/** No server-side opinion: an unpublished plan behaves as it always has. */
export const UNRESTRICTED_WRITE: DepartmentWritePolicy = { allow: null, deny: NONE };

/** A revoked delegate, a read-only share, or a plan held under a lease. */
export const NO_DEPARTMENT_WRITE: DepartmentWritePolicy = { allow: NONE, deny: NONE };

/**
 * A plain allow-list, for the one caller deriving a scope from something that
 * is not an ownership body: the publish filter's fallback to the head's read
 * scope, used before `/department-ownership` has ever been answered.
 */
export function allowOnly(codes: Iterable<string>): DepartmentWritePolicy {
  return { allow: new Set(codes), deny: NONE };
}

/**
 * Sets, not arrays: this is consulted for every rendered cell on every grid
 * store update, and a linear scan of thirty departments would be felt.
 */
export function canWriteDepartment(
  policy: DepartmentWritePolicy,
  code: string
): boolean {
  if (policy.deny.has(code)) return false;
  return policy.allow === null || policy.allow.has(code);
}

/**
 * Does this user hold anything at all?
 *
 * Two callers need it and neither is about a specific department: the "shared
 * with you to look at, not to change" refusal, and the rule that keeps a row
 * with no department editable so it can be given one.
 *
 * An open ceiling counts as holding something even when everything enumerated
 * has been denied — an owner who has delegated all five of their departments
 * away can still start a sixth, which the old `size > 0` test refused.
 */
export function holdsAnyDepartment(policy: DepartmentWritePolicy): boolean {
  return policy.allow === null || policy.allow.size > 0;
}

/**
 * The server's answer, as a policy.
 *
 * Callers layer their own gates on top — `planLocked`, `notShared`, and the
 * relation's own capability — exactly as they did before. This function only
 * reads the ownership body.
 *
 * ## Why the open ceiling is gated on the relation as well as the scope
 *
 * `scopeKind: "FULL"` alone would widen a delegate who happens to hold every
 * department, and a delegate is precisely who the enumeration is FOR: they hold
 * three of thirty and should see three. Requiring `ownsPlan` too means the
 * widening reaches only the person whose authority is the whole plan — an
 * owner, a degraded owner, or a support lease standing in for one.
 */
export function departmentWritePolicy(
  ownership: DepartmentOwnership | null | undefined
): DepartmentWritePolicy {
  if (!ownership) return UNRESTRICTED_WRITE;

  const openCeiling =
    ownership.me.scopeKind === "FULL" && ownsPlan(ownership.me.relation);

  if (!openCeiling) {
    const allow = new Set<string>();
    for (const row of ownership.departments) {
      if (row.writable) allow.add(row.code);
    }
    return { allow, deny: NONE };
  }

  const deny = new Set<string>();
  for (const row of ownership.departments) {
    if (!row.writable) deny.add(row.code);
  }
  return { allow: null, deny };
}

/**
 * The departments the server actually listed as writable.
 *
 * NOT the write predicate — `canWriteDepartment` is. This is the enumeration,
 * and the distinction is the whole point of this module, so the name says so.
 * The one legitimate consumer is presence reporting, which answers "which
 * departments am I working in" rather than "what may I write": a policy with an
 * open ceiling has no list to report, and reporting "all of them" would tell an
 * owner's colleagues they are mid-edit everywhere.
 */
export function enumeratedWritableDepartments(
  ownership: DepartmentOwnership | null | undefined
): string[] {
  if (!ownership) return [];
  return ownership.departments.filter((row) => row.writable).map((row) => row.code);
}
