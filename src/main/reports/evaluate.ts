/**
 * Evaluate a report for (hotel, columns) — the main-process glue between the
 * shared engine and the two stores.
 *
 * Each series column names one set of values, and this module decides what
 * an atom's `source` means under it:
 *
 *   bst     the column's bucket, for every atom — except one pinned to
 *           Kairos, which reads `relativeTo`'s results cache (or nothing, with
 *           SCENARIO_MISSING). The default "Budget" column.
 *   plan    the scenario's results laid over its bucket (planSource.ts) for
 *           every atom whose ref lands on that bucket; a pinned atom reads the
 *           cache; a bst ref aimed at another bucket reads that bucket raw.
 *   kairos  the results cache for kairos refs, the bucket the ref names for
 *           bst refs — the original single-scenario reading.
 *
 * Every source is memoised on its own stamp (cache.ts), so a second evaluation
 * of the same columns is the engine alone. Staleness is the Results page's own
 * fingerprint compare, per scenario, so a report and the page never disagree.
 * The drift check (plan ≠ BST) rides on both `plan` and scenario-relative `bst`
 * columns: the nudge to push belongs on the default view most of all.
 *
 * The same column plan serves the drill-down (`listAtomCombos`): one atom,
 * one column, the entries it summed — resolved by the very context the grid
 * was, so the two cannot disagree.
 */

import type { ClearRuleSet } from "../../shared/bstPush/ipc";
import type Database from "better-sqlite3-multiple-ciphers";
import { collectAtomEntries } from "../../shared/reports/atoms";
import {
  EvaluatedColumn,
  ReportColumnSpec,
  SeriesColumnSpec,
  evaluateColumns,
  isSeriesColumn,
} from "../../shared/reports/columns";
import type { CompiledReport } from "../../shared/reports/compile";
import { findReportDefinition, listReportDefinitions } from "../../shared/reports/definitions";
import { EvaluationContext, evaluateReport } from "../../shared/reports/engine";
import type {
  ReportBstInfo,
  ReportColumnInfo,
  ReportDefinitionDetail,
  ReportDefinitionSummary,
  ReportRunInfo,
  ReportsAtomCombosResponse,
  ReportsEvaluateColumnsResponse,
  ReportsEvaluateResponse,
} from "../../shared/reports/ipc";
import { MapIndex, PlanDrift, UNAVAILABLE_MAP_INDEX, ValueSource } from "../../shared/reports/sources";
import type { ParamValue, ReportWarning, ValueSourceRef } from "../../shared/reports/types";
import * as vec from "../../shared/reports/vec";
import { WEEKLY_HOURS_PARAM } from "../../shared/reports/catalog/staffing";
import { WeeklyHoursInfo, readWeeklyHours, weeklyHoursParam } from "../../shared/reports/weeklyHours";
import { readEffectiveWeek } from "../positions/effectiveWeek";
import { getCurrentImport } from "../budgetImport/repo";
import type { OuScope } from "../positions/ouScope";
import { computeFingerprint } from "../positions/outputsRepo";
import { prepared } from "../positions/stmtCache";
import { BstOverride, getBstSource } from "./bstSource";
import { getMapIndex, readMappingVersion } from "./mapsIndex";
import { BuiltinParamValues, ParamDeps, resolveBuiltinParams } from "./params";
import { getPlanSource } from "./planSource";
import { getResultsSource } from "./resultsSource";

type Db = InstanceType<typeof Database>;
const WEEKLY_HOURS_PARAM_ID = WEEKLY_HOURS_PARAM.id;
type BstRef = Extract<ValueSourceRef, { source: "bst" }>;

export interface ReportDbs {
  localDb: Db;
  secureDb: Db;
}

export interface EvaluateOptions {
  bst?: BstOverride;
}

export interface EvaluateColumnsOptions extends EvaluateOptions {
  /** The saved push clear rules and exceptions — what the plan overlay removes. */
  clearRules: ClearRuleSet;
  /** Request-level param values; win over the built-ins. */
  params?: Record<string, ParamValue>;
  /** Hotel-year setup readers for the built-in params; absent = built-in defaults. */
  deps?: ParamDeps;
}

function scenarioYear(localDb: Db, scope: OuScope, scenarioId: string): number {
  const row = prepared(
    localDb,
    `SELECT year FROM scenarios WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(scenarioId, scope.ou) as { year: number } | undefined;
  if (!row) throw new Error("The scenario does not exist for this hotel.");
  return Number(row.year);
}

function bucketYear(localDb: Db, ou: string, index: number): number | null {
  try {
    return getCurrentImport(localDb, ou)?.buckets.find((b) => b.index === index)?.year ?? null;
  } catch {
    return null;
  }
}

export function resolveCompiled(target: string | CompiledReport): CompiledReport {
  if (typeof target !== "string") return target;
  const compiled = findReportDefinition(target);
  if (!compiled) throw new Error(`Unknown report "${target}".`);
  return compiled;
}

/** The bucket a column reads: its own spec, with an atom's explicit bucket
 *  or year offset layered on top. */
function bucketRefFor(column: Extract<SeriesColumnSpec["series"], { kind: "bst" }>, atom: BstRef): BstRef {
  const ref: BstRef = { source: "bst" };
  const bucket = { ...(column.bucket ?? {}), ...(atom.bucket ?? {}) };
  if (Object.keys(bucket).length > 0) ref.bucket = bucket;
  const offset = (atom.yearOffset ?? 0) + (column.yearOffset ?? 0);
  if (offset !== 0) ref.yearOffset = offset;
  return ref;
}

/** The scenario-year budget bucket the plan overlay sits on. */
const PLAN_BUCKET: BstRef = { source: "bst", bucket: { type: "BUDGET" } };

export interface ColumnPlan {
  compiled: CompiledReport;
  maps: MapIndex;
  infos: Map<string, ReportColumnInfo>;
  contextFor: (spec: SeriesColumnSpec) => EvaluationContext;
  loadMs: number;
}

/**
 * Resolve every series column's scenario, year and params up front (the
 * built-in params are async; the engine is not), and hand back the context
 * builder the engine — or the drill-down, or the pack's universe — evaluates
 * under.
 */
export async function planColumns(
  dbs: ReportDbs,
  scope: OuScope,
  compiled: CompiledReport,
  columns: readonly ReportColumnSpec[],
  options: EvaluateColumnsOptions
): Promise<ColumnPlan> {
  const { localDb, secureDb } = dbs;
  const runs = new Map<string, ReportRunInfo | null>();
  const years = new Map<string, number>();
  const params = new Map<number, BuiltinParamValues>();

  const yearOf = (scenarioId: string): number => {
    let year = years.get(scenarioId);
    if (year === undefined) years.set(scenarioId, (year = scenarioYear(localDb, scope, scenarioId)));
    return year;
  };
  const runOf = (scenarioId: string): ReportRunInfo | null => {
    if (!runs.has(scenarioId)) {
      const results = getResultsSource(secureDb, scope, scenarioId);
      runs.set(
        scenarioId,
        results.run
          ? {
              computedAt: results.run.computedAt,
              stale:
                results.predatesCache ||
                computeFingerprint(localDb, secureDb, scope, scenarioId) !== results.run.fingerprint,
            }
          : null
      );
    }
    return runs.get(scenarioId)!;
  };

  const loadStart = performance.now();
  const needsMaps = [...compiled.atomsUsed].some((id) => compiled.atoms.get(id)!.usesMaps);
  const maps = needsMaps ? getMapIndex(localDb) : UNAVAILABLE_MAP_INDEX;
  const hasPinned = [...compiled.atomsUsed].some((id) => {
    const source = compiled.atoms.get(id)!.source;
    return source.source === "kairos" && source.pinned === true;
  });

  const infos = new Map<string, ReportColumnInfo>();
  // A bst column's year before its own offset: the offset is applied by
  // bucketRefFor when the bucket is looked up, so it must not be in here too.
  const baseYears = new Map<string, number | null>();
  for (const spec of columns) {
    if (!isSeriesColumn(spec)) continue;
    const series = spec.series;
    let scenarioId: string | null = null;
    let year: number | null = null;
    if (series.kind === "bst") {
      scenarioId = series.relativeTo ?? null;
      let base: number | null = null;
      if (series.year !== undefined) base = series.year;
      else if (scenarioId) base = yearOf(scenarioId);
      else if (series.bucket?.index) base = bucketYear(localDb, scope.ou, series.bucket.index);
      baseYears.set(spec.id, base);
      year = base === null ? null : base + (series.yearOffset ?? 0);
    } else {
      scenarioId = series.scenarioId;
      year = yearOf(scenarioId);
      baseYears.set(spec.id, year);
    }
    infos.set(spec.id, { scenarioId, year, run: null, bst: [], drift: null, weeklyHours: null });
    if (year !== null && compiled.paramsUsed.size > 0 && !params.has(year)) {
      params.set(year, await resolveBuiltinParams(options.deps, scope.ou, year));
    }
  }
  // "This year" for the weekly-hours fallback: the scenario the column set
  // is about — the first column that names one.
  const anchor = [...infos.values()].find((info) => info.scenarioId && info.year !== null) ?? null;
  if (anchor?.year !== undefined && anchor.year !== null && compiled.paramsUsed.size > 0 && !params.has(anchor.year)) {
    params.set(anchor.year, await resolveBuiltinParams(options.deps, scope.ou, anchor.year));
  }
  // The effective week the anchor scenario WOULD post, derived from its
  // positions — the fallback between "read off a source" and "the setup
  // alone". Async (it loads the scenario input), so it is resolved here,
  // and only when no source of the scenario's year already carries the row:
  // after a run the results hold it and the load is skipped.
  let derivedWeek: WeeklyHoursInfo | null = null;
  if (anchor?.scenarioId && anchor.year !== null && compiled.paramsUsed.has(WEEKLY_HOURS_PARAM_ID) && options.deps) {
    const posted =
      readWeeklyHours(getBstSource(localDb, scope.ou, anchor.year, PLAN_BUCKET, options.bst).source) ??
      readWeeklyHours(getResultsSource(secureDb, scope, anchor.scenarioId).source);
    if (posted === null) {
      const { derivation } = await readEffectiveWeek(dbs, scope, anchor.scenarioId, options.deps);
      if (derivation.effectiveWeek > 0) derivedWeek = { value: derivation.effectiveWeek, origin: "derived", derivation };
    }
  }
  const loadMs = performance.now() - loadStart;

  const contextFor = (spec: SeriesColumnSpec): EvaluationContext => {
    const series = spec.series;
    const info = infos.get(spec.id)!;
    const warnings: ReportWarning[] = [];
    const bstInfos = new Set<string>();
    const noteBst = (bst: ReportBstInfo | null) => {
      if (!bst) return;
      const key = `${bst.importId}|${bst.bucketIndex}`;
      if (bstInfos.has(key)) return;
      bstInfos.add(key);
      info.bst.push(bst);
    };
    const bucketSource = (year: number, ref: BstRef, warn: (w: ReportWarning) => void): ValueSource | null => {
      const load = getBstSource(localDb, scope.ou, year, ref, options.bst);
      if (load.warning) warn(load.warning);
      noteBst(load.info);
      return load.source;
    };
    const cacheOf = (scenarioId: string | null, warn: (w: ReportWarning) => void): ValueSource | null => {
      if (!scenarioId) {
        warn({
          code: "SCENARIO_MISSING",
          message: "A Kairos-only line needs a scenario; this column names none.",
        });
        return null;
      }
      return getResultsSource(secureDb, scope, scenarioId).source;
    };

    let getSource: EvaluationContext["getSource"];
    let drift: PlanDrift | null = null;

    if (series.kind === "plan") {
      const year = info.year!;
      const plan = getPlanSource(dbs, scope, series.scenarioId, year, PLAN_BUCKET, options.clearRules, options.bst);
      warnings.push(...plan.warnings);
      noteBst(plan.bst);
      drift = plan.drift;
      getSource = (ref, warn) => {
        if (ref.source === "kairos") return ref.pinned ? plan.results.source : plan.source;
        // A bst ref aimed at the plan's own bucket reads the overlay; any
        // other bucket (LY inside a formula) reads raw.
        const load = getBstSource(localDb, scope.ou, year, ref, options.bst);
        if (load.info && plan.bst && load.info.bucketIndex === plan.bst.bucketIndex) return plan.source;
        if (load.warning) warn(load.warning);
        noteBst(load.info);
        return load.source;
      };
    } else if (series.kind === "kairos") {
      const results = getResultsSource(secureDb, scope, series.scenarioId);
      warnings.push(...results.warnings);
      getSource = (ref, warn) =>
        ref.source === "kairos" ? results.source : bucketSource(info.year!, ref, warn);
    } else {
      const year = baseYears.get(spec.id) ?? 0;
      if (hasPinned && series.relativeTo) {
        warnings.push(...getResultsSource(secureDb, scope, series.relativeTo).warnings);
      }
      // The nudge: a scenario-relative bucket for the scenario's own year is
      // exactly what a push would overwrite.
      if (series.relativeTo && series.year === undefined && !(series.yearOffset ?? 0) && !series.bucket?.index) {
        const plan = getPlanSource(dbs, scope, series.relativeTo, year, PLAN_BUCKET, options.clearRules, options.bst);
        drift = plan.drift;
        const nudge = plan.warnings.find((w) => w.code === "PLAN_NOT_PUSHED");
        if (nudge) warnings.push(nudge);
      }
      getSource = (ref, warn) => {
        if (ref.source === "kairos") {
          if (ref.pinned) return cacheOf(series.relativeTo ?? null, warn);
          return bucketSource(year, bucketRefFor(series, { source: "bst" }), warn);
        }
        return bucketSource(year, bucketRefFor(series, ref), warn);
      };
    }

    info.drift = drift;
    if (info.scenarioId) info.run = runOf(info.scenarioId);

    const builtins = info.year !== null ? params.get(info.year) : undefined;

    // The effective work week, in this order: the column's own source (the
    // D0410 / A988112 row, January only), then — a prior year with no such
    // row — the scenario year's BST budget, the scenario's own results, then
    // the week derived from the scenario's positions (with a warning: it
    // should be posted so every report divides by the same figure), and last
    // the hotel-year setup alone, as the built-ins resolved it. Read once
    // per column.
    let weeklyHours: WeeklyHoursInfo | undefined;
    const swallow = (_warning: ReportWarning): void => undefined;
    const resolveWeeklyHours = (): WeeklyHoursInfo => {
      if (weeklyHours) return weeklyHours;
      const own = readWeeklyHours(getSource({ source: "kairos" }, swallow));
      if (own !== null) return (weeklyHours = { value: own, origin: "column" });
      if (anchor?.scenarioId && anchor.year !== null) {
        const bst = readWeeklyHours(getBstSource(localDb, scope.ou, anchor.year, PLAN_BUCKET, options.bst).source);
        if (bst !== null) return (weeklyHours = { value: bst, origin: "scenario_bst" });
        const results = readWeeklyHours(getResultsSource(secureDb, scope, anchor.scenarioId).source);
        if (results !== null) return (weeklyHours = { value: results, origin: "scenario_results" });
      }
      if (derivedWeek) {
        warnings.push({
          code: "WEEKLY_HOURS_NOT_POSTED",
          message:
            `The effective week (${derivedWeek.value.toFixed(2)}h) was derived from the scenario's positions because ` +
            "no results or BST budget carries it yet. Calculate the scenario and push it so every report, here and " +
            "in the company's own, divides by the same posted figure.",
        });
        return (weeklyHours = derivedWeek);
      }
      const setup = (anchor?.year !== null && anchor?.year !== undefined ? params.get(anchor.year) : builtins)?.weekly_hours;
      const value = typeof setup === "number" ? setup : (setup?.total ?? setup?.months[0] ?? 0);
      return (weeklyHours = { value, origin: "setup" });
    };

    // Resolved up front when the report reads the week (and nothing typed
    // overrides it): the engine copies the context's warnings before it asks
    // for any param, so a "derived, not posted" warning raised lazily inside
    // getParam would never reach the column.
    if (compiled.paramsUsed.has(WEEKLY_HOURS_PARAM_ID) && options.params?.[WEEKLY_HOURS_PARAM_ID] === undefined) {
      info.weeklyHours = resolveWeeklyHours();
    }

    return {
      maps,
      warnings,
      getSource,
      getParam: (param) => {
        const override = options.params?.[param.id];
        if (override !== undefined) {
          if (param.builtin === "weekly_hours") info.weeklyHours = { value: vec.fromParam(override)[0], origin: "override" };
          return override;
        }
        if (param.builtin === "weekly_hours") {
          info.weeklyHours = resolveWeeklyHours();
          return weeklyHoursParam(info.weeklyHours.value);
        }
        if (param.builtin && builtins) return builtins[param.builtin];
        return null;
      },
    };
  };

  return { compiled, maps, infos, contextFor, loadMs };
}

export async function evaluateReportColumns(
  dbs: ReportDbs,
  scope: OuScope,
  target: string | CompiledReport,
  columns: readonly ReportColumnSpec[],
  options: EvaluateColumnsOptions
): Promise<ReportsEvaluateColumnsResponse> {
  const compiled = resolveCompiled(target);
  const plan = await planColumns(dbs, scope, compiled, columns, options);

  const evaluateStart = performance.now();
  const grid = evaluateColumns(compiled, columns, plan.contextFor);
  const evaluateMs = performance.now() - evaluateStart;

  const withInfo = grid.columns.map((column): EvaluatedColumn & ReportColumnInfo => ({
    ...column,
    ...(plan.infos.get(column.id) ?? { scenarioId: null, year: null, run: null, bst: [], drift: null, weeklyHours: null }),
  }));

  return {
    ...grid,
    columns: withInfo,
    mappingVersion: readMappingVersion(dbs.localDb),
    timings: { loadMs: plan.loadMs, evaluateMs },
  };
}

/** The entries one atom summed under one series column. */
export async function listAtomCombos(
  dbs: ReportDbs,
  scope: OuScope,
  target: string | CompiledReport,
  atomId: string,
  column: SeriesColumnSpec,
  options: EvaluateColumnsOptions
): Promise<ReportsAtomCombosResponse> {
  const compiled = resolveCompiled(target);
  const atom = compiled.atoms.get(atomId);
  const declared = compiled.definition.atoms.find((a) => a.id === atomId);
  if (!atom || !declared) throw new Error(`Unknown atom "${atomId}".`);

  const plan = await planColumns(dbs, scope, compiled, [column], options);
  const context = plan.contextFor(column);
  const warnings: ReportWarning[] = [...(context.warnings ?? [])];
  const warn = (warning: ReportWarning) => {
    warnings.push(warning);
  };
  const source = context.getSource(atom.source, warn);
  // Always the real index here: the names are wanted even for a base-only atom.
  const maps = atom.usesMaps ? plan.maps : getMapIndex(dbs.localDb);
  const names = getMapIndex(dbs.localDb);

  const entries = source ? collectAtomEntries(atom, source, maps, warn) : [];
  const total = vec.zero();
  const combos = entries.map((entry) => {
    vec.addInto(total, entry.reportVec);
    return {
      dept: entry.dept,
      account: entry.account,
      deptName: names.name("dept", entry.dept),
      accountName: names.name("account", entry.account),
      values: vec.toArray(entry.reportVec),
      encoding: entry.encoding,
    };
  });

  return {
    atomId,
    label: declared.label ?? atomId,
    filters: declared.filters,
    negate: atom.negate,
    sourceId: source?.id ?? null,
    combos,
    total: vec.toArray(atom.negate ? vec.neg(total) : total),
    warnings,
  };
}

export function getReportDefinitionDetail(definitionId: string): ReportDefinitionDetail {
  const compiled = resolveCompiled(definitionId);
  const refs: Record<string, string[]> = {};
  for (const [id, measure] of compiled.measures) refs[id] = [...measure.refs];
  return { definition: compiled.definition, refs };
}

/**
 * The original single-scenario reading, kept for callers and tests that want
 * one set of values: kairos refs off the cache, bst refs off the bucket the
 * ref names for the scenario's year.
 */
export function evaluateReportForScenario(
  dbs: ReportDbs,
  scope: OuScope,
  scenarioId: string,
  target: string | CompiledReport,
  options: EvaluateOptions = {}
): ReportsEvaluateResponse {
  const compiled = resolveCompiled(target);
  const { localDb, secureDb } = dbs;
  const year = scenarioYear(localDb, scope, scenarioId);

  const loadStart = performance.now();
  const results = getResultsSource(secureDb, scope, scenarioId);
  const needsMaps = [...compiled.atomsUsed].some((id) => compiled.atoms.get(id)!.usesMaps);
  const maps = needsMaps ? getMapIndex(localDb) : UNAVAILABLE_MAP_INDEX;
  const loadMs = performance.now() - loadStart;

  const bst: ReportBstInfo[] = [];
  const bstInfoKeys = new Set<string>();
  const warnings: ReportWarning[] = compiled.sourceKinds.has("kairos") ? [...results.warnings] : [];

  const evaluateStart = performance.now();
  const report = evaluateReport(compiled, {
    maps,
    warnings,
    getSource: (ref, warn) => {
      if (ref.source === "kairos") return results.source;
      const load = getBstSource(localDb, scope.ou, year, ref, options.bst);
      if (load.warning) warn(load.warning);
      if (load.info) {
        const key = `${load.info.importId}|${load.info.bucketIndex}`;
        if (!bstInfoKeys.has(key)) {
          bstInfoKeys.add(key);
          bst.push(load.info);
        }
      }
      return load.source;
    },
  });
  const evaluateMs = performance.now() - evaluateStart;

  const run = results.run
    ? {
        computedAt: results.run.computedAt,
        stale:
          results.predatesCache ||
          computeFingerprint(localDb, secureDb, scope, scenarioId) !== results.run.fingerprint,
      }
    : null;

  return {
    ...report,
    scenarioId,
    year,
    run,
    mappingVersion: readMappingVersion(localDb),
    bst,
    timings: { loadMs, evaluateMs },
  };
}

export function listReportDefinitionSummaries(): ReportDefinitionSummary[] {
  return listReportDefinitions().map((compiled) => ({
    id: compiled.definition.id,
    name: compiled.definition.name,
    description: compiled.definition.description ?? "",
    sources: [...compiled.sourceKinds],
    params: [...compiled.params.values()].map((p) => ({
      id: p.id,
      label: p.label ?? p.id,
      builtin: p.builtin ?? null,
      unit: p.unit ?? null,
    })),
  }));
}
