/**
 * Did the server just start letting us read MORE of this plan?
 * ---------------------------------------------------------------------------
 * A delta download is a claim about time: "give me everything since version N".
 * That is only a complete answer while the question "everything I am allowed to
 * see" has the same answer it had when N was recorded. When a caller's READ
 * scope widens, it stops being one — the rows in the newly-visible departments
 * were written long before N, so no future delta will ever mention them again.
 *
 * The protocol has no counter for this. `version` moves once per accepted
 * commit and `syncEpoch` only on a support-lease handback or a forced resync,
 * so neither is touched by the two things that widen a scope: a delegation
 * amended to cover more departments, and an ownership transfer. The counter
 * that DOES move is `authzVersion` — but it is per USER and global to the
 * property, so it says "something you can see changed somewhere" and cannot
 * name the plan or say in which direction. Re-pulling every plan at the hotel
 * on any grant change anywhere is not an answer.
 *
 * The scope itself is the signal, and the comparison needs two copies of it that
 * move at DIFFERENT times: what the copy was pulled under, and what the server
 * offers now. `completePull` records the first in `pulledScopeKind` /
 * `pulledScopeDepartments` and nothing else writes them; the head carries the
 * second. Comparing the two is enough, needs no request, and is exact.
 *
 * ## Why the pulled scope has its own columns
 *
 * It used to be read from `scopeKind`/`scopeDepartments`, which `heads.ts` also
 * refreshes on every 200. A grant change bumps `authzVersion`, which is folded
 * into the heads ETag, so the probe that first carried the wider scope was
 * always a 200 — and it overwrote the stored scope before `runPull` or the
 * status call got to compare. Both sides then held the server's current answer
 * and this function said "not widened" in exactly the case it was written for.
 * Symptom: "I granted a second department and its rows and people never came
 * down." `pulledScope` below reads the right columns so no caller can repeat
 * the mistake.
 *
 * ## The case this exists for
 *
 * A delegate holding one department is made the plan's OWNER. Their watermark
 * is level with the server's version, so `changesWaiting` is zero and the card
 * reads "Everything is published" — over a local copy containing one department
 * of thirty. Pressing Download sent `since=<their old watermark>`, the server
 * answered "nothing since then" quite correctly, and nothing arrived. The plan
 * was unrecoverable from the UI: no button reset a watermark.
 *
 * ## Only ever widening, and only ever provable
 *
 * A NARROWING is not reported and must not be. Losing a department is already
 * handled — the server refuses the rows, the delegation's `generation` bumps,
 * and the local copy is deliberately left alone so the work is not lost. There
 * is nothing to download and a full pull would be a waste.
 *
 * Anything unprovable answers `false`. An absent stored scope is the ordinary
 * state of a plan pulled by a build that predates the column, and a head with
 * a null scope is an `OU_VISITOR` entry with its contents withheld. Guessing in
 * either case would fire a full re-download of every plan on the machine the
 * first time somebody opened the Sync page, which is a worse failure than the
 * one this fixes.
 */

/** The scope we last pulled under. */
export interface StoredScope {
  scopeKind: string | null;
  scopeDepartments: string[] | null;
}

/**
 * The pulled scope off a sync-state row, shaped for `readScopeWidened`.
 *
 * Reads `pulledScope*`, never `scope*` — see the module docstring for why the
 * two must not be confused. Null in, null out.
 */
export function pulledScope(
  state:
    | { pulledScopeKind: string | null; pulledScopeDepartments: string[] | null }
    | null
    | undefined
): StoredScope | null {
  if (!state) return null;
  return {
    scopeKind: state.pulledScopeKind,
    scopeDepartments: state.pulledScopeDepartments,
  };
}

/** The scope the server is offering now, as it rides on a `PlanHead`. */
export interface OfferedScope {
  scopeKind: "FULL" | "PARTIAL" | null;
  departments: string[] | null;
}

/**
 * True only when the offered scope is a PROVEN strict superset of the stored
 * one — the one condition under which a delta from our watermark is guaranteed
 * to be an incomplete answer.
 *
 * Both arguments are nullable because both callers have them so: a plan with no
 * state row has never been pulled, and a plan missing from the probe body has
 * no head. Neither can widen anything.
 */
export function readScopeWidened(
  stored: StoredScope | null | undefined,
  offered: OfferedScope | null | undefined
): boolean {
  if (!stored || !offered) return false;

  // Withheld, not empty. An `OU_VISITOR` head carries a null scope, and the
  // plan is about to be purged from this machine rather than downloaded.
  if (offered.scopeKind === null) return false;

  // Never pulled, or pulled by a build that did not record this. Unprovable.
  if (stored.scopeKind !== "FULL" && stored.scopeKind !== "PARTIAL") return false;

  // Already everything. `FULL` → `FULL` is the steady state of every owner on
  // every probe, so this is also the branch that keeps the check free.
  if (stored.scopeKind === "FULL") return false;

  if (offered.scopeKind === "FULL") return true;

  // PARTIAL → PARTIAL, which is the only case needing the lists. A null on
  // either side is `ScopeReport`'s "all departments", which cannot occur beside
  // `PARTIAL` and so means the list was simply not recorded — unprovable, the
  // same as an unknown kind. Note this is reached only AFTER the `FULL` offer
  // above, which is provable without any list at all.
  const held = stored.scopeDepartments;
  const offeredCodes = offered.departments;
  if (held === null || offeredCodes === null) return false;

  // A department in the offer that we did not hold is the only thing that makes
  // this a widening; a re-ordered or shorter list is not. Length is no proxy —
  // swapping one department for another leaves it unchanged while genuinely
  // exposing rows we have never seen.
  const holding = new Set(held);
  return offeredCodes.some((code) => !holding.has(code));
}
