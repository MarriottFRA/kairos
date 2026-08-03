/**
 * End-to-end Results generation, over real databases.
 * -----------------------------------------------------------
 * This is the regression test for the reported bug: "the output generation is
 * only generating a single output, only A972540". A user filled in the Headcount,
 * Working Hours, Salary and Vacation-benefits account columns, hit Recalculate,
 * and got one row per department on the one account pinned in code — because the
 * per-position account columns were stored and read by nothing.
 *
 * It walks the whole path the Recalculate button walks: seed the system defs →
 * write positions with their accounts → loadScenarioInput → compile → simulate →
 * projectOutputLines → writeRun → readOutputs, and asserts on the dept×account
 * rows the Results grid renders. Nothing is stubbed, so it fails if ANY link in
 * that chain stops carrying the account.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { buildDefaultCalendar, DEFAULT_WEEKEND_MASK } from "../../../shared/calendar";
import { compile, simulate } from "../../../shared/engine/simulate";
import {
  headcountAccountForJobType,
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE,
  POSITION_COUNT_ACCOUNT,
} from "../../../shared/positions/systemAccounts";
import { applyStructureColumns } from "../../blocks/schema";
import { ensureSystemDefs } from "../../blocks/repo";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { loadScenarioInput } from "../loadScenarioInput";
import { resolveOuScope } from "../ouScope";
import {
  cumulativeStatDefIds,
  projectOutputLines,
  readOutputs,
  writeRun,
} from "../outputsRepo";
import { batchWrite } from "../positionsRepo";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../schema";
import { getFieldCatalog, saveScenario } from "../structureRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const NOW = { now: "2026-01-01T00:00:00.000Z" };
const YEAR = 2027;
const CALENDAR = buildDefaultCalendar(SCOPE.ou, YEAR, DEFAULT_WEEKEND_MASK);

/** A level carried the way the BST reads one: loaded in January, unchanged after. */
const janOnly = (value: number) => [value, ...new Array(11).fill(0)];

/** The four accounts a position stores. The headcount account is not one of
 *  them since seed v26 — it is derived from the Classification below. */
const ACCOUNTS = {
  salaryAccountCode: "A511000",
  workingHoursAccount: "A972200",
  accrualAccount: "A512000",
  benefitsAccountCode: "A513000",
};

/** The grade every position here carries, and the headcount account it fixes. */
const JOB_TYPE = "Manager";
const HEADCOUNT_ACCOUNT = headcountAccountForJobType(JOB_TYPE);

let structureDb: Db;
let valuesDb: Db;
let scenarioId: string;

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(structureDb);
  applyHotelClustersV13(structureDb);
  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
  valuesDb.exec(ENGINE_OUTPUTS_SQL);
  scenarioId = saveScenario(structureDb, SCOPE, { year: YEAR, label: "Planning" }).id;
  ensureSystemDefs(structureDb, SCOPE, NOW);
});

/** Write one position with the given fields. */
function writePosition(fields: Record<string, unknown>): void {
  batchWrite(
    valuesDb,
    SCOPE,
    {
      ou: SCOPE.ou,
      scenarioId,
      creates: [
        {
          id: "pos-1",
          fields: {
            departmentCode: "0410",
            jobTypeCode: JOB_TYPE,
            payType: "SALARIED",
            headcount: 2,
            monthlyBaseSalary: 3000,
            seasonality: new Array(12).fill(1),
            vacationMonthlyWeights: new Array(12).fill(1 / 12),
            vacationDays: 24,
            dailyContractHours: 8,
            ...fields,
          },
        },
      ],
    },
    buildFieldMap(getFieldCatalog(structureDb, SCOPE))
  );
}

/** Everything Recalculate does, returning what the Results grid would show. */
async function recalculate() {
  const input = await loadScenarioInput(
    structureDb,
    valuesDb,
    SCOPE,
    scenarioId,
    async () => CALENDAR
  );
  const compiled = compile(input);
  if (!("plan" in compiled)) {
    throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);
  }
  const projection = projectOutputLines(
    simulate(compiled.plan),
    input.positions,
    cumulativeStatDefIds(input.definitions)
  );
  writeRun(
    valuesDb,
    SCOPE,
    scenarioId,
    {
      fingerprint: "fp",
      computedAt: NOW.now,
      positionCount: input.positions.length,
    },
    projection.lines
  );
  return {
    projection,
    outputs: readOutputs(structureDb, valuesDb, SCOPE, scenarioId),
  };
}

describe("Recalculate → Results rows", () => {
  it("emits one row per account the position posts to, not just A972540", async () => {
    writePosition(ACCOUNTS);
    const { outputs } = await recalculate();

    expect(outputs.rows.map((row) => row.account).sort()).toEqual(
      [
        ACCOUNTS.salaryAccountCode,
        ACCOUNTS.accrualAccount,
        ACCOUNTS.benefitsAccountCode,
        HEADCOUNT_ACCOUNT,
        ACCOUNTS.workingHoursAccount,
        POSITION_COUNT_ACCOUNT,
      ].sort()
    );
    // All under the position's own department — shown the way Kairos writes a
    // department code, whatever spelling the position was saved with.
    expect(new Set(outputs.rows.map((row) => row.dept))).toEqual(new Set(["D0410"]));
  });

  it("reproduces the reported bug's shape when no account is picked", async () => {
    // Associate books no headcount account either, so this row picks nothing at
    // all — the one case where a single output row is the right answer.
    writePosition({ jobTypeCode: "Associate" });
    const { outputs, projection } = await recalculate();

    // One row, the pinned head — exactly what the user saw. Correct behaviour
    // when nothing is picked; the bug was that it happened REGARDLESS.
    expect(outputs.rows).toHaveLength(1);
    expect(outputs.rows[0].account).toBe(POSITION_COUNT_ACCOUNT);
    // ...and now it is explained rather than silent.
    expect(projection.unpostedByLabel).toMatchObject({
      "Base Salary": 1,
      "Vacation Cost": 1,
      "Vacation Accrual": 1,
      "Hours Worked": 1,
      Headcount: 1,
    });
  });

  it("splits Costs from Statistics on the A9 prefix", async () => {
    writePosition(ACCOUNTS);
    const { outputs } = await recalculate();

    const stats = outputs.rows.filter((row) => row.isStats).map((row) => row.account);
    const costs = outputs.rows.filter((row) => !row.isStats).map((row) => row.account);

    // Statistics: counts and hours. Includes the pinned head — which the old
    // startsWith("9") test classified as a COST, so the Statistics tab was empty.
    expect(stats.sort()).toEqual(
      [
        HEADCOUNT_ACCOUNT,
        ACCOUNTS.workingHoursAccount,
        POSITION_COUNT_ACCOUNT,
      ].sort()
    );
    expect(costs.sort()).toEqual(
      [
        ACCOUNTS.salaryAccountCode,
        ACCOUNTS.accrualAccount,
        ACCOUNTS.benefitsAccountCode,
      ].sort()
    );
  });

  it("posts the headcount and the hours as counts, not currency", async () => {
    writePosition(ACCOUNTS);
    const { outputs } = await recalculate();
    const row = (account: string) =>
      outputs.rows.find((entry) => entry.account === account)!;

    // Count 2, active all year, on both heads — the per-row account and the
    // pinned one report the same heads under different accounts. A headcount is
    // a LEVEL, so it is loaded once in January: the BST reads such a statistic
    // as the running sum of its months, and repeating 2 twelve times would
    // report 24 heads by December.
    expect(row(HEADCOUNT_ACCOUNT).months).toEqual(janOnly(2));
    expect(row(POSITION_COUNT_ACCOUNT).months).toEqual(janOnly(2));
    // Hours are NOT a level — they genuinely accrue month by month.
    expect(row(ACCOUNTS.workingHoursAccount).months.filter((m) => m > 0).length).toBe(12);
    expect(row(ACCOUNTS.workingHoursAccount).total).toBeGreaterThan(0);
  });

  it("loads a mid-year starter's heads in the month it comes online", async () => {
    // Seasonality 0 until March: no heads to report before then, then 2.
    writePosition({
      ...ACCOUNTS,
      seasonality: [0, 0, ...new Array(10).fill(1)],
    });
    const { outputs } = await recalculate();
    const heads = outputs.rows.find(
      (entry) => entry.account === POSITION_COUNT_ACCOUNT
    )!;

    // The change, in the month it happens — the running sum is 0, 0, 2, 2 … 2,
    // which is the truth about this position.
    expect(heads.months).toEqual([0, 0, 2, ...new Array(9).fill(0)]);
  });

  it("loads a leaver's departure as a negative movement", async () => {
    // Active through August, gone from September.
    writePosition({
      ...ACCOUNTS,
      seasonality: [...new Array(8).fill(1), ...new Array(4).fill(0)],
    });
    const { outputs } = await recalculate();
    const heads = outputs.rows.find(
      (entry) => entry.account === POSITION_COUNT_ACCOUNT
    )!;

    expect(heads.months).toEqual([2, 0, 0, 0, 0, 0, 0, 0, -2, 0, 0, 0]);
    // Running sum back to zero by year end — the Year column reports the
    // December level, not twelve months of heads added together.
    expect(heads.total).toBe(0);
  });

  it("keeps salary and vacation cost adding back up to the gross wage", async () => {
    writePosition(ACCOUNTS);
    const { outputs } = await recalculate();
    const salary = outputs.rows.find(
      (row) => row.account === ACCOUNTS.salaryAccountCode
    )!;
    const vacation = outputs.rows.find(
      (row) => row.account === ACCOUNTS.benefitsAccountCode
    )!;

    // Salary is reported NET of leave taken; the Benefits account carries what
    // was deducted. Before this change that money was simply absent from Results.
    expect(vacation.total).toBeGreaterThan(0);
    expect(salary.total + vacation.total).toBeCloseTo(2 * 3000 * 12, 6);
  });

  it("calculates but does not post a line whose account is blank", async () => {
    writePosition({ ...ACCOUNTS, benefitsAccountCode: "" });
    const { outputs, projection } = await recalculate();

    expect(
      outputs.rows.some((row) => row.account === ACCOUNTS.benefitsAccountCode)
    ).toBe(false);
    expect(projection.unpostedByLabel).toEqual({ "Vacation Cost": 1 });
    // The salary line is still NET of the leave, so the vacation was calculated —
    // it just has nowhere to post.
    const salary = outputs.rows.find(
      (row) => row.account === ACCOUNTS.salaryAccountCode
    )!;
    expect(salary.total).toBeLessThan(2 * 3000 * 12);
  });

  it("does not double-count heads on the pinned account", async () => {
    writePosition(ACCOUNTS);
    const { outputs } = await recalculate();

    const pinned = outputs.rows.filter(
      (row) => row.account === POSITION_COUNT_ACCOUNT
    );
    expect(pinned).toHaveLength(1);
    // Count 2 — NOT 4. readOutputs sums lines sharing a dept|account key, so
    // both heads posting to one account would silently double the reported heads.
    expect(pinned[0].months).toEqual(janOnly(2));

    // applyPositionAccounts drops a per-row headcount account that collides with
    // the pinned head (pinned in positionAccounts.test.ts). This is the upstream
    // half of that guard: no grade may create the collision in the first place.
    for (const account of Object.values(HEADCOUNT_ACCOUNT_BY_JOB_TYPE)) {
      expect(account).not.toBe(POSITION_COUNT_ACCOUNT);
    }
  });

  it("recalculates a hotel that never opened the Blocks page", async () => {
    // ensureSystemDefs runs in the recalc handler too, so the BASE_SALARY def the
    // engine mandates exists even if the structure read model was never built.
    const fresh = new Database(":memory:") as Db;
    fresh.exec(POSITIONS_STRUCTURE_TABLES_SQL);
    applyStructureColumns(fresh);
    applyHotelClustersV13(fresh);
    const freshScenario = saveScenario(fresh, SCOPE, { year: YEAR, label: "P" }).id;

    batchWrite(
      valuesDb,
      SCOPE,
      {
        ou: SCOPE.ou,
        scenarioId: freshScenario,
        creates: [
          {
            id: "pos-9",
            fields: {
              departmentCode: "0410",
              monthlyBaseSalary: 1000,
              headcount: 1,
              seasonality: new Array(12).fill(1),
              salaryAccountCode: ACCOUNTS.salaryAccountCode,
            },
          },
        ],
      },
      buildFieldMap(getFieldCatalog(fresh, SCOPE))
    );

    ensureSystemDefs(fresh, SCOPE, NOW);
    const input = await loadScenarioInput(
      fresh,
      valuesDb,
      SCOPE,
      freshScenario,
      async () => CALENDAR
    );
    const compiled = compile(input);
    expect("plan" in compiled).toBe(true);
  });
});
