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

import type { ResultEncoding } from "../positions/ipc";

/** How a row's numbers are meant to be shown. Display only — the engine never
 *  scales a value by its format. */
export type Format = "currency" | "number" | "percent" | "ratio";

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
 */
export type ValueSourceRef =
  | { source: "kairos" }
  | {
      source: "bst";
      bucket?: { type?: string; index?: 1 | 2 | 3 };
      yearOffset?: number;
    };

export type ValueSourceKind = ValueSourceRef["source"];

export interface Atom {
  id: string;
  label?: string;
  source?: ValueSourceRef;
  filters: AtomFilter[];
  /** Multiply the summed vector by −1 (a credit shown as a positive). */
  negate?: boolean;
}

export interface Measure {
  id: string;
  /** See formula/parser.ts for the grammar. */
  formula: string;
  label?: string;
  format?: Format;
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
  | "DUPLICATE_MAP_CODE";

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
  values: number[] | null;
}

export interface EvaluatedReport {
  definitionId: string;
  rows: EvaluatedRow[];
  warnings: ReportWarning[];
  /** Every atom the rows reached, with its summed vector — the drill-down
   *  behind a measure, and what the tests pin. */
  atoms: Record<string, number[]>;
}

/** What an atom sums: one dept × account entry of a value source. Codes are
 *  bare ("0410" / "988112"). `vec` is the stored series; `reportVec` is what a
 *  report reads — the running sum for a LEVEL row, the series itself
 *  otherwise. Precomputed at load so summation is branch-free. */
export interface ComboEntry {
  dept: string;
  account: string;
  vec: Float64Array;
  reportVec: Float64Array;
  encoding: ResultEncoding;
}
