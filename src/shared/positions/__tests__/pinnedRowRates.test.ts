/**
 * applyPinnedRowRates — the loader-side rate pin for a MULTIPLIER whose per-row
 * multiplier column is switched off on a simple base (a movement block that IS
 * its balance). An absent value reads as rate 0 in the engine, so the pin is
 * what keeps such a block from silently computing zero — in BOTH loaders
 * (liveSimParity pins the two; this suite pins the helper's own contract).
 */

import { describe, expect, it } from "vitest";
import { BlockDto } from "../../blocks/ipc";
import {
  ComponentDefId,
  ComponentValue,
  Position,
  PositionId,
  ScenarioId,
} from "../../engine/types";
import { applyPinnedRowRates } from "../engineInput";

const DEF = "b1:cost";

function block(overrides: Partial<BlockDto> = {}): BlockDto {
  return {
    id: "b1",
    ou: "H001",
    blockType: "MULTIPLIER",
    label: "Indemnity Charge",
    accountCode: "628990",
    accountLocked: true,
    statsAccountCode: "",
    statsAccountLocked: true,
    base: { kind: "BLOCK", blockId: "b0" },
    movement: true,
    useRowRate: false,
    spread: "ACTIVE_MONTHS",
    increaseAware: false,
    departmentMode: "POSITION",
    sortOrder: 0,
    updatedAt: "",
    costDefId: DEF,
    ...overrides,
  } as BlockDto;
}

function position(id: string): Position {
  return {
    id: id as PositionId,
    scenarioId: "scen" as ScenarioId,
    departmentCode: "0410",
    jobTypeCode: "Manager",
    cluster: "",
    hotelClusterWeight: 1,
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
    yearlyHoursWorked: 2000,
    vacationDays: 20,
    vacationMonthlyWeights: new Array(12).fill(1 / 12),
    accrualDaysPerMonth: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function value(
  positionId: string,
  componentDefId: string,
  fields: Partial<ComponentValue> = {}
): ComponentValue {
  return {
    positionId: positionId as PositionId,
    componentDefId: componentDefId as ComponentDefId,
    updatedAt: "",
    deletedAt: null,
    ...fields,
  };
}

describe("applyPinnedRowRates", () => {
  it("synthesizes rate 1 for a position with no stored row", () => {
    const out = applyPinnedRowRates([block()], [position("p1")], []);
    expect(out).toEqual([
      {
        positionId: "p1",
        componentDefId: DEF,
        rate: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    ]);
  });

  it("patches a stored row to rate 1, keeping its opening balance and overrides", () => {
    const stored = value("p1", DEF, {
      rate: 0.25,
      ssOpeningBase: 900,
      accountCode: "628991",
      departmentCode: "1910",
    });
    const out = applyPinnedRowRates([block()], [position("p1")], [stored]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      positionId: "p1",
      componentDefId: DEF,
      rate: 1,
      ssOpeningBase: 900,
      accountCode: "628991",
      departmentCode: "1910",
    });
    // Shallow-cloned, never mutated: the caller's row still says 0.25.
    expect(stored.rate).toBe(0.25);
  });

  it("leaves a compound base alone — its selector carries the pin", () => {
    const compound = block({
      base: {
        kind: "COMBINE",
        op: "MUL",
        left: { kind: "BASE_SALARY" },
        right: { kind: "SERVICE", mode: "TOTAL" },
      },
    });
    const input: ComponentValue[] = [];
    expect(applyPinnedRowRates([compound], [position("p1")], input)).toBe(input);
  });

  it("leaves rules blocks, per-row-multiplier blocks and other types alone", () => {
    const input = [value("p1", DEF, { rate: 0.25 })];
    const untouched = [
      block({ rateRules: { rules: [], otherwise: 2 } }),
      block({ useRowRate: true }),
      block({ useRowRate: undefined }),
      block({ blockType: "FLAT_MONTHLY", useRowRate: false }),
    ];
    for (const candidate of untouched) {
      expect(applyPinnedRowRates([candidate], [position("p1")], input)).toBe(input);
    }
    expect(input[0].rate).toBe(0.25);
  });

  it("pins every position of every qualifying block, once each", () => {
    const other = block({ id: "b2", costDefId: "b2:cost" });
    const out = applyPinnedRowRates(
      [block(), other],
      [position("p1"), position("p2")],
      [value("p2", DEF, { rate: 3 })]
    );
    expect(out).toHaveLength(4);
    const rateOf = (positionId: string, defId: string) =>
      out.find((v) => v.positionId === positionId && v.componentDefId === defId)?.rate;
    expect(rateOf("p1", DEF)).toBe(1);
    expect(rateOf("p2", DEF)).toBe(1);
    expect(rateOf("p1", "b2:cost")).toBe(1);
    expect(rateOf("p2", "b2:cost")).toBe(1);
  });
});
