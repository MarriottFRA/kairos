/**
 * Code-defined default KPI drivers.
 *
 * Built-ins are NOT seeded per-OU (hotels are dynamic and these evolve across
 * releases). Instead they are defined here and UNIONed into read results for
 * every OU — the same "materialize rather than persist" approach as the
 * synthetic bank-holiday definition in loadScenarioInput.ts. Their resolved
 * series still land in kpi_driver_values keyed by the stable id below, so the
 * precalc + engine path is identical to a user driver.
 */

import type { KpiDriverId } from "../../shared/kpiDrivers/ipc";

/** The definitional core of a built-in driver (no ou / staleness). */
export interface BuiltinKpiDriver {
  id: KpiDriverId;
  label: string;
  /** Free-text note shown in the UI and matched by search. */
  description: string;
  deptMode: "EXPLICIT" | "POSITION";
  deptPatterns: string[];
  accountPrefixes: string[];
  bucketIndex: number;
}

export const BUILTIN_KPI_DRIVERS: BuiltinKpiDriver[] = [
  {
    // Total hotel revenue: every department, every account starting with A3,
    // from the budget bucket (index 1). One series shared by any position that
    // references it.
    id: "kpi:builtin:total-revenue" as KpiDriverId,
    label: "Total Revenue",
    description:
      "Sum of all revenue accounts (A3*) across every department, from the budget bucket.",
    deptMode: "EXPLICIT",
    deptPatterns: ["*"],
    accountPrefixes: ["A3"],
    bucketIndex: 1,
  },
];

const BUILTIN_IDS = new Set(BUILTIN_KPI_DRIVERS.map((d) => d.id));

/** Whether an id belongs to a code-defined built-in driver. */
export function isBuiltinDriverId(id: string): boolean {
  return BUILTIN_IDS.has(id as KpiDriverId);
}
