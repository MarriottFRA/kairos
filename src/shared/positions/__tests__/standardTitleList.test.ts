/**
 * The Standard Title list itself.
 *
 * jobTitlePair.test.ts pins what the FIELD is (closed list, not PII, invisible
 * to the engine). This pins what the LIST is: the shape the grouped picker
 * needs, and the curation rules that keep it a group-wide list rather than a
 * second free-text column. The rules are the reason the list is short, so they
 * are worth failing a build over — a title added by copying its neighbour and
 * prefixing "Assistant" is exactly the drift this column exists to stop.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG } from "../fieldSeed";

const source = BUILTIN_CATALOG.fields.find(
  (def) => def.key === "standardJobTitle"
)?.dropdownSource;
const options = source?.kind === "static" ? source.options : [];

describe("the standard title list", () => {
  it("files every title under a section", () => {
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect(option.group).toBeTruthy();
  });

  it("keeps each section contiguous", () => {
    // MUI's groupBy starts a new header every time the key changes, so a title
    // emitted away from its own group prints that header twice.
    const seen = new Set<string>();
    let current: string | undefined;
    for (const option of options) {
      if (option.group === current) continue;
      expect(seen.has(option.group!)).toBe(false);
      seen.add(option.group!);
      current = option.group;
    }
  });

  it("stays short enough to read", () => {
    // Not a hard ceiling — a signal. Past ~90 the list is encoding something
    // Classification or Department already carries (see the seed docblock).
    expect(options.length).toBeLessThanOrEqual(90);
  });

  it("carries no seniority-prefixed variant of another title", () => {
    const titles = new Set(options.map((option) => String(option.value)));
    for (const title of titles) {
      const stripped = title.replace(/^(Assistant|Deputy|Junior|Senior) /, "");
      if (stripped === title) continue;
      // Classification is the grade and the local Job Title keeps the wording,
      // so the parent title alone is the entry.
      expect(titles.has(stripped)).toBe(false);
    }
  });

  it("still covers every department the grid can group by", () => {
    // The prune must not leave a department with nothing to pick: a hotel that
    // finds no title for a whole team stops using the column.
    const groups = new Set(options.map((option) => option.group));
    expect(groups).toEqual(
      new Set([
        "Executive",
        "Finance & Purchasing",
        "Human Resources",
        "IT",
        "Front Office",
        "Housekeeping",
        "Food & Beverage",
        "Kitchen",
        "Sales, Marketing & Events",
        "Engineering",
        "Security",
        "Spa & Recreation",
        "General",
      ])
    );
  });
});
