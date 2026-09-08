/**
 * The formula DSL: what parses, what does not, and what the evaluator makes
 * of it over Vec13 — in particular that everything is column-wise, so a
 * ratio's Total is the ratio of the totals.
 */

import { describe, expect, it } from "vitest";
import { collectRefs } from "../formula/ast";
import { evaluateFormula } from "../formula/evaluate";
import { parseFormula } from "../formula/parser";
import { FormulaSyntaxError, tokenize } from "../formula/tokenizer";
import * as vec from "../vec";

const months = (values: number[]) => vec.fromMonths(values);
const seq = (start: number) => months(Array.from({ length: 12 }, (_, m) => start + m));

function evaluate(source: string, env: Record<string, vec.Vec13>) {
  return vec.toArray(
    evaluateFormula(parseFormula(source), (id) => {
      const value = env[id];
      if (!value) throw new Error(`missing ${id}`);
      return value;
    })
  );
}

describe("tokenizer", () => {
  it("splits numbers, identifiers, operators and punctuation", () => {
    expect(tokenize("a_1 + 2.5*(b - .5) / 1e3, x").map((t) => t.type)).toEqual([
      "ident", "op", "num", "op", "lparen", "ident", "op", "num", "rparen", "op", "num", "comma", "ident",
    ]);
    expect(tokenize("1e3")[0]).toMatchObject({ type: "num", value: 1000 });
    expect(tokenize(".5")[0]).toMatchObject({ type: "num", value: 0.5 });
  });

  it("names the position of a bad character", () => {
    expect(() => tokenize("a + $b")).toThrow(/Unexpected character "\$" \(at position 4\)/);
  });
});

describe("parser", () => {
  it("honours precedence and associativity", () => {
    expect(evaluate("1 + 2 * 3", {})[0]).toBe(7);
    expect(evaluate("(1 + 2) * 3", {})[0]).toBe(9);
    expect(evaluate("8 - 3 - 2", {})[0]).toBe(3);
    expect(evaluate("8 / 2 / 2", {})[0]).toBe(2);
    expect(evaluate("-2 * -3", {})[0]).toBe(6);
    expect(evaluate("--2", {})[0]).toBe(2);
    expect(evaluate("+2", {})[0]).toBe(2);
    expect(evaluate("2 * -(1 + 1)", {})[0]).toBe(-4);
  });

  it("collects references but not function names", () => {
    const ast = parseFormula("pct(a, b + c) - abs(a) * 2");
    expect([...collectRefs(ast)].sort()).toEqual(["a", "b", "c"]);
  });

  it("rejects malformed formulas with a message and a position", () => {
    const cases: Array<[string, RegExp]> = [
      ["", /Empty formula/],
      ["a +", /Unexpected end/],
      ["a b", /Unexpected "b"/],
      ["(a", /Expected \)/],
      ["a)", /Unexpected "\)"/],
      ["div(a)", /div\(\) takes 2 arguments, got 1/],
      ["min()", /min\(\) needs at least 1 argument/],
      ["foo(a)", /Unknown function "foo"/],
      ["pct", /"pct" is a function and needs arguments/],
      ["a * / b", /Unexpected "\/"/],
    ];
    for (const [source, message] of cases) {
      expect(() => parseFormula(source), source).toThrow(FormulaSyntaxError);
      expect(() => parseFormula(source), source).toThrow(message);
    }
  });
});

describe("evaluator", () => {
  const a = seq(1); // 1..12, total 78
  const b = seq(13); // 13..24, total 222

  it("is elementwise across the twelve months and the total", () => {
    expect(evaluate("a + b", { a, b })).toEqual(vec.toArray(vec.add(a, b)));
    expect(evaluate("a - b", { a, b })[12]).toBe(78 - 222);
    expect(evaluate("a * 2", { a })).toEqual(vec.toArray(a).map((v) => v * 2));
  });

  it("makes a ratio's Total the ratio of the totals, not a sum of ratios", () => {
    const out = evaluate("a / b", { a, b });
    expect(out[0]).toBeCloseTo(1 / 13);
    expect(out[12]).toBeCloseTo(78 / 222);
    expect(evaluate("pct(a, b)", { a, b })[12]).toBeCloseTo((78 / 222) * 100);
  });

  it("divides safely: a zero divisor reads 0, never NaN or Infinity", () => {
    const zeroIn3 = months([1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const out = evaluate("a / z", { a, z: zeroIn3 });
    expect(out[2]).toBe(0);
    expect(out[0]).toBe(1);
    expect(evaluate("div(a, 0)", { a }).every((v) => v === 0)).toBe(true);
    expect(evaluate("a / 0", { a }).every((v) => v === 0)).toBe(true);
  });

  it("cum turns January-plus-changes into levels, with Total = December", () => {
    const changes = months([5, 0, 0, 0, 0, 0, 0, 0, -2, 0, 0, 0]);
    const out = evaluate("cum(x)", { x: changes });
    expect(out.slice(0, 12)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3]);
    expect(out[12]).toBe(3);
  });

  it("dec, total and avg broadcast one figure across every slot", () => {
    expect(evaluate("dec(a)", { a }).every((v) => v === 12)).toBe(true);
    expect(evaluate("total(a)", { a }).every((v) => v === 78)).toBe(true);
    expect(evaluate("avg(a)", { a }).every((v) => v === 78 / 12)).toBe(true);
  });

  it("retotal re-sums the months, for rate × volume products", () => {
    const rate = months(new Array(12).fill(2)); // total 24
    const volume = seq(1); // total 78
    const naive = evaluate("rate * volume", { rate, volume });
    expect(naive[12]).toBe(24 * 78); // the column-wise corollary
    const fixed = evaluate("retotal(rate * volume)", { rate, volume });
    expect(fixed[12]).toBe(2 * 78);
    expect(fixed.slice(0, 12)).toEqual(naive.slice(0, 12));
  });

  it("abs, neg, min and max are elementwise", () => {
    const m = months([-1, 2, -3, 4, -5, 6, -7, 8, -9, 10, -11, 12]);
    expect(evaluate("abs(m)", { m }).slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(evaluate("neg(m)", { m }).slice(0, 2)).toEqual([1, -2]);
    expect(evaluate("min(a, b, 5)", { a, b }).slice(0, 6)).toEqual([1, 2, 3, 4, 5, 5]);
    expect(evaluate("max(a, 6)", { a }).slice(0, 8)).toEqual([6, 6, 6, 6, 6, 6, 7, 8]);
  });
});
