/**
 * Annual salary entry — the Annual <-> Monthly Basic pairing.
 *
 * The engine reads only monthlyBaseSalary and is untouched by this feature, so
 * what has to hold is that rowModel keeps that figure correct: derived from the
 * contract's yearly amount when the row types Annual, left alone when it types
 * Monthly, and never disturbed for a row saved before the pairing existed.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG } from "../fieldSeed";
import {
  ANNUAL_DIVISOR_KEY,
  BASIC_SALARY_ANNUAL_KEY,
  BASIC_SALARY_HOURLY_KEY,
  BASIC_SALARY_MONTHLY_KEY,
  SALARY_ENTRY_MODE_KEY,
  vectorKey,
} from "../fields";
import {
  basicSalaryCellLocked,
  newDraftRow,
  PositionRow,
  salaryEntryModeOf,
  sanitizeRow,
  toRow,
} from "../rowModel";
import { PositionRecord } from "../ipc";

const MONTHS = 12;

/** A salaried row working `workingMonths` full months from January. */
function rowWith(overrides: Partial<PositionRow> = {}, workingMonths = 12): PositionRow {
  const row: PositionRow = {
    id: "p1",
    payType: "SALARIED",
    [BASIC_SALARY_MONTHLY_KEY]: 0,
    [BASIC_SALARY_HOURLY_KEY]: 0,
    [BASIC_SALARY_ANNUAL_KEY]: 0,
    [SALARY_ENTRY_MODE_KEY]: "ANNUAL",
    [ANNUAL_DIVISOR_KEY]: "WORKING_MONTHS",
    increaseMonth: 13,
  };
  for (let m = 1; m <= MONTHS; m++) {
    row[vectorKey("seasonality", m)] = m <= workingMonths ? 1 : 0;
  }
  return { ...row, ...overrides };
}

/** sanitizeRow's contract: (newRow, oldRow, catalog). */
function sanitize(row: PositionRow, oldRow: PositionRow = row): PositionRow {
  return sanitizeRow(row, oldRow, BUILTIN_CATALOG);
}

describe("Annual → Monthly derivation", () => {
  it("spreads a full-year contract over twelve months", () => {
    const out = sanitize(rowWith({ [BASIC_SALARY_ANNUAL_KEY]: 60_000 }));
    expect(out[BASIC_SALARY_MONTHLY_KEY]).toBe(5_000);
  });

  it("spreads a part-year contract over its working months, not twelve", () => {
    // A nine-month contract states nine months' pay: 60k over 9 months is
    // 6,666.67/mo, and the budget year still books the full 60k.
    const out = sanitize(rowWith({ [BASIC_SALARY_ANNUAL_KEY]: 60_000 }, 9));
    expect(out[BASIC_SALARY_MONTHLY_KEY]).toBeCloseTo(6_666.6667, 4);
    expect((out[BASIC_SALARY_MONTHLY_KEY] as number) * 9).toBeCloseTo(60_000, 6);
  });

  it("honours a fractional working month in the divisor", () => {
    // Eleven full months plus a half: Σ seasonality = 11.5.
    const row = rowWith({ [BASIC_SALARY_ANNUAL_KEY]: 46_000 });
    row[vectorKey("seasonality", 12)] = 0.5;
    expect(sanitize(row)[BASIC_SALARY_MONTHLY_KEY]).toBeCloseTo(4_000, 6);
  });

  it("divides by a flat 12 when the row opts into that basis", () => {
    const out = sanitize(
      rowWith(
        { [BASIC_SALARY_ANNUAL_KEY]: 60_000, [ANNUAL_DIVISOR_KEY]: "TWELVE" },
        9
      )
    );
    expect(out[BASIC_SALARY_MONTHLY_KEY]).toBe(5_000);
  });

  it("keeps full precision rather than rounding to currency", () => {
    // 50,000 / 12 must not be stored as 4,166.67, or the year total comes back
    // as 49,999.99 and stops reconciling to the contract figure.
    const out = sanitize(
      rowWith({ [BASIC_SALARY_ANNUAL_KEY]: 50_000, [ANNUAL_DIVISOR_KEY]: "TWELVE" })
    );
    expect((out[BASIC_SALARY_MONTHLY_KEY] as number) * 12).toBeCloseTo(50_000, 6);
  });

  it("re-derives when a Working month changes, not just the salary cell", () => {
    // The divisor is Σ seasonality, so shortening the season must re-base the
    // monthly figure — the contract total is what stays fixed.
    const before = sanitize(rowWith({ [BASIC_SALARY_ANNUAL_KEY]: 60_000 }));
    expect(before[BASIC_SALARY_MONTHLY_KEY]).toBe(5_000);

    const shortened = { ...before };
    for (let m = 7; m <= MONTHS; m++) shortened[vectorKey("seasonality", m)] = 0;
    const after = sanitize(shortened, before);
    expect(after[BASIC_SALARY_MONTHLY_KEY]).toBe(10_000);
  });

  it("falls to 0 when the position never works, instead of dividing by zero", () => {
    const out = sanitize(rowWith({ [BASIC_SALARY_ANNUAL_KEY]: 60_000 }, 0));
    expect(out[BASIC_SALARY_MONTHLY_KEY]).toBe(0);
    expect(Number.isFinite(out[BASIC_SALARY_MONTHLY_KEY] as number)).toBe(true);
  });
});

describe("Monthly → Annual derivation", () => {
  it("reverses the conversion when the row types Monthly", () => {
    const out = sanitize(
      rowWith(
        {
          [SALARY_ENTRY_MODE_KEY]: "MONTHLY",
          [BASIC_SALARY_MONTHLY_KEY]: 6_666.666666666667,
        },
        9
      )
    );
    expect(out[BASIC_SALARY_ANNUAL_KEY]).toBeCloseTo(60_000, 6);
  });

  it("leaves the typed monthly figure exactly as entered", () => {
    const out = sanitize(
      rowWith({
        [SALARY_ENTRY_MODE_KEY]: "MONTHLY",
        [BASIC_SALARY_MONTHLY_KEY]: 4_321.99,
      })
    );
    expect(out[BASIC_SALARY_MONTHLY_KEY]).toBe(4_321.99);
  });
});

describe("Pay Basis interaction", () => {
  it("zeroes both salary faces on an hourly row", () => {
    const out = sanitize(
      rowWith({
        payType: "HOURLY",
        [BASIC_SALARY_ANNUAL_KEY]: 60_000,
        [BASIC_SALARY_HOURLY_KEY]: 30,
      })
    );
    expect(out[BASIC_SALARY_MONTHLY_KEY]).toBe(0);
    expect(out[BASIC_SALARY_ANNUAL_KEY]).toBe(0);
    expect(out[BASIC_SALARY_HOURLY_KEY]).toBe(30);
  });

  it("still clears the hourly rate on a salaried row", () => {
    const out = sanitize(
      rowWith({ [BASIC_SALARY_ANNUAL_KEY]: 60_000, [BASIC_SALARY_HOURLY_KEY]: 30 })
    );
    expect(out[BASIC_SALARY_HOURLY_KEY]).toBe(0);
  });
});

describe("which cell is live", () => {
  it("locks the derived face of the pair", () => {
    const annual = rowWith();
    expect(basicSalaryCellLocked(annual, BASIC_SALARY_ANNUAL_KEY)).toBe(false);
    expect(basicSalaryCellLocked(annual, BASIC_SALARY_MONTHLY_KEY)).toBe(true);

    const monthly = rowWith({ [SALARY_ENTRY_MODE_KEY]: "MONTHLY" });
    expect(basicSalaryCellLocked(monthly, BASIC_SALARY_ANNUAL_KEY)).toBe(true);
    expect(basicSalaryCellLocked(monthly, BASIC_SALARY_MONTHLY_KEY)).toBe(false);
  });

  it("locks both salary faces and frees the rate on an hourly row", () => {
    const hourly = rowWith({ payType: "HOURLY" });
    expect(basicSalaryCellLocked(hourly, BASIC_SALARY_ANNUAL_KEY)).toBe(true);
    expect(basicSalaryCellLocked(hourly, BASIC_SALARY_MONTHLY_KEY)).toBe(true);
    expect(basicSalaryCellLocked(hourly, BASIC_SALARY_HOURLY_KEY)).toBe(false);
  });

  it("locks the rate on a salaried row", () => {
    expect(basicSalaryCellLocked(rowWith(), BASIC_SALARY_HOURLY_KEY)).toBe(true);
  });

  it("treats an absent row as nothing to lock", () => {
    expect(basicSalaryCellLocked(undefined, BASIC_SALARY_ANNUAL_KEY)).toBe(false);
  });
});

describe("rows saved before the pairing existed", () => {
  /** A stored record with no salaryEntryMode — i.e. everything written pre-v19. */
  function legacyRecord(monthly: number, workingMonths = 12): PositionRecord {
    return {
      id: "legacy",
      scenarioId: "s1",
      lineageId: "legacy",
      active: true,
      departmentCode: "0410",
      jobTypeCode: "Associate",
      cluster: "",
      clusterMultiplierOverride: null,
      clusterLinkId: "",
      payType: "SALARIED",
      headcount: 1,
      fte: 1,
      seasonality: Array.from({ length: MONTHS }, (_v, m) =>
        m < workingMonths ? 1 : 0
      ),
      monthlyBaseSalary: monthly,
      hourlyRate: 0,
      additionalMonthlyCosts: new Array(MONTHS).fill(0),
      meritIncreasePct: 0,
      manualYearlyIncrease: 0,
      increaseMonth: 13,
      dailyContractHours: 8,
      yearlyHoursWorked: 0,
      vacationDays: 0,
      vacationMonthlyWeights: new Array(MONTHS).fill(1 / 12),
      accrualDaysPerMonth: 0,
      extraValues: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("reads as Monthly entry, so the stored engine input is untouched", () => {
    const row = toRow(legacyRecord(5_000));
    expect(salaryEntryModeOf(row)).toBe("MONTHLY");
    expect(row[BASIC_SALARY_MONTHLY_KEY]).toBe(5_000);
  });

  it("shows an Annual figure derived from the stored monthly one", () => {
    expect(toRow(legacyRecord(5_000))[BASIC_SALARY_ANNUAL_KEY]).toBe(60_000);
    expect(toRow(legacyRecord(5_000, 9))[BASIC_SALARY_ANNUAL_KEY]).toBe(45_000);
  });

  it("survives an unrelated edit without moving the monthly figure", () => {
    const loaded = toRow(legacyRecord(5_000, 9));
    const edited = sanitize({ ...loaded, headcount: 3 }, loaded);
    expect(edited[BASIC_SALARY_MONTHLY_KEY]).toBe(5_000);
    expect(edited[BASIC_SALARY_ANNUAL_KEY]).toBe(45_000);
  });
});

describe("new rows", () => {
  it("default to typing the annual contract figure", () => {
    const draft = newDraftRow(BUILTIN_CATALOG);
    expect(draft[SALARY_ENTRY_MODE_KEY]).toBe("ANNUAL");
    expect(draft[ANNUAL_DIVISOR_KEY]).toBe("WORKING_MONTHS");
    expect(draft[BASIC_SALARY_ANNUAL_KEY]).toBe(0);
    expect(draft[BASIC_SALARY_MONTHLY_KEY]).toBe(0);
  });

  it("carry an annual figure straight through to the monthly base", () => {
    const draft = newDraftRow(BUILTIN_CATALOG);
    const out = sanitize({ ...draft, [BASIC_SALARY_ANNUAL_KEY]: 48_000 }, draft);
    expect(out[BASIC_SALARY_MONTHLY_KEY]).toBe(4_000);
  });
});
