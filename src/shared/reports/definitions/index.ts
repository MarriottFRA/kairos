/**
 * The built-in report definitions. Data objects, compiled once at module
 * load so an invalid definition fails at startup (and in the test that
 * imports this module), never at report time.
 *
 * Definitions are keyed by id; a table of user-authored definitions can sit
 * beside this registry later with the same shape.
 */

import { CompiledReport, compileDefinition } from "../compile";
import type { ReportDefinition } from "../types";
import { PAYROLL_SUMMARY } from "./payrollSummary";
import { STAFFING_STATS } from "./staffingStats";

export const BUILTIN_REPORT_DEFINITIONS: readonly ReportDefinition[] = [
  PAYROLL_SUMMARY,
  STAFFING_STATS,
];

const COMPILED: ReadonlyMap<string, CompiledReport> = new Map(
  BUILTIN_REPORT_DEFINITIONS.map((definition) => [
    definition.id,
    compileDefinition(definition),
  ])
);

export function findReportDefinition(id: string): CompiledReport | undefined {
  return COMPILED.get(id);
}

export function listReportDefinitions(): readonly CompiledReport[] {
  return [...COMPILED.values()];
}
