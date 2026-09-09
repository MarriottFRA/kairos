/**
 * The overlay (the BST as a push would leave it), the drift check (how far
 * the BST is from that), and the map index's inverse lookups. Pins the three
 * overlay rules, the allocation-share exclusion, the LEVEL recompute, the
 * tolerance that lets a ÷1000 / ×1000 round trip read as unchanged, and the
 * three rows a push can never reconcile (so the drift check must not count
 * them, or the push nudge outlives every push).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRIFT_TOLERANCE,
  UNAVAILABLE_MAP_INDEX,
  buildMapIndex,
  buildValueSource,
  comparePlanToBst,
  hasDrift,
  overlaySource,
} from "../sources";
import type { ComboEntry } from "../types";

const flat = (value: number) => new Array(12).fill(value);
const jan = (value: number) => [value, ...new Array(11).fill(0)];

const CLEAR_PREFIXES = ["5", "988", "97254"];
const clears = (account: string) => CLEAR_PREFIXES.some((p) => account.startsWith(p));
const owns = (entry: ComboEntry) => entry.valueKind !== "percent";

const CACHE = buildValueSource("kairos", [
  { dept: "D0410", account: "A511000", months: flat(1000), valueKind: "currency" },
  { dept: "D0410", account: "A972540", months: jan(4), total: 4, encoding: "LEVEL", valueKind: "count" },
  { dept: "D0410", account: "A988699", months: flat(640), valueKind: "count" },
  // A combo the BST does not hold at all.
  { dept: "D0510", account: "A560303", months: flat(50), valueKind: "currency" },
  // An allocation share: never overlaid.
  { dept: "D0410", account: "A701110", months: jan(15.23), valueKind: "percent" },
]);

// The share the user actually hit: an allocation split on an account their
// clear rules cover, plus the zero rows a pulled bucket is full of.
const SHARE_PREFIXES = [...CLEAR_PREFIXES, "9"];
const clearsShares = (account: string) => SHARE_PREFIXES.some((p) => account.startsWith(p));

const SHARE_CACHE = buildValueSource("kairos", [
  { dept: "D0410", account: "A511000", months: flat(1000), valueKind: "currency" },
  { dept: "D0012", account: "A914120", months: jan(85), valueKind: "percent" },
  { dept: "D0011", account: "A914120", months: jan(15), valueKind: "percent" },
  // Zero and absent from the BST: the push's `no_data`.
  { dept: "D0510", account: "A512400", months: flat(0), valueKind: "currency" },
]);

const SHARE_BST = buildValueSource("bst", [
  { dept: "D0410", account: "A511000", months: flat(1000) },
  { dept: "D0012", account: "A914120", months: jan(85) },
  { dept: "D0011", account: "A914120", months: jan(15) },
  // Empty in THIS bucket, kept by the import because another bucket has data.
  { dept: "D0010", account: "A520208", months: flat(0) },
  { dept: "D0010", account: "A988201", months: flat(0) },
]);

const BST = buildValueSource("bst", [
  { dept: "D0410", account: "A511000", months: flat(900) }, // stale — the plan moved
  { dept: "D0410", account: "A972540", months: jan(4) }, // LEVEL in the BST too
  { dept: "D0410", account: "A560303", months: flat(70) }, // in clear scope, gone from the plan
  { dept: "D0410", account: "A701110", months: flat(2000) }, // the BST's own allocation amount
  { dept: "D0100", account: "A400100", months: flat(50000) }, // revenue: untouched
]);

describe("overlaySource", () => {
  const merged = overlaySource("plan", BST, CACHE, owns, clears);

  it("replaces a BST combo with the cache's, and adds a cache-only one", () => {
    expect(merged.get("D0410", "A511000")!.vec[0]).toBe(1000);
    expect(merged.get("D0510", "A560303")!.vec[0]).toBe(50);
    expect(merged.get("D0410", "A988699")!.vec[0]).toBe(640);
  });

  it("drops a BST combo the clear rules cover that the plan no longer produces", () => {
    expect(merged.get("D0410", "A560303")).toBeUndefined();
  });

  it("keeps a BST combo outside the clear rules", () => {
    expect(merged.get("D0100", "A400100")!.vec[0]).toBe(50000);
  });

  it("never lays an allocation share over the BST's amount", () => {
    expect(merged.get("D0410", "A701110")!.vec[0]).toBe(2000);
  });

  it("recomputes the encoding and the report vector of an overlaid level row", () => {
    const heads = merged.get("D0410", "A972540")!;
    expect(heads.encoding).toBe("LEVEL");
    expect(Array.from(heads.reportVec)).toEqual([...flat(4), 4]);
    expect(heads.valueKind).toBe("count");
  });

  it("keeps the BST's allocation figure even when a clear rule covers it", () => {
    // The push guards an allocation row `skip` in the clear pass too, so
    // dropping it here would blank a figure no push would ever remove.
    const shares = overlaySource("plan", SHARE_BST, SHARE_CACHE, owns, clearsShares);
    expect(shares.get("D0012", "A914120")!.vec[0]).toBe(85);
    expect(shares.get("D0011", "A914120")!.vec[0]).toBe(15);
  });

  it("is a plain value source: a second overlay over it is idempotent", () => {
    const again = overlaySource("plan2", merged, CACHE, owns, clears);
    expect(again.entries.map((e) => `${e.dept}-${e.account}`).sort()).toEqual(
      merged.entries.map((e) => `${e.dept}-${e.account}`).sort()
    );
  });
});

describe("comparePlanToBst", () => {
  it("counts the three kinds of difference and ranks the movers", () => {
    const drift = comparePlanToBst(CACHE, BST, owns, clears);
    expect(drift.differing).toBe(1); // A511000 900 → 1000
    expect(drift.onlyInPlan).toBe(2); // D0510/A560303 and A988699
    expect(drift.onlyInBst).toBe(1); // D0410/A560303
    expect(hasDrift(drift)).toBe(true);
    expect(drift.absDelta[0]).toBe(100 + 50 + 640 + 70);
    expect(drift.absDelta[12]).toBe((100 + 50 + 640 + 70) * 12);
    expect(drift.top.map((t) => [t.account, t.kind])).toEqual([
      ["988699", "onlyInPlan"],
      ["511000", "differs"],
      ["560303", "onlyInBst"],
      ["560303", "onlyInPlan"],
    ]);
    expect(drift.top[2].delta[0]).toBe(-70);
  });

  it("is silent when the BST holds exactly what the plan produces", () => {
    const pushed = overlaySource("pushed", BST, CACHE, owns, clears);
    const drift = comparePlanToBst(CACHE, pushed, owns, clears);
    expect(drift).toMatchObject({ differing: 0, onlyInPlan: 0, onlyInBst: 0 });
    expect(hasDrift(drift)).toBe(false);
    expect(drift.top).toEqual([]);
  });

  it("ignores the noise of a ÷1000 / ×1000 round trip, but not a typed-over figure", () => {
    const plan = buildValueSource("k", [
      { dept: "D0410", account: "A511000", months: flat(1234.567) },
      { dept: "D0410", account: "A988699", months: flat(160.004) },
    ]);
    const roundTrip = buildValueSource("b", [
      { dept: "D0410", account: "A511000", months: flat((1234.567 / 1000) * 1000) },
      { dept: "D0410", account: "A988699", months: flat(160.004) },
    ]);
    expect(hasDrift(comparePlanToBst(plan, roundTrip, owns, clears))).toBe(false);

    const typedOver = buildValueSource("b2", [
      { dept: "D0410", account: "A511000", months: flat(1235) }, // 0.433 off: inside 0.5
      { dept: "D0410", account: "A988699", months: flat(160.02) }, // 0.016 off: a stat, outside 0.005
    ]);
    const drift = comparePlanToBst(plan, typedOver, owns, clears, DEFAULT_DRIFT_TOLERANCE);
    expect(drift.differing).toBe(1);
    expect(drift.top[0].account).toBe("988699");
  });

  it("only counts a BST-only combo when the clear rules would touch it", () => {
    const drift = comparePlanToBst(CACHE, BST, owns, () => false);
    expect(drift.onlyInBst).toBe(0);
  });

  it("stays silent over rows no push can reconcile", () => {
    // An allocation share the plan holds but does not push, and rows the pull
    // brought back as zeroes: before, every one of these counted as "the push
    // would clear", so the banner survived a faithful push and pull.
    const drift = comparePlanToBst(SHARE_CACHE, SHARE_BST, owns, clearsShares);
    expect(drift).toMatchObject({ differing: 0, onlyInPlan: 0, onlyInBst: 0 });
    expect(hasDrift(drift)).toBe(false);
    expect(drift.absDelta[12]).toBe(0);
  });

  it("still counts a BST row inside the clear rules that holds a figure", () => {
    const bst = buildValueSource("bst2", [
      ...SHARE_BST.entries.map((e) => ({ dept: e.dept, account: e.account, months: e.vec.subarray(0, 12) })),
      { dept: "D0010", account: "A510502", months: jan(120) },
    ]);
    const drift = comparePlanToBst(SHARE_CACHE, bst, owns, clearsShares);
    expect(drift.onlyInBst).toBe(1);
    expect(drift.top.map((t) => t.account)).toEqual(["510502"]);
    expect(drift.absDelta[12]).toBe(120);
  });
});

describe("MapIndex inverse lookups", () => {
  const levels = (entries: Record<number, string>) =>
    Array.from({ length: 31 }, (_, i) => entries[i] ?? null);
  const maps = buildMapIndex(
    "v1",
    [{ code: "D0410", levels: levels({ 2: "Lodging Operations", 7: " Administrative & General " }), name: "Admin" }],
    [{ code: "A511000", levels: levels({ 9: "Total Payroll" }) }]
  );

  it("answers a code's label at a level, trimmed, either spelling", () => {
    expect(maps.labelAt("dept", "0410", 7)).toBe("Administrative & General");
    expect(maps.labelAt("dept", "D0410", 2)).toBe("Lodging Operations");
    expect(maps.labelAt("account", "511000", 9)).toBe("Total Payroll");
  });

  it("answers null for a blank cell, an unmapped code, and the never-synced index", () => {
    expect(maps.labelAt("dept", "D0410", 3)).toBeNull();
    expect(maps.labelAt("account", "A999999", 9)).toBeNull();
    expect(maps.name("dept", "D0410")).toBe("Admin");
    expect(maps.name("account", "A511000")).toBeNull();
    expect(UNAVAILABLE_MAP_INDEX.labelAt("dept", "D0410", 7)).toBeNull();
    expect(UNAVAILABLE_MAP_INDEX.name("dept", "D0410")).toBeNull();
  });
});
