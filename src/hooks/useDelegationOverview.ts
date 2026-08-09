/**
 * Fill in the delegation picture for the plans that have one.
 * ---------------------------------------------------------------------------
 * `PlanSyncStatus.delegation` is derived from whatever `/department-ownership`
 * last cached for that plan, which costs nothing — but for an owner who has
 * never opened the Delegation page, nothing has ever been cached, and that is
 * most owners. So the strip would be permanently stale for exactly the people it
 * is for.
 *
 * ## Every plan you could delegate — a deliberate widening
 *
 * This used to gate on the two facts that PROVE a delegation exists:
 * `handbacksPending > 0`, which comes off the head and is authoritative, and
 * `relation === "DELEGATE"`, which is self-evident. That was right when the
 * consumer was a strip that only drew for a handback. It is wrong now.
 *
 * An owner who has delegated a department and whose delegate has not handed
 * anything back matches neither condition, so their ownership answer stayed
 * `stale` for ever — and `PlanPeopleSection`, which must never render "nobody
 * holds anything" from an UNKNOWN, could never draw for them at all. That is the
 * common case, not an edge one: it is every delegation between the grant and the
 * handback.
 *
 * So the gate is now "could this plan have a delegation", i.e. the caller can
 * grant one. The cost is bounded and was always the reason this was safe: the
 * call is ETag'd, and a hit is written back into `ownershipJson` by the handler,
 * so the NEXT status refresh carries the summary with no request at all. The
 * fetch pays for itself once per plan per ETag change — still materially cheaper
 * than the per-plan lease loop on the same page, which is unconditional.
 */

import { useEffect, useState } from "react";
import { departmentOwnership } from "../services/kairosSyncService";
import { syncFailed } from "../shared/kairosSync/ipc";
import type { PlanSyncStatus } from "../shared/kairosSync/ipc";
import type { DepartmentOwnership } from "../shared/kairosSync/protocol";
import { canDelegate } from "../shared/kairosSync/relations";

export function useDelegationOverview(
  ou: string | null,
  plans: PlanSyncStatus[]
): Record<string, DepartmentOwnership | null> {
  const [byPlan, setByPlan] = useState<Record<string, DepartmentOwnership | null>>({});

  // A stable key so this does not re-fire on every status object identity change.
  const wanted = plans
    .filter(
      (plan) =>
        plan.onThisComputer &&
        plan.readable &&
        (canDelegate(plan.relation) ||
          plan.handbacksPending > 0 ||
          plan.relation === "DELEGATE")
    )
    .map((plan) => plan.planId)
    .sort()
    .join(",");

  useEffect(() => {
    if (!ou || wanted === "") return;
    const ids = wanted.split(",");
    let cancelled = false;

    void Promise.all(
      ids.map(async (planId) => {
        const result = await departmentOwnership(ou, planId);
        return [planId, syncFailed(result) ? null : result.data] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      setByPlan((current) => {
        const next = { ...current };
        for (const [planId, ownership] of entries) {
          // A 304 with no cached body comes back null. Keep whatever we already
          // showed rather than blanking a correct strip on a conditional miss.
          if (ownership !== null || !(planId in next)) next[planId] = ownership;
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
