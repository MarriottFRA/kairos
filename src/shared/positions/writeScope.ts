/**
 * "May I edit this row?" — asked once, answered in one place.
 * ---------------------------------------------------------------------------
 * The department lock had three independent copies of the same predicate: the
 * cell-editability resolver in `columnFactory`, the row-menu guard in
 * `PositionsGrid`, and the save backstop in the positions page. Three copies of
 * a permission rule is three chances for the grid to offer an edit the save then
 * refuses — so they now all call this.
 *
 * ## The states, and why they are not two
 *
 * The answer is a `DepartmentWritePolicy` — see `shared/kairosSync/writePolicy`,
 * which derives it once from `/department-ownership` for the grid, the picker
 * and the publish filter alike. Omitting it entirely still means "no server-side
 * opinion": an unpublished plan, or an ownership call that has not resolved yet,
 * where everything is editable exactly as the app behaved before sync existed.
 *
 * The case worth restating here is the one that used to be wrong. A full-scope
 * OWNER gets an open ceiling with a deny-list, because `/department-ownership`
 * enumerates only departments that already have rows — so a department nobody
 * has used yet is absent from it, and absent is not refused. A DELEGATE gets an
 * allow-list, because for them the enumeration is the point. Either way an owner
 * is still locked out of a department they have DELEGATED; that arrives as an
 * explicit `deny` and their route back is to withdraw the delegation.
 *
 * ## The unassigned row
 *
 * A row with no department used to be locked outright, on the reasoning that the
 * server routes department-less rows to the owner-only branch. That reasoning is
 * sound about PUBLISHING and wrong about EDITING, and the difference stranded
 * people: a new row is born with no department, the lock covered the department
 * picker itself, and so a delegate could not give a row they had just created
 * the one value that would unlock it — not through the grid, not through the row
 * form, not through a paste.
 *
 * So an unassigned row is editable whenever the user has any department at all.
 * **The publish rule is unchanged**: `filterToWriteScope` still withholds
 * department-less rows from anyone without structure rights, and the grid tints
 * them so it is visible that they are unfinished rather than merely new.
 */

import {
  DepartmentWritePolicy,
  canWriteDepartment,
  holdsAnyDepartment,
} from "../kairosSync/writePolicy";
import { DEPARTMENT_CODE_KEY } from "./fields";

export interface PositionWriteScope {
  /** Omitted = no server opinion at all. See `departmentWritePolicy`. */
  writePolicy?: DepartmentWritePolicy;
  /** An administrator holds an exclusive lease: the whole plan is read-only. */
  planLocked?: boolean;
}

/**
 * Any grid row that carries a department code.
 *
 * Structural rather than `PositionRow`, because Manual Input rows are
 * department-scoped in exactly the same way — `manual_input_row` is in
 * `DEPARTMENT_ENTITY_TYPES` and the publish filter treats it identically — and a
 * second copy of this predicate for a second grid is precisely what the module
 * note above says went wrong the first time. `ManualGridRow` names the field
 * explicitly; `PositionRow` supplies it through its index signature.
 */
export interface DepartmentScopedRow {
  /**
   * Declared so this is not a "weak type".
   *
   * With `departmentCode` optional and nothing else on the interface, TypeScript
   * rejects every argument whose declared members do not overlap — including
   * `PositionRow`, which supplies the field through an index signature. Every
   * grid row has an id, so requiring it costs nothing and makes the structural
   * match work in both directions.
   */
  readonly id: string;
  readonly departmentCode?: unknown;
}

/** The row's department code, or `""`. The one place this coercion happens. */
export function departmentCodeOf(row: DepartmentScopedRow | undefined): string {
  const value = (row as unknown as Record<string, unknown> | undefined)?.[
    DEPARTMENT_CODE_KEY
  ];
  return typeof value === "string" ? value : "";
}

/**
 * A row that has not been given a department yet, on a plan where that matters.
 *
 * False when there is no scope at all — an unpublished plan has no owner-only
 * branch to fall foul of, so an empty department there is not "unfinished", it
 * is just how that hotel works.
 */
export function departmentUnassigned(
  row: DepartmentScopedRow | undefined,
  scope: PositionWriteScope
): boolean {
  if (scope.writePolicy === undefined) return false;
  return departmentCodeOf(row) === "";
}

export function rowDepartmentWritable(
  row: DepartmentScopedRow | undefined,
  scope: PositionWriteScope
): boolean {
  if (!row) return true;
  if (scope.planLocked) return false;

  const policy = scope.writePolicy;
  if (policy === undefined) return true;

  const code = departmentCodeOf(row);
  // No department yet. Editable if this user holds anything at all — which is
  // what lets them pick one. A revoked delegate holds nothing and stays locked.
  if (code === "") return holdsAnyDepartment(policy);
  return canWriteDepartment(policy, code);
}
