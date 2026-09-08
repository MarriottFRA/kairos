/**
 * Reports — IPC channel names and wire shapes.
 *
 * The renderer names a definition and a scenario; main evaluates against the
 * results cache (and the BST import when the definition asks for it) and
 * returns the rows with what they were computed from, so a page can say
 * "calculated at …, out of date" the way the Results page does.
 */

import type { EvaluatedReport, ValueSourceKind } from "./types";

export const REPORTS_CHANNELS = {
  /** Evaluate one built-in definition for (hotel, scenario). */
  evaluate: "reports:evaluate",
  /** The built-in definitions, for a picker. */
  listDefinitions: "reports:list-definitions",
} as const;

export interface ReportsEvaluateRequest {
  ou: string;
  scenarioId: string;
  definitionId: string;
  /** Overrides for atoms that read the BST without pinning a bucket. */
  bst?: { bucketType?: string; bucketIndex?: 1 | 2 | 3 };
}

export interface ReportRunInfo {
  computedAt: string;
  /** True when an input changed since the run — same test as the Results page. */
  stale: boolean;
}

export interface ReportBstInfo {
  importId: string;
  bucketIndex: number;
  bucketType: string | null;
  year: number | null;
}

export interface ReportsEvaluateResponse extends EvaluatedReport {
  scenarioId: string;
  year: number;
  /** Null when the scenario was never calculated. */
  run: ReportRunInfo | null;
  /** The mapping-tables version the atoms resolved against; null = none. */
  mappingVersion: string | null;
  /** The BST buckets that were read, one per distinct atom source ref. */
  bst: ReportBstInfo[];
  timings: { loadMs: number; evaluateMs: number };
}

export interface ReportDefinitionSummary {
  id: string;
  name: string;
  description: string;
  sources: ValueSourceKind[];
}

export interface ReportsListDefinitionsRequest {
  ou: string;
}
