/**
 * Rules-driven multiplier rows — the pure row layer and the display path.
 *
 * Two invariants:
 *   1. While rules are on, the block exposes NO editable rate cell (and
 *      therefore no diff keys and no write-back patches) — the rules are the
 *      single source of truth.
 *   2. The read-only derived cell (ruleRatesForRows) must agree with what the
 *      loaders feed the engine (applyRateRules) — one evaluator, two callers,
 *      pinned here so the cell can never show a rate the engine didn't use.
 */

import { describe, expect, it } from "vitest";
import { BlockDto } from "../../blocks/ipc";
import { RateRulesConfig } from "../../blocks/rateRules";
import { Position, PositionId, ScenarioId } from "../../engine/types";
import { applyRateRules } from "../engineInput";
import { ruleRatesForRows } from "../derivedRowValues";
import { PositionRow } from "../rowModel";
import { serviceDaysFor } from "../serviceDays";
import {
  blockFieldKey,
  blockInputSlots,
  blockPatchesFromRow,
  blockRuleRateKey,
  changedBlockKeys,
} from "../blockRows";

const DEF = "b1:cost";
const YEAR = 2027;

const RULES: RateRulesConfig = {
  rules: [
    {
      when: [
        { source: { kind: "FIELD", fieldKey: "u_band", dataType: "TEXT" }, op: "EQ", value: "blue" },
      ],
      rate: 0.1,
    },
    {
      when: [{ source: { kind: "DAYS_IN_POSITION" }, op: "LTE", value: 100 }],
      rate: 21,
    },
  ],
  otherwise: 30,
};

function block(overrides: Partial<BlockDto> = {}): BlockDto {
  return {
    id: "b1",
    ou: "H001",
    blockType: "MULTIPLIER",
    label: "Tiered Indemnity",
    accountCode: "A519000",
    accountLocked: true,
    statsAccountCode: "",
    statsAccountLocked: true,
    base: { kind: "BASE_SALARY" },
    rateRules: RULES,
    spread: "ACTIVE_MONTHS",
    increaseAware: false,
    departmentMode: "POSITION",
    sortOrder: 0,
    updatedAt: "",
    costDefId: DEF,
    ...overrides,
  } as BlockDto;
}

function position(id: string, hiringDate: string | null, bagless = false): Position {
  const service = serviceDaysFor(hiringDate, YEAR);
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
    serviceDaysPerMonth: bagless ? undefined : service.perMonth,
    serviceDaysOpening: bagless ? undefined : service.opening,
    updatedAt: "",
    deletedAt: null,
  };
}

const row = (fields: Partial<PositionRow> = {}) =>
  ({ id: "p1", active: true, departmentCode: "0410", jobTypeCode: "Manager", payType: "SALARIED", ...fields }) as PositionRow;

describe("row model while rules are on", () => {
  it("exposes no editable rate slot", () => {
    expect(blockInputSlots(block())).toEqual([]);
    expect(blockInputSlots(block({ rateRules: undefined }))).toEqual(["rate"]);
  });

  it("emits no diff keys and no write-back patch while rules are on", () => {
    // Even a rate key that somehow changed on the row (stale grid state, a
    // paste) is not a diff — blockRowKeys is empty for a rules block.
    const oldRow = row();
    const newRow = row({
      [blockFieldKey(DEF, "rate")]: 0.42,
      [blockRuleRateKey(block())]: 0.42,
    } as never);
    const changed = changedBlockKeys(oldRow, newRow, [block()]);
    expect(changed).toEqual([]);
    // And the derived-cell key maps to no ComponentValue field either way.
    expect(
      blockPatchesFromRow(newRow, [blockRuleRateKey(block())], [block()])
    ).toEqual([]);
  });
});

describe("display agrees with the engine feed", () => {
  it("matches applyRateRules for constant, banded and month-varying rows", () => {
    const blocks = [block()];
    const specs = [{ costDefId: DEF, config: RULES }];

    // p1: band blue → 0.1 (field rule beats the tenure rule by order).
    // p2: hired mid-year → 21 until the 100-day mark, 30 after (monthly).
    // p3: long-serving, no band → constant 30.
    const rowsIn = [
      row({ id: "p1", u_band: "blue", hiringDate: "2019-06-01" } as never),
      row({ id: "p2", hiringDate: `${YEAR}-03-15` } as never),
      row({ id: "p3", hiringDate: "2019-06-01" } as never),
    ];
    const positions = [
      position("p1", "2019-06-01"),
      position("p2", `${YEAR}-03-15`),
      position("p3", "2019-06-01"),
    ];
    const bags = new Map<string, Record<string, unknown>>(
      rowsIn.map((r) => [String(r.id), r as Record<string, unknown>])
    );

    const engineValues = applyRateRules(specs, positions, bags, []);
    const displayed = ruleRatesForRows(rowsIn, blocks, YEAR);

    for (const id of ["p1", "p2", "p3"]) {
      const engine = engineValues.find((value) => value.positionId === (id as never))!;
      const cell = displayed.get(id)!.get(DEF)!;
      if ("rate" in cell) {
        expect(engine.rate, id).toBe(cell.rate);
        expect(engine.monthlyRates, id).toBeUndefined();
      } else if ("monthlyRates" in cell) {
        expect(engine.monthlyRates, id).toEqual(cell.monthlyRates);
      } else {
        throw new Error(`${id}: unexpected block-valued outcome in this fixture`);
      }
    }

    // And the shapes are the ones the comment above promises.
    expect(displayed.get("p1")!.get(DEF)).toEqual({ rate: 0.1 });
    expect(displayed.get("p3")!.get(DEF)).toEqual({ rate: 30 });
    const p2 = displayed.get("p2")!.get(DEF)!;
    if (!("monthlyRates" in p2)) throw new Error("expected a month-varying rate");
    const p2Rates = p2.monthlyRates;
    expect(p2Rates[0]).toBe(21);
    expect(p2Rates[11]).toBe(30);
  });

  it("skips inactive rows and returns empty with no plan year", () => {
    const rowsIn = [row({ id: "p1", active: false } as never)];
    expect(ruleRatesForRows(rowsIn, [block()], YEAR).size).toBe(0);
    expect(ruleRatesForRows([row()], [block()], null).size).toBe(0);
  });
});
