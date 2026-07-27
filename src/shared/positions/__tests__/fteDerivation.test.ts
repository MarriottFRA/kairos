/**
 * FTE derivation — the calendar-and-contract replacement for the old free-entry
 * FTE field. Pins the shape of the workbook formula it reproduces
 * (Associate Details column P):
 *
 *   =(((I4-BA4-J4-K4)*L4)/12*AD4)/((Menu!$O$14-$BA4)*(FT_Hours/5))
 *
 *   I  contractYearlyDays    BA vacationDays      J  contractDaysOff
 *   K  contractPubHolidays   L  dailyContractHours  AD Σ working months
 *   Menu!$O$14  full-time productive days   FT_Hours  full-time weekly hours
 *
 * Both engine-input paths (loadScenarioInput, runLiveSim) and the grid's FTE
 * column call deriveFte, so this is the one place the math is stated.
 */

import { describe, expect, it } from "vitest";
import { deriveFte, readContractDays } from "../engineInput";
import {
  buildDefaultPositionDefaults,
  dailyHoursFromWeekly,
  fullTimeReference,
  normalizePositionDefaults,
} from "../../positionDefaults";
import type { Position } from "../../engine/types";

/** A hotel whose full-timer works 250 productive days at 8h (40h ÷ 5). */
const REFERENCE = { productiveDays: 250, dailyHours: 8 };

/** The same contract the reference describes: 365 − 104 − 11 = 250 days. */
const FULL_TIME_CONTRACT = {
  contractYearlyDays: 365,
  contractDaysOff: 104,
  contractPubHolidays: 11,
};

function position(
  overrides: Partial<Pick<Position, "vacationDays" | "dailyContractHours" | "seasonality">> = {}
): Pick<Position, "vacationDays" | "dailyContractHours" | "seasonality"> {
  return {
    vacationDays: 25,
    dailyContractHours: 8,
    seasonality: new Array(12).fill(1),
    ...overrides,
  };
}

describe("deriveFte", () => {
  it("is exactly 1 for a position on the hotel's own full-time contract", () => {
    expect(
      deriveFte(position(), readContractDays(FULL_TIME_CONTRACT), REFERENCE)
    ).toBeCloseTo(1, 12);
  });

  it("is 1 whatever the vacation entitlement — it cancels on both sides", () => {
    // The denominator subtracts the row's OWN vacation days (Menu!$O$14 − $BA4),
    // which is what stops a generous holiday allowance from reading as a
    // part-timer. Deliberate: do not "fix" this into a fixed denominator.
    for (const vacationDays of [0, 14, 25, 40]) {
      expect(
        deriveFte(
          position({ vacationDays }),
          readContractDays(FULL_TIME_CONTRACT),
          REFERENCE
        ),
        `vacation ${vacationDays}`
      ).toBeCloseTo(1, 12);
    }
  });

  it("scales with a shorter working day", () => {
    // Half days at the same contract = half a full-timer.
    expect(
      deriveFte(
        position({ dailyContractHours: 4 }),
        readContractDays(FULL_TIME_CONTRACT),
        REFERENCE
      )
    ).toBeCloseTo(0.5, 12);
  });

  it("prorates a seasonal position by its working months", () => {
    const sixMonths = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
    expect(
      deriveFte(
        position({ seasonality: sixMonths }),
        readContractDays(FULL_TIME_CONTRACT),
        REFERENCE
      )
    ).toBeCloseTo(0.5, 12);

    // Part-months count as the fraction they are: Σ = 9.5 of 12.
    const partial = [1, 1, 1, 0.5, 0, 1, 1, 1, 1, 1, 1, 0];
    expect(
      deriveFte(
        position({ seasonality: partial }),
        readContractDays(FULL_TIME_CONTRACT),
        REFERENCE
      )
    ).toBeCloseTo(9.5 / 12, 12);
  });

  it("counts a contract with fewer days off as more than one FTE", () => {
    // A 6-day week: 52 days off instead of 104, so ~1.21 full-timers' worth of
    // days. The ratio is allowed above 1 — that is what overtime contracts are.
    const sixDayWeek = { ...FULL_TIME_CONTRACT, contractDaysOff: 52 };
    expect(
      deriveFte(position(), readContractDays(sixDayWeek), REFERENCE)
    ).toBeCloseTo(((365 - 25 - 52 - 11) * 8) / ((250 - 25) * 8), 12);
  });

  it("matches the workbook formula on an arbitrary row", () => {
    const contract = {
      contractYearlyDays: 365,
      contractDaysOff: 96,
      contractPubHolidays: 13,
    };
    const row = position({ vacationDays: 18, dailyContractHours: 7.5 });
    row.seasonality = [1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0, 0, 0];

    // (((I - BA - J - K) * L) / 12 * AD) / ((O14 - BA) * (FT_Hours / 5))
    const expected =
      (((365 - 18 - 96 - 13) * 7.5) / 12) * 8.5 /
      ((250 - 18) * dailyHoursFromWeekly(40));

    expect(deriveFte(row, readContractDays(contract), REFERENCE)).toBeCloseTo(
      expected,
      12
    );
  });

  it("falls back to the full-time year when the row states no Yearly Days", () => {
    // Rows written before the Contract day columns existed are blank there.
    // Blank must not mean "no contract" — that would zero the FTE of every
    // pre-existing position, and with it every FTE-based pool and stat.
    expect(deriveFte(position(), readContractDays({}), REFERENCE)).toBeCloseTo(1, 12);
    expect(
      deriveFte(position({ dailyContractHours: 4 }), readContractDays({}), REFERENCE)
    ).toBeCloseTo(0.5, 12);
  });

  it("takes a row that states its Yearly Days at its word", () => {
    // Yearly Days present with blank Days Off / Public Holidays is a real
    // 365-day contract, not a row to substitute the hotel's standard into.
    expect(
      deriveFte(position(), readContractDays({ contractYearlyDays: 365 }), REFERENCE)
    ).toBeCloseTo(((365 - 25) * 8) / ((250 - 25) * 8), 12);
  });

  describe("degenerate inputs return 0 rather than dividing by zero", () => {

    it("vacation exceeds the contract's own productive days", () => {
      expect(
        deriveFte(
          position({ vacationDays: 400 }),
          readContractDays(FULL_TIME_CONTRACT),
          REFERENCE
        )
      ).toBe(0);
    });

    it("no daily hours entered", () => {
      expect(
        deriveFte(
          position({ dailyContractHours: 0 }),
          readContractDays(FULL_TIME_CONTRACT),
          REFERENCE
        )
      ).toBe(0);
    });

    it("the hotel-year defaults have not loaded", () => {
      expect(
        deriveFte(position(), readContractDays(FULL_TIME_CONTRACT), {
          productiveDays: 0,
          dailyHours: 0,
        })
      ).toBe(0);
    });

    it("vacation swallows the whole full-time year", () => {
      expect(
        deriveFte(position({ vacationDays: 250 }), readContractDays(FULL_TIME_CONTRACT), {
          productiveDays: 250,
          dailyHours: 8,
        })
      ).toBe(0);
    });
  });

  it("reads its day counts out of a raw grid row / extraValues bag", () => {
    // Values arrive as whatever the grid or the JSON blob held — strings
    // included. Anything unparseable counts as 0, never NaN.
    expect(
      readContractDays({
        contractYearlyDays: "365",
        contractDaysOff: 104,
        contractPubHolidays: null,
      })
    ).toEqual({ yearlyDays: 365, daysOff: 104, pubHolidays: 0 });
  });
});

describe("fullTimeReference", () => {
  it("is the defaults' productive year at the weekly hours' day length", () => {
    const defaults = normalizePositionDefaults("OU12345", 2027, 39, {
      yearlyDays: { value: 365, linked: false },
      daysOff: { value: 104, linked: false },
      pubHolidays: { value: 11, linked: false },
      dailyHours: { value: 6, linked: false },
    });

    // Note the defaults' own Daily Hours (6) is ignored: that field seeds a
    // position, whereas the yardstick is the hotel's standard full-time day.
    expect(fullTimeReference(defaults)).toEqual({
      productiveDays: 250,
      dailyHours: 39 / 5,
    });
  });

  it("floors at zero rather than going negative on nonsense defaults", () => {
    const defaults = normalizePositionDefaults("OU12345", 2027, 40, {
      yearlyDays: { value: 10, linked: false },
      daysOff: { value: 104, linked: false },
      pubHolidays: { value: 11, linked: false },
    });
    expect(fullTimeReference(defaults).productiveDays).toBe(0);
  });

  it("yields a zero reference — so a blank FTE — when nothing is loaded", () => {
    expect(fullTimeReference(null)).toEqual({ productiveDays: 0, dailyHours: 0 });
  });

  it("defaults a never-saved hotel-year to a 40-hour week", () => {
    const reference = fullTimeReference(
      buildDefaultPositionDefaults("OU12345", 2027)
    );
    expect(reference.dailyHours).toBe(8);
  });
});
