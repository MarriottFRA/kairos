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
 * Cost: compile is O(positions × definitions) with no allocation in the hot
 * loop; at realistic scale a full run is single-digit milliseconds, so a
 * plain useMemo over (rows, structure, calendar) needs no debounce.
 */

import { CalendarYear } from "../calendar";
import { BlockDto } from "../blocks/ipc";
import { buildCalendarContext } from "../engine/calendarContext";
import { compile } from "../engine/compile";
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
  buildBankHolidayDefinition,
  injectKpiSeries,
  KpiSeriesSlice,
  resolveBlockValues,
} from "./engineInput";
import { rowToComponentValues } from "./blockRows";
import { PositionRow, rowToEnginePosition } from "./rowModel";

export interface BlockLineResult {
  months: number[];
  total: number;
}

/** rowId → componentDefId → line result (cost AND stat defs of each block). */
export type BlockResultsById = Map<string, Map<string, BlockLineResult>>;

export interface LiveSimResult {
  results: BlockResultsById;
  /** Compile errors, when the structure is currently invalid (cycle etc.). */
  errors: CompileError[] | null;
}

const EMPTY: LiveSimResult = { results: new Map(), errors: null };

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
}): LiveSimResult {
  const { rows, blocks, definitions, ssSchemes, calendarYear, scenarioId } = args;
  if (blocks.length === 0 || rows.length === 0 || !calendarYear) return EMPTY;

  // Inactive rows are excluded exactly like the budget loader excludes them —
  // a retained-but-not-budgeted position shows no block totals.
  const positions = rows
    .filter((row) => row.active !== false)
    .map((row) => rowToEnginePosition(row, scenarioId));
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
        accountCode: record.accountCode ?? undefined,
        statsAccountCode: record.statsAccountCode ?? undefined,
        updatedAt: "",
        deletedAt: null,
      })
    )
  );
  injectKpiSeries(defs, positions, componentValues, args.kpiSeries);
  const resolvedValues = resolveBlockValues(
    defs,
    componentValues,
    blocks.map((block) => ({
      costDefId: block.costDefId,
      accountLocked: block.accountLocked,
      statsAccountLocked: block.statsAccountLocked,
    }))
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
    calendar: buildCalendarContext(calendarYear),
    definitions: defs,
    ssSchemes,
    positions,
    componentValues: resolvedValues,
    buyouts: [],
  };

  const compiled = compile(input);
  if ("errors" in compiled) return { results: new Map(), errors: compiled.errors };
  const simulation = simulate(compiled.plan);

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
  return { results, errors: null };
}
