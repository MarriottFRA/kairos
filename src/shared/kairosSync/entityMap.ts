/**
 * Local rows ⇄ sync entities.
 * -----------------------------------------------------------
 * One `toEntity`/`fromEntity` pair per published type. Everything here is pure
 * and Electron-free: the repos hand it plain row objects, so the whole mapping
 * is testable without a database, and the round-trip property that the protocol
 * depends on —
 *
 *     hash(toPayload(fromPayload(p))) === hash(p)
 *
 * — is checkable directly. If that ever fails, a row looks dirty on every sync
 * and republishes forever.
 *
 * ## What is published, and what is not
 *
 * Seven types travel as entities. Everything else the server's registry knows
 * about (field catalog, blocks, component defs, SS schemes, allocations, KPI
 * drivers, calendar, position defaults) is OU-shared config keyed `(ou, …)`
 * locally and shared by every scenario at the property — it travels as one
 * versioned document through `/ou/{ou}/structure` instead. See
 * `structureDoc.ts`, and `structure_service.py`'s own docstring: "not
 * plan-scoped data pretending to be".
 *
 * ## Conventions the server enforces
 *
 * - `position_pii.entityId` MUST equal its `parentId` (both are the position
 *   id). Anything else is `PII_KEY_MISMATCH`, and the manifest never converges
 *   because the client keys the row one way and the server the other.
 * - `component_value.entityId` is `"{positionId}:{componentDefId}"`.
 * - Department-scoped payloads must carry `departmentCode`, and it must agree
 *   with the envelope's `department` — that one field is the ONLY thing the
 *   server reads out of a payload, because it is authorisation metadata.
 * - `department: ""` normalises to null server-side and lands in the owner-only
 *   branch, so an unclassified row silently stops being delegatable. We send
 *   null deliberately rather than `""` so that is visible rather than accidental.
 *
 * ## JSON columns
 *
 * `seasonality`, `monthly_values`, `extra_values` and friends are TEXT holding
 * JSON. They are parsed into the payload rather than passed through as strings:
 * a payload of real arrays and objects hashes on its VALUES, so a stored
 * `[1,1,1]` and a stored `[1, 1, 1]` are the same row. Passing the text through
 * would make whitespace a content change.
 */

import { EntityPayload } from "./protocol";

/** The seven types this client publishes as entities. */
export const PUBLISHED_ENTITY_TYPES = [
  "scenario",
  "position",
  "position_pii",
  "component_value",
  "buyout_row",
  "manual_input_row",
  "engine_run",
] as const;

export type PublishedEntityType = (typeof PUBLISHED_ENTITY_TYPES)[number];

/** Types whose rows belong to a department and are therefore delegatable. */
export const DEPARTMENT_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "position",
  "buyout_row",
  "manual_input_row",
]);

/** Types that inherit their department from a parent position. */
export const INHERITED_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "position_pii",
  "component_value",
]);

/**
 * Fallback apply order, used only if `/sync/heads` did not send one.
 *
 * The server sends `applyOrder` precisely so this cannot drift, so treat this
 * as a safety net rather than the source of truth — `pull.ts` prefers the
 * server's copy.
 */
export const FALLBACK_APPLY_ORDER: readonly string[] = [
  "scenario",
  "position",
  "position_pii",
  "component_value",
  "buyout_row",
  "manual_input_row",
  "engine_run",
];

/** A row as `better-sqlite3` hands it back: snake_case columns, SQLite types. */
export type Row = Record<string, unknown>;

/** The envelope fields derived from a row, alongside its payload. */
export interface MappedEntity {
  entityType: PublishedEntityType;
  entityId: string;
  parentId: string | null;
  department: string | null;
  deleted: boolean;
  clientUpdatedAt: string | null;
  payload: EntityPayload;
}

// ------------------------------------------------------------------ coercion

/** SQLite has no boolean; 0/1 INTEGER columns come back as numbers. */
function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nullableStr(value: unknown): string | null {
  return value == null ? null : String(value);
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNum(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse a JSON TEXT column, falling back rather than throwing.
 *
 * A malformed column is a local-corruption problem, not a reason to abort a
 * whole publish: the fallback publishes a defensible value and the row stays
 * syncable. `runRecalc` would have failed on the same row long before this.
 */
function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Serialise back to a JSON TEXT column. */
function text(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** A twelve-month array, padded or truncated. Positional — never sorted. */
function months(value: unknown, fill = 0): number[] {
  const raw = json<unknown[]>(value, []);
  const out = new Array<number>(12).fill(fill);
  for (let index = 0; index < 12; index += 1) {
    out[index] = num(Array.isArray(raw) ? raw[index] : undefined, fill);
  }
  return out;
}

/**
 * The department a row is stored under, or null.
 *
 * `''` becomes null on purpose. Both `positions` and `manual_input_rows` default
 * `department_code` to the empty string, and the server collapses `''` to NULL
 * anyway — sending it as null here means the client's own scope filters and the
 * server's agree about which rows are unclassified.
 */
export function normalizeDepartment(value: unknown): string | null {
  const code = str(value).trim();
  return code === "" ? null : code;
}

/** `"{positionId}:{componentDefId}"` — the server's id convention. */
export function componentValueId(positionId: string, componentDefId: string): string {
  return `${positionId}:${componentDefId}`;
}

/** Split a component-value id back into its parts. Empty on a malformed id. */
export function splitComponentValueId(
  entityId: string
): { positionId: string; componentDefId: string } {
  const cut = entityId.indexOf(":");
  if (cut < 0) return { positionId: entityId, componentDefId: "" };
  return {
    positionId: entityId.slice(0, cut),
    componentDefId: entityId.slice(cut + 1),
  };
}

/** `engine_run` is one row per (ou, scenario), so its id is the scenario id. */
export function engineRunId(scenarioId: string): string {
  return scenarioId;
}

// ------------------------------------------------------------------ scenario

/**
 * The plan's own row. `entityId` is the scenario id, which is also the plan id —
 * publishing it means a colleague who pulls the plan gets its label and year
 * without a second call.
 */
export function scenarioToPayload(row: Row): EntityPayload {
  return {
    id: str(row.id),
    ou: str(row.ou),
    year: num(row.year),
    label: str(row.label),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function scenarioFromPayload(payload: EntityPayload): Row {
  return {
    id: str(payload.id),
    ou: str(payload.ou),
    year: num(payload.year),
    label: str(payload.label),
    updated_at: nullableStr(payload.updatedAt) ?? new Date().toISOString(),
    deleted_at: nullableStr(payload.deletedAt),
  };
}

// ------------------------------------------------------------------ position

export function positionToPayload(row: Row): EntityPayload {
  return {
    id: str(row.id),
    ou: str(row.ou),
    scenarioId: str(row.scenario_id),
    lineageId: str(row.lineage_id),
    active: bool(row.active),
    // The server reads exactly this key and nothing else out of a payload.
    departmentCode: normalizeDepartment(row.department_code),
    jobTypeCode: str(row.job_type_code),
    cluster: str(row.cluster),
    clusterMultiplierOverride: nullableNum(row.cluster_multiplier_override),
    clusterLinkId: str(row.cluster_link_id),
    payType: str(row.pay_type) || "SALARIED",
    headcount: num(row.headcount, 1),
    fte: num(row.fte, 1),
    seasonality: months(row.seasonality, 1),
    monthlyBaseSalary: num(row.monthly_base_salary),
    hourlyRate: num(row.hourly_rate),
    additionalMonthlyCosts: months(row.additional_monthly_costs),
    meritIncreasePct: num(row.merit_increase_pct),
    manualYearlyIncrease: num(row.manual_yearly_increase),
    increaseMonth: num(row.increase_month, 13),
    dailyContractHours: num(row.daily_contract_hours),
    yearlyHoursWorked: num(row.yearly_hours_worked),
    vacationDays: num(row.vacation_days),
    vacationMonthlyWeights: months(row.vacation_monthly_weights),
    accrualDaysPerMonth: num(row.accrual_days_per_month),
    extraValues: json<Record<string, unknown>>(row.extra_values, {}),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function positionFromPayload(payload: EntityPayload): Row {
  return {
    id: str(payload.id),
    ou: str(payload.ou),
    scenario_id: str(payload.scenarioId),
    lineage_id: str(payload.lineageId),
    active: bool(payload.active) ? 1 : 0,
    department_code: normalizeDepartment(payload.departmentCode) ?? "",
    job_type_code: str(payload.jobTypeCode),
    cluster: str(payload.cluster),
    cluster_multiplier_override: nullableNum(payload.clusterMultiplierOverride),
    cluster_link_id: str(payload.clusterLinkId),
    pay_type: str(payload.payType) || "SALARIED",
    headcount: num(payload.headcount, 1),
    fte: num(payload.fte, 1),
    seasonality: text(months(payload.seasonality, 1)),
    monthly_base_salary: num(payload.monthlyBaseSalary),
    hourly_rate: num(payload.hourlyRate),
    additional_monthly_costs: text(months(payload.additionalMonthlyCosts)),
    merit_increase_pct: num(payload.meritIncreasePct),
    manual_yearly_increase: num(payload.manualYearlyIncrease),
    increase_month: num(payload.increaseMonth, 13),
    daily_contract_hours: num(payload.dailyContractHours),
    yearly_hours_worked: num(payload.yearlyHoursWorked),
    vacation_days: num(payload.vacationDays),
    vacation_monthly_weights: text(months(payload.vacationMonthlyWeights)),
    accrual_days_per_month: num(payload.accrualDaysPerMonth),
    extra_values: text(json<Record<string, unknown>>(payload.extraValues, {})),
    updated_at: nullableStr(payload.updatedAt) ?? new Date().toISOString(),
    deleted_at: nullableStr(payload.deletedAt),
  };
}

// -------------------------------------------------------------- position_pii

/**
 * Employee personal details.
 *
 * Published through the ordinary commit chunk but diverted server-side into a
 * separate AES-GCM-sealed table, and read back through `GET /plans/{id}/pii`
 * rather than `/changes`. `ou` and `scenarioId` ride along so a pull can insert
 * the row without joining back to its position.
 */
export function piiToPayload(row: Row): EntityPayload {
  return {
    positionId: str(row.position_id),
    ou: str(row.ou),
    scenarioId: str(row.scenario_id),
    hiringDate: nullableStr(row.hiring_date),
    empNumber: nullableStr(row.emp_number),
    lastName: nullableStr(row.last_name),
    firstName: nullableStr(row.first_name),
    title: nullableStr(row.title),
    extraValues: json<Record<string, unknown>>(row.extra_values, {}),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function piiFromPayload(payload: EntityPayload): Row {
  return {
    position_id: str(payload.positionId),
    ou: str(payload.ou),
    scenario_id: str(payload.scenarioId),
    hiring_date: nullableStr(payload.hiringDate),
    emp_number: nullableStr(payload.empNumber),
    last_name: nullableStr(payload.lastName),
    first_name: nullableStr(payload.firstName),
    title: nullableStr(payload.title),
    extra_values: text(json<Record<string, unknown>>(payload.extraValues, {})),
    updated_at: nullableStr(payload.updatedAt) ?? new Date().toISOString(),
    deleted_at: nullableStr(payload.deletedAt),
  };
}

// ----------------------------------------------------------- component_value

export function componentValueToPayload(row: Row): EntityPayload {
  return {
    positionId: str(row.position_id),
    componentDefId: str(row.component_def_id),
    ou: str(row.ou),
    scenarioId: str(row.scenario_id),
    rate: nullableNum(row.rate),
    yearlyValue: nullableNum(row.yearly_value),
    // Nullable on purpose: NULL and a zero-filled array mean different things to
    // the engine (unset vs explicitly zero for every month).
    monthlyValues: row.monthly_values == null ? null : months(row.monthly_values),
    qty: nullableNum(row.qty),
    unitRate: nullableNum(row.unit_rate),
    ssOpeningBase: nullableNum(row.ss_opening_base),
    accountCode: nullableStr(row.account_code),
    statsAccountCode: nullableStr(row.stats_account_code),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function componentValueFromPayload(payload: EntityPayload): Row {
  return {
    position_id: str(payload.positionId),
    component_def_id: str(payload.componentDefId),
    ou: str(payload.ou),
    scenario_id: str(payload.scenarioId),
    rate: nullableNum(payload.rate),
    yearly_value: nullableNum(payload.yearlyValue),
    monthly_values:
      payload.monthlyValues == null ? null : text(months(payload.monthlyValues)),
    qty: nullableNum(payload.qty),
    unit_rate: nullableNum(payload.unitRate),
    ss_opening_base: nullableNum(payload.ssOpeningBase),
    account_code: nullableStr(payload.accountCode),
    stats_account_code: nullableStr(payload.statsAccountCode),
    updated_at: nullableStr(payload.updatedAt) ?? new Date().toISOString(),
    deleted_at: nullableStr(payload.deletedAt),
  };
}

// ---------------------------------------------------------------- buyout_row

export function buyoutToPayload(row: Row): EntityPayload {
  return {
    id: str(row.id),
    ou: str(row.ou),
    scenarioId: str(row.scenario_id),
    departmentCode: normalizeDepartment(row.department_code),
    accountCode: str(row.account_code),
    monthlyValues: months(row.monthly_values),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function buyoutFromPayload(payload: EntityPayload): Row {
  return {
    id: str(payload.id),
    ou: str(payload.ou),
    scenario_id: str(payload.scenarioId),
    department_code: normalizeDepartment(payload.departmentCode) ?? "",
    account_code: str(payload.accountCode),
    monthly_values: text(months(payload.monthlyValues)),
    updated_at: nullableStr(payload.updatedAt) ?? new Date().toISOString(),
    deleted_at: nullableStr(payload.deletedAt),
  };
}

// ---------------------------------------------------------- manual_input_row

/**
 * Hand-entered cost lines.
 *
 * Note the two department columns: `department` is the display NAME and
 * `department_code` is the code. Only the CODE is authorisation-relevant, so
 * that is what goes in the envelope and in `departmentCode`; the name rides in
 * the payload as ordinary data.
 */
export function manualInputToPayload(row: Row): EntityPayload {
  return {
    id: str(row.id),
    ou: str(row.ou),
    scenarioId: str(row.scenario_id),
    description: str(row.description),
    department: str(row.department),
    departmentCode: normalizeDepartment(row.department_code),
    costAccount: str(row.cost_account),
    statsAccount: str(row.stats_account),
    // NULL vs a number is the mode switch: null means the amounts were typed,
    // set means they are derived from rate × stats. Never coerce it to 0.
    rate: nullableNum(row.rate),
    stats: months(row.stats_json),
    amounts: months(row.amounts_json),
    spreadMode: nullableStr(row.spread_mode),
    spreadBaseStats: nullableNum(row.spread_base_stats),
    spreadBaseAmount: nullableNum(row.spread_base_amount),
    increasePct: num(row.increase_pct),
    increaseMonth: num(row.increase_month, 13),
    sortOrder: num(row.sort_order),
    createdBy: nullableStr(row.created_by),
    createdAt: nullableStr(row.created_at),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function manualInputFromPayload(payload: EntityPayload): Row {
  const now = new Date().toISOString();
  return {
    id: str(payload.id),
    ou: str(payload.ou),
    scenario_id: str(payload.scenarioId),
    description: str(payload.description),
    department: str(payload.department),
    department_code: normalizeDepartment(payload.departmentCode) ?? "",
    cost_account: str(payload.costAccount),
    stats_account: str(payload.statsAccount),
    rate: nullableNum(payload.rate),
    stats_json: text(months(payload.stats)),
    amounts_json: text(months(payload.amounts)),
    spread_mode: nullableStr(payload.spreadMode),
    spread_base_stats: nullableNum(payload.spreadBaseStats),
    spread_base_amount: nullableNum(payload.spreadBaseAmount),
    increase_pct: num(payload.increasePct),
    increase_month: num(payload.increaseMonth, 13),
    sort_order: num(payload.sortOrder),
    created_by: nullableStr(payload.createdBy),
    created_at: nullableStr(payload.createdAt) ?? now,
    updated_at: nullableStr(payload.updatedAt) ?? now,
    deleted_at: nullableStr(payload.deletedAt),
  };
}

// ---------------------------------------------------------------- engine_run

/**
 * Recalculation metadata — never the output lines.
 *
 * The lines are ~10k rows of derived numbers that the recipient's own engine
 * reproduces exactly; publishing them as entities would multiply a plan's wire
 * size for data nobody merges. They go to `PUT /plans/{id}/artifacts/engine_output`
 * as one opaque blob instead. What travels here is the fingerprint, so a puller
 * can tell whether the publisher's results were current when they published.
 */
export function engineRunToPayload(row: Row): EntityPayload {
  return {
    ou: str(row.ou),
    scenarioId: str(row.scenario_id),
    fingerprint: str(row.fingerprint),
    computedAt: nullableStr(row.computed_at),
    lineCount: num(row.line_count),
    positionCount: num(row.position_count),
  };
}

export function engineRunFromPayload(payload: EntityPayload): Row {
  return {
    ou: str(payload.ou),
    scenario_id: str(payload.scenarioId),
    fingerprint: str(payload.fingerprint),
    computed_at: nullableStr(payload.computedAt) ?? new Date().toISOString(),
    line_count: num(payload.lineCount),
    position_count: num(payload.positionCount),
  };
}

// ------------------------------------------------------------------ registry

interface TypeSpec {
  toPayload: (row: Row) => EntityPayload;
  fromPayload: (payload: EntityPayload) => Row;
  /** The entity id, read off a LOCAL row. */
  idOf: (row: Row) => string;
  /** The parent position id, for the inherited types. */
  parentOf: (row: Row) => string | null;
  /** The authorising department code, or null. */
  departmentOf: (row: Row) => string | null;
}

export const ENTITY_SPECS: Record<PublishedEntityType, TypeSpec> = {
  scenario: {
    toPayload: scenarioToPayload,
    fromPayload: scenarioFromPayload,
    idOf: (row) => str(row.id),
    parentOf: () => null,
    departmentOf: () => null,
  },
  position: {
    toPayload: positionToPayload,
    fromPayload: positionFromPayload,
    idOf: (row) => str(row.id),
    parentOf: () => null,
    departmentOf: (row) => normalizeDepartment(row.department_code),
  },
  position_pii: {
    toPayload: piiToPayload,
    fromPayload: piiFromPayload,
    // entityId === parentId === the position id. Anything else is PII_KEY_MISMATCH.
    idOf: (row) => str(row.position_id),
    parentOf: (row) => str(row.position_id),
    departmentOf: () => null, // inherited from the parent position, server-side
  },
  component_value: {
    toPayload: componentValueToPayload,
    fromPayload: componentValueFromPayload,
    idOf: (row) => componentValueId(str(row.position_id), str(row.component_def_id)),
    parentOf: (row) => str(row.position_id),
    departmentOf: () => null,
  },
  buyout_row: {
    toPayload: buyoutToPayload,
    fromPayload: buyoutFromPayload,
    idOf: (row) => str(row.id),
    parentOf: () => null,
    departmentOf: (row) => normalizeDepartment(row.department_code),
  },
  manual_input_row: {
    toPayload: manualInputToPayload,
    fromPayload: manualInputFromPayload,
    idOf: (row) => str(row.id),
    parentOf: () => null,
    departmentOf: (row) => normalizeDepartment(row.department_code),
  },
  engine_run: {
    toPayload: engineRunToPayload,
    fromPayload: engineRunFromPayload,
    idOf: (row) => engineRunId(str(row.scenario_id)),
    parentOf: () => null,
    departmentOf: () => null,
  },
};

export function isPublishedType(value: string): value is PublishedEntityType {
  return Object.prototype.hasOwnProperty.call(ENTITY_SPECS, value);
}

/** Build the full envelope + payload for one local row. */
export function toEntity(entityType: PublishedEntityType, row: Row): MappedEntity {
  const spec = ENTITY_SPECS[entityType];
  return {
    entityType,
    entityId: spec.idOf(row),
    parentId: spec.parentOf(row),
    department: spec.departmentOf(row),
    deleted: row.deleted_at != null,
    clientUpdatedAt: nullableStr(row.updated_at) ?? nullableStr(row.computed_at),
    payload: spec.toPayload(row),
  };
}
