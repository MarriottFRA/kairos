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
 * `/department-ownership` lists only departments this caller can READ, and it is
 * not established whether that enumerates departments with no rows in them yet.
 * That matters in one direction only:
 *
 * - For a **delegate** the answer is the whole point. They hold three
 *   departments out of thirty and should see three, not thirty.
 * - For an **owner** it would be a regression. Intersecting with ownership could
 *   make it impossible to assign a position to a department nobody has used yet,
 *   which is a normal thing to do when a hotel opens a new outlet.
 *
 * So a FULL scope starts from the reference data and only ever SUBTRACTS what
 * has been delegated away; a PARTIAL scope starts from what the server says it
 * holds. If the enumeration question is ever settled the two branches collapse
 * into one intersection.
 */

import type { DepartmentOption } from "../mappingTables/types";
import type { DepartmentOwnership } from "../kairosSync/protocol";
import { lockReasonsByDepartment } from "../kairosSync/lockReason";

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
  ownership: DepartmentOwnership | null | undefined,
  scopeKind: "FULL" | "PARTIAL" | null
): DepartmentPickList {
  // No server opinion: an unpublished plan behaves exactly as it always has.
  if (!ownership) return UNRESTRICTED(all);

  const writable = new Set<string>();
  for (const row of ownership.departments) {
    if (row.writable) writable.add(row.code);
  }
  // Readable-but-not-writable, worded for whoever is being refused: an owner
  // must not be told a department was "handed back to the owner". Derived by
  // `lockReasonsByDepartment` rather than here so the picker, the row menu and
  // the Delegation table cannot word the same reason three ways.
  const reasonByCode = lockReasonsByDepartment(ownership);

  // A revoked delegate holds nothing. Everything they can still see is locked,
  // and offering them a choice would be a lie about what a save would do.
  if (writable.size === 0) {
    return {
      selectable: [],
      locked: all
        .filter((option) => reasonByCode.has(option.code))
        .map((option) => ({
          ...option,
          reason: reasonByCode.get(option.code) as string,
        })),
    };
  }

  if (scopeKind === "PARTIAL") {
    const selectable: DepartmentOption[] = [];
    const locked: LockedDepartmentOption[] = [];
    for (const option of all) {
      if (writable.has(option.code)) {
        selectable.push(option);
      } else if (reasonByCode.has(option.code)) {
        locked.push({ ...option, reason: reasonByCode.get(option.code) as string });
      }
      // Neither readable nor writable: not this delegate's business at all, and
      // listing it would hand somebody scoped to one department the shape of the
      // whole hotel.
    }
    return { selectable, locked };
  }

  // FULL, or an unknown scope kind treated as full. Reference data is the source
  // of truth and ownership only subtracts — see the module note.
  const selectable: DepartmentOption[] = [];
  const locked: LockedDepartmentOption[] = [];
  for (const option of all) {
    const reason = reasonByCode.get(option.code);
    if (reason !== undefined && !writable.has(option.code)) {
      locked.push({ ...option, reason });
    } else {
      selectable.push(option);
    }
  }
  return { selectable, locked };
}
