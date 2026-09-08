/**
 * The results cache — the aggregation, its persistence, and the read path
 * that now sits on top of it.
 *
 * The aggregation moved out of readOutputs and into resultsCache.ts, and the
 * one thing that must not change on the way is the answer. So the historical
 * read loop is FROZEN here as an oracle (it must never be rebuilt from the
 * current code) and aggregateResultRows is held to it over every shape of
 * input the sources can produce. On top of that: the cache is written in the
 * run's transaction, readOutputs reads it back unchanged in shape, a run that
 * predates the cache still renders (from its lines, marked stale), and a
 * rebuild says exactly what a write would have said.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { MAPPING_TABLES_SQL } from "../../mappingTables/schema";
import { replaceAllTables } from "../../mappingTables/repo";
import { resolveOuScope } from "../ouScope";
import {
  OutputLineWrite,
  computeFingerprint,
  projectAllocationLines,
  projectSetupLines,
  readOutputs,
  writeRun,
} from "../outputsRepo";
import {
  AggregatableLine,
  aggregateResultRows,
  readLinesForAggregation,
  readResultsCache,
  readResultsCacheStamp,
  rebuildResultsCache,
} from "../resultsCache";
import { ENGINE_OUTPUTS_SQL, POSITIONS_STRUCTURE_TABLES_SQL, POSITIONS_VALUE_TABLES_SQL } from "../schema";
import { accountAllowed } from "../../../shared/positions/fields";
import {
  bareAccount,
  bareDept,
  comboKeyOf,
  displayAccount,
  displayDept,
} from "../../../shared/positions/comboKey";
import { STATS_ACCOUNT_FILTER } from "../../../shared/positions/systemAccounts";
import type { OutputSource, OutputValueKind } from "../../../shared/positions/ipc";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU12345");
const SCENARIO = "scn-cache";
const NOW = "2026-09-08T00:00:00.000Z";
const YEAR = 2027;

// ---------------------------------------------------------------------------
// The oracle: readOutputs' aggregation as it stood before the cache. Frozen.
// ---------------------------------------------------------------------------

interface OracleRow {
  dept: string;
  account: string;
  isStats: boolean;
  months: number[];
  total: number;
  sources: OutputSource[];
  blockLabels: string[];
  valueKind: OutputValueKind;
}

const ORACLE_SOURCE_ORDER: readonly OutputSource[] = [
  "ENGINE",
  "MANUAL",
  "ALLOCATION",
  "BUYOUT",
  "SETUP",
];
const ORACLE_SOURCE_SET: ReadonlySet<string> = new Set(ORACLE_SOURCE_ORDER);

function oracleAggregate(
  lineRows: Array<{
    dept: string;
    account: string;
    monthly_values: string;
    total: number;
    source: string;
    label: string | null;
  }>
): OracleRow[] {
  const isStatsAccount = (account: string) =>
    accountAllowed(account, STATS_ACCOUNT_FILTER);
  const normalizeSource = (value: unknown): OutputSource => {
    const source = String(value ?? "");
    return ORACLE_SOURCE_SET.has(source) ? (source as OutputSource) : "ENGINE";
  };
  const resolveValueKind = (
    isStats: boolean,
    sources: ReadonlySet<OutputSource>
  ): OutputValueKind => {
    if (sources.size === 1 && sources.has("ALLOCATION")) return "percent";
    return isStats ? "count" : "currency";
  };

  const byKey = new Map<string, OracleRow>();
  const sourcesByKey = new Map<string, Set<OutputSource>>();
  const blocksByKey = new Map<string, Map<string, number>>();
  for (const line of lineRows) {
    const key = comboKeyOf(line.dept, line.account);
    const account = displayAccount(line.account);
    let row = byKey.get(key);
    if (!row) {
      row = {
        dept: displayDept(line.dept),
        account,
        isStats: isStatsAccount(account),
        months: new Array(12).fill(0),
        total: 0,
        sources: [],
        blockLabels: [],
        valueKind: "currency",
      };
      byKey.set(key, row);
      sourcesByKey.set(key, new Set());
      blocksByKey.set(key, new Map());
    }
    const source = normalizeSource(line.source);
    sourcesByKey.get(key)!.add(source);
    const label = (line.label ?? "").trim();
    if (source === "ENGINE" && label) {
      const blocks = blocksByKey.get(key)!;
      blocks.set(label, (blocks.get(label) ?? 0) + Math.abs(line.total));
    }
    let months: number[] = [];
    try {
      months = JSON.parse(line.monthly_values) as number[];
    } catch {
      months = [];
    }
    for (let m = 0; m < 12; m++) row.months[m] += Number(months[m]) || 0;
    row.total += line.total;
  }
  for (const [key, row] of byKey) {
    const sources = sourcesByKey.get(key)!;
    row.sources = ORACLE_SOURCE_ORDER.filter((source) => sources.has(source));
    row.blockLabels = [...blocksByKey.get(key)!.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([label]) => label);
    row.valueKind = resolveValueKind(row.isStats, sources);
  }
  return [...byKey.values()].sort(
    (a, b) => a.dept.localeCompare(b.dept) || a.account.localeCompare(b.account)
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ZERO_METRICS = {
  headcount: 0,
  fte: 0,
  manhoursWorked: 0,
  manhoursPaid: 0,
  baseSalary: 0,
  contractDays: 0,
  vacationDays: 0,
};

const months = (value: number, at?: number): number[] =>
  at === undefined
    ? new Array(12).fill(value)
    : new Array(12).fill(0).map((_, m) => (m === at ? value : 0));

let counter = 0;
function line(
  overrides: Partial<OutputLineWrite> & { dept: string; account: string; months: number[] }
): OutputLineWrite {
  counter += 1;
  return {
    positionId: `p${counter}`,
    componentDefId: `c${counter}`,
    label: `Block ${counter}`,
    total: overrides.months.reduce((sum, v) => sum + v, 0),
    source: "ENGINE",
    sourceRef: `p${counter}`,
    ...overrides,
  };
}

/** The lines as the oracle read them off disk. */
const toOracleInput = (lines: OutputLineWrite[]) =>
  lines.map((l) => ({
    dept: l.dept,
    account: l.account,
    monthly_values: JSON.stringify(l.months),
    total: l.total,
    source: l.source ?? "ENGINE",
    label: l.label,
  }));

const toAggregatable = (lines: OutputLineWrite[]): AggregatableLine[] =>
  lines.map((l) => ({
    dept: l.dept,
    account: l.account,
    months: l.months,
    total: l.total,
    source: l.source,
    label: l.label,
    encoding: l.encoding,
  }));

/** A realistic mixed bag: several spellings, every source, uneven floats,
 *  more blocks than the cap on one combo, and a leaver that nets to zero. */
function mixedLines(): OutputLineWrite[] {
  counter = 0;
  const out: OutputLineWrite[] = [
    line({ dept: "D0410", account: "A511000", months: months(1000.1), label: "Base Salary" }),
    line({ dept: "0410", account: "511000", months: months(0.3), label: "Merit" }),
    line({ dept: " d0410 ", account: "a511000", months: months(33.333333), label: "Bonus" }),
    line({ dept: "D0410", account: "A511000", months: months(7), label: "", source: "MANUAL" }),
    line({ dept: "D0410", account: "A511000", months: months(2), label: "Buyout", source: "BUYOUT" }),
    line({ dept: "D0410", account: "A988101", months: months(3, 0), label: "Headcount", encoding: "LEVEL" }),
    line({
      dept: "D0410",
      account: "A988101",
      months: [2, 0, 0, 0, 0, 0, 0, 0, -2, 0, 0, 0],
      label: "Headcount",
      encoding: "LEVEL",
    }),
    line({ dept: "D0410", account: "A988699", months: months(160), label: "Hours Worked" }),
    line({ dept: "D0410", account: "A988699", months: months(1, 0), label: "Weekly Hours", source: "SETUP", encoding: "LEVEL" }),
    line({ dept: "D0510", account: "A975010", months: months(15.23, 0), label: "Alloc", source: "ALLOCATION", encoding: "LEVEL" }),
    line({ dept: "D0510", account: "A511000", months: months(-5) }),
  ];
  // Fourteen distinct blocks on one combo — two past the cap — in a deliberately
  // shuffled order with ties, so the ordering rule has something to decide.
  for (let i = 0; i < 14; i++) {
    out.push(
      line({
        dept: "D0600",
        account: "A520001",
        months: months(((i * 7) % 5) + 1),
        label: `Blk ${String.fromCharCode(65 + ((i * 3) % 14))}`,
      })
    );
  }
  return out;
}

let structureDb: Db;
let valuesDb: Db;

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  structureDb.exec(MAPPING_TABLES_SQL);
  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
  valuesDb.exec(ENGINE_OUTPUTS_SQL);
});

const run = (lines: OutputLineWrite[], computedAt = NOW) =>
  writeRun(
    valuesDb,
    SCOPE,
    SCENARIO,
    { fingerprint: "fp", computedAt, positionCount: 1, year: YEAR },
    lines
  );

const stripOracle = (rows: OracleRow[]) => rows;
const stripNew = (rows: ReturnType<typeof aggregateResultRows>): OracleRow[] =>
  rows.map(({ encoding: _encoding, ...rest }) => rest);

// ---------------------------------------------------------------------------
// Aggregation vs the oracle
// ---------------------------------------------------------------------------

describe("aggregateResultRows", () => {
  it("matches the historical read exactly, field for field, over a mixed bag of lines", () => {
    const lines = mixedLines();
    expect(stripNew(aggregateResultRows(toAggregatable(lines)))).toEqual(
      stripOracle(oracleAggregate(toOracleInput(lines)))
    );
  });

  it("matches the oracle on every single-source shape the projectors emit", () => {
    counter = 0;
    const shapes: OutputLineWrite[][] = [
      [line({ dept: "D0410", account: "A500100", months: months(10) })],
      [line({ dept: "D0410", account: "A500100", months: months(10), source: "MANUAL", label: "Covers" })],
      projectAllocationLines(
        [
          {
            id: "al-1",
            name: "Laundry",
            spreadBase: "HEADCOUNT",
            excludedDepartments: [],
            injectAccount: "A975010",
          },
        ],
        [
          { departmentCode: "D0410", metrics: { ...ZERO_METRICS, headcount: 3, fte: 3 } },
          { departmentCode: "D0510", metrics: { ...ZERO_METRICS, headcount: 1, fte: 1 } },
        ]
      ),
      projectSetupLines({ weeklyHours: 40 }),
      [],
    ];
    for (const lines of shapes) {
      expect(stripNew(aggregateResultRows(toAggregatable(lines)))).toEqual(
        stripOracle(oracleAggregate(toOracleInput(lines)))
      );
    }
  });

  it("reads lines written before the source/encoding columns as ENGINE amounts", () => {
    const rows = aggregateResultRows([
      { dept: "D1", account: "A5", months: months(1), total: 12, source: "", label: "Old", encoding: "" },
      { dept: "D1", account: "A5", months: months(1), total: 12, source: null, label: null, encoding: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toEqual(["ENGINE"]);
    expect(rows[0].encoding).toBe("AMOUNT");
    expect(rows[0].blockLabels).toEqual(["Old"]);
  });

  it("derives the row encoding from its lines: AMOUNT, LEVEL, or MIXED when both land on one combo", () => {
    const lines = mixedLines();
    const rows = aggregateResultRows(toAggregatable(lines));
    const byAccount = new Map(rows.map((row) => [`${row.dept}|${row.account}`, row]));
    expect(byAccount.get("D0410|A511000")?.encoding).toBe("AMOUNT");
    expect(byAccount.get("D0410|A988101")?.encoding).toBe("LEVEL");
    expect(byAccount.get("D0510|A975010")?.encoding).toBe("LEVEL");
    // Hours Worked (amount) shares the account with Weekly Hours (level).
    expect(byAccount.get("D0410|A988699")?.encoding).toBe("MIXED");
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("writeRun + the cache", () => {
  it("writes the cache in the run's transaction and reads it back as the same rows", () => {
    const lines = mixedLines();
    run(lines);

    const expected = aggregateResultRows(toAggregatable(lines));
    const stored = readResultsCache(valuesDb, SCOPE, SCENARIO);
    expect(stored).toEqual(expected);

    const stamp = readResultsCacheStamp(valuesDb, SCOPE, SCENARIO);
    expect(stamp).toEqual({ count: expected.length, writtenAt: NOW });
    const years = valuesDb
      .prepare(`SELECT DISTINCT year FROM results_cache WHERE ou = ? AND scenario_id = ?`)
      .all(SCOPE.ou, SCENARIO) as Array<{ year: number }>;
    expect(years).toEqual([{ year: YEAR }]);
  });

  it("replaces the cache wholesale on the next run", () => {
    run(mixedLines());
    counter = 0;
    run([line({ dept: "D0900", account: "A500100", months: months(1) })], "2026-09-09T00:00:00.000Z");
    const stored = readResultsCache(valuesDb, SCOPE, SCENARIO);
    expect(stored.map((row) => `${row.dept}|${row.account}`)).toEqual(["D0900|A500100"]);
    expect(readResultsCacheStamp(valuesDb, SCOPE, SCENARIO).writtenAt).toBe(
      "2026-09-09T00:00:00.000Z"
    );
  });

  it("persists each line's encoding so the cache can be rebuilt from lines alone", () => {
    run(mixedLines());
    const stored = readLinesForAggregation(valuesDb, SCOPE, SCENARIO);
    // Two headcount lines, Weekly Hours and the allocation split.
    expect(stored.filter((l) => l.encoding === "LEVEL")).toHaveLength(4);
    expect(stored.filter((l) => l.encoding === "AMOUNT").length).toBe(stored.length - 4);
  });

  it("rebuilds from the remaining lines to exactly what a write would say", () => {
    const lines = mixedLines();
    run(lines);
    // Purge one position's lines behind the cache's back, then rebuild.
    valuesDb
      .prepare(`DELETE FROM engine_output_lines WHERE position_id IN ('p1', 'p6')`)
      .run();
    const count = rebuildResultsCache(valuesDb, SCOPE, SCENARIO, YEAR, "2026-09-10T00:00:00.000Z");

    const survivors = lines.filter((l) => l.positionId !== "p1" && l.positionId !== "p6");
    const expected = aggregateResultRows(toAggregatable(survivors));
    expect(count).toBe(expected.length);
    expect(readResultsCache(valuesDb, SCOPE, SCENARIO)).toEqual(expected);
    expect(readResultsCacheStamp(valuesDb, SCOPE, SCENARIO).writtenAt).toBe(
      "2026-09-10T00:00:00.000Z"
    );
  });
});

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

describe("readOutputs over the cache", () => {
  it("returns the same wire rows the historical read produced, with names attached", () => {
    replaceAllTables(
      structureDb,
      {
        accountMaps: [
          { base_account: "A511000", account_description_detail_level_max: "Salaries" },
          { base_account: "988101", account_description_detail_level_max: "Managers" },
        ],
        departmentMaps: [
          { base_department: "0410", department_description_detail_level_max: "Admin" },
        ],
        combos: [],
        version: "v1",
      },
      NOW
    );
    const lines = mixedLines();
    run(lines);

    const outputs = readOutputs(structureDb, valuesDb, SCOPE, SCENARIO);
    expect(outputs.run).toEqual({
      computedAt: NOW,
      lineCount: lines.length,
      positionCount: 1,
    });

    const oracle = oracleAggregate(toOracleInput(lines));
    expect(outputs.rows).toHaveLength(oracle.length);
    outputs.rows.forEach((row, i) => {
      const { isStats, months, total, ...rest } = oracle[i];
      expect(row).toMatchObject(rest);
      expect(row.isStats).toBe(isStats);
      row.months.forEach((v, m) => expect(v).toBeCloseTo(months[m], 9));
      expect(row.total).toBeCloseTo(total, 9);
    });
    const salaries = outputs.rows.find((r) => r.dept === "D0410" && r.account === "A511000")!;
    expect(salaries.accountName).toBe("Salaries");
    expect(salaries.departmentName).toBe("Admin");
    // Names resolve on the bare code whatever spelling the map row used.
    expect(outputs.rows.find((r) => r.account === "A988101")!.accountName).toBe("Managers");
    // Nothing about the DTO betrays the cache: no encoding leaks to the wire.
    expect(Object.keys(salaries).sort()).toEqual(
      [
        "account",
        "accountName",
        "blockLabels",
        "dept",
        "departmentName",
        "isStats",
        "months",
        "sources",
        "total",
        "valueKind",
      ].sort()
    );
  });

  it("is not stale right after a run, and is stale once an input drifts", () => {
    const fingerprint = computeFingerprint(structureDb, valuesDb, SCOPE, SCENARIO);
    writeRun(
      valuesDb,
      SCOPE,
      SCENARIO,
      { fingerprint, computedAt: NOW, positionCount: 0, year: YEAR },
      mixedLines()
    );
    expect(readOutputs(structureDb, valuesDb, SCOPE, SCENARIO).stale).toBe(false);
    valuesDb
      .prepare(
        `INSERT INTO buyout_rows (id, ou, scenario_id, updated_at) VALUES ('b1', ?, ?, ?)`
      )
      .run(SCOPE.ou, SCENARIO, NOW);
    expect(readOutputs(structureDb, valuesDb, SCOPE, SCENARIO).stale).toBe(true);
  });

  it("renders a run that predates the cache from its lines, marked stale, persisting nothing", () => {
    const lines = mixedLines();
    const fingerprint = computeFingerprint(structureDb, valuesDb, SCOPE, SCENARIO);
    writeRun(
      valuesDb,
      SCOPE,
      SCENARIO,
      { fingerprint, computedAt: NOW, positionCount: 0, year: YEAR },
      lines
    );
    // A pre-v8 store: lines and a run header, no cache rows.
    valuesDb.prepare(`DELETE FROM results_cache`).run();

    const outputs = readOutputs(structureDb, valuesDb, SCOPE, SCENARIO);
    expect(outputs.stale).toBe(true);
    const expected = aggregateResultRows(toAggregatable(lines));
    expect(outputs.rows.map((r) => [r.dept, r.account, r.total, r.sources, r.blockLabels])).toEqual(
      expected.map((r) => [r.dept, r.account, r.total, r.sources, r.blockLabels])
    );
    expect(readResultsCacheStamp(valuesDb, SCOPE, SCENARIO).count).toBe(0);
  });

  it("keeps a synced plan that has a run header but no lines at rows: []", () => {
    valuesDb
      .prepare(
        `INSERT INTO engine_runs (ou, scenario_id, fingerprint, computed_at, line_count, position_count)
         VALUES (?, ?, 'remote', ?, 40, 3)`
      )
      .run(SCOPE.ou, SCENARIO, NOW);
    const outputs = readOutputs(structureDb, valuesDb, SCOPE, SCENARIO);
    expect(outputs.run).toEqual({ computedAt: NOW, lineCount: 40, positionCount: 3 });
    expect(outputs.rows).toEqual([]);
  });

  it("answers run: null for a scenario that was never calculated", () => {
    expect(readOutputs(structureDb, valuesDb, SCOPE, "never")).toEqual({
      run: null,
      stale: false,
      rows: [],
    });
  });

  it("scopes the cache to the hotel", () => {
    run(mixedLines());
    const other = resolveOuScope("OU99999");
    expect(readResultsCache(valuesDb, other, SCENARIO)).toEqual([]);
    expect(readOutputs(structureDb, valuesDb, other, SCENARIO).run).toBeNull();
    expect(bareDept("D0410")).toBe("0410");
    expect(bareAccount("A1")).toBe("1");
  });
});
