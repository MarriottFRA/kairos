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
  BuyoutRecord,
  ComponentValueRecord,
  PiiRecord,
  PositionRecord,
  PositionsBatchWriteRequest,
  PositionsBatchWriteResponse,
  PositionsLoadResponse,
} from "../../shared/positions/ipc";
import { ClusterSyncResult } from "../../shared/positions/clusterSync";
import { RowBefore, runClusterSync } from "./clusterSync";
import { OuScope } from "./ouScope";
import {
  FieldLookup,
  applyUpdate,
  coerceVector,
  splitPiiFields,
  splitPositionFields,
} from "./positionWrites";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

const MONTHS = 12;

// Re-exported so the many existing importers of positionsRepo keep working;
// the definitions live in positionWrites so clusterSync can share them without
// a cycle back through this module.
export type { FieldLookup, SplitFields } from "./positionWrites";
export { applyUpdate, splitPiiFields, splitPositionFields } from "./positionWrites";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const POSITION_COLUMNS = `
  id, scenario_id, lineage_id, active,
  department_code, job_type_code, cluster, cluster_multiplier_override,
  cluster_link_id, pay_type,
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
    clusterLinkId: (row.cluster_link_id as string) ?? "",
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
  componentDefIds?: ReadonlySet<string>,
  /** The plaintext store. Supplied by the handler to enable cluster-position
   *  sync: without it a write is an ordinary single-hotel write, which is what
   *  the tests that predate the feature (and any caller that has no structure
   *  handle) get. */
  structureDb?: Db
): PositionsBatchWriteResponse {
  const scenarioId = String(request.scenarioId ?? "");
  if (!scenarioId) throw new Error("A scenarioId is required");

  const stamp = new Date().toISOString();
  let applied = 0;
  let clusterSync: ClusterSyncResult | undefined;

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
    // Cluster assignment BEFORE the batch, for every row it touches: joining,
    // leaving or switching a cluster is only detectable by comparison, and the
    // snapshot has to be taken inside the transaction that changes it.
    const before = structureDb
      ? snapshotClusterState(db, scope, request)
      : new Map<string, RowBefore>();

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

    // Cluster positions last, inside the same transaction: the sibling hotels'
    // rows and the user's own edit land together or not at all.
    if (structureDb) {
      clusterSync = runClusterSync(
        { structureDb, valuesDb: db, stamp },
        {
          sourceScope: scope,
          scenarioId,
          before,
          positionFields: fieldsById(request, "position"),
          piiFields: fieldsById(request, "pii"),
          componentPatches: request.componentValuePatches ?? [],
          softDeleteIds: request.softDeleteIds ?? [],
          restoreIds: request.restoreIds ?? [],
          sourceLookup: lookup,
        }
      );
    }
  })();

  return { updatedAt: stamp, applied, clusterSync };
}

/** Cluster assignment + group of every row this request touches, read before
 *  any of it is applied. */
function snapshotClusterState(
  db: Db,
  scope: OuScope,
  request: PositionsBatchWriteRequest
): Map<string, RowBefore> {
  const ids = new Set<string>([
    ...(request.creates ?? []).map((create) => create.id),
    ...(request.positionPatches ?? []).map((patch) => patch.id),
    ...(request.piiPatches ?? []).map((patch) => patch.positionId),
    ...(request.componentValuePatches ?? []).map((patch) => patch.positionId),
    ...(request.softDeleteIds ?? []),
    ...(request.restoreIds ?? []),
  ]);

  const before = new Map<string, RowBefore>();
  const read = prepared(
    db,
    `SELECT cluster, cluster_link_id FROM positions WHERE id = ? AND ou = ?`
  );
  for (const id of ids) {
    const row = read.get(id, scope.ou) as
      | { cluster: string; cluster_link_id: string }
      | undefined;
    before.set(id, {
      cluster: row?.cluster ?? "",
      clusterLinkId: row?.cluster_link_id ?? "",
    });
  }
  return before;
}

/** Merge creates and patches into one catalog-keyed payload per row — what a
 *  sibling needs to receive, regardless of which lane it arrived in. */
function fieldsById(
  request: PositionsBatchWriteRequest,
  lane: "position" | "pii"
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const add = (id: string, fields?: Record<string, unknown>) => {
    if (!fields) return;
    out.set(id, { ...(out.get(id) ?? {}), ...fields });
  };

  for (const create of request.creates ?? []) {
    add(create.id, lane === "position" ? create.fields : create.pii);
  }
  if (lane === "position") {
    for (const patch of request.positionPatches ?? []) add(patch.id, patch.fields);
  } else {
    for (const patch of request.piiPatches ?? []) add(patch.positionId, patch.fields);
  }
  return out;
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
      // cluster_link_id carries forward so next year's rows stay one cluster
      // group across the hotels (each hotel clones its own scenario, and the
      // shared id is what re-joins them). Sibling sync always resolves its
      // targets to one scenario per hotel for the row's YEAR, so the older
      // year's rows — which hold the same link id — are never written to.
      `INSERT INTO positions (
         id, ou, scenario_id, lineage_id, active,
         department_code, job_type_code, cluster, cluster_multiplier_override,
         cluster_link_id, pay_type, headcount, fte,
         seasonality, monthly_base_salary, hourly_rate, additional_monthly_costs,
         merit_increase_pct, manual_yearly_increase, increase_month,
         daily_contract_hours, yearly_hours_worked, vacation_days,
         vacation_monthly_weights, accrual_days_per_month,
         extra_values, updated_at, deleted_at)
       SELECT ?, ou, ?, lineage_id, active,
         department_code, job_type_code, cluster, cluster_multiplier_override,
         cluster_link_id, pay_type, headcount, fte,
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
