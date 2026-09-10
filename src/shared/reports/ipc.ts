/**
 * Reports — IPC channel names and wire shapes.
 *
 * The renderer names a definition and the COLUMNS it wants (series to
 * evaluate, variances between them); main evaluates against the results
 * cache, the BST import and the mapping tables and returns one row scaffold
 * with row-aligned values per column, plus per-column provenance (which
 * scenario, which bucket, how stale, how far the BST is from the plan) so
 * the page can say "calculated at …, out of date, not pushed" the way the
 * Results page does.
 *
 * The drill-down is two more reads: the definition itself (formulas and what
 * each measure references) and the combos one atom summed under one column.
 * Export builds a workbook in main and saves it where the user says.
 */

import type { EffectiveWeekDerivation } from "../positions/effectiveWeek";
import type {
  EvaluatedColumn,
  EvaluatedGrid,
  ReportColumnSpec,
  SeriesColumnSpec,
} from "./columns";
import type { PackDepartment, PackPage } from "./packs";
import type { PlanDrift } from "./sources";
import type { StaffingBasis, TitleMode } from "./staffingOverview";
import type {
  AtomFilter,
  BuiltinParam,
  EvaluatedReport,
  ParamValue,
  ReportDefinition,
  ReportWarning,
  ValueSourceKind,
} from "./types";
import type { ResultEncoding } from "../positions/ipc";
import type { WeeklyHoursInfo } from "./weeklyHours";

export const REPORTS_CHANNELS = {
  /** Evaluate one built-in definition for (hotel, scenario) — the single-series reading. */
  evaluate: "reports:evaluate",
  /** Evaluate one built-in definition under a column set. */
  evaluateColumns: "reports:evaluate-columns",
  /** The built-in definitions, for a picker. */
  listDefinitions: "reports:list-definitions",
  /** One definition as data, with each measure's references — the drill-down's map. */
  getDefinition: "reports:get-definition",
  /** The combos one atom summed under one series column. */
  atomCombos: "reports:atom-combos",
  /** Evaluate and save as an Excel workbook (main opens the save dialog). */
  export: "reports:export",
  /** The budget pack's pages for the columns' sources. */
  packPages: "reports:pack-pages",
  /** One pack page evaluated, with its generated definition. */
  packEvaluate: "reports:pack-evaluate",
  /** The whole pack saved as a workbook. */
  packExport: "reports:pack-export",
  /** The payroll bridge: a scenario's payroll by position, per department. */
  positionBridge: "reports:position-bridge",
  /** The bridge saved as a workbook, one sheet per department. */
  positionBridgeExport: "reports:position-bridge-export",
  /** The staffing overview: heads and FTE per department group and title, by classification. */
  staffingOverview: "reports:staffing-overview",
  /** The staffing overview saved as a workbook. */
  staffingOverviewExport: "reports:staffing-overview-export",
  /** Staffing statistics: heads, FTE and hours by account — hotel, groups, departments, positions. */
  staffingStatistics: "reports:staffing-statistics",
  /** The staffing statistics saved as a workbook, everything expanded. */
  staffingStatisticsExport: "reports:staffing-statistics-export",
  /** The FTE reconciliation: the Positions grid's FTE beside the account-derived FTE, per department. */
  fteReconciliation: "reports:fte-reconciliation",
  /** The FTE reconciliation saved as a workbook. */
  fteReconciliationExport: "reports:fte-reconciliation-export",
  /** The effective week a scenario would post (D0410 / A988112), with its working. */
  effectiveWeek: "reports:effective-week",
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

export interface ReportsEffectiveWeekRequest {
  ou: string;
  scenarioId: string;
}

/** The effective week derived from a scenario's positions right now, beside
 *  what its last run actually posted — the Home page's live cell. */
export interface EffectiveWeekResponse {
  scenarioId: string;
  year: number;
  derivation: EffectiveWeekDerivation;
  /** The D0410 / A988112 figure the scenario's results hold; null = never posted. */
  posted: number | null;
  run: ReportRunInfo | null;
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

export interface ReportsEvaluateColumnsRequest {
  ou: string;
  definitionId: string;
  columns: ReportColumnSpec[];
  bst?: ReportsEvaluateRequest["bst"];
  /** Param values the user typed; win over the built-in resolution. */
  params?: Record<string, ParamValue>;
}

/** Where one series column's numbers came from. */
export interface ReportColumnInfo {
  /** The scenario the column is about (plan/kairos, or a bst column's relativeTo). */
  scenarioId: string | null;
  year: number | null;
  /** The scenario's run; null for a column with no scenario or never calculated. */
  run: ReportRunInfo | null;
  /** The BST buckets read. */
  bst: ReportBstInfo[];
  /** Plan vs BST, on `plan` columns and scenario-relative `bst` ones; null otherwise. */
  drift: PlanDrift | null;
  /** The standard work week the column's FTE was sized with, and where it
   *  was read; null when the report has no FTE line. */
  weeklyHours: WeeklyHoursInfo | null;
}

export interface ReportsEvaluateColumnsResponse extends EvaluatedGrid {
  columns: (EvaluatedColumn & ReportColumnInfo)[];
  mappingVersion: string | null;
  timings: { loadMs: number; evaluateMs: number };
}

export interface ReportParamSummary {
  id: string;
  label: string;
  builtin: BuiltinParam | null;
  unit: string | null;
}

export interface ReportDefinitionSummary {
  id: string;
  name: string;
  description: string;
  sources: ValueSourceKind[];
  params: ReportParamSummary[];
}

export interface ReportsListDefinitionsRequest {
  ou: string;
}

export interface ReportsGetDefinitionRequest {
  ou: string;
  definitionId: string;
}

export interface ReportDefinitionDetail {
  definition: ReportDefinition;
  /** measure id → the ids its formula references (atoms, params, measures). */
  refs: Record<string, string[]>;
}

export interface ReportsAtomCombosRequest {
  ou: string;
  /** A built-in definition id; ignored when `pack` is given. */
  definitionId: string;
  atomId: string;
  /** The series column to resolve the atom under. */
  column: SeriesColumnSpec;
  bst?: ReportsEvaluateRequest["bst"];
  /** For a generated pack page: which page, and the full column set the
   *  page was laid out from (its universe spans every column's source). */
  pack?: { pageId: string; columns: ReportColumnSpec[] };
}

export interface AtomComboDto {
  dept: string;
  account: string;
  deptName: string | null;
  accountName: string | null;
  /** What the atom read: the stored series, or the running sum for a level. */
  values: number[];
  encoding: ResultEncoding;
}

export interface ReportsAtomCombosResponse {
  atomId: string;
  label: string;
  filters: AtomFilter[];
  negate: boolean;
  /** The source the column resolved the atom to, or null when unavailable. */
  sourceId: string | null;
  combos: AtomComboDto[];
  /** Σ of the combos as the atom reads it (negated when the atom negates). */
  total: number[];
  warnings: ReportWarning[];
}

export interface ReportsExportRequest extends ReportsEvaluateColumnsRequest {
  /** Twelve months + Total per column, or the Total alone. */
  months: boolean;
  /** Money in thousands (Excel's scaling format; the values stay whole). */
  thousands?: boolean;
  hotelName?: string;
  /** Suggested file name (without extension). */
  fileName?: string;
}

export type ReportsExportResponse =
  | { outcome: "cancelled" }
  | { outcome: "saved"; path: string; sheets: number };

// ---------------------------------------------------------------------------
// Budget pack
// ---------------------------------------------------------------------------

export interface ReportsPackPagesRequest {
  ou: string;
  columns: ReportColumnSpec[];
  bst?: ReportsEvaluateRequest["bst"];
  params?: Record<string, ParamValue>;
}

export interface ReportsPackPagesResponse {
  pages: PackPage[];
  departments: PackDepartment[];
  groups: string[];
}

export interface ReportsPackEvaluateRequest extends ReportsPackPagesRequest {
  pageId: string;
}

export interface ReportsPackEvaluateResponse extends ReportsEvaluateColumnsResponse {
  page: PackPage;
  /** The generated definition, for the drill-down. */
  detail: ReportDefinitionDetail;
}

export interface ReportsPackExportRequest extends ReportsPackPagesRequest {
  months: boolean;
  thousands?: boolean;
  includeDepartments: boolean;
  /** One page alone (no Contents sheet) instead of the whole pack. */
  pageId?: string;
  hotelName?: string;
  fileName?: string;
}

// ---------------------------------------------------------------------------
// Payroll bridge
// ---------------------------------------------------------------------------

export interface ReportsPositionBridgeRequest {
  ou: string;
  scenarioId: string;
  /** Restrict to one department (bare or branded code). */
  dept?: string;
  /** A second scenario to set beside it, matched by lineage. */
  compareScenarioId?: string;
}

export interface ReportsPositionBridgeExportRequest extends ReportsPositionBridgeRequest {
  hotelName?: string;
  fileName?: string;
  /** The account depth the workbook opens at (a tree level, or ACCOUNT_DEPTH);
   *  everything deeper is in the file, collapsed under Excel outline groups. */
  depth?: number;
}

// ---------------------------------------------------------------------------
// Staffing overview
// ---------------------------------------------------------------------------

export interface ReportsStaffingOverviewRequest {
  ou: string;
  scenarioId: string;
  /** A second scenario to set beside it, matched by department group and title. */
  compareScenarioId?: string;
  /** Roll positions up by the job title as typed (default) or the Standard Title. */
  titleMode?: TitleMode;
  /** Read the accounts (default — what every report carries) or the positions. */
  basis?: StaffingBasis;
}

export interface ReportsStaffingOverviewExportRequest extends ReportsStaffingOverviewRequest {
  hotelName?: string;
  fileName?: string;
}

// ---------------------------------------------------------------------------
// Staffing statistics
// ---------------------------------------------------------------------------

export interface ReportsStaffingStatisticsRequest {
  ou: string;
  scenarioId: string;
}

export interface ReportsStaffingStatisticsExportRequest extends ReportsStaffingStatisticsRequest {
  /** The period the page shows: 0..11 a month, 12 (the default) the year. */
  slot?: number;
  hotelName?: string;
  fileName?: string;
}

// ---------------------------------------------------------------------------
// FTE reconciliation
// ---------------------------------------------------------------------------

export interface ReportsFteReconciliationRequest {
  ou: string;
  scenarioId: string;
}

export interface ReportsFteReconciliationExportRequest extends ReportsFteReconciliationRequest {
  hotelName?: string;
  fileName?: string;
}
