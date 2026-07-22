/**
 * Request/response contracts for the `positions:*` IPC channels.
 * Shared between the main-process handlers and the renderer services so both
 * sides compile against one shape. All ids are UUIDv7 strings (plain here —
 * the engine's branded types are applied by the loader, not the wire format).
 */

import { FieldDef, SectionDef } from "./fields";

// ---------------------------------------------------------------------------
// Records (wire shapes)
// ---------------------------------------------------------------------------

export interface ScenarioDto {
  id: string;
  ou: string;
  year: number;
  label: string;
  updatedAt: string;
}

/** One position's engine-relevant data + flexible extras. Never carries PII. */
export interface PositionRecord {
  id: string;
  scenarioId: string;
  /** Stable across years — a scenario clone mints a new id but keeps this. */
  lineageId: string;
  /** False = retained in the grid but excluded from the engine. */
  active: boolean;
  departmentCode: string;
  jobTypeCode: string;
  cluster: string;
  payType: "HOURLY" | "SALARIED";
  headcount: number;
  fte: number;
  seasonality: number[];
  monthlyBaseSalary: number;
  additionalMonthlyCosts: number[];
  meritIncreasePct: number;
  manualYearlyIncrease: number;
  increaseMonth: number;
  dailyContractHours: number;
  yearlyHoursWorked: number;
  vacationDays: number;
  dailyVacationCost: number;
  vacationMonthlyWeights: number[];
  accrualDaysPerMonth: number;
  accrualCostPerDay: number;
  /** Catalog-keyed values for POSITION_EXTRA fields. */
  extraValues: Record<string, unknown>;
  updatedAt: string;
}

/** The PII sidecar for one position — only ever moves over positions:pii-get
 *  and the piiPatches lane of batch-write. */
export interface PiiRecord {
  positionId: string;
  hiringDate: string | null;
  empNumber: string | null;
  lastName: string | null;
  firstName: string | null;
  title: string | null;
  extraValues: Record<string, unknown>;
  updatedAt: string;
}

export interface ComponentValueRecord {
  positionId: string;
  componentDefId: string;
  rate: number | null;
  yearlyValue: number | null;
  monthlyValues: number[] | null;
  qty: number | null;
  unitRate: number | null;
  updatedAt: string;
}

export interface BuyoutRecord {
  id: string;
  scenarioId: string;
  departmentCode: string;
  accountCode: string;
  monthlyValues: number[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export interface OuRequest {
  ou: string;
}

export interface ScenarioScopedRequest extends OuRequest {
  scenarioId: string;
}

export interface ScenarioSaveRequest extends OuRequest {
  scenario: { id?: string; year: number; label: string };
}

export interface FieldCatalogResponse {
  sections: SectionDef[];
  fields: FieldDef[];
}

/** Patch to one catalog field. Only user-ownable attributes are accepted;
 *  renames of locked fields are rejected by the repo. */
export interface FieldCatalogPatch {
  key?: string; // absent = create a new USER field
  customLabel?: string | null;
  sortOrder?: number;
  visible?: boolean;
  /** Soft-delete a USER field (reversible via `restore`, permanent via purge). */
  remove?: boolean;
  /** Clear a USER field's soft delete — the "Recently removed" undo. */
  restore?: boolean;
  create?: Pick<
    FieldDef,
    "section" | "dataType" | "defaultLabel" | "dropdownSource" | "validation" | "defaultValue"
  > & { storage: "POSITION_EXTRA" | "PII_EXTRA" };
}

export interface FieldCatalogSaveRequest extends OuRequest {
  patches: FieldCatalogPatch[];
}

/** A soft-deleted USER column, for the "Recently removed" management surface. */
export interface RemovedFieldDto {
  key: string;
  /** Custom label if set, else the label it was created with. */
  label: string;
  section: string;
  /** ISO stamp of the soft delete. */
  deletedAt: string;
  /** Value rows across ALL scenarios that still hold data for this key. Null
   *  when the encrypted store was locked and the count could not be taken. */
  valueCount: number | null;
}

export type FieldCatalogRemovedRequest = OuRequest;

/**
 * Hard-delete request. Either an explicit `keys` list (manual purge) or a
 * `sweepGraceDays` window (the automatic cleanup: purge removed columns that
 * are empty, or whose soft delete is older than the window). Purging strips the
 * key from every position's extra_values blob and drops the catalog row.
 */
export interface FieldCatalogPurgeRequest extends OuRequest {
  keys?: string[];
  sweepGraceDays?: number;
}

export interface FieldCatalogPurgeResponse {
  /** Keys actually purged (already-gone or non-removed keys are skipped). */
  purged: string[];
}

/** Snapshot-copy every value row from one scenario into an empty other. */
export interface ScenarioCloneRequest extends OuRequest {
  sourceScenarioId: string;
  targetScenarioId: string;
}

export interface ScenarioCloneResponse {
  /** Positions copied; the child tables follow them. */
  positions: number;
}

export interface PositionsLoadResponse {
  positions: PositionRecord[];
  componentValues: ComponentValueRecord[];
  buyouts: BuyoutRecord[];
}

/** A new grid row: the full engine record + optional PII entered before the
 *  first save. The id is minted renderer-side (UUIDv7) so creates and edits
 *  coalesce in the same queue without waiting on a round trip. */
export interface PositionCreate {
  id: string;
  /** Catalog-keyed values (ENGINE scalars, vectors as number[12] under the
   *  vector name, POSITION_EXTRA keys). Missing keys take table defaults. */
  fields: Record<string, unknown>;
  pii?: Record<string, unknown>;
}

export interface PositionsBatchWriteRequest extends ScenarioScopedRequest {
  creates?: PositionCreate[];
  /** Sparse per-position patches, catalog-keyed. Vector fields arrive as whole
   *  number[12] arrays under the vector name (e.g. "seasonality"). */
  positionPatches?: Array<{ id: string; fields: Record<string, unknown> }>;
  piiPatches?: Array<{ positionId: string; fields: Record<string, unknown> }>;
  softDeleteIds?: string[];
  /** Undo a soft delete (the snackbar Undo path). */
  restoreIds?: string[];
}

export interface PositionsBatchWriteResponse {
  /** One ISO stamp for the whole batch; the renderer adopts it per row. */
  updatedAt: string;
  applied: number;
}

/** Error sentinel the renderer branches on when the encrypted DB is locked. */
export const SECURE_DB_LOCKED = "SECURE_DB_LOCKED";

export const POSITIONS_CHANNELS = {
  scenarioList: "positions:scenario-list",
  scenarioSave: "positions:scenario-save",
  scenarioDelete: "positions:scenario-delete",
  scenarioClone: "positions:scenario-clone",
  fieldCatalogGet: "positions:field-catalog-get",
  fieldCatalogSave: "positions:field-catalog-save",
  fieldCatalogRemoved: "positions:field-catalog-removed",
  fieldCatalogPurge: "positions:field-catalog-purge",
  load: "positions:load",
  piiGet: "positions:pii-get",
  batchWrite: "positions:batch-write",
  scenarioInput: "positions:scenario-input",
} as const;
