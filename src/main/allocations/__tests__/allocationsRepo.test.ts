/**
 * Allocations repository tests — CRUD against in-memory SQLite: save/list/delete
 * round-trip, name-clash rejection, invalid-base rejection, OU isolation, and
 * soft-delete hiding.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { resolveOuScope } from "../../positions/ouScope";
import { ALLOCATIONS_SQL } from "../schema";
import { deleteAllocation, listAllocations, saveAllocation } from "../repo";

type Db = InstanceType<typeof Database>;

const OU_A = resolveOuScope("OU12345");
const OU_B = resolveOuScope("OU99999");
const NOW = { now: "2026-01-01T00:00:00.000Z" };

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(ALLOCATIONS_SQL);
});

describe("saveAllocation / listAllocations", () => {
  it("creates and reads back an allocation", () => {
    const id = saveAllocation(
      db,
      OU_A,
      { name: "Laundry", spreadBase: "HEADCOUNT", excludedDepartments: ["LN"] },
      NOW
    );
    const list = listAllocations(db, OU_A);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      name: "Laundry",
      spreadBase: "HEADCOUNT",
      excludedDepartments: ["LN"],
    });
  });

  it("updates an existing allocation in place", () => {
    const id = saveAllocation(
      db,
      OU_A,
      { name: "Meal", spreadBase: "FTE", excludedDepartments: [] },
      NOW
    );
    saveAllocation(
      db,
      OU_A,
      { id, name: "Employee Meal", spreadBase: "BASE_SALARY", excludedDepartments: ["FB"] },
      { now: "2026-02-01T00:00:00.000Z" }
    );
    const list = listAllocations(db, OU_A);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      name: "Employee Meal",
      spreadBase: "BASE_SALARY",
      excludedDepartments: ["FB"],
    });
  });

  it("rejects a duplicate name (case-insensitive) in the same OU", () => {
    saveAllocation(db, OU_A, { name: "Laundry", spreadBase: "FLAT", excludedDepartments: [] }, NOW);
    expect(() =>
      saveAllocation(db, OU_A, { name: "laundry", spreadBase: "FTE", excludedDepartments: [] }, NOW)
    ).toThrow(/already exists/i);
  });

  it("rejects an invalid spread base", () => {
    expect(() =>
      saveAllocation(
        db,
        OU_A,
        { name: "Bad", spreadBase: "NONSENSE" as never, excludedDepartments: [] },
        NOW
      )
    ).toThrow(/spread base/i);
  });

  it("rejects a blank name", () => {
    expect(() =>
      saveAllocation(db, OU_A, { name: "   ", spreadBase: "FLAT", excludedDepartments: [] }, NOW)
    ).toThrow(/name is required/i);
  });

  it("isolates allocations by OU and allows the same name in another OU", () => {
    saveAllocation(db, OU_A, { name: "Laundry", spreadBase: "FLAT", excludedDepartments: [] }, NOW);
    expect(() =>
      saveAllocation(db, OU_B, { name: "Laundry", spreadBase: "FTE", excludedDepartments: [] }, NOW)
    ).not.toThrow();
    expect(listAllocations(db, OU_A)).toHaveLength(1);
    expect(listAllocations(db, OU_B)).toHaveLength(1);
  });

  it("de-dupes and trims excluded departments", () => {
    saveAllocation(
      db,
      OU_A,
      { name: "Laundry", spreadBase: "HEADCOUNT", excludedDepartments: [" LN ", "LN", "", "FB"] },
      NOW
    );
    expect(listAllocations(db, OU_A)[0].excludedDepartments).toEqual(["LN", "FB"]);
  });
});

describe("deleteAllocation", () => {
  it("soft-deletes and hides the allocation, freeing the name for reuse", () => {
    const id = saveAllocation(
      db,
      OU_A,
      { name: "Laundry", spreadBase: "FLAT", excludedDepartments: [] },
      NOW
    );
    deleteAllocation(db, OU_A, id, NOW);
    expect(listAllocations(db, OU_A)).toHaveLength(0);
    // Name is free again.
    expect(() =>
      saveAllocation(db, OU_A, { name: "Laundry", spreadBase: "FTE", excludedDepartments: [] }, NOW)
    ).not.toThrow();
  });

  it("throws when deleting an unknown allocation", () => {
    expect(() => deleteAllocation(db, OU_A, "missing", NOW)).toThrow(/no longer exists/i);
  });
});
