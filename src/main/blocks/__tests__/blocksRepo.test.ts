/**
 * Blocks repository tests — block CRUD + block→definition compilation against
 * in-memory SQLite. Covers: each block type's definition projection, base
 * compilation (salary / block / KPI / stat / calendar), update semantics,
 * the delete guard while referenced as a base, restore, reorder mirroring,
 * OU isolation, and a compile() smoke round-trip.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { compile } from "../../../shared/engine/compile";
import { simulate } from "../../../shared/engine/simulate";
import { POSITIONS_STRUCTURE_TABLES_SQL } from "../../positions/schema";
import { resolveOuScope } from "../../positions/ouScope";
import { getComponentDefinitions } from "../../positions/structureRepo";
import { applyBlocksStructureV12 } from "../schema";
import {
  blockCostDefId,
  blockStatDefId,
  BlockInput,
} from "../../../shared/blocks/ipc";
import {
  deleteBlock,
  ensureBaseSalaryDef,
  ensurePositionCountDef,
  listBlocks,
  POSITION_COUNT_ACCOUNT,
  positionCountDefId,
  reorderBlocks,
  restoreBlock,
  saveBlock,
  systemStatDefId,
} from "../repo";

type Db = InstanceType<typeof Database>;

const OU_A = resolveOuScope("OU12345");
const OU_B = resolveOuScope("OU99999");
const NOW = { now: "2026-01-01T00:00:00.000Z" };

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyBlocksStructureV12(db);
});

function flatMonthly(overrides: Partial<BlockInput> = {}): BlockInput {
  return {
    blockType: "FLAT_MONTHLY",
    label: "Uniform Allowance",
    accountCode: "511000",
    accountLocked: true,
    increaseAware: false,
    ...overrides,
  };
}

describe("saveBlock — definition projection", () => {
  it("FLAT_MONTHLY compiles to one SPREAD def with the FLAT_MONTHLY method", () => {
    const id = saveBlock(db, OU_A, flatMonthly(), NOW);

    const blocks = listBlocks(db, OU_A);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].label).toBe("Uniform Allowance");
    expect(blocks[0].costDefId).toBe(blockCostDefId(id));
    expect(blocks[0].statDefId).toBeUndefined();

    const defs = getComponentDefinitions(db, OU_A);
    expect(defs).toHaveLength(1);
    expect(defs[0].id).toBe(blockCostDefId(id));
    expect(defs[0].kind).toBe("SPREAD");
    expect(defs[0].spreadMethod).toBe("FLAT_MONTHLY");
    expect(defs[0].accountCode).toBe("511000");
    expect(defs[0].increaseAware).toBe(false);
  });

  it("COUNT_RATE compiles to a cost def and a stat def sharing the spread", () => {
    const id = saveBlock(
      db,
      OU_A,
      {
        blockType: "COUNT_RATE",
        label: "Meals",
        accountCode: "512000",
        accountLocked: true,
        statsAccountCode: "988200",
        spread: "DAYS",
      },
      NOW
    );

    const blocks = listBlocks(db, OU_A);
    expect(blocks[0].statDefId).toBe(blockStatDefId(id));

    const defs = getComponentDefinitions(db, OU_A);
    expect(defs).toHaveLength(2);
    const cost = defs.find((def) => def.id === blockCostDefId(id))!;
    const stat = defs.find((def) => def.id === blockStatDefId(id))!;
    expect(cost.spreadMethod).toBe("FLAT_PER_DAY");
    expect(cost.accountCode).toBe("512000");
    expect(stat.spreadMethod).toBe("FLAT_PER_DAY");
    expect(stat.accountCode).toBe("988200");
    expect(stat.label).toBe("Meals (count)");
    expect(stat.increaseAware).toBe(false);
  });

  it("MULTIPLIER of base salary compiles to PERCENT_OF over BASE_SALARY", () => {
    const id = saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Pension",
        accountCode: "513000",
        accountLocked: true,
        base: { kind: "BASE_SALARY" },
      },
      NOW
    );

    const [def] = getComponentDefinitions(db, OU_A);
    expect(def.id).toBe(blockCostDefId(id));
    expect(def.spreadMethod).toBe("PERCENT_OF");
    expect(def.baseSelector).toEqual({ kind: "BASE_SALARY" });
    // % blocks inherit any merit increase through their base series.
    expect(def.increaseAware).toBe(false);
  });

  it("MULTIPLIER of another block references that block's cost def", () => {
    const baseId = saveBlock(db, OU_A, flatMonthly(), NOW);
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Levy on Uniforms",
        accountCode: "514000",
        accountLocked: true,
        base: { kind: "BLOCK", blockId: baseId },
      },
      NOW
    );

    const defs = getComponentDefinitions(db, OU_A);
    const levy = defs.find((def) => def.label === "Levy on Uniforms")!;
    expect(levy.baseSelector).toEqual({
      kind: "COMPONENTS",
      componentIds: [blockCostDefId(baseId)],
    });
  });

  it("MULTIPLIER of a KPI compiles to the kpi_driver_id / DIRECT_ABS path", () => {
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Per Occupied Room",
        accountCode: "515000",
        accountLocked: true,
        base: { kind: "KPI", kpiDriverId: "kpi-123" },
      },
      NOW
    );

    const [def] = getComponentDefinitions(db, OU_A);
    expect(def.spreadMethod).toBe("DIRECT_ABS");
    expect(def.kpiDriverId).toBe("kpi-123");
    expect(def.baseSelector).toBeUndefined();
  });

  it("MULTIPLIER of a stat seeds the system stat def and references it", () => {
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Levy per Hour",
        accountCode: "516000",
        accountLocked: true,
        base: { kind: "STAT", stat: "HOURS" },
      },
      NOW
    );

    const defs = getComponentDefinitions(db, OU_A);
    const sysStat = defs.find((def) => def.id === systemStatDefId(OU_A.ou, "HOURS"))!;
    expect(sysStat.kind).toBe("STAT");
    expect(sysStat.statKind).toBe("HOURS");
    expect(sysStat.accountCode).toBe(""); // compute-only, never output

    const levy = defs.find((def) => def.label === "Levy per Hour")!;
    expect(levy.baseSelector).toEqual({
      kind: "COMPONENTS",
      componentIds: [systemStatDefId(OU_A.ou, "HOURS")],
    });
  });

  it("MULTIPLIER of a calendar series rides base_ref JSON", () => {
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Per Day Levy",
        accountCode: "517000",
        accountLocked: true,
        base: { kind: "CALENDAR", series: "PAY_DAYS" },
      },
      NOW
    );

    const [def] = getComponentDefinitions(db, OU_A);
    expect(def.baseSelector).toEqual({ kind: "CALENDAR", series: "PAY_DAYS" });
  });

  it("CUSTOM_MONTHLY compiles to DIRECT_MONTHLY", () => {
    saveBlock(
      db,
      OU_A,
      {
        blockType: "CUSTOM_MONTHLY",
        label: "Seasonal Bonus",
        accountCode: "518000",
        accountLocked: true,
        increaseAware: true,
      },
      NOW
    );
    const [def] = getComponentDefinitions(db, OU_A);
    expect(def.spreadMethod).toBe("DIRECT_MONTHLY");
    expect(def.increaseAware).toBe(true);
  });
});

describe("saveBlock — update semantics", () => {
  it("recompiles the projection on edit and preserves sort order", () => {
    const id = saveBlock(db, OU_A, flatMonthly(), NOW);
    const before = listBlocks(db, OU_A)[0];

    saveBlock(
      db,
      OU_A,
      flatMonthly({ id, label: "Uniforms & Shoes", accountCode: "519999" }),
      { now: "2026-02-01T00:00:00.000Z" }
    );

    const after = listBlocks(db, OU_A)[0];
    expect(after.label).toBe("Uniforms & Shoes");
    expect(after.sortOrder).toBe(before.sortOrder);

    const [def] = getComponentDefinitions(db, OU_A);
    expect(def.label).toBe("Uniforms & Shoes");
    expect(def.accountCode).toBe("519999");
  });

  it("rejects a block-type change and unknown update targets", () => {
    const id = saveBlock(db, OU_A, flatMonthly(), NOW);
    expect(() =>
      saveBlock(
        db,
        OU_A,
        { blockType: "CUSTOM_MONTHLY", id, label: "X", accountCode: "", accountLocked: true },
        NOW
      )
    ).toThrow(/type cannot change/);
    expect(() => saveBlock(db, OU_A, flatMonthly({ id: "missing" }), NOW)).toThrow(
      /no longer exists/
    );
  });

  it("validates multiplier bases", () => {
    expect(() =>
      saveBlock(
        db,
        OU_A,
        {
          blockType: "MULTIPLIER",
          label: "No base",
          accountCode: "",
          accountLocked: true,
        },
        NOW
      )
    ).toThrow(/needs a base/);

    expect(() =>
      saveBlock(
        db,
        OU_A,
        {
          blockType: "MULTIPLIER",
          label: "Ghost base",
          accountCode: "",
          accountLocked: true,
          base: { kind: "BLOCK", blockId: "missing" },
        },
        NOW
      )
    ).toThrow(/base block no longer exists/);
  });
});

describe("deleteBlock / restoreBlock", () => {
  it("refuses deletion while another block uses it as a base", () => {
    const baseId = saveBlock(db, OU_A, flatMonthly(), NOW);
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Levy",
        accountCode: "",
        accountLocked: true,
        base: { kind: "BLOCK", blockId: baseId },
      },
      NOW
    );

    expect(() => deleteBlock(db, OU_A, baseId, NOW)).toThrow(/used as a base by: Levy/);

    // Delete the referencing block first, then the base deletes cleanly.
    const levyId = listBlocks(db, OU_A).find((block) => block.label === "Levy")!.id;
    deleteBlock(db, OU_A, levyId, NOW);
    deleteBlock(db, OU_A, baseId, NOW);
    expect(listBlocks(db, OU_A)).toHaveLength(0);
    expect(getComponentDefinitions(db, OU_A)).toHaveLength(0);
  });

  it("restore brings back the config and its defs", () => {
    const id = saveBlock(db, OU_A, flatMonthly(), NOW);
    deleteBlock(db, OU_A, id, NOW);
    expect(listBlocks(db, OU_A)).toHaveLength(0);

    restoreBlock(db, OU_A, id, NOW);
    expect(listBlocks(db, OU_A)).toHaveLength(1);
    expect(getComponentDefinitions(db, OU_A)).toHaveLength(1);
  });
});

describe("reorderBlocks", () => {
  it("mirrors the new order onto the compiled defs", () => {
    const first = saveBlock(db, OU_A, flatMonthly({ label: "A" }), NOW);
    const second = saveBlock(db, OU_A, flatMonthly({ label: "B" }), NOW);

    reorderBlocks(db, OU_A, [second, first], NOW);

    const blocks = listBlocks(db, OU_A);
    expect(blocks.map((block) => block.label)).toEqual(["B", "A"]);

    const defs = getComponentDefinitions(db, OU_A);
    expect(defs.map((def) => def.label)).toEqual(["B", "A"]);
  });
});

describe("scoping + engine round trip", () => {
  it("blocks are OU-isolated", () => {
    saveBlock(db, OU_A, flatMonthly(), NOW);
    expect(listBlocks(db, OU_B)).toHaveLength(0);
    expect(getComponentDefinitions(db, OU_B)).toHaveLength(0);
  });

  it("ensureBaseSalaryDef is idempotent and completes a compilable graph", () => {
    ensureBaseSalaryDef(db, OU_A, NOW);
    ensureBaseSalaryDef(db, OU_A, NOW);
    const baseId = saveBlock(db, OU_A, flatMonthly(), NOW);
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Levy",
        accountCode: "520000",
        accountLocked: true,
        base: { kind: "BLOCK", blockId: baseId },
      },
      NOW
    );

    const defs = getComponentDefinitions(db, OU_A);
    expect(defs.filter((def) => def.kind === "BASE_SALARY")).toHaveLength(1);

    const result = compile({
      scenario: {
        id: "scen-1" as never,
        ou: OU_A.ou,
        year: 2026,
        label: "Planning",
        updatedAt: NOW.now,
        deletedAt: null,
      },
      calendar: {
        realDays: new Float64Array(12).fill(21),
        flatDays: new Float64Array(12).fill(30),
        holidayDays: new Float64Array(12),
      },
      definitions: defs,
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
          updatedAt: NOW.now,
          deletedAt: null,
        },
      ],
      componentValues: [],
      buyouts: [],
    });

    expect("errors" in result).toBe(false);
  });

  it("ensurePositionCountDef is idempotent and pins a HEADCOUNT head to A972540", () => {
    ensurePositionCountDef(db, OU_A, NOW);
    ensurePositionCountDef(db, OU_A, NOW);

    const heads = getComponentDefinitions(db, OU_A).filter(
      (def) => def.id === positionCountDefId(OU_A.ou)
    );
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      kind: "STAT",
      statKind: "HEADCOUNT",
      accountCode: POSITION_COUNT_ACCOUNT,
    });
  });

  it("the position-count head always books Count to A972540 (unflexed, seasonality-gated)", () => {
    ensureBaseSalaryDef(db, OU_A, NOW);
    ensurePositionCountDef(db, OU_A, NOW);
    const defs = getComponentDefinitions(db, OU_A);

    // Count 3, half-owned by a shared cluster (weight 0.5 → heads must NOT flex),
    // and idle in January (seasonality[0] = 0 → that month's head is 0).
    const seasonality = new Array(12).fill(1);
    seasonality[0] = 0;
    const compiled = compile({
      scenario: {
        id: "scen-1" as never,
        ou: OU_A.ou,
        year: 2026,
        label: "Planning",
        updatedAt: NOW.now,
        deletedAt: null,
      },
      calendar: {
        realDays: new Float64Array(12).fill(21),
        flatDays: new Float64Array(12).fill(30),
        holidayDays: new Float64Array(12),
      },
      definitions: defs,
      ssSchemes: [],
      positions: [
        {
          id: "pos-1" as never,
          scenarioId: "scen-1" as never,
          departmentCode: "0410",
          jobTypeCode: "MGR",
          cluster: "Rooms",
          hotelClusterWeight: 0.5,
          payType: "SALARIED",
          headcount: 3,
          fte: 1,
          seasonality,
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
          updatedAt: NOW.now,
          deletedAt: null,
        },
      ],
      componentValues: [],
      buyouts: [],
    });
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);

    const headRow = result.aggregates.keys.findIndex(
      (key) => key.dept === "0410" && key.account === POSITION_COUNT_ACCOUNT
    );
    expect(headRow).toBeGreaterThanOrEqual(0);
    const head = Array.from({ length: 12 }, (_, m) =>
      result.aggregates.values[headRow * 12 + m]
    );
    // Full 3 heads every active month (weight 0.5 does not flex headcount), 0 in January.
    expect(head).toEqual([0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  });
});
