import { describe, expect, it } from "vitest";
import { compile } from "../compile";
import { CompileErrorCode, SsSchemeId } from "../types";
import { defId, makeDef, makeInput, makePosition, makeScheme, makeValue, standardDefinitions, standardScheme } from "./fixtures";

function errorCodes(result: ReturnType<typeof compile>): CompileErrorCode[] {
  return "errors" in result ? result.errors.map((error) => error.code) : [];
}

describe("compile validation", () => {
  it("requires exactly one BASE_SALARY definition", () => {
    const none = compile(makeInput({ definitions: [], positions: [makePosition({ id: "p1" })] }));
    expect(errorCodes(none)).toContain("MISSING_BASE");

    const two = compile(
      makeInput({
        definitions: [
          makeDef({ id: "b1", kind: "BASE_SALARY" }),
          makeDef({ id: "b2", kind: "BASE_SALARY" }),
        ],
        positions: [makePosition({ id: "p1" })],
      })
    );
    expect(errorCodes(two)).toContain("MULTIPLE_BASE");
  });

  it("rejects a social security component without a scheme", () => {
    const result = compile(
      makeInput({
        definitions: [
          makeDef({ id: "b", kind: "BASE_SALARY" }),
          makeDef({ id: "ss", kind: "SOCIAL_SECURITY", ssSchemeId: "missing" as SsSchemeId }),
        ],
        positions: [makePosition({ id: "p1" })],
      })
    );
    expect(errorCodes(result)).toContain("MISSING_SCHEME");
  });

  it("rejects the reserved REVENUE_WEIGHTED method", () => {
    const result = compile(
      makeInput({
        definitions: [
          makeDef({ id: "b", kind: "BASE_SALARY" }),
          makeDef({ id: "rev", spreadMethod: "REVENUE_WEIGHTED" }),
        ],
        positions: [makePosition({ id: "p1" })],
      })
    );
    expect(errorCodes(result)).toContain("UNSUPPORTED_METHOD");
  });

  it("rejects unknown and non-referenceable base components", () => {
    // STAT lines became base-referenceable with the blocks feature
    // ("multiplier of hours"), so the non-referenceable case is now
    // HOLIDAY_ACCRUAL (a scratch-coupled line no % base may include).
    const result = compile(
      makeInput({
        definitions: [
          makeDef({ id: "b", kind: "BASE_SALARY" }),
          makeDef({ id: "accr", kind: "HOLIDAY_ACCRUAL" }),
          makeDef({
            id: "pct",
            spreadMethod: "PERCENT_OF",
            baseSelector: { kind: "COMPONENTS", componentIds: [defId("ghost"), defId("accr")] },
          }),
        ],
        positions: [makePosition({ id: "p1" })],
      })
    );
    expect(errorCodes(result)).toContain("MISSING_DEF");
    expect(errorCodes(result)).toContain("INVALID_BASE_REF");
  });

  it("interns a per-row account override into the line's aggregation key", () => {
    const result = compile(
      makeInput({
        definitions: [
          makeDef({ id: "b", kind: "BASE_SALARY", accountCode: "610000" }),
          makeDef({ id: "housing", spreadMethod: "FLAT_PER_ACTIVE_MONTH", accountCode: "622000" }),
        ],
        positions: [makePosition({ id: "p1" }), makePosition({ id: "p2" })],
        componentValues: [
          makeValue("p1", "housing", { yearlyValue: 1200, accountCode: "629999" }),
          makeValue("p2", "housing", { yearlyValue: 1200 }),
        ],
      })
    );
    expect("plan" in result).toBe(true);
    if (!("plan" in result)) return;
    const keys = result.plan.aggKeys.map((key) => `${key.dept}|${key.account}`);
    expect(keys).toContain("1010|629999"); // p1's override
    expect(keys).toContain("1010|622000"); // p2 on the definition's account
  });

  it("accepts STAT lines as base components", () => {
    const result = compile(
      makeInput({
        definitions: [
          makeDef({ id: "b", kind: "BASE_SALARY" }),
          makeDef({ id: "hrs", kind: "STAT", statKind: "HOURS" }),
          makeDef({
            id: "pct",
            spreadMethod: "PERCENT_OF",
            baseSelector: { kind: "COMPONENTS", componentIds: [defId("hrs")] },
          }),
        ],
        positions: [makePosition({ id: "p1" })],
      })
    );
    expect("errors" in result).toBe(false);
  });

  it("rejects malformed social security schemes", () => {
    const descending = makeScheme({
      id: "s1",
      brackets: [
        { upTo: 5000, rate: 0.1 },
        { upTo: 3000, rate: 0.2 },
      ],
    });
    const unboundedFirst = makeScheme({
      id: "s2",
      brackets: [
        { upTo: null, rate: 0.1 },
        { upTo: 5000, rate: 0.2 },
      ],
    });
    for (const scheme of [descending, unboundedFirst]) {
      const result = compile(
        makeInput({
          definitions: [
            makeDef({ id: "b", kind: "BASE_SALARY" }),
            makeDef({ id: "ss", kind: "SOCIAL_SECURITY", ssSchemeId: scheme.id }),
          ],
          ssSchemes: [scheme],
          positions: [makePosition({ id: "p1" })],
        })
      );
      expect(errorCodes(result)).toContain("INVALID_SCHEME");
    }
  });

  it("rejects base-reference cycles with the offending labels", () => {
    const result = compile(
      makeInput({
        definitions: [
          makeDef({ id: "b", kind: "BASE_SALARY" }),
          makeDef({
            id: "x",
            label: "Alpha",
            spreadMethod: "PERCENT_OF",
            baseSelector: { kind: "COMPONENTS", componentIds: [defId("y")] },
          }),
          makeDef({
            id: "y",
            label: "Beta",
            spreadMethod: "PERCENT_OF",
            baseSelector: { kind: "COMPONENTS", componentIds: [defId("x")] },
          }),
        ],
        positions: [makePosition({ id: "p1" })],
      })
    );
    expect(errorCodes(result)).toEqual(["CYCLE"]);
    if ("errors" in result) {
      expect(result.errors[0].message).toContain("Alpha");
      expect(result.errors[0].message).toContain("Beta");
    }
  });

  it("rejects positions with malformed month vectors", () => {
    const result = compile(
      makeInput({
        definitions: [makeDef({ id: "b", kind: "BASE_SALARY" })],
        positions: [makePosition({ id: "p1", seasonality: [1, 1, 1] })],
      })
    );
    expect(errorCodes(result)).toContain("INVALID_POSITION");
  });
});

describe("compile ordering and interning", () => {
  it("orders dependents after their bases regardless of sortOrder", () => {
    const result = compile(
      makeInput({
        definitions: [
          // SS sorts FIRST by sortOrder but must run after pension (its base).
          makeDef({
            id: "ss",
            kind: "SOCIAL_SECURITY",
            sortOrder: 0,
            ssSchemeId: standardScheme().id,
            baseSelector: { kind: "COMPONENTS", componentIds: [defId("pension")] },
          }),
          makeDef({ id: "pension", spreadMethod: "PERCENT_OF", sortOrder: 1 }),
          makeDef({ id: "b", kind: "BASE_SALARY", sortOrder: 2 }),
        ],
        ssSchemes: [standardScheme()],
        positions: [makePosition({ id: "p1" })],
      })
    );
    expect("plan" in result).toBe(true);
    if ("plan" in result) {
      const order = result.plan.componentDefs.map((def) => def.id as string);
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("pension"));
      expect(order.indexOf("pension")).toBeLessThan(order.indexOf("ss"));
    }
  });

  it("interns dept×account pairs once across positions and buyouts", () => {
    const definitions = standardDefinitions();
    const result = compile(
      makeInput({
        definitions,
        ssSchemes: [standardScheme()],
        positions: [
          makePosition({ id: "p1", departmentCode: "1010" }),
          makePosition({ id: "p2", departmentCode: "1010" }),
          makePosition({ id: "p3", departmentCode: "1310" }),
        ],
      })
    );
    expect("plan" in result).toBe(true);
    if ("plan" in result) {
      // 12 definitions × 2 distinct departments = 24 dept×account rows.
      expect(result.plan.aggKeys.length).toBe(definitions.length * 2);
      const defCount = result.plan.componentDefs.length;
      // p1 and p2 share every aggregate row; p3 shares none.
      for (let di = 0; di < defCount; di++) {
        expect(result.plan.lineAggRow[0 * defCount + di]).toBe(
          result.plan.lineAggRow[1 * defCount + di]
        );
        expect(result.plan.lineAggRow[0 * defCount + di]).not.toBe(
          result.plan.lineAggRow[2 * defCount + di]
        );
      }
    }
  });

  it("compiles deleted rows out of the plan", () => {
    const definitions = standardDefinitions();
    const deletedDef = makeDef({ id: "gone", spreadMethod: "FLAT_PER_ACTIVE_MONTH" });
    deletedDef.deletedAt = "2026-06-01T00:00:00Z";
    const deletedPosition = makePosition({ id: "p-gone" });
    deletedPosition.deletedAt = "2026-06-01T00:00:00Z";

    const result = compile(
      makeInput({
        definitions: [...definitions, deletedDef],
        ssSchemes: [standardScheme()],
        positions: [makePosition({ id: "p1" }), deletedPosition],
      })
    );
    expect("plan" in result).toBe(true);
    if ("plan" in result) {
      expect(result.plan.componentDefs.map((def) => def.id as string)).not.toContain("gone");
      expect(result.plan.positionIds).toEqual(["p1"]);
    }
  });
});
