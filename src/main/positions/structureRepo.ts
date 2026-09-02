/**
 * Structure repository — scenarios, component definitions, SS schemes and the
 * field catalog, all in the plaintext store (kairos.db).
 *
 * Every function takes the Database handle explicitly (vitest runs these
 * against in-memory databases) and an OuScope (see ouScope.ts) — scope.ou is
 * the only OU ever bound into SQL; payload-embedded OUs are ignored.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { uuidv7 } from "../../shared/engine/ids";
import type {
  BaseSelector,
  ComponentDefId,
  CostComponentDefinition,
  SocialSecurityScheme,
  SsSchemeId,
} from "../../shared/engine/types";
import { FieldDef } from "../../shared/positions/fields";
import {
  SECTIONS,
  SEED_VERSION,
  SYSTEM_FIELD_SEED,
} from "../../shared/positions/fieldSeed";
import {
  FieldCatalogPatch,
  FieldCatalogResponse,
  ScenarioDto,
  ScenarioSaveRequest,
} from "../../shared/positions/ipc";
import { OuScope } from "./ouScope";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

const now = () => new Date().toISOString();

/** Every OU+year starts with this planning scenario; users add more beside it. */
export const DEFAULT_SCENARIO_LABEL = "Planning";

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export function listScenarios(db: Db, scope: OuScope): ScenarioDto[] {
  const rows = prepared(
    db,
    `SELECT id, ou, year, label, updated_at
       FROM scenarios
      WHERE ou = ? AND deleted_at IS NULL
      ORDER BY year DESC, label`
  ).all(scope.ou) as Array<{
    id: string;
    ou: string;
    year: number;
    label: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    ou: row.ou,
    year: row.year,
    label: row.label,
    updatedAt: row.updated_at,
  }));
}

export function saveScenario(
  db: Db,
  scope: OuScope,
  scenario: ScenarioSaveRequest["scenario"]
): ScenarioDto {
  const year = Math.trunc(Number(scenario.year));
  if (!Number.isFinite(year) || year < 1900 || year > 2999) {
    throw new Error(`Invalid scenario year: ${scenario.year}`);
  }
  const label = String(scenario.label ?? "").trim();
  if (!label) throw new Error("A scenario label is required");

  const id = scenario.id ?? uuidv7();
  const stamp = now();

  prepared(
    db,
    `INSERT INTO scenarios (id, ou, year, label, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       year = excluded.year,
       label = excluded.label,
       updated_at = excluded.updated_at,
       deleted_at = NULL
     WHERE scenarios.ou = excluded.ou`
  ).run(id, scope.ou, year, label, stamp);

  return { id, ou: scope.ou, year, label, updatedAt: stamp };
}

/** Guarantee the default "Planning" scenario exists for this OU + year. */
export function ensureDefaultScenario(db: Db, scope: OuScope, year: number): void {
  const trimmed = Math.trunc(Number(year));
  if (!Number.isFinite(trimmed) || trimmed < 1900 || trimmed > 2999) return;

  const exists = prepared(
    db,
    `SELECT 1 FROM scenarios
      WHERE ou = ? AND year = ? AND deleted_at IS NULL
      LIMIT 1`
  ).get(scope.ou, trimmed);
  if (!exists) {
    saveScenario(db, scope, { year: trimmed, label: DEFAULT_SCENARIO_LABEL });
  }
}

export function softDeleteScenario(db: Db, scope: OuScope, scenarioId: string): void {
  prepared(
    db,
    `UPDATE scenarios SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).run(now(), now(), scenarioId, scope.ou);
}

// ---------------------------------------------------------------------------
// Field catalog
// ---------------------------------------------------------------------------

interface FieldCatalogRow {
  field_key: string;
  section: string;
  data_type: string;
  storage: string;
  origin: string;
  locked: number;
  default_label: string;
  custom_label: string | null;
  sort_order: number;
  visible: number;
  editable: number;
  maskable: number;
  vector: string | null;
  month_index: number | null;
  compute_key: string | null;
  dropdown_source: string | null;
  validation: string | null;
  default_value: string | null;
  seed_version: number;
}

function rowToFieldDef(row: FieldCatalogRow): FieldDef {
  return {
    key: row.field_key,
    section: row.section,
    dataType: row.data_type as FieldDef["dataType"],
    storage: row.storage as FieldDef["storage"],
    origin: row.origin as FieldDef["origin"],
    locked: row.locked === 1,
    defaultLabel: row.default_label,
    customLabel: row.custom_label,
    sortOrder: row.sort_order,
    visible: row.visible === 1,
    editable: row.editable === 1,
    maskable: row.maskable === 1,
    vector: (row.vector as FieldDef["vector"]) ?? undefined,
    monthIndex: row.month_index ?? undefined,
    computeKey: row.compute_key ?? undefined,
    dropdownSource: row.dropdown_source ? JSON.parse(row.dropdown_source) : null,
    validation: row.validation ? JSON.parse(row.validation) : null,
    defaultValue: row.default_value ? JSON.parse(row.default_value) : undefined,
  };
}

/**
 * Idempotently push the SYSTEM seed into this OU's catalog. Missing fields are
 * inserted; existing SYSTEM fields with an older seed_version get their
 * system-owned attributes refreshed while the user-owned ones (custom_label,
 * visible, deleted_at) are preserved. USER fields are untouched.
 *
 * sort_order is re-seeded on a version bump too: the seed array IS the source of
 * truth for system-column order, and there is no user-facing column reorder, so
 * a seed that relocates a field between sections (e.g. Pay Basis / Cluster into
 * Position) has to be able to carry that field's position with it — otherwise
 * the moved field keeps its old order and its section band draws twice (see
 * sortOrderAtEndOfSection). USER fields (only addable to the pii band, whose
 * system orders don't move) keep their own sort_order and stay contiguous.
 */
export function ensureFieldCatalogSeed(db: Db, scope: OuScope): void {
  const existing = new Map(
    (
      prepared(
        db,
        `SELECT field_key, seed_version FROM field_catalog WHERE ou = ? AND origin = 'SYSTEM'`
      ).all(scope.ou) as Array<{ field_key: string; seed_version: number }>
    ).map((row) => [row.field_key, row.seed_version])
  );

  const insert = prepared(
    db,
    `INSERT INTO field_catalog (
       ou, field_key, section, data_type, storage, origin, locked,
       default_label, custom_label, sort_order, visible, editable, maskable,
       vector, month_index, compute_key, dropdown_source, validation,
       default_value, seed_version, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, 'SYSTEM', ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  );
  const refresh = prepared(
    db,
    `UPDATE field_catalog SET
       section = ?, sort_order = ?, data_type = ?, storage = ?, locked = ?,
       default_label = ?, editable = ?, maskable = ?, vector = ?, month_index = ?,
       compute_key = ?, dropdown_source = ?, validation = ?, default_value = ?,
       seed_version = ?, updated_at = ?
     WHERE ou = ? AND field_key = ?`
  );
  const dropField = prepared(
    db,
    `DELETE FROM field_catalog WHERE ou = ? AND field_key = ? AND origin = 'SYSTEM'`
  );

  // System fields retired from the seed (e.g. dailyVacationCost in v11) must be
  // pruned from catalogs seeded earlier — refresh only touches keys still in the
  // seed, so a stale row would otherwise linger as a column with no DB backing.
  const seedKeys = new Set(SYSTEM_FIELD_SEED.map((field) => field.key));

  db.transaction(() => {
    for (const storedKey of existing.keys()) {
      if (!seedKeys.has(storedKey)) dropField.run(scope.ou, storedKey);
    }

    for (const field of SYSTEM_FIELD_SEED) {
      const json = {
        dropdown: field.dropdownSource ? JSON.stringify(field.dropdownSource) : null,
        validation: field.validation ? JSON.stringify(field.validation) : null,
        defaultValue:
          field.defaultValue !== undefined ? JSON.stringify(field.defaultValue) : null,
      };
      const storedVersion = existing.get(field.key);

      if (storedVersion === undefined) {
        insert.run(
          scope.ou,
          field.key,
          field.section,
          field.dataType,
          field.storage,
          field.locked ? 1 : 0,
          field.defaultLabel,
          field.sortOrder,
          field.editable ? 1 : 0,
          field.maskable ? 1 : 0,
          field.vector ?? null,
          field.monthIndex ?? null,
          field.computeKey ?? null,
          json.dropdown,
          json.validation,
          json.defaultValue,
          SEED_VERSION,
          now()
        );
      } else if (storedVersion < SEED_VERSION) {
        refresh.run(
          field.section,
          field.sortOrder,
          field.dataType,
          field.storage,
          field.locked ? 1 : 0,
          field.defaultLabel,
          field.editable ? 1 : 0,
          field.maskable ? 1 : 0,
          field.vector ?? null,
          field.monthIndex ?? null,
          field.computeKey ?? null,
          json.dropdown,
          json.validation,
          json.defaultValue,
          SEED_VERSION,
          now(),
          scope.ou,
          field.key
        );
      }
    }
  })();
}

export function getFieldCatalog(db: Db, scope: OuScope): FieldCatalogResponse {
  ensureFieldCatalogSeed(db, scope);

  const rows = prepared(
    db,
    `SELECT field_key, section, data_type, storage, origin, locked,
            default_label, custom_label, sort_order, visible, editable,
            maskable, vector, month_index, compute_key, dropdown_source,
            validation, default_value, seed_version
       FROM field_catalog
      WHERE ou = ? AND deleted_at IS NULL
      ORDER BY sort_order, field_key`
  ).all(scope.ou) as FieldCatalogRow[];

  return { sections: SECTIONS, fields: rows.map(rowToFieldDef) };
}

export function saveFieldCatalog(
  db: Db,
  scope: OuScope,
  patches: FieldCatalogPatch[]
): FieldCatalogResponse {
  const stamp = now();

  db.transaction(() => {
    for (const patch of patches) {
      if (patch.create) {
        const spec = patch.create;
        if (spec.storage !== "POSITION_EXTRA" && spec.storage !== "PII_EXTRA") {
          throw new Error("User-defined fields must use extra-value storage");
        }
        prepared(
          db,
          `INSERT INTO field_catalog (
             ou, field_key, section, data_type, storage, origin, locked,
             default_label, custom_label, sort_order, visible, editable,
             maskable, dropdown_source, validation, default_value,
             seed_version, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'USER', 0, ?, NULL, ?, 1, 1, ?, ?, ?, ?, ?, ?)`
        ).run(
          scope.ou,
          `u_${uuidv7()}`,
          spec.section,
          spec.dataType,
          spec.storage,
          spec.defaultLabel,
          patch.sortOrder ?? 100000,
          spec.storage === "PII_EXTRA" ? 1 : 0,
          spec.dropdownSource ? JSON.stringify(spec.dropdownSource) : null,
          spec.validation ? JSON.stringify(spec.validation) : null,
          spec.defaultValue !== undefined ? JSON.stringify(spec.defaultValue) : null,
          SEED_VERSION,
          stamp
        );
        continue;
      }

      if (!patch.key) throw new Error("Field patch requires a key");

      // Restore looks up the soft-deleted row, so it skips the deleted_at
      // filter the other patch kinds share.
      if (patch.restore) {
        const target = prepared(
          db,
          `SELECT origin FROM field_catalog WHERE ou = ? AND field_key = ?`
        ).get(scope.ou, patch.key) as { origin: string } | undefined;
        if (!target) throw new Error(`Unknown field: ${patch.key}`);
        if (target.origin !== "USER") {
          throw new Error(`Field '${patch.key}' is not a user-added column`);
        }
        prepared(
          db,
          `UPDATE field_catalog SET deleted_at = NULL, updated_at = ?
            WHERE ou = ? AND field_key = ? AND origin = 'USER'`
        ).run(stamp, scope.ou, patch.key);
        continue;
      }

      const row = prepared(
        db,
        `SELECT locked, origin FROM field_catalog
          WHERE ou = ? AND field_key = ? AND deleted_at IS NULL`
      ).get(scope.ou, patch.key) as { locked: number; origin: string } | undefined;
      if (!row) throw new Error(`Unknown field: ${patch.key}`);

      if (patch.remove) {
        // Two gates. Locked stays the first word (a locked field is off-limits
        // for every reason), but ownership is the one that matters here: system
        // fields are the data model the engine, row model and header overrides
        // all assume is present, so an *unlocked* system field (deptName, title)
        // still cannot be removed. Only USER columns ever pass both.
        if (row.locked === 1) {
          throw new Error(`Field '${patch.key}' is locked and cannot be removed`);
        }
        if (row.origin !== "USER") {
          throw new Error("Only user-added columns can be removed");
        }
        prepared(
          db,
          `UPDATE field_catalog SET deleted_at = ?, updated_at = ?
            WHERE ou = ? AND field_key = ?`
        ).run(stamp, stamp, scope.ou, patch.key);
        continue;
      }

      if (patch.customLabel !== undefined && row.locked === 1) {
        throw new Error(`Field '${patch.key}' is locked and cannot be renamed`);
      }

      prepared(
        db,
        `UPDATE field_catalog SET
           custom_label = COALESCE(?, custom_label),
           sort_order = COALESCE(?, sort_order),
           visible = COALESCE(?, visible),
           updated_at = ?
         WHERE ou = ? AND field_key = ?`
      ).run(
        patch.customLabel !== undefined ? patch.customLabel : null,
        patch.sortOrder ?? null,
        patch.visible === undefined ? null : patch.visible ? 1 : 0,
        stamp,
        scope.ou,
        patch.key
      );
    }
  })();

  return getFieldCatalog(db, scope);
}

/** Soft-deleted USER columns for this OU, newest removal first. The value
 *  count (which lives in the encrypted store) is added by the handler. */
export function listRemovedFields(
  db: Db,
  scope: OuScope
): Array<{ key: string; label: string; section: string; deletedAt: string }> {
  const rows = prepared(
    db,
    `SELECT field_key, default_label, custom_label, section, deleted_at
       FROM field_catalog
      WHERE ou = ? AND origin = 'USER' AND deleted_at IS NOT NULL
      ORDER BY deleted_at DESC`
  ).all(scope.ou) as Array<{
    field_key: string;
    default_label: string;
    custom_label: string | null;
    section: string;
    deleted_at: string;
  }>;

  return rows.map((row) => ({
    key: row.field_key,
    label: row.custom_label ?? row.default_label,
    section: row.section,
    deletedAt: row.deleted_at,
  }));
}

/**
 * Permanently drop soft-deleted USER catalog rows. This only removes the
 * catalog entries — the caller MUST scrub the matching keys out of the
 * encrypted value store first (see positionsRepo.scrubExtraValueKeys), since
 * the two live in separate database files with no shared transaction. Locked
 * and SYSTEM rows are never eligible. Returns the keys actually deleted.
 */
export function purgeCatalogFields(
  db: Db,
  scope: OuScope,
  keys: string[]
): string[] {
  const purged: string[] = [];
  const del = prepared(
    db,
    `DELETE FROM field_catalog
      WHERE ou = ? AND field_key = ? AND origin = 'USER' AND deleted_at IS NOT NULL`
  );
  db.transaction(() => {
    for (const key of keys) {
      if (del.run(scope.ou, key).changes > 0) purged.push(key);
    }
  })();
  return purged;
}

// ---------------------------------------------------------------------------
// Component definitions + social security schemes (read path for the engine
// loader; write path lands with the blocks admin UI)
// ---------------------------------------------------------------------------

export function getComponentDefinitions(
  db: Db,
  scope: OuScope
): CostComponentDefinition[] {
  const rows = prepared(
    db,
    `SELECT id, ou, kind, spread_method, stat_kind, label, account_code,
            department_mode, fixed_department, increase_aware, sort_order,
            base_selector_kind, ss_scheme_id, kpi_driver_id, base_ref,
            count_exempt, collapse_months, weekday_mask, updated_at
       FROM cost_component_definitions
      WHERE ou = ? AND deleted_at IS NULL
      ORDER BY sort_order, id`
  ).all(scope.ou) as Array<Record<string, unknown>>;

  const refs = prepared(
    db,
    `SELECT r.component_def_id, r.referenced_def_id
       FROM component_base_refs r
       JOIN cost_component_definitions d ON d.id = r.component_def_id
      WHERE d.ou = ?
      ORDER BY r.component_def_id, r.sort_order`
  ).all(scope.ou) as Array<{ component_def_id: string; referenced_def_id: string }>;

  const refsByDef = new Map<string, string[]>();
  for (const ref of refs) {
    const list = refsByDef.get(ref.component_def_id) ?? [];
    list.push(ref.referenced_def_id);
    refsByDef.set(ref.component_def_id, list);
  }

  return rows.map((row): CostComponentDefinition => {
    let baseSelector: BaseSelector | undefined;
    if (row.base_selector_kind === "BASE_SALARY") {
      baseSelector = { kind: "BASE_SALARY" };
    } else if (row.base_selector_kind === "COMPONENTS") {
      baseSelector = {
        kind: "COMPONENTS",
        componentIds: (refsByDef.get(row.id as string) ?? []) as ComponentDefId[],
      };
    } else if (typeof row.base_ref === "string" && row.base_ref) {
      // Extended base kinds (blocks feature) ride as JSON — the legacy CHECK
      // on base_selector_kind cannot be widened in SQLite. Unknown kinds are
      // dropped rather than surfaced as a selector the compiler can't run.
      const parsed = JSON.parse(row.base_ref) as { kind?: string } & Record<string, unknown>;
      if (
        parsed.kind === "CALENDAR" ||
        parsed.kind === "VACATION" ||
        parsed.kind === "SERVICE" ||
        parsed.kind === "COMBINE"
      ) {
        baseSelector = parsed as BaseSelector;
      }
    }
    return {
      id: row.id as ComponentDefId,
      ou: row.ou as string,
      kind: row.kind as CostComponentDefinition["kind"],
      spreadMethod:
        (row.spread_method as CostComponentDefinition["spreadMethod"]) ?? undefined,
      statKind: (row.stat_kind as CostComponentDefinition["statKind"]) ?? undefined,
      label: row.label as string,
      accountCode: row.account_code as string,
      departmentMode: row.department_mode as CostComponentDefinition["departmentMode"],
      fixedDepartment: (row.fixed_department as string) ?? undefined,
      increaseAware: row.increase_aware === 1,
      sortOrder: row.sort_order as number,
      baseSelector,
      ssSchemeId: (row.ss_scheme_id as SsSchemeId) ?? undefined,
      kpiDriverId: (row.kpi_driver_id as string) ?? undefined,
      countExempt: row.count_exempt === 1,
      collapseMonths: parseCollapseMonths(row.collapse_months),
      // Normalize-on-read like collapse_months: junk or an empty mask reads as
      // undefined, which the engine treats as a zero line.
      weekdayMask:
        Number.isInteger(row.weekday_mask) && (row.weekday_mask as number) > 0
          ? (row.weekday_mask as number) & 127
          : undefined,
      updatedAt: row.updated_at as string,
      deletedAt: null,
    };
  });
}

/**
 * Parse cost_component_definitions.collapse_months (JSON array of 1-based
 * months), tolerating malformed data: anything but integers 1-12 is dropped,
 * duplicates folded, and an empty result reads as undefined — the def spreads
 * with its base, the pre-column behaviour.
 */
function parseCollapseMonths(raw: unknown): number[] | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const months = [
      ...new Set(
        parsed.filter(
          (month) => Number.isInteger(month) && month >= 1 && month <= 12
        ) as number[]
      ),
    ].sort((a, b) => a - b);
    return months.length > 0 ? months : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the ss_schemes.base_component_ids JSON, tolerating malformed data. */
function parseBaseComponentIds(raw: string): ComponentDefId[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed.filter((id) => typeof id === "string") as ComponentDefId[])
      : [];
  } catch {
    return [];
  }
}

export function getSsSchemes(db: Db, scope: OuScope): SocialSecurityScheme[] {
  const rows = prepared(
    db,
    `SELECT id, label, monthly_cap, yearly_cap,
            accumulation_mode, tax_year_start_month,
            include_base_salary, include_vacation, base_component_ids,
            updated_at
       FROM ss_schemes
      WHERE ou = ? AND deleted_at IS NULL
      ORDER BY label`
  ).all(scope.ou) as Array<{
    id: string;
    label: string;
    monthly_cap: number | null;
    yearly_cap: number | null;
    accumulation_mode: string;
    tax_year_start_month: number;
    include_base_salary: number;
    include_vacation: number;
    base_component_ids: string;
    updated_at: string;
  }>;

  const brackets = prepared(
    db,
    `SELECT b.scheme_id, b.up_to, b.rate
       FROM ss_brackets b
       JOIN ss_schemes s ON s.id = b.scheme_id
      WHERE s.ou = ?
      ORDER BY b.scheme_id, b.bracket_index`
  ).all(scope.ou) as Array<{ scheme_id: string; up_to: number | null; rate: number }>;

  const bracketsByScheme = new Map<string, Array<{ upTo: number | null; rate: number }>>();
  for (const bracket of brackets) {
    const list = bracketsByScheme.get(bracket.scheme_id) ?? [];
    list.push({ upTo: bracket.up_to, rate: bracket.rate });
    bracketsByScheme.set(bracket.scheme_id, list);
  }

  return rows.map((row): SocialSecurityScheme => ({
    id: row.id as SsSchemeId,
    label: row.label,
    monthlyCap: row.monthly_cap,
    yearlyCap: row.yearly_cap,
    brackets: bracketsByScheme.get(row.id) ?? [],
    accumulationMode: row.accumulation_mode === "PER_PERIOD" ? "PER_PERIOD" : "CUMULATIVE",
    taxYearStartMonth: row.tax_year_start_month,
    includeBaseSalary: row.include_base_salary !== 0,
    includeVacation: row.include_vacation !== 0,
    baseComponentIds: parseBaseComponentIds(row.base_component_ids),
    updatedAt: row.updated_at,
    deletedAt: null,
  }));
}
