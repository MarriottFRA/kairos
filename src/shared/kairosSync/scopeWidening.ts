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
 * The scope itself is the signal, and we already store it: `pull.ts` records
 * `scopeKind`/`scopeDepartments` at the end of every pull, and `heads.ts`
 * refreshes them on every probe. Comparing the two is enough, needs no request,
 * and is exact.
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

/** The scope we last pulled under, as `getSyncState` returns it. */
export interface StoredScope {
  scopeKind: string | null;
  scopeDepartments: string[] | null;
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
