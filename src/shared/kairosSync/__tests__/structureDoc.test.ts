/**
 * The OU structure document's merge rule.
 *
 * A pull is an **additive upsert with tombstone-only removal**. The failure this
 * prevents is concrete and destructive: a colleague who has not yet pulled a
 * locally created field-catalog column publishes a document without it, and
 * under a subtractive merge their publish silently deletes that column — along
 * with the `extra_values` key every position stores under it.
 *
 * So: absent never means delete. Only an explicit `deletedAt` does.
 */

import { describe, expect, it } from "vitest";
import { canonicalJson } from "../canonical";
import {
  FIELD_DIFF_LIMIT,
  STRUCTURE_DOC_VERSION,
  StructureDoc,
  calendarFromDoc,
  calendarToDoc,
  emptyStructureDoc,
  fieldCatalogFromDoc,
  fieldCatalogToDoc,
  kpiDriverToDoc,
  mergeStructureDoc,
  ssSchemeToDoc,
  componentDefToDoc,
  componentDefFromDoc,
  structureRowKey,
} from "../structureDoc";

const OU = "OU25RJ2";

function field(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ou: OU,
    fieldKey: key,
    section: "CONTRACT",
    dataType: "NUMBER",
    storage: "COLUMN",
    origin: "SYSTEM",
    locked: false,
    defaultLabel: key,
    customLabel: null,
    sortOrder: 0,
    visible: true,
    editable: true,
    maskable: false,
    vector: null,
    monthIndex: null,
    computeKey: null,
    dropdownSource: null,
    validation: null,
    defaultValue: null,
    seedVersion: 1,
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    ...extra,
  };
}

function doc(fields: Record<string, unknown>[]): StructureDoc {
  return { docVersion: STRUCTURE_DOC_VERSION, ou: OU, fieldCatalog: fields };
}

describe("mergeStructureDoc", () => {
  it("keeps a local row the incoming document does not mention", () => {
    // THE rule. A colleague on an older pull publishes without our USER column;
    // that must not read as "delete it".
    const local = doc([field("mine", { origin: "USER" }), field("shared")]);
    const incoming = doc([field("shared")]);

    const { doc: merged, changes } = mergeStructureDoc(local, incoming);
    const keys = (merged.fieldCatalog ?? []).map((row) => row.fieldKey);
    expect(keys).toContain("mine");
    expect(changes).toHaveLength(0);
  });

  it("adds a row only the incoming document has", () => {
    const local = doc([field("shared")]);
    const incoming = doc([field("shared"), field("theirs")]);

    const { doc: merged, changes } = mergeStructureDoc(local, incoming);
    expect((merged.fieldCatalog ?? []).map((row) => row.fieldKey).sort()).toEqual([
      "shared",
      "theirs",
    ]);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "added", section: "fieldCatalog" }),
    ]);
  });

  it("reports a changed row as an update and takes the incoming version", () => {
    const local = doc([field("shared", { customLabel: "Ours" })]);
    const incoming = doc([field("shared", { customLabel: "Theirs" })]);

    const { doc: merged, changes } = mergeStructureDoc(local, incoming);
    expect(merged.fieldCatalog?.[0].customLabel).toBe("Theirs");
    expect(changes).toEqual([expect.objectContaining({ kind: "updated" })]);
  });

  it("treats an explicit deletedAt as the only form of removal", () => {
    const local = doc([field("going")]);
    const incoming = doc([field("going", { deletedAt: "2026-07-02T00:00:00.000Z" })]);

    const { doc: merged, changes } = mergeStructureDoc(local, incoming);
    expect(changes).toEqual([expect.objectContaining({ kind: "removed" })]);
    // Stored as a tombstone, not dropped, so it does not come back from an
    // older peer's document on the next pull.
    expect(merged.fieldCatalog?.[0].deletedAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("does not announce a tombstone for a row we never had", () => {
    const local = doc([]);
    const incoming = doc([field("gone", { deletedAt: "2026-07-02T00:00:00.000Z" })]);

    const { changes } = mergeStructureDoc(local, incoming);
    expect(changes).toHaveLength(0);
  });

  it("does not re-announce a tombstone already applied", () => {
    const local = doc([field("gone", { deletedAt: "2026-07-02T00:00:00.000Z" })]);
    const incoming = doc([field("gone", { deletedAt: "2026-07-02T00:00:00.000Z" })]);

    expect(mergeStructureDoc(local, incoming).changes).toHaveLength(0);
  });

  it("preserves a section a newer client added that this build cannot map", () => {
    // Dropping it means a round trip through an older client silently deletes a
    // colleague's configuration — the same failure the additive rule prevents,
    // one level up.
    const local: StructureDoc = { docVersion: 1, ou: OU };
    const incoming: StructureDoc = {
      docVersion: 2,
      ou: OU,
      futureThing: [{ id: "x" }],
    };

    const { doc: merged } = mergeStructureDoc(local, incoming);
    expect(merged.futureThing).toEqual([{ id: "x" }]);
  });

  it("merges every section independently", () => {
    const local: StructureDoc = {
      docVersion: 1,
      ou: OU,
      allocations: [{ id: "a1", name: "Laundry" }],
      kpiDrivers: [{ id: "k1", label: "Rooms revenue" }],
    };
    const incoming: StructureDoc = {
      docVersion: 1,
      ou: OU,
      allocations: [{ id: "a2", name: "Meals" }],
    };

    const { doc: merged } = mergeStructureDoc(local, incoming);
    expect((merged.allocations as unknown[]).length).toBe(2);
    // The section the incoming document never mentioned survives untouched.
    expect((merged.kpiDrivers as unknown[]).length).toBe(1);
  });

  it("survives an empty document on either side", () => {
    const local = doc([field("mine")]);
    const { doc: merged } = mergeStructureDoc(local, emptyStructureDoc(OU));
    expect(merged.fieldCatalog).toHaveLength(1);

    const { doc: fromNothing } = mergeStructureDoc(emptyStructureDoc(OU), local);
    expect(fromNothing.fieldCatalog).toHaveLength(1);
  });
});

/**
 * What a row has to differ BY to count as different.
 *
 * These are the cases the suite above could not catch, because every test in it
 * builds both sides from the same helper and therefore in the same key order.
 * The app does not: `pushStructure` canonicalises before sending, so the
 * server's copy comes back with sorted keys while `buildStructureDoc` assembles
 * the local one in field-declaration order. Compared with a plain
 * `JSON.stringify` the two can never be equal, whatever the values — which
 * reported an untouched hotel's entire column set as changed in both directions,
 * and left the diff exactly as it was after downloading, so the download read as
 * a no-op.
 */
describe("what counts as a difference", () => {
  /** The server's copy: same values, canonical key order. */
  function asServerSent(row: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(canonicalJson(row)) as Record<string, unknown>;
  }

  it("does not report a row whose keys arrive in canonical order", () => {
    const local = doc([field("shared")]);
    const incoming = doc([asServerSent(field("shared"))]);

    expect(mergeStructureDoc(local, incoming).changes).toHaveLength(0);
    // And the other way round, which is the "not published" count on the card.
    expect(mergeStructureDoc(incoming, local).changes).toHaveLength(0);
  });

  it("does not report a row that differs only by updatedAt", () => {
    // Every machine seeds its own catalog with its own clock, so this is the
    // steady state for all 79 system columns at a hotel, not an edge case.
    const local = doc([field("shared", { updatedAt: "2026-07-01T00:00:00.000Z" })]);
    const incoming = doc([field("shared", { updatedAt: "2026-08-09T11:22:33.000Z" })]);

    expect(mergeStructureDoc(local, incoming).changes).toHaveLength(0);
  });

  it("does not report a row that differs only by seedVersion", () => {
    const local = doc([field("shared", { seedVersion: 29 })]);
    const incoming = doc([field("shared", { seedVersion: 28 })]);

    expect(mergeStructureDoc(local, incoming).changes).toHaveLength(0);
  });

  it("does not report a config blob whose nested keys are reordered", () => {
    const local: StructureDoc = {
      docVersion: STRUCTURE_DOC_VERSION,
      ou: OU,
      blockConfigs: [
        { id: "b1", ou: OU, blockType: "MERIT", label: "Merit", config: { a: 1, b: 2 } },
      ],
    };
    const incoming: StructureDoc = {
      docVersion: STRUCTURE_DOC_VERSION,
      ou: OU,
      blockConfigs: [
        { id: "b1", ou: OU, blockType: "MERIT", label: "Merit", config: { b: 2, a: 1 } },
      ],
    };

    expect(mergeStructureDoc(local, incoming).changes).toHaveLength(0);
  });

  it("still reports a real change, and names the field that moved", () => {
    const local = doc([field("shared", { customLabel: "Ours", visible: true })]);
    const incoming = doc([
      asServerSent(field("shared", { customLabel: "Theirs", visible: false })),
    ]);

    const { changes } = mergeStructureDoc(local, incoming);
    expect(changes).toHaveLength(1);
    expect(changes[0].fields).toEqual([
      { field: "customLabel", base: "Ours", incoming: "Theirs" },
      { field: "visible", base: "Yes", incoming: "No" },
    ]);
    expect(changes[0].moreFields).toBeUndefined();
  });

  it("caps the field list and counts what it left out", () => {
    // A row that disagrees about everything is "a different row", not something
    // anybody reads line by line — but the count must not lie about it.
    const local = doc([field("shared")]);
    const incoming = doc([
      field("shared", {
        section: "PII",
        dataType: "TEXT",
        storage: "POSITION_EXTRA",
        origin: "USER",
        locked: true,
        defaultLabel: "Other",
        customLabel: "Other",
        sortOrder: 99,
        visible: false,
        editable: false,
        maskable: true,
        vector: "MONTHLY",
        monthIndex: 3,
        computeKey: "x",
      }),
    ]);

    const { changes } = mergeStructureDoc(local, incoming);
    expect(changes[0].fields).toHaveLength(FIELD_DIFF_LIMIT);
    expect(changes[0].moreFields).toBe(2);
  });
});

describe("row keys", () => {
  it("keys the field catalog on (ou, fieldKey)", () => {
    expect(structureRowKey("fieldCatalog", field("x"))).toBe(`${OU} x`);
  });

  it("keys a calendar on (ou, year)", () => {
    expect(structureRowKey("calendars", { ou: OU, year: 2026 })).toBe(`${OU} 2026`);
  });
});

describe("child ordering", () => {
  it("sorts base refs so two clients produce the same document", () => {
    // The child tables have no ORDER BY guarantee of their own; an unstable
    // order would change the document hash without changing its meaning.
    const forward = componentDefToDoc({ id: "d1", ou: OU }, [
      { referenced_def_id: "b", sort_order: 1 },
      { referenced_def_id: "a", sort_order: 0 },
    ]);
    const reversed = componentDefToDoc({ id: "d1", ou: OU }, [
      { referenced_def_id: "a", sort_order: 0 },
      { referenced_def_id: "b", sort_order: 1 },
    ]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("round-trips a compound block's base and its ratio flag", () => {
    // Everything a compound block needs has to survive a sync hop: the COMBINE
    // selector rides base_ref as JSON, but count_exempt is a column of its own
    // and would be silently dropped if the document forgot it — the ratio would
    // then come back multiplied by headcount on the other device.
    const baseRef = JSON.stringify({
      kind: "COMBINE",
      op: "DIV",
      left: { kind: "BASE_SALARY" },
      right: { kind: "COMPONENTS", componentIds: ["sys-stat-hours:OU1"] },
    });
    const doc = componentDefToDoc(
      {
        id: "d1",
        ou: OU,
        kind: "SPREAD",
        spread_method: "PERCENT_OF",
        label: "Cost Per Hour",
        base_ref: baseRef,
        count_exempt: 1,
      },
      []
    );
    expect(doc.countExempt).toBe(true);

    const { def } = componentDefFromDoc(doc);
    expect(def.count_exempt).toBe(1);
    expect(JSON.parse(def.base_ref as string)).toEqual(JSON.parse(baseRef));
  });

  it("reads a document without countExempt as not exempt", () => {
    // A client that predates the field omits the key entirely; the flag must
    // fall back to today's behaviour rather than becoming undefined.
    const { def } = componentDefFromDoc({ id: "d1", ou: OU, kind: "SPREAD" });
    expect(def.count_exempt).toBe(0);
  });

  it("round-trips a multiplier's collapse months", () => {
    // The months are a column of their own (like count_exempt); forgetting the
    // key in either mapper would silently turn a 13th-month block back into a
    // spread on the other device.
    const doc = componentDefToDoc(
      {
        id: "d1",
        ou: OU,
        kind: "SPREAD",
        spread_method: "PERCENT_OF",
        label: "Thirteenth Salary",
        collapse_months: JSON.stringify([6, 12]),
      },
      []
    );
    expect(doc.collapseMonths).toEqual([6, 12]);

    const { def } = componentDefFromDoc(doc);
    expect(JSON.parse(def.collapse_months as string)).toEqual([6, 12]);
  });

  it("reads a document without collapseMonths as NULL — spread with the base", () => {
    const { def } = componentDefFromDoc({ id: "d1", ou: OU, kind: "SPREAD" });
    expect(def.collapse_months).toBeNull();
  });

  it("round-trips a weekday spread's mask", () => {
    // Forgetting the key in either mapper would silently zero the mask on the
    // other device — a WEEKDAY_COUNT def with no mask books nothing at all.
    const doc = componentDefToDoc(
      {
        id: "d1",
        ou: OU,
        kind: "SPREAD",
        spread_method: "WEEKDAY_COUNT",
        label: "Live Music",
        weekday_mask: 1 << 5,
      },
      []
    );
    expect(doc.weekdayMask).toBe(1 << 5);

    const { def } = componentDefFromDoc(doc);
    expect(def.weekday_mask).toBe(1 << 5);
  });

  it("reads a document without weekdayMask as NULL — not a weekday def", () => {
    const { def } = componentDefFromDoc({ id: "d1", ou: OU, kind: "SPREAD" });
    expect(def.weekday_mask).toBeNull();
  });

  it("round-trips the whole bank-holiday premium config", () => {
    // Every knob has to survive a sync hop. The coverage map is the easy one to
    // lose: it is a JSON column locally, so forgetting it in either mapper would
    // silently re-price every department at the hotel-wide fraction on the other
    // device — a change nobody made, in a number nobody looks at twice.
    const doc = calendarToDoc(
      {
        ou: OU,
        year: 2026,
        weekend_mask: 65,
        bank_holiday_enabled: 1,
        bank_holiday_staff_fraction: 0.7,
        bank_holiday_premium_multiplier: 1.5,
        bank_holiday_account: "A5120",
        bank_holiday_applies_to: "ALL",
        bank_holiday_paid_when_not_worked: 1,
        bank_holiday_coverage_json: '{"1010":0.95,"1910":0}',
        updated_at: "then",
      },
      []
    );
    // Parsed, not passed through as a string, so the document hashes on values.
    expect(doc.bankHolidayCoverageByDepartment).toEqual({ "1010": 0.95, "1910": 0 });

    const { year } = calendarFromDoc(doc);
    expect(year.bank_holiday_applies_to).toBe("ALL");
    expect(year.bank_holiday_paid_when_not_worked).toBe(1);
    expect(JSON.parse(year.bank_holiday_coverage_json as string)).toEqual({
      "1010": 0.95,
      "1910": 0,
    });
    expect(year.bank_holiday_staff_fraction).toBe(0.7);
    expect(year.bank_holiday_premium_multiplier).toBe(1.5);
  });

  it("reads a calendar from a client that predates the v4 knobs", () => {
    // Absent keys must land on the pre-v4 behaviour — hourly staff only, the
    // holiday unpaid unless worked, no overrides — not on undefined, which the
    // NOT NULL columns would reject.
    const { year } = calendarFromDoc({
      ou: OU,
      year: 2026,
      weekendMask: 65,
      bankHolidayEnabled: true,
      bankHolidayStaffFraction: 0.5,
      bankHolidayPremiumMultiplier: 2,
      bankHolidayAccount: "A5120",
      months: [],
    });
    expect(year.bank_holiday_applies_to).toBe("HOURLY");
    expect(year.bank_holiday_paid_when_not_worked).toBe(0);
    expect(year.bank_holiday_coverage_json).toBe("{}");
    // And the hotel's own saved fraction is untouched by the new 0.7 default.
    expect(year.bank_holiday_staff_fraction).toBe(0.5);
  });

  it("orders SS brackets by their ladder index", () => {
    const scheme = ssSchemeToDoc({ id: "s1", ou: OU }, [
      { bracket_index: 2, up_to: null, rate: 0.1 },
      { bracket_index: 1, up_to: 1000, rate: 0.2 },
    ]);
    expect((scheme.brackets as Array<{ bracketIndex: number }>).map((b) => b.bracketIndex))
      .toEqual([1, 2]);
  });

  it("sorts KPI patterns and account prefixes", () => {
    const driver = kpiDriverToDoc(
      { id: "k1", ou: OU },
      [{ pattern: "D06*" }, { pattern: "D04*" }],
      [{ starts_with: "62" }, { starts_with: "61" }]
    );
    expect(driver.deptPatterns).toEqual(["D04*", "D06*"]);
    expect(driver.accountPrefixes).toEqual(["61", "62"]);
  });
});

describe("field catalog round trip", () => {
  it("returns the same document after a trip through the row shape", () => {
    const original = field("x", { customLabel: "Label", maskable: true });
    const round = fieldCatalogToDoc(fieldCatalogFromDoc(original));
    expect(round).toEqual(original);
  });
});
