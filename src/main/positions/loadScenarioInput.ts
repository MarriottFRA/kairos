/**
 * Assemble a complete engine ScenarioInput from the two stores.
 * -----------------------------------------------------------
 * Structure (scenario, definitions, schemes) comes from the plaintext DB;
 * values (positions, component values, buyouts) from the encrypted DB; the
 * calendar context from the existing calendar tables. Soft-deleted rows are
 * filtered by the repositories.
 *
 * PII is structurally unreachable from here — this module never imports the
 * PII read path, so no ScenarioInput can ever carry it.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  buildDefaultCalendar,
  CalendarYear,
  DEFAULT_WEEKEND_MASK,
} from "../../shared/calendar";
import { buildCalendarContext } from "../../shared/engine/calendarContext";
import type {
  BuyoutRow,
  BuyoutRowId,
  ComponentValue,
  ComponentDefId,
  Position,
  PositionId,
  Scenario,
  ScenarioId,
  ScenarioInput,
} from "../../shared/engine/types";
import {
  applySocialSecurityBase,
  buildBankHolidayDefinition,
  injectKpiSeries,
  resolveBlockValues,
  resolveYearlyHoursWorked,
} from "../../shared/positions/engineInput";
import { listBlocks } from "../blocks/repo";
import { listClusters } from "../hotelClusters/repo";
import {
  clusterMapById,
  resolveHotelClusterWeight,
} from "../../shared/hotelClusters/resolve";
import { OuScope } from "./ouScope";
import { prepared } from "./stmtCache";
import { getComponentDefinitions, getSsSchemes } from "./structureRepo";
import { getSeries } from "../kpiDrivers/repo";
import { loadScenarioValues } from "./positionsRepo";

type Db = InstanceType<typeof Database>;

/** Calendar lookup, injected so this module stays Electron-free (the handler
 *  passes local_db.getCalendarYear; tests pass a stub). */
export type CalendarGetter = (
  ou: string,
  year: number
) => Promise<CalendarYear | null>;

/** The accrual account (a POSITION_EXTRA key) is the on/off switch for holiday
 *  accrual generation — set means "book it", empty means "don't". */
function accrualAccountSet(extraValues: Record<string, unknown>): boolean {
  const account = extraValues.accrualAccount;
  return typeof account === "string" && account.trim() !== "";
}

// buildBankHolidayDefinition and the KPI/dual-block value resolution moved to
// src/shared/positions/engineInput.ts — one implementation shared with the
// renderer live simulation so the two can never diverge. This module keeps
// only the DB reads and feeds them in.

export async function loadScenarioInput(
  structureDb: Db,
  valuesDb: Db,
  scope: OuScope,
  scenarioId: string,
  getCalendarYear: CalendarGetter
): Promise<ScenarioInput> {
  const scenarioRow = prepared(
    structureDb,
    `SELECT id, ou, year, label, updated_at
       FROM scenarios
      WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(scenarioId, scope.ou) as
    | { id: string; ou: string; year: number; label: string; updated_at: string }
    | undefined;

  if (!scenarioRow) {
    throw new Error(`Scenario not found in this hotel: ${scenarioId}`);
  }

  const scenario: Scenario = {
    id: scenarioRow.id as ScenarioId,
    ou: scenarioRow.ou,
    year: scenarioRow.year,
    label: scenarioRow.label,
    updatedAt: scenarioRow.updated_at,
    deletedAt: null,
  };

  // An unsaved calendar falls back to the real-calendar default, matching the
  // calendar page's own behavior.
  const calendarYear =
    (await getCalendarYear(scope.ou, scenario.year)) ??
    buildDefaultCalendar(scope.ou, scenario.year, DEFAULT_WEEKEND_MASK);
  const calendar = buildCalendarContext(calendarYear);

  const values = loadScenarioValues(valuesDb, scope, scenarioId);

  // Hotel-cluster definitions (cross-OU, plaintext store). The stored value is
  // the cluster ID; the engine gets the resolved NAME (its staffing-stats
  // rollup key) and this hotel's WEIGHT. Must mirror runLiveSim exactly —
  // liveSimParity pins the two together.
  const clusterById = clusterMapById(listClusters(structureDb));

  // Inactive positions are retained in the store and the grid (and roll forward
  // with a scenario copy) but are not budgeted — dropping them here keeps the
  // engine a pure 12-month kernel with no notion of activation.
  const positions: Position[] = values.positions
    .filter((record) => record.active)
    .map((record): Position => {
      const resolved = resolveHotelClusterWeight(
        scope.ou,
        record.cluster,
        record.clusterMultiplierOverride,
        clusterById
      );
      return {
      id: record.id as PositionId,
      scenarioId: record.scenarioId as ScenarioId,
      departmentCode: record.departmentCode,
      jobTypeCode: record.jobTypeCode,
      cluster: resolved.clusterName,
      hotelClusterWeight: resolved.weight,
      payType: record.payType,
      headcount: record.headcount,
      fte: record.fte,
      seasonality: record.seasonality,
      monthlyBaseSalary: record.monthlyBaseSalary,
      hourlyRate: record.hourlyRate,
      additionalMonthlyCosts: record.additionalMonthlyCosts,
      meritIncreasePct: record.meritIncreasePct,
      manualYearlyIncrease: record.manualYearlyIncrease,
      increaseMonth: record.increaseMonth,
      dailyContractHours: record.dailyContractHours,
      // Auto-derived from the calendar (net productive days − vacation) × daily
      // hours; a positive stored value is a manual override. Shared with
      // runLiveSim via resolveYearlyHoursWorked — liveSimParity pins the two.
      yearlyHoursWorked: resolveYearlyHoursWorked(
        record.yearlyHoursWorked,
        record,
        calendar
      ),
      vacationDays: record.vacationDays,
      vacationMonthlyWeights: record.vacationMonthlyWeights,
      // Accrual is auto-calculated (Yearly Days ÷ 12) and generated only when the
      // position carries an accrual account; with none, feed 0 so the engine's
      // accrualDays===0 guard suppresses the line. Mirrors rowToEnginePosition.
      accrualDaysPerMonth: accrualAccountSet(record.extraValues)
        ? record.vacationDays / 12
        : 0,
      updatedAt: record.updatedAt,
      deletedAt: null,
      };
    });

  const componentValues: ComponentValue[] = values.componentValues.map(
    (record): ComponentValue => ({
      positionId: record.positionId as PositionId,
      componentDefId: record.componentDefId as ComponentDefId,
      rate: record.rate ?? undefined,
      yearlyValue: record.yearlyValue ?? undefined,
      monthlyValues: record.monthlyValues ?? undefined,
      qty: record.qty ?? undefined,
      unitRate: record.unitRate ?? undefined,
      ssOpeningBase: record.ssOpeningBase ?? undefined,
      accountCode: record.accountCode ?? undefined,
      statsAccountCode: record.statsAccountCode ?? undefined,
      updatedAt: record.updatedAt,
      deletedAt: null,
    })
  );

  const buyouts: BuyoutRow[] = values.buyouts.map((record): BuyoutRow => ({
    id: record.id as BuyoutRowId,
    scenarioId: record.scenarioId as ScenarioId,
    departmentCode: record.departmentCode,
    accountCode: record.accountCode,
    monthlyValues: record.monthlyValues,
    updatedAt: record.updatedAt,
    deletedAt: null,
  }));

  // The user's components, plus the synthetic bank-holiday premium when the
  // calendar has it switched on (see buildBankHolidayDefinition).
  const definitions = [...getComponentDefinitions(structureDb, scope)];
  const bankHolidayDef = buildBankHolidayDefinition(scope.ou, calendarYear);
  if (bankHolidayDef) definitions.push(bankHolidayDef);

  // Fill each NI scheme's contributory base from its own base membership
  // (mirror of runLiveSim — liveSimParity pins the two).
  const blocks = listBlocks(structureDb, scope);
  const ssSchemes = getSsSchemes(structureDb, scope);
  applySocialSecurityBase(definitions, ssSchemes);

  // Resolve KPI-driven blocks to absolute monthly values (the KPI precalc cache
  // lives in the same plaintext store as the structure). Positions carry the
  // per-position multiplier as ComponentValue.rate. Then synthesize the
  // yearly slots dual "Count × Rate" blocks read (shared resolution).
  injectKpiSeries(definitions, positions, componentValues, (driverId) =>
    getSeries(structureDb, scope.ou, driverId)
  );
  const resolvedValues = resolveBlockValues(
    definitions,
    componentValues,
    blocks.map((block) => ({
      costDefId: block.costDefId,
      accountLocked: block.accountLocked,
      statsAccountLocked: block.statsAccountLocked,
    }))
  );

  return {
    scenario,
    calendar,
    definitions,
    ssSchemes,
    positions,
    componentValues: resolvedValues,
    buyouts,
  };
}
