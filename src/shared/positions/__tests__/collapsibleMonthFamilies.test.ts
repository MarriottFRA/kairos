/**
 * Collapsible month families — the Additional Cost Jan..Dec fold.
 *
 * Twelve columns hide behind one summary column, so what has to hold is that
 * hiding them is purely presentational: the fields stay in the catalog, the
 * values stay on the row and in the engine input, and the summary reads back
 * exactly what the twelve cells would. The layout half is a default that never
 * overrides a choice the user already made.
 */

import { describe, expect, it } from "vitest";
import { GridInitialState } from "@mui/x-data-grid-premium";
import { BUILTIN_CATALOG } from "../fieldSeed";
import {
  COLLAPSIBLE_MONTH_FAMILIES,
  collapsibleMonthKeys,
  vectorKey,
  vectorKeys,
} from "../fields";
import { COMPUTES, PositionRow, rowToEnginePosition } from "../rowModel";
import {
  healCollapsedFamilies,
  healNewColumn,
} from "../../../components/positions/gridLayout";

const MONTHS = 12;

/** A row carrying `amount` of additional cost in every month. */
function rowWithCosts(amount: number): PositionRow {
  const row: PositionRow = { id: "p1" };
  for (let m = 1; m <= MONTHS; m++) {
    row[vectorKey("additionalMonthlyCosts", m)] = amount;
    row[vectorKey("seasonality", m)] = 1;
  }
  return row;
}

describe("the catalog side", () => {
  it("summarizes each collapsible family with a COMPUTED column right in front of it", () => {
    for (const [summaryKey, vector] of Object.entries(COLLAPSIBLE_MONTH_FAMILIES)) {
      const summary = BUILTIN_CATALOG.fields.find((def) => def.key === summaryKey);
      expect(summary, `${summaryKey} is seeded`).toBeDefined();
      expect(summary!.storage).toBe("COMPUTED");
      expect(summary!.computeKey && COMPUTES[summary!.computeKey]).toBeTypeOf("function");

      const order = BUILTIN_CATALOG.fields.map((def) => def.key);
      const firstMonth = order.indexOf(vectorKey(vector, 1));
      // Immediately in front, and in the same band — a summary parked anywhere
      // else would leave a gap in its section and draw the banner twice.
      expect(order.indexOf(summaryKey)).toBe(firstMonth - 1);
      expect(summary!.section).toBe(
        BUILTIN_CATALOG.fields.find((def) => def.key === vectorKey(vector, 1))!.section
      );
    }
  });

  it("leaves the collapsed months visible in the catalog — folded is not removed", () => {
    for (const key of collapsibleMonthKeys()) {
      const def = BUILTIN_CATALOG.fields.find((field) => field.key === key);
      expect(def, `${key} is seeded`).toBeDefined();
      // visible:false is the Manage Columns "removed" surface, persisted per OU.
      // Collapsing must not go near it, or expanding would need a catalog write.
      expect(def!.visible).toBe(true);
      expect(def!.editable).toBe(true);
    }
  });
});

describe("the summary value", () => {
  it("is the plain sum of the twelve cells it stands in for", () => {
    expect(COMPUTES.additionalCostsTotal(rowWithCosts(50))).toBeCloseTo(600, 6);
    expect(COMPUTES.additionalCostsTotal({ id: "empty" })).toBe(0);
  });

  it("ignores seasonality — the weighted cost is Full Year Wage's job", () => {
    const row = rowWithCosts(50);
    // Half the year closed: the entered figures are unchanged, what they cost is not.
    for (let m = 7; m <= MONTHS; m++) row[vectorKey("seasonality", m)] = 0;
    expect(COMPUTES.additionalCostsTotal(row)).toBeCloseTo(600, 6);
    expect(COMPUTES.fullYearWage(row)).toBeCloseTo(300, 6);
  });

  it("does not change what the engine is fed", () => {
    const position = rowToEnginePosition(rowWithCosts(50), "s1");
    expect(position.additionalMonthlyCosts).toEqual(Array(MONTHS).fill(50));
  });
});

describe("the saved layout", () => {
  const monthKeys = collapsibleMonthKeys();

  it("folds the family away in a layout saved before the feature existed", () => {
    const saved: GridInitialState = { columns: { columnVisibilityModel: {} } };
    const healed = healCollapsedFamilies(saved, monthKeys);
    for (const key of monthKeys) {
      expect(healed.columns?.columnVisibilityModel?.[key]).toBe(false);
    }
  });

  it("leaves an expanded family expanded", () => {
    const saved: GridInitialState = {
      columns: {
        columnVisibilityModel: Object.fromEntries(monthKeys.map((key) => [key, true])),
      },
    };
    expect(healCollapsedFamilies(saved, monthKeys)).toBe(saved);
  });

  it("does not disturb an unrelated hidden column", () => {
    const saved: GridInitialState = {
      columns: { columnVisibilityModel: { hourlyRate: false } },
    };
    const healed = healCollapsedFamilies(saved, monthKeys);
    expect(healed.columns?.columnVisibilityModel?.hourlyRate).toBe(false);
    expect(healed.columns?.columnVisibilityModel?.[monthKeys[0]]).toBe(false);
  });

  it("splices the summary column in front of its family, not onto the far right", () => {
    const [summaryKey, vector] = Object.entries(COLLAPSIBLE_MONTH_FAMILIES)[0];
    const saved: GridInitialState = {
      columns: { orderedFields: ["monthlyBaseSalary", ...vectorKeys(vector), "fullYearWage"] },
    };
    const ordered = healNewColumn(saved, summaryKey, vectorKey(vector, 1)).columns
      ?.orderedFields;
    expect(ordered?.indexOf(summaryKey)).toBe(1);
    expect(ordered?.at(-1)).toBe("fullYearWage");
  });

  it("leaves a layout that already places the summary column alone", () => {
    const saved: GridInitialState = {
      columns: { orderedFields: ["fullYearWage", "additionalCostsTotal", "addc_1"] },
    };
    expect(healNewColumn(saved, "additionalCostsTotal", "addc_1")).toBe(saved);
  });

  // A pre-v22 layout knows every column except Standard Title, so the grid would
  // append it after the last field it does know — vacationEstimate.
  it("keeps Standard Title beside Job Title in a layout saved before it existed", () => {
    const saved: GridInitialState = {
      columns: {
        orderedFields: ["title", "payType", "cluster", "vacationEstimate"],
      },
    };
    const ordered = healNewColumn(saved, "standardJobTitle", "payType").columns
      ?.orderedFields;
    expect(ordered).toEqual([
      "title",
      "standardJobTitle",
      "payType",
      "cluster",
      "vacationEstimate",
    ]);
  });
});
