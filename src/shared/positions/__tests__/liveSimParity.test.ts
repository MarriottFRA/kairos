/**
 * Live-sim ↔ loader parity — the anti-divergence guarantee for block totals.
 * The renderer's runLiveSim (grid rows in, block lines out) must produce
 * BIT-IDENTICAL months to the main-process path (loadScenarioInput → compile
 * → simulate) over the same persisted data, for every block type.
 */

import { beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  buildDefaultCalendar,
  calendarTotals,
  DEFAULT_WEEKEND_MASK,
} from "../../calendar";
import {
  buildDefaultPositionDefaults,
  fullTimeReference,
  resolvePositionDefaults,
} from "../../positionDefaults";
import { compile, simulate } from "../../engine/simulate";
import { PositionId } from "../../engine/types";
import { applyBlocksStructureV12 } from "../../../main/blocks/schema";
import { KPI_DRIVERS_SQL } from "../../../main/kpiDrivers/schema";
import {
  ensureBaseSalaryDef,
  listBlocks,
  saveBlock,
} from "../../../main/blocks/repo";
import { applyHotelClustersV13 } from "../../../main/hotelClusters/schema";
import {
  listClusters as listHotelClusters,
  saveCluster as saveHotelCluster,
} from "../../../main/hotelClusters/repo";
import {
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../../main/positions/schema";
import { resolveOuScope } from "../../../main/positions/ouScope";
import {
  getComponentDefinitions,
  getFieldCatalog,
  getSsSchemes,
  saveScenario,
} from "../../../main/positions/structureRepo";
import {
  batchWrite,
  loadScenarioValues,
} from "../../../main/positions/positionsRepo";
import { loadScenarioInput } from "../../../main/positions/loadScenarioInput";
import { applyComponentValuesToRow } from "../blockRows";
import { buildFieldMap, toRow } from "../rowModel";
import { runLiveSim } from "../liveSim";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const NOW = { now: "2026-01-01T00:00:00.000Z" };
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);

// The full-time contract FTE is derived against. The loader builds this itself
// from the hotel-year defaults (falling back to the built-in ones resolved
// against the scenario calendar, which is what these fixtures get, having saved
// none); the renderer reads it from the same handler and hands it to the sim.
// Parity requires the two to be the SAME reference — a live sim measuring
// against a different full-timer would silently disagree on every FTE-based
// pool and every FTE stat.
const FULL_TIME = fullTimeReference(
  resolvePositionDefaults(buildDefaultPositionDefaults(SCOPE.ou, YEAR), CALENDAR)
);

/** Contract day counts that make a full-year row exactly one FTE: the same
 *  productive year the reference is built from, at the full-time day length. */
const CAL_TOTALS = calendarTotals(CALENDAR);
const FULL_TIME_CONTRACT = {
  contractYearlyDays: CAL_TOTALS.calendarDays,
  contractDaysOff: CAL_TOTALS.weekendDays,
  contractPubHolidays: CAL_TOTALS.publicHolidays,
  dailyContractHours: FULL_TIME.dailyHours,
};

/** The gratuity pot: a KPI driver whose cached series is already multiplied. */
const GRAT_DRIVER = "kpi-gratuities";
const GRAT_SERIES = new Array(12).fill(1200);

/** Seed the KPI precalc cache the loader reads (the renderer gets the same
 *  numbers from its own drivers list — see the kpiSeries lambda below). */
function seedKpiSeries(db: Db): void {
  const insert = db.prepare(
    `INSERT INTO kpi_driver_values
       (driver_id, ou, dept_key, period, value, source_import_id, computed_at)
     VALUES (?, ?, '*', ?, ?, NULL, ?)`
  );
  for (let period = 1; period <= 12; period++) {
    insert.run(GRAT_DRIVER, SCOPE.ou, period, GRAT_SERIES[period - 1], NOW.now);
  }
}

let structureDb: Db;
let valuesDb: Db;
let scenarioId: string;

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyBlocksStructureV12(structureDb);
  applyHotelClustersV13(structureDb);
  // The pooled block reads a KPI's cached series through the loader, so the
  // parity fixture needs the KPI tables the plaintext store carries.
  structureDb.exec(KPI_DRIVERS_SQL);
  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
  scenarioId = saveScenario(structureDb, SCOPE, { year: YEAR, label: "Planning" }).id;
});

it("live sim matches loadScenarioInput → simulate bit-for-bit on every block type", async () => {
  ensureBaseSalaryDef(structureDb, SCOPE, NOW);

  const flatId = saveBlock(
    structureDb, SCOPE,
    { blockType: "FLAT_MONTHLY", label: "Uniforms", accountCode: "511000", accountLocked: true, increaseAware: true },
    NOW
  );
  const multSalaryId = saveBlock(
    structureDb, SCOPE,
    { blockType: "MULTIPLIER", label: "Pension", accountCode: "513000", accountLocked: true, base: { kind: "BASE_SALARY" } },
    NOW
  );
  const multBlockId = saveBlock(
    structureDb, SCOPE,
    { blockType: "MULTIPLIER", label: "Uniform Levy", accountCode: "514000", accountLocked: true, base: { kind: "BLOCK", blockId: flatId } },
    NOW
  );
  const multHoursId = saveBlock(
    structureDb, SCOPE,
    { blockType: "MULTIPLIER", label: "Hourly Levy", accountCode: "515000", accountLocked: true, base: { kind: "STAT", stat: "HOURS" } },
    NOW
  );
  const multDaysId = saveBlock(
    structureDb, SCOPE,
    { blockType: "MULTIPLIER", label: "Daily Levy", accountCode: "516000", accountLocked: true, base: { kind: "CALENDAR", series: "PAY_DAYS" } },
    NOW
  );
  const multVacId = saveBlock(
    structureDb, SCOPE,
    { blockType: "MULTIPLIER", label: "Vacation Levy", accountCode: "", accountLocked: true, base: { kind: "VACATION" } },
    NOW
  );
  const countRateId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "COUNT_RATE", label: "Meals", accountCode: "517000", accountLocked: false,
      statsAccountCode: "988200", statsAccountLocked: true,
      spread: "VACATION_PATTERN", increaseAware: false,
    },
    NOW
  );
  const customId = saveBlock(
    structureDb, SCOPE,
    { blockType: "CUSTOM_MONTHLY", label: "Seasonal", accountCode: "518000", accountLocked: true, increaseAware: true },
    NOW
  );
  // A pooled block whose pot comes from a KPI and whose eligibility is a rule
  // with no filters — every position shares it, nothing is stored per row.
  seedKpiSeries(structureDb);
  const poolKpiId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "POOL_SPREAD", label: "Gratuities", accountCode: "601000",
      accountLocked: true, poolSource: "KPI", poolKpiDriverId: GRAT_DRIVER,
      poolSpreadBase: "HEADCOUNT", poolEligibilityMode: "RULE",
    },
    NOW
  );
  // …and one with a typed pot, shared only by the rows that are ticked.
  const poolManualId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "POOL_SPREAD", label: "Service charge", accountCode: "602000",
      accountLocked: true, poolSource: "MANUAL",
      poolMonthlyAmounts: new Array(12).fill(600),
      poolSpreadBase: "FTE", poolEligibilityMode: "MANUAL",
    },
    NOW
  );

  const blocks = listBlocks(structureDb, SCOPE);
  const lookup = buildFieldMap(getFieldCatalog(structureDb, SCOPE));
  const defIds = new Set(getComponentDefinitions(structureDb, SCOPE).map((def) => def.id as string));

  batchWrite(
    valuesDb, SCOPE,
    {
      ou: SCOPE.ou,
      scenarioId,
      creates: [
        // pos-1 fills in its posting accounts, pos-2 leaves them blank — so the
        // parity check covers both the routed and the calculate-but-don't-post
        // path through applyPositionAccounts.
        {
          id: "pos-1",
          fields: {
            departmentCode: "0410", jobTypeCode: "MGR", cluster: "Rooms",
            payType: "SALARIED", headcount: 2, monthlyBaseSalary: 3200,
            seasonality: [1, 1, 1, 0.5, 0, 1, 1, 1, 1, 1, 1, 1],
            vacationMonthlyWeights: [0, 0, 0.5, 0, 0, 0.25, 0, 0, 0.25, 0, 0, 0],
            // Contract days feed the derived FTE, which the FTE-based pooled
            // block below spreads over — a row without them is 0 FTE and gets
            // no share.
            ...FULL_TIME_CONTRACT,
            vacationDays: 21, yearlyHoursWorked: 1900,
            meritIncreasePct: 0.06, increaseMonth: 7,
            salaryAccountCode: "A511000", headCountAccount: "A972100",
            workingHoursAccount: "A972200", accrualAccount: "A512000",
            benefitsAccountCode: "A513000",
          },
        },
        {
          id: "pos-2",
          fields: {
            departmentCode: "1310", jobTypeCode: "ASC", cluster: "F&B",
            payType: "HOURLY", headcount: 1, hourlyRate: 21.5,
            seasonality: new Array(12).fill(1),
            vacationMonthlyWeights: new Array(12).fill(1 / 12),
            ...FULL_TIME_CONTRACT,
            vacationDays: 14, yearlyHoursWorked: 1700,
          },
        },
      ],
      componentValuePatches: [
        { positionId: "pos-1", componentDefId: `${flatId}:cost`, fields: { yearlyValue: 120 } },
        { positionId: "pos-1", componentDefId: `${multSalaryId}:cost`, fields: { rate: 0.05 } },
        { positionId: "pos-1", componentDefId: `${multBlockId}:cost`, fields: { rate: 1.5 } },
        { positionId: "pos-1", componentDefId: `${multHoursId}:cost`, fields: { rate: 0.75 } },
        { positionId: "pos-1", componentDefId: `${multDaysId}:cost`, fields: { rate: 12.25 } },
        { positionId: "pos-1", componentDefId: `${multVacId}:cost`, fields: { rate: 0.2 } },
        // Unlocked cost account: pos-1 overrides the block default per row.
        {
          positionId: "pos-1",
          componentDefId: `${countRateId}:cost`,
          fields: { qty: 40, unitRate: 6.5, accountCode: "517999" },
        },
        {
          positionId: "pos-1", componentDefId: `${customId}:cost`,
          fields: { monthlyValues: [10, 0, 30, 0, 50, 0, 70, 0, 90, 0, 110, 0] },
        },
        { positionId: "pos-2", componentDefId: `${flatId}:cost`, fields: { yearlyValue: 85 } },
        { positionId: "pos-2", componentDefId: `${multSalaryId}:cost`, fields: { rate: 0.08 } },
        { positionId: "pos-2", componentDefId: `${countRateId}:cost`, fields: { qty: 22, unitRate: 4 } },
        // The pool tick box rides the rate slot: pos-2 is in the service-charge
        // pool, pos-1 is deliberately not (and has no row at all).
        { positionId: "pos-2", componentDefId: `${poolManualId}:cost`, fields: { rate: 1 } },
      ],
    },
    lookup,
    defIds
  );

  // ── Main path: loader → compile → simulate ──
  const input = await loadScenarioInput(
    structureDb, valuesDb, SCOPE, scenarioId,
    async () => CALENDAR
  );
  const compiled = compile(input);
  if (!("plan" in compiled)) {
    throw new Error(`loader compile failed: ${JSON.stringify(compiled.errors)}`);
  }
  const mainRun = simulate(compiled.plan);

  // ── Renderer path: rows → runLiveSim ──
  const loaded = loadScenarioValues(valuesDb, SCOPE, scenarioId);
  const valuesByPosition = new Map<string, typeof loaded.componentValues>();
  for (const value of loaded.componentValues) {
    const list = valuesByPosition.get(value.positionId) ?? [];
    list.push(value);
    valuesByPosition.set(value.positionId, list);
  }
  const rows = loaded.positions.map((record) =>
    applyComponentValuesToRow(toRow(record), valuesByPosition.get(record.id), blocks)
  );

  const live = runLiveSim({
    rows,
    blocks,
    definitions: getComponentDefinitions(structureDb, SCOPE),
    ssSchemes: getSsSchemes(structureDb, SCOPE),
    calendarYear: CALENDAR,
    // The renderer's own copy of the cached series — same numbers the loader
    // reads out of kpi_driver_values, which is what parity is testing.
    kpiSeries: (driverId) =>
      driverId === GRAT_DRIVER
        ? [{ deptKey: "*", values: GRAT_SERIES }]
        : [],
    scenarioId,
    ou: SCOPE.ou,
    fullTime: FULL_TIME,
  });
  expect(live.errors).toBeNull();

  // ── Bit-identical block lines, both positions, every block def ──
  const blockDefIds = blocks.flatMap((block) =>
    block.statDefId ? [block.costDefId, block.statDefId] : [block.costDefId]
  );
  let comparedLines = 0;
  for (const positionId of ["pos-1", "pos-2"]) {
    const mainLines = new Map(
      mainRun
        .positionLines(positionId as PositionId)
        .map((line) => [line.component.id as string, line.months])
    );
    const liveLines = live.results.get(positionId);
    expect(liveLines, `live results for ${positionId}`).toBeDefined();
    for (const defId of blockDefIds) {
      const mainMonths = mainLines.get(defId);
      const liveMonths = liveLines!.get(defId)?.months;
      expect(mainMonths, `main line ${defId}`).toBeDefined();
      expect(liveMonths, `live line ${defId}`).toBeDefined();
      for (let m = 0; m < 12; m++) {
        if (liveMonths![m] !== mainMonths![m]) {
          throw new Error(
            `parity mismatch: ${positionId} ${defId} month ${m + 1}: live ${liveMonths![m]} vs main ${mainMonths![m]}`
          );
        }
      }
      comparedLines++;
    }
  }
  // 10 blocks + 1 dual stat line, × 2 positions.
  expect(comparedLines).toBe(22);

  // Per-row account override (unlocked Meals cost account): pos-1 posts to its
  // own account, pos-2 falls back to the block default — visible in the
  // dept×account keys the loader-compiled plan interned.
  const aggKeys = mainRun.aggregates.keys.map((key) => `${key.dept}|${key.account}`);
  expect(aggKeys).toContain("0410|517999"); // pos-1's override
  expect(aggKeys).toContain("1310|517000"); // pos-2 on the default
  expect(aggKeys).toContain("0410|988200"); // stat line on the locked stats account

  // Sanity on the semantics, not just parity: Uniforms (pos-1) = 120/month ×
  // seasonality × headcount 2, merit ×1.06 from July; total working months
  // = 11.5 with 0.5 April and a dark May.
  const uniforms = live.results.get("pos-1")!.get(`${flatId}:cost`)!;
  expect(uniforms.months[0]).toBeCloseTo(240, 9); // Jan: 120 × 1 × 2
  expect(uniforms.months[3]).toBeCloseTo(120, 9); // Apr: 120 × 0.5 × 2
  expect(uniforms.months[4]).toBe(0); // May dark
  expect(uniforms.months[7]).toBeCloseTo(240 * 1.06, 9); // Aug: merit-aware

  // The blank-account vacation levy still computes (usable as a base;
  // excluded only from persisted output).
  const vacLevy = live.results.get("pos-1")!.get(`${multVacId}:cost`)!;
  expect(vacLevy.total).toBeGreaterThan(0);

  // The pooled gratuity fund: 1200/month split by headcount (pos-1 counts 2,
  // pos-2 counts 1) and gated by working months. The whole pot always lands.
  const gratOne = live.results.get("pos-1")!.get(`${poolKpiId}:cost`)!;
  const gratTwo = live.results.get("pos-2")!.get(`${poolKpiId}:cost`)!;
  expect(gratOne.months[0]).toBeCloseTo(800, 9); // Jan: 1200 × 2/3
  expect(gratTwo.months[0]).toBeCloseTo(400, 9); // Jan: 1200 × 1/3
  expect(gratOne.months[3]).toBeCloseTo(600, 9); // Apr: pos-1 half-active → 1/2
  expect(gratOne.months[4]).toBe(0); // May: pos-1 dark…
  expect(gratTwo.months[4]).toBeCloseTo(1200, 9); // …so pos-2 takes it all
  for (let m = 0; m < 12; m++) {
    expect(gratOne.months[m] + gratTwo.months[m]).toBeCloseTo(1200, 9);
  }
  // Merit does not touch a share of a fixed pot (contrast Uniforms above).
  expect(gratOne.months[7] + gratTwo.months[7]).toBeCloseTo(1200, 9);

  // The manual pool: only pos-2 is ticked, so it takes the whole 600 and
  // pos-1 books nothing despite being the bigger row.
  expect(live.results.get("pos-1")!.get(`${poolManualId}:cost`)!.total).toBe(0);
  expect(
    live.results.get("pos-2")!.get(`${poolManualId}:cost`)!.months[0]
  ).toBeCloseTo(600, 9);
});

it("resolves a hotel-cluster weight identically in both paths and flexes block totals", async () => {
  ensureBaseSalaryDef(structureDb, SCOPE, NOW);
  const flatId = saveBlock(
    structureDb, SCOPE,
    { blockType: "FLAT_MONTHLY", label: "Uniforms", accountCode: "511000", accountLocked: true },
    NOW
  );

  // Two-hotel cluster: this hotel carries 0.25 of shared people. Written
  // through the real repo so the stored shape is the wire shape.
  const clusterId = saveHotelCluster(
    structureDb,
    {
      name: "Shared Services",
      members: [
        { ou: SCOPE.ou, weight: 0.25 },
        { ou: "OU99999", weight: 0.75 },
      ],
    },
    NOW
  );
  const hotelClusters = listHotelClusters(structureDb);

  const blocks = listBlocks(structureDb, SCOPE);
  const lookup = buildFieldMap(getFieldCatalog(structureDb, SCOPE));
  const defIds = new Set(getComponentDefinitions(structureDb, SCOPE).map((def) => def.id as string));

  batchWrite(
    valuesDb, SCOPE,
    {
      ou: SCOPE.ou,
      scenarioId,
      creates: [
        {
          // Assigned via the catalog write path — exercises the cluster field
          // end-to-end (seed v15 column + ENGINE_SCALAR_COLUMNS mapping).
          id: "pos-1",
          fields: {
            departmentCode: "0410", jobTypeCode: "MGR", cluster: clusterId,
            payType: "SALARIED", headcount: 1, monthlyBaseSalary: 3000,
            seasonality: new Array(12).fill(1),
            vacationMonthlyWeights: new Array(12).fill(1 / 12),
            // A full-time, full-year contract — so the derived FTE is exactly
            // 1 and the flexed stat below is purely the cluster weight.
            ...FULL_TIME_CONTRACT,
            yearlyHoursWorked: 1800,
          },
        },
        {
          // A multi-member cluster must IGNORE the stored override.
          id: "pos-2",
          fields: {
            departmentCode: "0410", jobTypeCode: "MGR", cluster: clusterId,
            clusterMultiplierOverride: 0.9,
            payType: "SALARIED", headcount: 1, monthlyBaseSalary: 3000,
            seasonality: new Array(12).fill(1),
            vacationMonthlyWeights: new Array(12).fill(1 / 12),
            ...FULL_TIME_CONTRACT,
            yearlyHoursWorked: 1800,
          },
        },
      ],
      componentValuePatches: [
        { positionId: "pos-1", componentDefId: `${flatId}:cost`, fields: { yearlyValue: 1200 } },
        { positionId: "pos-2", componentDefId: `${flatId}:cost`, fields: { yearlyValue: 1200 } },
      ],
    },
    lookup,
    defIds
  );

  const input = await loadScenarioInput(
    structureDb, valuesDb, SCOPE, scenarioId,
    async () => CALENDAR
  );
  // The loader hands the engine the resolved NAME (stats key) + weight.
  expect(input.positions.map((p) => p.cluster)).toEqual([
    "Shared Services",
    "Shared Services",
  ]);
  expect(input.positions.map((p) => p.hotelClusterWeight)).toEqual([0.25, 0.25]);

  const compiled = compile(input);
  if (!("plan" in compiled)) {
    throw new Error(`loader compile failed: ${JSON.stringify(compiled.errors)}`);
  }
  const mainRun = simulate(compiled.plan);

  const loaded = loadScenarioValues(valuesDb, SCOPE, scenarioId);
  const valuesByPosition = new Map<string, typeof loaded.componentValues>();
  for (const value of loaded.componentValues) {
    const list = valuesByPosition.get(value.positionId) ?? [];
    list.push(value);
    valuesByPosition.set(value.positionId, list);
  }
  const rows = loaded.positions.map((record) =>
    applyComponentValuesToRow(toRow(record), valuesByPosition.get(record.id), blocks)
  );

  const live = runLiveSim({
    rows,
    blocks,
    definitions: getComponentDefinitions(structureDb, SCOPE),
    ssSchemes: getSsSchemes(structureDb, SCOPE),
    calendarYear: CALENDAR,
    kpiSeries: () => [],
    scenarioId,
    ou: SCOPE.ou,
    hotelClusters,
    fullTime: FULL_TIME,
  });
  expect(live.errors).toBeNull();

  for (const positionId of ["pos-1", "pos-2"]) {
    const mainMonths = mainRun
      .positionLines(positionId as PositionId)
      .find((line) => (line.component.id as string) === `${flatId}:cost`)!.months;
    const liveMonths = live.results.get(positionId)!.get(`${flatId}:cost`)!.months;
    for (let m = 0; m < 12; m++) {
      expect(liveMonths[m], `${positionId} month ${m + 1}`).toBe(mainMonths[m]);
    }
    // Semantics, not just parity: FLAT_MONTHLY books its value per active
    // month (1200/mo), × 0.25 share = 300 — and the override on pos-2 is
    // ignored (two member hotels), so both rows land the same.
    expect(liveMonths[0]).toBeCloseTo(300, 9);
  }

  // Headcount stat is exempt: 2 whole heads; FTE flexes: 2 × 0.25 = 0.5.
  expect(mainRun.stats.headcount[0]).toBe(2);
  expect(mainRun.stats.fte[0]).toBeCloseTo(0.5, 9);
});
