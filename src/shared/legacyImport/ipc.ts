/**
 * Legacy Excel import — shared types + IPC channel names.
 *
 * A one-shot migration path for hotels moving off the Excel "Payroll Budget
 * Tool" (v3.6.x): read the workbook and reproduce its inputs here, so a new
 * hotel does not re-key ~160 positions × ~80 columns by hand.
 *
 * Deliberately self-contained. Nothing else in the app imports from
 * shared/legacyImport or main/legacyImport — the importer calls the existing
 * feature repos, never the other way round, so the whole thing can be deleted
 * once the last hotel has migrated without touching anything it wrote.
 *
 * The flow is two round-trips on purpose. `preview` parses and analyses but
 * writes NOTHING, so the confirm dialog can show what would happen (which
 * blocks, how many rows, every fidelity warning) against a file the user may
 * have picked by mistake. `commit` re-reads the same path — the preview holds
 * no server-side session state, so a stale token can never write the wrong file.
 */

import type { BlockType } from "../blocks/ipc";

/** One block the importer would create, described for the confirm dialog. */
export interface LegacyBlockPreview {
  /** The Excel band's name, e.g. "Pension", "Transportation Allowance". */
  label: string;
  blockType: BlockType;
  /** Human summary of the posting account(s): one code, or "per row (…)". */
  accountSummary: string;
  /** MULTIPLIER only: what the percentage applies to, in plain English. */
  baseSummary?: string;
  /** How the yearly figure lands across the months, in plain English. */
  spreadSummary?: string;
  /** Associate rows carrying a non-zero input for this band. */
  usedRows: number;
}

/** Everything the importer found, with nothing yet written. */
export interface LegacyImportPreview {
  /** Absolute path — passed straight back to `commit`. */
  filePath: string;
  sourceFileName: string;
  /** From Budget_Import!G5 / D5 — the workbook's own idea of which hotel it is.
   *  Advisory only: an OU is often absent, and the user picked the file. */
  fileHotelName: string | null;
  fileOu: string | null;
  /** From Settings!B4 ("Yr 2024"). */
  fileYear: number | null;
  positionCount: number;
  blocks: LegacyBlockPreview[];
  /** Excel bands present in the file but left entirely blank — nothing to make. */
  skippedBlocks: string[];
  manualInputRowCount: number;
  /** Names of the Active allocation columns. */
  allocationNames: string[];
  /** Settings!B31, the full-time week. */
  fullTimeWeeklyHours: number | null;
  /** Menu!C12:N12 — public holidays per month, Jan..Dec. */
  publicHolidaysByMonth: number[] | null;
  /** Fidelity notes: what was approximated, dropped, or needs a second look. */
  warnings: string[];
}

/** Why a workbook could not be previewed. */
export type LegacyImportRefusal =
  | { outcome: "cancelled" }
  | { outcome: "not_legacy_file"; sourceFileName: string; reason: string }
  | { outcome: "scenario_not_empty"; positionCount: number };

export type LegacyImportPreviewResult =
  | LegacyImportRefusal
  | { outcome: "ready"; preview: LegacyImportPreview };

/** What the import actually did. */
export interface LegacyImportReport {
  sourceFileName: string;
  positionsCreated: number;
  blocksCreated: LegacyBlockPreview[];
  manualInputRowsCreated: number;
  allocationsCreated: string[];
  /** Months whose public-holiday count was written. */
  calendarMonthsUpdated: number;
  /** Weekly hours written to position_defaults, or null if the file had none. */
  weeklyHoursUpdated: number | null;
  warnings: string[];
}

export type LegacyImportCommitResult =
  | LegacyImportRefusal
  | { outcome: "ok"; report: LegacyImportReport };

/** Which optional sheets to bring across. All default on. */
export interface LegacyImportOptions {
  calendarAndHours: boolean;
  manualInput: boolean;
  allocations: boolean;
}

export const DEFAULT_LEGACY_IMPORT_OPTIONS: LegacyImportOptions = {
  calendarAndHours: true,
  manualInput: true,
  allocations: true,
};

export function normalizeLegacyImportOptions(
  raw: unknown
): LegacyImportOptions {
  const value = (raw ?? {}) as Partial<LegacyImportOptions>;
  return {
    calendarAndHours:
      value.calendarAndHours ?? DEFAULT_LEGACY_IMPORT_OPTIONS.calendarAndHours,
    manualInput: value.manualInput ?? DEFAULT_LEGACY_IMPORT_OPTIONS.manualInput,
    allocations: value.allocations ?? DEFAULT_LEGACY_IMPORT_OPTIONS.allocations,
  };
}

export const LEGACY_IMPORT_CHANNELS = {
  /** Pick a file, parse + analyse it, write nothing, describe what would happen. */
  preview: "legacyImport:preview",
  /** Re-read the previewed path and apply it. */
  commit: "legacyImport:commit",
} as const;
