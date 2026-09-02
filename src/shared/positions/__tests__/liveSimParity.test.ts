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
  weekdayCounts,
} from "../../calendar";
import {
  buildDefaultPositionDefaults,
  fullTimeReference,
  resolvePositionDefaults,
} from "../../positionDefaults";
import { compile, simulate } from "../../engine/simulate";
import { PositionId } from "../../engine/types";
import { applyStructureColumns } from "../../../main/blocks/schema";
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
  saveFieldCatalog,
  saveScenario,
} from "../../../main/positions/structureRepo";
import {
  batchWrite,
  getPii,
  loadScenarioValues,
} from "../../../main/positions/positionsRepo";
import { loadScenarioInput } from "../../../main/positions/loadScenarioInput";
import { applyComponentValuesToRow } from "../blockRows";
import { buildFieldMap, toRow } from "../rowModel";
import { createLiveSimCache, runLiveSim } from "../liveSim";

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

/** A seasonal KPI for the rules-condition leg: above 80 for the first half of
 *  the year, below it after — so a "KPI ≥ 80" rule flips mid-year. */
const OCC_DRIVER = "kpi-occupancy";
const OCC_SERIES = [90, 90, 90, 90, 90, 90, 40, 40, 40, 40, 40, 40];

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
    insert.run(OCC_DRIVER, SCOPE.ou, period, OCC_SERIES[period - 1], NOW.now);
  }
}

/** The renderer's own copy of the cached series — shared by every runLiveSim
 *  call in this file so the two paths always read the same numbers. */
function rendererKpiSeries(driverId: string) {
  if (driverId === GRAT_DRIVER) return [{ deptKey: "*", values: GRAT_SERIES }];
  if (driverId === OCC_DRIVER) return [{ deptKey: "*", values: OCC_SERIES }];
  return [];
}

let structureDb: Db;
let valuesDb: Db;
let scenarioId: string;

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(structureDb);
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
  // Lands in chosen months (the 13th-month shape). May is chosen on purpose:
  // pos-1 is dark in May, so its whole figure must shift to December, while
  // full-year pos-2 splits May/December evenly — the compile-time weight gate
  // has to agree between the two paths per position, not just per block.
  const multCollapseId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "MULTIPLIER", label: "Thirteenth Salary", accountCode: "519500",
      accountLocked: true, base: { kind: "BASE_SALARY" }, collapseMonths: [5, 12],
    },
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
  // Both length-of-service bases. pos-1 is a long-serving hire (a prior-years
  // carry-in) and pos-2 was hired mid-year, so the partial-month and the
  // carry-in legs are both live on this parity run.
  const multServiceId = saveBlock(
    structureDb, SCOPE,
    { blockType: "MULTIPLIER", label: "Service Day Accrual", accountCode: "516500", accountLocked: true, base: { kind: "SERVICE", mode: "MONTH" } },
    NOW
  );
  const multServiceTotalId = saveBlock(
    structureDb, SCOPE,
    { blockType: "MULTIPLIER", label: "Indemnity Liability", accountCode: "516600", accountLocked: true, base: { kind: "SERVICE", mode: "TOTAL" } },
    NOW
  );
  const multVacId = saveBlock(
    structureDb, SCOPE,
    { blockType: "MULTIPLIER", label: "Vacation Levy", accountCode: "", accountLocked: true, base: { kind: "VACATION" } },
    NOW
  );
  // Rules-driven multipliers — nothing stored per row for either, so the rate
  // only lands if BOTH paths derive it from the block config (applyRateRules):
  // one keyed on a USER field, one on days-in-position. pos-2 was hired
  // mid-plan-year and crosses 100 days of service inside it, so the
  // monthlyRates → PCT_OF_ACC_M leg runs on this parity fixture too.
  const bandKey = saveFieldCatalog(structureDb, SCOPE, [
    {
      create: {
        section: "employee", dataType: "TEXT", defaultLabel: "Band",
        storage: "POSITION_EXTRA",
      },
    },
  ]).fields.find((field) => field.defaultLabel === "Band")!.key;
  const ruleBandId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "MULTIPLIER", label: "Banded Bonus", accountCode: "516700",
      accountLocked: true, base: { kind: "BASE_SALARY" },
      rateRules: {
        rules: [
          {
            when: [
              { source: { kind: "FIELD", fieldKey: bandKey, dataType: "TEXT" }, op: "EQ", value: "blue" },
            ],
            rate: 0.1,
          },
        ],
        otherwise: 0.04,
      },
    },
    NOW
  );
  const ruleTenureId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "MULTIPLIER", label: "Tiered Indemnity", accountCode: "516800",
      accountLocked: true, base: { kind: "SERVICE", mode: "MONTH" },
      rateRules: {
        rules: [
          { when: [{ source: { kind: "DAYS_IN_POSITION" }, op: "LTE", value: 100 }], rate: 21 / 365 },
        ],
        otherwise: 30 / 365,
      },
    },
    NOW
  );
  // KPI condition: the occupancy series crosses 80 mid-year, so this rate
  // steps DOWN in July on every row — the KPI leg of the monthly path.
  const ruleKpiId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "MULTIPLIER", label: "High-Season Premium", accountCode: "516900",
      accountLocked: true, base: { kind: "BASE_SALARY" },
      rateRules: {
        rules: [
          {
            when: [{ source: { kind: "KPI", kpiDriverId: OCC_DRIVER }, op: "GTE", value: 80 }],
            rate: 0.05,
          },
        ],
        otherwise: 0.01,
      },
    },
    NOW
  );
  // PII condition: hiring date (PII_CORE, DATE) — pos-1 was hired years ago
  // and matches, pos-2 mid-plan-year and does not. The PII values reach the
  // rules through the merged bag on the main path and the row on the live one;
  // only the derived rate enters the engine on either.
  const rulePiiId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "MULTIPLIER", label: "Long-Service Bonus", accountCode: "517100",
      accountLocked: true, base: { kind: "BASE_SALARY" },
      rateRules: {
        rules: [
          {
            when: [
              {
                source: { kind: "FIELD", fieldKey: "hiringDate", dataType: "DATE" },
                op: "LT",
                value: "2025-01-01",
              },
            ],
            rate: 0.07,
          },
        ],
        otherwise: 0.03,
      },
    },
    NOW
  );
  // Block-valued multiplier: banded rows multiply pay days by the Uniforms
  // block's own monthly value; everyone else takes a plain number. Also the
  // topo edge — Uniforms must compute before this line on both paths.
  const ruleBlockOutId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "MULTIPLIER", label: "Uniform-Scaled Levy", accountCode: "517200",
      accountLocked: true, base: { kind: "CALENDAR", series: "PAY_DAYS" },
      rateRules: {
        rules: [
          {
            when: [
              { source: { kind: "FIELD", fieldKey: bandKey, dataType: "TEXT" }, op: "EQ", value: "blue" },
            ],
            rate: 0,
            rateBlockId: flatId,
          },
        ],
        otherwise: 0.02,
      },
    },
    NOW
  );
  // "Each row picks" its department: the override moves the aggregation key
  // only, so both paths must still produce identical line VALUES.
  const multPerRowId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "MULTIPLIER", label: "Shared Services Levy", accountCode: "519000",
      accountLocked: true, base: { kind: "BASE_SALARY" }, departmentMode: "PER_ROW",
    },
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
  // Weekday cadence on both spread-consuming types: a fixed block booked every
  // Friday and a count×rate booked Mon+Fri. The mask travels def column →
  // loader on the main path and block config → live defs on the renderer one,
  // so a divergence in either pipe fails the bit-parity below.
  const flatWeekdayId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "FLAT_MONTHLY", label: "Live Music", accountCode: "628970",
      accountLocked: true, spread: "WEEKDAYS", weekdayMask: 1 << 5, increaseAware: true,
    },
    NOW
  );
  const countWeekdayId = saveBlock(
    structureDb, SCOPE,
    {
      blockType: "COUNT_RATE", label: "Weekly Deep Clean", accountCode: "628980",
      accountLocked: true, statsAccountCode: "988300", statsAccountLocked: true,
      spread: "WEEKDAYS", weekdayMask: (1 << 1) | (1 << 5),
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
      // Managers draw one-and-a-half shares of the pot. Nothing is stored per
      // row for it, so the weight only lands if BOTH sides read it off the
      // block config — which is exactly what this test is for.
      poolJobTypeWeights: { Manager: 1.5 },
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
            departmentCode: "0410", jobTypeCode: "Manager", cluster: "Rooms",
            // The rules block's IF matches this row ("blue" → 0.10); pos-2 has
            // no band at all and falls through to the otherwise rate.
            [bandKey]: "blue",
            payType: "SALARIED", headcount: 2, monthlyBaseSalary: 3200,
            seasonality: [1, 1, 1, 0.5, 0, 1, 1, 1, 1, 1, 1, 1],
            vacationMonthlyWeights: [0, 0, 0.5, 0, 0, 0.25, 0, 0, 0.25, 0, 0, 0],
            // Contract days feed the derived FTE, which the FTE-based pooled
            // block below spreads over — a row without them is 0 FTE and gets
            // no share.
            ...FULL_TIME_CONTRACT,
            vacationDays: 21, yearlyHoursWorked: 1900,
            meritIncreasePct: 0.06, increaseMonth: 7,
            salaryAccountCode: "A511000",
            workingHoursAccount: "A972200", accrualAccount: "A512000",
            benefitsAccountCode: "A513000",
          },
        },
        {
          id: "pos-2",
          fields: {
            departmentCode: "1310", jobTypeCode: "Associate", cluster: "F&B",
            payType: "HOURLY", headcount: 1, hourlyRate: 21.5,
            seasonality: new Array(12).fill(1),
            vacationMonthlyWeights: new Array(12).fill(1 / 12),
            ...FULL_TIME_CONTRACT,
            vacationDays: 14, yearlyHoursWorked: 1700,
          },
        },
      ],
      // Hiring dates live on position_pii, not the positions table. pos-1 is a
      // long-serving hire (a prior-years carry-in), pos-2 was hired mid-plan-year
      // (a partial month) — both legs of the SERVICE bases are exercised.
      piiPatches: [
        { positionId: "pos-1", fields: { hiringDate: "2019-06-01" } },
        { positionId: "pos-2", fields: { hiringDate: `${YEAR}-03-15` } },
      ],
      componentValuePatches: [
        { positionId: "pos-1", componentDefId: `${flatId}:cost`, fields: { yearlyValue: 120 } },
        { positionId: "pos-1", componentDefId: `${multSalaryId}:cost`, fields: { rate: 0.05 } },
        { positionId: "pos-1", componentDefId: `${multCollapseId}:cost`, fields: { rate: 1 / 12 } },
        { positionId: "pos-2", componentDefId: `${multCollapseId}:cost`, fields: { rate: 1 / 12 } },
        { positionId: "pos-1", componentDefId: `${multBlockId}:cost`, fields: { rate: 1.5 } },
        { positionId: "pos-1", componentDefId: `${multHoursId}:cost`, fields: { rate: 0.75 } },
        { positionId: "pos-1", componentDefId: `${multDaysId}:cost`, fields: { rate: 12.25 } },
        { positionId: "pos-1", componentDefId: `${multVacId}:cost`, fields: { rate: 0.2 } },
        { positionId: "pos-1", componentDefId: `${multServiceId}:cost`, fields: { rate: 3.75 } },
        { positionId: "pos-1", componentDefId: `${multServiceTotalId}:cost`, fields: { rate: 0.0125 } },
        { positionId: "pos-2", componentDefId: `${multServiceId}:cost`, fields: { rate: 2.5 } },
        { positionId: "pos-2", componentDefId: `${multServiceTotalId}:cost`, fields: { rate: 0.004 } },
        // Per-row department override on pos-1; pos-2 leaves it blank and falls
        // back to its own department.
        {
          positionId: "pos-1",
          componentDefId: `${multPerRowId}:cost`,
          fields: { rate: 0.03, departmentCode: "1910" },
        },
        { positionId: "pos-2", componentDefId: `${multPerRowId}:cost`, fields: { rate: 0.03 } },
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
        // Per-occurrence weekday values: pos-1 is seasonal (dark May) so the
        // seasonality gate on the occurrence counts is live on this run too.
        { positionId: "pos-1", componentDefId: `${flatWeekdayId}:cost`, fields: { yearlyValue: 250 } },
        { positionId: "pos-2", componentDefId: `${countWeekdayId}:cost`, fields: { qty: 3, unitRate: 45 } },
        // The pool share weight rides the rate slot: pos-2 takes a double share
        // of the service charge, pos-1 is deliberately out (no row at all).
        { positionId: "pos-2", componentDefId: `${poolManualId}:cost`, fields: { rate: 2 } },
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
  // The renderer holds PII (it displays names), and the SERVICE bases derive
  // length of service from the hiring date — so the row must carry it or the
  // live sim would silently read a blank date while the loader reads the real
  // one. Passing it here is what makes that divergence a test failure.
  const pii = getPii(valuesDb, SCOPE, scenarioId);
  const rows = loaded.positions.map((record) =>
    applyComponentValuesToRow(
      toRow(record, pii[record.id]),
      valuesByPosition.get(record.id),
      blocks
    )
  );

  const live = runLiveSim({
    rows,
    blocks,
    definitions: getComponentDefinitions(structureDb, SCOPE),
    ssSchemes: getSsSchemes(structureDb, SCOPE),
    calendarYear: CALENDAR,
    // The renderer's own copy of the cached series — same numbers the loader
    // reads out of kpi_driver_values, which is what parity is testing.
    kpiSeries: rendererKpiSeries,
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
  // 21 blocks + 2 dual stat lines, × 2 positions.
  expect(comparedLines).toBe(46);

  // Teeth for the weekday blocks — two identical zero lines would also
  // "match". pos-1's Friday fixture books amount × Friday-count in January
  // (pre-increase, fully active) and nothing in its dark May; pos-2's Mon+Fri
  // dual books qty × rate × count on the cost line and qty × count on the
  // stat one.
  const fridayCounts = weekdayCounts(YEAR, 1 << 5);
  const monFriCounts = weekdayCounts(YEAR, (1 << 1) | (1 << 5));
  const music1 = live.results.get("pos-1")!.get(`${flatWeekdayId}:cost`)!.months;
  // × 2: pos-1 counts two heads, and the engine books every line headcount
  // times over.
  expect(music1[0]).toBeCloseTo(2 * 250 * fridayCounts[0], 9);
  expect(music1[4]).toBe(0);
  const clean2 = live.results.get("pos-2")!.get(`${countWeekdayId}:cost`)!.months;
  const clean2Stat = live.results.get("pos-2")!.get(`${countWeekdayId}:stat`)!.months;
  expect(clean2[0]).toBeCloseTo(3 * 45 * monFriCounts[0], 9);
  expect(clean2Stat[0]).toBeCloseTo(3 * monFriCounts[0], 9);

  // Teeth for the rules blocks — two identical ZERO lines would also "match",
  // so pin that the derived rates actually landed on both paths. pos-1 wears
  // band "blue" (0.10 of salary); pos-2 has no band and takes the otherwise
  // rate, so its bonus is smaller relative to pay but still non-zero.
  const bonusLine = live.results.get("pos-1")!.get(`${ruleBandId}:cost`)!;
  expect(bonusLine.total).toBeGreaterThan(0);
  expect(live.results.get("pos-2")!.get(`${ruleBandId}:cost`)!.total).toBeGreaterThan(0);
  // pos-2 (hired 15 Mar) crosses 100 days of service in June, so the tiered
  // indemnity rate must STEP UP mid-year: May (31 days × 21/365) < July
  // (31 days × 30/365). This is the PCT_OF_ACC_M leg working end to end.
  const tenureMonths = live.results.get("pos-2")!.get(`${ruleTenureId}:cost`)!.months;
  expect(tenureMonths[4]).toBeGreaterThan(0);
  expect(tenureMonths[6]).toBeGreaterThan(tenureMonths[4]);
  // The KPI condition steps DOWN when occupancy falls below 80 in July —
  // 0.05 × salary in June vs 0.01 × salary in July (both full months).
  const kpiMonths = live.results.get("pos-2")!.get(`${ruleKpiId}:cost`)!.months;
  expect(kpiMonths[6]).toBeGreaterThan(0);
  expect(kpiMonths[5]).toBeGreaterThan(kpiMonths[6]);
  // The PII (hiring date) condition matches only the long-serving pos-1.
  expect(live.results.get("pos-1")!.get(`${rulePiiId}:cost`)!.total).toBeGreaterThan(0);
  expect(live.results.get("pos-2")!.get(`${rulePiiId}:cost`)!.total).toBeGreaterThan(0);
  // The block-valued multiplier: pos-1 (band blue) multiplies pay days by the
  // Uniforms block's line; pos-2 takes the plain 0.02 number. Both non-zero,
  // and pos-1's January figure is exactly payDays × Uniforms' January value.
  const scaled1 = live.results.get("pos-1")!.get(`${ruleBlockOutId}:cost`)!;
  const uniforms1 = live.results.get("pos-1")!.get(`${flatId}:cost`)!;
  expect(scaled1.total).toBeGreaterThan(0);
  expect(uniforms1.months[0]).toBeGreaterThan(0);
  expect(live.results.get("pos-2")!.get(`${ruleBlockOutId}:cost`)!.total).toBeGreaterThan(0);
  // Teeth for the collapse block — two identical all-zero lines would also
  // "match". pos-1 is dark in May, so December carries its whole (non-zero)
  // figure and May books nothing; full-year pos-2 splits May/December evenly
  // and books nothing anywhere else.
  const collapse1 = live.results.get("pos-1")!.get(`${multCollapseId}:cost`)!.months;
  expect(collapse1[4]).toBe(0);
  expect(collapse1[11]).toBeGreaterThan(0);
  expect(collapse1.filter((v) => v !== 0)).toHaveLength(1);
  const collapse2 = live.results.get("pos-2")!.get(`${multCollapseId}:cost`)!.months;
  expect(collapse2[4]).toBeGreaterThan(0);
  expect(collapse2[4]).toBeCloseTo(collapse2[11], 9);
  expect(collapse2.filter((v) => v !== 0)).toHaveLength(2);

  // ── The structure cache must not change a single number ──
  // Same call, twice, through a cache: the first run compiles and fills it, the
  // second reuses the compiled structure and repacks only the values. Run on
  // THIS fixture rather than a synthetic one because it is the one carrying
  // every block type, a per-row account override, a dual stat line and a KPI
  // series — the shapes most likely to be mis-cached.
  const cache = createLiveSimCache();
  const cachedArgs = {
    rows,
    blocks,
    definitions: getComponentDefinitions(structureDb, SCOPE),
    ssSchemes: getSsSchemes(structureDb, SCOPE),
    calendarYear: CALENDAR,
    kpiSeries: rendererKpiSeries,
    scenarioId,
    ou: SCOPE.ou,
    fullTime: FULL_TIME,
    cache,
  };
  const firstRun = runLiveSim(cachedArgs);
  expect(firstRun.timings?.structureReused).toBe(false);
  const secondRun = runLiveSim(cachedArgs);
  expect(secondRun.timings?.structureReused, "second run should reuse the structure").toBe(
    true
  );

  for (const positionId of ["pos-1", "pos-2"]) {
    const uncached = live.results.get(positionId)!;
    const reused = secondRun.results.get(positionId)!;
    expect(reused.size).toBe(uncached.size);
    for (const defId of blockDefIds) {
      expect(
        Array.from(reused.get(defId)!.months),
        `cached line ${positionId} ${defId}`
      ).toEqual(Array.from(uncached.get(defId)!.months));
    }
  }

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
  // pos-2 counts 1), weighted 1.5× because pos-1 is a manager, and gated by
  // working months. The whole pot always lands.
  const gratOne = live.results.get("pos-1")!.get(`${poolKpiId}:cost`)!;
  const gratTwo = live.results.get("pos-2")!.get(`${poolKpiId}:cost`)!;
  expect(gratOne.months[0]).toBeCloseTo(900, 9); // Jan: 1200 × 3/4 (2 × 1.5)
  expect(gratTwo.months[0]).toBeCloseTo(300, 9); // Jan: 1200 × 1/4
  expect(gratOne.months[3]).toBeCloseTo(720, 9); // Apr: pos-1 half-active → 1.5/2.5
  expect(gratOne.months[4]).toBe(0); // May: pos-1 dark…
  expect(gratTwo.months[4]).toBeCloseTo(1200, 9); // …so pos-2 takes it all
  for (let m = 0; m < 12; m++) {
    expect(gratOne.months[m] + gratTwo.months[m]).toBeCloseTo(1200, 9);
  }
  // Merit does not touch a share of a fixed pot (contrast Uniforms above).
  expect(gratOne.months[7] + gratTwo.months[7]).toBeCloseTo(1200, 9);

  // The manual pool: only pos-2 carries a share weight, so it takes the whole
  // 600 and pos-1 books nothing despite being the bigger row.
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
            departmentCode: "0410", jobTypeCode: "Manager", cluster: clusterId,
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
            departmentCode: "0410", jobTypeCode: "Manager", cluster: clusterId,
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
  // The renderer holds PII (it displays names), and the SERVICE bases derive
  // length of service from the hiring date — so the row must carry it or the
  // live sim would silently read a blank date while the loader reads the real
  // one. Passing it here is what makes that divergence a test failure.
  const pii = getPii(valuesDb, SCOPE, scenarioId);
  const rows = loaded.positions.map((record) =>
    applyComponentValuesToRow(
      toRow(record, pii[record.id]),
      valuesByPosition.get(record.id),
      blocks
    )
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
