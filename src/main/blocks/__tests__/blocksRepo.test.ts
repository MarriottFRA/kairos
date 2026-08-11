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
import { applyStructureColumns } from "../schema";
import {
  blockCostDefId,
  blockStatDefId,
  BlockInput,
} from "../../../shared/blocks/ipc";
import {
  baseSalaryDefId,
  deleteBlock,
  ensureBaseSalaryDef,
  ensurePositionCountDef,
  ensureSystemDefs,
  holidayAccrualDefId,
  listBlocks,
  POSITION_COUNT_ACCOUNT,
  positionCountDefId,
  reorderBlocks,
  restoreBlock,
  saveBlock,
  systemStatDefId,
  vacationCostDefId,
} from "../repo";

type Db = InstanceType<typeof Database>;

const OU_A = resolveOuScope("OU12345");
const OU_B = resolveOuScope("OU99999");
const NOW = { now: "2026-01-01T00:00:00.000Z" };

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(db);
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

  it("COUNT_RATE spread WEIGHTED_BASE compiles to WEIGHTED_BY_BASE", () => {
    const id = saveBlock(
      db,
      OU_A,
      {
        blockType: "COUNT_RATE",
        label: "End of Service",
        accountCode: "560506",
        accountLocked: true,
        statsAccountCode: "",
        spread: "WEIGHTED_BASE",
      },
      NOW
    );

    const cost = getComponentDefinitions(db, OU_A).find(
      (def) => def.id === blockCostDefId(id)
    )!;
    expect(cost.spreadMethod).toBe("WEIGHTED_BY_BASE");
    // No explicit selector: the engine defaults WEIGHTED_BY_BASE to the gross
    // base-salary curve, which is what "weighted by salary" means here.
    expect(cost.baseSelector).toBeUndefined();
    expect(listBlocks(db, OU_A)[0].spread).toBe("WEIGHTED_BASE");
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

  it("MULTIPLIER of a composite sums base salary and the picked blocks", () => {
    const foodId = saveBlock(db, OU_A, flatMonthly({ label: "Food" }), NOW);
    const housingId = saveBlock(db, OU_A, flatMonthly({ label: "Housing" }), NOW);
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Pension",
        accountCode: "565003",
        accountLocked: true,
        base: {
          kind: "COMPOSITE",
          includeBaseSalary: true,
          blockIds: [foodId, housingId],
        },
      },
      NOW
    );

    const defs = getComponentDefinitions(db, OU_A);
    const pension = defs.find((def) => def.label === "Pension")!;
    expect(pension.spreadMethod).toBe("PERCENT_OF");
    expect(pension.baseSelector).toEqual({
      kind: "COMPONENTS",
      componentIds: [
        baseSalaryDefId(OU_A.ou),
        blockCostDefId(foodId),
        blockCostDefId(housingId),
      ],
    });
    // The composite refs the base-salary head by id, so it must exist even
    // though nothing else has built the structure read model yet.
    expect(defs.some((def) => def.id === baseSalaryDefId(OU_A.ou))).toBe(true);
  });

  it("a composite without base salary refs only the picked blocks", () => {
    const foodId = saveBlock(db, OU_A, flatMonthly({ label: "Food" }), NOW);
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Levy",
        accountCode: "565004",
        accountLocked: true,
        base: { kind: "COMPOSITE", includeBaseSalary: false, blockIds: [foodId] },
      },
      NOW
    );

    const levy = getComponentDefinitions(db, OU_A).find(
      (def) => def.label === "Levy"
    )!;
    expect(levy.baseSelector).toEqual({
      kind: "COMPONENTS",
      componentIds: [blockCostDefId(foodId)],
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

  it("POOL_SPREAD compiles to one DIRECT_ABS def carrying no KPI driver", () => {
    saveBlock(
      db,
      OU_A,
      {
        blockType: "POOL_SPREAD",
        label: "Gratuities",
        accountCode: "601000",
        accountLocked: true,
        poolSource: "KPI",
        poolKpiDriverId: "kpi-gratuities",
        poolSpreadBase: "FTE",
        poolEligibilityMode: "RULE",
        poolDepartments: ["D0060"],
        poolJobTypes: ["Associate"],
      },
      NOW
    );

    const defs = getComponentDefinitions(db, OU_A);
    expect(defs).toHaveLength(1);
    expect(defs[0].spreadMethod).toBe("DIRECT_ABS");
    expect(defs[0].kind).toBe("SPREAD");
    // A share of a fixed pot is never merit-increased.
    expect(defs[0].increaseAware).toBe(false);
    // Critically NOT set: kpi_driver_id is injectKpiSeries' trigger, and that
    // path would read the per-row eligibility flag as a multiplier.
    expect(defs[0].kpiDriverId ?? null).toBeNull();

    const [dto] = listBlocks(db, OU_A);
    expect(dto).toMatchObject({
      poolSource: "KPI",
      poolKpiDriverId: "kpi-gratuities",
      poolSpreadBase: "FTE",
      poolEligibilityMode: "RULE",
      poolDepartments: ["D0060"],
      poolJobTypes: ["Associate"],
    });
    expect(dto.statDefId).toBeUndefined();
  });

  it("POOL_SPREAD defaults an unconfigured block and validates its pot", () => {
    const id = saveBlock(
      db,
      OU_A,
      {
        blockType: "POOL_SPREAD",
        label: "Service charge",
        accountCode: "",
        accountLocked: true,
        poolSource: "MANUAL",
        poolMonthlyAmounts: Array(12).fill(1000),
      },
      NOW
    );
    const [dto] = listBlocks(db, OU_A);
    // A rule is legal with no filters at all — that means "everyone".
    expect(dto.poolSpreadBase).toBe("HEADCOUNT");
    expect(dto.poolEligibilityMode).toBe("MANUAL");
    expect(dto.poolMonthlyAmounts).toEqual(Array(12).fill(1000));

    expect(() =>
      saveBlock(
        db,
        OU_A,
        {
          id,
          blockType: "POOL_SPREAD",
          label: "Service charge",
          accountCode: "",
          accountLocked: true,
          poolSource: "MANUAL",
          poolMonthlyAmounts: [1, 2, 3],
        },
        NOW
      )
    ).toThrow(/12 monthly amounts/);

    expect(() =>
      saveBlock(
        db,
        OU_A,
        {
          blockType: "POOL_SPREAD",
          label: "No KPI",
          accountCode: "",
          accountLocked: true,
          poolSource: "KPI",
        },
        NOW
      )
    ).toThrow(/needs a KPI/);
  });
});

describe("saveBlock — compound (COMBINE) bases", () => {
  function compound(overrides: Partial<BlockInput> = {}): BlockInput {
    return {
      blockType: "MULTIPLIER",
      label: "Cost Per Hour",
      accountCode: "",
      accountLocked: true,
      base: {
        kind: "COMBINE",
        op: "DIV",
        left: { kind: "BASE_SALARY" },
        right: { kind: "STAT", stat: "HOURS" },
      },
      ...overrides,
    };
  }

  it("compiles to a COMBINE selector and seeds the stat head it references", () => {
    saveBlock(db, OU_A, compound(), NOW);

    const defs = getComponentDefinitions(db, OU_A);
    const cost = defs.find((def) => def.label === "Cost Per Hour")!;
    expect(cost.spreadMethod).toBe("PERCENT_OF");
    expect(cost.baseSelector).toEqual({
      kind: "COMBINE",
      op: "DIV",
      left: { kind: "BASE_SALARY" },
      right: { kind: "COMPONENTS", componentIds: [systemStatDefId(OU_A.ou, "HOURS")] },
    });
    // The referenced stat head has to exist or compile() would report MISSING_DEF.
    expect(defs.some((def) => def.id === systemStatDefId(OU_A.ou, "HOURS"))).toBe(true);
  });

  it("defaults a division to count-exempt and round-trips both flags", () => {
    saveBlock(db, OU_A, compound(), NOW);

    const block = listBlocks(db, OU_A)[0];
    expect(block.ratioNoHeadcount).toBe(true); // DIV → a ratio by default
    expect(block.useRowRate).toBe(true);
    expect(
      getComponentDefinitions(db, OU_A).find((def) => def.label === "Cost Per Hour")!
        .countExempt
    ).toBe(true);
  });

  it("pins the rate to 1 when the block carries no per-row column", () => {
    // Without this the absent ComponentValue would read as rate 0 and the line
    // would silently compute nothing at all.
    saveBlock(db, OU_A, compound({ useRowRate: false }), NOW);

    const selector = getComponentDefinitions(db, OU_A).find(
      (def) => def.label === "Cost Per Hour"
    )!.baseSelector;
    expect(selector?.kind).toBe("COMBINE");
    expect(selector?.kind === "COMBINE" && selector.rate).toBe(1);
    expect(listBlocks(db, OU_A)[0].useRowRate).toBe(false);
  });

  it("lets a non-division compound keep the headcount multiplier", () => {
    saveBlock(db, OU_A, compound({ label: "Days × Hours", base: {
      kind: "COMBINE",
      op: "MUL",
      left: { kind: "CALENDAR", series: "PAY_DAYS" },
      right: { kind: "STAT", stat: "HOURS" },
    } }), NOW);

    expect(listBlocks(db, OU_A)[0].ratioNoHeadcount).toBe(false);
  });

  it("refuses a side that loops back to the block being saved", () => {
    const id = saveBlock(db, OU_A, flatMonthly({ label: "Housing" }), NOW);
    const levyId = saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Levy",
        accountCode: "",
        accountLocked: true,
        base: { kind: "BLOCK", blockId: id },
      },
      NOW
    );

    // Editing Housing to divide by the Levy that already depends on it would
    // close the loop — caught here rather than as a CYCLE at recalc time.
    expect(() =>
      saveBlock(
        db,
        OU_A,
        {
          id: levyId,
          blockType: "MULTIPLIER",
          label: "Levy",
          accountCode: "",
          accountLocked: true,
          base: {
            kind: "COMBINE",
            op: "DIV",
            left: { kind: "BASE_SALARY" },
            right: { kind: "BLOCK", blockId: levyId },
          },
        },
        NOW
      )
    ).toThrow(/itself as its base/);
  });

  it("rejects a nested compound and a KPI side", () => {
    expect(() =>
      saveBlock(db, OU_A, compound({ base: {
        kind: "COMBINE",
        op: "MUL",
        left: { kind: "BASE_SALARY" },
        right: {
          kind: "COMBINE",
          op: "ADD",
          left: { kind: "VACATION" },
          right: { kind: "BASE_SALARY" },
        },
      } }), NOW)
    ).toThrow(/cannot use another combined block/);

    expect(() =>
      saveBlock(db, OU_A, compound({ base: {
        kind: "COMBINE",
        op: "MUL",
        left: { kind: "BASE_SALARY" },
        right: { kind: "KPI", kpiDriverId: "kpi-1" },
      } }), NOW)
    ).toThrow(/KPI cannot be one side/);
  });
});

describe("saveBlock — where it books", () => {
  const multiplier = (overrides: Partial<BlockInput> = {}): BlockInput => ({
    blockType: "MULTIPLIER",
    label: "Shared Services Levy",
    accountCode: "519000",
    accountLocked: true,
    base: { kind: "BASE_SALARY" },
    ...overrides,
  });

  it("round-trips PER_ROW while projecting the def as POSITION", () => {
    const id = saveBlock(db, OU_A, multiplier({ departmentMode: "PER_ROW" }), NOW);

    expect(listBlocks(db, OU_A)[0].departmentMode).toBe("PER_ROW");

    // The compiled definition keeps to the two values its CHECK allows. That
    // is not a lossy projection: POSITION is exactly what a blank per-row cell
    // falls back to, and it is all the engine asks the definition for.
    const row = db
      .prepare(
        `SELECT department_mode, fixed_department FROM cost_component_definitions WHERE id = ?`
      )
      .get(blockCostDefId(id)) as Record<string, unknown>;
    expect(row.department_mode).toBe("POSITION");
    expect(row.fixed_department).toBeNull();
  });

  it("round-trips FIXED and keeps it across a re-save", () => {
    // Regression: the dialog used to omit departmentMode entirely, so opening
    // a FIXED block's cog and saving silently moved its money back to each
    // row's own department with no message.
    const id = saveBlock(
      db,
      OU_A,
      multiplier({ departmentMode: "FIXED", fixedDepartment: "1910" }),
      NOW
    );
    expect(listBlocks(db, OU_A)[0].fixedDepartment).toBe("1910");

    saveBlock(
      db,
      OU_A,
      multiplier({ id, departmentMode: "FIXED", fixedDepartment: "1910" }),
      { now: "2026-02-01T00:00:00.000Z" }
    );

    const after = listBlocks(db, OU_A)[0];
    expect(after.departmentMode).toBe("FIXED");
    expect(after.fixedDepartment).toBe("1910");
    const row = db
      .prepare(
        `SELECT department_mode, fixed_department FROM cost_component_definitions WHERE id = ?`
      )
      .get(blockCostDefId(id)) as Record<string, unknown>;
    expect(row.department_mode).toBe("FIXED");
    expect(row.fixed_department).toBe("1910");
  });

  it("drops a stale fixed department when the mode moves off FIXED", () => {
    const id = saveBlock(
      db,
      OU_A,
      multiplier({ departmentMode: "FIXED", fixedDepartment: "1910" }),
      NOW
    );
    saveBlock(
      db,
      OU_A,
      multiplier({ id, departmentMode: "PER_ROW", fixedDepartment: "1910" }),
      NOW
    );
    expect(listBlocks(db, OU_A)[0].fixedDepartment).toBeUndefined();
  });

  it("rejects FIXED with no department, and PER_ROW on a non-multiplier", () => {
    expect(() =>
      saveBlock(db, OU_A, multiplier({ departmentMode: "FIXED" }), NOW)
    ).toThrow(/Choose the department/);
    expect(() =>
      saveBlock(db, OU_A, flatMonthly({ departmentMode: "PER_ROW" }), NOW)
    ).toThrow(/Only a Multiplier block/);
  });

  it("defaults to POSITION", () => {
    saveBlock(db, OU_A, multiplier(), NOW);
    expect(listBlocks(db, OU_A)[0].departmentMode).toBe("POSITION");
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

  it("rejects a composite base that adds up nothing", () => {
    expect(() =>
      saveBlock(
        db,
        OU_A,
        {
          blockType: "MULTIPLIER",
          label: "Empty composite",
          accountCode: "",
          accountLocked: true,
          base: { kind: "COMPOSITE", includeBaseSalary: false, blockIds: [] },
        },
        NOW
      )
    ).toThrow(/at least one thing/);
  });

  it("rejects a composite base that loops back through another block", () => {
    // A -> B (composite). Editing B's base to include A would close the loop.
    const aId = saveBlock(db, OU_A, flatMonthly({ label: "A" }), NOW);
    const bId = saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "B",
        accountCode: "",
        accountLocked: true,
        base: { kind: "COMPOSITE", includeBaseSalary: true, blockIds: [aId] },
      },
      NOW
    );
    // C sits between them so the cycle is not a direct self-reference.
    const cId = saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "C",
        accountCode: "",
        accountLocked: true,
        base: { kind: "BLOCK", blockId: bId },
      },
      NOW
    );

    expect(() =>
      saveBlock(
        db,
        OU_A,
        {
          id: bId,
          blockType: "MULTIPLIER",
          label: "B",
          accountCode: "",
          accountLocked: true,
          base: { kind: "COMPOSITE", includeBaseSalary: true, blockIds: [cId] },
        },
        NOW
      )
    ).toThrow(/loops back to this block/);
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

  it("refuses deletion while a COMPOUND block divides by it", () => {
    // The guard reads component_base_refs, so a compound only stays protected
    // because its nested sides are written into that projection too.
    const baseId = saveBlock(db, OU_A, flatMonthly({ label: "Overtime" }), NOW);
    saveBlock(
      db,
      OU_A,
      {
        blockType: "MULTIPLIER",
        label: "Overtime Per Hour",
        accountCode: "",
        accountLocked: true,
        base: {
          kind: "COMBINE",
          op: "DIV",
          left: { kind: "BLOCK", blockId: baseId },
          right: { kind: "STAT", stat: "HOURS" },
        },
      },
      NOW
    );

    expect(() => deleteBlock(db, OU_A, baseId, NOW)).toThrow(
      /used as a base by: Overtime Per Hour/
    );
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

  // These heads are what the Positions grid's account columns post through. They
  // must exist for every OU regardless of which blocks the user built — before
  // this, only the position-count head was permanently seeded, which is why
  // Results only ever showed A972540. Asserted against the real SQL (not
  // hand-built defs) so the seed and the read path are pinned together; the
  // account wiring itself is covered by shared/positions/__tests__/positionAccounts.
  it("ensureSystemDefs seeds every permanent head, idempotently and blank-accounted", () => {
    ensureSystemDefs(db, OU_A, NOW);
    ensureSystemDefs(db, OU_A, NOW);

    const defs = getComponentDefinitions(db, OU_A);
    const byId = new Map(defs.map((def) => [def.id as string, def]));
    expect(defs).toHaveLength(6);

    expect(byId.get(baseSalaryDefId(OU_A.ou))).toMatchObject({
      kind: "BASE_SALARY",
      accountCode: "",
    });
    expect(byId.get(systemStatDefId(OU_A.ou, "HEADCOUNT"))).toMatchObject({
      kind: "STAT",
      statKind: "HEADCOUNT",
      accountCode: "",
    });
    expect(byId.get(systemStatDefId(OU_A.ou, "HOURS"))).toMatchObject({
      kind: "STAT",
      statKind: "HOURS",
      accountCode: "",
    });
    expect(byId.get(holidayAccrualDefId(OU_A.ou))).toMatchObject({
      kind: "HOLIDAY_ACCRUAL",
      accountCode: "",
    });
    // The vacation-cost head is a PERCENT_OF spread over the VACATION series —
    // no new opcode, no new ComponentKind, no migration of the kind CHECK. The
    // selector rides as base_ref JSON, so this also pins that round-trip.
    expect(byId.get(vacationCostDefId(OU_A.ou))).toMatchObject({
      kind: "SPREAD",
      spreadMethod: "PERCENT_OF",
      baseSelector: { kind: "VACATION" },
      accountCode: "",
    });
    // Only this one carries an account, and it is pinned.
    expect(byId.get(positionCountDefId(OU_A.ou))).toMatchObject({
      accountCode: POSITION_COUNT_ACCOUNT,
    });

    // The set must still compile: exactly one BASE_SALARY, at most one accrual,
    // and the vacation base resolves — all validated by compile().
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
          accrualDaysPerMonth: 20 / 12,
          updatedAt: NOW.now,
          deletedAt: null,
        },
      ],
      componentValues: [],
      buyouts: [],
    });
    expect("errors" in compiled).toBe(false);
  });
});
