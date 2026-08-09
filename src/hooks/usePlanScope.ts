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
 * `writableDepartments` is `undefined` and every consumer treats that as "all of
 * it" — exactly how the app behaved before sync existed. A hotel that never opts
 * in must never notice this hook exists. That is why `undefined` and "an empty
 * set" mean opposite things here and are kept carefully distinct.
 *
 * ## The answer is the server's, not a guess
 *
 * `writable` comes straight from `/department-ownership`, where it IS the
 * server's write predicate — so the grid can never disagree with what a save
 * will actually do. Notably an OWNER is reported as unable to write a department
 * they have DELEGATED; their route back is to withdraw the delegation.
 *
 * The call is ETag'd server-side and cached in the encrypted store, so a refresh
 * costs a conditional request rather than a rebuild.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { departmentOwnership } from "../services/kairosSyncService";
import { syncFailed } from "../shared/kairosSync/ipc";
import {
  DepartmentOwnership,
  DepartmentOwnershipRow,
  Relation,
} from "../shared/kairosSync/protocol";

export interface PlanScope {
  /** Null until the first answer arrives, or when the plan is unpublished. */
  ownership: DepartmentOwnership | null;
  /**
   * Departments the user may write. `undefined` means "no server-side opinion" —
   * unpublished plan, or the lookup has not resolved — and every consumer reads
   * that as unrestricted.
   */
  writableDepartments: ReadonlySet<string> | undefined;
  /** Departments the user may READ. Looser than write: it includes handbacks. */
  readableDepartments: ReadonlySet<string> | undefined;
  relation: Relation | null;
  /** PARTIAL disables allocations, results totals and BST push. See §5.4. */
  scopeKind: "FULL" | "PARTIAL" | null;
  /** False for a demoted owner: hide the blocks/allocations/KPI/SS editors. */
  structureEditable: boolean;
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
  /** Rows the user can see but not edit, with the reason, for the grid banner. */
  lockedDepartments: DepartmentOwnershipRow[];
  loading: boolean;
  /** Non-null only for a real failure; an unpublished plan is not an error. */
  error: string | null;
  refresh: () => void;
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

export function usePlanScope(
  ou: string | null,
  planId: string | null
): PlanScope {
  const [ownership, setOwnership] = useState<DepartmentOwnership | null>(null);
  const [unpublished, setUnpublished] = useState(true);
  const [notShared, setNotShared] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

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

    departmentOwnership(ou, planId)
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

  return useMemo<PlanScope>(() => {
    const departments = ownership?.departments ?? [];
    // A plan the server refuses to discuss has no writable departments and no
    // readable ones. An EMPTY set, never `undefined` — the two mean opposite
    // things here, and `undefined` is the one that unlocks the grid.
    const empty: ReadonlySet<string> = new Set<string>();
    return {
      ownership,
      // Sets, not arrays: the grid consults these for every rendered cell.
      writableDepartments: notShared
        ? empty
        : ownership === null
          ? undefined
          : new Set(departments.filter((row) => row.writable).map((row) => row.code)),
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
      planLocked: notShared || ownership?.me.relation === "GLOBAL_ADMIN",
      unpublished,
      notShared,
      lockedDepartments: departments.filter((row) => row.readable && !row.writable),
      loading,
      error,
      refresh,
    };
  }, [ownership, unpublished, notShared, loading, error, refresh]);
}
