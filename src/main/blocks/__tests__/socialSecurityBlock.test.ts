/**
 * Social Security / NI block â€” a user-added block that emits a SOCIAL_SECURITY
 * definition once a scheme is attached. Covers: an unconfigured block compiles
 * to NO def (harmless); configuring it emits the def; and an end-to-end
 * compile+simulate produces the NI line off the contributory base each scheme
 * owns (materialized by applySocialSecurityBase). In-memory SQLite (blocksRepo
 * test pattern).
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { compile, simulate } from "../../../shared/engine/simulate";
import {
  Position,
  ScenarioInput,
  SocialSecurityScheme,
} from "../../../shared/engine/types";
import { POSITIONS_STRUCTURE_TABLES_SQL } from "../../positions/schema";
import { resolveOuScope } from "../../positions/ouScope";
import { getComponentDefinitions } from "../../positions/structureRepo";
import { applyStructureColumns } from "../schema";
import { applySocialSecurityBase } from "../../../shared/positions/engineInput";
import { BlockDto } from "../../../shared/blocks/ipc";
import { ensureBaseSalaryDef, listBlocks, saveBlock } from "../repo";

type Db = InstanceType<typeof Database>;

const OU = resolveOuScope("OU12345");
const NOW = { now: "2026-01-01T00:00:00.000Z" };
const SCHEME_ID = "ni-scheme-1";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(db);
  ensureBaseSalaryDef(db, OU, NOW);
});

/** Create the NI block (optionally with a scheme) and return it. */
function saveNiBlock(ssSchemeId?: string): BlockDto {
  saveBlock(
    db,
    OU,
    {
      blockType: "SOCIAL_SECURITY",
      label: "National Insurance",
      accountCode: "530000",
      accountLocked: true,
      ssSchemeId,
    },
    NOW
  );
  const ni = listBlocks(db, OU).find((b) => b.blockType === "SOCIAL_SECURITY");
  if (!ni) throw new Error("NI block was not created");
  return ni;
}

/** A flat-10% scheme; base membership defaults to base salary + vacation on. */
function makeScheme(over: Partial<SocialSecurityScheme> = {}): SocialSecurityScheme {
  return {
    id: SCHEME_ID as never,
    label: "Flat 10%",
    monthlyCap: null,
    yearlyCap: null,
    brackets: [{ upTo: null, rate: 0.1 }],
    includeBaseSalary: true,
    includeVacation: true,
    baseComponentIds: [],
    updatedAt: NOW.now,
    deletedAt: null,
    ...over,
  };
}

function salariedPosition(): Position {
  return {
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
    vacationDays: 0,
    vacationMonthlyWeights: new Array(12).fill(0),
    accrualDaysPerMonth: 0,
    updatedAt: NOW.now,
    deletedAt: null,
  };
}

function scenarioInput(schemes: SocialSecurityScheme[]): ScenarioInput {
  const definitions = getComponentDefinitions(db, OU);
  applySocialSecurityBase(definitions, schemes);
  return {
    scenario: { id: "scen-1" as never, ou: OU.ou, year: 2026, label: "", updatedAt: NOW.now, deletedAt: null },
    calendar: {
      year: 2026,
      realDays: new Float64Array(12).fill(21),
      flatDays: new Float64Array(12).fill(30),
      holidayDays: new Float64Array(12),
    },
    definitions,
    ssSchemes: schemes,
    positions: [salariedPosition()],
    componentValues: [],
    buyouts: [],
  };
}

describe("an unconfigured NI block", () => {
  it("has no scheme attached", () => {
    const ni = saveNiBlock();
    expect(ni.ssSchemeId).toBeUndefined();
  });

  it("emits NO definition while unconfigured, and still compiles", () => {
    saveNiBlock();
    const defs = getComponentDefinitions(db, OU);
    expect(defs.some((d) => d.kind === "SOCIAL_SECURITY")).toBe(false);
    const result = compile(scenarioInput([]));
    expect("errors" in result).toBe(false);
  });
});

describe("configuring the NI block", () => {
  let niCostDefId: string;

  beforeEach(() => {
    niCostDefId = saveNiBlock(SCHEME_ID).costDefId;
  });

  it("emits a SOCIAL_SECURITY def with the scheme attached", () => {
    const defs = getComponentDefinitions(db, OU);
    const ni = defs.find((d) => d.kind === "SOCIAL_SECURITY");
    expect(ni?.id).toBe(niCostDefId);
    expect(ni?.ssSchemeId).toBe(SCHEME_ID);
    expect(ni?.accountCode).toBe("530000");
  });

  it("computes NI as 10% of the base-salary contributory base", () => {
    const compiled = compile(scenarioInput([makeScheme()]));
    expect("errors" in compiled).toBe(false);
    if ("errors" in compiled) return;
    const sim = simulate(compiled.plan);
    const niLine = sim
      .positionLines("pos-1" as never)
      .find((line) => line.component.id === niCostDefId);
    expect(niLine).toBeDefined();
    // Salaried 3000/mo, no vacation â†’ net base + vacation = 3000 each month; flat
    // 10% â†’ 300/mo, 3600/yr.
    const total = [...niLine!.months].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(3600, 5);
    for (const month of niLine!.months) expect(month).toBeCloseTo(300, 5);
  });

  it("drops NI to 0 when the base opts out of base salary and vacation", () => {
    const scheme = makeScheme({ includeBaseSalary: false, includeVacation: false });
    const compiled = compile(scenarioInput([scheme]));
    expect("errors" in compiled).toBe(false);
    if ("errors" in compiled) return;
    const sim = simulate(compiled.plan);
    const niLine = sim
      .positionLines("pos-1" as never)
      .find((line) => line.component.id === niCostDefId);
    const total = niLine ? [...niLine.months].reduce((sum, value) => sum + value, 0) : 0;
    expect(total).toBeCloseTo(0, 5);
  });
});
