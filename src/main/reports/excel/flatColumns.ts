/**
 * Column helpers for the own-path reports (the payroll bridge, the staffing
 * overview) that write a table through the report sheet writer: a value in
 * the 13-slot shape the writer expects with `months: false` (it reads slot
 * 12), and a column whose spec makes it a series (plain figures) or a
 * variance (coloured by whether the figure is good news).
 */

import type { EvaluatedColumn, ReportColumnSpec } from "../../../shared/reports/columns";
import type { Format } from "../../../shared/reports/types";

export const flat13 = (total: number): number[] => [...new Array<number>(12).fill(0), total];

export type FlatColumn = Pick<EvaluatedColumn, "id" | "label" | "values" | "rowFormats" | "spec">;

/** An empty `values` entry (`[]`) is a blank cell. */
export function flatColumn(
  id: string,
  label: string,
  values: number[][],
  format: Format | null = null,
  spec: ReportColumnSpec = { id, series: { kind: "kairos", scenarioId: "report" } }
): FlatColumn {
  return {
    id,
    label,
    spec,
    values: values.map((v) => (v.length === 0 ? null : v)),
    rowFormats: values.map(() => format),
  };
}
