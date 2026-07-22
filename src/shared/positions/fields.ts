/**
 * Positions field catalog — domain types.
 * -----------------------------------------------------------
 * The grid's columns are not hardcoded: they are generated from a catalog of
 * FieldDefs. System fields ship with the app (see fieldSeed.ts) and are pushed
 * into the `field_catalog` table per OU; user-defined fields are ordinary rows
 * with origin 'USER'. The UI, the write path, and the persistence layer all key
 * off `FieldDef.key`, so adding a field is a seed change, not a schema change.
 *
 * Storage classes:
 *   ENGINE          typed column on the encrypted `positions` table, mapped via
 *                   ENGINE_SCALAR_COLUMNS / VECTOR_COLUMNS (feeds the engine)
 *   POSITION_EXTRA  key in the `positions.extra_values` JSON blob
 *   PII_CORE        typed column on `position_pii` (PII_CORE_COLUMNS)
 *   PII_EXTRA       key in the `position_pii.extra_values` JSON blob
 *   COMPUTED        never stored — derived in the renderer (rowModel.ts)
 *
 * SQL identifiers are ONLY ever taken from the static maps below — a field key
 * arriving over IPC is looked up, never interpolated.
 */

export const SECTION_IDS = [
  "control",
  "pii",
  "employee",
  "contract",
  "seasonality",
  "basicSalary",
  "vacation",
] as const;

export type SectionId = (typeof SECTION_IDS)[number] | (string & {});

export interface SectionDef {
  id: SectionId;
  label: string;
  order: number;
}

export type FieldDataType =
  | "TEXT"
  | "NUMBER"
  | "INTEGER"
  | "DATE"
  | "PERCENT"
  | "ENUM"
  | "ACCOUNT_CODE"
  | "BOOLEAN";

export type FieldStorage =
  | "ENGINE"
  | "POSITION_EXTRA"
  | "PII_CORE"
  | "PII_EXTRA"
  | "COMPUTED";

export type VectorName =
  | "seasonality"
  | "additionalMonthlyCosts"
  | "vacationMonthlyWeights";

/** Where a dropdown-gated field gets its options. `accounts`/`departments`
 *  resolve to reference data when it exists; until then the columnFactory
 *  degrades them to free text. */
export type DropdownSource =
  | { kind: "static"; options: Array<{ value: string | number; label: string }> }
  | { kind: "months" }
  | { kind: "accounts" }
  | { kind: "departments" };

export interface FieldValidation {
  required?: boolean;
  min?: number;
  max?: number;
  decimals?: number;
}

export interface FieldDef {
  /** Stable identifier; system keys are camelCase, user keys are `u_<uuidv7>`. */
  key: string;
  section: SectionId;
  dataType: FieldDataType;
  storage: FieldStorage;
  origin: "SYSTEM" | "USER";
  /** Locked fields cannot be renamed or deleted (engine-bound and identity fields). */
  locked: boolean;
  defaultLabel: string;
  /** User rename; null/undefined = use defaultLabel. Rejected when locked. */
  customLabel?: string | null;
  sortOrder: number;
  visible: boolean;
  editable: boolean;
  /** True for fields hidden by the PII mask toggle. */
  maskable: boolean;
  dropdownSource?: DropdownSource | null;
  validation?: FieldValidation | null;
  /** JSON-encodable default applied to new draft rows. */
  defaultValue?: unknown;
  /** Set on the 12-month families; drives flat-row <-> vector mapping. */
  vector?: VectorName;
  /** 1..12, set together with `vector`. */
  monthIndex?: number;
  /** Registry key into rowModel COMPUTES; only when storage === 'COMPUTED'. */
  computeKey?: string;
}

export interface FieldCatalog {
  sections: SectionDef[];
  fields: FieldDef[];
}

export function fieldLabel(def: FieldDef): string {
  return def.customLabel && !def.locked ? def.customLabel : def.defaultLabel;
}

// ---------------------------------------------------------------------------
// Static key -> SQL column maps. THE only source of SQL identifiers for
// dynamic writes; anything not in these maps lands in an extra_values blob.
// ---------------------------------------------------------------------------

/** Scalar engine fields: flat row key -> `positions` column. */
export const ENGINE_SCALAR_COLUMNS: Readonly<Record<string, string>> = {
  active: "active",
  departmentCode: "department_code",
  jobTypeCode: "job_type_code",
  cluster: "cluster",
  payType: "pay_type",
  headcount: "headcount",
  fte: "fte",
  monthlyBaseSalary: "monthly_base_salary",
  meritIncreasePct: "merit_increase_pct",
  manualYearlyIncrease: "manual_yearly_increase",
  increaseMonth: "increase_month",
  dailyContractHours: "daily_contract_hours",
  yearlyHoursWorked: "yearly_hours_worked",
  vacationDays: "vacation_days",
  dailyVacationCost: "daily_vacation_cost",
  accrualDaysPerMonth: "accrual_days_per_month",
  accrualCostPerDay: "accrual_cost_per_day",
};

/** Vector engine fields: vector name -> `positions` JSON column. */
export const VECTOR_COLUMNS: Readonly<Record<VectorName, string>> = {
  seasonality: "seasonality",
  additionalMonthlyCosts: "additional_monthly_costs",
  vacationMonthlyWeights: "vacation_monthly_weights",
};

/** Core PII fields: flat row key -> `position_pii` column. */
export const PII_CORE_COLUMNS: Readonly<Record<string, string>> = {
  hiringDate: "hiring_date",
  empNumber: "emp_number",
  lastName: "last_name",
  firstName: "first_name",
  title: "title",
};

/** Flat-row keys of the exploded month families, e.g. sea_1..sea_12. */
export const VECTOR_KEY_PREFIXES: Readonly<Record<VectorName, string>> = {
  seasonality: "sea",
  additionalMonthlyCosts: "addc",
  vacationMonthlyWeights: "vacw",
};

const VECTOR_KEY_RE = /^(sea|addc|vacw)_(\d{1,2})$/;

/** Parse a flat month key ("sea_3") into its vector + 1-based month, or null. */
export function parseVectorKey(
  key: string
): { vector: VectorName; monthIndex: number } | null {
  const match = VECTOR_KEY_RE.exec(key);
  if (!match) return null;
  const monthIndex = Number(match[2]);
  if (monthIndex < 1 || monthIndex > 12) return null;
  const vector = (
    Object.entries(VECTOR_KEY_PREFIXES) as Array<[VectorName, string]>
  ).find(([, prefix]) => prefix === match[1])?.[0];
  return vector ? { vector, monthIndex } : null;
}

export function vectorKey(vector: VectorName, monthIndex: number): string {
  return `${VECTOR_KEY_PREFIXES[vector]}_${monthIndex}`;
}
