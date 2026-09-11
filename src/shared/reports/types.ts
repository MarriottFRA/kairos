/**
 * Report definitions — the data a report IS.
 * -----------------------------------------------------------
 * Three layers, all plain data (no closures), so a definition round-trips
 * through JSON and can live in code today and in a table tomorrow:
 *
 *   rows      what the report shows: headers, spacers, and measure lines
 *   measures  formulas over atoms and other measures ("salaries + benefits")
 *   atoms     sums over the source values, selected by filters on the
 *             department and account — a base code, a prefix, or a node of the
 *             account/department map hierarchy
 *
 * Every value in the engine is a Vec13: twelve months and a total, evaluated
 * column by column. That is what makes a ratio's Total the ratio of the
 * totals rather than the sum of twelve monthly ratios. The corollary is that
 * `a * b` has Total = total(a) × total(b); a rate × volume product wants
 * `retotal(a * b)`, which re-sums the months. See vec.ts.
 *
 * Modelled on PS Loader 2.0's P&L engine (rows → measures → sub-measures) but
 * with the two things it could not do: measures may reference measures, and a
 * definition is data.
 */

import type { OutputValueKind, ResultEncoding } from "../positions/ipc";

/** How a row's numbers are meant to be shown. Display only — the engine never
 *  scales a value by its format. `pts` is a difference of two percentages
 *  (a variance column's own format, never a measure's).
 *
 *  `currency` is the ONLY format the "amounts in 000's" toggle scales, so a
 *  money figure that is already divided by a statistic — ADR, RevPAR, a POR /
 *  PAR / per-FTE rate — must be `rate`, not `currency`. Scaling a £150 ADR to
 *  0 destroys the KPI; the workbook's own rule is "except Ratios & Stats". */
export type Format = "currency" | "number" | "percent" | "ratio" | "pts" | "rate";

/**
 * One filter on the department or account side of an atom. Filters on one
 * atom are AND-ed; the values inside one filter are OR-ed.
 *
 * Codes and prefixes accept either spelling ("D0410" / "0410", "A988" / "988")
 * and are normalised to the bare form. Level values are the labels held in
 * account_maps.level_N / department_maps.level_N, matched exactly after a
 * trim. `*_level_not_in` also matches a code the maps do not know at all, the
 * way a residual bucket has to; `*_level` needs the code to be mapped.
 *
 * Base and prefix filters never consult the maps. They resolve against the
 * source's own codes, so a report built only from them runs on an install
 * that has never synced the mapping tables.
 */
export type AtomFilter =
  | { kind: "dept_base"; codes: string[] }
  | { kind: "dept_base_not_in"; codes: string[] }
  | { kind: "dept_prefix"; prefixes: string[] }
  | { kind: "dept_level"; level: number; values: string[] }
  | { kind: "dept_level_not_in"; level: number; values: string[] }
  | { kind: "acc_base"; codes: string[] }
  | { kind: "acc_base_not_in"; codes: string[] }
  | { kind: "acc_prefix"; prefixes: string[] }
  | { kind: "acc_level"; level: number; values: string[] }
  | { kind: "acc_level_not_in"; level: number; values: string[] };

export type AtomFilterKind = AtomFilter["kind"];

/**
 * Where an atom's values come from.
 *  - kairos: the scenario's results cache (the default).
 *  - bst:    the hotel's BST budget import, the bucket whose year is the
 *            scenario year (+ yearOffset). `bucket.type` narrows to a bucket
 *            type ("BUDGET", "ACT/FCST", …, matched case-insensitively) and
 *            `bucket.index` pins one of the three outright.
 *
 * Under a report COLUMN (see columns.ts) the column's series decides what
 * "kairos" and "bst" mean — a `bst` column reads every atom off its bucket,
 * a `plan` column reads the overlay. `pinned: true` on a kairos ref opts an
 * atom out of that: it always reads the scenario's own cache, whatever the
 * column. Hours and heads are pinned — they exist only where Kairos posts
 * them, and the push's clear rules (which decide what the overlay replaces)
 * are user-editable, so the cache is the only guarantee.
 */
export type ValueSourceRef =
  | { source: "kairos"; pinned?: true }
  | {
      source: "bst";
      bucket?: { type?: string; index?: 1 | 2 | 3 };
      yearOffset?: number;
    };

/**
 * A value a definition takes from outside the sources: a number (every slot)
 * or a monthly series. The Total of a series defaults to the sum of its
 * months — right for "hours per FTE this year", where FTE = hours ÷ param
 * wants the year's hours in the Total slot — and a rate that wants an average
 * says so with an explicit `total`.
 */
export type ParamValue = number | { months: number[]; total?: number };

/**
 * Params main knows how to resolve.
 *  - weekly_hours: the standard work week, read off the column's own source
 *    (department D0410, account A988112, posted in January only), falling
 *    back to the scenario year's value and then to the hotel-year setup —
 *    see main/reports/evaluate.ts. Twelve equal months with the SAME figure
 *    in the Total, so `weekly_hours * weeks` sizes a year as weekly × weeks.
 *  - days_in_month: the calendar's day counts for the column's year.
 */
export type BuiltinParam = "weekly_hours" | "days_in_month";

export interface ReportParam {
  id: string;
  label?: string;
  /** Used when nothing resolves the param (and PARAM_DEFAULTED is raised). */
  default: ParamValue;
  /** Resolved by main from the hotel-year setup; a request override wins. */
  builtin?: BuiltinParam;
  unit?: string;
}

export type ValueSourceKind = ValueSourceRef["source"];

export interface Atom {
  id: string;
  label?: string;
  source?: ValueSourceRef;
  filters: AtomFilter[];
  /** Multiply the summed vector by −1 (a credit shown as a positive). */
  negate?: boolean;
}

/** Which way is good: a cost that fell is favourable, a sale that fell is
 *  not. Display only — it colours a variance, never changes a number. */
export type Polarity = "revenue" | "cost";

export interface Measure {
  id: string;
  /** See formula/parser.ts for the grammar. */
  formula: string;
  label?: string;
  format?: Format;
  polarity?: Polarity;
}

export type ReportRow =
  | { type: "header"; label: string; indent?: number }
  | { type: "spacer" }
  | {
      type: "measure";
      measureId: string;
      label?: string;
      indent?: number;
      format?: Format;
      /** Show the value with its sign flipped. Display only. */
      invertSign?: boolean;
    };

export interface ReportDefinition {
  id: string;
  name: string;
  description?: string;
  version: 1;
  atoms: Atom[];
  measures: Measure[];
  rows: ReportRow[];
  /** Leaves a formula may reference beside atoms. */
  params?: ReportParam[];
}

// ---------------------------------------------------------------------------
// Evaluation output
// ---------------------------------------------------------------------------

export type ReportWarningCode =
  /** A level filter was used on an install that has no mapping tables. */
  | "MAPS_UNAVAILABLE"
  /** A summed row mixes level and amount lines; it was read as amounts. */
  | "MIXED_ENCODING"
  /** The scenario has no results at all (never calculated, or synced without them). */
  | "NO_RESULTS"
  /** The results predate the cache; they were aggregated on the fly. */
  | "RESULTS_PREDATE_CACHE"
  /** A BST atom asked for a bucket the current import does not hold. */
  | "BST_BUCKET_NOT_FOUND"
  /** A BST atom was used but the hotel has no budget import. */
  | "BST_UNAVAILABLE"
  /** The maps hold both spellings of one code; the last one read wins. */
  | "DUPLICATE_MAP_CODE"
  /** No source carried the work week; it was derived from the scenario's
   *  positions and should be posted (calculate, then push). */
  | "WEEKLY_HOURS_NOT_POSTED"
  /** The scenario's results differ from what the BST holds — push before reporting. */
  | "PLAN_NOT_PUSHED"
  /** Nothing resolved a param; its definition default was used. */
  | "PARAM_DEFAULTED"
  /** Budget submission: the plan has no active positions to send. */
  | "NO_POSITIONS"
  /** Budget submission: the posted effective week is not the derived one — recalculate. */
  | "EFFECTIVE_WEEK_DRIFT"
  /** A pinned atom needs a scenario the column does not name. */
  | "SCENARIO_MISSING";

export interface ReportWarning {
  code: ReportWarningCode;
  message: string;
  atomId?: string;
}

/** One evaluated line. `values` is Jan..Dec then Total (13 slots), or null for
 *  a header/spacer. Plain numbers, so it crosses IPC as-is. */
export interface EvaluatedRow {
  type: ReportRow["type"];
  label: string;
  indent: number;
  measureId?: string;
  format?: Format;
  invertSign?: boolean;
  polarity?: Polarity;
  values: number[] | null;
}

export interface EvaluatedReport {
  definitionId: string;
  rows: EvaluatedRow[];
  warnings: ReportWarning[];
  /** Every atom the rows reached, with its summed vector — the drill-down
   *  behind a measure, and what the tests pin. */
  atoms: Record<string, number[]>;
  /** Every param the rows reached, as the vector it entered the formulas as. */
  params: Record<string, number[]>;
}

/** What an atom sums: one dept × account entry of a value source. Codes are
 *  bare ("0410" / "988112"). `vec` is the stored series; `reportVec` is what a
 *  report reads — the running sum for a LEVEL row, the series itself
 *  otherwise. Precomputed at load so summation is branch-free. `valueKind`
 *  is carried from the results cache (an allocation share is "percent") so
 *  the overlay can tell a share from an amount. */
export interface ComboEntry {
  dept: string;
  account: string;
  vec: Float64Array;
  reportVec: Float64Array;
  encoding: ResultEncoding;
  valueKind?: OutputValueKind;
}
