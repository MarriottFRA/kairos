/**
 * usePlanScope — what the signed-in user may do with the selected plan.
 * -----------------------------------------------------------
 * One hook, consumed by every surface that has to behave differently once a plan
 * is published and shared: the positions grid locks rows it cannot write,
 * Allocations and Results refuse to render totals from a partial scope, and BST
 * push hides itself entirely.
 *
 * ## Unpublished is the default, and it is permissive
 *
 * A plan that was never published has no server-side authority to consult, so
 * `writePolicy` is `undefined` and every consumer treats that as "all of it" —
 * exactly how the app behaved before sync existed. A hotel that never opts in
 * must never notice this hook exists.
 *
 * ## The answer is the server's, not a guess
 *
 * `writable` comes straight from `/department-ownership`, where it IS the
 * server's write predicate — so the grid can never disagree with what a save
 * will actually do. Notably an OWNER is reported as unable to write a department
 * held by an ACTIVE delegate; their route back is to withdraw the delegation.
 *
 * What that answer does NOT contain is a department with no rows in the plan
 * yet, because the enumeration is built from live rows. `departmentWritePolicy`
 * is where that is handled — for a full-scope owner it becomes a deny-list, so
 * an unmentioned department reads as unrestricted rather than as refused. Read
 * that module before touching anything here.
 *
 * "Actively delegated" is the exact bar, and the imprecise version of that
 * sentence cost a round of misdiagnosis. A HANDED_BACK department has no active
 * holder, so it goes back to `writable: true`, `reason: null` for the owner —
 * the grant survives only to keep the delegate's read access and make reopening
 * one update. `HANDED_BACK` as a *reason* is what the delegate is told about
 * their own lost write access; an owner never sees it.
 *
 * That last sentence is now checked rather than trusted. An owner-side answer
 * that breaks the rule is caught by `ownershipContradiction`, and `ownership.ts`
 * settles it by asking again without the ETag — because a handback happens on
 * the DELEGATE's machine, so the owner has no local event to invalidate on and
 * would otherwise be answered 304 for ever. What must never happen is this hook
 * deciding it knows better and reporting a department as writable: the publish
 * filter reads the same field, so those edits would be withheld without a word.
 *
 * The call is ETag'd server-side and cached in the encrypted store, so a refresh
 * costs a conditional request rather than a rebuild.
 *
 * ## Handback, reopen and withdrawal do not move `planVersion`
 *
 * They change this answer without touching the plan, so nothing about the
 * plan's own state can be the trigger to re-ask. This used to be fetched on
 * mount and never again, which was wrong in both directions: an owner sitting
 * on the grid stayed locked out of a department that had just been handed back
 * to them, and — the silent one — kept an editable grid for a department
 * REOPENED to the delegate, whose rows `filterToWriteScope` then withheld at
 * publish rather than the cell blocking up front.
 *
 * So it revalidates on window focus as well. See `useRevalidateOnFocus`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { departmentOwnership, listDelegations } from "../services/kairosSyncService";
import { syncFailed } from "../shared/kairosSync/ipc";
import { DepartmentOwnership, Relation } from "../shared/kairosSync/protocol";
import {
  DepartmentWritePolicy,
  NO_DEPARTMENT_WRITE,
  clampToGrant,
  departmentWritePolicy,
  enumeratedWritableDepartments,
  holdsAnyDepartment,
} from "../shared/kairosSync/writePolicy";

export interface PlanScope {
  /** Null until the first answer arrives, or when the plan is unpublished. */
  ownership: DepartmentOwnership | null;
  /**
   * What the user may write, as a ceiling and a floor. `undefined` means "no
   * server-side opinion" — unpublished plan, or the lookup has not resolved —
   * and every consumer reads that as unrestricted.
   *
   * Ask it through `canWriteDepartment`, never by reading `allow` directly: a
   * full-scope owner's `allow` is `null`, which is the case the old flat set
   * could not represent and the reason this is a policy.
   */
  writePolicy: DepartmentWritePolicy | undefined;
  /** True when the user holds nothing writable at all. Not the same as loading. */
  holdsNoDepartment: boolean;
  /**
   * The departments the server LISTED as writable — the enumeration, not the
   * predicate. Presence reporting is the only legitimate consumer; see
   * `enumeratedWritableDepartments`.
   */
  enumeratedWritable: string[];
  /** Departments the user may READ. Looser than write: it includes handbacks. */
  readableDepartments: ReadonlySet<string> | undefined;
  relation: Relation | null;
  /** PARTIAL disables allocations, results totals and BST push. See §5.4. */
  scopeKind: "FULL" | "PARTIAL" | null;
  /** False for a demoted owner: hide the blocks/allocations/KPI/SS editors. */
  structureEditable: boolean;
  /**
   * May this user create new positions?
   *
   * `canAddRows` is one of the four flags the owner set when they granted, and
   * the server enforces it — but it is not on `/department-ownership`, so it
   * takes a second call to `GET /plans/{id}/delegations` to learn. That call is
   * granted to DELEGATE and returns only their own row, so it costs one request
   * and discloses nothing.
   *
   * `undefined` means "not asked, or the ask failed", and every consumer reads
   * that as PERMISSIVE. The server is the enforcement point; an offline delegate
   * must not silently lose the ability to add rows they legitimately hold.
   */
  canAddRows: boolean | undefined;
  /**
   * The whole plan is read-only for this user.
   *
   * True for `GLOBAL_ADMIN` — an administrator without a support lease reads
   * everything and writes nothing, deliberately, so that looking at a hotel's
   * plan is not the same act as changing it. A lease held by SOMEBODY ELSE is
   * not visible here; it surfaces as `423 kairos_plan_locked_by_support` at save
   * time, which the Sync page explains with the ticket reference.
   */
  planLocked: boolean;
  /** True while the plan has never been published — the local file is the copy. */
  unpublished: boolean;
  /**
   * The server holds this plan and will not show it to us.
   *
   * Kept strictly apart from `unpublished`, which is the PERMISSIVE default:
   * an unpublished plan has no server-side authority to consult, so consumers
   * read it as "no restriction" and the grid is fully editable — exactly right
   * for a hotel that never opted in. Folding a 403 into that flag would make
   * losing access to a colleague's plan look identical to never having synced,
   * and hand the grid an unrestricted local copy of data the server has just
   * stopped serving.
   *
   * Reachable only with unpublished local work in it; anything clean is purged
   * by the Sync page's status call.
   */
  notShared: boolean;
  loading: boolean;
  /** Non-null only for a real failure; an unpublished plan is not an error. */
  error: string | null;
  /**
   * Ask again.
   *
   * `{ unconditional: true }` bypasses the ETag, and belongs on a user action
   * only — it is what somebody staring at a lock nobody holds presses to make
   * this computer stop trusting its cached answer. The flag is consumed by the
   * one request it triggers; the next automatic revalidate goes back to being
   * conditional.
   */
  refresh: (options?: { unconditional?: boolean }) => void;
}

/**
 * "This plan exists at your hotel and its owner has not shared it with you."
 *
 * Deliberately not in `UNPUBLISHED_CODES` below, and the distinction is the
 * whole point: those codes mean the app should behave as though sync does not
 * exist, which is permissive. This one means the opposite.
 */
const NOT_SHARED_CODE = "kairos_plan_not_shared";

/** Codes that mean "there is no plan on the server", not "something broke". */
const UNPUBLISHED_CODES = new Set([
  "kairos_plan_not_found",
  "kairos_scope_empty",
  // No OU grant, no app grant, no departments: the user is not on this surface
  // at all, and the app must keep working locally rather than showing an error.
  "kairos_ou_scope_required",
  "kairos_department_scope_required",
  "kairos_app_access_required",
  "account_not_approved",
  "device_required",
]);

/**
 * Re-ask when the window comes back to the front.
 *
 * Focus is the honest trigger for a permission that can change while nobody is
 * looking: it is the moment before the user acts on a lock — or on the absence
 * of one. Polling would ask a hundred times to catch the same transition once,
 * and there is no push channel to subscribe to.
 *
 * Cheap by construction rather than by luck. The server folds the delegation's
 * (department, holder, state) triples into the ETag, so an unchanged grant is a
 * 304 with no body and a handback, reopen or withdrawal is a 200 carrying the
 * new answer. Returning to the app costs one conditional request.
 *
 * `focus` and `visibilitychange` both fire when switching back from another
 * application, so the pair is collapsed — two identical requests a second apart
 * would be the kind of small, permanent waste that is hard to notice later.
 */
function useRevalidateOnFocus(enabled: boolean, revalidate: () => void): void {
  const lastAt = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const onFocus = () => {
      // A visibilitychange to "hidden" is the app going away, not coming back.
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAt.current < 1000) return;
      lastAt.current = now;
      revalidate();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, revalidate]);
}

export function usePlanScope(
  ou: string | null,
  planId: string | null
): PlanScope {
  const [ownership, setOwnership] = useState<DepartmentOwnership | null>(null);
  const [unpublished, setUnpublished] = useState(true);
  const [notShared, setNotShared] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canAddRows, setCanAddRows] = useState<boolean | undefined>(undefined);
  const [grantCanEdit, setGrantCanEdit] = useState<boolean | undefined>(undefined);
  /**
   * The re-ask trigger, carrying whether that particular ask ignores the cache.
   *
   * The flag rides with the nonce rather than sitting in its own state so it is
   * consumed exactly once — a `unconditional` left standing would turn every
   * subsequent focus revalidate into a full request, which is the opposite of
   * what the ETag is for.
   */
  const [nonce, setNonce] = useState({ n: 0, unconditional: false });

  const refresh = useCallback(
    (options?: { unconditional?: boolean }) =>
      setNonce((value) => ({
        n: value.n + 1,
        unconditional: options?.unconditional === true,
      })),
    []
  );

  // No argument, deliberately: coming back to the window is the commonest event
  // in the feature and it must stay a conditional request. The cache corrects
  // itself without help — see `fetchOwnership`, which spends one unconditional
  // request of its own when the replayed answer cannot justify its own lock.
  const revalidate = useCallback(() => refresh(), [refresh]);

  useRevalidateOnFocus(Boolean(ou && planId), revalidate);

  useEffect(() => {
    if (!ou || !planId) {
      setOwnership(null);
      setUnpublished(true);
      setNotShared(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    departmentOwnership(ou, planId, { unconditional: nonce.unconditional })
      .then((result) => {
        if (cancelled) return;
        if (syncFailed(result)) {
          const locked = result.error.code === NOT_SHARED_CODE;
          // Offline, signed out, or simply not published: the app is standalone
          // first, so none of these is a failure the user needs to see.
          setOwnership(null);
          // NOT `unpublished` for a locked plan. That flag is the permissive
          // default and would hand the grid an unrestricted copy of exactly the
          // data the server has stopped serving.
          setUnpublished(!locked);
          setNotShared(locked);
          setError(
            locked ||
              UNPUBLISHED_CODES.has(result.error.code) ||
              result.error.code === "local"
              ? null
              : result.error.message
          );
          return;
        }
        setOwnership(result.data);
        // A null body with a successful call means the plan exists but this
        // client has no cached copy and the server answered 304 — rare, and
        // treated as "ask again" rather than "unrestricted".
        setUnpublished(result.data === null);
        setNotShared(false);
        setError(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ou, planId, nonce]);

  /**
   * The delegation's own permission flags, for the two flags the grid needs.
   *
   * Only ever fetched for somebody who actually holds a delegation — an owner's
   * page must not pay a request to learn something that cannot apply to them.
   * A failure leaves both `undefined`, which is permissive: see `canAddRows`.
   *
   * `canEdit` is the read-only switch itself, and it is read here as well as
   * trusted to shape the ownership answer: `writable` describes who HOLDS each
   * department, and a read-only delegate displaces nobody — so this flag is the
   * one place the grant's own read-only-ness is stated outright.
   */
  useEffect(() => {
    const relation = ownership?.me.relation;
    if (!ou || !planId || relation !== "DELEGATE") {
      setCanAddRows(undefined);
      setGrantCanEdit(undefined);
      return;
    }

    let cancelled = false;
    listDelegations(ou, planId)
      .then((result) => {
        if (cancelled || syncFailed(result)) return;
        // The server returns only this caller's own grant on this route, so a
        // single row is the expected shape. More than one would mean an owner is
        // reading it, and `relation` has already ruled that out.
        const mine = result.data.delegations[0];
        if (mine) {
          setCanAddRows(mine.canAddRows);
          setGrantCanEdit(mine.canEdit);
        }
      })
      .catch(() => {
        // Permissive on failure, deliberately.
      });

    return () => {
      cancelled = true;
    };
  }, [ou, planId, ownership?.me.relation, nonce]);

  return useMemo<PlanScope>(() => {
    const departments = ownership?.departments ?? [];
    // A plan the server refuses to discuss has no writable departments and no
    // readable ones. An EMPTY set, never `undefined` — the two mean opposite
    // things here, and `undefined` is the one that unlocks the grid.
    const empty: ReadonlySet<string> = new Set<string>();
    // The grant's own `canEdit: false` clamps whatever the ownership answer
    // produced: it strips every write capability server-side, so no department
    // may stay writable under it however the enumeration was shaped.
    const writePolicy = clampToGrant(
      notShared
        ? NO_DEPARTMENT_WRITE
        : ownership === null
          ? undefined
          : departmentWritePolicy(ownership),
      grantCanEdit
    );
    return {
      ownership,
      writePolicy,
      holdsNoDepartment: writePolicy !== undefined && !holdsAnyDepartment(writePolicy),
      // A read-only delegate is working in no department, whatever the
      // enumeration says — presence must not report them as mid-edit.
      enumeratedWritable:
        notShared || grantCanEdit === false
          ? []
          : enumeratedWritableDepartments(ownership),
      readableDepartments: notShared
        ? empty
        : ownership === null
          ? undefined
          : new Set(departments.filter((row) => row.readable).map((row) => row.code)),
      relation: ownership?.me.relation ?? null,
      scopeKind: ownership?.me.scopeKind ?? null,
      // Unpublished plans keep the full editor — the demotion only applies to a
      // plan the server has an opinion about. A locked one is not unpublished.
      structureEditable: notShared ? false : ownership ? ownership.structureEditableByMe : true,
      // `canEdit: false` strips every write capability, adding rows included,
      // whatever the separate `canAddRows` flag was set to.
      canAddRows: notShared || grantCanEdit === false ? false : canAddRows,
      planLocked: notShared || ownership?.me.relation === "GLOBAL_ADMIN",
      unpublished,
      notShared,
      loading,
      error,
      refresh,
    };
  }, [ownership, unpublished, notShared, canAddRows, grantCanEdit, loading, error, refresh]);
}
