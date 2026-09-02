/**
 * WEEKDAYS spread, end to end: saveBlock → weekday_mask column →
 * getComponentDefinitions → (resolveBlockValues for the dual block) → compile
 * → simulate, asserting the actual numbers against weekdayCounts.
 *
 * The engine suite already pins the math per se (goldenMaster, invariants);
 * this file pins the PLUMBING — that a mask typed in the dialog survives the
 * DB round trip and lands on every def that needs it, and that a fixed
 * block's spread choice really switches the amount's unit.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { weekdayCounts } from "../../../shared/calendar";
import { compile, simulate } from "../../../shared/engine/simulate";
import { MONTHS, ScenarioInput } from "../../../shared/engine/types";
import {
  FIXTURE_YEAR,
  makeCalendar,
  makePosition,
  makeScenario,
  makeValue,
  posId,
} from "../../../shared/engine/__tests__/fixtures";
import { resolveBlockValues } from "../../../shared/positions/engineInput";
import { blockCostDefId, blockStatDefId } from "../../../shared/blocks/ipc";
import { POSITIONS_STRUCTURE_TABLES_SQL } from "../../positions/schema";
import { resolveOuScope } from "../../positions/ouScope";
import { getComponentDefinitions } from "../../positions/structureRepo";
import { applyStructureColumns } from "../schema";
import { ensureBaseSalaryDef, saveBlock } from "../repo";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const NOW = { now: "2026-01-01T00:00:00.000Z" };
const FRIDAYS = 1 << 5;
const MON_FRI = (1 << 1) | (1 << 5);

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(db);
  ensureBaseSalaryDef(db, SCOPE, NOW);
});

function runScenario(componentValues: ScenarioInput["componentValues"]) {
  const definitions = getComponentDefinitions(db, SCOPE);
  const compiled = compile({
    scenario: makeScenario(),
    calendar: makeCalendar(),
    definitions,
    ssSchemes: [],
    positions: [makePosition({ id: "p1", monthlyBaseSalary: 3000 })],
    componentValues: resolveBlockValues(definitions, componentValues),
    buyouts: [],
  });
  if (!("plan" in compiled)) {
    throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);
  }
  const lines = simulate(compiled.plan).positionLines(posId("p1"));
  return (id: string) =>
    lines.find((entry) => (entry.component.id as string) === id)!.months;
}

describe("WEEKDAYS spread through the real store", () => {
  it("a fixed block books its amount once per masked day", () => {
    const id = saveBlock(
      db,
      SCOPE,
      {
        blockType: "FLAT_MONTHLY",
        label: "Live Music",
        accountCode: "628970",
        accountLocked: true,
        spread: "WEEKDAYS",
        weekdayMask: FRIDAYS,
      },
      NOW
    );
    const line = runScenario([
      makeValue("p1", blockCostDefId(id), { yearlyValue: 100 }),
    ])(blockCostDefId(id));

    const counts = weekdayCounts(FIXTURE_YEAR, FRIDAYS);
    for (let m = 0; m < MONTHS; m++) {
      expect(line[m], `month ${m + 1}`).toBeCloseTo(100 * counts[m], 9);
    }
  });

  it("a count×rate block books qty × rate per day, and qty on the stat line", () => {
    const id = saveBlock(
      db,
      SCOPE,
      {
        blockType: "COUNT_RATE",
        label: "Weekly Deep Clean",
        accountCode: "628980",
        accountLocked: true,
        statsAccountCode: "988300",
        spread: "WEEKDAYS",
        weekdayMask: MON_FRI,
      },
      NOW
    );
    // One stored row under the cost def, the dual convention — the resolver
    // synthesizes cost = qty × rate and stat = qty into the yearlyValue slot.
    const line = runScenario([
      makeValue("p1", blockCostDefId(id), { qty: 2, unitRate: 10 }),
    ]);

    const counts = weekdayCounts(FIXTURE_YEAR, MON_FRI);
    for (let m = 0; m < MONTHS; m++) {
      expect(line(blockCostDefId(id))[m], `cost month ${m + 1}`).toBeCloseTo(
        2 * 10 * counts[m],
        9
      );
      expect(line(blockStatDefId(id))[m], `stat month ${m + 1}`).toBeCloseTo(
        2 * counts[m],
        9
      );
    }
  });

  it("a fixed block with the DAYS spread books its amount as a YEARLY total", () => {
    // The unit switch: with a spread other than the default, the single
    // amount is the year's figure, not a per-month one.
    const id = saveBlock(
      db,
      SCOPE,
      {
        blockType: "FLAT_MONTHLY",
        label: "Transport",
        accountCode: "623000",
        accountLocked: true,
        spread: "DAYS",
      },
      NOW
    );
    const line = runScenario([
      makeValue("p1", blockCostDefId(id), { yearlyValue: 1200 }),
    ])(blockCostDefId(id));

    let total = 0;
    for (let m = 0; m < MONTHS; m++) total += line[m];
    expect(total).toBeCloseTo(1200, 8);
  });
});
