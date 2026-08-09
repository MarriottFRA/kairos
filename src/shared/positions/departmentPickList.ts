/**
 * What the Department picker may offer, and what it must show greyed.
 * ---------------------------------------------------------------------------
 * The picker used to offer every department in the hotel's reference data,
 * regardless of who could write them. Picking one you did not hold locked the
 * row you were editing — instantly, silently, and with no way back, because the
 * lock covered the picker too. The fix is to stop offering them.
 *
 * ## Narrow, never delete
 *
 * A department that is unavailable is shown, disabled, with the server's own
 * reason beside it. Removing it outright answers a different question from the
 * one being asked: somebody looking for Rooms and not finding it concludes the
 * reference data is broken, not that a colleague is holding it. The reasons come
 * from `lockReasonsByDepartment`, the same derivation the row menu and the
 * Delegation table use, so the surfaces cannot word it differently — including
 * the part that depends on who is reading.
 *
 * ## Why an owner and a delegate need different rules
 *
 * `/department-ownership` lists only departments this caller can READ, and it
 * enumerates only those that already have rows in the plan. That matters in one
 * direction only:
 *
 * - For a **delegate** the answer is the whole point. They hold three
 *   departments out of thirty and should see three, not thirty.
 * - For an **owner** it would be a regression. Intersecting with ownership makes
 *   it impossible to assign a position to a department nobody has used yet,
 *   which is a normal thing to do when a hotel opens a new outlet.
 *
 * This module used to be the only place that knew that, and it hand-wrote the
 * distinction as a FULL/PARTIAL branch. The grid's lock did not know it, so it
 * refused what this offered — a picked department locked the row instantly, and
 * the lock covered the picker, so there was no way back from a mis-click.
 *
 * The rule now lives in `departmentWritePolicy` and both read it: a full-scope
 * owner gets an open ceiling with a deny-list, everyone else an allow-list. What
 * is left here is presentation — which options to grey, and what to say on them.
 */

import type { DepartmentOption } from "../mappingTables/types";
import type { DepartmentOwnership } from "../kairosSync/protocol";
import { lockReasonsByDepartment } from "../kairosSync/lockReason";
import { canWriteDepartment, departmentWritePolicy } from "../kairosSync/writePolicy";

export interface LockedDepartmentOption extends DepartmentOption {
  /** Why it cannot be chosen, in the words the grid's banner already uses. */
  reason: string;
}

export interface DepartmentPickList {
  selectable: DepartmentOption[];
  /** Rendered, disabled, with the reason. Never silently dropped. */
  locked: LockedDepartmentOption[];
}

const UNRESTRICTED = (all: DepartmentOption[]): DepartmentPickList => ({
  selectable: all,
  locked: [],
});

export function departmentPickList(
  all: DepartmentOption[],
  ownership: DepartmentOwnership | null | undefined
): DepartmentPickList {
  // No server opinion: an unpublished plan behaves exactly as it always has.
  if (!ownership) return UNRESTRICTED(all);

  const policy = departmentWritePolicy(ownership);
  // Readable-but-not-writable, worded for whoever is being refused: an owner
  // must not be told a department was "handed back to the owner". Derived by
  // `lockReasonsByDepartment` rather than here so the picker, the row menu and
  // the Delegation table cannot word the same reason three ways.
  const reasonByCode = lockReasonsByDepartment(ownership);

  const selectable: DepartmentOption[] = [];
  const locked: LockedDepartmentOption[] = [];
  for (const option of all) {
    if (canWriteDepartment(policy, option.code)) {
      selectable.push(option);
      continue;
    }
    const reason = reasonByCode.get(option.code);
    // Refused, with a reason worth reading: greyed, never dropped. Refused and
    // not even readable: omitted entirely, because listing it would hand
    // somebody scoped to one department the shape of the whole hotel.
    if (reason !== undefined) locked.push({ ...option, reason });
  }

  // No early return for a revoked delegate: their `allow` is empty, so the loop
  // above already refuses every option and greys the ones they can still read.
  // The special case that used to be here said the same thing twice.
  return { selectable, locked };
}
