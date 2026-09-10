/**
 * The grid's Full Year Wage and the engine's base line agree on an hourly row.
 * -----------------------------------------------------------
 * An hourly position is paid rate × the hours its OWN Contract columns give it
 * (Yearly Days − Days Off − Public Holidays − Vacation, plus the vacation back
 * as paid time). Both the grid preview (rowModel.COMPUTES.fullYearWage) and the
 * engine (BASE_SALARY_HOURLY) read that figure through the same
 * hourlyPaidHours(position) — this pins it.
 *
 * The bug this guards against (2026-09-10): the engine spread rate × daily
 * hours × the HOTEL CALENDAR's net productive days (~252) while the grid showed
 * rate × the contract's days, so a part-time contract of 105 paid days read
 * 15,024 on the grid and 36,069 on the Results page. The Home-page defaults
 * SEED a new row's Contract columns; after that, the row is the truth.
 */

import { describe, expect, it } from "vitest";
import { makeCalendarContext } from "../../engine/calendarContext";
import { referenceVacation } from "../../engine/reference";
import { compile, simulate } from "../../engine/simulate";
import { MONTHS } from "../../engine/types";
import { SCENARIO_ID, makeDef, makeInput, posId } from "../../engine/__tests__/fixtures";
import { EMPTY_FULL_TIME_REFERENCE } from "../../positionDefaults";
import { vectorKey } from "../fields";
import { COMPUTES, PositionRow, rowToEnginePosition } from "../rowModel";

/** A real-shaped hotel year: 252 net productive days, unevenly spread. */
const UNEVEN = makeCalendarContext([21, 20, 22, 21, 21, 22, 22, 21, 22, 22, 20, 18]);
const FLAT = makeCalendarContext(new Array(MONTHS).fill(20));

/** The reported row: 365 yearly days, 260 off, 4 public holidays, 10 h/day,
 *  13.96/h — 101 productive days, 1,010 paid hours. */
function hourlyRow(overrides: Partial<PositionRow> = {}): PositionRow {
  const row: PositionRow = {
    id: "p1",
    departmentCode: "1010",
    jobTypeCode: "A1",
    cluster: "",
    payType: "HOURLY",
    headcount: 1,
    hourlyRate: 13.96,
    monthlyBaseSalary: 0,
    dailyContractHours: 10,
    contractYearlyDays: 365,
    contractDaysOff: 260,
    contractPubHolidays: 4,
    vacationDays: 0,
    yearlyHoursWorked: 0,
    meritIncreasePct: 0,
    increaseMonth: 13,
    ...overrides,
  };
  for (let m = 1; m <= MONTHS; m++) {
    row[vectorKey("seasonality", m)] = 1;
    row[vectorKey("vacationMonthlyWeights", m)] = 1 / MONTHS;
    row[vectorKey("additionalMonthlyCosts", m)] = 0;
  }
  return row;
}

function baseLine(row: PositionRow, calendar = UNEVEN): Float64Array {
  const position = rowToEnginePosition(row, SCENARIO_ID, EMPTY_FULL_TIME_REFERENCE, calendar);
  const input = makeInput({
    definitions: [makeDef({ id: "base", kind: "BASE_SALARY", accountCode: "610000" })],
    positions: [position],
    calendar,
  });
  const compiled = compile(input);
  if (!("plan" in compiled)) throw new Error("compile failed");
  const line = simulate(compiled.plan)
    .positionLines(posId("p1"))
    .find((entry) => (entry.component.id as string) === "base");
  if (!line) throw new Error("no base line");
  return line.months;
}

const sum = (values: ArrayLike<number>) => Array.from(values).reduce((a, b) => a + b, 0);

describe("hourly Full Year Wage follows the row's contract, on the grid and in the engine", () => {
  it("pays 1,010 contract hours × rate, not the calendar's 252 days × daily hours", () => {
    const row = hourlyRow();
    const preview = COMPUTES.fullYearWage(row, { calendar: UNEVEN });
    expect(preview).toBeCloseTo(13.96 * 1010, 6);

    const engine = sum(baseLine(row));
    expect(engine).toBeCloseTo(preview, 6);
    // The old figure — what the hotel calendar would have paid.
    expect(engine).not.toBeCloseTo(13.96 * 10 * 252, 0);
  });

  it("does not move when the hotel calendar does", () => {
    const row = hourlyRow();
    expect(sum(baseLine(row, FLAT))).toBeCloseTo(sum(baseLine(row, UNEVEN)), 6);
  });

  it("previews the merit ramp exactly on a flat calendar (3% from March)", () => {
    const row = hourlyRow({ meritIncreasePct: 0.03, increaseMonth: 3 });
    const preview = COMPUTES.budgetYearBasicSalary(row, { calendar: FLAT });
    // 13.96 × 1010 × (2 + 10 × 1.03) / 12
    expect(preview).toBeCloseTo(14452.09, 2);
    expect(sum(baseLine(row, FLAT))).toBeCloseTo(preview, 6);
  });

  it("counts vacation as paid time: net base + vacation cost = the preview", () => {
    const row = hourlyRow({ vacationDays: 10 });
    const preview = COMPUTES.fullYearWage(row, { calendar: UNEVEN });
    // (101 − 10) worked days + 10 days' leave, all at 10 h — still 1,010 hours.
    expect(preview).toBeCloseTo(13.96 * 1010, 6);

    const position = rowToEnginePosition(row, SCENARIO_ID, EMPTY_FULL_TIME_REFERENCE, UNEVEN);
    const vacation = sum(referenceVacation(position, UNEVEN));
    expect(vacation).toBeCloseTo(10 * 13.96 * 10, 6);
    expect(sum(baseLine(row)) + vacation).toBeCloseTo(preview, 6);
  });

  it("takes a typed Manhours Worked override at its word", () => {
    const row = hourlyRow({ yearlyHoursWorked: 800, vacationDays: 5 });
    const preview = COMPUTES.fullYearWage(row, { calendar: UNEVEN });
    expect(preview).toBeCloseTo(13.96 * (800 + 5 * 10), 6);
    const position = rowToEnginePosition(row, SCENARIO_ID, EMPTY_FULL_TIME_REFERENCE, UNEVEN);
    expect(sum(baseLine(row)) + sum(referenceVacation(position, UNEVEN))).toBeCloseTo(preview, 6);
  });

  it("derives from the Contract columns alone when no calendar is loaded yet", () => {
    const row = hourlyRow();
    expect(COMPUTES.fullYearWage(row)).toBeCloseTo(13.96 * 1010, 6);
  });
});
