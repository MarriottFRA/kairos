/**
 * Block preset application tests.
 *
 * The interesting part of a preset is not that it saves blocks â€” saveBlock is
 * covered elsewhere â€” but that a MULTI-step preset wires its later steps to the
 * ids of its earlier ones, and that applying the same preset twice produces two
 * independent graphs rather than a second copy pointing at the first. Both are
 * silent failures: the wrong wiring still compiles, still simulates, and just
 * prices the wrong thing.
 *
 * The Overtime preset is the one that exercises all of it â€” three blocks, two
 * COMBINE bases, one of each countExempt polarity.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { compile } from "../../../shared/engine/compile";
import { simulate } from "../../../shared/engine/simulate";
import { POSITIONS_STRUCTURE_TABLES_SQL } from "../../positions/schema";
import { resolveOuScope } from "../../positions/ouScope";
import { getComponentDefinitions } from "../../positions/structureRepo";
import { applyStructureColumns } from "../schema";
import { blockCostDefId } from "../../../shared/blocks/ipc";
import { ensureSystemDefs, listBlocks } from "../repo";
import { applyBlockPreset, uniqueBlockLabel } from "../presets";

type Db = InstanceType<typeof Database>;

const OU = resolveOuScope("OU12345");
const NOW = { now: "2026-01-01T00:00:00.000Z" };

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(db);
});

function blockByLabel(label: string) {
  const found = listBlocks(db, OU).find((block) => block.label === label);
  if (!found) throw new Error(`No block labelled "${label}"`);
  return found;
}

function defById(id: string) {
  const found = getComponentDefinitions(db, OU).find((def) => def.id === id);
  if (!found) throw new Error(`No definition ${id}`);
  return found;
}

describe("applyBlockPreset â€” pension", () => {
  it("creates one multiplier on basic salary with the seeded account", () => {
    const ids = applyBlockPreset(db, OU, "pension", NOW);

    expect(ids).toHaveLength(1);
    const pension = blockByLabel("Pension");
    expect(pension.blockType).toBe("MULTIPLIER");
    expect(pension.base).toEqual({ kind: "BASE_SALARY" });
    expect(pension.accountCode).toBe("A565003");
    expect(pension.accountLocked).toBe(true);
  });
});

describe("applyBlockPreset â€” overtime", () => {
  it("creates the three blocks in order", () => {
    const ids = applyBlockPreset(db, OU, "overtime", NOW);

    expect(ids).toHaveLength(3);
    const blocks = listBlocks(db, OU);
    expect(blocks.map((block) => block.label)).toEqual([
      "Overtime Hours",
      "Overtime Hourly Rate",
      "Overtime Cost",
    ]);
    expect(blocks.map((block) => block.id)).toEqual(ids);
  });

  it("wires the cost block to the REAL ids of the hours and rate blocks", () => {
    applyBlockPreset(db, OU, "overtime", NOW);

    const hours = blockByLabel("Overtime Hours");
    const rate = blockByLabel("Overtime Hourly Rate");
    const cost = blockByLabel("Overtime Cost");

    // The placeholders must be gone: a surviving "$otHours" would still parse
    // as a BLOCK ref and simply resolve to nothing at compile time.
    expect(cost.base).toEqual({
      kind: "COMBINE",
      op: "MUL",
      left: { kind: "BLOCK", blockId: hours.id },
      right: { kind: "BLOCK", blockId: rate.id },
    });

    // And the same thing once lowered onto the engine definition.
    const selector = defById(cost.costDefId).baseSelector;
    expect(selector).toEqual({
      kind: "COMBINE",
      op: "MUL",
      left: { kind: "COMPONENTS", componentIds: [blockCostDefId(hours.id)] },
      right: { kind: "COMPONENTS", componentIds: [blockCostDefId(rate.id)] },
    });
  });

  it("derives the rate from salary Ã· hours paid and exempts it from headcount", () => {
    applyBlockPreset(db, OU, "overtime", NOW);

    const rate = blockByLabel("Overtime Hourly Rate");
    expect(rate.base).toEqual({
      kind: "COMBINE",
      op: "DIV",
      left: { kind: "BASE_SALARY" },
      right: { kind: "STAT", stat: "HOURS_PAID" },
    });
    expect(rate.ratioNoHeadcount).toBe(true);
    expect(rate.useRowRate).toBe(true);
    expect(rate.accountCode).toBe("");
    expect(defById(rate.costDefId).countExempt).toBe(true);
  });

  it("keeps the cost line scaling with headcount", () => {
    applyBlockPreset(db, OU, "overtime", NOW);

    const cost = blockByLabel("Overtime Cost");
    expect(cost.ratioNoHeadcount).toBe(false);
    expect(cost.accountCode).toBe("A521001");
    // A row standing for three people works three lots of overtime, so unlike
    // the rate this line is NOT exempt from the count post-pass.
    expect(defById(cost.costDefId).countExempt).toBe(false);
  });

  it("leaves merit increase off the hours block", () => {
    applyBlockPreset(db, OU, "overtime", NOW);

    const hours = blockByLabel("Overtime Hours");
    expect(hours.blockType).toBe("CUSTOM_MONTHLY");
    expect(hours.accountCode).toBe("A988306");
    // Deliberate: the rate leg already carries merit through basic salary, so
    // uplifting the hours as well would compound the increase.
    expect(hours.increaseAware).toBe(false);
    expect(defById(hours.costDefId).increaseAware).toBe(false);
  });
});

describe("applyBlockPreset â€” applying twice", () => {
  it("suffixes the colliding labels", () => {
    applyBlockPreset(db, OU, "overtime", NOW);
    applyBlockPreset(db, OU, "overtime", NOW);

    const labels = listBlocks(db, OU).map((block) => block.label);
    expect(labels).toEqual([
      "Overtime Hours",
      "Overtime Hourly Rate",
      "Overtime Cost",
      "Overtime Hours 2",
      "Overtime Hourly Rate 2",
      "Overtime Cost 2",
    ]);
  });

  it("points the second graph at its own blocks, not the first set", () => {
    applyBlockPreset(db, OU, "overtime", NOW);
    applyBlockPreset(db, OU, "overtime", NOW);

    const cost2 = blockByLabel("Overtime Cost 2");
    const hours2 = blockByLabel("Overtime Hours 2");
    const rate2 = blockByLabel("Overtime Hourly Rate 2");

    expect(cost2.base).toEqual({
      kind: "COMBINE",
      op: "MUL",
      left: { kind: "BLOCK", blockId: hours2.id },
      right: { kind: "BLOCK", blockId: rate2.id },
    });
  });
});

describe("applyBlockPreset â€” failure", () => {
  it("rejects an unknown preset without writing anything", () => {
    expect(() => applyBlockPreset(db, OU, "not-a-preset", NOW)).toThrow(
      /Unknown preset/
    );
    expect(listBlocks(db, OU)).toHaveLength(0);
  });
});

/**
 * The Overtime preset is only worth shipping if the three blocks actually price
 * overtime, so the wiring is asserted against simulated money rather than
 * against stored JSON alone. One position, no seasonality, no merit: a clean
 * arithmetic target.
 */
describe("applyBlockPreset â€” overtime, simulated", () => {
  const MONTHLY_SALARY = 3000;
  const YEARLY_HOURS = 2000;
  const VACATION_DAYS = 20;
  const DAILY_HOURS = 8;
  // hoursPaid = worked + vacation hours, and the rate is annual salary over it.
  const HOURS_PAID = YEARLY_HOURS + VACATION_DAYS * DAILY_HOURS;
  const OT_HOURS_PER_MONTH = 10;
  const PREMIUM = 1.5;

  function simulateOvertime(
    headcount: number,
    merit: { pct: number; month: number } = { pct: 0, month: 13 }
  ) {
    const ids = applyBlockPreset(db, OU, "overtime", NOW);
    ensureSystemDefs(db, OU, NOW);
    const [hoursId, rateId, costId] = ids;

    const compiled = compile({
      scenario: {
        id: "scen-1" as never,
        ou: OU.ou,
        year: 2026,
        label: "Planning",
        updatedAt: NOW.now,
        deletedAt: null,
      },
      calendar: {
        year: 2026,
        realDays: new Float64Array(12).fill(21),
        flatDays: new Float64Array(12).fill(30),
        holidayDays: new Float64Array(12),
      },
      definitions: getComponentDefinitions(db, OU),
      ssSchemes: [],
      positions: [
        {
          id: "pos-1" as never,
          scenarioId: "scen-1" as never,
          departmentCode: "0410",
          jobTypeCode: "MGR",
          cluster: "Rooms",
          hotelClusterWeight: 1,
          payType: "SALARIED",
          headcount,
          fte: 1,
          seasonality: new Array(12).fill(1),
          monthlyBaseSalary: MONTHLY_SALARY,
          hourlyRate: 0,
          additionalMonthlyCosts: new Array(12).fill(0),
          meritIncreasePct: merit.pct,
          manualYearlyIncrease: 0,
          increaseMonth: merit.month,
          dailyContractHours: DAILY_HOURS,
          yearlyHoursWorked: YEARLY_HOURS,
          vacationDays: VACATION_DAYS,
          vacationMonthlyWeights: new Array(12).fill(1 / 12),
          accrualDaysPerMonth: 0,
          updatedAt: NOW.now,
          deletedAt: null,
        },
      ],
      componentValues: [
        {
          positionId: "pos-1" as never,
          componentDefId: blockCostDefId(hoursId) as never,
          monthlyValues: new Array(12).fill(OT_HOURS_PER_MONTH),
          updatedAt: NOW.now,
          deletedAt: null,
        },
        {
          positionId: "pos-1" as never,
          componentDefId: blockCostDefId(rateId) as never,
          rate: PREMIUM,
          updatedAt: NOW.now,
          deletedAt: null,
        },
        {
          positionId: "pos-1" as never,
          componentDefId: blockCostDefId(costId) as never,
          rate: 1,
          updatedAt: NOW.now,
          deletedAt: null,
        },
      ],
      buyouts: [],
    });
    if (!("plan" in compiled)) {
      throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
    }
    const result = simulate(compiled.plan);
    const line = (defId: string) =>
      result.positionLines("pos-1" as never).find((row) => row.component.id === defId);
    return {
      rate: line(blockCostDefId(rateId))!.months,
      cost: line(blockCostDefId(costId))!.months,
    };
  }

  it("prices overtime at premium Ã— salary Ã· hours paid Ã— hours", () => {
    const { rate, cost } = simulateOvertime(1);

    const expectedRate = (PREMIUM * (MONTHLY_SALARY * 12)) / HOURS_PAID;
    expect(rate[0]).toBeCloseTo(expectedRate, 6);
    expect(cost[0]).toBeCloseTo(expectedRate * OT_HOURS_PER_MONTH, 6);
  });

  it("keeps the rate per-person but scales the cost with headcount", () => {
    const one = simulateOvertime(1);
    db.exec("DELETE FROM block_configs; DELETE FROM cost_component_definitions");
    const three = simulateOvertime(3);

    // The ratio is the same figure however many people the row stands for...
    expect(three.rate[0]).toBeCloseTo(one.rate[0], 6);
    // ...while the money it drives is three times as much.
    expect(three.cost[0]).toBeCloseTo(one.cost[0] * 3, 6);
  });

  it("applies a merit increase ONCE, through the rate leg", () => {
    // This is the reason Overtime Hours ships with merit off. With it on, the
    // hours would be uplifted too and December would land at 1.1Â² â€” a 21%
    // rise nobody asked for, invisible in any total.
    const { cost } = simulateOvertime(1, { pct: 0.1, month: 7 });

    expect(cost[11] / cost[0]).toBeCloseTo(1.1, 6);
  });
});

describe("uniqueBlockLabel", () => {
  it("leaves a free label alone", () => {
    expect(uniqueBlockLabel(db, OU, "Pension")).toBe("Pension");
  });

  it("counts up past every taken suffix", () => {
    applyBlockPreset(db, OU, "pension", NOW);
    expect(uniqueBlockLabel(db, OU, "Pension")).toBe("Pension 2");
    applyBlockPreset(db, OU, "pension", NOW);
    expect(uniqueBlockLabel(db, OU, "Pension")).toBe("Pension 3");
  });

  it("matches case-insensitively", () => {
    applyBlockPreset(db, OU, "pension", NOW);
    expect(uniqueBlockLabel(db, OU, "pension")).toBe("pension 2");
  });
});
