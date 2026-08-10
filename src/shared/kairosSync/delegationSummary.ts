/**
 * Who holds what on one plan, in the terms a screen actually asks in.
 * ---------------------------------------------------------------------------
 * `/department-ownership` answers a per-department question — "may I write this
 * one, and if not, why" — because that is what the grid needs on every render.
 * Every delegation-aware screen asks the inverse: which departments have gone
 * out, which have come back, and which are mine. Deriving that in each of them
 * is how two screens end up disagreeing about the same fact, so it is derived
 * once, here, and shared by the main process and the renderer.
 *
 * Pure by construction — no Electron, no DOM, no imports beyond the protocol
 * types. Same constraints as `planState.ts`, and for the same reason.
 *
 * ## The one trap
 *
 * `DelegatedHolder` carries `userId` and `email`, and neither answers "is that
 * me". There is no cheap current-user id on the sync surface, and matching on
 * email is wrong in a way that fails silently: a delegate's login address need
 * not be the address the grant was made to. So the "mine" half is derived from
 * `writable` plus `me.relation` — the same predicate a save uses — and never
 * from the holder list.
 */

import type { DepartmentOwnership, OwnershipHolder } from "./protocol";

/**
 * Whether this holder holds the pen right now.
 *
 * The one place the rule is written, because five screens ask it and a
 * disagreement between any two of them is a screen contradicting itself about
 * the same department. A missing flag reads as EDITING: that is the safe
 * direction against a server that predates it, since it can only over-report
 * who holds something and never unlock a department the server locked.
 */
export function holderEdits(
  holder: Pick<OwnershipHolder, "state"> & { canEdit?: boolean }
): boolean {
  return holder.state === "ACTIVE" && holder.canEdit !== false;
}

/** ACTIVE, but read-only: they can see the department and change nothing. */
export function holderReadsOnly(
  holder: Pick<OwnershipHolder, "state"> & { canEdit?: boolean }
): boolean {
  return holder.state === "ACTIVE" && holder.canEdit === false;
}

export interface DelegatedDepartment {
  code: string;
  email: string;
  delegationId: string;
}

export interface PlanDelegationSummary {
  /** Delegated away and still being worked on. Not writable by the owner. */
  delegatedOut: DelegatedDepartment[];
  /**
   * Somebody else can READ this department. Nothing is out of the owner's
   * hands: `writable` stays true and a publish still sends it.
   *
   * Its own bucket rather than a filter on `delegatedOut`, because the two
   * questions have opposite answers and both are asked. "What must I not
   * promise to publish" is `delegatedOut`; "is anybody else on this plan at
   * all" — the gate on fetching the grants, and the count of person rows on the
   * card — has to include these, or the read-only delegation an ownership
   * handover leaves behind is invisible to the new owner.
   */
  readOnly: DelegatedDepartment[];
  /** Handed back and not yet reopened. The owner's cue to download. */
  handedBack: DelegatedDepartment[];
  /** Departments I hold as a delegate and may still write. */
  mine: string[];
  /** Departments I held and have handed back: readable, not writable. */
  myHandedBack: string[];
  /**
   * `/department-ownership` has never run for this plan.
   *
   * Every list above is empty because it is UNKNOWN, not because it is empty.
   * A caller must render that as "ask", never as "nobody holds anything" —
   * which is the more reassuring reading and the wrong one.
   */
  stale: boolean;
}

const EMPTY: PlanDelegationSummary = {
  delegatedOut: [],
  readOnly: [],
  handedBack: [],
  mine: [],
  myHandedBack: [],
  stale: true,
};

export function delegationSummary(
  ownership: DepartmentOwnership | null | undefined
): PlanDelegationSummary {
  if (!ownership) return { ...EMPTY };

  const summary: PlanDelegationSummary = {
    delegatedOut: [],
    readOnly: [],
    handedBack: [],
    mine: [],
    myHandedBack: [],
    stale: false,
  };
  const isDelegate = ownership.me.relation === "DELEGATE";

  for (const row of ownership.departments) {
    for (const holder of row.assignedTo) {
      const entry = {
        code: row.code,
        email: holder.email,
        delegationId: holder.delegationId,
      };
      const bucket = holderEdits(holder)
        ? summary.delegatedOut
        : holderReadsOnly(holder)
          ? summary.readOnly
          : summary.handedBack;
      bucket.push(entry);
    }
    if (!isDelegate) continue;
    if (row.writable) {
      summary.mine.push(row.code);
    } else if (row.readable && row.reason === "HANDED_BACK") {
      summary.myHandedBack.push(row.code);
    }
  }

  return summary;
}

/** Nothing worth drawing. Lets a caller skip the whole component. */
export function delegationSummaryEmpty(
  summary: PlanDelegationSummary | null | undefined
): boolean {
  if (!summary) return true;
  return (
    summary.delegatedOut.length === 0 &&
    summary.readOnly.length === 0 &&
    summary.handedBack.length === 0 &&
    summary.mine.length === 0 &&
    summary.myHandedBack.length === 0
  );
}
