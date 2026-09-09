/**
 * Report columns — the same definition evaluated against several series, side
 * by side, plus the differences between them.
 *
 * A SERIES names one complete set of values: a raw BST bucket (the default
 * "Budget" column, and LY / LLY), the overlay of a scenario's results on its
 * bucket (`plan`), or a scenario's results alone (`kairos`). The definition is
 * evaluated once per series column — a full Vec13 pass each, so a variance is
 * just two evaluated rows subtracted — and the rows come out as ONE scaffold
 * with row-aligned values per column, which is what a grid and a sheet want.
 *
 * What a series MEANS for an atom's `source` is the caller's business
 * (`contextFor`); this module only knows that one context evaluates one
 * column. See main/reports/evaluate.ts for the resolution.
 *
 * Variance rules (the PS Loader conventions, kept):
 *   abs  a − b
 *   pct  100 × (a − b) ÷ |b| — the absolute denominator so a cost that grew
 *        reads positive whatever the sign convention of the base
 *   pts  a − b, for two percentages
 * A `pct` variance of a percent-format row is silently a `pts` one: "12% vs
 * 10%" is 2 points, not 20%. Variances are computed on raw values; a row's
 * `invertSign` stays display-only, so the UI flips value and variance alike.
 */

import { ID_PATTERN, type CompiledReport } from "./compile";
import { EvaluationContext, evaluateReport } from "./engine";
import type { EvaluatedReport, EvaluatedRow, Format, ReportWarning } from "./types";
import * as vec from "./vec";

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export type BstBucketRef = { type?: string; index?: 1 | 2 | 3 };

export type SeriesRef =
  /** A scenario's results laid over its BST bucket (the "unpushed plan" mode). */
  | { kind: "plan"; scenarioId: string }
  /** A scenario's results alone. */
  | { kind: "kairos"; scenarioId: string }
  /**
   * One BST bucket. The year is `year` outright, or `relativeTo`'s scenario
   * year (+ `yearOffset`), or implied by `bucket.index`. Atoms pinned to
   * Kairos read `relativeTo`'s cache.
   */
  | {
      kind: "bst";
      bucket?: BstBucketRef;
      year?: number;
      relativeTo?: string;
      yearOffset?: number;
    };

export type SeriesKind = SeriesRef["kind"];

export type VarianceMode = "abs" | "pct" | "pts";

export interface VarianceRef {
  /** Column ids; both must be series columns. */
  a: string;
  b: string;
  mode: VarianceMode;
}

export type ReportColumnSpec =
  | { id: string; label?: string; series: SeriesRef }
  | { id: string; label?: string; variance: VarianceRef };

export type SeriesColumnSpec = Extract<ReportColumnSpec, { series: SeriesRef }>;
export type VarianceColumnSpec = Extract<ReportColumnSpec, { variance: VarianceRef }>;

export function isSeriesColumn(spec: ReportColumnSpec): spec is SeriesColumnSpec {
  return "series" in spec && spec.series !== undefined;
}

export class ReportColumnsError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`The report columns are invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ReportColumnsError";
  }
}

const SERIES_KINDS: ReadonlySet<string> = new Set(["plan", "kairos", "bst"]);
const VARIANCE_MODES: ReadonlySet<string> = new Set(["abs", "pct", "pts"]);
const BUCKET_INDEXES: ReadonlySet<number> = new Set([1, 2, 3]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * A column list as the renderer sent it → a validated one, or every problem
 * at once. The payload is untrusted (the same stance as the BST push's
 * option normaliser): ids are checked, kinds are closed sets, and a variance
 * may only name series columns.
 */
export function normalizeColumns(raw: unknown): ReportColumnSpec[] {
  const problems: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ReportColumnsError(["columns must be a non-empty list"]);
  }

  const out: ReportColumnSpec[] = [];
  const seen = new Set<string>();
  const seriesIds = new Set<string>();

  raw.forEach((item, index) => {
    const where = `column ${index + 1}`;
    if (!isRecord(item)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const id = trimmed(item.id);
    if (!ID_PATTERN.test(id)) {
      problems.push(`${where}: id ${JSON.stringify(item.id)} must match ${ID_PATTERN}`);
      return;
    }
    if (seen.has(id)) {
      problems.push(`column id "${id}" is used more than once`);
      return;
    }
    seen.add(id);
    const label = trimmed(item.label) || undefined;

    if (isRecord(item.series)) {
      const series = normalizeSeries(item.series, `column "${id}"`, problems);
      if (series) {
        seriesIds.add(id);
        out.push(label ? { id, label, series } : { id, series });
      }
      return;
    }
    if (isRecord(item.variance)) {
      const { a, b, mode } = item.variance;
      const aId = trimmed(a);
      const bId = trimmed(b);
      const modeText = trimmed(mode);
      if (!aId || !bId) problems.push(`column "${id}": a variance names two columns (a, b)`);
      else if (aId === bId) problems.push(`column "${id}": a variance needs two different columns`);
      if (!VARIANCE_MODES.has(modeText)) {
        problems.push(`column "${id}": variance mode must be one of abs, pct, pts`);
      }
      if (aId && bId && aId !== bId && VARIANCE_MODES.has(modeText)) {
        const variance: VarianceRef = { a: aId, b: bId, mode: modeText as VarianceMode };
        out.push(label ? { id, label, variance } : { id, variance });
      }
      return;
    }
    problems.push(`column "${id}" needs either a series or a variance`);
  });

  for (const spec of out) {
    if (isSeriesColumn(spec)) continue;
    for (const ref of [spec.variance.a, spec.variance.b]) {
      if (!seriesIds.has(ref)) {
        problems.push(`column "${spec.id}": "${ref}" is not a series column`);
      }
    }
  }
  if (seriesIds.size === 0) problems.push("at least one series column is required");

  if (problems.length > 0) throw new ReportColumnsError(problems);
  return out;
}

function normalizeSeries(
  raw: Record<string, unknown>,
  where: string,
  problems: string[]
): SeriesRef | null {
  const kind = trimmed(raw.kind);
  if (!SERIES_KINDS.has(kind)) {
    problems.push(`${where}: series kind must be one of plan, kairos, bst`);
    return null;
  }
  if (kind === "plan" || kind === "kairos") {
    const scenarioId = trimmed(raw.scenarioId);
    if (!scenarioId) {
      problems.push(`${where}: a ${kind} series names a scenarioId`);
      return null;
    }
    return { kind, scenarioId };
  }

  const series: Extract<SeriesRef, { kind: "bst" }> = { kind: "bst" };
  if (raw.bucket !== undefined) {
    if (!isRecord(raw.bucket)) {
      problems.push(`${where}: bucket must be an object`);
      return null;
    }
    const bucket: BstBucketRef = {};
    const type = trimmed(raw.bucket.type);
    if (type) bucket.type = type;
    if (raw.bucket.index !== undefined) {
      const index = Number(raw.bucket.index);
      if (!BUCKET_INDEXES.has(index)) {
        problems.push(`${where}: bucket index must be 1, 2 or 3`);
        return null;
      }
      bucket.index = index as 1 | 2 | 3;
    }
    series.bucket = bucket;
  }
  if (raw.year !== undefined) {
    const year = Number(raw.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      problems.push(`${where}: year must be a four-digit year`);
      return null;
    }
    series.year = year;
  }
  const relativeTo = trimmed(raw.relativeTo);
  if (relativeTo) series.relativeTo = relativeTo;
  if (raw.yearOffset !== undefined) {
    const offset = Number(raw.yearOffset);
    if (!Number.isInteger(offset) || Math.abs(offset) > 10) {
      problems.push(`${where}: yearOffset must be a small integer`);
      return null;
    }
    series.yearOffset = offset;
  }
  if (series.year === undefined && !series.relativeTo && series.bucket?.index === undefined) {
    problems.push(`${where}: a bst series needs a year, a relativeTo scenario or a bucket index`);
    return null;
  }
  return series;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** A row without its values — the scaffold every column shares. */
export type EvaluatedRowMeta = Omit<EvaluatedRow, "values">;

export interface EvaluatedColumn {
  id: string;
  label: string;
  spec: ReportColumnSpec;
  /** Row-aligned with the grid's rows; null for headers and spacers. */
  values: (number[] | null)[];
  /** A variance column's own format per row (pct → "percent" or "pts");
   *  null means the row's format applies. */
  rowFormats: (Format | null)[];
  atoms: Record<string, number[]>;
  params: Record<string, number[]>;
  warnings: ReportWarning[];
}

export interface EvaluatedGrid {
  definitionId: string;
  rows: EvaluatedRowMeta[];
  columns: EvaluatedColumn[];
}

/** One variance figure and the format it prints in. */
export interface VarianceValue {
  value: number | null;
  format: Format;
}

/**
 * The variance rules for ONE pair of figures — what `deriveVariance` does per
 * slot, for a caller holding two displayed numbers (the grid's in-cell
 * difference). `abs` is a − b in the row's format; `pct` is 100 × (a − b) ÷ |b|,
 * or points when the row is itself a percentage. A zero denominator gives no
 * figure, where the vector form gives 0: in a cell, no figure prints as
 * nothing and so do both agree on the page.
 */
export function varianceOf(
  a: number | null | undefined,
  b: number | null | undefined,
  mode: VarianceMode,
  rowFormat: Format
): VarianceValue {
  if (a === null || a === undefined || b === null || b === undefined) return { value: null, format: rowFormat };
  const effective: VarianceMode = mode === "pct" && rowFormat === "percent" ? "pts" : mode;
  switch (effective) {
    case "abs":
      return { value: a - b, format: rowFormat };
    case "pts":
      return { value: a - b, format: "pts" };
    case "pct":
      return Math.abs(b) < vec.DIVIDE_EPSILON
        ? { value: null, format: "percent" }
        : { value: (100 * (a - b)) / Math.abs(b), format: "percent" };
  }
}

export interface DerivedVariance {
  values: (number[] | null)[];
  rowFormats: (Format | null)[];
}

export function deriveVariance(
  a: EvaluatedReport,
  b: EvaluatedReport,
  mode: VarianceMode
): DerivedVariance {
  const values: (number[] | null)[] = [];
  const rowFormats: (Format | null)[] = [];
  a.rows.forEach((row, index) => {
    const other = b.rows[index];
    if (!row.values || !other?.values) {
      values.push(null);
      rowFormats.push(null);
      return;
    }
    const av = Float64Array.from(row.values);
    const bv = Float64Array.from(other.values);
    const effective: VarianceMode = mode === "pct" && row.format === "percent" ? "pts" : mode;
    switch (effective) {
      case "abs":
        values.push(vec.toArray(vec.sub(av, bv)));
        rowFormats.push(null);
        break;
      case "pts":
        values.push(vec.toArray(vec.sub(av, bv)));
        rowFormats.push("pts");
        break;
      case "pct":
        values.push(vec.toArray(vec.pct(vec.sub(av, bv), vec.abs(bv))));
        rowFormats.push("percent");
        break;
    }
  });
  return { values, rowFormats };
}

/**
 * Evaluate one compiled definition under every series column, then derive
 * the variance columns. `contextFor` is asked once per series column.
 */
export function evaluateColumns(
  compiled: CompiledReport,
  columns: readonly ReportColumnSpec[],
  contextFor: (spec: SeriesColumnSpec) => EvaluationContext
): EvaluatedGrid {
  const reports = new Map<string, EvaluatedReport>();
  for (const spec of columns) {
    if (isSeriesColumn(spec)) reports.set(spec.id, evaluateReport(compiled, contextFor(spec)));
  }
  const first = reports.values().next().value as EvaluatedReport | undefined;
  if (!first) throw new ReportColumnsError(["at least one series column is required"]);

  const rows: EvaluatedRowMeta[] = first.rows.map(({ values: _values, ...meta }) => meta);
  const none: (Format | null)[] = rows.map((): Format | null => null);

  const out: EvaluatedColumn[] = columns.map((spec): EvaluatedColumn => {
    if (isSeriesColumn(spec)) {
      const report = reports.get(spec.id)!;
      return {
        id: spec.id,
        label: spec.label ?? spec.id,
        spec,
        values: report.rows.map((row) => row.values),
        rowFormats: none,
        atoms: report.atoms,
        params: report.params,
        warnings: report.warnings,
      };
    }
    const a = reports.get(spec.variance.a);
    const b = reports.get(spec.variance.b);
    if (!a || !b) {
      throw new ReportColumnsError([`column "${spec.id}" refers to a column that was not evaluated`]);
    }
    const derived = deriveVariance(a, b, spec.variance.mode);
    return {
      id: spec.id,
      label: spec.label ?? spec.id,
      spec,
      values: derived.values,
      rowFormats: derived.rowFormats,
      atoms: {},
      params: {},
      warnings: [],
    };
  });

  return { definitionId: compiled.definition.id, rows, columns: out };
}
