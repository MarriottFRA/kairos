/**
 * The perimeter test.
 * -----------------------------------------------------------
 * The engine kernel was always fine; what shipped broken was the boundary. Four
 * of the five account columns on the Positions grid (Salary, Headcount, Working
 * Hours, Vacation Benefits) were written to `extra_values` and read by NOTHING,
 * so every system head compiled with the blank account it was seeded with and
 * was dropped from the output. Results therefore showed exactly one account —
 * A972540, the only one pinned in code — however much the user filled in.
 *
 * No test asserted that a user-facing account field reaches a compiled line, so
 * nothing caught it. That is what this file exists to prevent: it walks the real
 * path (extra values → readPositionAccounts → applyPositionAccounts → compile)
 * and asserts on the aggregation keys the output projection actually reads.
 */

import { describe, expect, it } from "vitest";
import {
  baseSalaryDefId,
  holidayAccrualDefId,
  positionCountDefId,
  systemStatDefId,
  vacationCostDefId,
} from "../../blocks/ipc";
import { compile } from "../../engine/compile";
import { simulate } from "../../engine/simulate";
import {
  ComponentDefId,
  MONTHS,
  Position,
  PositionId,
  ScenarioId,
  ScenarioInput,
} from "../../engine/types";
import { makeCalendarContext } from "../../engine/calendarContext";
import { applyPositionAccounts, readPositionAccounts } from "../engineInput";
import { POSITION_COUNT_ACCOUNT } from "../systemAccounts";

const OU = "0410";
const SCENARIO = "scn-1" as ScenarioId;
const SYNC: { updatedAt: string; deletedAt: string | null } = {
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
};

/** The five accounts as the grid stores them, all filled in. */
const FILLED = {
  salaryAccountCode: "A511000",
  headCountAccount: "A972100",
  workingHoursAccount: "A972200",
  accrualAccount: "A512000",
  benefitsAccountCode: "A513000",
};

function position(id: string, overrides: Partial<Position> = {}): Position {
  return {
    id: id as PositionId,
    scenarioId: SCENARIO,
    departmentCode: "1010",
    jobTypeCode: "Associate",
    cluster: "Rooms",
    hotelClusterWeight: 1,
    payType: "SALARIED",
    headcount: 3,
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
    vacationDays: 24,
    vacationMonthlyWeights: new Array(MONTHS).fill(1 / 12),
    accrualDaysPerMonth: 2,
    ...SYNC,
    ...overrides,
  };
}

/** The permanent system heads, exactly as blocks/repo.ensureSystemDefs seeds
 *  them: every account BLANK except the pinned position-count head. */
function systemDefs(): ScenarioInput["definitions"] {
  const base = {
    ou: OU,
    departmentMode: "POSITION" as const,
    increaseAware: false,
    accountCode: "",
    ...SYNC,
  };
  return [
    {
      ...base,
      id: baseSalaryDefId(OU) as ComponentDefId,
      kind: "BASE_SALARY",
      label: "Base Salary",
      sortOrder: 0,
    },
    {
      ...base,
      id: vacationCostDefId(OU) as ComponentDefId,
      kind: "SPREAD",
      spreadMethod: "PERCENT_OF",
      baseSelector: { kind: "VACATION" },
      label: "Vacation Cost",
      sortOrder: 2,
    },
    {
      ...base,
      id: holidayAccrualDefId(OU) as ComponentDefId,
      kind: "HOLIDAY_ACCRUAL",
      label: "Vacation Accrual",
      sortOrder: 3,
    },
    {
      ...base,
      id: systemStatDefId(OU, "HOURS") as ComponentDefId,
      kind: "STAT",
      statKind: "HOURS",
      label: "Hours Worked",
      sortOrder: 5,
    },
    {
      ...base,
      id: systemStatDefId(OU, "HEADCOUNT") as ComponentDefId,
      kind: "STAT",
      statKind: "HEADCOUNT",
      label: "Headcount",
      sortOrder: 5,
    },
    {
      ...base,
      id: positionCountDefId(OU) as ComponentDefId,
      kind: "STAT",
      statKind: "HEADCOUNT",
      label: "Position Count",
      accountCode: POSITION_COUNT_ACCOUNT,
      sortOrder: 6,
    },
  ];
}

/**
 * Run the real path and return what the output projection would see: one entry
 * per emitted line, with the blank-account drop applied exactly as the recalc
 * handler applies it.
 */
function run(extraValues: Record<string, unknown>, overrides: Partial<Position> = {}) {
  const pos = position("p1", overrides);
  const input: ScenarioInput = {
    scenario: { id: SCENARIO, ou: OU, year: 2027, label: "B", ...SYNC },
    calendar: makeCalendarContext(new Array(MONTHS).fill(20)),
    definitions: systemDefs(),
    ssSchemes: [],
    positions: [pos],
    componentValues: applyPositionAccounts(
      OU,
      [],
      new Map([[pos.id as string, readPositionAccounts(extraValues)]])
    ),
    buyouts: [],
  };

  const compiled = compile(input);
  if ("errors" in compiled) {
    throw new Error(`compile failed: ${compiled.errors.map((e) => e.code).join(",")}`);
  }
  const result = simulate(compiled.plan);

  const all = result.positionLines(pos.id).map((line) => {
    let total = 0;
    for (const value of line.months) total += value;
    return { label: line.component.label, account: line.account, total };
  });
  return { all, posted: all.filter((line) => line.account !== "") };
}

describe("per-position posting accounts reach the engine", () => {
  it("posts every account the user picked, each to its own line", () => {
    const { posted } = run(FILLED);

    const byAccount = new Map(posted.map((line) => [line.account, line]));
    // The four user-picked accounts, plus the pinned head. This is the assertion
    // whose absence let the bug ship: before the fix this set was {A972540}.
    expect([...byAccount.keys()].sort()).toEqual([
      FILLED.salaryAccountCode,
      FILLED.accrualAccount,
      FILLED.benefitsAccountCode,
      FILLED.headCountAccount,
      FILLED.workingHoursAccount,
      POSITION_COUNT_ACCOUNT,
    ].sort());

    // Each account carries exactly one line — no account is doubled up.
    for (const account of byAccount.keys()) {
      expect(posted.filter((line) => line.account === account)).toHaveLength(1);
    }
  });

  it("routes each account to the head that owns it", () => {
    const { posted } = run(FILLED);
    const accountOf = (label: string) =>
      posted.find((line) => line.label === label)?.account;

    expect(accountOf("Base Salary")).toBe(FILLED.salaryAccountCode);
    expect(accountOf("Vacation Cost")).toBe(FILLED.benefitsAccountCode);
    expect(accountOf("Vacation Accrual")).toBe(FILLED.accrualAccount);
    expect(accountOf("Hours Worked")).toBe(FILLED.workingHoursAccount);
    expect(accountOf("Headcount")).toBe(FILLED.headCountAccount);
    expect(accountOf("Position Count")).toBe(POSITION_COUNT_ACCOUNT);
  });

  it("calculates a blank-account line but excludes it from the output", () => {
    const { all, posted } = run({ ...FILLED, salaryAccountCode: "" });

    const salary = all.find((line) => line.label === "Base Salary")!;
    expect(salary.account).toBe("");
    // The value is real — it stays available to anything using it as a base.
    expect(salary.total).toBeGreaterThan(0);
    // ...but it is not posted.
    expect(posted.some((line) => line.label === "Base Salary")).toBe(false);
  });

  it("still posts the pinned head when every user account is blank", () => {
    const { posted } = run({});
    expect(posted).toHaveLength(1);
    expect(posted[0].account).toBe(POSITION_COUNT_ACCOUNT);
  });

  it("does not double-count heads when the Headcount account is the pinned one", () => {
    // Both heads are STAT/HEADCOUNT emitting the same Count, so sharing an
    // account would make the outputs read (which SUMS lines per dept|account)
    // report twice the heads. The override is dropped instead.
    const { posted } = run({ ...FILLED, headCountAccount: POSITION_COUNT_ACCOUNT });

    const pinned = posted.filter((line) => line.account === POSITION_COUNT_ACCOUNT);
    expect(pinned).toHaveLength(1);
    expect(pinned[0].label).toBe("Position Count");
    expect(pinned[0].total).toBe(3 * MONTHS); // Count 3, every month active
    expect(posted.some((line) => line.label === "Headcount")).toBe(false);
  });

  it("matches the account case-insensitively when guarding the pinned head", () => {
    const { posted } = run({
      ...FILLED,
      headCountAccount: POSITION_COUNT_ACCOUNT.toLowerCase(),
    });
    expect(posted.filter((line) => line.account === POSITION_COUNT_ACCOUNT)).toHaveLength(1);
  });

  it("gives the vacation-cost head the leave actually taken", () => {
    // The base line is reported NET of vacation; this head re-emits what was
    // deducted, so the two must add back up to the gross wage.
    const { all } = run(FILLED);
    const salary = all.find((line) => line.label === "Base Salary")!;
    const vacation = all.find((line) => line.label === "Vacation Cost")!;

    expect(vacation.total).toBeGreaterThan(0);
    // 3 heads × 1200 × 12 months gross.
    expect(salary.total + vacation.total).toBeCloseTo(3 * 1200 * MONTHS, 6);
  });

  it("trims whitespace and treats a blank string as no account", () => {
    expect(readPositionAccounts({ salaryAccountCode: "  A511000  " }).salary).toBe(
      "A511000"
    );
    expect(readPositionAccounts({ salaryAccountCode: "   " }).salary).toBe("");
    expect(readPositionAccounts({}).salary).toBe("");
    // Non-strings (a stale numeric value, null) must not leak into an account.
    expect(readPositionAccounts({ salaryAccountCode: 511000 }).salary).toBe("");
  });

  it("merges onto an existing stored value instead of duplicating it", () => {
    // compile keys values by positionId|componentDefId, so a duplicate row would
    // silently win or lose on ordering.
    const existing = [
      {
        positionId: "p1" as PositionId,
        componentDefId: baseSalaryDefId(OU) as ComponentDefId,
        ssOpeningBase: 4200,
        ...SYNC,
      },
    ];
    const out = applyPositionAccounts(
      OU,
      existing,
      new Map([["p1", readPositionAccounts(FILLED)]])
    );

    const forBase = out.filter(
      (value) => (value.componentDefId as string) === baseSalaryDefId(OU)
    );
    expect(forBase).toHaveLength(1);
    expect(forBase[0].accountCode).toBe(FILLED.salaryAccountCode);
    // The stored field it merged onto survives.
    expect(forBase[0].ssOpeningBase).toBe(4200);
  });

  it("leaves values for other definitions untouched", () => {
    const blockValue = {
      positionId: "p1" as PositionId,
      componentDefId: "blk-9:cost" as ComponentDefId,
      rate: 0.15,
      accountCode: "A600000",
      ...SYNC,
    };
    const out = applyPositionAccounts(
      OU,
      [blockValue],
      new Map([["p1", readPositionAccounts(FILLED)]])
    );
    expect(out).toContain(blockValue);
  });

  it("is a no-op with no positions to account for", () => {
    const values = [
      {
        positionId: "p1" as PositionId,
        componentDefId: "blk-1:cost" as ComponentDefId,
        ...SYNC,
      },
    ];
    expect(applyPositionAccounts(OU, values, new Map())).toBe(values);
  });
});
