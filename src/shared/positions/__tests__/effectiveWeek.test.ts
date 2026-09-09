/**
 * The effective week: the contract week over the days a full-timer works
 * once the roster's average vacation is out — and the identity it exists
 * for: hours ÷ (effective week × 52) equals the grid's FTE when the roster
 * is on the average entitlement.
 */

import { describe, expect, it } from "vitest";
import { deriveFte, deriveYearlyHoursWorked } from "../engineInput";
import {
  EFFECTIVE_WEEK_DECIMALS,
  EMPTY_ROSTER_VACATION,
  EffectiveWeekPosition,
  WEEKS_PER_YEAR,
  annualizedVacation,
  deriveEffectiveWeek,
  describeEffectiveWeek,
  effectiveWeekOf,
  rosterVacation,
} from "../effectiveWeek";

const FULL = new Array<number>(12).fill(1);
const REF = { productiveDays: 261, dailyHours: 8 };

const position = (over: Partial<EffectiveWeekPosition> = {}): EffectiveWeekPosition => ({
  jobTypeCode: "Associate",
  headcount: 1,
  fte: 1,
  hotelClusterWeight: 1,
  vacationDays: 26,
  seasonality: FULL,
  ...over,
});

describe("effectiveWeekOf", () => {
  it("is the contract week when a full-timer's year is 260 days and nothing is averaged", () => {
    expect(effectiveWeekOf(40, { productiveDays: 260 }).effectiveWeek).toBe(40);
    expect(effectiveWeekOf(37.5, { productiveDays: 260 }, EMPTY_ROSTER_VACATION).effectiveWeek).toBe(37.5);
  });

  it("scales the contract week by the days actually worked", () => {
    // 40h × (260 − 26) ÷ 260: the 0.90 the ledger read a full-timer as, undone.
    const d = effectiveWeekOf(40, { productiveDays: 260 }, { averageVacationDays: 26, weightedFte: 1, positions: 1 });
    expect(d).toMatchObject({ contractWeek: 40, productiveDays: 260, dailyHours: 8, fullTimeDays: 234, fullTimeHoursYear: 1872 });
    expect(d.effectiveWeek).toBe(36);
    // 1,872 worked hours ÷ (36 × 52) reads 1.00, not 0.90.
    expect(1872 / (d.effectiveWeek * WEEKS_PER_YEAR)).toBeCloseTo(1, 10);
  });

  it("carries the public holidays and the calendar's own weekday count, not a round 52 weeks", () => {
    // 2027 has 261 weekdays; 9 public holidays leave 252. The ledger's ×52 is
    // fixed, so the week absorbs the difference — a shade UNDER the contract
    // with no vacation at all when holidays are taken, a shade over without.
    expect(effectiveWeekOf(40, { productiveDays: 252 }).effectiveWeek).toBeCloseTo(40 * (252 / 260), 9);
    expect(effectiveWeekOf(40, { productiveDays: 261 }).effectiveWeek).toBeCloseTo(40 * (261 / 260), 9);
  });

  it("derives 0 for a setup that is not finished, and never goes negative", () => {
    expect(effectiveWeekOf(0, REF).effectiveWeek).toBe(0);
    expect(effectiveWeekOf(NaN, REF).effectiveWeek).toBe(0);
    expect(effectiveWeekOf(40, { productiveDays: 0 }).effectiveWeek).toBe(0);
    expect(effectiveWeekOf(40, { productiveDays: 20 }, { averageVacationDays: 30, weightedFte: 1, positions: 1 }).effectiveWeek).toBe(0);
  });

  it("rounds the posted figure to what an Excel cell holds", () => {
    const d = effectiveWeekOf(40, { productiveDays: 261 }, { averageVacationDays: 26.123456789, weightedFte: 1, positions: 1 });
    const text = String(d.effectiveWeek);
    expect(text.split(".")[1]?.length ?? 0).toBeLessThanOrEqual(EFFECTIVE_WEEK_DECIMALS);
    expect(text.replace(".", "").length).toBeLessThanOrEqual(15);
    expect(d.effectiveWeek).toBeCloseTo((40 / 5) * (261 - 26.123456789) / 52, 9);
  });
});

describe("rosterVacation", () => {
  it("weights each position's entitlement by its FTE × count × cluster share", () => {
    const roster = rosterVacation([
      position({ vacationDays: 20, fte: 1, headcount: 3 }), // 3 FTE at 20
      position({ vacationDays: 30, fte: 0.5, headcount: 2 }), // 1 FTE at 30
      position({ vacationDays: 40, fte: 1, headcount: 1, hotelClusterWeight: 0 }), // no share here
    ]);
    expect(roster.weightedFte).toBe(4);
    expect(roster.positions).toBe(2);
    expect(roster.averageVacationDays).toBeCloseTo((3 * 20 + 1 * 30) / 4, 10);
  });

  it("leaves managers and Buyout Labour out — the ledger counts managers by head", () => {
    const roster = rosterVacation([
      position({ jobTypeCode: "Manager", vacationDays: 35 }),
      position({ jobTypeCode: "Manager (Non Exempt)", vacationDays: 35 }),
      position({ jobTypeCode: "Buyout Labour", vacationDays: 35 }),
      position({ jobTypeCode: "Supervisor", vacationDays: 22 }),
      position({ jobTypeCode: "Casual", vacationDays: 18 }),
    ]);
    expect(roster.positions).toBe(2);
    expect(roster.averageVacationDays).toBe(20);
  });

  it("is empty for no positions, and 0 with no vacation typed", () => {
    expect(rosterVacation([])).toEqual(EMPTY_ROSTER_VACATION);
    expect(rosterVacation([position({ vacationDays: 0 }), position({ vacationDays: 0 })]).averageVacationDays).toBe(0);
    // 40h over 260 days with nothing to average is 40 — the "as expected" case.
    expect(deriveEffectiveWeek(40, { productiveDays: 260 }, [position({ vacationDays: 0 })]).effectiveWeek).toBe(40);
  });

  it("annualizes a seasonal position's leave the way deriveFte does", () => {
    // Six months' seasonality: the engine position holds half a year's leave
    // (13 of a 26-day entitlement); the yardstick is a full year, so 26.
    const half = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
    expect(annualizedVacation({ vacationDays: 13, seasonality: half })).toBe(26);
    expect(annualizedVacation({ vacationDays: 26, seasonality: FULL })).toBe(26);
    expect(annualizedVacation({ vacationDays: 26, seasonality: [] })).toBe(26);
    expect(annualizedVacation({ vacationDays: 26, seasonality: new Array(12).fill(0) })).toBe(0);
    expect(rosterVacation([position({ vacationDays: 13, seasonality: half, fte: 0.5 })]).averageVacationDays).toBe(26);
  });
});

describe("the identity", () => {
  it("makes hours ÷ (effective week × 52) the grid's FTE for a roster on the average entitlement", () => {
    const contract = { yearlyDays: 0, daysOff: 0, pubHolidays: 0 }; // blank → the yardstick's days
    const calendar = { realDays: Float64Array.from(new Array(12).fill(261 / 12)) };
    const rows = [
      { vacationDays: 26, dailyContractHours: 8, seasonality: FULL, headcount: 3 },
      { vacationDays: 26, dailyContractHours: 4, seasonality: FULL, headcount: 1 }, // a half-timer
    ];
    const positions = rows.map((row) =>
      position({ headcount: row.headcount, vacationDays: row.vacationDays, fte: deriveFte(row, contract, REF) })
    );
    const gridFte = positions.reduce((sum, p) => sum + p.fte * p.headcount, 0);
    const hours = rows.reduce((sum, row) => sum + deriveYearlyHoursWorked(row, contract, calendar) * row.headcount, 0);
    const week = deriveEffectiveWeek(40, REF, positions).effectiveWeek;
    expect(gridFte).toBeCloseTo(3.5, 10);
    expect(hours / (week * WEEKS_PER_YEAR)).toBeCloseTo(gridFte, 8);
  });

  it("shows a department's leave mix against the average, and nothing else", () => {
    // Two full-timers, 20 and 32 days: the average is 26 and the hotel total
    // reconciles, while each one reads slightly off — the honest residual.
    const contract = { yearlyDays: 0, daysOff: 0, pubHolidays: 0 };
    const calendar = { realDays: Float64Array.from(new Array(12).fill(261 / 12)) };
    const rows = [
      { vacationDays: 20, dailyContractHours: 8, seasonality: FULL },
      { vacationDays: 32, dailyContractHours: 8, seasonality: FULL },
    ];
    const positions = rows.map((row) => position({ vacationDays: row.vacationDays, fte: deriveFte(row, contract, REF) }));
    const week = deriveEffectiveWeek(40, REF, positions).effectiveWeek;
    const ledger = rows.map((row) => deriveYearlyHoursWorked(row, contract, calendar) / (week * WEEKS_PER_YEAR));
    expect(ledger[0]).toBeGreaterThan(1);
    expect(ledger[1]).toBeLessThan(1);
    expect(ledger[0] + ledger[1]).toBeCloseTo(2, 8);
  });
});

describe("describeEffectiveWeek", () => {
  it("spells the working out in one line", () => {
    const text = describeEffectiveWeek(
      effectiveWeekOf(40, { productiveDays: 260 }, { averageVacationDays: 26, weightedFte: 4, positions: 4 })
    );
    expect(text).toContain("(260 productive days − 26 vacation) × 8h a day");
    expect(text).toContain("1,872 hours a year ÷ 52 weeks = 36h");
    expect(text).toContain("Contract week 40h");
    expect(text).toContain("4 hours-driven positions");
    expect(describeEffectiveWeek(effectiveWeekOf(40, { productiveDays: 260 }))).toContain("no hours-driven positions yet");
  });
});
