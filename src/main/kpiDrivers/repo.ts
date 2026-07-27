/**
 * KPI-driver repository — plaintext local store access.
 *
 * Definitions live in kpi_drivers (+ child pattern/account tables); their
 * resolved 12-month series are precalculated into kpi_driver_values by a plain
 * GROUP BY over budget_values. Built-in drivers are code-defined (builtins.ts),
 * UNIONed into reads, and cache their series under a stable id just like user
 * drivers — so the engine load path never distinguishes the two.
 *
 * Every function takes the Database handle explicitly (in-memory DB in tests),
 * and clock values are passed in, matching budgetImport/repo.ts. GLOB is
 * case-sensitive; patterns/prefixes are upper-cased at write time and the budget
 * data is stored upper-cased, so matching is consistent.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { normalizeOu } from "../positions/ouScope";
import {
  KPI_EXPLICIT_DEPT_KEY,
  KPI_PERIOD_COUNT,
  KpiDeptMode,
  KpiDriver,
  KpiDriverId,
  KpiDriverSeries,
} from "../../shared/kpiDrivers/ipc";
import { BUILTIN_KPI_DRIVERS, isBuiltinDriverId } from "./builtins";

type LocalDb = InstanceType<typeof Database>;

/** The fields needed to run a driver's aggregation, regardless of user/built-in. */
interface ResolvedDriverDef {
  id: string;
  deptMode: KpiDeptMode;
  deptPatterns: string[];
  accountPrefixes: string[];
  bucketIndex: number;
  /** Applied to every aggregated period before caching; 1 = as-is. */
  multiplier: number;
}

interface DriverRow {
  id: string;
  ou: string;
  label: string;
  description: string | null;
  dept_mode: KpiDeptMode;
  bucket_index: number;
  multiplier: number | null;
  aggregation: string;
  sort_order: number;
  created_by: string | null;
  updated_at: string;
  deleted_at: string | null;
}

function scopeOf(ou: string): string {
  return normalizeOu(ou) ?? ou;
}

/** A stored/typed multiplier coerced to a usable factor; anything unusable
 *  (null from a pre-column store, NaN from a bad payload) falls back to 1. */
function normMultiplier(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 1;
}

function loadPatterns(db: LocalDb, driverId: string): string[] {
  return (
    db
      .prepare("SELECT pattern FROM kpi_driver_dept_patterns WHERE driver_id = ?")
      .all(driverId) as Array<{ pattern: string }>
  ).map((r) => r.pattern);
}

function loadAccounts(db: LocalDb, driverId: string): string[] {
  return (
    db
      .prepare("SELECT starts_with FROM kpi_driver_accounts WHERE driver_id = ?")
      .all(driverId) as Array<{ starts_with: string }>
  ).map((r) => r.starts_with);
}

/** The OU's current budget import id, or null if it has never pulled. */
function currentImportId(db: LocalDb, scoped: string): string | null {
  const row = db
    .prepare("SELECT id FROM budget_imports WHERE ou = ?")
    .get(scoped) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Zero-fill a period->value list into a length-12 vector. */
function zeroFillPeriods(rows: Array<{ period: number; value: number }>): number[] {
  const out = new Array<number>(KPI_PERIOD_COUNT).fill(0);
  for (const r of rows) {
    if (r.period >= 1 && r.period <= KPI_PERIOD_COUNT) {
      out[r.period - 1] = Number(r.value) || 0;
    }
  }
  return out;
}

/**
 * A driver is stale when its cache was computed against a superseded budget
 * import, or the definition changed after its last compute. A driver with no
 * cache is stale only when there is budget data to compute from.
 */
function computeStale(
  db: LocalDb,
  scoped: string,
  driverId: string,
  updatedAt: string
): boolean {
  const importId = currentImportId(db, scoped);
  const rows = db
    .prepare(
      "SELECT DISTINCT source_import_id AS src, computed_at AS at FROM kpi_driver_values WHERE ou = ? AND driver_id = ?"
    )
    .all(scoped, driverId) as Array<{ src: string | null; at: string }>;

  if (rows.length === 0) return importId !== null; // nothing cached but data exists
  for (const r of rows) {
    if ((r.src ?? null) !== importId) return true;
    if (updatedAt && r.at < updatedAt) return true;
  }
  return false;
}

function toDriver(
  db: LocalDb,
  scoped: string,
  row: DriverRow
): KpiDriver {
  return {
    id: row.id as KpiDriverId,
    ou: row.ou,
    label: row.label,
    description: row.description ?? "",
    deptMode: row.dept_mode,
    deptPatterns: row.dept_mode === "EXPLICIT" ? loadPatterns(db, row.id) : [],
    accountPrefixes: loadAccounts(db, row.id),
    bucketIndex: row.bucket_index,
    multiplier: normMultiplier(row.multiplier),
    aggregation: "SUM",
    sortOrder: row.sort_order,
    isBuiltin: false,
    isStale: computeStale(db, scoped, row.id, row.updated_at),
    updatedAt: row.updated_at,
  };
}

/** All drivers for an OU — built-ins first, then user drivers by sort order. */
export function listDrivers(db: LocalDb, ou: string): KpiDriver[] {
  const scoped = scopeOf(ou);

  const builtins: KpiDriver[] = BUILTIN_KPI_DRIVERS.map((b, index) => ({
    id: b.id,
    ou: scoped,
    label: b.label,
    description: b.description,
    deptMode: b.deptMode,
    deptPatterns: b.deptMode === "EXPLICIT" ? b.deptPatterns : [],
    accountPrefixes: b.accountPrefixes,
    bucketIndex: b.bucketIndex,
    multiplier: 1, // built-ins are raw roll-ups; only user drivers derive a pot
    aggregation: "SUM",
    sortOrder: index,
    isBuiltin: true,
    isStale: computeStale(db, scoped, b.id, ""),
    updatedAt: "",
  }));

  const userRows = db
    .prepare(
      "SELECT * FROM kpi_drivers WHERE ou = ? AND deleted_at IS NULL ORDER BY sort_order, id"
    )
    .all(scoped) as DriverRow[];

  return [...builtins, ...userRows.map((row) => toDriver(db, scoped, row))];
}

/** The resolved definition for one driver (user or built-in), or null. */
function resolveDriver(
  db: LocalDb,
  scoped: string,
  driverId: string
): ResolvedDriverDef | null {
  const builtin = BUILTIN_KPI_DRIVERS.find((b) => b.id === driverId);
  if (builtin) {
    return {
      id: builtin.id,
      deptMode: builtin.deptMode,
      deptPatterns: builtin.deptPatterns,
      accountPrefixes: builtin.accountPrefixes,
      bucketIndex: builtin.bucketIndex,
      multiplier: 1,
    };
  }
  const row = db
    .prepare(
      "SELECT id, dept_mode, bucket_index, multiplier FROM kpi_drivers WHERE id = ? AND ou = ? AND deleted_at IS NULL"
    )
    .get(driverId, scoped) as
    | {
        id: string;
        dept_mode: KpiDeptMode;
        bucket_index: number;
        multiplier: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    deptMode: row.dept_mode,
    deptPatterns: loadPatterns(db, row.id),
    accountPrefixes: loadAccounts(db, row.id),
    bucketIndex: row.bucket_index,
    multiplier: normMultiplier(row.multiplier),
  };
}

/** Every driver's resolved definition for an OU (built-ins + user). */
function resolveAllDrivers(db: LocalDb, scoped: string): ResolvedDriverDef[] {
  const builtins: ResolvedDriverDef[] = BUILTIN_KPI_DRIVERS.map((b) => ({
    id: b.id,
    deptMode: b.deptMode,
    deptPatterns: b.deptPatterns,
    accountPrefixes: b.accountPrefixes,
    bucketIndex: b.bucketIndex,
    multiplier: 1,
  }));
  const users = (
    db
      .prepare(
        "SELECT id, dept_mode, bucket_index, multiplier FROM kpi_drivers WHERE ou = ? AND deleted_at IS NULL"
      )
      .all(scoped) as Array<{
      id: string;
      dept_mode: KpiDeptMode;
      bucket_index: number;
      multiplier: number | null;
    }>
  ).map((row) => ({
    id: row.id,
    deptMode: row.dept_mode,
    deptPatterns: loadPatterns(db, row.id),
    accountPrefixes: loadAccounts(db, row.id),
    bucketIndex: row.bucket_index,
    multiplier: normMultiplier(row.multiplier),
  }));
  return [...builtins, ...users];
}

/**
 * Run a driver's aggregation over budget_values, returning one series per
 * dept_key: a single '*' series for EXPLICIT, one per department for POSITION.
 * Patterns/prefixes are bound as parameters (never interpolated); account
 * prefixes match as `<prefix>*` via GLOB.
 */
function aggregate(
  db: LocalDb,
  scoped: string,
  def: ResolvedDriverDef
): Array<{ deptKey: string; values: number[] }> {
  const accountPrefixes =
    def.accountPrefixes.length > 0 ? def.accountPrefixes : ["*"];
  const accountClause = accountPrefixes.map(() => "account GLOB ?").join(" OR ");
  const accountParams = accountPrefixes.map((p) =>
    p === "*" ? "*" : `${p}*`
  );

  if (def.deptMode === "EXPLICIT") {
    const patterns = def.deptPatterns.length > 0 ? def.deptPatterns : ["*"];
    const deptClause = patterns.map(() => "dept GLOB ?").join(" OR ");
    const rows = db
      .prepare(
        `SELECT period, SUM(value) AS value
           FROM budget_values
          WHERE ou = ? AND bucket_index = ?
            AND (${deptClause}) AND (${accountClause})
          GROUP BY period
          ORDER BY period`
      )
      .all(scoped, def.bucketIndex, ...patterns, ...accountParams) as Array<{
      period: number;
      value: number;
    }>;
    // EXPLICIT always yields exactly one series (zeros when there is no data).
    return [{ deptKey: KPI_EXPLICIT_DEPT_KEY, values: zeroFillPeriods(rows) }];
  }

  // POSITION: GROUP BY dept enumerates exactly the departments present.
  const rows = db
    .prepare(
      `SELECT dept, period, SUM(value) AS value
         FROM budget_values
        WHERE ou = ? AND bucket_index = ?
          AND (${accountClause})
        GROUP BY dept, period
        ORDER BY dept, period`
    )
    .all(scoped, def.bucketIndex, ...accountParams) as Array<{
    dept: string;
    period: number;
    value: number;
  }>;

  const byDept = new Map<string, Array<{ period: number; value: number }>>();
  for (const r of rows) {
    const list = byDept.get(r.dept) ?? [];
    list.push({ period: r.period, value: r.value });
    byDept.set(r.dept, list);
  }
  return [...byDept.entries()].map(([deptKey, list]) => ({
    deptKey,
    values: zeroFillPeriods(list),
  }));
}

/** Clear-then-insert the cached series for one driver, in a transaction. */
function writeSeries(
  db: LocalDb,
  scoped: string,
  def: ResolvedDriverDef,
  computedAt: string,
  sourceImportId: string | null
): void {
  // The multiplier is baked in HERE rather than at read time, so the cached
  // series is the final figure everywhere: the KPI page shows the pot in
  // currency, and consumers never re-apply the rate. It also means changing a
  // multiplier moves kpi_driver_values, which computeFingerprint already
  // probes — results go stale without a new probe.
  const factor = normMultiplier(def.multiplier);
  const series = aggregate(db, scoped, def).map((s) => ({
    deptKey: s.deptKey,
    values: factor === 1 ? s.values : s.values.map((value) => value * factor),
  }));
  const insert = db.prepare(
    `INSERT INTO kpi_driver_values
       (driver_id, ou, dept_key, period, value, source_import_id, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare(
      "DELETE FROM kpi_driver_values WHERE ou = ? AND driver_id = ?"
    ).run(scoped, def.id);
    for (const s of series) {
      for (let period = 1; period <= KPI_PERIOD_COUNT; period++) {
        insert.run(
          def.id,
          scoped,
          s.deptKey,
          period,
          s.values[period - 1] ?? 0,
          sourceImportId,
          computedAt
        );
      }
    }
  })();
}

/** Recompute and cache one driver's series for an OU. */
export function recomputeDriver(
  db: LocalDb,
  ou: string,
  driverId: string,
  params: { computedAt: string }
): void {
  const scoped = scopeOf(ou);
  const def = resolveDriver(db, scoped, driverId);
  if (!def) return;
  writeSeries(db, scoped, def, params.computedAt, currentImportId(db, scoped));
}

/** Recompute every driver (user + built-in) for an OU — e.g. after a budget pull. */
export function recomputeAllForOu(
  db: LocalDb,
  ou: string,
  params: { computedAt: string }
): void {
  const scoped = scopeOf(ou);
  const sourceImportId = currentImportId(db, scoped);
  for (const def of resolveAllDrivers(db, scoped)) {
    writeSeries(db, scoped, def, params.computedAt, sourceImportId);
  }
}

/** The cached series for one driver, grouped by dept_key and zero-filled. */
export function getSeries(
  db: LocalDb,
  ou: string,
  driverId: string
): KpiDriverSeries[] {
  const scoped = scopeOf(ou);
  const rows = db
    .prepare(
      `SELECT dept_key, period, value, source_import_id, computed_at
         FROM kpi_driver_values
        WHERE ou = ? AND driver_id = ?
        ORDER BY dept_key, period`
    )
    .all(scoped, driverId) as Array<{
    dept_key: string;
    period: number;
    value: number;
    source_import_id: string | null;
    computed_at: string;
  }>;

  const byDept = new Map<string, KpiDriverSeries>();
  for (const r of rows) {
    let series = byDept.get(r.dept_key);
    if (!series) {
      series = {
        driverId: driverId as KpiDriverId,
        deptKey: r.dept_key,
        values: new Array<number>(KPI_PERIOD_COUNT).fill(0),
        sourceImportId: r.source_import_id,
        computedAt: r.computed_at,
      };
      byDept.set(r.dept_key, series);
    }
    if (r.period >= 1 && r.period <= KPI_PERIOD_COUNT) {
      series.values[r.period - 1] = Number(r.value) || 0;
    }
  }
  return [...byDept.values()];
}

/** Normalize a code/pattern for GLOB matching: trim + upper-case. */
function normPattern(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Create or update a user driver and replace its child rows, in one
 * transaction. Built-in ids are rejected. POSITION mode stores no dept
 * patterns. Timestamps/ids are passed in so this stays deterministic.
 */
export function saveDriver(
  db: LocalDb,
  driver: {
    id: string;
    ou: string;
    label: string;
    description?: string;
    deptMode: KpiDeptMode;
    deptPatterns: string[];
    accountPrefixes: string[];
    bucketIndex: number;
    multiplier?: number;
    sortOrder: number;
    createdBy: string | null;
    now: string;
  }
): void {
  if (isBuiltinDriverId(driver.id)) {
    throw new Error("Built-in KPI drivers cannot be edited.");
  }
  const scoped = scopeOf(driver.ou);
  const label = driver.label.trim();
  if (!label) throw new Error("KPI driver needs a label.");
  const description = (driver.description ?? "").trim();

  const accounts = [
    ...new Set(driver.accountPrefixes.map(normPattern).filter(Boolean)),
  ];
  if (accounts.length === 0) {
    throw new Error("KPI driver needs at least one account prefix.");
  }
  const patterns =
    driver.deptMode === "EXPLICIT"
      ? [...new Set(driver.deptPatterns.map(normPattern).filter(Boolean))]
      : [];
  if (driver.deptMode === "EXPLICIT" && patterns.length === 0) {
    throw new Error("An explicit-department KPI needs at least one pattern.");
  }
  const bucketIndex =
    driver.bucketIndex >= 1 && driver.bucketIndex <= 3 ? driver.bucketIndex : 1;
  const multiplier = normMultiplier(driver.multiplier ?? 1);

  const upsertDriver = db.prepare(`
    INSERT INTO kpi_drivers
      (id, ou, label, description, dept_mode, bucket_index, multiplier, aggregation, sort_order, created_by, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'SUM', ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      description = excluded.description,
      dept_mode = excluded.dept_mode,
      bucket_index = excluded.bucket_index,
      multiplier = excluded.multiplier,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `);
  const insertPattern = db.prepare(
    "INSERT INTO kpi_driver_dept_patterns (driver_id, pattern) VALUES (?, ?)"
  );
  const insertAccount = db.prepare(
    "INSERT INTO kpi_driver_accounts (driver_id, starts_with) VALUES (?, ?)"
  );

  db.transaction(() => {
    upsertDriver.run(
      driver.id,
      scoped,
      label,
      description,
      driver.deptMode,
      bucketIndex,
      multiplier,
      driver.sortOrder,
      driver.createdBy,
      driver.now
    );
    db.prepare("DELETE FROM kpi_driver_dept_patterns WHERE driver_id = ?").run(
      driver.id
    );
    db.prepare("DELETE FROM kpi_driver_accounts WHERE driver_id = ?").run(
      driver.id
    );
    for (const p of patterns) insertPattern.run(driver.id, p);
    for (const a of accounts) insertAccount.run(driver.id, a);
  })();
}

/** Soft-delete a user driver and drop its cached series. Built-ins rejected. */
export function deleteDriver(
  db: LocalDb,
  ou: string,
  driverId: string,
  params: { now: string }
): void {
  if (isBuiltinDriverId(driverId)) {
    throw new Error("Built-in KPI drivers cannot be deleted.");
  }
  const scoped = scopeOf(ou);
  db.transaction(() => {
    db.prepare(
      "UPDATE kpi_drivers SET deleted_at = ? WHERE id = ? AND ou = ?"
    ).run(params.now, driverId, scoped);
    db.prepare(
      "DELETE FROM kpi_driver_values WHERE ou = ? AND driver_id = ?"
    ).run(scoped, driverId);
  })();
}

/** The next sort_order for a new user driver in this OU. */
export function nextSortOrder(db: LocalDb, ou: string): number {
  const scoped = scopeOf(ou);
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), -1) AS max FROM kpi_drivers WHERE ou = ? AND deleted_at IS NULL"
    )
    .get(scoped) as { max: number };
  return (row?.max ?? -1) + 1;
}
