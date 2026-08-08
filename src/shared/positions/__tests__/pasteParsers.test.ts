import { describe, expect, it } from "vitest";
import {
  makeNumberPasteParser,
  makeOptionPasteParser,
  makePercentPasteParser,
} from "../pasteParsers";

// The grid builds its formatter as `new Intl.NumberFormat()`; the tests pin a
// locale so they assert the same thing on any machine.
const enUS = new Intl.NumberFormat("en-US");
const deDE = new Intl.NumberFormat("de-DE");
const frFR = new Intl.NumberFormat("fr-FR");

describe("makeNumberPasteParser", () => {
  it("round-trips what the formatter produced", () => {
    const parse = makeNumberPasteParser(enUS);
    for (const value of [0, 5, 1234, 30000, 1234567, -4200, 12.5]) {
      expect(parse(enUS.format(value))).toBe(value);
    }
  });

  it("strips the locale's thousands separator", () => {
    expect(makeNumberPasteParser(enUS)("30,000")).toBe(30000);
    expect(makeNumberPasteParser(enUS)("1,234,567")).toBe(1234567);
  });

  it("handles comma-decimal locales", () => {
    const parse = makeNumberPasteParser(deDE);
    expect(parse("30.000")).toBe(30000);
    expect(parse("1.234,5")).toBe(1234.5);
    expect(parse(deDE.format(9876.54))).toBeCloseTo(9876.54);
  });

  it("tolerates a plain space where the locale groups with NBSP", () => {
    const parse = makeNumberPasteParser(frFR);
    expect(parse(frFR.format(1234))).toBe(1234);
    expect(parse("1 234")).toBe(1234);
  });

  it("clears on an empty cell and rejects garbage", () => {
    const parse = makeNumberPasteParser(enUS);
    expect(parse("")).toBeNull();
    expect(parse("   ")).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse("abc")).toBeUndefined();
    expect(parse("12abc")).toBeUndefined();
    // A masked PII cell copies out as dots — it must not land as anything.
    expect(parse("••••••")).toBeUndefined();
  });
});

describe("makePercentPasteParser", () => {
  const parse = makePercentPasteParser(enUS);

  it("inverts the '5%' display and the whole-percent rule", () => {
    expect(parse("5%")).toBeCloseTo(0.05);
    expect(parse("5")).toBeCloseTo(0.05);
    expect(parse("0.05")).toBeCloseTo(0.05);
    expect(parse("1")).toBe(1);
  });

  it("rejects garbage instead of zeroing the cell", () => {
    // The typed-edit valueParser falls back to 0 here; on paste that would
    // silently wipe a merit increase across a pasted range.
    expect(parse("abc")).toBeUndefined();
    expect(parse("••••••")).toBeUndefined();
    expect(parse("")).toBe(0);
  });
});

describe("makeOptionPasteParser", () => {
  const payType = makeOptionPasteParser([
    { value: "SALARIED", label: "Salaried (30/360)" },
    { value: "HOURLY", label: "Hourly" },
  ]);

  it("accepts the label the grid copied", () => {
    expect(payType("Salaried (30/360)")).toBe("SALARIED");
    expect(payType("Hourly")).toBe("HOURLY");
  });

  it("accepts the stored value too, and ignores case and padding", () => {
    expect(payType("SALARIED")).toBe("SALARIED");
    expect(payType("  hourly  ")).toBe("HOURLY");
  });

  it("rejects an unknown value rather than blanking the cell", () => {
    expect(payType("Hourlyy")).toBeUndefined();
    expect(payType("••••••")).toBeUndefined();
    // No blank option in this list, so the value is required.
    expect(payType("")).toBeUndefined();
  });

  it("returns numeric option values as numbers", () => {
    const months = makeOptionPasteParser([
      ...Array.from({ length: 12 }, (_, index) => ({
        value: index + 1,
        label: new Date(2000, index, 1).toLocaleString("en", { month: "short" }),
      })),
      { value: 13, label: "None" },
    ]);
    expect(months("Jan")).toBe(1);
    expect(months("dec")).toBe(12);
    expect(months("None")).toBe(13);
    // Strict === against numeric options is exactly what MUI's default parser
    // gets wrong: a clipboard string can never match, so this column could
    // previously never accept a paste at all.
    expect(months("3")).toBe(3);
    expect(months("Smarch")).toBeUndefined();
  });

  it("clears only where the list offers a blank option", () => {
    const cluster = makeOptionPasteParser([
      { value: "", label: "None" },
      { value: "uuid-a", label: "Seaside Group" },
    ]);
    expect(cluster("Seaside Group")).toBe("uuid-a");
    expect(cluster("uuid-a")).toBe("uuid-a");
    expect(cluster("None")).toBe("");
    expect(cluster("")).toBe("");
    // A stale id whose cluster was deleted reads as this placeholder; rejecting
    // it leaves the orphan id in place instead of blanking it.
    expect(cluster("(deleted cluster)")).toBeUndefined();
  });

  it("keeps the first option that claims a key", () => {
    const dupes = makeOptionPasteParser([
      { value: "A", label: "Same" },
      { value: "B", label: "Same" },
    ]);
    expect(dupes("Same")).toBe("A");
  });
});
