/**
 * The cluster-position sync contract — the partition every sibling write reads.
 *
 * These are the rules the main-process sync and the grid both depend on, so
 * they are pinned here rather than only being implied by the behaviour tests in
 * main/positions/__tests__/clusterSync.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  CLUSTER_LINK_ROW_KEY,
  EMPTY_CLUSTER_SYNC,
  NEVER_SYNCED_KEYS,
  mergeClusterSync,
  normalizeLabel,
  syncsByKey,
} from "../clusterSync";
import { SYSTEM_FIELD_SEED } from "../fieldSeed";
import { FieldDef, HOTEL_CLUSTER_MULT_KEY } from "../fields";
import { resolvePlanningScenario } from "../scenarioResolve";
import { PositionRecord, ScenarioDto } from "../ipc";
import { toRow } from "../rowModel";

const seeded = (key: string): FieldDef =>
  SYSTEM_FIELD_SEED.find((field) => field.key === key) as FieldDef;

describe("what travels between sibling rows", () => {
  it("syncs the shared contractual fields", () => {
    for (const key of [
      "monthlyBaseSalary",
      "departmentCode",
      "jobTypeCode",
      "payType",
      "headcount",
      "vacationDays",
      "cluster",
      "title",
      "annualBaseSalary",
      // Input Basis: it reinterprets every yearly number on the row, so a
      // sibling that received the figures without it would budget a different
      // amount from the same contract.
      "annualDivisorBasis",
    ]) {
      expect(syncsByKey(seeded(key)), key).toBe(true);
    }
  });

  it("never syncs FTE or the multiplier override — both are per-hotel by design", () => {
    expect(NEVER_SYNCED_KEYS.has("fte")).toBe(true);
    expect(NEVER_SYNCED_KEYS.has(HOTEL_CLUSTER_MULT_KEY)).toBe(true);
    expect(syncsByKey(seeded(HOTEL_CLUSTER_MULT_KEY))).toBe(false);
  });

  it("never syncs a COMPUTED field — nothing stores it on either side", () => {
    const computed = SYSTEM_FIELD_SEED.find(
      (field) => field.storage === "COMPUTED"
    ) as FieldDef;
    expect(syncsByKey(computed)).toBe(false);
  });

  it("never syncs a USER field by key — those are matched by label per hotel", () => {
    expect(
      syncsByKey({ ...seeded("monthlyBaseSalary"), origin: "USER" })
    ).toBe(false);
  });
});

describe("label matching", () => {
  it("ignores case and internal whitespace, so two typists agree", () => {
    expect(normalizeLabel("  Pension   5%  ")).toBe(normalizeLabel("pension 5%"));
  });

  it("keeps genuinely different labels apart", () => {
    expect(normalizeLabel("Pension 5%")).not.toBe(normalizeLabel("Pension 6%"));
  });
});

describe("merging results across a batch", () => {
  it("sums the counts and reports each distinct skip once", () => {
    const skip = {
      targetOu: "OU22222",
      label: "Pension 5%",
      kind: "BLOCK" as const,
      reason: "NO_MATCH" as const,
    };
    const merged = mergeClusterSync([
      { created: [{ ou: "OU22222", positionId: "p1" }], unlinked: 0, propagated: 1, skips: [skip] },
      { created: [], unlinked: 2, propagated: 3, skips: [skip, { ...skip, label: "Meal" }] },
    ]);

    expect(merged.created).toHaveLength(1);
    expect(merged.unlinked).toBe(2);
    expect(merged.propagated).toBe(4);
    expect(merged.skips).toHaveLength(2);
  });

  it("merges nothing into nothing", () => {
    expect(mergeClusterSync([])).toEqual(EMPTY_CLUSTER_SYNC);
  });
});

describe("planning-scenario resolution", () => {
  const scenario = (id: string, year: number, label: string): ScenarioDto => ({
    id,
    ou: "OU11111",
    year,
    label,
    updatedAt: "",
  });

  it("prefers the caller's pick, then Planning, then anything that year", () => {
    const list = [
      scenario("a", 2026, "Aggressive"),
      scenario("p", 2026, "Planning"),
      scenario("old", 2025, "Planning"),
    ];
    expect(resolvePlanningScenario(list, 2026, "a")?.id).toBe("a");
    expect(resolvePlanningScenario(list, 2026)?.id).toBe("p");
    expect(
      resolvePlanningScenario([scenario("only", 2026, "Draft")], 2026)?.id
    ).toBe("only");
  });

  it("ignores a preferred id belonging to another year", () => {
    const list = [scenario("old", 2025, "Planning"), scenario("p", 2026, "Planning")];
    expect(resolvePlanningScenario(list, 2026, "old")?.id).toBe("p");
  });

  it("returns null when the year has nothing", () => {
    expect(resolvePlanningScenario([], 2026)).toBeNull();
  });
});

describe("the grid's row marker", () => {
  it("carries the group id onto the row so a linked position is visible", () => {
    const record = {
      id: "p1",
      scenarioId: "s1",
      lineageId: "p1",
      active: true,
      departmentCode: "0410",
      jobTypeCode: "Associate",
      cluster: "cluster-1",
      clusterMultiplierOverride: null,
      clusterLinkId: "group-1",
      payType: "SALARIED",
      headcount: 1,
      fte: 1,
      seasonality: new Array(12).fill(1),
      monthlyBaseSalary: 3000,
      hourlyRate: 0,
      additionalMonthlyCosts: new Array(12).fill(0),
      meritIncreasePct: 0,
      manualYearlyIncrease: 0,
      increaseMonth: 13,
      dailyContractHours: 8,
      yearlyHoursWorked: 0,
      vacationDays: 0,
      vacationMonthlyWeights: new Array(12).fill(0),
      accrualDaysPerMonth: 0,
      extraValues: {},
      updatedAt: "",
    } as PositionRecord;

    expect(toRow(record)[CLUSTER_LINK_ROW_KEY]).toBe("group-1");
    // A standalone row reads as empty rather than undefined, so the grid's
    // truthiness check is the same shape either way.
    expect(toRow({ ...record, clusterLinkId: "" })[CLUSTER_LINK_ROW_KEY]).toBe("");
  });
});
