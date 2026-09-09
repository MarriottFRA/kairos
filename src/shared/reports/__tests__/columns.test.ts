/**
 * Columns: the spec normaliser's rejections, one evaluation per series
 * column, row alignment across columns, and the three variance modes
 * (including pct-of-a-percent-row becoming points, and the |b| denominator).
 */

import { describe, expect, it } from "vitest";
import {
  ReportColumnSpec,
  ReportColumnsError,
  deriveVariance,
  evaluateColumns,
  normalizeColumns,
  varianceOf,
} from "../columns";
import { compileDefinition } from "../compile";
import type { EvaluationContext } from "../engine";
import { UNAVAILABLE_MAP_INDEX, buildValueSource } from "../sources";
import type { EvaluatedReport, Format, ReportDefinition } from "../types";

const flat = (value: number) => new Array(12).fill(value);

const DEF: ReportDefinition = {
  id: "t",
  name: "t",
  version: 1,
  atoms: [
    { id: "cost", filters: [{ kind: "acc_base", codes: ["A511000"] }] },
    { id: "revenue", filters: [{ kind: "acc_base", codes: ["A400100"] }] },
  ],
  measures: [
    { id: "cost_line", formula: "cost", format: "currency" },
    { id: "margin", formula: "pct(revenue - cost, revenue)", format: "percent" },
  ],
  rows: [
    { type: "header", label: "P&L" },
    { type: "measure", measureId: "cost_line", label: "Cost" },
    { type: "measure", measureId: "margin", label: "Margin" },
  ],
};

const sourceOf = (cost: number, revenue: number) =>
  buildValueSource("s", [
    { dept: "D0410", account: "A511000", months: flat(cost) },
    { dept: "D0410", account: "A400100", months: flat(revenue) },
  ]);

const COLUMNS: ReportColumnSpec[] = [
  { id: "budget", series: { kind: "bst", relativeTo: "s1" } },
  { id: "ly", label: "Last year", series: { kind: "bst", relativeTo: "s1", yearOffset: -1 } },
  { id: "v_abs", variance: { a: "budget", b: "ly", mode: "abs" } },
  { id: "v_pct", variance: { a: "budget", b: "ly", mode: "pct" } },
  { id: "v_pts", variance: { a: "budget", b: "ly", mode: "pts" } },
];

describe("normalizeColumns", () => {
  it("accepts a well-formed list and drops nothing", () => {
    expect(normalizeColumns(COLUMNS)).toEqual(COLUMNS);
  });

  it("lists every problem at once", () => {
    const attempt = () =>
      normalizeColumns([
        { id: "bad id", series: { kind: "plan", scenarioId: "x" } },
        { id: "dup", series: { kind: "kairos", scenarioId: "x" } },
        { id: "dup", series: { kind: "kairos", scenarioId: "x" } },
        { id: "nokind", series: { kind: "csv" } },
        { id: "noscen", series: { kind: "plan" } },
        { id: "bare", series: { kind: "bst" } },
        { id: "badidx", series: { kind: "bst", bucket: { index: 4 } } },
        { id: "v1", variance: { a: "dup", b: "dup", mode: "abs" } },
        { id: "v2", variance: { a: "dup", b: "v3", mode: "pct" } },
        { id: "v3", variance: { a: "dup", b: "nope", mode: "ratio" } },
        { id: "neither" },
      ]);
    expect(attempt).toThrow(ReportColumnsError);
    try {
      attempt();
    } catch (error) {
      expect((error as ReportColumnsError).problems).toEqual([
        'column 1: id "bad id" must match /^[A-Za-z_][A-Za-z0-9_]*$/',
        'column id "dup" is used more than once',
        'column "nokind": series kind must be one of plan, kairos, bst',
        'column "noscen": a plan series names a scenarioId',
        'column "bare": a bst series needs a year, a relativeTo scenario or a bucket index',
        'column "badidx": bucket index must be 1, 2 or 3',
        'column "v1": a variance needs two different columns',
        'column "v3": variance mode must be one of abs, pct, pts',
        'column "neither" needs either a series or a variance',
        'column "v2": "v3" is not a series column',
      ]);
    }
  });

  it("insists on at least one series column", () => {
    expect(() => normalizeColumns([])).toThrow(/non-empty/);
  });

  it("normalises numbers and trims strings", () => {
    expect(
      normalizeColumns([
        { id: " c ", label: " Budget ", series: { kind: "bst", year: "2027", bucket: { type: " budget ", index: "1" } } },
      ])
    ).toEqual([{ id: "c", label: "Budget", series: { kind: "bst", year: 2027, bucket: { type: "budget", index: 1 } } }]);
  });
});

describe("evaluateColumns", () => {
  const compiled = compileDefinition(DEF);
  const contexts: string[] = [];
  const contextFor = (spec: { id: string }): EvaluationContext => {
    contexts.push(spec.id);
    const source = spec.id === "budget" ? sourceOf(120, 200) : sourceOf(100, 250);
    return { getSource: () => source, maps: UNAVAILABLE_MAP_INDEX };
  };
  const grid = evaluateColumns(compiled, COLUMNS, contextFor);

  it("evaluates each series column exactly once and keeps the column order", () => {
    expect(contexts).toEqual(["budget", "ly"]);
    expect(grid.columns.map((c) => c.id)).toEqual(["budget", "ly", "v_abs", "v_pct", "v_pts"]);
    expect(grid.columns[1].label).toBe("Last year");
    expect(grid.columns[0].label).toBe("budget");
  });

  it("shares one row scaffold, with headers null in every column", () => {
    expect(grid.rows.map((r) => [r.type, r.label])).toEqual([
      ["header", "P&L"],
      ["measure", "Cost"],
      ["measure", "Margin"],
    ]);
    expect("values" in grid.rows[1]).toBe(false);
    for (const column of grid.columns) {
      expect(column.values).toHaveLength(3);
      expect(column.values[0]).toBeNull();
      expect(column.rowFormats[0]).toBeNull();
    }
  });

  it("derives abs, pct and pts on raw values", () => {
    const [budget, ly, abs, pct, pts] = grid.columns;
    expect(budget.values[1]![0]).toBe(120);
    expect(ly.values[1]![0]).toBe(100);
    expect(abs.values[1]![0]).toBe(20);
    expect(abs.rowFormats[1]).toBeNull();
    expect(pct.values[1]![0]).toBeCloseTo(20);
    expect(pct.rowFormats[1]).toBe("percent");
    expect(pts.values[1]![0]).toBe(20);
    expect(pts.rowFormats[1]).toBe("pts");
    expect(abs.warnings).toEqual([]);
    expect(Object.keys(abs.atoms)).toEqual([]);
  });

  it("turns a pct variance of a percent-format row into points", () => {
    const [budget, ly, , pct] = grid.columns;
    expect(budget.values[2]![0]).toBeCloseTo(40); // (200-120)/200
    expect(ly.values[2]![0]).toBeCloseTo(60); // (250-100)/250
    expect(pct.values[2]![0]).toBeCloseTo(-20);
    expect(pct.rowFormats[2]).toBe("pts");
  });

  it("uses |b| as the pct denominator so a grown cost reads positive against a negative base", () => {
    const negBase = evaluateColumns(
      compiled,
      [
        { id: "a", series: { kind: "bst", year: 2027 } },
        { id: "b", series: { kind: "bst", year: 2026 } },
        { id: "v", variance: { a: "a", b: "b", mode: "pct" } },
      ],
      (spec) => ({
        getSource: () => (spec.id === "a" ? sourceOf(-80, 1) : sourceOf(-100, 1)),
        maps: UNAVAILABLE_MAP_INDEX,
      })
    );
    expect(negBase.columns[2].values[1]![0]).toBeCloseTo(20);
  });

  it("carries each series column's atoms, params and warnings", () => {
    expect(Object.keys(grid.columns[0].atoms).sort()).toEqual(["cost", "revenue"]);
    expect(grid.columns[0].params).toEqual({});
  });
});

describe("varianceOf (the in-cell difference)", () => {
  it("abs is a − b in the row's own format", () => {
    expect(varianceOf(120, 100, "abs", "currency")).toEqual({ value: 20, format: "currency" });
    expect(varianceOf(80, 100, "abs", "number")).toEqual({ value: -20, format: "number" });
  });

  it("pct is 100 × (a − b) ÷ |b| against the absolute base", () => {
    expect(varianceOf(120, 100, "pct", "currency")).toEqual({ value: 20, format: "percent" });
    // A cost that grew against a negative base still reads positive.
    expect(varianceOf(-120, -100, "pct", "currency")).toEqual({ value: -20, format: "percent" });
  });

  it("pct of a percentage row is points, whichever mode was asked", () => {
    expect(varianceOf(12, 10, "pct", "percent")).toEqual({ value: 2, format: "pts" });
    expect(varianceOf(12, 10, "abs", "percent")).toEqual({ value: 2, format: "percent" });
  });

  it("no figure without both sides or with a zero base", () => {
    expect(varianceOf(null, 100, "abs", "number").value).toBeNull();
    expect(varianceOf(100, undefined, "pct", "number").value).toBeNull();
    expect(varianceOf(100, 0, "pct", "number")).toEqual({ value: null, format: "percent" });
    expect(varianceOf(100, 0, "abs", "number")).toEqual({ value: 100, format: "number" });
  });

  it("agrees with deriveVariance slot by slot", () => {
    const report = (values: number[], format: Format): EvaluatedReport => ({
      definitionId: "t",
      rows: [{ type: "measure", label: "x", indent: 0, format, values }],
      warnings: [],
      atoms: {},
      params: {},
    });
    const av = [110, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200];
    const bv = [100, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200];
    for (const mode of ["abs", "pct"] as const) {
      const derived = deriveVariance(report(av, "currency"), report(bv, "currency"), mode).values[0]!;
      for (const slot of [0, 1, 12]) {
        expect(varianceOf(av[slot], bv[slot], mode, "currency").value).toBeCloseTo(derived[slot], 9);
      }
    }
  });
});
