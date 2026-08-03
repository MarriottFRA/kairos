/**
 * Country preset catalogue checks.
 *
 * These presets are hand-entered statutory rates, so the cheap mistakes are the
 * likely ones: a rate typed as 15 instead of 0.15, bands out of order, a
 * bounded top band. Every one of those would be rejected by the repo the moment
 * a user pressed Save — after they had read and trusted the numbers on screen —
 * so the same validator runs over the whole catalogue here instead.
 */

import { describe, expect, it } from "vitest";
import { SS_MAX_BRACKETS } from "../../engine/types";
import { validateSsSchemeInput } from "../ipc";
import {
  DEFAULT_SOCIAL_SECURITY_ACCOUNT,
  SS_COUNTRY_PRESETS,
} from "../presets";

describe("SS_COUNTRY_PRESETS", () => {
  it("has unique ids", () => {
    const ids = SS_COUNTRY_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("passes the same validation the repo applies on save", () => {
    for (const preset of SS_COUNTRY_PRESETS) {
      const check = () =>
        validateSsSchemeInput({ ...preset.scheme, baseComponentIds: [] });
      expect(check, preset.id).not.toThrow();
    }
  });

  it("stores rates as fractions, not percents", () => {
    for (const preset of SS_COUNTRY_PRESETS) {
      for (const bracket of preset.scheme.brackets) {
        expect(bracket.rate, `${preset.id} rate`).toBeGreaterThanOrEqual(0);
        // 0.5 is far above any real employer rate; anything higher is a percent
        // that forgot to be divided.
        expect(bracket.rate, `${preset.id} rate`).toBeLessThan(0.5);
      }
    }
  });

  it("fits inside the engine's bracket budget", () => {
    for (const preset of SS_COUNTRY_PRESETS) {
      expect(preset.scheme.brackets.length, preset.id).toBeGreaterThan(0);
      expect(preset.scheme.brackets.length, preset.id).toBeLessThanOrEqual(
        SS_MAX_BRACKETS
      );
    }
  });

  it("is per-period throughout, so every threshold is a monthly figure", () => {
    for (const preset of SS_COUNTRY_PRESETS) {
      expect(preset.scheme.accumulationMode, preset.id).toBe("PER_PERIOD");
      // A yearly cap is meaningless without accumulation, so it must stay null.
      expect(preset.scheme.yearlyCap, preset.id).toBeNull();
    }
  });

  it("seeds the statutory account and carries display copy", () => {
    for (const preset of SS_COUNTRY_PRESETS) {
      expect(preset.defaultAccountCode).toBe(DEFAULT_SOCIAL_SECURITY_ACCOUNT);
      expect(preset.title.trim(), preset.id).not.toBe("");
      expect(preset.blurb.trim(), preset.id).not.toBe("");
      expect(preset.scheme.label.trim(), preset.id).not.toBe("");
      expect(preset.flag.trim(), preset.id).not.toBe("");
    }
  });

  it("prices UK employer NI at 15% above the monthly secondary threshold", () => {
    const uk = SS_COUNTRY_PRESETS.find((preset) => preset.id === "uk-employer-ni");
    expect(uk?.scheme.brackets).toEqual([
      { upTo: 417, rate: 0 },
      { upTo: null, rate: 0.15 },
    ]);
    expect(uk?.scheme.monthlyCap).toBeNull();
  });
});
