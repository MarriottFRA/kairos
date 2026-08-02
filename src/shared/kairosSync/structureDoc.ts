/**
 * The OU structure document — build, merge, diff.
 * -----------------------------------------------------------
 * Everything a hotel configures once and every scenario at that hotel shares:
 * the field catalog, blocks and their compiled component definitions, social
 * security schemes, allocations, KPI drivers, the budget calendar, and the safe
 * defaults for new positions. All of it is keyed `(ou, …)` locally, so it
 * travels as ONE versioned document through `/ou/{ou}/structure` rather than as
 * per-plan entity rows.
 *
 * That is not just a size optimisation. A hotel with three scenarios would
 * otherwise store three identical copies of its column set, and pulling plan B
 * would overwrite whatever plan A had just written to the same local table —
 * two plans fighting over rows that were never plan-scoped to begin with. The
 * server's own `structure_service.py` says the same thing: "not plan-scoped
 * data pretending to be".
 *
 * ## The merge rule
 *
 * A pull is an **additive upsert with tombstone-only removal**. A document that
 * simply lacks a section, or lacks a row inside one, must never be read as
 * "delete that". Two reasons, and the first is the one that bites:
 *
 *   1. A locally created field-catalog column (`origin='USER'`) that a colleague
 *      has not pulled yet is absent from the document they then publish. Under
 *      subtractive merge, their publish silently deletes a column — and with it
 *      the `extra_values` key every position stores under it.
 *   2. The seed (`fieldSeed.ts`) adds system columns on a version bump. A client
 *      on an older seed publishes a document without them; a newer client must
 *      keep its own.
 *
 * Deletion therefore travels as an explicit `deletedAt` on the row, exactly as
 * it does in the local stores. `mergeStructureDoc` returns the removals it found
 * so the Sync page can list them before anything is written.
 *
 * Pure and Electron-free: the repo hands it rows, it hands back rows.
 */

import {
  DEFAULT_BANK_HOLIDAY_APPLIES_TO,
  DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER,
  DEFAULT_BANK_HOLIDAY_STAFF_FRACTION,
} from "../calendar";
import { Row } from "./entityMap";

/** The document's shape. Sections are optional so an older client can omit one. */
export interface StructureDoc {
  /** Bumped when the SHAPE changes, not the contents. Lets a future client
   *  recognise a document it does not fully understand instead of guessing. */
  docVersion: number;
  ou: string;
  /** Sections a newer client added that this one does not know about are kept
   *  verbatim rather than dropped — otherwise a round trip through an older
   *  client silently deletes a colleague's configuration. */
  [section: string]: unknown;
  fieldCatalog?: Row[];
  blockConfigs?: Row[];
  componentDefs?: Row[];
  ssSchemes?: Row[];
  allocations?: Row[];
  kpiDrivers?: Row[];
  calendars?: Row[];
  positionDefaults?: Row[];
}

export const STRUCTURE_DOC_VERSION = 1;

/** Every section, with the columns that identify a row inside it. */
export const STRUCTURE_SECTIONS = [
  { key: "fieldCatalog", idKeys: ["ou", "fieldKey"] },
  { key: "blockConfigs", idKeys: ["id"] },
  { key: "componentDefs", idKeys: ["id"] },
  { key: "ssSchemes", idKeys: ["id"] },
  { key: "allocations", idKeys: ["id"] },
  { key: "kpiDrivers", idKeys: ["id"] },
  { key: "calendars", idKeys: ["ou", "year"] },
  { key: "positionDefaults", idKeys: ["ou", "year"] },
] as const;

export type StructureSectionKey = (typeof STRUCTURE_SECTIONS)[number]["key"];

/** The composite key of a row within its section, as one string. */
export function structureRowKey(
  section: StructureSectionKey,
  row: Record<string, unknown>
): string {
  const spec = STRUCTURE_SECTIONS.find((entry) => entry.key === section);
  if (!spec) return "";
  return spec.idKeys.map((key) => String(row[key] ?? "")).join(" ");
}

// --------------------------------------------------------------- row coercion

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

/** The bank-holiday coverage map, from either side of the boundary: a JSON
 *  string on the local row, an already-parsed object in the document. Finite
 *  numeric entries only — normalizeBankHoliday clamps them properly once the
 *  calendar is read back through it. */
function parseCoverage(value: unknown): Record<string, number> {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source || "{}");
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== "object") return {};
  const out: Record<string, number> = {};
  for (const [code, raw] of Object.entries(source as Record<string, unknown>)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) out[code] = parsed;
  }
  return out;
}

function nullableNum(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function text(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// ------------------------------------------------------------- field catalog

export function fieldCatalogToDoc(row: Row): Row {
  return {
    ou: str(row.ou),
    fieldKey: str(row.field_key),
    section: str(row.section),
    dataType: str(row.data_type),
    storage: str(row.storage),
    origin: str(row.origin) || "SYSTEM",
    locked: bool(row.locked),
    defaultLabel: str(row.default_label),
    customLabel: nullableStr(row.custom_label),
    sortOrder: num(row.sort_order),
    visible: bool(row.visible),
    editable: bool(row.editable),
    maskable: bool(row.maskable),
    vector: nullableStr(row.vector),
    monthIndex: nullableNum(row.month_index),
    computeKey: nullableStr(row.compute_key),
    dropdownSource: nullableStr(row.dropdown_source),
    validation: nullableStr(row.validation),
    defaultValue: nullableStr(row.default_value),
    seedVersion: num(row.seed_version, 1),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function fieldCatalogFromDoc(row: Row): Row {
  return {
    ou: str(row.ou),
    field_key: str(row.fieldKey),
    section: str(row.section),
    data_type: str(row.dataType),
    storage: str(row.storage),
    origin: str(row.origin) || "SYSTEM",
    locked: bool(row.locked) ? 1 : 0,
    default_label: str(row.defaultLabel),
    custom_label: nullableStr(row.customLabel),
    sort_order: num(row.sortOrder),
    visible: bool(row.visible) ? 1 : 0,
    editable: bool(row.editable) ? 1 : 0,
    maskable: bool(row.maskable) ? 1 : 0,
    vector: nullableStr(row.vector),
    month_index: nullableNum(row.monthIndex),
    compute_key: nullableStr(row.computeKey),
    dropdown_source: nullableStr(row.dropdownSource),
    validation: nullableStr(row.validation),
    default_value: nullableStr(row.defaultValue),
    seed_version: num(row.seedVersion, 1),
    updated_at: nullableStr(row.updatedAt) ?? new Date().toISOString(),
    deleted_at: nullableStr(row.deletedAt),
  };
}

// --------------------------------------------------------------------- blocks

export function blockConfigToDoc(row: Row): Row {
  return {
    id: str(row.id),
    ou: str(row.ou),
    blockType: str(row.block_type),
    label: str(row.label),
    // Parsed rather than passed through as TEXT so the document hashes on the
    // config's VALUES; otherwise a re-serialisation with different key order
    // reads as a changed block.
    config: json<Record<string, unknown>>(row.config, {}),
    sortOrder: num(row.sort_order),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function blockConfigFromDoc(row: Row): Row {
  return {
    id: str(row.id),
    ou: str(row.ou),
    block_type: str(row.blockType),
    label: str(row.label),
    config: text(json<Record<string, unknown>>(row.config, {})),
    sort_order: num(row.sortOrder),
    updated_at: nullableStr(row.updatedAt) ?? new Date().toISOString(),
    deleted_at: nullableStr(row.deletedAt),
  };
}

// ---------------------------------------------------------- component defs

/**
 * A compiled cost-component definition, with its `component_base_refs`
 * inclusion list nested. The refs are a child table with no identity of their
 * own — folding them in means one row cannot be applied without the other.
 */
export function componentDefToDoc(row: Row, baseRefs: Row[]): Row {
  return {
    id: str(row.id),
    ou: str(row.ou),
    kind: str(row.kind),
    spreadMethod: nullableStr(row.spread_method),
    statKind: nullableStr(row.stat_kind),
    label: str(row.label),
    accountCode: str(row.account_code),
    departmentMode: str(row.department_mode) || "POSITION",
    fixedDepartment: nullableStr(row.fixed_department),
    increaseAware: bool(row.increase_aware),
    sortOrder: num(row.sort_order),
    baseSelectorKind: nullableStr(row.base_selector_kind),
    ssSchemeId: nullableStr(row.ss_scheme_id),
    kpiDriverId: nullableStr(row.kpi_driver_id),
    blockId: nullableStr(row.block_id),
    baseRef: nullableStr(row.base_ref) === null ? null : json(row.base_ref, null),
    // Ratio blocks opt out of the engine's headcount post-pass. Additive: a
    // document from a client that predates it simply omits the key and reads
    // back as false, which is the pre-existing behaviour.
    countExempt: bool(row.count_exempt),
    baseRefs: baseRefs
      .map((ref) => ({
        referencedDefId: str(ref.referenced_def_id),
        sortOrder: num(ref.sort_order),
      }))
      // Ordered so two clients that read the child table in different physical
      // orders still produce the same document hash.
      .sort((a, b) =>
        a.sortOrder - b.sortOrder ||
        a.referencedDefId.localeCompare(b.referencedDefId)
      ),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function componentDefFromDoc(row: Row): { def: Row; baseRefs: Row[] } {
  const id = str(row.id);
  const refs = Array.isArray(row.baseRefs) ? (row.baseRefs as Row[]) : [];
  return {
    def: {
      id,
      ou: str(row.ou),
      kind: str(row.kind),
      spread_method: nullableStr(row.spreadMethod),
      stat_kind: nullableStr(row.statKind),
      label: str(row.label),
      account_code: str(row.accountCode),
      department_mode: str(row.departmentMode) || "POSITION",
      fixed_department: nullableStr(row.fixedDepartment),
      increase_aware: bool(row.increaseAware) ? 1 : 0,
      sort_order: num(row.sortOrder),
      base_selector_kind: nullableStr(row.baseSelectorKind),
      ss_scheme_id: nullableStr(row.ssSchemeId),
      kpi_driver_id: nullableStr(row.kpiDriverId),
      block_id: nullableStr(row.blockId),
      base_ref: row.baseRef == null ? null : text(row.baseRef),
      count_exempt: bool(row.countExempt) ? 1 : 0,
      updated_at: nullableStr(row.updatedAt) ?? new Date().toISOString(),
      deleted_at: nullableStr(row.deletedAt),
    },
    baseRefs: refs.map((ref) => ({
      component_def_id: id,
      referenced_def_id: str(ref.referencedDefId),
      sort_order: num(ref.sortOrder),
    })),
  };
}

// --------------------------------------------------------------- ss schemes

export function ssSchemeToDoc(row: Row, brackets: Row[]): Row {
  return {
    id: str(row.id),
    ou: str(row.ou),
    label: str(row.label),
    monthlyCap: nullableNum(row.monthly_cap),
    yearlyCap: nullableNum(row.yearly_cap),
    accumulationMode: str(row.accumulation_mode) || "CUMULATIVE",
    taxYearStartMonth: num(row.tax_year_start_month, 1),
    includeBaseSalary: bool(row.include_base_salary),
    includeVacation: bool(row.include_vacation),
    baseComponentIds: json<string[]>(row.base_component_ids, []),
    brackets: brackets
      .map((bracket) => ({
        bracketIndex: num(bracket.bracket_index),
        upTo: nullableNum(bracket.up_to),
        rate: num(bracket.rate),
      }))
      // Positional in meaning — a bracket's index IS its place in the ladder.
      .sort((a, b) => a.bracketIndex - b.bracketIndex),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function ssSchemeFromDoc(row: Row): { scheme: Row; brackets: Row[] } {
  const id = str(row.id);
  const brackets = Array.isArray(row.brackets) ? (row.brackets as Row[]) : [];
  return {
    scheme: {
      id,
      ou: str(row.ou),
      label: str(row.label),
      monthly_cap: nullableNum(row.monthlyCap),
      yearly_cap: nullableNum(row.yearlyCap),
      accumulation_mode: str(row.accumulationMode) || "CUMULATIVE",
      tax_year_start_month: num(row.taxYearStartMonth, 1),
      include_base_salary: bool(row.includeBaseSalary) ? 1 : 0,
      include_vacation: bool(row.includeVacation) ? 1 : 0,
      base_component_ids: text(json<string[]>(row.baseComponentIds, [])),
      updated_at: nullableStr(row.updatedAt) ?? new Date().toISOString(),
      deleted_at: nullableStr(row.deletedAt),
    },
    brackets: brackets.map((bracket) => ({
      scheme_id: id,
      bracket_index: num(bracket.bracketIndex),
      up_to: nullableNum(bracket.upTo),
      rate: num(bracket.rate),
    })),
  };
}

// -------------------------------------------------------------- allocations

export function allocationToDoc(row: Row): Row {
  return {
    id: str(row.id),
    ou: str(row.ou),
    name: str(row.name),
    spreadBase: str(row.spread_base),
    excludedDepartments: json<string[]>(row.excluded_departments, []),
    injectAccount: str(row.inject_account),
    sortOrder: num(row.sort_order),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function allocationFromDoc(row: Row): Row {
  return {
    id: str(row.id),
    ou: str(row.ou),
    name: str(row.name),
    spread_base: str(row.spreadBase),
    excluded_departments: text(json<string[]>(row.excludedDepartments, [])),
    inject_account: str(row.injectAccount),
    sort_order: num(row.sortOrder),
    updated_at: nullableStr(row.updatedAt) ?? new Date().toISOString(),
    deleted_at: nullableStr(row.deletedAt),
  };
}

// -------------------------------------------------------------- kpi drivers

/**
 * A driver's definition, with its department patterns and account prefixes
 * nested. `kpi_driver_values` is deliberately NOT here: it is a precalculated
 * cache derived from the hotel's own budget import, reproducible locally, and
 * `POST /ou/{ou}/kpi-series` recomputes it server-side without touching the blob.
 */
export function kpiDriverToDoc(row: Row, patterns: Row[], accounts: Row[]): Row {
  return {
    id: str(row.id),
    ou: str(row.ou),
    label: str(row.label),
    description: str(row.description),
    deptMode: str(row.dept_mode),
    bucketIndex: num(row.bucket_index, 1),
    aggregation: str(row.aggregation) || "SUM",
    multiplier: num(row.multiplier, 1),
    sortOrder: num(row.sort_order),
    deptPatterns: patterns.map((entry) => str(entry.pattern)).sort(),
    accountPrefixes: accounts.map((entry) => str(entry.starts_with)).sort(),
    createdBy: nullableStr(row.created_by),
    updatedAt: nullableStr(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function kpiDriverFromDoc(
  row: Row
): { driver: Row; patterns: Row[]; accounts: Row[] } {
  const id = str(row.id);
  const patterns = Array.isArray(row.deptPatterns) ? (row.deptPatterns as unknown[]) : [];
  const accounts = Array.isArray(row.accountPrefixes)
    ? (row.accountPrefixes as unknown[])
    : [];
  return {
    driver: {
      id,
      ou: str(row.ou),
      label: str(row.label),
      description: str(row.description),
      dept_mode: str(row.deptMode),
      bucket_index: num(row.bucketIndex, 1),
      aggregation: str(row.aggregation) || "SUM",
      multiplier: num(row.multiplier, 1),
      sort_order: num(row.sortOrder),
      created_by: nullableStr(row.createdBy),
      updated_at: nullableStr(row.updatedAt) ?? new Date().toISOString(),
      deleted_at: nullableStr(row.deletedAt),
    },
    patterns: patterns.map((pattern) => ({ driver_id: id, pattern: str(pattern) })),
    accounts: accounts.map((prefix) => ({ driver_id: id, starts_with: str(prefix) })),
  };
}

// ----------------------------------------------------------------- calendar

export function calendarToDoc(row: Row, monthRows: Row[]): Row {
  return {
    ou: str(row.ou),
    year: num(row.year),
    weekendMask: num(row.weekend_mask),
    bankHolidayEnabled: bool(row.bank_holiday_enabled),
    bankHolidayStaffFraction: num(
      row.bank_holiday_staff_fraction,
      DEFAULT_BANK_HOLIDAY_STAFF_FRACTION
    ),
    bankHolidayPremiumMultiplier: num(
      row.bank_holiday_premium_multiplier,
      DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER
    ),
    bankHolidayAccount: str(row.bank_holiday_account),
    bankHolidayAppliesTo: str(row.bank_holiday_applies_to) || DEFAULT_BANK_HOLIDAY_APPLIES_TO,
    bankHolidayPaidWhenNotWorked: bool(row.bank_holiday_paid_when_not_worked),
    // Parsed rather than passed through as TEXT so the document hashes on the
    // map's VALUES — the same reason blockConfigToDoc parses its config blob.
    bankHolidayCoverageByDepartment: parseCoverage(row.bank_holiday_coverage_json),
    months: monthRows
      .map((month) => ({
        month: num(month.month),
        calendarDays: num(month.calendar_days),
        publicHolidays: num(month.public_holidays),
        weekendDays: num(month.weekend_days),
      }))
      .sort((a, b) => a.month - b.month),
    updatedAt: nullableStr(row.updated_at),
  };
}

export function calendarFromDoc(row: Row): { year: Row; months: Row[] } {
  const ou = str(row.ou);
  const year = num(row.year);
  const monthRows = Array.isArray(row.months) ? (row.months as Row[]) : [];
  return {
    year: {
      ou,
      year,
      weekend_mask: num(row.weekendMask),
      bank_holiday_enabled: bool(row.bankHolidayEnabled) ? 1 : 0,
      bank_holiday_staff_fraction: num(
        row.bankHolidayStaffFraction,
        DEFAULT_BANK_HOLIDAY_STAFF_FRACTION
      ),
      bank_holiday_premium_multiplier: num(
        row.bankHolidayPremiumMultiplier,
        DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER
      ),
      bank_holiday_account: str(row.bankHolidayAccount),
      bank_holiday_applies_to:
        str(row.bankHolidayAppliesTo) || DEFAULT_BANK_HOLIDAY_APPLIES_TO,
      bank_holiday_paid_when_not_worked: bool(row.bankHolidayPaidWhenNotWorked) ? 1 : 0,
      bank_holiday_coverage_json: JSON.stringify(
        parseCoverage(row.bankHolidayCoverageByDepartment)
      ),
      updated_at: nullableStr(row.updatedAt) ?? new Date().toISOString(),
    },
    months: monthRows.map((month) => ({
      ou,
      year,
      month: num(month.month),
      calendar_days: num(month.calendarDays),
      public_holidays: num(month.publicHolidays),
      weekend_days: num(month.weekendDays),
    })),
  };
}

// -------------------------------------------------------- position defaults

export function positionDefaultsToDoc(row: Row): Row {
  return {
    ou: str(row.ou),
    year: num(row.year),
    weeklyHours: num(row.weekly_hours, 40),
    fields: json<Record<string, unknown>>(row.fields_json, {}),
    updatedAt: nullableStr(row.updated_at),
  };
}

export function positionDefaultsFromDoc(row: Row): Row {
  return {
    ou: str(row.ou),
    year: num(row.year),
    weekly_hours: num(row.weeklyHours, 40),
    fields_json: text(json<Record<string, unknown>>(row.fields, {})),
    updated_at: nullableStr(row.updatedAt) ?? new Date().toISOString(),
  };
}

// -------------------------------------------------------------------- merge

export interface StructureChange {
  section: StructureSectionKey;
  key: string;
  /** A human-readable handle for the Sync page — a label or a code, not an id. */
  label: string;
  kind: "added" | "updated" | "removed";
}

export interface StructureMerge {
  /** The document to write locally: ours, plus theirs, with tombstones applied. */
  doc: StructureDoc;
  changes: StructureChange[];
}

/** Best-effort display name for a row, for the diff list. */
function labelOf(section: StructureSectionKey, row: Record<string, unknown>): string {
  const candidates = ["label", "name", "defaultLabel", "fieldKey", "id", "year"];
  for (const key of candidates) {
    const value = row[key];
    if (value != null && value !== "") return String(value);
  }
  return structureRowKey(section, row);
}

/**
 * Merge a pulled document over the local one.
 *
 * Additive: a row present locally but absent from `incoming` is KEPT. A row
 * present in both takes the incoming version. A row whose incoming copy carries
 * `deletedAt` is reported as a removal — the caller writes the tombstone, it is
 * not silently dropped here, because the Sync page shows removals before
 * anything is applied.
 */
export function mergeStructureDoc(
  local: StructureDoc,
  incoming: StructureDoc
): StructureMerge {
  const changes: StructureChange[] = [];
  const merged: StructureDoc = {
    docVersion: STRUCTURE_DOC_VERSION,
    ou: incoming.ou || local.ou,
  };

  // Carry through anything a newer client added that this one has no mapping
  // for. Dropping it would mean a round trip through an older client silently
  // deletes a section of the property's configuration — the same failure mode
  // the additive merge below exists to prevent, one level up.
  const known = new Set<string>([
    "docVersion",
    "ou",
    ...STRUCTURE_SECTIONS.map((entry) => entry.key as string),
  ]);
  for (const source of [local, incoming]) {
    for (const key of Object.keys(source)) {
      if (!known.has(key)) merged[key] = source[key];
    }
  }

  for (const { key: section } of STRUCTURE_SECTIONS) {
    const localRows = (local[section] as Row[] | undefined) ?? [];
    const incomingRows = (incoming[section] as Row[] | undefined) ?? [];

    const byKey = new Map<string, Row>();
    for (const row of localRows) byKey.set(structureRowKey(section, row), row);

    for (const row of incomingRows) {
      const key = structureRowKey(section, row);
      const existing = byKey.get(key);
      const wasDeleted = existing?.deletedAt != null;
      const nowDeleted = row.deletedAt != null;

      if (!existing) {
        // A tombstone for a row we never had is not news — record nothing and
        // still store it, so we do not re-create the row from an older peer.
        if (!nowDeleted) {
          changes.push({ section, key, label: labelOf(section, row), kind: "added" });
        }
      } else if (nowDeleted && !wasDeleted) {
        changes.push({ section, key, label: labelOf(section, row), kind: "removed" });
      } else if (JSON.stringify(existing) !== JSON.stringify(row)) {
        changes.push({ section, key, label: labelOf(section, row), kind: "updated" });
      }

      byKey.set(key, row);
    }

    if (byKey.size > 0) {
      (merged as Record<string, unknown>)[section] = [...byKey.values()];
    }
  }

  return { doc: merged, changes };
}

/** An empty document for an OU that has published nothing yet. */
export function emptyStructureDoc(ou: string): StructureDoc {
  return { docVersion: STRUCTURE_DOC_VERSION, ou };
}
