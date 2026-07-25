/**
 * NI opening-balance pre-sim — computeNiOpeningBalances writes each position's
 * prior-year contributory base for a cumulative, non-January tax year (and
 * clears it to 0 otherwise / for a sim-year hire). Two in-memory stores, the
 * liveSimParity harness pattern.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { buildDefaultCalendar, CalendarYear, DEFAULT_WEEKEND_MASK } from "../../../shared/calendar";
import { applyBlocksStructureV12 } from "../../blocks/schema";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { ensureBaseSalaryDef, saveBlock } from "../../blocks/repo";
import {
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import { resolveOuScope } from "../../positions/ouScope";
import {
  getComponentDefinitions,
  getFieldCatalog,
  saveScenario,
} from "../../positions/structureRepo";
import { batchWrite } from "../../positions/positionsRepo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { SsSchemeInput } from "../../../shared/socialSecurity/ipc";
import { saveScheme } from "../repo";
import { computeNiOpeningBalances } from "../openingBalances";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const NOW = { now: "2026-01-01T00:00:00.000Z" };
const YEAR = 2026;

let structureDb: Db;
let valuesDb: Db;
let scenarioId: string;

const getCalendar = async (ou: string, year: number): Promise<CalendarYear | null> =>
  buildDefaultCalendar(ou, year, DEFAULT_WEEKEND_MASK);

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyBlocksStructureV12(structureDb);
  applyHotelClustersV13(structureDb);
  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
  scenarioId = saveScenario(structureDb, SCOPE, { year: YEAR, label: "Planning" }).id;
  ensureBaseSalaryDef(structureDb, SCOPE, NOW);
});

/** Configure an NI block with a scheme; returns the scheme id (the recompute is
 *  now scheme-scoped). Label is unique per call so multiple schemes coexist. */
function configureNi(
  scheme: Omit<SsSchemeInput, "label"> & { label?: string }
): string {
  const label = scheme.label ?? "NI";
  const schemeId = saveScheme(
    structureDb,
    SCOPE,
    { label, ...scheme } as SsSchemeInput,
    NOW
  );
  saveBlock(
    structureDb,
    SCOPE,
    {
      blockType: "SOCIAL_SECURITY",
      label,
      accountCode: "530000",
      accountLocked: true,
      ssSchemeId: schemeId,
    },
    NOW
  );
  return schemeId;
}

/** The SOCIAL_SECURITY component def id backing a scheme (keys its opening
 *  base in component_values). */
function ssDefIdFor(schemeId: string): string {
  const def = getComponentDefinitions(structureDb, SCOPE).find(
    (d) => d.kind === "SOCIAL_SECURITY" && (d.ssSchemeId as string) === schemeId
  );
  if (!def) throw new Error("no SS def for scheme");
  return def.id as string;
}

/** One salaried position, 1000/month, no vacation (so gross = net base). */
function seedPosition(id = "pos-1", hiringDate?: string): void {
  const lookup = buildFieldMap(getFieldCatalog(structureDb, SCOPE));
  const defIds = new Set(getComponentDefinitions(structureDb, SCOPE).map((def) => def.id as string));
  batchWrite(
    valuesDb,
    SCOPE,
    {
      ou: SCOPE.ou,
      scenarioId,
      creates: [
        {
          id,
          fields: {
            departmentCode: "0410",
            jobTypeCode: "MGR",
            payType: "SALARIED",
            headcount: 1,
            fte: 1,
            monthlyBaseSalary: 1000,
            seasonality: new Array(12).fill(1),
            vacationDays: 0,
            vacationMonthlyWeights: new Array(12).fill(0),
          },
          pii: hiringDate ? { hiringDate } : undefined,
        },
      ],
    },
    lookup,
    defIds
  );
}

/** The persisted per-(position, scheme) opening base. With no defId, reads the
 *  lone SS row (the only component_values row the pre-sim writes here). */
const openingOf = (id = "pos-1", defId?: string): number => {
  const row = (
    defId
      ? valuesDb
          .prepare(
            "SELECT ss_opening_base FROM component_values WHERE position_id = ? AND component_def_id = ?"
          )
          .get(id, defId)
      : valuesDb
          .prepare(
            "SELECT ss_opening_base FROM component_values WHERE position_id = ? AND ss_opening_base IS NOT NULL"
          )
          .get(id)
  ) as { ss_opening_base: number } | undefined;
  return row?.ss_opening_base ?? 0;
};

describe("computeNiOpeningBalances", () => {
  it("sums the prior tax-year slice for a cumulative, April-start scheme", async () => {
    const schemeId = configureNi({
      monthlyCap: null,
      yearlyCap: null,
      brackets: [{ upTo: null, rate: 0.1 }],
      accumulationMode: "CUMULATIVE",
      taxYearStartMonth: 4,
    });
    seedPosition();
    const { updated } = await computeNiOpeningBalances(structureDb, valuesDb, SCOPE, scenarioId, schemeId, getCalendar, NOW.now);
    expect(updated).toBe(1);
    // Apr..Dec = 9 months × 1000 base = 9000.
    expect(openingOf()).toBeCloseTo(9000, 5);
  });

  it("caps the opening base at the yearly cap", async () => {
    const schemeId = configureNi({
      monthlyCap: null,
      yearlyCap: 5000,
      brackets: [{ upTo: null, rate: 0.1 }],
      accumulationMode: "CUMULATIVE",
      taxYearStartMonth: 4,
    });
    seedPosition();
    await computeNiOpeningBalances(structureDb, valuesDb, SCOPE, scenarioId, schemeId, getCalendar, NOW.now);
    expect(openingOf()).toBeCloseTo(5000, 5);
  });

  it("is 0 for a position first staffed in the sim year", async () => {
    const schemeId = configureNi({
      monthlyCap: null,
      yearlyCap: null,
      brackets: [{ upTo: null, rate: 0.1 }],
      accumulationMode: "CUMULATIVE",
      taxYearStartMonth: 4,
    });
    seedPosition("pos-1", `${YEAR}-06-15`);
    await computeNiOpeningBalances(structureDb, valuesDb, SCOPE, scenarioId, schemeId, getCalendar, NOW.now);
    expect(openingOf()).toBeCloseTo(0, 5);
  });

  it("is 0 for a per-period scheme", async () => {
    const schemeId = configureNi({
      monthlyCap: null,
      yearlyCap: null,
      brackets: [{ upTo: null, rate: 0.1 }],
      accumulationMode: "PER_PERIOD",
      taxYearStartMonth: 4,
    });
    seedPosition();
    await computeNiOpeningBalances(structureDb, valuesDb, SCOPE, scenarioId, schemeId, getCalendar, NOW.now);
    expect(openingOf()).toBeCloseTo(0, 5);
  });

  it("is 0 for a January tax year", async () => {
    const schemeId = configureNi({
      monthlyCap: null,
      yearlyCap: null,
      brackets: [{ upTo: null, rate: 0.1 }],
      accumulationMode: "CUMULATIVE",
      taxYearStartMonth: 1,
    });
    seedPosition();
    await computeNiOpeningBalances(structureDb, valuesDb, SCOPE, scenarioId, schemeId, getCalendar, NOW.now);
    expect(openingOf()).toBeCloseTo(0, 5);
  });

  it("recomputes only the target scheme, leaving another scheme untouched", async () => {
    // Two cumulative, non-January schemes with different tax-year starts.
    const april = configureNi({
      label: "PAYE",
      monthlyCap: null,
      yearlyCap: null,
      brackets: [{ upTo: null, rate: 0.1 }],
      accumulationMode: "CUMULATIVE",
      taxYearStartMonth: 4,
    });
    const july = configureNi({
      label: "France",
      monthlyCap: null,
      yearlyCap: null,
      brackets: [{ upTo: null, rate: 0.1 }],
      accumulationMode: "CUMULATIVE",
      taxYearStartMonth: 7,
    });
    seedPosition();
    const aprilDef = ssDefIdFor(april);
    const julyDef = ssDefIdFor(july);

    // Recompute only April: Apr..Dec = 9 × 1000 = 9000 for its def; July's def
    // has no row yet.
    await computeNiOpeningBalances(structureDb, valuesDb, SCOPE, scenarioId, april, getCalendar, NOW.now);
    expect(openingOf("pos-1", aprilDef)).toBeCloseTo(9000, 5);
    expect(openingOf("pos-1", julyDef)).toBeCloseTo(0, 5);

    // Now recompute July (Jul..Dec = 6 × 1000 = 6000); April's value stays put.
    await computeNiOpeningBalances(structureDb, valuesDb, SCOPE, scenarioId, july, getCalendar, NOW.now);
    expect(openingOf("pos-1", julyDef)).toBeCloseTo(6000, 5);
    expect(openingOf("pos-1", aprilDef)).toBeCloseTo(9000, 5);
  });
});
