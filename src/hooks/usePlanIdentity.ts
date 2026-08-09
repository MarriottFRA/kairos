/**
 * Which plan am I looking at?
 * ---------------------------------------------------------------------------
 * The Delegation page is reached with nothing but `?plan=<opaque id>` and the
 * globally selected hotel. It rendered a hardcoded "Delegation" heading, so
 * somebody who mis-clicked on the Sync page — or opened a bookmark, or came back
 * to a tab from yesterday — was handing departments back on a plan they could
 * not name. That is the one screen where being on the wrong plan is expensive.
 *
 * ## Three sources, cheapest first, each a strict fallback
 *
 * 1. **Router state.** Free and exact, and covers every in-app navigation.
 *    Accepted ONLY when the id in the state matches the id in the query, so a
 *    stale history entry can never label the wrong plan.
 * 2. **`syncStatus(ou)` filtered by plan id.** One call that answers label,
 *    year, hotel and owner together, against caches the Sync page has usually
 *    warmed. Covers a refresh and a deep link with the right hotel selected.
 * 3. **`GET /me/delegations`.** Only when (2) does not contain the plan. This is
 *    the one thing that endpoint is uniquely good for and the reason to finally
 *    call it: it is cross-hotel, so it can say *which* hotel to switch to
 *    instead of "not found" — and it still lists delegations withdrawn in the
 *    last 30 days, so a revoked one is named rather than vanishing.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import authService from "../services/auth";
import { myDelegations, syncStatus } from "../services/kairosSyncService";
import { syncFailed } from "../shared/kairosSync/ipc";

export interface PlanIdentity {
  planId: string | null;
  label: string | null;
  year: number | null;
  /** The hotel the plan actually belongs to, which may not be the selected one. */
  ou: string | null;
  hotelName: string | null;
  ownerEmail: string | null;
  /** Set when the plan is real and lives at a hotel other than the selected one. */
  atAnotherHotel: { ou: string; hotelName: string | null } | null;
  /** True once every source has been tried and none knew the plan. */
  unknown: boolean;
  loading: boolean;
}

/** What a caller may put in router state. Matched on `planId` before use. */
export interface PlanIdentityHint {
  planId: string;
  label: string;
  year: number;
  ou: string;
  ownerEmail?: string | null;
}

const EMPTY: PlanIdentity = {
  planId: null,
  label: null,
  year: null,
  ou: null,
  hotelName: null,
  ownerEmail: null,
  atAnotherHotel: null,
  unknown: false,
  loading: false,
};

export function usePlanIdentity(
  ou: string | null,
  planId: string | null
): PlanIdentity {
  const location = useLocation();
  const [resolved, setResolved] = useState<PlanIdentity | null>(null);
  const [hotelNames, setHotelNames] = useState<ReadonlyMap<string, string>>(
    new Map()
  );
  const [loading, setLoading] = useState(false);

  /**
   * The hint the navigating page left behind, but only if it is about THIS plan.
   *
   * A back-navigation replays whatever state that history entry carried, and a
   * header naming the previous plan would be worse than a header naming none.
   */
  const hint = useMemo((): PlanIdentityHint | null => {
    const candidate = (location.state as { plan?: PlanIdentityHint } | null)?.plan;
    return candidate && candidate.planId === planId ? candidate : null;
  }, [location.state, planId]);

  useEffect(() => {
    let cancelled = false;
    void authService
      .getHotels()
      .then((hotels) => {
        if (cancelled) return;
        setHotelNames(new Map(hotels.map((hotel) => [hotel.ou, hotel.hotel_name])));
      })
      .catch(() => {
        // Raw OU codes are worse to read and never wrong. Not an error state.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!planId) {
      setResolved(null);
      return;
    }
    // A hint answers everything the header needs, so nothing is fetched at all
    // on the ordinary path from the Sync page.
    if (hint) {
      setResolved(null);
      return;
    }
    if (!ou) return;

    let cancelled = false;
    setLoading(true);

    void (async () => {
      const status = await syncStatus(ou);
      if (cancelled) return;

      if (!syncFailed(status)) {
        const plan = status.data.plans.find(
          (candidate) => candidate.planId === planId
        );
        if (plan) {
          setResolved({
            planId,
            label: plan.label,
            year: plan.year,
            ou: plan.ou,
            hotelName: null,
            ownerEmail: plan.ownerEmail,
            atAnotherHotel: null,
            unknown: false,
            loading: false,
          });
          setLoading(false);
          return;
        }
      }

      // Not at this hotel. The cross-hotel list is the only thing that can tell
      // "you are looking at the wrong hotel" apart from "that plan is not real".
      const mine = await myDelegations();
      if (cancelled) return;
      const entry = syncFailed(mine)
        ? undefined
        : mine.data.delegations.find(
            (candidate) => candidate.planId === planId
          );

      setResolved(
        entry
          ? {
              planId,
              label: entry.label,
              year: entry.year,
              ou: entry.ou,
              hotelName: null,
              ownerEmail: null,
              atAnotherHotel: entry.ou !== ou ? { ou: entry.ou, hotelName: null } : null,
              unknown: false,
              loading: false,
            }
          : { ...EMPTY, planId, unknown: true }
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [ou, planId, hint]);

  return useMemo((): PlanIdentity => {
    if (!planId) return EMPTY;
    const base: PlanIdentity = hint
      ? {
          planId,
          label: hint.label,
          year: hint.year,
          ou: hint.ou,
          hotelName: null,
          ownerEmail: hint.ownerEmail ?? null,
          atAnotherHotel: hint.ou !== ou ? { ou: hint.ou, hotelName: null } : null,
          unknown: false,
          loading: false,
        }
      : resolved ?? { ...EMPTY, planId, loading };

    // Names resolved last, so a slow /hotels never delays the label.
    return {
      ...base,
      hotelName: base.ou ? hotelNames.get(base.ou) ?? null : null,
      atAnotherHotel: base.atAnotherHotel
        ? {
            ...base.atAnotherHotel,
            hotelName: hotelNames.get(base.atAnotherHotel.ou) ?? null,
          }
        : null,
      loading: base.loading || loading,
    };
  }, [planId, hint, resolved, hotelNames, ou, loading]);
}
