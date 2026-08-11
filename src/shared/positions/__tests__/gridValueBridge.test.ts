/**
 * Grid value bridge — the Edit Position form reading/writing through the grid's
 * own column definitions.
 *
 * The form is a second editing surface over the same rows, and the rules that
 * make an edit correct are not in the row or in sanitizeRow — they are in the
 * GridColDef callbacks (PERCENT scaling, ISO dates, the two auto/override
 * fields, PII masking). Rather than re-implement them, the form calls them. So
 * what has to hold here is that calling them from outside a mounted grid gives
 * the same answers the grid gets, and in particular that the two setters which
 * silently drop an echoed derived value keep doing so — because getting those
 * wrong freezes a row into a manual override that stops tracking the calendar
 * or the cluster, which is invisible data corruption rather than a visible bug.
 */

import { describe, expect, it } from "vitest";
import { GridColDef } from "@mui/x-data-grid-premium";
import {
  buildColumns,
  cellEditable,
  ColumnFactoryContext,
  MASK_TEXT,
} from "../../../components/positions/columnFactory";
import {
  commitValue,
  dayToDate,
  displayValue,
  editValue,
  isoDay,
  rawEditText,
} from "../../../components/positions/gridValueBridge";
import { BUILTIN_CATALOG } from "../fieldSeed";
import {
  BASIC_SALARY_ANNUAL_KEY,
  BASIC_SALARY_HOURLY_KEY,
  BASIC_SALARY_MONTHLY_KEY,
  FieldDef,
  HOTEL_CLUSTER_KEY,
  HOTEL_CLUSTER_MULT_KEY,
  SALARY_ENTRY_MODE_KEY,
} from "../fields";
import { PositionRow } from "../rowModel";
import { staticDerivedRowValues } from "../derivedRowValues";
import { HotelClusterDto } from "../../hotelClusters/ipc";

const SINGLE: HotelClusterDto = {
  id: "c1",
  name: "Aberdeen only",
  members: [{ ou: "H001", weight: 0.8 }],
  sortOrder: 10,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SHARED: HotelClusterDto = {
  id: "c2",
  name: "North",
  members: [
    { ou: "H001", weight: 0.6 },
    { ou: "H002", weight: 0.4 },
  ],
  sortOrder: 20,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function ctx(overrides: Partial<ColumnFactoryContext> = {}): ColumnFactoryContext {
  return {
    masked: false,
    numberFormat: new Intl.NumberFormat("en-GB"),
    departments: [],
    accounts: [],
    derived: staticDerivedRowValues(),
    hotelClusters: [SINGLE, SHARED],
    currentOu: "H001",
    ...overrides,
  };
}

function columnsOf(context = ctx()): Map<string, GridColDef<PositionRow>> {
  return new Map(buildColumns(BUILTIN_CATALOG, context).map((col) => [col.field, col]));
}

function col(field: string, context = ctx()): GridColDef<PositionRow> {
  const found = columnsOf(context).get(field);
  if (!found) throw new Error(`no column for ${field}`);
  return found;
}

function def(key: string): FieldDef {
  const found = BUILTIN_CATALOG.fields.find((field) => field.key === key);
  if (!found) throw new Error(`no field def for ${key}`);
  return found;
}

describe("percent fields", () => {
  const merit = col("meritIncreasePct");

  it("shows the stored fraction as a percentage", () => {
    expect(displayValue(merit, { id: "p1", meritIncreasePct: 0.05 })).toBe("5%");
  });

  it("stores a typed whole percentage as a fraction", () => {
    const next = commitValue(merit, { id: "p1" }, "5");
    expect(next.meritIncreasePct).toBeCloseTo(0.05, 10);
  });

  it("accepts the three shapes a user might type", () => {
    for (const typed of ["5", "5%", "0.05"]) {
      expect(commitValue(merit, { id: "p1" }, typed).meritIncreasePct).toBeCloseTo(
        0.05,
        10
      );
    }
  });

  it("seeds the input with the typed scale, not the display scale", () => {
    // Round-trip: what rawEditText offers must parse back to what was stored,
    // or focusing a field and tabbing straight out would change its value.
    const row: PositionRow = { id: "p1", meritIncreasePct: 0.05 };
    const seeded = rawEditText(merit, def("meritIncreasePct"), row);
    expect(seeded).toBe("5");
    expect(commitValue(merit, row, seeded).meritIncreasePct).toBeCloseTo(0.05, 10);
  });

  it("round-trips a vacation weight on the stored scale, no percent skin", () => {
    // Vacation months are WEIGHTS (seed v25), not percentages: no ×100, no "%",
    // and no >1 → /100 parse. A legacy row still holding 1/12 therefore offers
    // 1/12 to the editor, and a typed 2 stays 2 rather than becoming 0.02.
    const weights = col("vacw_1");
    const row: PositionRow = { id: "p1", vacw_1: 1 / 12 };
    const seeded = rawEditText(weights, def("vacw_1"), row);
    expect(Number(seeded)).toBeCloseTo(1 / 12, 10);
    expect(commitValue(weights, row, seeded).vacw_1).toBeCloseTo(1 / 12, 10);
    // NUMBER columns commit the raw entry (sanitizeRow coerces); what matters
    // is that 2 is NOT read as 2% and quietly stored as 0.02.
    expect(Number(commitValue(weights, row, "2").vacw_1)).toBe(2);
  });
});

describe("date fields", () => {
  const hiring = col("hiringDate");

  it("hands the form a Date and takes an ISO day back", () => {
    const row: PositionRow = { id: "p1", hiringDate: "2026-03-05" };
    const value = editValue(hiring, row);
    expect(value).toBeInstanceOf(Date);
    expect(isoDay(value as Date)).toBe("2026-03-05");
  });

  it("does not shift the day when the form writes the date back", () => {
    // The column's setter serializes with toISOString(), so a Date built at
    // local midnight would land a day early for anyone east of UTC.
    const row: PositionRow = { id: "p1", hiringDate: "2026-03-05" };
    const seeded = rawEditText(hiring, def("hiringDate"), row);
    expect(seeded).toBe("2026-03-05");
    expect(commitValue(hiring, row, dayToDate(seeded)).hiringDate).toBe("2026-03-05");
  });

  it("clears on an unparseable day rather than storing garbage", () => {
    expect(dayToDate("not a date")).toBeNull();
    expect(commitValue(hiring, { id: "p1" }, null).hiringDate).toBeNull();
  });
});

describe("manhours worked — auto unless overridden", () => {
  const context = ctx({
    derived: staticDerivedRowValues({ manhoursWorkedById: new Map([["p1", 1800]]) }),
  });
  const manhours = col("yearlyHoursWorked", context);
  const row: PositionRow = { id: "p1", yearlyHoursWorked: null };

  it("shows the calendar-derived hours when nothing is stored", () => {
    expect(editValue(manhours, row)).toBe(1800);
  });

  it("stays auto when the derived value is committed back unchanged", () => {
    // This is the trap the form would fall into on its own: it seeds the input
    // from the EFFECTIVE value, so an untouched field commits 1800 — and
    // persisting that would freeze the row as a manual override.
    expect(commitValue(manhours, row, 1800).yearlyHoursWorked).toBeNull();
    expect(commitValue(manhours, row, "1800").yearlyHoursWorked ?? null).toBeNull();
  });

  it("stores a genuine override", () => {
    expect(commitValue(manhours, row, 1900).yearlyHoursWorked).toBe(1900);
  });

  it("falls back to auto when cleared", () => {
    const overridden: PositionRow = { id: "p1", yearlyHoursWorked: 1900 };
    expect(commitValue(manhours, overridden, null).yearlyHoursWorked).toBeNull();
  });
});

describe("cluster multiplier — auto unless overridden", () => {
  const single: PositionRow = { id: "p1", [HOTEL_CLUSTER_KEY]: "c1" };
  const multiplier = col(HOTEL_CLUSTER_MULT_KEY);

  it("shows the cluster's own weight when nothing is stored", () => {
    expect(editValue(multiplier, single)).toBeCloseTo(0.8, 10);
    expect(displayValue(multiplier, single)).toBe("×0.80");
  });

  it("drops an echo of the cluster weight by returning the row unchanged", () => {
    // Identity, not deep equality: the caller skips the write on `next === row`,
    // exactly as changedFieldKeys concludes nothing changed in the grid.
    expect(commitValue(multiplier, single, 0.8)).toBe(single);
    expect(single[HOTEL_CLUSTER_MULT_KEY]).toBeUndefined();
  });

  it("stores a real override", () => {
    expect(commitValue(multiplier, single, 0.5)[HOTEL_CLUSTER_MULT_KEY]).toBe(0.5);
  });
});

describe("PII masking", () => {
  const masked = ctx({ masked: true });

  it("shows dots for every maskable field", () => {
    const columns = columnsOf(masked);
    const maskable = BUILTIN_CATALOG.fields.filter((field) => field.maskable);
    expect(maskable.length).toBeGreaterThan(0);
    for (const field of maskable) {
      const column = columns.get(field.key);
      if (!column) continue;
      expect(displayValue(column, { id: "p1", [field.key]: "Jane" })).toBe(MASK_TEXT);
    }
  });

  it("locks every maskable field against editing, not just against reading", () => {
    const maskableKeys = new Set(
      BUILTIN_CATALOG.fields.filter((field) => field.maskable).map((field) => field.key)
    );
    const columns = columnsOf(masked);
    for (const key of maskableKeys) {
      const column = columns.get(key);
      if (!column) continue;
      expect(
        cellEditable({ id: "p1" }, column, {
          masked: true,
          maskableKeys,
          hotelClusters: [],
          currentOu: "H001",
        })
      ).toBe(false);
    }
  });
});

describe("editability", () => {
  const maskableKeys = new Set(
    BUILTIN_CATALOG.fields.filter((field) => field.maskable).map((field) => field.key)
  );
  const base = { masked: false, maskableKeys, hotelClusters: [SINGLE, SHARED], currentOu: "H001" };

  it("locks every derived column", () => {
    const columns = columnsOf();
    const computed = BUILTIN_CATALOG.fields.filter(
      (field) => field.storage === "COMPUTED" && field.visible
    );
    expect(computed.length).toBeGreaterThan(0);
    for (const field of computed) {
      expect(cellEditable({ id: "p1" }, columns.get(field.key)!, base)).toBe(false);
    }
  });

  it("leaves exactly one basic-salary face live per entry mode", () => {
    const faces = [
      BASIC_SALARY_MONTHLY_KEY,
      BASIC_SALARY_ANNUAL_KEY,
      BASIC_SALARY_HOURLY_KEY,
    ];
    const columns = columnsOf();
    const live = (row: PositionRow) =>
      faces.filter((key) => cellEditable(row, columns.get(key)!, base));

    expect(live({ id: "p1", payType: "SALARIED", [SALARY_ENTRY_MODE_KEY]: "ANNUAL" })).toEqual([
      BASIC_SALARY_ANNUAL_KEY,
    ]);
    expect(live({ id: "p1", payType: "SALARIED", [SALARY_ENTRY_MODE_KEY]: "MONTHLY" })).toEqual([
      BASIC_SALARY_MONTHLY_KEY,
    ]);
    expect(live({ id: "p1", payType: "HOURLY" })).toEqual([BASIC_SALARY_HOURLY_KEY]);
  });

  it("allows a hand override only on a single-hotel cluster", () => {
    const columns = columnsOf();
    const multiplier = columns.get(HOTEL_CLUSTER_MULT_KEY)!;
    expect(cellEditable({ id: "p1", [HOTEL_CLUSTER_KEY]: "c1" }, multiplier, base)).toBe(true);
    expect(cellEditable({ id: "p1", [HOTEL_CLUSTER_KEY]: "c2" }, multiplier, base)).toBe(false);
    expect(cellEditable({ id: "p1" }, multiplier, base)).toBe(false);
  });

  it("keeps ordinary fields editable — the form must not lock what the grid allows", () => {
    const columns = columnsOf();
    for (const key of ["headcount", "title", "dailyContractHours"]) {
      expect(cellEditable({ id: "p1" }, columns.get(key)!, base)).toBe(true);
    }
  });
});

describe("display fallbacks", () => {
  it("resolves an enum to its label, which MUI would otherwise do at runtime", () => {
    const payType = col("payType");
    // If columnFactory ever grew a valueFormatter for singleSelect columns, CSV
    // export would start emitting raw codes — so this asserts the absence too.
    expect(payType.valueFormatter).toBeUndefined();
    expect(displayValue(payType, { id: "p1", payType: "HOURLY" })).toBe("Hourly");
  });

  it("renders an empty cell as an empty string, never 'null'", () => {
    for (const key of ["title", "headcount", "hiringDate", "meritIncreasePct"]) {
      expect(displayValue(col(key), { id: "p1" })).toBe("");
    }
  });

  it("formats numbers the way the cell does", () => {
    expect(displayValue(col("monthlyBaseSalary"), { id: "p1", monthlyBaseSalary: 1800 })).toBe(
      "1,800"
    );
  });
});

describe("the precondition the bridge rests on", () => {
  it("never installs a callback that needs the grid api or the column", () => {
    // Calling these outside a mounted grid is only safe while they read
    // (value, row). A callback that reached for `apiRef` would get undefined
    // here and fail in the form but not in the grid — so fail loudly instead.
    const columns = buildColumns(BUILTIN_CATALOG, ctx());
    for (const column of columns) {
      for (const name of [
        "valueGetter",
        "valueSetter",
        "valueFormatter",
        "valueParser",
      ] as const) {
        const fn = column[name] as ((...args: unknown[]) => unknown) | undefined;
        if (fn) expect(fn.length, `${column.field}.${name}`).toBeLessThanOrEqual(2);
      }
    }
  });
});
