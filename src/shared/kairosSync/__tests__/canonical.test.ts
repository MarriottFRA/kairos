/**
 * Canonical JSON — the hash input.
 *
 * The property everything downstream rests on: the same logical value must
 * serialise identically no matter how it was constructed or which order SQLite
 * handed its columns back in. If that breaks, rows look dirty forever and
 * republish on every sync.
 */

import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalNumber, canonicalize } from "../canonical";

describe("canonicalJson", () => {
  it("sorts object keys at every level", () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("never reorders arrays — they are positional", () => {
    // seasonality and monthly_values mean different things in a different order.
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("drops undefined but keeps null", () => {
    // NULL is a real, distinguishable column state; undefined is an absent key.
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("emits no whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: "x" })).toBe('{"a":[1,2],"b":"x"}');
  });

  it("turns undefined inside an array into null rather than a hole", () => {
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("is stable across a JSON round trip", () => {
    const value: Record<string, unknown> = { z: [1, { b: 2, a: 1 }], a: "x", n: null };
    const round = JSON.parse(JSON.stringify(value));
    expect(canonicalJson(round)).toBe(canonicalJson(value));
  });
});

describe("canonicalNumber", () => {
  it("collapses negative zero", () => {
    // -0 and 0 are === but stringify differently, so a subtraction that lands on
    // negative zero would otherwise change a row's hash without changing it.
    expect(Object.is(canonicalNumber(-0), 0)).toBe(true);
    expect(canonicalJson({ v: -0 })).toBe(canonicalJson({ v: 0 }));
  });

  it("absorbs float drift at the ninth decimal", () => {
    // 0.1 + 0.2 is 0.30000000000000004. Without rounding, a value the user typed
    // as 0.3 and one the engine computed would hash differently forever.
    expect(canonicalJson({ v: 0.1 + 0.2 })).toBe(canonicalJson({ v: 0.3 }));
  });

  it("keeps ordinary decimals intact", () => {
    expect(canonicalJson({ v: 1234.56 })).toBe('{"v":1234.56}');
    expect(canonicalJson({ v: 0.0725 })).toBe('{"v":0.0725}');
  });

  it("never emits exponent notation", () => {
    // The one place JS and Python's JSON writers disagree: JS writes 1e-7 where
    // Python writes 1e-07. The structure document's hash is recomputed
    // server-side, so an exponent would be a 422.
    for (const value of [1e-7, 1e-12, 1e21, 5e-324, -1e30]) {
      expect(canonicalJson({ v: value })).not.toMatch(/e[+-]/i);
    }
  });

  it("maps non-finite values to null", () => {
    expect(canonicalNumber(NaN)).toBeNull();
    expect(canonicalNumber(Infinity)).toBeNull();
    expect(canonicalJson({ v: NaN })).toBe('{"v":null}');
  });

  it("leaves safe integers alone", () => {
    expect(canonicalJson({ v: 42 })).toBe('{"v":42}');
    expect(canonicalJson({ v: -7 })).toBe('{"v":-7}');
  });
});

describe("canonicalize", () => {
  it("returns a value ready for a plain stringify", () => {
    const out = canonicalize({ b: 1, a: 2 }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["a", "b"]);
  });
});
