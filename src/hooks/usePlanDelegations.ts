/**
 * The grants themselves, for the plans the Sync page knows have one.
 * ---------------------------------------------------------------------------
 * Stage two of a two-stage fetch. `useDelegationOverview` asks the cheap
 * question — `/department-ownership`, one ETag'd call that answers "does anybody
 * hold anything here" and is written back into the status cache so the next
 * refresh needs no request at all. This asks the expensive one, and only where
 * the answer to the cheap one was yes.
 *
 * That gating is the whole design. An owner with no delegations — most owners,
 * most of the time — makes zero calls from here. An owner with one delegate
 * makes two, once, and then not again until an ETag moves.
 *
 * ## Two calls, because the interesting fact is in the second
 *
 * `/plans/{id}/delegations` says who was given what and what the grant permits.
 * `/plans/{id}/activity` says who is in the app right now and how much they have
 * changed and not published. The first without the second gives an owner a list
 * of names and no way to tell "finished" from "mid-sentence" — which is exactly
 * the judgement they need before withdrawing anything.
 *
 * ## Joined on `delegateUserId`, never on email
 *
 * A delegate's login address need not be the address the grant was made to, and
 * matching on it fails silently — the row simply never shows presence. Same rule
 * as `delegationSummary` and `DelegationCard`.
 */

import { useEffect, useState } from "react";
import { activity, listDelegations } from "../services/kairosSyncService";
import { syncFailed } from "../shared/kairosSync/ipc";
import type { PlanSyncStatus } from "../shared/kairosSync/ipc";
import type { ActivityEntry, Delegation, DepartmentOwnership } from "../shared/kairosSync/protocol";
import { delegationSummary } from "../shared/kairosSync/delegationSummary";
import { canDelegate } from "../shared/kairosSync/relations";

export interface PlanDelegations {
  delegations: Delegation[];
  presenceByUserId: Record<string, ActivityEntry>;
}

export function usePlanDelegations(
  ou: string | null,
  plans: PlanSyncStatus[],
  /** Stage one's answers, keyed by plan id. */
  ownership: Record<string, DepartmentOwnership | null>
): Record<string, PlanDelegations> {
  const [byPlan, setByPlan] = useState<Record<string, PlanDelegations>>({});

  // A stable key, so this does not re-fire on every status object identity
  // change — only when the set of plans with a delegation actually moves.
  const wanted = plans
    .filter((plan) => {
      if (!plan.onThisComputer || !plan.readable) return false;
      // `plan:delegate` is the granting half. A delegate cannot list the grants
      // on somebody else's plan, and asking would be a 403 per refresh.
      if (!canDelegate(plan.relation)) return false;
      const summary = delegationSummary(ownership[plan.planId]);
      if (summary.stale) return false;
      return summary.delegatedOut.length + summary.handedBack.length > 0;
    })
    .map((plan) => plan.planId)
    .sort()
    .join(",");

  useEffect(() => {
    if (!ou || wanted === "") return;
    const ids = wanted.split(",");
    let cancelled = false;

    void Promise.all(
      ids.map(async (planId) => {
        const [grants, presence] = await Promise.all([
          listDelegations(ou, planId),
          activity(ou, planId),
        ]);
        if (syncFailed(grants)) return [planId, null] as const;

        const presenceByUserId: Record<string, ActivityEntry> = {};
        if (!syncFailed(presence)) {
          for (const entry of presence.data.present ?? []) {
            presenceByUserId[entry.userId] = entry;
          }
        }
        return [
          planId,
          { delegations: grants.data.delegations, presenceByUserId },
        ] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      setByPlan((current) => {
        const next = { ...current };
        for (const [planId, result] of entries) {
          // A failed refresh keeps whatever was already on screen. Blanking a
          // correct list because one call timed out reads as "they left".
          if (result !== null) next[planId] = result;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [ou, wanted]);

  return byPlan;
}
