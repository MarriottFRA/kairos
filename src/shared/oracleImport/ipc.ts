/**
 * Oracle report import — shared types + IPC channel names.
 *
 * A port of the Excel tool's `Add_New_Rows_Oracle` macro: read an Oracle HR
 * export and APPEND the associates it lists to the selected plan, so a hotel
 * does not re-key its employee list by hand.
 *
 * The difference from the legacy import matters. That one migrates a whole
 * workbook into an EMPTY plan and refuses to merge; this one runs into a plan
 * someone is already working in. So the guard is not emptiness but the employee
 * number: anyone already in the plan is skipped and itemised, which makes the
 * import safe to re-run against a refreshed extract. Nothing existing is ever
 * changed or removed.
 *
 * Deliberately self-contained. Nothing else in the app imports from
 * shared/oracleImport or main/oracleImport — the importer calls the existing
 * feature repos, never the other way round.
 *
 * The flow is two round-trips on purpose. `preview` parses and analyses but
 * writes NOTHING, so the confirm dialog can show the first parsed rows (the
 * check that the Oracle layout has not shifted), which block each percentage
 * lands on, and every row that will be skipped. `commit` re-reads the same path
 * — the preview holds no server-side session state, so a stale token can never
 * write the wrong file.
 */

/** The two percentage bands the macro hardcodes. */
export const ORACLE_BAND_KEYS = ["apprenticeshipLevy", "paidSickEstimate"] as const;
export type OracleBandKey = (typeof ORACLE_BAND_KEYS)[number];

export const ORACLE_BAND_LABELS: Record<OracleBandKey, string> = {
  apprenticeshipLevy: "Apprenticeship Levy",
  paidSickEstimate: "Paid Sick Estimate",
};

/** A MULTIPLIER block the dialog can send a band to. */
export interface OracleBlockOption {
  blockId: string;
  label: string;
  accountCode: string;
  accountLocked: boolean;
  /** Plain English base, so "% of base salary" vs "% of something else" shows. */
  baseSummary: string;
}

/** One band, resolved against the hotel's existing blocks. */
export interface OracleBandPreview {
  key: OracleBandKey;
  /** Canonical label, or the matched block's own. */
  label: string;
  /** The multiplier, e.g. 0.005 for 0.5%. */
  rate: number;
  /** "A560401" / "A560307", or the matched block's own when it locks one. */
  accountCode: string;
  disposition: "create" | "existing" | "off";
  /** Set when `existing` — so the user can find the column afterwards. */
  blockId?: string;
  baseSummary: string;
  /** The matched block's base is NOT base salary alone. The single most likely
   *  way this import goes quietly wrong, so it is called out on its own. */
  baseDiffers: boolean;
  /** Rows that will receive this rate. */
  rowCount: number;
}

/** A row the importer will not bring across, and why. Never silently dropped. */
export interface OracleSkippedRow {
  /** 1-based, exactly as the user sees it in Excel. */
  sheetRow: number;
  empNumber: string;
  name: string;
  reason:
    | "duplicate_in_plan"
    | "duplicate_in_file"
    | "no_emp_number"
    | "bad_days_per_week"
    | "bad_contract_hours"
    | "bad_salary";
  /** Human sentence including the offending value. */
  detail: string;
}

/** The first few parsed rows verbatim — the layout-shift check. */
export interface OracleSampleRow {
  sheetRow: number;
  lastName: string;
  firstName: string;
  empNumber: string;
  departmentCode: string;
  departmentName: string;
  weeklyHours: number;
  daysPerWeek: number;
  salary: number;
  annualEntitlement: number;
  /** Derived, so the arithmetic is visible before anything is written. */
  dailyContractHours: number;
  monthlyBaseSalary: number;
}

/** Where a field the Oracle report does not supply came from. */
export interface OracleSourcedField {
  label: string;
  source: "hotel_defaults" | "department" | "plan" | "fixed" | "blank";
  summary: string;
}

/** Everything the importer found, with nothing yet written. */
export interface OracleImportPreview {
  /** Absolute path — passed straight back to `commit`. */
  filePath: string;
  sourceFileName: string;
  sheetName: string;
  headerRow: number;
  /** Rows found under the header row. */
  fileRowCount: number;
  /** Rows that would actually be created. */
  positionCount: number;
  skipped: OracleSkippedRow[];
  /** Positions already in this plan — context, not a guard. */
  existingPositionCount: number;
  sampleRows: OracleSampleRow[];
  bands: OracleBandPreview[];
  blockOptions: OracleBlockOption[];
  /** Department codes in the file with no name in the mapping tables. */
  unknownDepartments: string[];
  /** The Menu!O11 / O12 / O13 equivalents actually used. */
  standards: { yearlyDays: number; pubHolidays: number; daysOff: number };
  /** What filled the gaps the report leaves. */
  sourcedFields: OracleSourcedField[];
  /** Fidelity notes: what was approximated, dropped, or needs a second look. */
  warnings: string[];
}

/** Why an import could not run. */
export type OracleImportRefusal =
  | { outcome: "cancelled" }
  | { outcome: "not_oracle_file"; sourceFileName: string; reason: string }
  /** No hotel-year defaults or no calendar — the public-holiday proration has
   *  no yardstick, and guessing one silently mis-scales every row. */
  | { outcome: "no_hotel_standards"; year: number };

export type OracleImportPreviewResult =
  | OracleImportRefusal
  | { outcome: "ready"; preview: OracleImportPreview };

/** What the import actually did. */
export interface OracleImportReport {
  sourceFileName: string;
  positionsCreated: number;
  skipped: OracleSkippedRow[];
  /** As committed — commit re-resolves, so this may differ from the preview. */
  bands: OracleBandPreview[];
  /** Labels of blocks the import minted. */
  blocksCreated: string[];
  /** Labels of blocks it wrote into instead of creating. */
  blocksReused: string[];
  warnings: string[];
}

export type OracleImportCommitResult =
  | OracleImportRefusal
  | { outcome: "ok"; report: OracleImportReport };

/** Per-band choice from the confirm dialog. `auto` = whatever analyze resolved. */
export interface OracleBandOverride {
  mode: "auto" | "existing" | "create" | "off";
  /** Required when mode is "existing". */
  blockId?: string;
  rate?: number;
  accountCode?: string;
}

export interface OracleImportOptions {
  bands: Record<OracleBandKey, OracleBandOverride>;
  /** Copy posting accounts off existing rows in the same department. */
  inheritAccounts: boolean;
}

export const DEFAULT_ORACLE_IMPORT_OPTIONS: OracleImportOptions = {
  bands: {
    apprenticeshipLevy: { mode: "auto" },
    paidSickEstimate: { mode: "auto" },
  },
  inheritAccounts: true,
};

const BAND_MODES = new Set(["auto", "existing", "create", "off"]);

function normalizeBand(raw: unknown): OracleBandOverride {
  const value = (raw ?? {}) as Partial<OracleBandOverride>;
  const mode = BAND_MODES.has(String(value.mode)) ? value.mode! : "auto";
  const rate = Number(value.rate);
  const account = typeof value.accountCode === "string" ? value.accountCode.trim() : "";
  return {
    mode,
    blockId: typeof value.blockId === "string" && value.blockId ? value.blockId : undefined,
    rate: Number.isFinite(rate) && rate >= 0 ? rate : undefined,
    accountCode: account || undefined,
  };
}

export function normalizeOracleImportOptions(raw: unknown): OracleImportOptions {
  const value = (raw ?? {}) as Partial<OracleImportOptions>;
  const bands = (value.bands ?? {}) as Partial<Record<OracleBandKey, unknown>>;
  return {
    bands: {
      apprenticeshipLevy: normalizeBand(bands.apprenticeshipLevy),
      paidSickEstimate: normalizeBand(bands.paidSickEstimate),
    },
    inheritAccounts:
      value.inheritAccounts ?? DEFAULT_ORACLE_IMPORT_OPTIONS.inheritAccounts,
  };
}

export const ORACLE_IMPORT_CHANNELS = {
  /** Pick a file, parse + analyse it, write nothing, describe what would happen. */
  preview: "oracleImport:preview",
  /** Re-read the previewed path and apply it. */
  commit: "oracleImport:commit",
} as const;
