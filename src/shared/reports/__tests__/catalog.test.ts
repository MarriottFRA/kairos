/**
 * The catalog and defineReport: groups pulled in transitively, identical
 * duplicates merged, a conflicting body refused at definition time, every
 * group closed (compiles on its own with what it requires), and the
 * assembled definitions still plain data.
 */

import { describe, expect, it } from "vitest";
import { CATALOG_GROUPS, CatalogGroup, atom, accBase, measure } from "../catalog";
import { ReportDefinitionError, compileDefinition, validateDefinition } from "../compile";
import { defineReport, line } from "../definitions/defineReport";
import { BUILTIN_REPORT_DEFINITIONS } from "../definitions";

const base: CatalogGroup = {
  id: "base",
  atoms: [atom("a", "A", accBase("A1"))],
  measures: [measure("a_line", "a", "number")],
};
const mid: CatalogGroup = {
  id: "mid",
  requires: [base],
  atoms: [atom("b", "B", accBase("A2"))],
  measures: [measure("ab", "a + b", "number")],
};
const top: CatalogGroup = {
  id: "top",
  requires: [mid, base],
  atoms: [],
  measures: [measure("abab", "ab * 2", "number")],
};

describe("defineReport", () => {
  it("walks requires transitively and merges identical duplicates", () => {
    const def = defineReport({ id: "d", name: "d", use: [top], rows: [line("abab")] });
    expect(def.atoms.map((a) => a.id)).toEqual(["a", "b"]);
    expect(def.measures.map((m) => m.id)).toEqual(["a_line", "ab", "abab"]);
    expect(validateDefinition(def)).toEqual([]);
    expect(def.params).toBeUndefined();
  });

  it("refuses the same id with a different body, naming it", () => {
    const rival: CatalogGroup = {
      id: "rival",
      atoms: [atom("a", "A", accBase("A9"))],
      measures: [],
    };
    expect(() => defineReport({ id: "d", name: "d", use: [base, rival], rows: [] })).toThrow(
      /atom "a" from catalog group "rival" differs/
    );
    expect(() =>
      defineReport({ id: "d", name: "d", use: [base], measures: [measure("a_line", "a * 1", "number")], rows: [] })
    ).toThrow(ReportDefinitionError);
  });

  it("keeps params from groups and the definition, deduplicated", () => {
    const withParam: CatalogGroup = {
      id: "p",
      atoms: [],
      measures: [],
      params: [{ id: "k", default: 1 }],
    };
    const def = defineReport({
      id: "d",
      name: "d",
      use: [withParam],
      params: [{ id: "k", default: 1 }],
      measures: [measure("m", "k * 2", "number")],
      rows: [line("m")],
    });
    expect(def.params).toEqual([{ id: "k", default: 1 }]);
    expect(validateDefinition(def)).toEqual([]);
  });
});

describe("the catalog", () => {
  it("has closed groups: each compiles with what it requires", () => {
    for (const group of CATALOG_GROUPS) {
      const def = defineReport({ id: `g_${group.id}`, name: group.id, use: [group], rows: [] });
      expect(validateDefinition(def), group.id).toEqual([]);
    }
  });

  it("compiles as one definition, with no id used twice", () => {
    const def = defineReport({ id: "all", name: "all", use: [...CATALOG_GROUPS], rows: [] });
    const ids = [...def.atoms.map((a) => a.id), ...def.measures.map((m) => m.id), ...(def.params ?? []).map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateDefinition(def)).toEqual([]);
  });

  it("never negates a revenue atom (the BST holds revenue positive)", () => {
    for (const group of CATALOG_GROUPS) {
      for (const a of group.atoms) expect(a.negate, `${group.id}/${a.id}`).toBeUndefined();
    }
  });

  it("never formats a per-unit money measure as currency", () => {
    // `currency` is the only format the "amounts in 000's" toggle scales, and
    // an ADR or a POR is already divided by a statistic — scaling a £150 ADR
    // to 0 destroys the KPI. Anything with a div() in it is a `rate`.
    for (const group of CATALOG_GROUPS) {
      for (const m of group.measures) {
        if (m.formula.includes("div(")) expect(m.format, `${group.id}/${m.id}`).not.toBe("currency");
      }
    }
  });

  it("assembles definitions that are plain data", () => {
    for (const def of BUILTIN_REPORT_DEFINITIONS) {
      const clone = JSON.parse(JSON.stringify(def));
      expect(clone).toEqual(def);
      expect(compileDefinition(clone).order).toEqual(compileDefinition(def).order);
    }
  });
});
