/**
 * Renderer-side live simulation — per-row block totals as the user types.
 * -----------------------------------------------------------
 * Assembles a real engine ScenarioInput from the LIVE grid rows (not the
 * store, which lags the write queue's debounce), runs the same compile() +
 * simulate() the budget uses, and returns each block line's months/total per
 * position. The heavy pieces are all shared with the main-process loader:
 * rowToEnginePosition, the engineInput resolution (KPI series, dual blocks,
 * bank holiday), and the VM itself — so the grid can never disagree with a
 * persisted run over the same data.
 *
 * Cost: compile and simulate are both O(positions × definitions), and at the
 * ~160 positions a hotel actually has (see shared/legacyImport/ipc.ts) the pair
 * costs a low single-digit number of milliseconds — so a plain useMemo over
 * (rows, structure, calendar) needs no debounce. A hotel nearing ~1,000 rows
 * crosses into "you can feel it". Don't take that on trust: every run returns
 * `timings`, and the Positions page logs them in dev.
 */

import { CalendarYear } from "../calendar";
import { BlockDto } from "../blocks/ipc";
import { buildCalendarContext } from "../engine/calendarContext";
import { compileStructure, packPlan } from "../engine/compile";
import type { PlanStructure } from "../engine/compile";
import { describeStructureDrift, structureKey } from "../engine/structureKey";
import { simulate } from "../engine/simulate";
import {
  CompileError,
  ComponentDefId,
  ComponentValue,
  CostComponentDefinition,
  PositionId,
  ScenarioInput,
  SocialSecurityScheme,
} from "../engine/types";
import {
  applyPositionAccounts,
  applyRateRules,
  applyRuleRateDependencies,
  applySocialSecurityBase,
  buildBankHolidayDefinition,
  injectKpiSeries,
  KpiSeriesSlice,
  readPositionAccounts,
  resolveBlockValues,
} from "./engineInput";
import { serviceDaysFor } from "./serviceDays";
import {
  EMPTY_FULL_TIME_REFERENCE,
  FullTimeReference,
} from "../positionDefaults";
import { HotelClusterDto } from "../hotelClusters/ipc";
import {
  clusterMapById,
  resolveHotelClusterWeight,
} from "../hotelClusters/resolve";
import { applyPoolSpread, buildPoolSpecs } from "./poolSpread";
import { rowToComponentValues } from "./blockRows";
import {
  HOTEL_CLUSTER_KEY,
  HOTEL_CLUSTER_MULT_KEY,
  HOTEL_CLUSTER_NAME_SNAPSHOT_KEY,
  HOTEL_CLUSTER_WEIGHT_SNAPSHOT_KEY,
} from "./fields";
import { PositionRow, rowToEnginePosition } from "./rowModel";

export interface BlockLineResult {
  months: number[];
  total: number;
}

/** rowId → componentDefId → line result (cost AND stat defs of each block). */
export type BlockResultsById = Map<string, Map<string, BlockLineResult>>;

/**
 * What one live run cost, so the claim in this file's header can be checked
 * rather than believed. `simulate()` already measures its own two phases and
 * threw them away until now; `inputMs` is everything before compile (row →
 * engine position, block values, KPI injection, pool spread), which is the part
 * no bench covers and the part that grows when the page gains a feature.
 *
 * Read by a DEV-only log on the Positions page. Populated on every run — the
 * numbers cost two `performance.now()` calls and shipping them means a future
 * "is the engine still fast" question is one console line, not an afternoon.
 */
export interface LiveSimTimings {
  rows: number;
  positions: number;
  blocks: number;
  inputMs: number;
  /** Structure (when rebuilt) + pack. `structureReused` says which. */
  compileMs: number;
  /** True when the cached structure was reused — i.e. this was a value-only
   *  edit and only the params were repacked. */
  structureReused: boolean;
  execMs: number;
  aggMs: number;
  totalMs: number;
}

export interface LiveSimResult {
  results: BlockResultsById;
  /** Compile errors, when the structure is currently invalid (cycle etc.). */
  errors: CompileError[] | null;
  /** Absent only on the early-out paths (no blocks, no rows, no calendar). */
  timings?: LiveSimTimings;
}

const EMPTY: LiveSimResult = { results: new Map(), errors: null };

/**
 * A compiled structure held across edits, so a value-only edit skips phase A.
 *
 * Owned by the CALLER (a useRef on the Positions page), never module state:
 * module state would leak across scenarios, hotels and test files, and this
 * function would stop being a pure function of its arguments — which is what
 * liveSimParity relies on to compare it against the main-process loader.
 *
 * Pass the same object on every call and it fills itself in. Set `.entry` to
 * null — or simply pass a fresh object — to force a full compile; that is what
 * the "Refresh totals" action does.
 *
 * SAFETY: this cache only ever feeds the GRID. The persisted budget compiles
 * fresh in the main process from SQLite on every recalculate (main/positions/
 * runRecalc), so a stale structure here could show a wrong number in a cell but
 * cannot write one into the budget, the Results page or a BST push. Do not
 * "optimize" runRecalc by sharing this.
 */
export interface LiveSimCache {
  entry: { key: string; structure: PlanStructure; scope: string } | null;
}

export function createLiveSimCache(): LiveSimCache {
  return { entry: null };
}

function toFiniteOrNull(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && value !== null && value !== "" ? num : null;
}

export function runLiveSim(args: {
  rows: PositionRow[];
  blocks: BlockDto[];
  /** Raw definitions from blocks:list (NOT loader-rewritten). */
  definitions: CostComponentDefinition[];
  ssSchemes: SocialSecurityScheme[];
  /** The scenario-year calendar record; null while loading. */
  calendarYear: CalendarYear | null;
  /** driverId → cached KPI series (renderer's kpiDrivers list). */
  kpiSeries: (driverId: string) => KpiSeriesSlice[];
  scenarioId: string;
  ou: string;
  /** Hotel-cluster definitions (cross-OU reference data); omitted/empty means
   *  every assignment resolves DANGLING → weight 1. */
  hotelClusters?: HotelClusterDto[];
  /** The hotel-year full-time yardstick every row's FTE is derived against
   *  (mirror of loadScenarioInput). Omitted leaves every FTE at 0, which an
   *  FTE-based pool spread would read as "nobody has a share". */
  fullTime?: FullTimeReference;
  /** Optional structure cache (see LiveSimCache). Omitted = always a full
   *  compile, which is what every test and the parity suite do. */
  cache?: LiveSimCache;
}): LiveSimResult {
  const { rows, blocks, definitions, ssSchemes, calendarYear, scenarioId } = args;
  if (blocks.length === 0 || rows.length === 0 || !calendarYear) return EMPTY;
  const startedAt = performance.now();

  // Hotel-cluster resolution: overlay the resolved cluster NAME (the stats
  // rollup key) and this hotel's WEIGHT onto the per-unit row mapping — the
  // exact mirror of loadScenarioInput (liveSimParity pins the two together).
  const clusterById = clusterMapById(args.hotelClusters ?? []);

  // Built once: the overlay below derives Manhours Worked from it, and the
  // ScenarioInput reuses the same instance.
  const calendar = buildCalendarContext(calendarYear);

  // Inactive rows are excluded exactly like the budget loader excludes them —
  // a retained-but-not-budgeted position shows no block totals.
  const positions = rows
    .filter((row) => row.active !== false)
    .map((row) => {
      // The calendar makes this the FULL engine-input assembly: rowToEnginePosition
      // runs applyInputBasis, which restates the row's yearly figures (fte, worked
      // hours, vacation, manual increase, accrual rate) for its Input Basis —
      // the mirror of loadScenarioInput that liveSimParity pins.
      const position = rowToEnginePosition(
        row,
        scenarioId,
        args.fullTime ?? EMPTY_FULL_TIME_REFERENCE,
        calendar
      );
      const resolved = resolveHotelClusterWeight(
        args.ou,
        typeof row[HOTEL_CLUSTER_KEY] === "string"
          ? (row[HOTEL_CLUSTER_KEY] as string)
          : "",
        toFiniteOrNull(row[HOTEL_CLUSTER_MULT_KEY]),
        clusterById,
        // The travelling ratio — mirror of loadScenarioInput (liveSimParity).
        {
          weight: toFiniteOrNull(row[HOTEL_CLUSTER_WEIGHT_SNAPSHOT_KEY]),
          name:
            typeof row[HOTEL_CLUSTER_NAME_SNAPSHOT_KEY] === "string"
              ? (row[HOTEL_CLUSTER_NAME_SNAPSHOT_KEY] as string)
              : null,
        }
      );
      position.cluster = resolved.clusterName;
      position.hotelClusterWeight = resolved.weight;
      // Length of service from the row's hiring date, for the SERVICE bases.
      // Mirror of loadScenarioInput; serviceDaysParity pins the two.
      const service = serviceDaysFor(
        typeof row.hiringDate === "string" ? row.hiringDate : null,
        calendarYear.year
      );
      position.serviceDaysPerMonth = service.perMonth;
      position.serviceDaysOpening = service.opening;
      return position;
    });
  if (positions.length === 0) return EMPTY;

  // Clone defs before resolution: injectKpiSeries rewrites spreadMethod in
  // place, and the raw definitions live in React state.
  const defs: CostComponentDefinition[] = definitions.map((def) => ({
    ...def,
    baseSelector:
      def.baseSelector?.kind === "COMPONENTS"
        ? { kind: "COMPONENTS", componentIds: [...def.baseSelector.componentIds] }
        : def.baseSelector,
  }));
  const bankHolidayDef = buildBankHolidayDefinition(args.ou, calendarYear);
  if (bankHolidayDef) defs.push(bankHolidayDef);
  // Fill each NI scheme's contributory base from its own base membership (mirror
  // of loadScenarioInput — liveSimParity pins the two).
  applySocialSecurityBase(defs, ssSchemes);
  // Topo edges for block-valued rule multipliers (mirror of loadScenarioInput).
  applyRuleRateDependencies(defs, blocks);

  // Rebuild component values from the live rows (one source of truth), then
  // run the same shared resolution the loader applies.
  const componentValues: ComponentValue[] = rows.flatMap((row) =>
    rowToComponentValues(row, blocks).map(
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
        updatedAt: "",
        deletedAt: null,
      })
    )
  );
  // Derive each row's rate for rules-driven multiplier blocks BEFORE the KPI
  // injection (mirror of loadScenarioInput — liveSimParity pins the two). The
  // live row IS the flat bag — u_* extras AND the PII columns sit at the top
  // level (toRow merges them), the same contract readPositionAccounts ships
  // under, so PII-referencing rules read the same values the main loader
  // merges from position_pii.
  const rowById = new Map<string, Record<string, unknown>>(
    rows.filter((row) => row.active !== false).map((row) => [String(row.id), row])
  );
  const ruledValues = applyRateRules(
    blocks
      .filter((block) => block.blockType === "MULTIPLIER" && block.rateRules)
      .map((block) => ({ costDefId: block.costDefId, config: block.rateRules! })),
    positions,
    rowById,
    componentValues,
    { kpiSeries: args.kpiSeries }
  );
  injectKpiSeries(defs, positions, ruledValues, args.kpiSeries);
  const resolvedValues = resolveBlockValues(
    defs,
    ruledValues,
    blocks.map((block) => ({
      costDefId: block.costDefId,
      accountLocked: block.accountLocked,
      statsAccountLocked: block.statsAccountLocked,
      departmentPerRow: block.departmentMode === "PER_ROW",
    }))
  );
  // Divide each pooled block's pot across its eligible positions (mirror of
  // loadScenarioInput). Note this runs over the LIVE rows, so ticking someone
  // into the pool immediately reduces everyone else's share in the grid.
  const pooledValues = applyPoolSpread(
    buildPoolSpecs(blocks, args.kpiSeries),
    positions,
    resolvedValues
  );
  // Mirror of loadScenarioInput. The accounts themselves never move a number —
  // they only pick the aggregation key, and this sim reports block lines, not
  // output rows. What matters here is the vacation-cost head's rate: without it
  // a block using vacation cost as its base would show 0 in the grid while the
  // persisted run showed the real figure.
  const valuesWithAccounts = applyPositionAccounts(
    args.ou,
    pooledValues,
    new Map(
      rows
        .filter((row) => row.active !== false)
        .map(
          (row) =>
            [
              row.id,
              readPositionAccounts(row, String(row.jobTypeCode ?? "")),
            ] as const
        )
    )
  );

  const input: ScenarioInput = {
    scenario: {
      id: scenarioId as ScenarioInput["scenario"]["id"],
      ou: args.ou,
      year: calendarYear.year,
      label: "",
      updatedAt: "",
      deletedAt: null,
    },
    calendar,
    definitions: defs,
    ssSchemes,
    positions,
    componentValues: valuesWithAccounts,
    buyouts: [],
  };

  const compileStart = performance.now();

  // Phase A (validate, topological order, the interned dimensions) is reused
  // while the plan's SHAPE is unchanged; phase B — every number — always runs.
  // Both paths call the same two functions in the same order, so a cached plan
  // is bit-identical to a freshly compiled one by construction, not by
  // agreement. engine/__tests__/repackParity.test.ts fuzzes that claim.
  const cache = args.cache;
  // The cache must never outlive the data it was built from: a different hotel
  // or scenario is a different plan entirely, whatever the key says.
  const scope = `${args.ou}|${scenarioId}|${calendarYear.year}`;
  const key = cache ? structureKey(input) : "";
  let structure: PlanStructure;
  let structureReused = false;

  if (cache?.entry && cache.entry.key === key && cache.entry.scope === scope) {
    structure = cache.entry.structure;
    structureReused = true;
    // In dev, prove it: rebuild the structure and compare what actually matters
    // — which aggregate row every line books to. A key that has fallen behind
    // compileStructure is the one bug here that would otherwise be silent.
    if (import.meta.env.DEV) {
      const rebuilt = compileStructure(input);
      const drift =
        "errors" in rebuilt ? "structure no longer compiles" : describeStructureDrift(structure, rebuilt.structure);
      if (drift) {
        console.error(
          `[liveSim] structureKey reused a stale plan — ${drift}. ` +
            `Falling back to a full compile; this is a bug in shared/engine/structureKey.`
        );
        if ("errors" in rebuilt) return { results: new Map(), errors: rebuilt.errors };
        structure = rebuilt.structure;
        structureReused = false;
        cache.entry = { key, structure, scope };
      }
    }
  } else {
    const built = compileStructure(input);
    if ("errors" in built) return { results: new Map(), errors: built.errors };
    structure = built.structure;
    if (cache) cache.entry = { key, structure, scope };
  }

  const plan = packPlan(input, structure);
  const compileMs = performance.now() - compileStart;
  const simulation = simulate(plan);

  const blockDefIds = new Set<string>();
  for (const block of blocks) {
    blockDefIds.add(block.costDefId);
    if (block.statDefId) blockDefIds.add(block.statDefId);
  }

  const results: BlockResultsById = new Map();
  for (const position of positions) {
    const perDef = new Map<string, BlockLineResult>();
    for (const line of simulation.positionLines(position.id)) {
      const defId = line.component.id as string;
      if (!blockDefIds.has(defId)) continue;
      const months = Array.from(line.months);
      let total = 0;
      for (const value of months) total += value;
      perDef.set(defId, { months, total });
    }
    results.set(position.id as string, perDef);
  }
  return {
    results,
    errors: null,
    timings: {
      rows: rows.length,
      positions: positions.length,
      blocks: blocks.length,
      // Everything before compile: rowToEnginePosition, the cluster/hours/
      // service overlays, block values, KPI injection, pool spread, accounts.
      inputMs: compileStart - startedAt,
      compileMs,
      structureReused,
      execMs: simulation.timings.execMs,
      aggMs: simulation.timings.aggMs,
      totalMs: performance.now() - startedAt,
    },
  };
}
