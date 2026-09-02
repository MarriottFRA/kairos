/**
 * Manual-input repository — encrypted secure store access.
 *
 * CRUD over hand-entered cost lines in manual_input_rows. Every function takes
 * the Database handle explicitly (in-memory DB in tests), and clock/UUID values
 * are passed in so the repo stays deterministic — matching kpiDrivers/repo.ts.
 * OU scoping is bound into every WHERE/INSERT via scopeOf(); any `ou` on a row
 * payload is ignored. The 12-month vectors are stored as JSON text.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { normalizeOu } from "../positions/ouScope";
import {
  ManualInputRow,
  ManualInputRowId,
  MANUAL_INPUT_NO_INCREASE_MONTH,
  normalizeMonthVector,
  SpreadMode,
} from "../../shared/manualInput/ipc";

type SecureDb = InstanceType<typeof Database>;

interface DbRow {
  id: string;
  ou: string;
  scenario_id: string;
  description: string;
  department: string;
  department_code: string;
  cost_account: string;
  stats_account: string;
  rate: number | null;
  stats_kpi_driver_id: string | null;
  stats_kpi_divisor: number | null;
  stats_kpi_factor: number | null;
  stats_json: string;
  amounts_json: string;
  spread_mode: string | null;
  spread_base_stats: number | null;
  spread_base_amount: number | null;
  increase_pct: number;
  increase_month: number;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function scopeOf(ou: string): string {
  return normalizeOu(ou) ?? ou;
}

/** Parse a stored JSON month vector into a well-formed length-12 array. */
function parseVector(json: string): number[] {
  try {
    return normalizeMonthVector(JSON.parse(json));
  } catch {
    return normalizeMonthVector(null);
  }
}

function toRow(row: DbRow): ManualInputRow {
  return {
    id: row.id as ManualInputRowId,
    ou: row.ou,
    scenarioId: row.scenario_id ?? "",
    description: row.description,
    department: row.department,
    departmentCode: row.department_code,
    costAccount: row.cost_account,
    statsAccount: row.stats_account,
    rate: row.rate ?? null,
    statsKpiDriverId: row.stats_kpi_driver_id ?? null,
    statsKpiDivisor: row.stats_kpi_divisor ?? null,
    statsKpiFactor: row.stats_kpi_factor ?? null,
    stats: parseVector(row.stats_json),
    amounts: parseVector(row.amounts_json),
    spreadMode: (row.spread_mode as SpreadMode | null) ?? null,
    spreadBaseStats: row.spread_base_stats ?? null,
    spreadBaseAmount: row.spread_base_amount ?? null,
    increasePct: Number(row.increase_pct) || 0,
    increaseMonth: Number(row.increase_month) || MANUAL_INPUT_NO_INCREASE_MONTH,
    sortOrder: row.sort_order,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * All rows for an (OU, scenario), in sort order.
 *
 * Rows carrying '' predate the scenario scoping and are included everywhere
 * until healRowScenario stamps them — a mid-upgrade user must not open the page
 * to find their manual lines gone.
 */
export function listRows(
  db: SecureDb,
  ou: string,
  scenarioId: string
): ManualInputRow[] {
  const scoped = scopeOf(ou);
  const rows = db
    .prepare(
      `SELECT * FROM manual_input_rows
        WHERE ou = ? AND (scenario_id = ? OR scenario_id = '') AND deleted_at IS NULL
        ORDER BY sort_order, created_at, id`
    )
    .all(scoped, scenarioId) as DbRow[];
  return rows.map(toRow);
}

/**
 * Adopt this OU's un-scoped rows into a scenario.
 *
 * The secure-store migration could only default the column to '': `scenarios`
 * lives in the plaintext store and the two database files can never be
 * ATTACHed, so nothing down there can resolve which scenario a row belongs to.
 * The handler can — it holds both handles — so the stamp happens on first list.
 * Idempotent, and a no-op once every row is scoped.
 */
export function healRowScenario(
  db: SecureDb,
  ou: string,
  scenarioId: string
): void {
  if (!scenarioId) return;
  db.prepare(
    `UPDATE manual_input_rows SET scenario_id = ?
      WHERE ou = ? AND scenario_id = ''`
  ).run(scenarioId, scopeOf(ou));
}

/**
 * Give a real id to any row stored under the empty-string primary key.
 *
 * Those rows are the residue of the `input.id ?? randomUUID()` bug in the save
 * handler: "Add row" sends id: "", and `""` is not nullish, so the row landed on
 * the `''` key. Whatever the user then typed into it was saved there too, so the
 * row is real data and is renamed, never dropped. Delete could not name it (the
 * handler filters blank ids, hence "Missing row id(s).") and the next add
 * overwrote it, because `id` is the table's PRIMARY KEY — at most one such row
 * exists install-wide, so the OU scope here only decides who heals it.
 *
 * `newId` is passed in to keep this repo deterministic in tests, like the
 * clock/id values everything else here takes.
 */
export function healBlankRowIds(
  db: SecureDb,
  ou: string,
  newId: () => string
): void {
  const stmt = db.prepare(
    "UPDATE manual_input_rows SET id = ? WHERE id = '' AND ou = ?"
  );
  db.transaction(() => {
    stmt.run(newId(), scopeOf(ou));
  })();
}

/** The next sort_order for a new row in this (OU, scenario). */
export function nextSortOrder(
  db: SecureDb,
  ou: string,
  scenarioId: string
): number {
  const scoped = scopeOf(ou);
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) AS max FROM manual_input_rows
        WHERE ou = ? AND (scenario_id = ? OR scenario_id = '') AND deleted_at IS NULL`
    )
    .get(scoped, scenarioId) as { max: number };
  return (row?.max ?? -1) + 1;
}

/** A finite spread mode or null. */
function normSpreadMode(value: unknown): SpreadMode | null {
  return value === "flat" || value === "daysInMonth" ? value : null;
}

/** A finite spread base value, or null when blank/non-numeric. */
function toBaseOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

/**
 * Create or update a row. Timestamps/ids are passed in so this stays
 * deterministic. `sortOrder` is used only on insert (an update leaves the stored
 * order untouched via the ON CONFLICT set). When a rate is present the amounts
 * are derived downstream, so `amounts` is stored verbatim but never trusted for
 * rate-driven rows.
 */
export function saveRow(
  db: SecureDb,
  row: {
    id: string;
    ou: string;
    scenarioId: string;
    description: string;
    department: string;
    departmentCode: string;
    costAccount: string;
    statsAccount: string;
    rate: number | null;
    statsKpiDriverId: string | null;
    statsKpiDivisor: number | null;
    statsKpiFactor: number | null;
    stats: number[];
    amounts: number[];
    spreadMode: SpreadMode | null;
    spreadBaseStats: number | null;
    spreadBaseAmount: number | null;
    increasePct: number;
    increaseMonth: number;
    sortOrder: number;
    createdBy: string | null;
    now: string;
  }
): void {
  const scoped = scopeOf(row.ou);
  const rate =
    row.rate === null || row.rate === undefined || !Number.isFinite(Number(row.rate))
      ? null
      : Number(row.rate);
  const statsKpiDriverId = String(row.statsKpiDriverId ?? "").trim() || null;
  const statsKpiDivisor = toBaseOrNull(row.statsKpiDivisor);
  const statsKpiFactor = toBaseOrNull(row.statsKpiFactor);
  const spreadBaseStats = toBaseOrNull(row.spreadBaseStats);
  const spreadBaseAmount = toBaseOrNull(row.spreadBaseAmount);
  const increaseMonth =
    Number.isFinite(Number(row.increaseMonth)) &&
    Number(row.increaseMonth) >= 1 &&
    Number(row.increaseMonth) <= 12
      ? Number(row.increaseMonth)
      : MANUAL_INPUT_NO_INCREASE_MONTH;

  const upsert = db.prepare(`
    INSERT INTO manual_input_rows
      (id, ou, scenario_id, description, department, department_code, cost_account, stats_account, rate,
       stats_kpi_driver_id, stats_kpi_divisor, stats_kpi_factor,
       stats_json, amounts_json, spread_mode, spread_base_stats, spread_base_amount,
       increase_pct, increase_month, sort_order, created_by, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      scenario_id        = excluded.scenario_id,
      description        = excluded.description,
      department         = excluded.department,
      department_code    = excluded.department_code,
      cost_account       = excluded.cost_account,
      stats_account      = excluded.stats_account,
      rate               = excluded.rate,
      stats_kpi_driver_id = excluded.stats_kpi_driver_id,
      stats_kpi_divisor  = excluded.stats_kpi_divisor,
      stats_kpi_factor   = excluded.stats_kpi_factor,
      stats_json         = excluded.stats_json,
      amounts_json       = excluded.amounts_json,
      spread_mode        = excluded.spread_mode,
      spread_base_stats  = excluded.spread_base_stats,
      spread_base_amount = excluded.spread_base_amount,
      increase_pct       = excluded.increase_pct,
      increase_month     = excluded.increase_month,
      updated_at         = excluded.updated_at,
      deleted_at         = NULL
  `);

  db.transaction(() => {
    upsert.run(
      row.id,
      scoped,
      String(row.scenarioId ?? ""),
      String(row.description ?? ""),
      String(row.department ?? ""),
      String(row.departmentCode ?? ""),
      String(row.costAccount ?? ""),
      String(row.statsAccount ?? ""),
      rate,
      statsKpiDriverId,
      statsKpiDivisor,
      statsKpiFactor,
      JSON.stringify(normalizeMonthVector(row.stats)),
      JSON.stringify(normalizeMonthVector(row.amounts)),
      normSpreadMode(row.spreadMode),
      spreadBaseStats,
      spreadBaseAmount,
      Number(row.increasePct) || 0,
      increaseMonth,
      row.sortOrder,
      row.createdBy,
      row.now,
      row.now
    );
  })();
}

/** Soft-delete one or more rows for an OU. */
export function deleteRows(
  db: SecureDb,
  ou: string,
  ids: string[],
  params: { now: string }
): void {
  const scoped = scopeOf(ou);
  const stmt = db.prepare(
    "UPDATE manual_input_rows SET deleted_at = ?, updated_at = ? WHERE id = ? AND ou = ?"
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(params.now, params.now, id, scoped);
  })();
}
