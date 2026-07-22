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
import { OuScope } from "./ouScope";
import { prepared } from "./stmtCache";
import { getComponentDefinitions, getSsSchemes } from "./structureRepo";
import { loadScenarioValues } from "./positionsRepo";

type Db = InstanceType<typeof Database>;

/** Calendar lookup, injected so this module stays Electron-free (the handler
 *  passes local_db.getCalendarYear; tests pass a stub). */
export type CalendarGetter = (
  ou: string,
  year: number
) => Promise<CalendarYear | null>;

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

  // Inactive positions are retained in the store and the grid (and roll forward
  // with a scenario copy) but are not budgeted — dropping them here keeps the
  // engine a pure 12-month kernel with no notion of activation.
  const positions: Position[] = values.positions
    .filter((record) => record.active)
    .map((record): Position => ({
      id: record.id as PositionId,
      scenarioId: record.scenarioId as ScenarioId,
      departmentCode: record.departmentCode,
      jobTypeCode: record.jobTypeCode,
      cluster: record.cluster,
      payType: record.payType,
      headcount: record.headcount,
      fte: record.fte,
      seasonality: record.seasonality,
      monthlyBaseSalary: record.monthlyBaseSalary,
      additionalMonthlyCosts: record.additionalMonthlyCosts,
      meritIncreasePct: record.meritIncreasePct,
      manualYearlyIncrease: record.manualYearlyIncrease,
      increaseMonth: record.increaseMonth,
      dailyContractHours: record.dailyContractHours,
      yearlyHoursWorked: record.yearlyHoursWorked,
      vacationDays: record.vacationDays,
      dailyVacationCost: record.dailyVacationCost,
      vacationMonthlyWeights: record.vacationMonthlyWeights,
      accrualDaysPerMonth: record.accrualDaysPerMonth,
      accrualCostPerDay: record.accrualCostPerDay,
      updatedAt: record.updatedAt,
      deletedAt: null,
    }));

  const componentValues: ComponentValue[] = values.componentValues.map(
    (record): ComponentValue => ({
      positionId: record.positionId as PositionId,
      componentDefId: record.componentDefId as ComponentDefId,
      rate: record.rate ?? undefined,
      yearlyValue: record.yearlyValue ?? undefined,
      monthlyValues: record.monthlyValues ?? undefined,
      qty: record.qty ?? undefined,
      unitRate: record.unitRate ?? undefined,
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

  return {
    scenario,
    calendar,
    definitions: getComponentDefinitions(structureDb, scope),
    ssSchemes: getSsSchemes(structureDb, scope),
    positions,
    componentValues,
    buyouts,
  };
}
