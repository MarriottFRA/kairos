/**
 * The grid's derived columns must not move when the live sim overlays a position.
 * -----------------------------------------------------------
 * Two code paths build an engine Position from the same grid row:
 *
 *   rowToEnginePosition            → what vacationCostById / manhoursWorkedById
 *                                    / fteById value, deliberately PER UNIT:
 *                                    raw cluster id, hotelClusterWeight 1
 *                                    (see the comment on the `cluster` field).
 *   runLiveSim's assembly          → the same object with the resolved cluster
 *                                    NAME, this hotel's share as the weight,
 *                                    the resolved worked hours and the service
 *                                    day series overlaid on top.
 *
 * The displayed Vacation Cost and Manhours columns come from the first, the
 * block totals from the second, and the two sit in adjacent cells. They agree
 * today because none of the overlaid fields feeds either derivation — which is a
 * fact about the current engine, not a law.
 *
 * These tests make it a law. If someone makes referenceVacation weight-aware, or
 * routes worked hours through the stored field, this fails loudly instead of
 * silently changing what a column shows. That is also the precondition anyone
 * would need before sharing ONE position build between the two paths — measured
 * at 0.56 ms of savings per edit at 160 rows, which is why it has not been done.
 */

import { describe, expect, it } from "vitest";
import { makeCalendarContext } from "../../engine/calendarContext";
import { referenceVacation } from "../../engine/reference";
import { deriveYearlyHoursWorked, readContractDays } from "../engineInput";
import { Position } from "../../engine/types";
import { vectorKey } from "../fields";
import { PositionRow, rowToEnginePosition } from "../rowModel";
import { serviceDaysFor } from "../serviceDays";

const CALENDAR = makeCalendarContext(new Array(12).fill(21));

/** Clustered, hourly and seasonal — every axis an overlay touches. */
function trickyRow(): PositionRow {
  const row: PositionRow = {
    id: "p1",
    departmentCode: "1010",
    jobTypeCode: "A1",
    cluster: "clu-1",
    payType: "HOURLY",
    headcount: 2,
    hourlyRate: 14.5,
    dailyContractHours: 7.5,
    monthlyBaseSalary: 0,
    vacationDays: 18,
    meritIncreasePct: 0.04,
    increaseMonth: 7,
    yearlyHoursWorked: 0,
  };
  for (let m = 1; m <= 12; m++) {
    // Via vectorKey, not a hand-written `seasonality1`: the flat keys are
    // "sea_1" / "vacw_1", and a row with the wrong ones reads as all-zero —
    // which is a silently PASSING test, since zero equals zero.
    row[vectorKey("seasonality", m)] = m <= 2 ? 0 : 1; // off for Jan/Feb
    row[vectorKey("vacationMonthlyWeights", m)] = m >= 7 ? 2 : 1;
    row[vectorKey("additionalMonthlyCosts", m)] = 0;
  }
  return row;
}

/** The same overlays runLiveSim applies, by hand — so this test fails if the
 *  overlay grows a field one of the derivations starts reading. */
function overlaid(position: Position): Position {
  const service = serviceDaysFor("2019-03-15", 2027);
  return {
    ...position,
    cluster: "Resolved Cluster Name",
    hotelClusterWeight: 0.4,
    yearlyHoursWorked: 1234,
    serviceDaysPerMonth: service.perMonth,
    serviceDaysOpening: service.opening,
  };
}

describe("live-sim overlays do not move the derived columns", () => {
  const perUnit = rowToEnginePosition(trickyRow(), "scn");

  it("vacation cost is identical before and after the overlay", () => {
    const before = referenceVacation(perUnit, CALENDAR);
    const after = referenceVacation(overlaid(perUnit), CALENDAR);
    expect(Array.from(after)).toEqual(Array.from(before));
  });

  it("vacation cost is a real number, so the test above is not vacuous", () => {
    const total = referenceVacation(perUnit, CALENDAR).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("derived manhours are identical before and after the overlay", () => {
    // The strongest case: the overlay sets yearlyHoursWorked to 1234, and the
    // derivation must keep computing from the contract rather than reading it.
    // deriveYearlyHoursWorked's Pick<> signature is what guarantees this — the
    // test is here so widening that signature cannot pass unnoticed.
    const contract = readContractDays(trickyRow());
    expect(deriveYearlyHoursWorked(overlaid(perUnit), contract, CALENDAR)).toBe(
      deriveYearlyHoursWorked(perUnit, contract, CALENDAR)
    );
  });

  it("derived manhours are a real number, so the test above is not vacuous", () => {
    expect(
      deriveYearlyHoursWorked(perUnit, readContractDays(trickyRow()), CALENDAR)
    ).toBeGreaterThan(0);
  });

  it("keeps the per-unit valuation: headcount and cluster share are not applied", () => {
    // Vacation Cost is what ONE person's leave costs, like the Headcount column
    // is one row's people. A row of 2 at a 0.4 cluster share must not show 0.8×
    // or 2× anything — the multipliers belong to the budget, not the cell.
    const single = rowToEnginePosition({ ...trickyRow(), headcount: 1 }, "scn");
    expect(Array.from(referenceVacation(perUnit, CALENDAR))).toEqual(
      Array.from(referenceVacation(single, CALENDAR))
    );
    expect(perUnit.hotelClusterWeight).toBe(1);
  });
});
