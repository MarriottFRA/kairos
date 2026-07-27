/**
 * The Job Title pair — local wording beside the group-wide title.
 *
 * The point of two columns is that each one is allowed to be what it is: the
 * local title must never be constrained to a list (users type the name on the
 * contract whatever the system offers), and the standard title must never be
 * free text (it exists to make the same role report as one title). These tests
 * pin exactly that, plus the properties that keep the pair cheap: neither is
 * derived from the other, neither is PII, and neither reaches the engine.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG } from "../fieldSeed";
import { ENGINE_SCALAR_COLUMNS, PII_CORE_COLUMNS } from "../fields";
import { newDraftRow, rowToEnginePosition } from "../rowModel";

const LOCAL_KEY = "title";
const STANDARD_KEY = "standardJobTitle";

const fieldFor = (key: string) =>
  BUILTIN_CATALOG.fields.find((def) => def.key === key);

describe("the local title", () => {
  it("stays free text — no dropdown to fight the wording on the contract", () => {
    const def = fieldFor(LOCAL_KEY);
    expect(def).toBeDefined();
    expect(def!.dataType).toBe("TEXT");
    expect(def!.editable).toBe(true);
    expect(def!.dropdownSource ?? null).toBeNull();
  });

  it("is not masked — it names the post, not the person", () => {
    // It keeps its position_pii column purely as storage (see v4 in the seed).
    expect(fieldFor(LOCAL_KEY)!.maskable).toBe(false);
    expect(PII_CORE_COLUMNS[LOCAL_KEY]).toBe("title");
  });
});

describe("the standard title", () => {
  it("only accepts values from the group list", () => {
    const def = fieldFor(STANDARD_KEY);
    expect(def).toBeDefined();
    expect(def!.dataType).toBe("ENUM");
    expect(def!.editable).toBe(true);
    expect(def!.dropdownSource?.kind).toBe("static");

    const source = def!.dropdownSource;
    const options = source?.kind === "static" ? source.options : [];
    expect(options.length).toBeGreaterThan(0);
    // Stored value === displayed label: the column holds the title itself, so
    // moving this list to a reference table later does not restate the data.
    for (const option of options) expect(option.value).toBe(option.label);
    // A duplicate would show twice in the picker and split the rollup in two.
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
  });

  it("is an ordinary extra column — off the PII store and out of the engine", () => {
    expect(fieldFor(STANDARD_KEY)!.storage).toBe("POSITION_EXTRA");
    expect(fieldFor(STANDARD_KEY)!.maskable).toBe(false);
    expect(PII_CORE_COLUMNS[STANDARD_KEY]).toBeUndefined();
    expect(ENGINE_SCALAR_COLUMNS[STANDARD_KEY]).toBeUndefined();
  });
});

describe("the pair", () => {
  it("sits together in the Position band, local first", () => {
    const order = BUILTIN_CATALOG.fields.map((def) => def.key);
    expect(order.indexOf(STANDARD_KEY)).toBe(order.indexOf(LOCAL_KEY) + 1);
    expect(fieldFor(STANDARD_KEY)!.section).toBe(fieldFor(LOCAL_KEY)!.section);
    expect(fieldFor(STANDARD_KEY)!.section).toBe("employee");
  });

  it("starts empty on a new row — neither column guesses the other", () => {
    const row = newDraftRow(BUILTIN_CATALOG);
    expect(row[LOCAL_KEY]).toBeNull();
    expect(row[STANDARD_KEY]).toBeNull();
  });

  it("changes nothing the engine is fed", () => {
    const base = newDraftRow(BUILTIN_CATALOG);
    const titled = {
      ...base,
      [LOCAL_KEY]: "Chef de Rang — Terrace",
      [STANDARD_KEY]: "Waiter / Waitress",
    };
    expect(rowToEnginePosition(titled, "s1")).toEqual(
      rowToEnginePosition(base, "s1")
    );
  });
});
