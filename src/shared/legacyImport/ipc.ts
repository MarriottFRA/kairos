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

/** Why the benefit blocks are not part of this import. */
export type LegacyBlocksOmission =
  /** The user left the toggle off — the detected blocks are shown as a recipe. */
  | "not_requested"
  /** The block columns could not be identified, so reading them would guess. */
  | "layout_unknown";

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
  /** The version the file states in Settings!B29, whatever layout was used. */
  fileVersion: string | null;
  /** The column map the import will read by — "3.6.1", "3.6.3", or null. */
  resolvedVersion: string | null;
  /** How that was decided, so the dialog can say "detected" vs "you chose". */
  versionSource: "headers" | "version-cell" | "forced" | "unknown";
  /** Disagreements between the version cell, the headers and any override. */
  versionNotes: string[];
  positionCount: number;
  /**
   * The benefit blocks read out of the file. When `blocksOmitted` is set these
   * are NOT being created — they are shown so the user can build the same
   * blocks by hand, which is the point of leaving the toggle off.
   */
  blocks: LegacyBlockPreview[];
  /** Null when the blocks in `blocks` will actually be created. */
  blocksOmitted: LegacyBlocksOmission | null;
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

/** Human label for a block that was found but not created. */
export const BLOCKS_OMISSION_LABEL: Record<LegacyBlocksOmission, string> = {
  not_requested:
    "Found in the file but NOT imported, because “Benefit blocks” is switched " +
    "off. Create these on the Positions page, then paste each band's column " +
    "in from Excel.",
  layout_unknown:
    "Found in the file but NOT imported: this workbook's benefit-band columns " +
    "could not be identified, so importing them would be guesswork. Create " +
    "them on the Positions page and paste the values in from Excel.",
};

export type LegacyImportPreviewResult =
  | LegacyImportRefusal
  | { outcome: "ready"; preview: LegacyImportPreview };

/** What the import actually did. */
export interface LegacyImportReport {
  sourceFileName: string;
  positionsCreated: number;
  /** Blocks actually written. Empty when `blocksOmitted` is set. */
  blocksCreated: LegacyBlockPreview[];
  /** Every band found in the file, created or not — the build-by-hand list. */
  blocksDetected: LegacyBlockPreview[];
  /** Null when the detected blocks were created. */
  blocksOmitted: LegacyBlocksOmission | null;
  /** The column map that was used, for the record. */
  resolvedVersion: string | null;
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

/**
 * The Excel tool versions this importer has a verified column map for.
 *
 * The layout is not stable across the 3.6.x line — 3.6.1 has no Overtime band,
 * which shifts every column from DY onward seven to the left. See
 * main/legacyImport/layout.ts.
 */
export const SUPPORTED_LEGACY_VERSIONS = ["3.6.1", "3.6.3"] as const;
export type SupportedLegacyVersion = (typeof SUPPORTED_LEGACY_VERSIONS)[number];

/** "auto" reads the layout from the file, which is right for almost every file. */
export type LegacyVersionChoice = "auto" | SupportedLegacyVersion;

/** What to bring across, and how to read the file. */
export interface LegacyImportOptions {
  calendarAndHours: boolean;
  manualInput: boolean;
  allocations: boolean;
  /**
   * Create the benefit blocks (pension, allowances, incentives…) from the
   * workbook's bands.
   *
   * Defaults OFF, unlike the sheet options. The importer can read the columns,
   * but it cannot know what a hotel has USED them for — one hotel's "Custom
   * Allowance 2" is another's shift differential — and a block built by hand is
   * both more accurate and understood by whoever has to maintain it. The
   * preview lists every band it found either way, so leaving this off is a
   * recipe rather than a loss.
   */
  blocks: boolean;
  /** Force a column map instead of reading it off the file. */
  version: LegacyVersionChoice;
}

export const DEFAULT_LEGACY_IMPORT_OPTIONS: LegacyImportOptions = {
  calendarAndHours: true,
  manualInput: true,
  allocations: true,
  blocks: false,
  version: "auto",
};

function normalizeVersion(raw: unknown): LegacyVersionChoice {
  return SUPPORTED_LEGACY_VERSIONS.includes(raw as SupportedLegacyVersion)
    ? (raw as SupportedLegacyVersion)
    : "auto";
}

export function normalizeLegacyImportOptions(
  raw: unknown
): LegacyImportOptions {
  const value = (raw ?? {}) as Partial<LegacyImportOptions>;
  return {
    calendarAndHours:
      value.calendarAndHours ?? DEFAULT_LEGACY_IMPORT_OPTIONS.calendarAndHours,
    manualInput: value.manualInput ?? DEFAULT_LEGACY_IMPORT_OPTIONS.manualInput,
    allocations: value.allocations ?? DEFAULT_LEGACY_IMPORT_OPTIONS.allocations,
    blocks: value.blocks ?? DEFAULT_LEGACY_IMPORT_OPTIONS.blocks,
    version: normalizeVersion(value.version),
  };
}

export const LEGACY_IMPORT_CHANNELS = {
  /** Pick a file, parse + analyse it, write nothing, describe what would happen. */
  preview: "legacyImport:preview",
  /** Re-read the previewed path and apply it. */
  commit: "legacyImport:commit",
} as const;
