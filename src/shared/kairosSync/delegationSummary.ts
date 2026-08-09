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

import type { DepartmentOwnership } from "./protocol";

export interface DelegatedDepartment {
  code: string;
  email: string;
  delegationId: string;
}

export interface PlanDelegationSummary {
  /** Delegated away and still being worked on. Not writable by the owner. */
  delegatedOut: DelegatedDepartment[];
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
      (holder.state === "ACTIVE" ? summary.delegatedOut : summary.handedBack).push(
        entry
      );
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
    summary.handedBack.length === 0 &&
    summary.mine.length === 0 &&
    summary.myHandedBack.length === 0
  );
}
