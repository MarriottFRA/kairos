/**
 * Rate-rules evaluator — the shared logic both loaders AND the grid display
 * run, so every operator, coercion and blank rule is pinned here once.
 */

import { describe, expect, it } from "vitest";
import type { FieldDataType } from "../../positions/fields";
import { serviceDaysFor } from "../../positions/serviceDays";
import {
  RATE_RULE_OPERATORS,
  RateRuleSubject,
  RateRulesConfig,
  RateRuleTerm,
  evaluateRateRules,
  normalizeRateRules,
  operatorNeedsValue,
  rateRulesBlockIds,
  rateRulesFieldKeys,
  rateRulesMonthVarying,
} from "../rateRules";

function subject(overrides: Partial<RateRuleSubject> = {}): RateRuleSubject {
  return { bag: {}, ...overrides };
}

function config(rules: RateRulesConfig["rules"], otherwise = 0): RateRulesConfig {
  return { rules, otherwise };
}

function fieldTerm(
  fieldKey: string,
  dataType: FieldDataType,
  op: RateRuleTerm["op"],
  value?: RateRuleTerm["value"]
): RateRuleTerm {
  return { source: { kind: "FIELD", fieldKey, dataType }, op, value };
}

function rateOf(result: ReturnType<typeof evaluateRateRules>): number {
  if (!("rate" in result)) throw new Error("expected a scalar rate");
  return result.rate;
}

describe("text / enum / account comparisons", () => {
  const blueRule = config(
    [{ when: [fieldTerm("u_band", "TEXT", "EQ", "blue")], rate: 0.1 }],
    0.05
  );

  it("matches trimmed and case-insensitively", () => {
    expect(rateOf(evaluateRateRules(blueRule, subject({ bag: { u_band: "  Blue " } })))).toBe(0.1);
    expect(rateOf(evaluateRateRules(blueRule, subject({ bag: { u_band: "BLUE" } })))).toBe(0.1);
    expect(rateOf(evaluateRateRules(blueRule, subject({ bag: { u_band: "green" } })))).toBe(0.05);
  });

  it("reads a missing or empty field as blank — EQ fails, otherwise applies", () => {
    expect(rateOf(evaluateRateRules(blueRule, subject()))).toBe(0.05);
    expect(rateOf(evaluateRateRules(blueRule, subject({ bag: { u_band: "" } })))).toBe(0.05);
    expect(rateOf(evaluateRateRules(blueRule, subject({ bag: { u_band: "   " } })))).toBe(0.05);
    expect(rateOf(evaluateRateRules(blueRule, subject({ bag: { u_band: null } })))).toBe(0.05);
  });

  it("NEQ still fails on blank (blank is not 'different', it is absent)", () => {
    const neq = config([{ when: [fieldTerm("u_band", "TEXT", "NEQ", "blue")], rate: 1 }], 2);
    expect(rateOf(evaluateRateRules(neq, subject({ bag: { u_band: "green" } })))).toBe(1);
    expect(rateOf(evaluateRateRules(neq, subject({ bag: { u_band: "blue" } })))).toBe(2);
    expect(rateOf(evaluateRateRules(neq, subject()))).toBe(2);
  });

  it("IN matches any list entry, normalized", () => {
    const rule = config(
      [{ when: [fieldTerm("u_band", "ENUM", "IN", ["Blue", "green "])], rate: 7 }],
      1
    );
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_band: "blue" } })))).toBe(7);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_band: "GREEN" } })))).toBe(7);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_band: "red" } })))).toBe(1);
  });

  it("IS_BLANK / NOT_BLANK work without a value", () => {
    const rule = config([{ when: [fieldTerm("u_band", "TEXT", "IS_BLANK")], rate: 9 }], 1);
    expect(rateOf(evaluateRateRules(rule, subject()))).toBe(9);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_band: "x" } })))).toBe(1);
    const notBlank = config([{ when: [fieldTerm("u_band", "TEXT", "NOT_BLANK")], rate: 9 }], 1);
    expect(rateOf(evaluateRateRules(notBlank, subject({ bag: { u_band: "x" } })))).toBe(9);
    expect(rateOf(evaluateRateRules(notBlank, subject()))).toBe(1);
  });
});

describe("numeric comparisons", () => {
  it("covers every comparison operator, coercing string cells", () => {
    const cases: Array<[RateRuleTerm["op"], number, string | number, boolean]> = [
      ["EQ", 5, 5, true],
      ["EQ", 5, "5", true],
      ["NEQ", 5, 6, true],
      ["GT", 5, 6, true],
      ["GT", 5, 5, false],
      ["GTE", 5, 5, true],
      ["LT", 5, 4, true],
      ["LTE", 5, 5, true],
      ["LTE", 5, 6, false],
    ];
    for (const [op, expected, actual, matches] of cases) {
      const rule = config([{ when: [fieldTerm("u_n", "NUMBER", op, expected)], rate: 1 }], 0);
      expect(
        rateOf(evaluateRateRules(rule, subject({ bag: { u_n: actual } }))),
        `${actual} ${op} ${expected}`
      ).toBe(matches ? 1 : 0);
    }
  });

  it("uncoercible or blank numbers never match", () => {
    const rule = config([{ when: [fieldTerm("u_n", "NUMBER", "GTE", 0)], rate: 1 }], 0);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_n: "abc" } })))).toBe(0);
    expect(rateOf(evaluateRateRules(rule, subject()))).toBe(0);
  });

  it("PERCENT compares the stored fraction", () => {
    const rule = config([{ when: [fieldTerm("u_p", "PERCENT", "GT", 0.5)], rate: 1 }], 0);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_p: 0.6 } })))).toBe(1);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_p: 0.4 } })))).toBe(0);
  });
});

describe("text ordering (GT/GTE/LT/LTE on text)", () => {
  it("compares numerically when both sides are numbers", () => {
    const rule = config([{ when: [fieldTerm("u_t", "TEXT", "GT", "9")], rate: 1 }], 0);
    // Lexicographic would say "10" < "9"; the numeric-aware compare must not.
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_t: "10" } })))).toBe(1);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_t: "8" } })))).toBe(0);
  });

  it("falls back to case-insensitive codepoint order for words", () => {
    const rule = config([{ when: [fieldTerm("u_t", "TEXT", "LT", "M")], rate: 1 }], 0);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_t: "grade-a" } })))).toBe(1);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_t: "Zeta" } })))).toBe(0);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_t: "" } })))).toBe(0);
  });
});

describe("KPI conditions", () => {
  const kpiTerm = (op: RateRuleTerm["op"], value: number): RateRuleTerm => ({
    source: { kind: "KPI", kpiDriverId: "kpi-occ" },
    op,
    value,
  });
  const halfYearHigh = {
    kpiSeries: (driverId: string) =>
      driverId === "kpi-occ"
        ? [{ deptKey: "*", values: [90, 90, 90, 90, 90, 90, 40, 40, 40, 40, 40, 40] }]
        : [],
  };

  it("varies by month with the series", () => {
    const rule = config([{ when: [kpiTerm("GTE", 80)], rate: 2 }], 1);
    const result = evaluateRateRules(rule, subject(), halfYearHigh);
    if (!("monthlyRates" in result)) throw new Error("expected monthly rates");
    expect(result.monthlyRates).toEqual([2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1]);
  });

  it("resolves POSITION-mode series by the subject's department", () => {
    const perDept = {
      kpiSeries: () => [
        { deptKey: "1310", values: new Array(12).fill(100) },
        { deptKey: "1010", values: new Array(12).fill(10) },
      ],
    };
    const rule = config([{ when: [kpiTerm("GT", 50)], rate: 2 }], 1);
    const fnb = evaluateRateRules(rule, subject({ departmentCode: "1310" }), perDept);
    const rooms = evaluateRateRules(rule, subject({ departmentCode: "1010" }), perDept);
    expect(fnb).toEqual({ rate: 2 });
    expect(rooms).toEqual({ rate: 1 });
  });

  it("a missing series never matches (falls through)", () => {
    const rule = config([{ when: [kpiTerm("GTE", 0)], rate: 2 }], 1);
    expect(evaluateRateRules(rule, subject())).toEqual({ rate: 1 });
  });
});

describe("block outputs", () => {
  it("resolves to the matched rule's block reference", () => {
    const rules: RateRulesConfig = {
      rules: [
        { when: [fieldTerm("u_band", "TEXT", "EQ", "blue")], rate: 0, rateBlockId: "blk-x" },
      ],
      otherwise: 0.5,
    };
    expect(evaluateRateRules(rules, subject({ bag: { u_band: "blue" } }))).toEqual({
      rateBlockId: "blk-x",
    });
    expect(evaluateRateRules(rules, subject({ bag: { u_band: "red" } }))).toEqual({
      rate: 0.5,
    });
  });

  it("otherwise can be a block too, and helpers collect the ids", () => {
    const rules: RateRulesConfig = {
      rules: [
        { when: [fieldTerm("u_band", "TEXT", "EQ", "blue")], rate: 0, rateBlockId: "blk-x" },
      ],
      otherwise: 0,
      otherwiseBlockId: "blk-y",
    };
    expect(evaluateRateRules(rules, subject())).toEqual({ rateBlockId: "blk-y" });
    expect(rateRulesBlockIds(rules).sort()).toEqual(["blk-x", "blk-y"]);
  });
});

describe("date comparisons", () => {
  it("compares ISO day strings as UTC days", () => {
    const rule = config(
      [{ when: [fieldTerm("u_d", "DATE", "LT", "2026-06-01")], rate: 1 }],
      0
    );
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_d: "2026-05-31" } })))).toBe(1);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_d: "2026-06-01" } })))).toBe(0);
  });

  it("malformed dates read as blank", () => {
    const rule = config([{ when: [fieldTerm("u_d", "DATE", "EQ", "2026-06-01")], rate: 1 }], 0);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_d: "junk" } })))).toBe(0);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_d: "2026-02-30" } })))).toBe(0);
  });
});

describe("boolean comparisons", () => {
  it("accepts boolean, numeric and string cells", () => {
    const rule = config([{ when: [fieldTerm("u_b", "BOOLEAN", "EQ", true)], rate: 1 }], 0);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_b: true } })))).toBe(1);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_b: "TRUE" } })))).toBe(1);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_b: 1 } })))).toBe(1);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_b: false } })))).toBe(0);
    expect(rateOf(evaluateRateRules(rule, subject({ bag: { u_b: "maybe" } })))).toBe(0);
  });
});

describe("engine scalar sources", () => {
  it("reads departmentCode / jobTypeCode / payType from the subject, not the bag", () => {
    const rule = config(
      [{ when: [fieldTerm("payType", "TEXT", "EQ", "HOURLY")], rate: 1 }],
      0
    );
    // A bag key of the same name must NOT shadow the engine scalar.
    const s = subject({ payType: "HOURLY", bag: { payType: "SALARIED" } });
    expect(rateOf(evaluateRateRules(rule, s))).toBe(1);
  });
});

describe("rule combination", () => {
  it("AND-combines terms within a rule", () => {
    const rule = config(
      [
        {
          when: [
            fieldTerm("u_band", "TEXT", "EQ", "blue"),
            fieldTerm("departmentCode", "TEXT", "EQ", "1310"),
          ],
          rate: 1,
        },
      ],
      0
    );
    expect(
      rateOf(evaluateRateRules(rule, subject({ departmentCode: "1310", bag: { u_band: "blue" } })))
    ).toBe(1);
    expect(
      rateOf(evaluateRateRules(rule, subject({ departmentCode: "1010", bag: { u_band: "blue" } })))
    ).toBe(0);
  });

  it("first matching rule wins, in order", () => {
    const rules = config(
      [
        { when: [fieldTerm("u_n", "NUMBER", "GTE", 10)], rate: 3 },
        { when: [fieldTerm("u_n", "NUMBER", "GTE", 5)], rate: 2 },
        { when: [fieldTerm("u_n", "NUMBER", "GTE", 0)], rate: 1 },
      ],
      0
    );
    expect(rateOf(evaluateRateRules(rules, subject({ bag: { u_n: 12 } })))).toBe(3);
    expect(rateOf(evaluateRateRules(rules, subject({ bag: { u_n: 7 } })))).toBe(2);
    expect(rateOf(evaluateRateRules(rules, subject({ bag: { u_n: 1 } })))).toBe(1);
    expect(rateOf(evaluateRateRules(rules, subject({ bag: { u_n: -1 } })))).toBe(0);
  });

  it("no rules at all resolves to otherwise", () => {
    expect(rateOf(evaluateRateRules(config([], 0.42), subject()))).toBe(0.42);
  });
});

describe("days in position (month-varying)", () => {
  const daysTerm = (op: RateRuleTerm["op"], value: number): RateRuleTerm => ({
    source: { kind: "DAYS_IN_POSITION" },
    op,
    value,
  });
  // 21 days of indemnity below 100 days of service, 30 from then on.
  const indemnity = config([{ when: [daysTerm("LTE", 100)], rate: 21 }], 30);

  it("flips mid-year when the threshold is crossed", () => {
    // Hired 1 Jan 2026: 31 days at end of Jan, 90 end of Mar, 120 end of Apr.
    const service = serviceDaysFor("2026-01-01", 2026);
    const result = evaluateRateRules(
      indemnity,
      subject({ serviceDaysPerMonth: service.perMonth, serviceDaysOpening: service.opening })
    );
    if (!("monthlyRates" in result)) throw new Error("expected monthly rates");
    expect(result.monthlyRates).toEqual([21, 21, 21, 30, 30, 30, 30, 30, 30, 30, 30, 30]);
  });

  it("collapses to a scalar when no month crosses the threshold", () => {
    // Hired years ago: over 100 days everywhere → constant 30.
    const longServing = serviceDaysFor("2020-01-01", 2026);
    const result = evaluateRateRules(
      indemnity,
      subject({
        serviceDaysPerMonth: longServing.perMonth,
        serviceDaysOpening: longServing.opening,
      })
    );
    expect(result).toEqual({ rate: 30 });
  });

  it("no hiring date means zero service days everywhere", () => {
    const result = evaluateRateRules(indemnity, subject());
    expect(result).toEqual({ rate: 21 });
  });

  it("compares against END-of-month cumulative service", () => {
    // Hired 1 June 2026: end of June = 30 days (inclusive), end of July = 61.
    // A GTE 31 term must NOT match June (30 < 31) and must match July on.
    const rule = config([{ when: [daysTerm("GTE", 31)], rate: 1 }], 0);
    const service = serviceDaysFor("2026-06-01", 2026);
    const result = evaluateRateRules(
      rule,
      subject({ serviceDaysPerMonth: service.perMonth, serviceDaysOpening: service.opening })
    );
    if (!("monthlyRates" in result)) throw new Error("expected monthly rates");
    expect(result.monthlyRates).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  });
});

describe("helpers", () => {
  it("rateRulesFieldKeys collects unique FIELD keys only", () => {
    const rules = config([
      {
        when: [
          fieldTerm("u_a", "TEXT", "EQ", "x"),
          fieldTerm("u_b", "TEXT", "EQ", "y"),
          { source: { kind: "DAYS_IN_POSITION" }, op: "GTE", value: 1 },
        ],
        rate: 1,
      },
      { when: [fieldTerm("u_a", "TEXT", "EQ", "z")], rate: 2 },
    ]);
    expect(rateRulesFieldKeys(rules).sort()).toEqual(["u_a", "u_b"]);
  });

  it("rateRulesMonthVarying is true only with a DAYS_IN_POSITION term", () => {
    expect(rateRulesMonthVarying(config([{ when: [fieldTerm("u_a", "TEXT", "EQ", "x")], rate: 1 }]))).toBe(false);
    expect(
      rateRulesMonthVarying(
        config([{ when: [{ source: { kind: "DAYS_IN_POSITION" }, op: "GT", value: 1 }], rate: 1 }])
      )
    ).toBe(true);
  });

  it("operator tables carry no value-less operator inconsistencies", () => {
    for (const ops of Object.values(RATE_RULE_OPERATORS)) {
      for (const op of ops) {
        expect(typeof operatorNeedsValue(op)).toBe("boolean");
      }
    }
  });
});

describe("normalizeRateRules", () => {
  it("passes a well-formed config through, trimming strings", () => {
    const normalized = normalizeRateRules({
      rules: [
        { when: [fieldTerm("u_band", "TEXT", "EQ", "  blue ")], rate: 0.1 },
      ],
      otherwise: 0.05,
    });
    expect(normalized).toEqual({
      rules: [{ when: [fieldTerm("u_band", "TEXT", "EQ", "blue")], rate: 0.1 }],
      otherwise: 0.05,
    });
  });

  it("drops a whole rule when any of its terms is malformed", () => {
    const normalized = normalizeRateRules({
      rules: [
        {
          when: [
            fieldTerm("u_band", "TEXT", "EQ", "blue"),
            { source: { kind: "FIELD", fieldKey: "u_x", dataType: "TEXT" }, op: "NOPE" },
          ],
          rate: 0.1,
        },
        { when: [fieldTerm("u_band", "TEXT", "EQ", "green")], rate: 0.2 },
      ],
      otherwise: 1,
    });
    expect(normalized?.rules).toHaveLength(1);
    expect(normalized?.rules[0]?.rate).toBe(0.2);
  });

  it("rejects an operator illegal for the data type", () => {
    const normalized = normalizeRateRules({
      rules: [{ when: [fieldTerm("u_b", "BOOLEAN", "GT", true)], rate: 1 }],
      otherwise: 0,
    });
    expect(normalized?.rules).toHaveLength(0);
  });

  it("strips block outputs when month-varying terms exist (unrepresentable)", () => {
    const normalized = normalizeRateRules({
      rules: [
        {
          when: [{ source: { kind: "DAYS_IN_POSITION" }, op: "GTE", value: 100 }],
          rate: 2,
          rateBlockId: "blk-x",
        },
      ],
      otherwise: 1,
      otherwiseBlockId: "blk-y",
    });
    expect(normalized).toEqual({
      rules: [
        {
          when: [{ source: { kind: "DAYS_IN_POSITION" }, op: "GTE", value: 100 }],
          rate: 2,
        },
      ],
      otherwise: 1,
    });
  });

  it("keeps block outputs on per-position-constant configs", () => {
    const normalized = normalizeRateRules({
      rules: [
        { when: [fieldTerm("u_band", "TEXT", "EQ", "blue")], rate: 0, rateBlockId: " blk-x " },
      ],
      otherwise: 0.5,
    });
    expect(normalized?.rules[0]?.rateBlockId).toBe("blk-x");
  });

  it("coerces non-finite rates to 0 and rejects non-config shapes", () => {
    expect(normalizeRateRules(null)).toBeUndefined();
    expect(normalizeRateRules("x")).toBeUndefined();
    expect(normalizeRateRules({})).toBeUndefined();
    const normalized = normalizeRateRules({
      rules: [{ when: [fieldTerm("u_n", "NUMBER", "EQ", 1)], rate: Infinity }],
      otherwise: NaN,
    });
    expect(normalized).toEqual({
      rules: [{ when: [fieldTerm("u_n", "NUMBER", "EQ", 1)], rate: 0 }],
      otherwise: 0,
    });
  });

  it("drops empty IN lists and blank values", () => {
    const normalized = normalizeRateRules({
      rules: [
        { when: [fieldTerm("u_t", "TEXT", "IN", [])], rate: 1 },
        { when: [fieldTerm("u_t", "TEXT", "EQ", "   ")], rate: 2 },
      ],
      otherwise: 0,
    });
    expect(normalized?.rules).toHaveLength(0);
  });
});
