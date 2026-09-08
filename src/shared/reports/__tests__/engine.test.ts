/**
 * Compile + evaluate, end to end over in-memory sources: the dependency
 * graph (measure → measure chains, cycles, unknown ids, unreachable atoms
 * never resolved), the evaluation itself, and the built-in definitions.
 */

import { describe, expect, it } from "vitest";
import { ReportDefinitionError, compileDefinition, validateDefinition } from "../compile";
import {
  BUILTIN_REPORT_DEFINITIONS,
  findReportDefinition,
  listReportDefinitions,
} from "../definitions";
import { EvaluationContext, evaluateReport } from "../engine";
import { UNAVAILABLE_MAP_INDEX, buildMapIndex, buildValueSource } from "../sources";
import type { ReportDefinition, ValueSourceRef } from "../types";

const flat = (value: number) => new Array(12).fill(value);
const jan = (value: number) => [value, ...new Array(11).fill(0)];

const KAIROS = buildValueSource("kairos", [
  { dept: "D0410", account: "A511000", months: flat(1000) },
  { dept: "D0410", account: "A560303", months: flat(100) },
  { dept: "D0510", account: "A511000", months: flat(2000) },
  { dept: "D0510", account: "A560303", months: flat(200) },
  { dept: "D0410", account: "A972540", months: jan(4), total: 4, encoding: "LEVEL" },
  { dept: "D0510", account: "A972540", months: jan(6), total: 6, encoding: "LEVEL" },
  { dept: "D0410", account: "A988699", months: flat(640) },
  { dept: "D0410", account: "A988101", months: jan(1), total: 1, encoding: "LEVEL" },
]);

const BST = buildValueSource("bst", [
  { dept: "D0100", account: "A400100", months: flat(50000) },
  { dept: "D0200", account: "A420100", months: flat(10000) },
]);

const levels = (entries: Record<number, string>) =>
  Array.from({ length: 31 }, (_, i) => entries[i] ?? null);
const MAPS = buildMapIndex(
  "maps-1",
  [],
  [
    { code: "A400100", levels: levels({ 6: "Revenue" }) },
    { code: "A420100", levels: levels({ 6: "Revenue" }) },
  ]
);

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    getSource: (ref: ValueSourceRef) => (ref.source === "bst" ? BST : KAIROS),
    maps: MAPS,
    ...overrides,
  };
}

function definition(partial: Partial<ReportDefinition>): ReportDefinition {
  return { id: "t", name: "t", version: 1, atoms: [], measures: [], rows: [], ...partial };
}

describe("compileDefinition", () => {
  it("reports every problem at once, with the id it belongs to", () => {
    const problems = validateDefinition(
      definition({
        atoms: [
          { id: "ok", filters: [] },
          { id: "ok", filters: [] },
          { id: "div", filters: [] },
          { id: "bad level", filters: [] },
          { id: "lvl", filters: [{ kind: "acc_level", level: 99, values: ["x"] }] },
        ],
        measures: [
          { id: "m1", formula: "ok +" },
          { id: "m2", formula: "nothere * 2" },
        ],
        rows: [{ type: "measure", measureId: "m3" }],
      })
    );
    expect(problems).toEqual([
      'id "ok" is used more than once',
      'atom id "div" is a function name and is reserved',
      'atom id "bad level" must match /^[A-Za-z_][A-Za-z0-9_]*$/',
      'Atom "lvl": level must be an integer between 0 and 30',
      'measure "m1": Unexpected end of formula (at position 4)',
      'measure "m2" references unknown id "nothere"',
      'row 1 references unknown measure "m3"',
    ]);
  });

  it("names the path of a circular reference", () => {
    expect(() =>
      compileDefinition(
        definition({
          atoms: [{ id: "a", filters: [] }],
          measures: [
            { id: "x", formula: "y + a" },
            { id: "y", formula: "z" },
            { id: "z", formula: "x" },
          ],
          rows: [{ type: "measure", measureId: "x" }],
        })
      )
    ).toThrow(/Circular measure reference: x → y → z → x/);
    expect(() =>
      compileDefinition(
        definition({ measures: [{ id: "x", formula: "x" }], rows: [{ type: "measure", measureId: "x" }] })
      )
    ).toThrow(ReportDefinitionError);
  });

  it("orders measures so every reference precedes its referrer, and reaches only what rows need", () => {
    const compiled = compileDefinition(
      definition({
        atoms: [
          { id: "a", filters: [] },
          { id: "unused", filters: [] },
          { id: "b", source: { source: "bst" }, filters: [] },
        ],
        measures: [
          { id: "top", formula: "mid + b" },
          { id: "mid", formula: "leaf * 2" },
          { id: "leaf", formula: "a" },
          { id: "orphan", formula: "unused" },
        ],
        rows: [
          { type: "measure", measureId: "top" },
          { type: "measure", measureId: "top" },
          { type: "measure", measureId: "leaf" },
        ],
      })
    );
    expect(compiled.roots).toEqual(["top", "leaf"]);
    expect(compiled.order).toEqual(["leaf", "mid", "top"]);
    expect([...compiled.atomsUsed].sort()).toEqual(["a", "b"]);
    expect([...compiled.sourceKinds].sort()).toEqual(["bst", "kairos"]);
  });
});

describe("evaluateReport", () => {
  const DEF = definition({
    atoms: [
      { id: "wages", filters: [{ kind: "acc_base", codes: ["A511000"] }] },
      { id: "benefits", filters: [{ kind: "acc_prefix", prefixes: ["A56"] }] },
      { id: "heads", filters: [{ kind: "acc_base", codes: ["A972540"] }] },
      {
        id: "revenue",
        source: { source: "bst", bucket: { type: "BUDGET" } },
        filters: [{ kind: "acc_level", level: 6, values: ["Revenue"] }],
      },
      { id: "unused", filters: [{ kind: "acc_level", level: 1, values: ["never"] }] },
    ],
    measures: [
      { id: "payroll", formula: "wages + benefits", format: "currency" },
      { id: "per_head", formula: "div(payroll, heads)", format: "currency" },
      { id: "pct_rev", formula: "pct(payroll, revenue)", format: "percent" },
      { id: "orphan", formula: "unused" },
    ],
    rows: [
      { type: "header", label: "PAYROLL" },
      { type: "measure", measureId: "payroll", label: "Total payroll", indent: 1 },
      { type: "spacer" },
      { type: "measure", measureId: "per_head", format: "ratio", invertSign: true },
      { type: "measure", measureId: "pct_rev" },
    ],
  });

  it("produces one 13-slot row per measure row, headers and spacers as null", () => {
    const report = evaluateReport(compileDefinition(DEF), context());
    expect(report.rows.map((r) => [r.type, r.label, r.values === null])).toEqual([
      ["header", "PAYROLL", true],
      ["measure", "Total payroll", false],
      ["spacer", "", true],
      ["measure", "per_head", false],
      ["measure", "pct_rev", false],
    ]);
    const payroll = report.rows[1];
    expect(payroll.values![0]).toBe(3300);
    expect(payroll.values![12]).toBe(3300 * 12);
    expect(payroll.format).toBe("currency");
    expect(payroll.indent).toBe(1);

    const perHead = report.rows[3];
    expect(perHead.values![0]).toBe(330);
    expect(perHead.values![12]).toBe((3300 * 12) / 10); // heads Total = December level 10
    expect(perHead.format).toBe("ratio"); // the row's own format wins
    expect(perHead.invertSign).toBe(true);
    expect(perHead.values![0]).toBe(330); // display-only: the value is not flipped

    const pct = report.rows[4];
    expect(pct.values![0]).toBeCloseTo((3300 / 60000) * 100);
    expect(pct.values![12]).toBeCloseTo((3300 / 60000) * 100);
    expect(report.warnings).toEqual([]);
    expect(Object.keys(report.atoms).sort()).toEqual(["benefits", "heads", "revenue", "wages"]);
  });

  it("never resolves an atom no row reaches, and fetches only the sources it needs", () => {
    const fetched: string[] = [];
    const report = evaluateReport(
      compileDefinition(
        definition({
          atoms: DEF.atoms,
          measures: DEF.measures,
          rows: [{ type: "measure", measureId: "payroll" }],
        })
      ),
      context({
        getSource: (ref) => {
          fetched.push(ref.source);
          return ref.source === "bst" ? BST : KAIROS;
        },
        maps: UNAVAILABLE_MAP_INDEX, // the level atoms would warn if touched
      })
    );
    expect(fetched).toEqual(["kairos"]);
    expect(report.warnings).toEqual([]);
    expect(Object.keys(report.atoms).sort()).toEqual(["benefits", "wages"]);
  });

  it("zero-fills atoms whose source is unavailable and carries the context's warnings through", () => {
    const report = evaluateReport(
      compileDefinition(DEF),
      context({
        getSource: (ref, warn) => {
          if (ref.source === "bst") {
            warn({ code: "BST_UNAVAILABLE", message: "no import" });
            return null;
          }
          return KAIROS;
        },
        warnings: [{ code: "RESULTS_PREDATE_CACHE", message: "old run" }],
      })
    );
    expect(report.rows[4].values!.every((v) => v === 0)).toBe(true);
    expect(report.warnings.map((w) => w.code)).toEqual(["RESULTS_PREDATE_CACHE", "BST_UNAVAILABLE"]);
  });

  it("dedupes a warning raised by the same atom twice", () => {
    const report = evaluateReport(
      compileDefinition(
        definition({
          atoms: [{ id: "lvl", filters: [{ kind: "acc_level", level: 6, values: ["Revenue"] }] }],
          measures: [
            { id: "m1", formula: "lvl" },
            { id: "m2", formula: "lvl * 2" },
          ],
          rows: [
            { type: "measure", measureId: "m1" },
            { type: "measure", measureId: "m2" },
          ],
        })
      ),
      context({ maps: UNAVAILABLE_MAP_INDEX })
    );
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatchObject({ code: "MAPS_UNAVAILABLE", atomId: "lvl" });
  });
});

describe("built-in definitions", () => {
  it("all compile, are listed, and are findable by id", () => {
    for (const def of BUILTIN_REPORT_DEFINITIONS) {
      expect(validateDefinition(def), def.id).toEqual([]);
      expect(findReportDefinition(def.id)?.definition).toBe(def);
    }
    expect(listReportDefinitions().map((c) => c.definition.id)).toEqual(
      BUILTIN_REPORT_DEFINITIONS.map((d) => d.id)
    );
    expect(findReportDefinition("nope")).toBeUndefined();
  });

  it("are plain data: a JSON round-trip compiles to the same plan", () => {
    for (const def of BUILTIN_REPORT_DEFINITIONS) {
      const clone = JSON.parse(JSON.stringify(def)) as ReportDefinition;
      expect(clone).toEqual(def);
      const a = compileDefinition(def);
      const b = compileDefinition(clone);
      expect(b.order).toEqual(a.order);
      expect([...b.atomsUsed]).toEqual([...a.atomsUsed]);
    }
  });

  it("payroll summary evaluates over the fixtures", () => {
    const report = evaluateReport(findReportDefinition("payroll_summary")!, context());
    const byLabel = new Map(report.rows.map((r) => [r.label, r.values]));
    expect(byLabel.get("Wages & salaries")![0]).toBe(3000);
    expect(byLabel.get("Benefits")![0]).toBe(300);
    expect(byLabel.get("Total payroll")![0]).toBe(3300);
    expect(byLabel.get("Position count")![12]).toBe(10);
    expect(byLabel.get("Payroll per head")![0]).toBe(330);
    expect(byLabel.get("Payroll % of revenue")![0]).toBeCloseTo(5.5);
  });

  it("staffing stats needs no maps at all", () => {
    const report = evaluateReport(
      findReportDefinition("staffing_stats")!,
      context({ maps: UNAVAILABLE_MAP_INDEX })
    );
    expect(report.warnings).toEqual([]);
    const byLabel = new Map(report.rows.map((r) => [r.label, r.values]));
    expect(byLabel.get("Position count")![0]).toBe(10);
    expect(byLabel.get("Graded heads")![0]).toBe(1);
    expect(byLabel.get("Hours")![0]).toBe(640);
    expect(byLabel.get("Hours per head")![0]).toBe(64);
  });
});
