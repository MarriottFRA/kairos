/**
 * applySocialSecurityBase — each SS definition's contributory base is
 * materialized at engine load from ITS OWN scheme's base membership (net base
 * salary, vacation, and any custom-block lines), not stored, so the base is
 * always fresh and no cross-block recompile is needed. Both engine-input paths
 * call this; here we pin the scheme→selector logic directly.
 */

import { describe, expect, it } from "vitest";
import {
  CostComponentDefinition,
  ComponentDefId,
} from "../../engine/types";
import { applySocialSecurityBase, SsBaseScheme } from "../engineInput";

const OU = "OU12345";

function def(
  id: string,
  kind: CostComponentDefinition["kind"],
  over: Partial<CostComponentDefinition> = {}
): CostComponentDefinition {
  return {
    id: id as ComponentDefId,
    ou: OU,
    kind,
    label: id,
    accountCode: "",
    departmentMode: "POSITION",
    increaseAware: false,
    sortOrder: 0,
    updatedAt: "",
    deletedAt: null,
    ...over,
  };
}

const baseSalaryDefId = `sys-base:${OU}` as ComponentDefId;
const niDefId = `ni-1:cost`;

function scheme(over: Partial<SsBaseScheme> = {}): SsBaseScheme {
  return {
    id: "scheme-1" as SsBaseScheme["id"],
    includeBaseSalary: true,
    includeVacation: true,
    baseComponentIds: [],
    ...over,
  };
}

function fixture() {
  const definitions = [
    def(baseSalaryDefId, "BASE_SALARY"),
    def("blkA:cost", "SPREAD"),
    def("blkB:cost", "SPREAD"),
    def(niDefId, "SOCIAL_SECURITY", { ssSchemeId: "scheme-1" as never }),
  ];
  return { definitions };
}

/** The SS def's resolved SS_BASE selector, or undefined. */
function ssBase(definitions: CostComponentDefinition[]) {
  const ss = definitions.find((d) => d.kind === "SOCIAL_SECURITY");
  const selector = ss?.baseSelector;
  return selector?.kind === "SS_BASE" ? selector : undefined;
}

describe("applySocialSecurityBase", () => {
  it("builds an SS_BASE selector from the scheme's base membership", () => {
    const { definitions } = fixture();
    applySocialSecurityBase(definitions, [
      scheme({ baseComponentIds: ["blkA:cost"] as ComponentDefId[] }),
    ]);
    expect(ssBase(definitions)).toEqual({
      kind: "SS_BASE",
      includeBaseSalary: true,
      includeVacation: true,
      componentIds: ["blkA:cost"],
    });
  });

  it("carries the scheme's includeBaseSalary / includeVacation flags", () => {
    const { definitions } = fixture();
    applySocialSecurityBase(definitions, [
      scheme({ includeBaseSalary: false, includeVacation: false }),
    ]);
    const base = ssBase(definitions);
    expect(base?.includeBaseSalary).toBe(false);
    expect(base?.includeVacation).toBe(false);
  });

  it("drops base component ids for definitions that no longer exist", () => {
    const { definitions } = fixture();
    applySocialSecurityBase(definitions, [
      scheme({ baseComponentIds: ["blkA:cost", "gone:cost"] as ComponentDefId[] }),
    ]);
    expect(ssBase(definitions)?.componentIds).toEqual(["blkA:cost"]);
  });

  it("defaults both flags on when the scheme is missing", () => {
    const { definitions } = fixture();
    applySocialSecurityBase(definitions, []); // no scheme matches the SS def
    expect(ssBase(definitions)).toEqual({
      kind: "SS_BASE",
      includeBaseSalary: true,
      includeVacation: true,
      componentIds: [],
    });
  });

  it("is a no-op when there is no SS definition", () => {
    const definitions = [def(baseSalaryDefId, "BASE_SALARY"), def("blkA:cost", "SPREAD")];
    expect(() => applySocialSecurityBase(definitions, [scheme()])).not.toThrow();
  });
});
