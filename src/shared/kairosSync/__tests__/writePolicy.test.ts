/**
 * The write-policy derivations, and the one shape none of the other suites
 * ever built: the READ-ONLY delegation.
 *
 * `canEdit: false` leaves the relation a plain DELEGATE on the wire, so
 * nothing about the capability table catches it — the read-only-ness lives
 * only in the ownership body's `writable` flags and in the grant's own
 * `canEdit`. Every fixture elsewhere has at least one `writable: true` row,
 * which is exactly how the all-false shape went untested while two code paths
 * (the publish fallback's open ceiling, and the unread `canEdit`) let a
 * full-scope read-only delegate edit.
 */

import { describe, expect, it } from "vitest";
import type { DepartmentOwnership, DepartmentOwnershipRow } from "../protocol";
import {
  NO_DEPARTMENT_WRITE,
  UNRESTRICTED_WRITE,
  allowOnly,
  canWriteDepartment,
  clampToGrant,
  departmentWritePolicy,
  headFallbackWritePolicy,
  holdsAnyDepartment,
} from "../writePolicy";

function delegateOwnership(
  writable: boolean,
  codes: string[] = ["D0410", "D0610"]
): DepartmentOwnership {
  return {
    planId: "plan-1",
    planVersion: 1,
    authzVersion: 1,
    me: { relation: "DELEGATE", scopeKind: "FULL" },
    structureEditableByMe: false,
    departments: codes.map((code): DepartmentOwnershipRow => ({
      code,
      readable: true,
      writable,
      reason: writable ? null : "NOT_IN_WRITE_SCOPE",
      assignedTo: [],
    })),
  };
}

describe("departmentWritePolicy", () => {
  it("gives a read-only full-scope delegate nothing at all", () => {
    // The delegate holds EVERY department, readable, and none writable. FULL
    // scope must not widen them: the ceiling stays closed and empty.
    const policy = departmentWritePolicy(delegateOwnership(false));
    expect(holdsAnyDepartment(policy)).toBe(false);
    expect(canWriteDepartment(policy, "D0410")).toBe(false);
    expect(canWriteDepartment(policy, "D0610")).toBe(false);
    // Including a department the answer never enumerated — absence is not an
    // opening for anybody but an owner.
    expect(canWriteDepartment(policy, "D0910")).toBe(false);
  });

  it("keeps a writing full-scope delegate on the enumerated allow-list", () => {
    const policy = departmentWritePolicy(delegateOwnership(true));
    expect(canWriteDepartment(policy, "D0410")).toBe(true);
    expect(canWriteDepartment(policy, "D0910")).toBe(false);
  });
});

describe("headFallbackWritePolicy", () => {
  it("keeps the open ceiling for an owner with a FULL head", () => {
    const policy = headFallbackWritePolicy("OWNER", "FULL", null);
    expect(policy).toEqual(UNRESTRICTED_WRITE);
  });

  it("keeps the open ceiling for an owner with no head at all", () => {
    // A brand-new plan's first publish: nothing cached, no head, and the
    // scenario row still has to go up.
    const policy = headFallbackWritePolicy("OWNER", null, null);
    expect(policy).toEqual(UNRESTRICTED_WRITE);
  });

  it("bounds an owner with a PARTIAL head to its departments", () => {
    const policy = headFallbackWritePolicy("OWNER_DEGRADED", "PARTIAL", ["D0410"]);
    expect(canWriteDepartment(policy, "D0410")).toBe(true);
    expect(canWriteDepartment(policy, "D0610")).toBe(false);
  });

  it("never opens the ceiling for a FULL-scope delegate", () => {
    // The bug this function exists to close: "all departments" made the
    // fallback unrestricted, which skipped the read-only refusal entirely.
    const policy = headFallbackWritePolicy("DELEGATE", "FULL", ["D0410", "D0610"]);
    expect(policy.allow).not.toBeNull();
    expect(canWriteDepartment(policy, "D0410")).toBe(true);
    expect(canWriteDepartment(policy, "D0910")).toBe(false);
  });

  it("gives a delegate with no department list nothing, not everything", () => {
    const policy = headFallbackWritePolicy("DELEGATE", "FULL", null);
    expect(holdsAnyDepartment(policy)).toBe(false);
  });

  it("fails closed on a relation it has never heard of", () => {
    const policy = headFallbackWritePolicy("OU_SOMETHING_NEW", "FULL", null);
    expect(holdsAnyDepartment(policy)).toBe(false);
  });
});

describe("clampToGrant", () => {
  it("strips every write when the grant says canEdit: false", () => {
    // Whatever the ownership answer was shaped like — `writable` describes who
    // HOLDS a department, and a read-only delegate displaces nobody, so an
    // answer built from displacement alone can read writable everywhere.
    expect(clampToGrant(UNRESTRICTED_WRITE, false)).toEqual(NO_DEPARTMENT_WRITE);
    expect(clampToGrant(allowOnly(["D0410"]), false)).toEqual(NO_DEPARTMENT_WRITE);
    expect(clampToGrant(undefined, false)).toEqual(NO_DEPARTMENT_WRITE);
  });

  it("changes nothing for canEdit: true", () => {
    const policy = allowOnly(["D0410"]);
    expect(clampToGrant(policy, true)).toBe(policy);
  });

  it("changes nothing when the flag was never learned", () => {
    // Permissive on failure, same rule as canAddRows: the server enforces
    // either way, and an offline delegate must not lose access they hold.
    const policy = allowOnly(["D0410"]);
    expect(clampToGrant(policy, undefined)).toBe(policy);
    expect(clampToGrant(undefined, undefined)).toBeUndefined();
  });
});
