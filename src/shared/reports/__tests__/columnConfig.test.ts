/**
 * The column configuration produces specs the engine accepts, reads the BST
 * by default, names the pulled sets by position, and survives a stored
 * configuration that has gone stale.
 */

import { describe, expect, it } from "vitest";
import { isSeriesColumn, normalizeColumns } from "../columns";
import {
  ColumnConfig,
  DEFAULT_COLUMN_CONFIG,
  buildConfigColumns,
  describeColumnConfig,
  normalizeColumnConfig,
} from "../columnConfig";

const scenario = { id: "s1", label: "Planning", year: 2027 };
const compare = { id: "s0-ab", label: "Last year", year: 2026 };
const scenarios = [scenario, compare];
const buckets = [
  { index: 1, type: "BUDGET", year: 2027 },
  { index: 2, type: "ACT/FCST", year: 2026 },
  { index: 3, type: "ACTUAL", year: 2025 },
];

describe("buildConfigColumns", () => {
  it("the default and a full configuration validate, in both modes", () => {
    const full = {
      compares: [
        { kind: "bst" as const, offset: 1 as const },
        { kind: "bst" as const, offset: 2 as const },
        { kind: "scenario" as const, scenarioId: compare.id },
      ],
      showAbs: true,
      showPct: true,
    };
    for (const config of [DEFAULT_COLUMN_CONFIG, full]) {
      for (const mode of ["bst", "plan"] as const) {
        const columns = buildConfigColumns(config, { scenario, mode, scenarios, buckets });
        expect(normalizeColumns(columns), mode).toEqual(columns);
      }
    }
  });

  it("reads the BST budget bucket by default and the overlay only in plan mode", () => {
    const bst = buildConfigColumns(DEFAULT_COLUMN_CONFIG, { scenario, mode: "bst", scenarios, buckets });
    expect(bst[0]).toEqual({
      id: "budget",
      label: "Budget 2027",
      series: { kind: "bst", relativeTo: "s1", bucket: { type: "BUDGET" } },
    });
    const plan = buildConfigColumns(DEFAULT_COLUMN_CONFIG, { scenario, mode: "plan", scenarios, buckets });
    expect(plan[0].label).toBe("Plan 2027 (unpushed)");
    expect(isSeriesColumn(plan[0]) && plan[0].series.kind).toBe("plan");
    // The offset is always the pulled set, whatever the mode.
    expect(plan[1]).toEqual({
      id: "bst2",
      label: "ACT/FCST 2026",
      series: { kind: "bst", relativeTo: "s1", bucket: { index: 2 } },
    });
  });

  it("offset 1 is bucket 2 and offset 2 is bucket 3, labelled from the pull, with abs and pct variances", () => {
    const columns = buildConfigColumns(
      { compares: [{ kind: "bst", offset: 1 }, { kind: "bst", offset: 2 }], showAbs: true, showPct: true },
      { scenario, mode: "bst", scenarios, buckets }
    );
    expect(columns.map((c) => c.id)).toEqual(["budget", "bst2", "bst2_v", "bst2_v_pct", "bst3", "bst3_v", "bst3_v_pct"]);
    expect(columns[4]).toEqual({
      id: "bst3",
      label: "ACTUAL 2025",
      series: { kind: "bst", relativeTo: "s1", bucket: { index: 3 } },
    });
    expect(columns[5]).toEqual({ id: "bst3_v", label: "vs ACTUAL 2025", variance: { a: "budget", b: "bst3", mode: "abs" } });
    expect(columns[6]).toEqual({
      id: "bst3_v_pct",
      label: "vs ACTUAL 2025 %",
      variance: { a: "budget", b: "bst3", mode: "pct" },
    });
  });

  it("names a set by position when nothing is pulled", () => {
    const columns = buildConfigColumns(DEFAULT_COLUMN_CONFIG, { scenario, mode: "bst", scenarios });
    expect(columns[1].label).toBe("BST set 2");
  });

  it("compares another scenario as its own plan, and skips one that no longer exists", () => {
    const config = {
      compares: [
        { kind: "scenario" as const, scenarioId: compare.id },
        { kind: "scenario" as const, scenarioId: "gone" },
      ],
      showAbs: false,
      showPct: true,
    };
    const columns = buildConfigColumns(config, { scenario, mode: "bst", scenarios, buckets });
    expect(columns.map((c) => c.id)).toEqual(["budget", "s_s0_ab", "s_s0_ab_v_pct"]);
    expect(columns[1]).toEqual({
      id: "s_s0_ab",
      label: "Last year 2026 (plan)",
      series: { kind: "plan", scenarioId: "s0-ab" },
    });
    expect(columns[2].label).toBe("vs Last year 2026 %");
    expect(describeColumnConfig(config, scenarios, buckets)).toBe("vs Last year 2026");
  });

  it("no comparisons is the budget alone", () => {
    const config: ColumnConfig = { compares: [], showAbs: true, showPct: true };
    expect(buildConfigColumns(config, { scenario, mode: "bst", scenarios, buckets })).toHaveLength(1);
    expect(describeColumnConfig(config, scenarios, buckets)).toBe("Budget only");
  });
});

describe("normalizeColumnConfig", () => {
  it("falls back to the default for anything unusable", () => {
    expect(normalizeColumnConfig(null)).toBe(DEFAULT_COLUMN_CONFIG);
    expect(normalizeColumnConfig("x")).toBe(DEFAULT_COLUMN_CONFIG);
    expect(normalizeColumnConfig({ compares: "no" })).toBe(DEFAULT_COLUMN_CONFIG);
  });

  it("keeps valid entries, drops the rest, and de-duplicates", () => {
    expect(
      normalizeColumnConfig({
        compares: [
          { kind: "bst", offset: 2 },
          { kind: "bst", offset: 3 },
          { kind: "scenario", scenarioId: " s0 " },
          { kind: "bst", offset: 2 },
          { kind: "scenario", scenarioId: "" },
          "junk",
        ],
        showAbs: false,
        showPct: "yes",
      })
    ).toEqual({
      compares: [
        { kind: "bst", offset: 2 },
        { kind: "scenario", scenarioId: "s0" },
      ],
      showAbs: false,
      showPct: true,
    });
  });
});
