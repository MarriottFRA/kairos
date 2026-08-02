/**
 * Test fixtures: deterministic builders for scenario inputs, a "standard"
 * component set mirroring the legacy workbook, and a seeded RNG for the
 * randomized parity tests. Ids are stable strings (not uuidv7) so failures
 * are reproducible and readable.
 */

import { makeCalendarContext } from "../calendarContext";
import {
  BuyoutRow,
  BuyoutRowId,
  CalendarContext,
  ComponentDefId,
  ComponentValue,
  CostComponentDefinition,
  MONTHS,
  Position,
  PositionId,
  Scenario,
  ScenarioId,
  ScenarioInput,
  SocialSecurityScheme,
  SsSchemeId,
} from "../types";

export const SCENARIO_ID = "scn-1" as ScenarioId;

export function defId(id: string): ComponentDefId {
  return id as ComponentDefId;
}
export function posId(id: string): PositionId {
  return id as PositionId;
}

const SYNC: { updatedAt: string; deletedAt: string | null } = {
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
};

export function makeScenario(): Scenario {
  return { id: SCENARIO_ID, ou: "0410", year: 2027, label: "Budget 2027", ...SYNC };
}

/** Flat 20 productive days per month unless overridden — keeps math hand-checkable.
 *  `holidayDays` defaults to zero (no bank-holiday cost). */
export function makeCalendar(realDays?: number[], holidayDays?: number[]): CalendarContext {
  return makeCalendarContext(realDays ?? new Array(MONTHS).fill(20), holidayDays);
}

/** Builder override shape: everything optional except a plain-string id. */
type WithId<T> = Omit<Partial<T>, "id"> & { id: string };

export function makeDef(overrides: WithId<CostComponentDefinition>): CostComponentDefinition {
  return {
    ou: "0410",
    kind: "SPREAD",
    label: overrides.id,
    accountCode: "600000",
    departmentMode: "POSITION",
    increaseAware: false,
    sortOrder: 0,
    ...SYNC,
    ...overrides,
    id: defId(overrides.id),
  };
}

export function makePosition(overrides: WithId<Position>): Position {
  return {
    scenarioId: SCENARIO_ID,
    departmentCode: "1010",
    jobTypeCode: "Associate Hourly Pay",
    cluster: "Rooms",
    hotelClusterWeight: 1,
    payType: "SALARIED",
    headcount: 1,
    fte: 1,
    seasonality: new Array(MONTHS).fill(1),
    monthlyBaseSalary: 1200,
    hourlyRate: 0,
    additionalMonthlyCosts: new Array(MONTHS).fill(0),
    meritIncreasePct: 0,
    manualYearlyIncrease: 0,
    increaseMonth: 13,
    dailyContractHours: 8,
    yearlyHoursWorked: 1800,
    vacationDays: 0,
    vacationMonthlyWeights: new Array(MONTHS).fill(1 / 12),
    accrualDaysPerMonth: 0,
    ...SYNC,
    ...overrides,
    id: posId(overrides.id),
  };
}

export function makeValue(
  positionId: string,
  componentDefId: string,
  fields: Partial<ComponentValue>
): ComponentValue {
  return {
    positionId: posId(positionId),
    componentDefId: defId(componentDefId),
    ...SYNC,
    ...fields,
  };
}

export function makeBuyout(
  id: string,
  departmentCode: string,
  accountCode: string,
  monthlyValues: number[]
): BuyoutRow {
  return {
    id: id as BuyoutRowId,
    scenarioId: SCENARIO_ID,
    departmentCode,
    accountCode,
    monthlyValues,
    ...SYNC,
  };
}

export function makeScheme(overrides: WithId<SocialSecurityScheme>): SocialSecurityScheme {
  return {
    label: overrides.id,
    monthlyCap: null,
    yearlyCap: null,
    brackets: [{ upTo: null, rate: 0.1 }],
    ...SYNC,
    ...overrides,
    id: overrides.id as SsSchemeId,
  };
}

export function makeInput(parts: {
  definitions: CostComponentDefinition[];
  positions: Position[];
  ssSchemes?: SocialSecurityScheme[];
  componentValues?: ComponentValue[];
  buyouts?: BuyoutRow[];
  calendar?: CalendarContext;
}): ScenarioInput {
  return {
    scenario: makeScenario(),
    calendar: parts.calendar ?? makeCalendar(),
    definitions: parts.definitions,
    ssSchemes: parts.ssSchemes ?? [],
    positions: parts.positions,
    componentValues: parts.componentValues ?? [],
    buyouts: parts.buyouts ?? [],
  };
}

// ---------------------------------------------------------------------------
// Standard component set — one of each lego, mirroring the workbook sections
// ---------------------------------------------------------------------------

export function standardScheme(): SocialSecurityScheme {
  return makeScheme({
    id: "sch-std",
    brackets: [
      { upTo: 6000, rate: 0.1 },
      { upTo: null, rate: 0.05 },
    ],
  });
}

export function standardDefinitions(): CostComponentDefinition[] {
  return [
    makeDef({ id: "def-base", kind: "BASE_SALARY", label: "Base Salary", accountCode: "610000", sortOrder: 0 }),
    makeDef({ id: "def-accrual", kind: "HOLIDAY_ACCRUAL", label: "Holiday Accrual", accountCode: "611000", sortOrder: 1 }),
    makeDef({
      id: "def-bankhol",
      kind: "BANK_HOLIDAY",
      label: "Bank Holiday Premium",
      accountCode: "612000",
      sortOrder: 12,
      increaseAware: true,
      bankHolidayStaffFraction: 0.5,
      bankHolidayPremiumMultiplier: 2,
    }),
    makeDef({ id: "def-pension", spreadMethod: "PERCENT_OF", label: "Pension", accountCode: "620000", sortOrder: 2 }),
    makeDef({ id: "def-indemnity", spreadMethod: "WEIGHTED_BY_BASE", label: "Indemnity", accountCode: "621000", sortOrder: 3 }),
    makeDef({ id: "def-housing", spreadMethod: "FLAT_PER_ACTIVE_MONTH", label: "Housing", accountCode: "622000", sortOrder: 4 }),
    makeDef({ id: "def-transport", spreadMethod: "FLAT_PER_DAY", label: "Transportation", accountCode: "623000", sortOrder: 5 }),
    makeDef({ id: "def-custom", spreadMethod: "DIRECT_MONTHLY", label: "Custom Monthly", accountCode: "624000", sortOrder: 6 }),
    makeDef({ id: "def-overtime", spreadMethod: "QTY_TIMES_RATE", label: "Overtime", accountCode: "625000", sortOrder: 7 }),
    makeDef({
      id: "def-ss",
      kind: "SOCIAL_SECURITY",
      label: "Social Security",
      accountCode: "630000",
      sortOrder: 8,
      ssSchemeId: "sch-std" as SsSchemeId,
      baseSelector: {
        kind: "COMPONENTS",
        componentIds: [defId("def-base"), defId("def-pension"), defId("def-overtime")],
      },
    }),
    makeDef({ id: "def-hc", kind: "STAT", statKind: "HEADCOUNT", label: "Headcount", accountCode: "972000", sortOrder: 9 }),
    makeDef({ id: "def-fte", kind: "STAT", statKind: "FTE", label: "FTE", accountCode: "972540", sortOrder: 10 }),
    makeDef({ id: "def-hours", kind: "STAT", statKind: "HOURS", label: "Hours Worked", accountCode: "971000", sortOrder: 11 }),
    // Blocks-feature shapes: the FLAT_MONTHLY / VACATION_WEIGHTED methods and
    // the CALENDAR / VACATION / STAT-line base selectors.
    makeDef({ id: "def-flatmonthly", spreadMethod: "FLAT_MONTHLY", label: "Uniforms", accountCode: "626000", sortOrder: 13, increaseAware: true }),
    makeDef({ id: "def-vacweighted", spreadMethod: "VACATION_WEIGHTED", label: "Vacation Bonus", accountCode: "627000", sortOrder: 14 }),
    makeDef({
      id: "def-multdays",
      spreadMethod: "PERCENT_OF",
      label: "Per Pay-Day Levy",
      accountCode: "628000",
      sortOrder: 15,
      baseSelector: { kind: "CALENDAR", series: "PAY_DAYS" },
    }),
    makeDef({
      id: "def-multrealdays",
      spreadMethod: "PERCENT_OF",
      label: "Per Real-Day Levy",
      accountCode: "628100",
      sortOrder: 16,
      baseSelector: { kind: "CALENDAR", series: "REAL_DAYS" },
    }),
    makeDef({
      id: "def-multholdays",
      spreadMethod: "PERCENT_OF",
      label: "Per Public-Holiday Levy",
      accountCode: "628150",
      sortOrder: 16.5,
      baseSelector: { kind: "CALENDAR", series: "HOLIDAY_DAYS" },
    }),
    makeDef({
      id: "def-multvac",
      spreadMethod: "PERCENT_OF",
      label: "Vacation Levy",
      accountCode: "628200",
      sortOrder: 17,
      baseSelector: { kind: "VACATION" },
    }),
    makeDef({
      id: "def-multhours",
      spreadMethod: "PERCENT_OF",
      label: "Hours Levy",
      accountCode: "628300",
      sortOrder: 18,
      baseSelector: { kind: "COMPONENTS", componentIds: [defId("def-hours")] },
    }),
    makeDef({
      id: "def-hourspaid",
      kind: "STAT",
      statKind: "HOURS_PAID",
      label: "Hours Paid",
      accountCode: "971100",
      sortOrder: 19,
    }),
    // Compound (COMBINE) bases — one per operation, so the parity fuzzer covers
    // every branch of COMBINE_ACC against reference.resolveBase.
    makeDef({
      id: "def-combadd",
      spreadMethod: "PERCENT_OF",
      label: "Salary Plus Housing Levy",
      accountCode: "629000",
      sortOrder: 20,
      baseSelector: {
        kind: "COMBINE",
        op: "ADD",
        left: { kind: "BASE_SALARY" },
        right: { kind: "COMPONENTS", componentIds: [defId("def-housing")] },
      },
    }),
    makeDef({
      id: "def-combsub",
      spreadMethod: "PERCENT_OF",
      label: "Salary Less Vacation Levy",
      accountCode: "629100",
      sortOrder: 21,
      baseSelector: {
        kind: "COMBINE",
        op: "SUB",
        left: { kind: "BASE_SALARY" },
        right: { kind: "VACATION" },
      },
    }),
    makeDef({
      id: "def-combmul",
      spreadMethod: "PERCENT_OF",
      label: "Days By Hours Levy",
      accountCode: "629200",
      sortOrder: 22,
      baseSelector: {
        kind: "COMBINE",
        op: "MUL",
        left: { kind: "CALENDAR", series: "PAY_DAYS" },
        right: { kind: "COMPONENTS", componentIds: [defId("def-hours")] },
      },
    }),
    // The ratio case: cost ÷ hours, and therefore countExempt — a per-person
    // figure that must NOT be multiplied by headcount. Exercises both the DIV
    // branch and the post-pass exemption in the parity suite.
    makeDef({
      id: "def-costperhour",
      spreadMethod: "PERCENT_OF",
      label: "Cost Per Hour",
      accountCode: "629300",
      sortOrder: 23,
      countExempt: true,
      baseSelector: {
        kind: "COMBINE",
        op: "DIV",
        left: { kind: "BASE_SALARY" },
        right: { kind: "COMPONENTS", componentIds: [defId("def-hours")] },
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Seeded RNG + randomized scenario generator (for parity/invariant tests)
// ---------------------------------------------------------------------------

/** mulberry32 — deterministic, good-enough PRNG for test data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomScenario(seed: number, positionCount: number): ScenarioInput {
  const rand = rng(seed);
  const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const definitions = standardDefinitions();

  // Vary the bank-holiday knobs per seed so parity covers every branch of
  // bankHolidayCoefficient — hourly vs salaried eligibility, the paid-when-off
  // leg, and a department override sitting alongside the hotel-wide fraction.
  const bankHoliday = definitions.find((def) => def.kind === "BANK_HOLIDAY");
  if (bankHoliday) {
    bankHoliday.bankHolidayAppliesTo = rand() < 0.5 ? "ALL" : "HOURLY";
    bankHoliday.bankHolidayPaidWhenNotWorked = rand() < 0.5;
    bankHoliday.bankHolidayCoverageByDepartment = {
      "1310": Math.round(rand() * 100) / 100,
    };
  }
  const positions: Position[] = [];
  const componentValues: ComponentValue[] = [];

  for (let i = 0; i < positionCount; i++) {
    const id = `pos-${String(i).padStart(4, "0")}`;
    const seasonality = Array.from({ length: MONTHS }, () =>
      rand() < 0.25 ? 0 : Math.round(rand() * 100) / 100
    );
    if (!seasonality.some((s) => s !== 0)) seasonality[5] = 1; // keep at least one active month
    const weights = Array.from({ length: MONTHS }, () => Math.round(rand() * 100) / 100);
    // ~30% of positions drive their base from an hourly rate instead of a fixed
    // monthly amount (the two inputs are mutually exclusive), so the parity /
    // invariant / emission / disassemble suites cover the BASE_SALARY_HOURLY op.
    const hourly = rand() < 0.3;

    positions.push(
      makePosition({
        id,
        departmentCode: pick(["1010", "1310", "1910"]),
        jobTypeCode: pick(["Associate Hourly Pay", "Manager Salaried Pay", "Casual Hourly Pay"]),
        cluster: pick(["Rooms", "F&B", "Admin"]),
        // ~30% carry a hotel-cluster share < 1 so the parity / invariant
        // suites cover the weight leg of the count-multiplier pass.
        hotelClusterWeight: rand() < 0.3 ? pick([0.25, 0.5, 0.75]) : 1,
        payType: pick(["HOURLY", "SALARIED"]),
        headcount: 1 + Math.floor(rand() * 3),
        fte: Math.round(rand() * 200) / 100,
        seasonality,
        monthlyBaseSalary: hourly ? 0 : Math.round(rand() * 5000 * 100) / 100,
        hourlyRate: hourly ? Math.round(rand() * 50 * 100) / 100 : 0,
        additionalMonthlyCosts: Array.from({ length: MONTHS }, () =>
          rand() < 0.8 ? 0 : Math.round(rand() * 500 * 100) / 100
        ),
        meritIncreasePct: rand() < 0.5 ? 0 : Math.round(rand() * 15 * 100) / 10000,
        manualYearlyIncrease: rand() < 0.5 ? 0 : Math.round(rand() * 1200 * 100) / 100,
        increaseMonth: 1 + Math.floor(rand() * 13),
        dailyContractHours: 8,
        yearlyHoursWorked: Math.round(rand() * 2000),
        vacationDays: Math.floor(rand() * 30),
        vacationMonthlyWeights: weights,
        accrualDaysPerMonth: rand() < 0.4 ? 0 : Math.round(rand() * 3 * 100) / 100,
      })
    );

    componentValues.push(
      makeValue(id, "def-pension", { rate: Math.round(rand() * 20 * 100) / 10000 }),
      makeValue(id, "def-indemnity", { yearlyValue: Math.round(rand() * 3000 * 100) / 100 }),
      makeValue(id, "def-housing", { yearlyValue: Math.round(rand() * 12000 * 100) / 100 }),
      makeValue(id, "def-transport", { yearlyValue: Math.round(rand() * 4000 * 100) / 100 }),
      makeValue(id, "def-custom", {
        monthlyValues: Array.from({ length: MONTHS }, () =>
          rand() < 0.5 ? 0 : Math.round(rand() * 300 * 100) / 100
        ),
      }),
      makeValue(id, "def-overtime", {
        qty: Math.round(rand() * 200),
        unitRate: Math.round(rand() * 40 * 100) / 100,
      }),
      makeValue(id, "def-flatmonthly", { yearlyValue: Math.round(rand() * 400 * 100) / 100 }),
      makeValue(id, "def-vacweighted", { yearlyValue: Math.round(rand() * 2000 * 100) / 100 }),
      makeValue(id, "def-multdays", { rate: Math.round(rand() * 30 * 100) / 100 }),
      makeValue(id, "def-multrealdays", { rate: Math.round(rand() * 30 * 100) / 100 }),
      makeValue(id, "def-multholdays", { rate: Math.round(rand() * 30 * 100) / 100 }),
      makeValue(id, "def-multvac", { rate: Math.round(rand() * 100) / 100 }),
      makeValue(id, "def-multhours", { rate: Math.round(rand() * 5 * 100) / 100 }),
      makeValue(id, "def-combadd", { rate: Math.round(rand() * 10 * 100) / 10000 }),
      makeValue(id, "def-combsub", { rate: Math.round(rand() * 10 * 100) / 10000 }),
      makeValue(id, "def-combmul", { rate: Math.round(rand() * 100) / 10000 }),
      makeValue(id, "def-costperhour", { rate: 1 })
    );
  }

  const realDays = Array.from({ length: MONTHS }, () => 18 + Math.floor(rand() * 5));
  // ~half the months carry 1–2 bank holidays, so the BANK_HOLIDAY op is exercised
  // with nonzero counts (and hourly vs salaried positions) in the parity suite.
  const holidayDays = Array.from({ length: MONTHS }, () =>
    rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 2)
  );
  return makeInput({
    definitions,
    ssSchemes: [standardScheme()],
    positions,
    componentValues,
    calendar: makeCalendar(realDays, holidayDays),
  });
}
