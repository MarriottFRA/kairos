/**
 * Positions repository — the encrypted store (kairos_secure.db).
 * -----------------------------------------------------------
 * Batch-oriented: the renderer's write queue sends coalesced patches and the
 * whole batch executes in ONE transaction with one updated_at stamp. Sparse
 * patches compile to dynamic UPDATEs whose column names come exclusively from
 * the static maps in shared/positions/fields.ts — a field key arriving over
 * IPC is looked up against the OU's catalog, never interpolated into SQL.
 * Unknown keys throw; catalog extras land in the extra_values JSON blob via
 * json_patch() (single statement, no read-modify-write).
 *
 * Creates are "ensure row + patch all fields", which makes them idempotent
 * under queue retries.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  ENGINE_SCALAR_COLUMNS,
  FieldDef,
  PII_CORE_COLUMNS,
  VECTOR_COLUMNS,
  VectorName,
} from "../../shared/positions/fields";
import {
  BuyoutRecord,
  ComponentValueRecord,
  PiiRecord,
  PositionRecord,
  PositionsBatchWriteRequest,
  PositionsBatchWriteResponse,
  PositionsLoadResponse,
} from "../../shared/positions/ipc";
import { OuScope } from "./ouScope";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

const MONTHS = 12;

export type FieldLookup = Map<string, FieldDef>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const POSITION_COLUMNS = `
  id, scenario_id, lineage_id, active,
  department_code, job_type_code, cluster, cluster_multiplier_override, pay_type,
  headcount, fte, seasonality, monthly_base_salary, hourly_rate,
  additional_monthly_costs,
  merit_increase_pct, manual_yearly_increase, increase_month,
  daily_contract_hours, yearly_hours_worked, vacation_days,
  vacation_monthly_weights, accrual_days_per_month,
  extra_values, updated_at`;

function parseVector(raw: unknown): number[] {
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) {
      const out: number[] = [];
      for (let m = 0; m < MONTHS; m++) out.push(Number(parsed[m]) || 0);
      return out;
    }
  } catch {
    /* fall through */
  }
  return new Array(MONTHS).fill(0);
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function rowToPosition(row: Record<string, unknown>): PositionRecord {
  return {
    id: row.id as string,
    scenarioId: row.scenario_id as string,
    // Pre-v3 rows backfill to their own id; the fallback covers the window
    // before that migration has run against a given file.
    lineageId: (row.lineage_id as string) || (row.id as string),
    active: row.active !== 0,
    departmentCode: row.department_code as string,
    jobTypeCode: row.job_type_code as string,
    cluster: row.cluster as string,
    clusterMultiplierOverride:
      (row.cluster_multiplier_override as number | null) ?? null,
    payType: row.pay_type as PositionRecord["payType"],
    headcount: row.headcount as number,
    fte: row.fte as number,
    seasonality: parseVector(row.seasonality),
    monthlyBaseSalary: row.monthly_base_salary as number,
    hourlyRate: row.hourly_rate as number,
    additionalMonthlyCosts: parseVector(row.additional_monthly_costs),
    meritIncreasePct: row.merit_increase_pct as number,
    manualYearlyIncrease: row.manual_yearly_increase as number,
    increaseMonth: row.increase_month as number,
    dailyContractHours: row.daily_contract_hours as number,
    yearlyHoursWorked: row.yearly_hours_worked as number,
    vacationDays: row.vacation_days as number,
    vacationMonthlyWeights: parseVector(row.vacation_monthly_weights),
    accrualDaysPerMonth: row.accrual_days_per_month as number,
    extraValues: parseJsonObject(row.extra_values),
    updatedAt: row.updated_at as string,
  };
}

export function loadScenarioValues(
  db: Db,
  scope: OuScope,
  scenarioId: string
): PositionsLoadResponse {
  const positions = (
    prepared(
      db,
      `SELECT ${POSITION_COLUMNS} FROM positions
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL
        ORDER BY id`
    ).all(scope.ou, scenarioId) as Array<Record<string, unknown>>
  ).map(rowToPosition);

  const componentValues = (
    prepared(
      db,
      `SELECT position_id, component_def_id, rate, yearly_value, monthly_values,
              qty, unit_rate, ss_opening_base, account_code, stats_account_code,
              updated_at
         FROM component_values
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`
    ).all(scope.ou, scenarioId) as Array<Record<string, unknown>>
  ).map(
    (row): ComponentValueRecord => ({
      positionId: row.position_id as string,
      componentDefId: row.component_def_id as string,
      rate: row.rate as number | null,
      yearlyValue: row.yearly_value as number | null,
      monthlyValues: row.monthly_values ? parseVector(row.monthly_values) : null,
      qty: row.qty as number | null,
      unitRate: row.unit_rate as number | null,
      ssOpeningBase: (row.ss_opening_base as number | null) ?? null,
      accountCode: (row.account_code as string | null) ?? null,
      statsAccountCode: (row.stats_account_code as string | null) ?? null,
      updatedAt: row.updated_at as string,
    })
  );

  const buyouts = (
    prepared(
      db,
      `SELECT id, scenario_id, department_code, account_code, monthly_values, updated_at
         FROM buyout_rows
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`
    ).all(scope.ou, scenarioId) as Array<Record<string, unknown>>
  ).map(
    (row): BuyoutRecord => ({
      id: row.id as string,
      scenarioId: row.scenario_id as string,
      departmentCode: row.department_code as string,
      accountCode: row.account_code as string,
      monthlyValues: parseVector(row.monthly_values),
      updatedAt: row.updated_at as string,
    })
  );

  return { positions, componentValues, buyouts };
}

/** PII for one scenario, keyed by position id. The ONLY read path for PII. */
export function getPii(
  db: Db,
  scope: OuScope,
  scenarioId: string
): Record<string, PiiRecord> {
  const rows = prepared(
    db,
    `SELECT position_id, hiring_date, emp_number, last_name, first_name, title,
            extra_values, updated_at
       FROM position_pii
      WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`
  ).all(scope.ou, scenarioId) as Array<Record<string, unknown>>;

  const out: Record<string, PiiRecord> = {};
  for (const row of rows) {
    out[row.position_id as string] = {
      positionId: row.position_id as string,
      hiringDate: row.hiring_date as string | null,
      empNumber: row.emp_number as string | null,
      lastName: row.last_name as string | null,
      firstName: row.first_name as string | null,
      title: row.title as string | null,
      extraValues: parseJsonObject(row.extra_values),
      updatedAt: row.updated_at as string,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extra-value maintenance (field purge)
// ---------------------------------------------------------------------------

/**
 * A user field's key is a `u_<uuidv7>` string, only ever minted server-side, so
 * embedding it in a JSON path is not an injection surface — but we still bind
 * the whole path as a parameter rather than interpolating it into SQL.
 */
function jsonPath(key: string): string {
  return `$."${key}"`;
}

/**
 * Count value rows (across every scenario in the OU) that still hold real data
 * for one extra-value key — positions + PII. "Real" excludes JSON null and the
 * empty string, so a cell that was typed into and then cleared reads as empty.
 * Drives the count-aware delete confirm and the empty-first purge sweep.
 */
export function countExtraValueUsage(db: Db, scope: OuScope, key: string): number {
  const path = jsonPath(key);
  const row = prepared(
    db,
    `SELECT
       (SELECT COUNT(*) FROM positions
          WHERE ou = ? AND deleted_at IS NULL
            AND json_extract(extra_values, ?) IS NOT NULL
            AND json_extract(extra_values, ?) <> '')
     + (SELECT COUNT(*) FROM position_pii
          WHERE ou = ? AND deleted_at IS NULL
            AND json_extract(extra_values, ?) IS NOT NULL
            AND json_extract(extra_values, ?) <> '') AS c`
  ).get(scope.ou, path, path, scope.ou, path, path) as { c: number };
  return row.c;
}

/**
 * Strip the given extra-value keys out of every position + PII blob in the OU
 * (all scenarios, all years). One transaction; only rows that actually carry
 * the key are rewritten (json_type filters the rest). Returns rows touched.
 */
export function scrubExtraValueKeys(db: Db, scope: OuScope, keys: string[]): number {
  if (keys.length === 0) return 0;
  const stamp = new Date().toISOString();
  let changed = 0;

  const updatePositions = prepared(
    db,
    `UPDATE positions SET extra_values = json_remove(extra_values, ?), updated_at = ?
      WHERE ou = ? AND json_type(extra_values, ?) IS NOT NULL`
  );
  const updatePii = prepared(
    db,
    `UPDATE position_pii SET extra_values = json_remove(extra_values, ?), updated_at = ?
      WHERE ou = ? AND json_type(extra_values, ?) IS NOT NULL`
  );

  db.transaction(() => {
    for (const key of keys) {
      const path = jsonPath(key);
      changed += updatePositions.run(path, stamp, scope.ou, path).changes;
      changed += updatePii.run(path, stamp, scope.ou, path).changes;
    }
  })();
  return changed;
}

// ---------------------------------------------------------------------------
// Batch write
// ---------------------------------------------------------------------------

interface SplitFields {
  /** SQL column -> coerced value (identifiers only ever from the static maps). */
  columns: Map<string, unknown>;
  /** Keys destined for the extra_values JSON blob. */
  extras: Record<string, unknown>;
}

/**
 * Empty-cell values for engine columns whose schema default is not the type's
 * zero. Clearing "Increase Month" must mean "no increase" (13), not "increase
 * from month 0 onward"; a headcount/FTE cleared to 0 would silently zero the
 * position's whole cost rather than fall back to one. A cleared cluster
 * multiplier override MUST persist as NULL ("use the cluster's weight") — the
 * numeric-zero fallback would zero the position's whole cost instead.
 */
const ENGINE_EMPTY_OVERRIDES: Readonly<Record<string, unknown>> = {
  increaseMonth: 13,
  headcount: 1,
  fte: 1,
  active: 1,
  clusterMultiplierOverride: null,
};

/**
 * Coerce one engine scalar. Every column this feeds is NOT NULL (see
 * POSITIONS_VALUE_TABLES_SQL) except cluster_multiplier_override (nullable by
 * design, cleared via its ENGINE_EMPTY_OVERRIDES entry), so a cleared or
 * absent cell resolves to the column's default — returning an unmapped null
 * here fails the whole batch transaction.
 */
function coerceScalar(key: string, def: FieldDef | undefined, value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    if (key in ENGINE_EMPTY_OVERRIDES) return ENGINE_EMPTY_OVERRIDES[key];
    switch (def?.dataType) {
      case "NUMBER":
      case "PERCENT":
      case "INTEGER":
        return 0;
      default:
        return "";
    }
  }
  switch (def?.dataType) {
    case "NUMBER":
    case "PERCENT": {
      const num = Number(value);
      return Number.isFinite(num) ? num : 0;
    }
    case "INTEGER": {
      const num = Math.trunc(Number(value));
      return Number.isFinite(num) ? num : 0;
    }
    // SQLite has no boolean type — the column is INTEGER 0/1.
    case "BOOLEAN":
      return value === false || value === 0 || value === "false" ? 0 : 1;
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

function coerceVector(value: unknown): string {
  const out: number[] = new Array(MONTHS).fill(0);
  if (Array.isArray(value)) {
    for (let m = 0; m < MONTHS; m++) {
      const num = Number(value[m]);
      out[m] = Number.isFinite(num) ? num : 0;
    }
  }
  return JSON.stringify(out);
}

/**
 * Split catalog-keyed fields into typed columns + extras for the positions
 * table. Vector names ("seasonality", ...) are accepted alongside catalog
 * keys. Unknown keys throw — accuracy over silent loss.
 */
function splitPositionFields(
  fields: Record<string, unknown>,
  lookup: FieldLookup
): SplitFields {
  const columns = new Map<string, unknown>();
  const extras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (key in VECTOR_COLUMNS) {
      columns.set(VECTOR_COLUMNS[key as VectorName], coerceVector(value));
      continue;
    }
    const def = lookup.get(key);
    if (!def) throw new Error(`Unknown position field: ${key}`);

    if (def.storage === "ENGINE") {
      const column = ENGINE_SCALAR_COLUMNS[key];
      if (!column) throw new Error(`Field '${key}' has no engine column mapping`);
      // The pay_type CHECK would reject junk; normalize here instead.
      if (key === "payType") {
        columns.set(column, value === "HOURLY" ? "HOURLY" : "SALARIED");
      } else {
        columns.set(column, coerceScalar(key, def, value));
      }
    } else if (def.storage === "POSITION_EXTRA") {
      extras[key] = value === undefined ? null : value;
    } else {
      throw new Error(`Field '${key}' does not belong on the positions table`);
    }
  }

  return { columns, extras };
}

function splitPiiFields(
  fields: Record<string, unknown>,
  lookup: FieldLookup
): SplitFields {
  const columns = new Map<string, unknown>();
  const extras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    const def = lookup.get(key);
    if (!def) throw new Error(`Unknown PII field: ${key}`);
    if (def.storage === "PII_CORE") {
      const column = PII_CORE_COLUMNS[key];
      if (!column) throw new Error(`Field '${key}' has no PII column mapping`);
      columns.set(column, value === undefined || value === "" ? null : value);
    } else if (def.storage === "PII_EXTRA") {
      extras[key] = value === undefined ? null : value;
    } else {
      throw new Error(`Field '${key}' does not belong on the PII table`);
    }
  }

  return { columns, extras };
}

/** Dynamic sparse UPDATE with sorted columns for statement-cache reuse. */
function applyUpdate(
  db: Db,
  table: "positions" | "position_pii",
  idColumn: string,
  id: string,
  scope: OuScope,
  split: SplitFields,
  stamp: string
): number {
  const columnNames = [...split.columns.keys()].sort();
  const hasExtras = Object.keys(split.extras).length > 0;
  if (columnNames.length === 0 && !hasExtras) return 0;

  const sets = columnNames.map((name) => `${name} = ?`);
  if (hasExtras) sets.push(`extra_values = json_patch(extra_values, ?)`);
  sets.push(`updated_at = ?`);

  const sql = `UPDATE ${table} SET ${sets.join(", ")}
     WHERE ${idColumn} = ? AND ou = ? AND deleted_at IS NULL`;

  const params: unknown[] = columnNames.map((name) => split.columns.get(name));
  if (hasExtras) params.push(JSON.stringify(split.extras));
  params.push(stamp, id, scope.ou);

  return prepared(db, sql).run(...params).changes;
}

/** Wire-field → column map for component_values patches. Column names come
 *  exclusively from here — never from the IPC payload. */
const COMPONENT_VALUE_COLUMNS: Record<string, string> = {
  rate: "rate",
  yearlyValue: "yearly_value",
  monthlyValues: "monthly_values",
  qty: "qty",
  unitRate: "unit_rate",
  ssOpeningBase: "ss_opening_base",
  accountCode: "account_code",
  statsAccountCode: "stats_account_code",
};

/** The two per-row account overrides are TEXT; everything else numeric. */
const COMPONENT_VALUE_TEXT_FIELDS = new Set(["accountCode", "statsAccountCode"]);

export function batchWrite(
  db: Db,
  scope: OuScope,
  request: PositionsBatchWriteRequest,
  lookup: FieldLookup,
  /** Valid component-definition ids for this OU (from the plaintext store).
   *  Patches referencing anything else throw — accuracy over silent loss. */
  componentDefIds?: ReadonlySet<string>
): PositionsBatchWriteResponse {
  const scenarioId = String(request.scenarioId ?? "");
  if (!scenarioId) throw new Error("A scenarioId is required");

  const stamp = new Date().toISOString();
  let applied = 0;

  // A position created in the grid starts its own lineage; only a scenario
  // clone carries an existing lineage_id forward.
  const ensurePosition = prepared(
    db,
    `INSERT INTO positions (id, ou, scenario_id, lineage_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  );
  const ensurePii = prepared(
    db,
    `INSERT INTO position_pii (position_id, ou, scenario_id, updated_at)
     SELECT id, ou, scenario_id, ? FROM positions
      WHERE id = ? AND ou = ?
     ON CONFLICT(position_id) DO NOTHING`
  );

  db.transaction(() => {
    for (const create of request.creates ?? []) {
      ensurePosition.run(create.id, scope.ou, scenarioId, create.id, stamp);
      applied += applyUpdate(
        db, "positions", "id", create.id, scope,
        splitPositionFields(create.fields ?? {}, lookup), stamp
      );
      if (create.pii && Object.keys(create.pii).length > 0) {
        ensurePii.run(stamp, create.id, scope.ou);
        applied += applyUpdate(
          db, "position_pii", "position_id", create.id, scope,
          splitPiiFields(create.pii, lookup), stamp
        );
      }
    }

    for (const patch of request.positionPatches ?? []) {
      applied += applyUpdate(
        db, "positions", "id", patch.id, scope,
        splitPositionFields(patch.fields ?? {}, lookup), stamp
      );
    }

    for (const patch of request.piiPatches ?? []) {
      ensurePii.run(stamp, patch.positionId, scope.ou);
      applied += applyUpdate(
        db, "position_pii", "position_id", patch.positionId, scope,
        splitPiiFields(patch.fields ?? {}, lookup), stamp
      );
    }

    // Block inputs. Runs after creates so a patch for a just-created row
    // lands in the same transaction. The ensure INSERT selects FROM positions
    // bound to (ou, scenario), so a position id from another hotel or
    // scenario can never gain a value row here.
    for (const patch of request.componentValuePatches ?? []) {
      if (!componentDefIds?.has(patch.componentDefId)) {
        throw new Error(`Unknown component definition: ${patch.componentDefId}`);
      }
      const entries = Object.entries(patch.fields ?? {}).filter(
        ([, value]) => value !== undefined
      );
      if (entries.length === 0) continue;

      prepared(
        db,
        `INSERT INTO component_values (position_id, component_def_id, ou, scenario_id, updated_at)
         SELECT id, ?, ou, scenario_id, ? FROM positions
          WHERE id = ? AND ou = ? AND scenario_id = ? AND deleted_at IS NULL
         ON CONFLICT(position_id, component_def_id) DO NOTHING`
      ).run(patch.componentDefId, stamp, patch.positionId, scope.ou, scenarioId);

      const columns: string[] = [];
      const params: unknown[] = [];
      for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
        const column = COMPONENT_VALUE_COLUMNS[key];
        if (!column) throw new Error(`Unknown component value field: ${key}`);
        columns.push(`${column} = ?`);
        if (key === "monthlyValues") {
          params.push(value === null ? null : coerceVector(value));
        } else if (COMPONENT_VALUE_TEXT_FIELDS.has(key)) {
          if (value !== null && typeof value !== "string") {
            throw new Error(`Component value '${key}' must be a string or null`);
          }
          params.push(value);
        } else {
          if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
            throw new Error(`Component value '${key}' must be a number or null`);
          }
          params.push(value);
        }
      }
      applied += prepared(
        db,
        `UPDATE component_values SET ${columns.join(", ")}, updated_at = ?, deleted_at = NULL
          WHERE position_id = ? AND component_def_id = ? AND ou = ?`
      ).run(...params, stamp, patch.positionId, patch.componentDefId, scope.ou).changes;
    }

    for (const id of request.softDeleteIds ?? []) {
      applied += prepared(
        db,
        `UPDATE positions SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND ou = ? AND deleted_at IS NULL`
      ).run(stamp, stamp, id, scope.ou).changes;
      prepared(
        db,
        `UPDATE position_pii SET deleted_at = ?, updated_at = ?
          WHERE position_id = ? AND ou = ? AND deleted_at IS NULL`
      ).run(stamp, stamp, id, scope.ou);
      prepared(
        db,
        `UPDATE component_values SET deleted_at = ?, updated_at = ?
          WHERE position_id = ? AND ou = ? AND deleted_at IS NULL`
      ).run(stamp, stamp, id, scope.ou);
    }

    for (const id of request.restoreIds ?? []) {
      applied += prepared(
        db,
        `UPDATE positions SET deleted_at = NULL, updated_at = ?
          WHERE id = ? AND ou = ? AND deleted_at IS NOT NULL`
      ).run(stamp, id, scope.ou).changes;
      prepared(
        db,
        `UPDATE position_pii SET deleted_at = NULL, updated_at = ?
          WHERE position_id = ? AND ou = ? AND deleted_at IS NOT NULL`
      ).run(stamp, id, scope.ou);
      prepared(
        db,
        `UPDATE component_values SET deleted_at = NULL, updated_at = ?
          WHERE position_id = ? AND ou = ? AND deleted_at IS NOT NULL`
      ).run(stamp, id, scope.ou);
    }
  })();

  return { updatedAt: stamp, applied };
}

// ---------------------------------------------------------------------------
// Roll-forward
// ---------------------------------------------------------------------------

/**
 * Snapshot-copy every value row of one scenario into another.
 *
 * This is the "next year came around" path: positions keep their lineage_id so
 * the same role is traceable across years, but get fresh ids so the two years
 * are fully independent — editing the copy never touches the source. Inactive
 * positions are copied too; retaining them across years is the whole point of
 * the flag.
 *
 * Refuses a non-empty target rather than merging: silently interleaving two
 * years' worth of positions would be unrecoverable without an undo.
 */
export function cloneScenarioValues(
  db: Db,
  scope: OuScope,
  sourceScenarioId: string,
  targetScenarioId: string,
  mintId: () => string
): { positions: number } {
  if (!sourceScenarioId || !targetScenarioId) {
    throw new Error("Both a source and a target scenario are required");
  }
  if (sourceScenarioId === targetScenarioId) {
    throw new Error("Cannot copy a scenario onto itself");
  }

  const stamp = new Date().toISOString();
  let copied = 0;

  db.transaction(() => {
    const occupied = prepared(
      db,
      `SELECT 1 FROM positions
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL
        LIMIT 1`
    ).get(scope.ou, targetScenarioId);
    if (occupied) {
      throw new Error(
        "The target scenario already has positions — copy into an empty one"
      );
    }

    const sourceIds = (
      prepared(
        db,
        `SELECT id FROM positions
          WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL
          ORDER BY id`
      ).all(scope.ou, sourceScenarioId) as Array<{ id: string }>
    ).map((row) => row.id);

    // One new id per source position, reused by the child tables below so
    // their foreign keys land on the copies rather than the originals.
    const idMap = new Map(sourceIds.map((id) => [id, mintId()]));

    const insertPosition = prepared(
      db,
      `INSERT INTO positions (
         id, ou, scenario_id, lineage_id, active,
         department_code, job_type_code, cluster, cluster_multiplier_override,
         pay_type, headcount, fte,
         seasonality, monthly_base_salary, hourly_rate, additional_monthly_costs,
         merit_increase_pct, manual_yearly_increase, increase_month,
         daily_contract_hours, yearly_hours_worked, vacation_days,
         vacation_monthly_weights, accrual_days_per_month,
         extra_values, updated_at, deleted_at)
       SELECT ?, ou, ?, lineage_id, active,
         department_code, job_type_code, cluster, cluster_multiplier_override,
         pay_type, headcount, fte,
         seasonality, monthly_base_salary, hourly_rate, additional_monthly_costs,
         merit_increase_pct, manual_yearly_increase, increase_month,
         daily_contract_hours, yearly_hours_worked, vacation_days,
         vacation_monthly_weights, accrual_days_per_month,
         extra_values, ?, NULL
         FROM positions
        WHERE id = ? AND ou = ? AND deleted_at IS NULL`
    );
    const insertPii = prepared(
      db,
      `INSERT INTO position_pii (
         position_id, ou, scenario_id, hiring_date, emp_number, last_name,
         first_name, title, extra_values, updated_at, deleted_at)
       SELECT ?, ou, ?, hiring_date, emp_number, last_name,
         first_name, title, extra_values, ?, NULL
         FROM position_pii
        WHERE position_id = ? AND ou = ? AND deleted_at IS NULL`
    );
    const insertComponentValues = prepared(
      db,
      `INSERT INTO component_values (
         position_id, component_def_id, ou, scenario_id, rate, yearly_value,
         monthly_values, qty, unit_rate, ss_opening_base, account_code,
         stats_account_code, updated_at, deleted_at)
       SELECT ?, component_def_id, ou, ?, rate, yearly_value,
         monthly_values, qty, unit_rate, ss_opening_base, account_code,
         stats_account_code, ?, NULL
         FROM component_values
        WHERE position_id = ? AND ou = ? AND deleted_at IS NULL`
    );

    for (const [sourceId, newId] of idMap) {
      copied += insertPosition.run(
        newId, targetScenarioId, stamp, sourceId, scope.ou
      ).changes;
      insertPii.run(newId, targetScenarioId, stamp, sourceId, scope.ou);
      insertComponentValues.run(newId, targetScenarioId, stamp, sourceId, scope.ou);
    }

    // Buyouts hang off the scenario, not a position — new ids, no remapping.
    const buyoutIds = (
      prepared(
        db,
        `SELECT id FROM buyout_rows
          WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`
      ).all(scope.ou, sourceScenarioId) as Array<{ id: string }>
    ).map((row) => row.id);

    const insertBuyout = prepared(
      db,
      `INSERT INTO buyout_rows (
         id, ou, scenario_id, department_code, account_code, monthly_values,
         updated_at, deleted_at)
       SELECT ?, ou, ?, department_code, account_code, monthly_values, ?, NULL
         FROM buyout_rows
        WHERE id = ? AND ou = ? AND deleted_at IS NULL`
    );
    for (const id of buyoutIds) {
      insertBuyout.run(mintId(), targetScenarioId, stamp, id, scope.ou);
    }
  })();

  return { positions: copied };
}
