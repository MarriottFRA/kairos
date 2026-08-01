/**
 * Which column map a legacy workbook actually uses.
 *
 * The Excel tool's columns are only fixed within a version. 3.6.3 added an
 * Overtime band at DR..DX; 3.6.1 does not have it, so from DY onward every
 * column sits SEVEN to the left of where 3.6.3 puts it:
 *
 *              3.6.1                       3.6.3
 *   DR         Custom 1 - Jan              Overtime → Monthly Hours
 *   DY         Custom 1 - Aug              Custom 1 - Jan
 *   ER         Social Security/NI          Custom 2 - Jul
 *   EY         5th Tax Rate                Social Security/NI
 *   last       FI                          FP
 *
 * Reading a 3.6.1 file with the 3.6.3 map does not fail — it imports confidently
 * wrong data: an Overtime block built from Custom-1 January, and Custom Monthly
 * 2 filled with tax margins and tax rates as if they were money. That is the
 * failure this file exists to prevent.
 *
 * Everything BEFORE DR is identical across the two versions (verified column by
 * column), as are the Buyout & Manual Input, Allocations and Menu sheets. So an
 * unrecognised block region costs the blocks, never the positions.
 *
 * Detection prefers the sheet's OWN headers over the version cell. A hotel that
 * pasted its data into a newer template can leave Settings!B29 saying the old
 * number, and it is the headers we actually read by.
 */

import {
  LegacyVersionChoice,
  SUPPORTED_LEGACY_VERSIONS,
  SupportedLegacyVersion,
} from "../../shared/legacyImport/ipc";
import { LegacyWorkbook } from "./parseWorkbook";

// ---------------------------------------------------------------------------
// Column-letter arithmetic (duplicated from analyze.ts's exports to keep the
// dependency one-way: analyze imports layout, never the other way round).
// ---------------------------------------------------------------------------

function indexOfColumn(letter: string): number {
  let index = 0;
  for (const character of letter) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** First column of the Overtime band in the layout that has it. */
const OVERTIME_FIRST = indexOfColumn("DR");
/** First column after it — where the shift starts for a layout without it. */
const AFTER_OVERTIME = indexOfColumn("DY");
/** DR..DX. */
const OVERTIME_WIDTH = AFTER_OVERTIME - OVERTIME_FIRST;

export interface LegacyLayout {
  /** The version this map belongs to, or null when nothing was recognised. */
  version: SupportedLegacyVersion | null;
  /** Whether the file carries the Overtime band — the whole of the difference. */
  hasOvertime: boolean;
  /** How the layout was decided, for the preview dialog. */
  source: "headers" | "version-cell" | "forced" | "unknown";
  /** The version the file claims, whatever we decided to use. */
  declaredVersion: string | null;
  /**
   * True when the block region (DR onward) can be read with confidence. False
   * means positions still import; blocks cannot, because we would be reading
   * unknown columns.
   */
  blocksReadable: boolean;
  /** Plain-English notes for the preview: disagreements, forced overrides. */
  notes: string[];
}

/**
 * Map a 3.6.3 column letter onto the same content in this layout.
 *
 * Returns null for a column that does not exist here at all — the Overtime band
 * on a layout without it. Callers drop those bands rather than read something
 * else in their place.
 */
export function mapColumn(letter: string, layout: LegacyLayout): string | null {
  if (layout.hasOvertime) return letter;
  const index = indexOfColumn(letter);
  if (index < OVERTIME_FIRST) return letter;
  if (index < AFTER_OVERTIME) return null; // the Overtime band itself
  return encodeColumn(index - OVERTIME_WIDTH);
}

function encodeColumn(index: number): string {
  let out = "";
  let remaining = index + 1;
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    remaining = Math.floor((remaining - remainder) / 26);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core-layout anchors
// ---------------------------------------------------------------------------

/**
 * Row-3 headers that must still mean what the importer thinks, spread across
 * the whole pre-block region so a shift anywhere in it shows up. These are
 * template headers on a protected sheet; a hotel renaming one is possible, a
 * hotel renaming two means the layout moved.
 *
 * A BLANK header is not a mismatch. Absence is not evidence of a different
 * layout, and a workbook stripped of its header rows should still import.
 */
const CORE_ANCHORS: Array<[column: string, expected: string]> = [
  ["A", "hiring date"],
  ["E", "department"],
  ["O", "hc"],
  ["R", "jan"],
  ["AE", "monthly basic salary"],
  ["AU", "increase month"],
  ["AZ", "budget year basic salary"],
  ["BA", "contract - yrly vacation days"],
  ["BR", "benefits account code"],
];

/** How many anchors may disagree before we call the file a different layout. */
const ANCHOR_MISMATCH_LIMIT = 2;

function normalize(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Anchors that are present AND say something else. */
export function coreAnchorMismatches(workbook: LegacyWorkbook): string[] {
  const mismatches: string[] = [];
  for (const [column, expected] of CORE_ANCHORS) {
    const actual = normalize(workbook.columnNames[column]);
    if (!actual) continue; // blank → not checkable, not wrong
    if (actual !== expected) {
      mismatches.push(`${column} says "${workbook.columnNames[column]}"`);
    }
  }
  return mismatches;
}

/**
 * True when the associate sheet is laid out so differently that even the
 * positions cannot be trusted. This is the one condition that refuses a file
 * outright rather than degrading to a positions-only import.
 */
export function isUnreadableLayout(workbook: LegacyWorkbook): boolean {
  return coreAnchorMismatches(workbook).length >= ANCHOR_MISMATCH_LIMIT;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * What column DR says about itself. This single column is the whole question:
 * on 3.6.3 it opens the Overtime band, on 3.6.1 it is Custom 1's January.
 */
function overtimeFromHeaders(workbook: LegacyWorkbook): boolean | null {
  const band = normalize(workbook.bandNames.DR);
  const name = normalize(workbook.columnNames.DR);
  if (/overtime/.test(band) || /monthly hours/.test(name)) return true;
  if (/custom monthly spread 1/.test(band) || /^custom 1\b/.test(name)) {
    return false;
  }
  return null;
}

const VERSION_HAS_OVERTIME: Record<SupportedLegacyVersion, boolean> = {
  "3.6.1": false,
  "3.6.3": true,
};

function isSupported(version: string | null): version is SupportedLegacyVersion {
  return SUPPORTED_LEGACY_VERSIONS.includes(version as SupportedLegacyVersion);
}

/**
 * Decide the column map, in order of how much the signal can be trusted:
 *
 *   1. an explicit choice from the settings card — the user is looking at the
 *      file and we are not;
 *   2. the sheet's own row-2/row-3 headers, which are what we read by;
 *   3. the version cell, when the headers are missing or unfamiliar.
 *
 * Signals that disagree do not block the import; they are reported, and the
 * more trustworthy one wins.
 */
export function resolveLayout(
  workbook: LegacyWorkbook,
  choice: LegacyVersionChoice = "auto"
): LegacyLayout {
  const declaredVersion = workbook.declaredVersion;
  const fromHeaders = overtimeFromHeaders(workbook);
  const notes: string[] = [];

  // The Social-Security inclusion list gains an Overtime row with the band, so
  // it corroborates the headers without being authoritative on its own.
  if (
    fromHeaders !== null &&
    workbook.hasOvertimeSetting !== fromHeaders &&
    workbook.hasOvertimeSetting
  ) {
    notes.push(
      `The Settings sheet lists an Overtime row but the Associate Details ` +
        `columns do not carry the band. The columns were used.`
    );
  }

  if (choice !== "auto") {
    const forced = VERSION_HAS_OVERTIME[choice];
    if (fromHeaders !== null && fromHeaders !== forced) {
      notes.push(
        `You selected ${choice}, but this file's columns look like ` +
          `${forced ? "3.6.1" : "3.6.3"} (column DR is ` +
          `"${workbook.bandNames.DR ?? workbook.columnNames.DR ?? "blank"}"). ` +
          `Your choice was used — check the blocks carefully, or switch the ` +
          `version back to Detect automatically.`
      );
    }
    return {
      version: choice,
      hasOvertime: forced,
      source: "forced",
      declaredVersion,
      blocksReadable: true,
      notes,
    };
  }

  if (fromHeaders !== null) {
    const version: SupportedLegacyVersion = fromHeaders ? "3.6.3" : "3.6.1";
    if (
      isSupported(declaredVersion) &&
      VERSION_HAS_OVERTIME[declaredVersion] !== fromHeaders
    ) {
      notes.push(
        `This file says it is version ${declaredVersion}, but its columns are ` +
          `laid out like ${version}. The columns were used, which is what the ` +
          `import actually reads — it usually means the data was pasted into a ` +
          `different template.`
      );
    }
    return {
      version,
      hasOvertime: fromHeaders,
      source: "headers",
      declaredVersion,
      blocksReadable: true,
      notes,
    };
  }

  if (isSupported(declaredVersion)) {
    notes.push(
      `The band headings on row 2 were not recognised, so the column layout ` +
        `was taken from the version this file declares (${declaredVersion}).`
    );
    return {
      version: declaredVersion,
      hasOvertime: VERSION_HAS_OVERTIME[declaredVersion],
      source: "version-cell",
      declaredVersion,
      blocksReadable: true,
      notes,
    };
  }

  notes.push(
    `The benefit-band columns could not be identified: row 2 does not carry ` +
      `headings this tool recognises and the file ` +
      `${declaredVersion ? `declares version ${declaredVersion}, which is not one this tool has a column map for` : "does not state its version"}. ` +
      `Positions, the manual-input sheet and allocations still import — those ` +
      `columns are the same in every version — but the benefit blocks cannot ` +
      `be read, so they were left out. Build them on the Positions page and ` +
      `paste each band's column in from Excel.`
  );
  return {
    version: null,
    hasOvertime: false,
    source: "unknown",
    declaredVersion,
    blocksReadable: false,
    notes,
  };
}
