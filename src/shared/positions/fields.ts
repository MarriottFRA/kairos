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

/**
 * Which accounts an account picker offers, out of the full account_maps cache.
 *
 * Deliberately a small, open-ended shape: today it is a set of base_account
 * prefixes (headcount/working-hours book to A9…, salary/vacation to A5…), but
 * it is the one place account eligibility is expressed, so narrowing a field to
 * a tighter set later — an explicit allow-list, a level_* match, a rule keyed on
 * the row — is a change here plus the matcher in `accountAllowed`, never a change
 * at every call site. An absent/empty filter means "any account".
 */
export interface AccountFilter {
  /** base_account must start with one of these prefixes (case-insensitive). */
  startsWith?: string[];
}

/** Where a dropdown-gated field gets its options. `accounts`/`departments`
 *  resolve to reference data when it exists; until then the columnFactory
 *  degrades them to free text.
 *
 *  A `departments` picker searches and stores department NAMES (which already
 *  carry the code). `codeField` names a sibling field (e.g. `departmentCode`)
 *  that mirrors the picked department's code: selecting a name auto-fills that
 *  field and the factory renders it read-only. Omit it for a name-only picker.
 *
 *  An `accounts` picker searches by description but stores the base_account
 *  code. `filter` narrows which accounts it offers (see AccountFilter); omit it
 *  to offer every account. */
export type DropdownSource =
  // `group` is optional and only read by the type-ahead editors: a long static
  // list (Standard Title) renders section headers from it, a short one ignores
  // it. Options carrying a group must be emitted group-contiguously — see the
  // note on STANDARD_JOB_TITLE_GROUPS.
  | {
      kind: "static";
      options: Array<{ value: string | number; label: string; group?: string }>;
    }
  | { kind: "months" }
  | { kind: "accounts"; filter?: AccountFilter | null }
  | { kind: "departments"; codeField?: string }
  // Picks a hotel cluster: displays cluster NAMES, stores the cluster ID
  // (rename-safe). Options come from the hotelClusters service at column
  // build time; with none loaded the cell degrades to read-only text, like
  // an unsynced departments picker.
  | { kind: "hotelClusters" };

/**
 * Does an account code pass a field's filter? The single matcher for account
 * eligibility — the picker, and any future rule-based auto-selection, decide
 * membership here so the definition never forks. No filter (or an empty one)
 * admits every account.
 */
export function accountAllowed(
  code: string,
  filter?: AccountFilter | null
): boolean {
  const prefixes = filter?.startsWith;
  if (!prefixes || prefixes.length === 0) return true;
  const upper = code.toUpperCase();
  return prefixes.some((prefix) => upper.startsWith(prefix.toUpperCase()));
}

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
  clusterMultiplierOverride: "cluster_multiplier_override",
  payType: "pay_type",
  headcount: "headcount",
  monthlyBaseSalary: "monthly_base_salary",
  hourlyRate: "hourly_rate",
  meritIncreasePct: "merit_increase_pct",
  manualYearlyIncrease: "manual_yearly_increase",
  increaseMonth: "increase_month",
  dailyContractHours: "daily_contract_hours",
  yearlyHoursWorked: "yearly_hours_worked",
  vacationDays: "vacation_days",
  // accrualDaysPerMonth is no longer an engine scalar — it is a COMPUTED column
  // (Yearly Days ÷ 12) and the engine value is derived at load time, gated by the
  // accrual account (see loadScenarioInput). The DB column is left vestigial.
  //
  // `fte` left for the same reason in v24: it is a COMPUTED column derived from
  // the row's contract against the hotel-year full-time reference (see
  // engineInput.deriveFte), materialized by both engine paths at load. The
  // positions.fte column is vestigial — still selected by POSITION_COLUMNS, no
  // longer read or written.
};

/** The Basic Salary band offers two mutually-exclusive inputs: a fixed Monthly
 *  Basic amount or an Hourly Rate that derives the base from hours worked. Only
 *  one may hold a value on a row — the other is locked read-only. These keys are
 *  the single source of that pairing, shared by the grid (read-only gating +
 *  muting) and rowModel (sanitize clears the counterpart). */
export const BASIC_SALARY_MONTHLY_KEY = "monthlyBaseSalary";
export const BASIC_SALARY_HOURLY_KEY = "hourlyRate";

/**
 * Annual salary entry. Contracts are written per year, so Annual Basic is the
 * figure most users actually hold — but the engine's base is per active month
 * and stays that way (monthlyBaseSalary is the only salary input it reads).
 * These keys are the pairing that lets one be typed and the other derived:
 *
 *   salaryEntryMode      which face the user typed; the other is read-only
 *   annualBaseSalary     the yearly contract figure
 *
 * The conversion between them is Input Basis (below), which lives on the ROW,
 * not in a global setting, so a row's monthly figure is always reproducible
 * from the row itself — flipping a preference can never silently re-base
 * positions nobody touched. Shared by the grid (read-only gating + muting) and
 * rowModel (derivation + hydration).
 */
export const BASIC_SALARY_ANNUAL_KEY = "annualBaseSalary";
export const SALARY_ENTRY_MODE_KEY = "salaryEntryMode";

/**
 * Input Basis — what PERIOD every yearly figure on the row is stated for.
 *
 * Shipped in v19 as "Annual Basis", a hidden switch that only chose the Annual
 * → Monthly salary divisor. It always asked the more general question, and as
 * of v31 it answers it for the whole row: contract days, vacation days, the
 * manual yearly increase and the derived man-hours/FTE all read through it.
 *
 *   TWELVE          the figures describe a full 12-month contract. The post
 *                   works Σ seasonality months anyway (a new starter, a
 *                   mid-year leaver), so each yearly quantity prorates by
 *                   twm/12 and the annual salary divides by a flat 12.
 *   WORKING_MONTHS  the figures already cover only the months worked. A real
 *                   six-month contract states six months' pay, ~182 contract
 *                   days and its own leave; everything is taken as typed.
 *
 * The key STRING is unchanged from v19 so no stored row has to be rewritten to
 * be read correctly — see engineInput.basisMonthsFor for the arithmetic and
 * secure_db MIGRATIONS[7] for the one-time restatement of pre-v31 rows.
 */
export const INPUT_BASIS_KEY = "annualDivisorBasis";

/** Which of the two basic-salary faces the user types. Absent = MONTHLY, the
 *  behaviour of every row written before the Annual column existed. */
export type SalaryEntryMode = "MONTHLY" | "ANNUAL";

/** What period the row's yearly figures cover. Absent = TWELVE: every derived
 *  quantity on a pre-v19 row was computed from a full-year contract. */
export type InputBasis = "WORKING_MONTHS" | "TWELVE";

/** The hotel-cluster pair on a position: the assignment (stores a cluster id,
 *  "" = none) and the manual multiplier override (only honored while the
 *  assigned cluster has exactly one member hotel). Shared by the grid
 *  (editability gating + display) and rowModel (sanitize clears the override
 *  when the assignment changes). */
export const HOTEL_CLUSTER_KEY = "cluster";
export const HOTEL_CLUSTER_MULT_KEY = "clusterMultiplierOverride";

/** The travelling cluster ratio (weight + name), stamped by the machine that
 *  holds the cluster definition and carried on the row through sync. Read-only
 *  everywhere in the renderer — not catalog keys, so they never reach a patch.
 *  Both engine input paths fall back to them when the definition is absent. */
export const HOTEL_CLUSTER_WEIGHT_SNAPSHOT_KEY = "clusterWeightSnapshot";
export const HOTEL_CLUSTER_NAME_SNAPSHOT_KEY = "clusterNameSnapshot";

/**
 * The department code a row belongs to.
 *
 * A read-only mirror auto-filled from the department NAME dropdown, and — since
 * server sync — the authorization key too: it is what a delegation is granted
 * over and what the grid locks against. Named here because the field seed, the
 * grid's editability gate and the sync layer all have to agree on it.
 */
export const DEPARTMENT_CODE_KEY = "departmentCode";

/**
 * The per-position posting accounts, keyed to the permanent system definition
 * each one routes. POSITION_EXTRA fields, so they live in `extra_values`.
 *
 * Named here because three places must agree on them and previously did not:
 * the field seed that declares the columns, and the TWO engine-input assemblies
 * that read them (loadScenarioInput and the renderer live sim). They were
 * write-only for exactly this reason — nothing tied the stored key to a reader.
 * See engineInput.readPositionAccounts / applyPositionAccounts.
 */
/**
 * The read-only "HC Stats" column: displays the account the permanent
 * position-count head books for the row — POSITION_COUNT_ACCOUNT for every
 * Classification except Buyout Labour, which books no heads and shows blank
 * (see systemAccounts.positionCountAccountForJobType). COMPUTED and never
 * stored, surfaced so the pinned account is discoverable from the grid instead
 * of only appearing, unexplained, in Results.
 */
export const HEADCOUNT_STATS_ACCOUNT_KEY = "headcountStatsAccount";

export const ACCOUNT_FIELD_KEYS = {
  salary: "salaryAccountCode",
  headcount: "headCountAccount",
  hours: "workingHoursAccount",
  accrual: "accrualAccount",
  benefits: "benefitsAccountCode",
} as const;

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

/** The twelve flat keys of a month family, in month order. */
export function vectorKeys(vector: VectorName): string[] {
  return Array.from({ length: 12 }, (_, index) => vectorKey(vector, index + 1));
}

/**
 * Month families the grid folds away behind one summary column.
 *
 * Twelve columns is a lot of width to spend on a field most hotels never fill
 * in. The pair here is `summary field key -> the vector it stands in for`: the
 * summary is an ordinary COMPUTED column (so it sums the family and reads as
 * derived like any other), and the grid hides the twelve behind it by DEFAULT,
 * with a chevron on the summary header that expands them in place.
 *
 * Note what this is NOT: the fields keep `visible: true` in the catalog. Catalog
 * visibility means "removed column" (the Manage Columns surface, persisted per
 * OU); collapsing is a layout state on the grid's own columnVisibilityModel, so
 * it costs one click to reverse, survives via the saved layout, and the values
 * keep feeding the engine either way — a collapsed family is hidden, never off.
 */
export const COLLAPSIBLE_MONTH_FAMILIES: Readonly<Record<string, VectorName>> = {
  additionalCostsTotal: "additionalMonthlyCosts",
  totalWorkingMonths: "seasonality",
};

/** Every month key that starts out folded away. */
export function collapsibleMonthKeys(): string[] {
  return Object.values(COLLAPSIBLE_MONTH_FAMILIES).flatMap(vectorKeys);
}
