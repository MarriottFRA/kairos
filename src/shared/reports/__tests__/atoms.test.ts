/**
 * Atoms: filters → code sets → a summed vector, against in-memory sources
 * and a map index built from literals. Pins the residual (`not_in`) rules,
 * code normalisation, the LEVEL running sum, and that base/prefix atoms never
 * touch the maps.
 */

import { describe, expect, it } from "vitest";
import { normalizeAtom, resolveSide, sumAtom } from "../atoms";
import {
  MapIndex,
  UNAVAILABLE_MAP_INDEX,
  buildMapIndex,
  buildValueSource,
} from "../sources";
import type { Atom, ReportWarning } from "../types";
import * as vec from "../vec";

const flat = (value: number) => new Array(12).fill(value);
const jan = (value: number) => [value, ...new Array(11).fill(0)];

const SOURCE = buildValueSource("test", [
  { dept: "D0410", account: "A511000", months: flat(100) },
  { dept: "0410", account: "A560303", months: flat(10) },
  { dept: "D0510", account: "a511000", months: flat(200) },
  { dept: "D0510", account: "A560303", months: flat(20) },
  { dept: "D0600", account: "A511000", months: flat(300) },
  { dept: "D0410", account: "A972540", months: jan(5), total: 5, encoding: "LEVEL" },
  { dept: "D0510", account: "A972540", months: [3, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0], total: 2, encoding: "LEVEL" },
  { dept: "D0410", account: "A988699", months: flat(160), encoding: "MIXED" },
  { dept: "D9999", account: "A511000", months: flat(1) }, // unmapped department
]);

const levels = (entries: Record<number, string>) =>
  Array.from({ length: 31 }, (_, i) => entries[i] ?? null);

const MAPS: MapIndex = buildMapIndex(
  "v1",
  [
    { code: "D0410", levels: levels({ 2: "Lodging Operations", 7: "Administrative & General" }) },
    { code: "0510", levels: levels({ 2: "Lodging Operations", 7: "Rooms and Reservation" }) },
    { code: "D0600", levels: levels({ 2: "Owner", 7: "Owner Departments" }) },
  ],
  [
    { code: "A511000", levels: levels({ 9: "Total Payroll", 12: "Associate Wages" }) },
    { code: "560303", levels: levels({ 9: "Total Payroll", 12: "Associate Benefits" }) },
    { code: "A972540", levels: levels({ 9: "Statistics" }) },
    { code: "A988699", levels: levels({ 9: "Statistics" }) },
  ]
);

const THROWING_MAPS: MapIndex = {
  version: "x",
  available: true,
  deptCodes: () => {
    throw new Error("maps consulted");
  },
  accountCodes: () => {
    throw new Error("maps consulted");
  },
  hasDept: () => true,
  hasAccount: () => true,
  warnings: [],
};

function sum(atom: Atom, maps: MapIndex = MAPS) {
  const warnings: ReportWarning[] = [];
  const out = vec.toArray(sumAtom(normalizeAtom(atom), SOURCE, maps, (w) => warnings.push(w)));
  return { out, warnings };
}

describe("normalizeAtom", () => {
  it("normalises codes and prefixes to the bare form, either spelling", () => {
    const atom = normalizeAtom({
      id: "a",
      filters: [
        { kind: "dept_base", codes: [" d0410 ", "0510"] },
        { kind: "acc_prefix", prefixes: ["A988", "97"] },
      ],
    });
    expect(atom.dept).toEqual([{ kind: "base", codes: new Set(["0410", "0510"]) }]);
    expect(atom.account).toEqual([{ kind: "prefix", prefixes: ["988", "97"] }]);
    expect(atom.usesMaps).toBe(false);
    expect(atom.source).toEqual({ source: "kairos" });
  });

  it("rejects an out-of-range level and empty value lists", () => {
    expect(() =>
      normalizeAtom({ id: "a", filters: [{ kind: "acc_level", level: 31, values: ["x"] }] })
    ).toThrow(/level must be an integer between 0 and 30/);
    expect(() =>
      normalizeAtom({ id: "a", filters: [{ kind: "acc_base", codes: [] }] })
    ).toThrow(/codes must be a non-empty list/);
    expect(() =>
      normalizeAtom({ id: "a", filters: [{ kind: "acc_base", codes: [" "] }] })
    ).toThrow(/at least one non-blank value/);
  });
});

describe("resolveSide", () => {
  const resolve = (filters: Atom["filters"], side: "dept" | "account", maps = MAPS) => {
    const atom = normalizeAtom({ id: "r", filters });
    const out = resolveSide("r", side, side === "dept" ? atom.dept : atom.account, SOURCE, maps, () => {});
    return out === "all" ? "all" : [...out].sort();
  };

  it("is 'all' with no filters on the side", () => {
    expect(resolve([{ kind: "acc_base", codes: ["A511000"] }], "dept")).toBe("all");
  });

  it("resolves base, prefix and level filters, and intersects them", () => {
    expect(resolve([{ kind: "dept_base", codes: ["D0410", "D0510"] }], "dept")).toEqual(["0410", "0510"]);
    expect(resolve([{ kind: "acc_prefix", prefixes: ["A5"] }], "account")).toEqual(["511000", "560303"]);
    expect(resolve([{ kind: "dept_level", level: 2, values: ["Lodging Operations"] }], "dept")).toEqual([
      "0410",
      "0510",
    ]);
    expect(
      resolve(
        [
          { kind: "dept_level", level: 2, values: ["Lodging Operations"] },
          { kind: "dept_base_not_in", codes: ["0410"] },
        ],
        "dept"
      )
    ).toEqual(["0510"]);
    expect(resolve([{ kind: "acc_level", level: 12, values: ["Associate Wages", "Associate Benefits"] }], "account")).toEqual([
      "511000",
      "560303",
    ]);
  });

  it("level_not_in keeps unmapped codes — the residual bucket never drops them", () => {
    expect(resolve([{ kind: "dept_level_not_in", level: 2, values: ["Lodging Operations"] }], "dept")).toEqual([
      "0600",
      "9999",
    ]);
  });

  it("base_not_in is the complement over the source's own codes", () => {
    expect(resolve([{ kind: "dept_base_not_in", codes: ["D0410", "D0600"] }], "dept")).toEqual(["0510", "9999"]);
  });

  it("without maps, a level filter selects nothing and a level_not_in selects everything", () => {
    expect(resolve([{ kind: "dept_level", level: 2, values: ["x"] }], "dept", UNAVAILABLE_MAP_INDEX)).toEqual([]);
    expect(resolve([{ kind: "dept_level_not_in", level: 2, values: ["x"] }], "dept", UNAVAILABLE_MAP_INDEX)).toEqual([
      "0410",
      "0510",
      "0600",
      "9999",
    ]);
  });
});

describe("sumAtom", () => {
  it("sums direct lookups for base × base without consulting the maps", () => {
    const { out, warnings } = sum(
      {
        id: "a",
        filters: [
          { kind: "dept_base", codes: ["D0410", "D0510"] },
          { kind: "acc_base", codes: ["A511000"] },
        ],
      },
      THROWING_MAPS
    );
    expect(out[0]).toBe(300);
    expect(out[12]).toBe(300 * 12);
    expect(warnings).toEqual([]);
  });

  it("walks one index when only one side is filtered", () => {
    expect(sum({ id: "a", filters: [{ kind: "acc_prefix", prefixes: ["A511"] }] }, THROWING_MAPS).out[0]).toBe(
      601
    );
    expect(sum({ id: "a", filters: [{ kind: "dept_base", codes: ["0510"] }] }, THROWING_MAPS).out[0]).toBe(220 + 3);
  });

  it("sums every entry with no filters at all", () => {
    const { out } = sum({ id: "all", filters: [] }, THROWING_MAPS);
    expect(out[0]).toBe(100 + 10 + 200 + 20 + 300 + 5 + 3 + 160 + 1);
  });

  it("resolves map nodes on both sides", () => {
    const { out } = sum({
      id: "lodging_payroll",
      filters: [
        { kind: "dept_level", level: 2, values: ["Lodging Operations"] },
        { kind: "acc_level", level: 9, values: ["Total Payroll"] },
      ],
    });
    expect(out[0]).toBe(100 + 10 + 200 + 20);
  });

  it("reads a LEVEL row as its running sum, so a mid-year change shows as a level", () => {
    const { out } = sum({ id: "hc", filters: [{ kind: "acc_base", codes: ["A972540"] }] });
    // D0410: 5 all year. D0510: 3, then 2 from July.
    expect(out.slice(0, 12)).toEqual([8, 8, 8, 8, 8, 8, 7, 7, 7, 7, 7, 7]);
    expect(out[12]).toBe(7); // Total = the December level
  });

  it("negates after summation", () => {
    const { out } = sum({ id: "n", negate: true, filters: [{ kind: "acc_base", codes: ["A560303"] }] });
    expect(out[0]).toBe(-30);
    expect(out[12]).toBe(-360);
  });

  it("flags a MIXED row it summed, and warns once per atom", () => {
    const { out, warnings } = sum({ id: "hrs", filters: [{ kind: "acc_prefix", prefixes: ["988"] }] });
    expect(out[0]).toBe(160);
    expect(warnings).toEqual([expect.objectContaining({ code: "MIXED_ENCODING", atomId: "hrs" })]);
  });

  it("warns when a level filter is used with no maps and sums nothing", () => {
    const { out, warnings } = sum(
      { id: "lvl", filters: [{ kind: "acc_level", level: 9, values: ["Total Payroll"] }] },
      UNAVAILABLE_MAP_INDEX
    );
    expect(out.every((v) => v === 0)).toBe(true);
    expect(warnings.map((w) => w.code)).toEqual(["MAPS_UNAVAILABLE"]);
  });
});

describe("buildValueSource / buildMapIndex", () => {
  it("merges two spellings of one combo into one entry, keeping the encodings honest", () => {
    const source = buildValueSource("s", [
      { dept: "D1", account: "A2", months: flat(1) },
      { dept: "1", account: "2", months: flat(1) },
      { dept: "D3", account: "A4", months: jan(1), encoding: "LEVEL" },
      { dept: "3", account: "4", months: flat(1) },
    ]);
    expect(source.entries).toHaveLength(2);
    expect(source.get("D1", "A2")!.vec[0]).toBe(2);
    expect(source.get("D1", "A2")!.encoding).toBe("AMOUNT");
    expect(source.get("3", "4")!.encoding).toBe("MIXED");
  });

  it("keeps the stored total when given one, else sums the months", () => {
    const source = buildValueSource("s", [
      { dept: "D1", account: "A1", months: flat(1), total: 11.5 },
      { dept: "D2", account: "A1", months: flat(1) },
    ]);
    expect(source.get("D1", "A1")!.vec[12]).toBe(11.5);
    expect(source.get("D2", "A1")!.vec[12]).toBe(12);
  });

  it("warns about duplicate map codes across spellings and lets the last win", () => {
    const maps = buildMapIndex(
      "v",
      [
        { code: "D0410", levels: levels({ 2: "A" }) },
        { code: "0410", levels: levels({ 2: "B" }) },
      ],
      []
    );
    expect(maps.warnings.map((w) => w.code)).toEqual(["DUPLICATE_MAP_CODE"]);
    expect([...maps.deptCodes(2, ["B"])]).toEqual(["0410"]);
    expect([...maps.deptCodes(2, ["A"])]).toEqual([]);
  });

  it("matches labels exactly after a trim, case-sensitively", () => {
    expect([...MAPS.deptCodes(7, [" Rooms and Reservation "])]).toEqual(["0510"]);
    expect([...MAPS.deptCodes(7, ["rooms and reservation"])]).toEqual([]);
    expect(MAPS.hasDept("D9999")).toBe(false);
    expect(MAPS.hasAccount("511000")).toBe(true);
  });
});
