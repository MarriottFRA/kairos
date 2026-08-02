/**
 * The bank-holiday premium's configuration layer: the calendar-head normalizer
 * and the definition it materializes for the engine.
 *
 * These two sit either side of every path into the feature (fresh calendar,
 * reseed, read-from-storage, sync pull), so a coercion that lets a bad value
 * through here surfaces later as a wrong number in Results with no obvious
 * cause. The engine-side arithmetic is pinned separately by the golden masters.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER,
  DEFAULT_BANK_HOLIDAY_STAFF_FRACTION,
  buildDefaultCalendar,
  normalizeBankHoliday,
} from "../../calendar";
import { buildBankHolidayDefinition } from "../engineInput";

const OU = "0410";

/** A calendar with the premium switched on and configured, ready to tweak. */
function configured(overrides: Record<string, unknown> = {}) {
  return {
    ...buildDefaultCalendar(OU, 2026),
    bankHolidayEnabled: true,
    bankHolidayAccount: "A5120",
    ...overrides,
  };
}

describe("normalizeBankHoliday", () => {
  it("starts a fresh calendar at the documented defaults", () => {
    const config = normalizeBankHoliday({});
    expect(config.bankHolidayEnabled).toBe(false);
    // 0.7 ≈ a 5-day rota in a 7-day operation. Pinned because it is a stated
    // piece of reasoning in the UI copy, not an arbitrary starting number.
    expect(config.bankHolidayStaffFraction).toBe(DEFAULT_BANK_HOLIDAY_STAFF_FRACTION);
    expect(config.bankHolidayStaffFraction).toBe(0.7);
    expect(config.bankHolidayPremiumMultiplier).toBe(DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER);
    expect(config.bankHolidayAppliesTo).toBe("HOURLY");
    expect(config.bankHolidayPaidWhenNotWorked).toBe(false);
    expect(config.bankHolidayCoverageByDepartment).toEqual({});
  });

  it("clamps the fraction, floors the multiplier and rejects an unknown applies-to", () => {
    const config = normalizeBankHoliday({
      bankHolidayStaffFraction: 1.4,
      bankHolidayPremiumMultiplier: -2,
      bankHolidayAppliesTo: "EVERYONE" as never,
    });
    expect(config.bankHolidayStaffFraction).toBe(1);
    expect(config.bankHolidayPremiumMultiplier).toBe(0);
    expect(config.bankHolidayAppliesTo).toBe("HOURLY");
  });

  it("clamps coverage overrides and drops entries that are not numbers", () => {
    const config = normalizeBankHoliday({
      bankHolidayCoverageByDepartment: {
        "1010": 1.5,
        "1310": -0.2,
        "1910": "n/a" as never,
        "  ": 0.5,
      },
    });
    expect(config.bankHolidayCoverageByDepartment).toEqual({ "1010": 1, "1310": 0 });
  });

  it("keeps an override that happens to equal the hotel-wide fraction", () => {
    // Pruning it would look tidy and be wrong: the value is a statement about
    // that department, and it would silently start tracking the hotel-wide
    // number the moment someone changed it.
    const config = normalizeBankHoliday({
      bankHolidayStaffFraction: 0.7,
      bankHolidayCoverageByDepartment: { "1010": 0.7 },
    });
    expect(config.bankHolidayCoverageByDepartment).toEqual({ "1010": 0.7 });
  });
});

describe("buildBankHolidayDefinition", () => {
  it("returns null when the feature is off or has no account", () => {
    expect(buildBankHolidayDefinition(OU, buildDefaultCalendar(OU, 2026))).toBeNull();
    expect(
      buildBankHolidayDefinition(OU, configured({ bankHolidayAccount: "  " }))
    ).toBeNull();
  });

  it("carries every knob through to the definition", () => {
    const def = buildBankHolidayDefinition(
      OU,
      configured({
        bankHolidayStaffFraction: 0.7,
        bankHolidayPremiumMultiplier: 1.5,
        bankHolidayAppliesTo: "ALL",
        bankHolidayPaidWhenNotWorked: true,
        bankHolidayCoverageByDepartment: { "1010": 0.95 },
      })
    );
    expect(def).not.toBeNull();
    expect(def?.kind).toBe("BANK_HOLIDAY");
    expect(def?.accountCode).toBe("A5120");
    expect(def?.bankHolidayStaffFraction).toBe(0.7);
    expect(def?.bankHolidayPremiumMultiplier).toBe(1.5);
    expect(def?.bankHolidayAppliesTo).toBe("ALL");
    expect(def?.bankHolidayPaidWhenNotWorked).toBe(true);
    expect(def?.bankHolidayCoverageByDepartment).toEqual({ "1010": 0.95 });
  });

  it("is inert when nobody works the holiday and it is not paid regardless", () => {
    expect(
      buildBankHolidayDefinition(
        OU,
        configured({ bankHolidayStaffFraction: 0, bankHolidayPremiumMultiplier: 2 })
      )
    ).toBeNull();
    expect(
      buildBankHolidayDefinition(
        OU,
        configured({ bankHolidayStaffFraction: 0.7, bankHolidayPremiumMultiplier: 0 })
      )
    ).toBeNull();
  });

  it("still books a line when only a department has coverage", () => {
    // The hotel-wide number is zero, but Rooms works the holiday — the old
    // "staffFraction <= 0 → no line" guard would have thrown this cost away.
    const def = buildBankHolidayDefinition(
      OU,
      configured({
        bankHolidayStaffFraction: 0,
        bankHolidayPremiumMultiplier: 2,
        bankHolidayCoverageByDepartment: { "1010": 0.8 },
      })
    );
    expect(def).not.toBeNull();
  });

  it("still books a line when the holiday is paid to staff who are off", () => {
    // Nobody works it, but everybody is paid for it: a real cost the app's
    // net-productive-days base pay leaves out entirely.
    const def = buildBankHolidayDefinition(
      OU,
      configured({
        bankHolidayStaffFraction: 0,
        bankHolidayPremiumMultiplier: 0,
        bankHolidayPaidWhenNotWorked: true,
      })
    );
    expect(def).not.toBeNull();
  });
});
