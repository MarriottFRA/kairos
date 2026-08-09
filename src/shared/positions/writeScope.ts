/**
 * "May I edit this row?" — asked once, answered in one place.
 * ---------------------------------------------------------------------------
 * The department lock had three independent copies of the same predicate: the
 * cell-editability resolver in `columnFactory`, the row-menu guard in
 * `PositionsGrid`, and the save backstop in the positions page. Three copies of
 * a permission rule is three chances for the grid to offer an edit the save then
 * refuses — so they now all call this.
 *
 * ## The three states, and why they are not two
 *
 * - **`undefined`** — no server-side opinion. An unpublished plan, or the
 *   ownership call has not resolved yet. Everything is editable, which is
 *   exactly how the app behaved before sync existed; a hotel that never opts in
 *   must not notice this code exists.
 * - **An empty set** — the opposite. A revoked delegate, or a read-only share.
 *   Nothing is editable. Collapsing this into `undefined` hands a revoked
 *   delegate a fully editable grid.
 * - **A populated set** — the server's own write predicate, verbatim from
 *   `/department-ownership`, so the grid cannot disagree with what a save does.
 *   Note that an OWNER is reported as unable to write a department they have
 *   DELEGATED; their route back is to withdraw the delegation.
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

import { DEPARTMENT_CODE_KEY } from "./fields";

export interface PositionWriteScope {
  /** `undefined` = no server opinion. An empty Set = nothing writable. */
  writableDepartments?: ReadonlySet<string>;
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
  if (scope.writableDepartments === undefined) return false;
  return departmentCodeOf(row) === "";
}

export function rowDepartmentWritable(
  row: DepartmentScopedRow | undefined,
  scope: PositionWriteScope
): boolean {
  if (!row) return true;
  if (scope.planLocked) return false;

  const writable = scope.writableDepartments;
  if (writable === undefined) return true;

  const code = departmentCodeOf(row);
  // No department yet. Editable if this user holds anything at all — which is
  // what lets them pick one. A revoked delegate holds nothing and stays locked.
  if (code === "") return writable.size > 0;
  return writable.has(code);
}
