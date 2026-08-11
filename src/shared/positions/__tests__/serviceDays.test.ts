/**
 * Length-of-service day counts — the input for the SERVICE block bases.
 *
 * The rules being pinned here are the ones a user can actually be wrong about:
 * a blank hiring date must contribute nothing, both endpoints are inclusive,
 * and the prior-years carry-in is what makes "total service days" a real length
 * of service rather than a within-year count.
 */

import { describe, expect, it } from "vitest";
import { serviceDaysFor } from "../serviceDays";
import { serviceSeries, MONTHS } from "../../engine/types";

/** A position stub carrying only what serviceSeries reads. */
function withService(hiringDate: string | null, year: number, active = true) {
  const service = serviceDaysFor(hiringDate, year);
  return {
    serviceDaysPerMonth: service.perMonth,
    serviceDaysOpening: service.opening,
    seasonality: new Array(MONTHS).fill(active ? 1 : 0),
  };
}

describe("serviceDaysFor", () => {
  it("returns all zeros when the hiring date was never filled in", () => {
    // The headline rule: a blank cell must not invent a liability.
    for (const blank of [null, undefined, "", "   ", "not a date"]) {
      const service = serviceDaysFor(blank, 2026);
      expect(service.opening).toBe(0);
      expect(service.perMonth).toEqual(new Array(MONTHS).fill(0));
    }
  });

  it("rejects an impossible date rather than rolling it into the next month", () => {
    // "2026-02-30" would silently become 2 March through Date's normalization.
    expect(serviceDaysFor("2026-02-30", 2026).perMonth).toEqual(new Array(MONTHS).fill(0));
    expect(serviceDaysFor("2026-13-01", 2026).perMonth).toEqual(new Array(MONTHS).fill(0));
  });

  it("counts whole calendar months for someone hired long ago", () => {
    const service = serviceDaysFor("2019-06-01", 2026);
    // Every month of the plan year is full — weekends and holidays included,
    // which is what separates service days from the CALENDAR bases.
    expect(service.perMonth).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    // Carry-in: 1 Jun 2019 → 31 Dec 2025 inclusive. 2020 and 2024 are leap.
    const expectedOpening =
      (Date.UTC(2026, 0, 1) - Date.UTC(2019, 5, 1)) / 86_400_000;
    expect(service.opening).toBe(expectedOpening);
    expect(service.opening).toBe(2406);
  });

  it("counts the hiring day itself, so a 1 January hire has a full January", () => {
    const service = serviceDaysFor("2026-01-01", 2026);
    expect(service.perMonth[0]).toBe(31);
    expect(service.opening).toBe(0);
  });

  it("gives a mid-year hire zeros before, a part month in, and full months after", () => {
    const service = serviceDaysFor("2026-03-15", 2026);
    // 15–31 March inclusive = 17 days.
    expect(service.perMonth).toEqual([0, 0, 17, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    expect(service.opening).toBe(0);
  });

  it("gives a future hire nothing at all in this plan year", () => {
    const service = serviceDaysFor("2027-04-01", 2026);
    expect(service.perMonth).toEqual(new Array(MONTHS).fill(0));
    expect(service.opening).toBe(0);
  });

  it("counts 29 February in a leap year", () => {
    expect(serviceDaysFor("2024-01-01", 2024).perMonth[1]).toBe(29);
    expect(serviceDaysFor("2026-01-01", 2026).perMonth[1]).toBe(28);
  });

  it("reads the date as a plain day, not a local-timezone instant", () => {
    // A hire on the 1st must never slide into the previous month because the
    // machine running the budget sits west of Greenwich.
    expect(serviceDaysFor("2026-03-01", 2026).perMonth[1]).toBe(0);
    expect(serviceDaysFor("2026-03-01", 2026).perMonth[2]).toBe(31);
    // A full ISO timestamp is accepted and truncated to its day.
    expect(serviceDaysFor("2026-03-15T23:30:00Z", 2026).perMonth[2]).toBe(17);
  });
});

describe("serviceSeries", () => {
  it("MONTH is the month's own days; TOTAL runs them up from the carry-in", () => {
    const position = withService("2026-03-15", 2026);
    expect(serviceSeries(position, "MONTH")).toEqual([
      0, 0, 17, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
    expect(serviceSeries(position, "TOTAL")).toEqual([
      0, 0, 17, 47, 78, 108, 139, 170, 200, 231, 261, 292,
    ]);
  });

  it("carries prior years into TOTAL from month one", () => {
    const position = withService("2019-06-01", 2026);
    const total = serviceSeries(position, "TOTAL");
    expect(total[0]).toBe(2406 + 31);
    expect(total[11]).toBe(2406 + 365);
  });

  it("resolves to zeros for a position with no hiring date", () => {
    const position = withService(null, 2026);
    expect(serviceSeries(position, "MONTH")).toEqual(new Array(MONTHS).fill(0));
    expect(serviceSeries(position, "TOTAL")).toEqual(new Array(MONTHS).fill(0));
  });

  it("books nothing for a month the position is not in the plan", () => {
    // Service is gated by seasonality, not scaled by it — an inactive month
    // accrues no days and shows no standing liability, but the days stay whole.
    const position = withService("2019-06-01", 2026);
    position.seasonality = [0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0];
    expect(serviceSeries(position, "MONTH")).toEqual([
      0, 0, 0, 0, 0, 30, 31, 31, 0, 0, 0, 0,
    ]);
    const total = serviceSeries(position, "TOTAL");
    expect(total.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(total[5]).toBe(2406 + 30);
    expect(total[7]).toBe(2406 + 30 + 31 + 31);
    expect(total.slice(8)).toEqual([0, 0, 0, 0]);
  });

  it("never emits a fractional day for a partially active month", () => {
    const position = withService("2019-06-01", 2026);
    position.seasonality = new Array(MONTHS).fill(0.5);
    for (const days of serviceSeries(position, "MONTH")) {
      expect(Number.isInteger(days)).toBe(true);
    }
  });
});
