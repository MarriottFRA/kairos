/**
 * Social Security / NI scheme repository — CRUD, OU scoping, the updated_at
 * fingerprint invariant, and validation parity with the engine compiler.
 * In-memory database (the blocksRepo/clustersRepo pattern).
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { POSITIONS_STRUCTURE_TABLES_SQL } from "../../positions/schema";
import { resolveOuScope } from "../../positions/ouScope";
import { getSsSchemes } from "../../positions/structureRepo";
import { SsSchemeInput } from "../../../shared/socialSecurity/ipc";
import { deleteScheme, saveScheme } from "../repo";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const OTHER = resolveOuScope("OU99999");
const NOW = { now: "2026-07-24T00:00:00.000Z" };
const LATER = { now: "2026-07-25T00:00:00.000Z" };

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(POSITIONS_STRUCTURE_TABLES_SQL);
});

const scheme = (over: Partial<SsSchemeInput> = {}): SsSchemeInput => ({
  label: "UK NI",
  monthlyCap: null,
  yearlyCap: null,
  brackets: [
    { upTo: 1048, rate: 0 }, // tax-free band
    { upTo: 4189, rate: 0.08 },
    { upTo: null, rate: 0.02 }, // unbounded top band
  ],
  ...over,
});

describe("saveScheme + getSsSchemes", () => {
  it("round-trips a scheme with ordered brackets + caps", () => {
    const id = saveScheme(
      db,
      SCOPE,
      scheme({ monthlyCap: 5000, yearlyCap: 60000 }),
      NOW
    );
    const schemes = getSsSchemes(db, SCOPE);
    expect(schemes).toHaveLength(1);
    expect(schemes[0].id).toBe(id);
    expect(schemes[0].label).toBe("UK NI");
    expect(schemes[0].monthlyCap).toBe(5000);
    expect(schemes[0].yearlyCap).toBe(60000);
    expect(schemes[0].brackets).toEqual(scheme().brackets);
    expect(schemes[0].updatedAt).toBe(NOW.now);
  });

  it("defaults the contributory base to base salary + vacation, no components", () => {
    saveScheme(db, SCOPE, scheme(), NOW);
    const [saved] = getSsSchemes(db, SCOPE);
    expect(saved.includeBaseSalary).toBe(true);
    expect(saved.includeVacation).toBe(true);
    expect(saved.baseComponentIds).toEqual([]);
  });

  it("round-trips an explicit contributory base membership", () => {
    saveScheme(
      db,
      SCOPE,
      scheme({
        includeBaseSalary: false,
        includeVacation: true,
        baseComponentIds: ["blkA:cost", "blkB:cost"],
      }),
      NOW
    );
    const [saved] = getSsSchemes(db, SCOPE);
    expect(saved.includeBaseSalary).toBe(false);
    expect(saved.includeVacation).toBe(true);
    expect(saved.baseComponentIds).toEqual(["blkA:cost", "blkB:cost"]);
  });

  it("updates in place, re-stamps updated_at, and rewrites brackets", () => {
    const id = saveScheme(db, SCOPE, scheme(), NOW);
    saveScheme(
      db,
      SCOPE,
      { id, label: "UK NI v2", monthlyCap: null, yearlyCap: null, brackets: [{ upTo: null, rate: 0.1 }] },
      LATER
    );
    const schemes = getSsSchemes(db, SCOPE);
    expect(schemes).toHaveLength(1);
    expect(schemes[0].label).toBe("UK NI v2");
    expect(schemes[0].brackets).toEqual([{ upTo: null, rate: 0.1 }]);
    expect(schemes[0].updatedAt).toBe(LATER.now);
  });

  it("scopes schemes by OU", () => {
    saveScheme(db, SCOPE, scheme(), NOW);
    expect(getSsSchemes(db, SCOPE)).toHaveLength(1);
    expect(getSsSchemes(db, OTHER)).toHaveLength(0);
  });

  it("refuses to update a scheme from another OU", () => {
    const id = saveScheme(db, SCOPE, scheme(), NOW);
    expect(() =>
      saveScheme(db, OTHER, { ...scheme(), id }, LATER)
    ).toThrow(/no longer exists/);
  });
});

describe("validation (matches the engine compiler + UX guardrails)", () => {
  it("rejects an empty label", () => {
    expect(() => saveScheme(db, SCOPE, scheme({ label: "  " }), NOW)).toThrow(/name/i);
  });

  it("rejects more than 7 bands", () => {
    const brackets = Array.from({ length: 8 }, (_, i) => ({ upTo: (i + 1) * 100, rate: 0.1 }));
    brackets[7].upTo = null;
    expect(() => saveScheme(db, SCOPE, scheme({ brackets }), NOW)).toThrow(/1 to 7/);
  });

  it("rejects non-ascending bounds", () => {
    expect(() =>
      saveScheme(db, SCOPE, scheme({ brackets: [{ upTo: 5000, rate: 0 }, { upTo: 2000, rate: 0.1 }] }), NOW)
    ).toThrow(/ascend/i);
  });

  it("rejects an unbounded band that is not last", () => {
    expect(() =>
      saveScheme(db, SCOPE, scheme({ brackets: [{ upTo: null, rate: 0.1 }, { upTo: 5000, rate: 0.2 }] }), NOW)
    ).toThrow(/unbounded/i);
  });

  it("rejects a negative cap", () => {
    expect(() => saveScheme(db, SCOPE, scheme({ monthlyCap: -1 }), NOW)).toThrow(/cap/i);
  });
});

describe("deleteScheme", () => {
  it("soft-deletes so the scheme drops from the list", () => {
    const id = saveScheme(db, SCOPE, scheme(), NOW);
    deleteScheme(db, SCOPE, id, LATER);
    expect(getSsSchemes(db, SCOPE)).toHaveLength(0);
  });

  it("throws when the scheme is already gone", () => {
    expect(() => deleteScheme(db, SCOPE, "nope", LATER)).toThrow(/no longer exists/);
  });
});
