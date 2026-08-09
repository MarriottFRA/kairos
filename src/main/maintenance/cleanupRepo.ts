/**
 * Soft-delete cleanup — the permanent sweep behind Settings → Storage cleanup.
 *
 * Deleting anything in Kairos stamps `deleted_at` and leaves the row in place;
 * that is what the undo snackbar, "Recently removed" columns and block restore
 * read back. Only removed grid columns are ever swept automatically (a 30-day
 * grace window on the Positions page), so everything else accumulates forever.
 * This module removes it for real, install-wide, across both stores.
 *
 * Two rules shape the code:
 *
 *  1. The scan and the purge MUST agree. Rather than maintain a second set of
 *     counting queries that drift, the scan runs the purge inside a transaction
 *     that is deliberately rolled back (`dryRun`). The counts are therefore
 *     exactly what a purge would do, with no double-counting of rows that
 *     qualify twice (a soft-deleted position inside a deleted plan).
 *
 *  2. The stores are separate files with no shared transaction. Encrypted-store
 *     rows go FIRST, plaintext parents last — the fieldCatalogPurge ordering
 *     rationale: a failure between the two leaves a parent over missing values
 *     (recoverable, re-runnable) rather than live values no definition explains.
 *
 * Child rows are deleted explicitly rather than trusting ON DELETE CASCADE, so
 * the result is identical whether or not `foreign_keys` is on (it is on in both
 * production stores; in-memory test databases may not exec the FK-bearing DDL).
 *
 * Every function takes the Database handles explicitly and this module stays
 * free of Electron imports — vitest drives it against in-memory databases.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { prepared } from "../positions/stmtCache";
import { resolveOuScope } from "../positions/ouScope";
import { scrubExtraValueKeys } from "../positions/positionsRepo";
import {
  CleanupTally,
  EMPTY_CLEANUP_TALLY,
} from "../../shared/maintenance/ipc";

type Db = InstanceType<typeof Database>;

/** Thrown to roll a dry run back; never escapes purgeSoftDeleted. */
class DryRunRollback extends Error {}

/**
 * The eligibility test, as a SQL fragment plus its binds.
 *
 * With no cutoff every soft-deleted row qualifies (the manual "clean up now"
 * button). With one, only rows deleted before it do — the automatic sweep, which
 * must leave the recent bin intact so undo and restore still work.
 *
 * Rows that carry no `deleted_at` of their own inherit eligibility from their
 * parent: the positions inside a deleted plan, the values of a deleted block.
 * That falls out of collectTargets applying the window once, up front.
 */
interface DeletedWindow {
  clause: string;
  params: string[];
}

function deletedWindow(olderThan?: string): DeletedWindow {
  return olderThan
    ? { clause: "deleted_at IS NOT NULL AND deleted_at < ?", params: [olderThan] }
    : { clause: "deleted_at IS NOT NULL", params: [] };
}

function hasTable(db: Db, table: string): boolean {
  return (
    prepared(
      db,
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table) !== undefined
  );
}

/** Run a DELETE and return the rows it removed; a missing table counts as 0. */
function del(db: Db, table: string, sql: string, ...params: unknown[]): number {
  if (!hasTable(db, table)) return 0;
  return prepared(db, sql).run(...params).changes;
}

function ids(db: Db, table: string, sql: string, ...params: unknown[]): string[] {
  if (!hasTable(db, table)) return [];
  return (prepared(db, sql).all(...params) as Array<{ id: string }>).map(
    (row) => row.id
  );
}

/**
 * Everything the plaintext store has marked deleted. Read once, up front: the
 * encrypted-store pass needs these ids while the rows still exist, and the
 * plaintext pass then drops them.
 */
/** One plan, addressed the way both stores key it. */
export interface ScenarioRef {
  id: string;
  ou: string;
}

interface CleanupTargets {
  /** Deleted plans — their whole contents go with them. */
  scenarios: ScenarioRef[];
  /** Deleted cost-component definitions (the compiled side of a block). */
  definitions: Array<{ id: string; ou: string }>;
  /** Removed user columns, grouped by hotel, for the extra_values scrub. */
  fieldKeysByOu: Map<string, string[]>;
  ssSchemeIds: string[];
  kpiDriverIds: string[];
  hotelClusterIds: string[];
}

function collectTargets(local: Db, window: DeletedWindow): CleanupTargets {
  const scenarios = hasTable(local, "scenarios")
    ? (prepared(
        local,
        `SELECT id, ou FROM scenarios WHERE ${window.clause}`
      ).all(...window.params) as Array<{ id: string; ou: string }>)
    : [];

  const definitions = hasTable(local, "cost_component_definitions")
    ? (prepared(
        local,
        `SELECT id, ou FROM cost_component_definitions WHERE ${window.clause}`
      ).all(...window.params) as Array<{ id: string; ou: string }>)
    : [];

  // SYSTEM catalog rows are never eligible — only user-added columns can be
  // removed in the first place (see structureRepo.purgeCatalogFields).
  const fieldKeysByOu = new Map<string, string[]>();
  if (hasTable(local, "field_catalog")) {
    const rows = prepared(
      local,
      `SELECT ou, field_key FROM field_catalog
        WHERE ${window.clause} AND origin = 'USER'`
    ).all(...window.params) as Array<{ ou: string; field_key: string }>;
    for (const row of rows) {
      const keys = fieldKeysByOu.get(row.ou) ?? [];
      keys.push(row.field_key);
      fieldKeysByOu.set(row.ou, keys);
    }
  }

  return {
    scenarios,
    definitions,
    fieldKeysByOu,
    ssSchemeIds: ids(
      local,
      "ss_schemes",
      `SELECT id FROM ss_schemes WHERE ${window.clause}`,
      ...window.params
    ),
    kpiDriverIds: ids(
      local,
      "kpi_drivers",
      `SELECT id FROM kpi_drivers WHERE ${window.clause}`,
      ...window.params
    ),
    hotelClusterIds: ids(
      local,
      "hotel_clusters",
      `SELECT id FROM hotel_clusters WHERE ${window.clause}`,
      ...window.params
    ),
  };
}

/**
 * Strip removed user columns out of every position/PII blob. Runs before the
 * catalog rows are dropped, for the reason given in the module header — and
 * per-OU, because scrubExtraValueKeys is (correctly) OU-scoped.
 */
function scrubRemovedFieldValues(secure: Db, targets: CleanupTargets): void {
  if (!hasTable(secure, "positions")) return;
  for (const [ou, keys] of targets.fieldKeysByOu) {
    let scope;
    try {
      scope = resolveOuScope(ou);
    } catch {
      // A catalog row stamped with an OU the validator no longer accepts. Its
      // values cannot be addressed safely, so leave them; the catalog row still
      // goes, and the orphaned JSON key is inert (nothing reads an unknown key).
      continue;
    }
    scrubExtraValueKeys(secure, scope, keys);
  }
}

/** Encrypted store: position values, PII, block values, manual rows, buyouts. */
/** Every position filed under a scenario, live or soft-deleted. */
function positionIdsInScenario(secure: Db, scenario: ScenarioRef): string[] {
  if (!hasTable(secure, "positions")) return [];
  return (
    prepared(
      secure,
      "SELECT id FROM positions WHERE ou = ? AND scenario_id = ?"
    ).all(scenario.ou, scenario.id) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** A position and everything that hangs off it. */
function deletePositionTree(secure: Db, id: string, tally: CleanupTally): void {
  tally.componentValues += del(
    secure,
    "component_values",
    "DELETE FROM component_values WHERE position_id = ?",
    id
  );
  tally.positionPii += del(
    secure,
    "position_pii",
    "DELETE FROM position_pii WHERE position_id = ?",
    id
  );
  tally.engineOutputLines += del(
    secure,
    "engine_output_lines",
    "DELETE FROM engine_output_lines WHERE position_id = ?",
    id
  );
  tally.positions += del(secure, "positions", "DELETE FROM positions WHERE id = ?", id);
}

/**
 * The rest of a plan's encrypted rows, once its positions are gone.
 *
 * Keyed on the scenario alone — no `deleted_at` anywhere in it. That is what
 * lets {@link purgeScenario} reuse it to remove ONE plan without touching
 * everybody else's recycle bin, while the install-wide sweep calls the same code
 * for each of its targets.
 */
function deleteScenarioTail(secure: Db, scenario: ScenarioRef, tally: CleanupTally): void {
  tally.buyoutRows += del(
    secure,
    "buyout_rows",
    "DELETE FROM buyout_rows WHERE ou = ? AND scenario_id = ?",
    scenario.ou,
    scenario.id
  );
  tally.manualInputRows += del(
    secure,
    "manual_input_rows",
    "DELETE FROM manual_input_rows WHERE ou = ? AND scenario_id = ?",
    scenario.ou,
    scenario.id
  );
  tally.engineOutputLines += del(
    secure,
    "engine_output_lines",
    "DELETE FROM engine_output_lines WHERE ou = ? AND scenario_id = ?",
    scenario.ou,
    scenario.id
  );
  // The run header is a cache row with no deleted_at of its own; it is
  // meaningless once its lines are gone, so it is dropped untallied.
  del(
    secure,
    "engine_runs",
    "DELETE FROM engine_runs WHERE ou = ? AND scenario_id = ?",
    scenario.ou,
    scenario.id
  );
}

function purgeSecureRows(
  secure: Db,
  targets: CleanupTargets,
  window: DeletedWindow,
  tally: CleanupTally
): void {
  // ── Positions: soft-deleted anywhere, plus every row filed under a deleted
  // plan. A deleted plan only ever soft-deletes the `scenarios` row, so its
  // positions are still live rows — invisible, but stored.
  const positionIds = new Set<string>();
  if (hasTable(secure, "positions")) {
    for (const scenario of targets.scenarios) {
      for (const id of positionIdsInScenario(secure, scenario)) positionIds.add(id);
    }
    const orphans = prepared(
      secure,
      `SELECT id FROM positions WHERE ${window.clause}`
    ).all(...window.params) as Array<{ id: string }>;
    for (const row of orphans) positionIds.add(row.id);
  }

  for (const id of positionIds) deletePositionTree(secure, id, tally);

  // ── Values whose block/definition is gone. No cross-file FK exists, so these
  // would otherwise sit in the encrypted store forever with nothing to read them.
  for (const definition of targets.definitions) {
    tally.componentValues += del(
      secure,
      "component_values",
      "DELETE FROM component_values WHERE ou = ? AND component_def_id = ?",
      definition.ou,
      definition.id
    );
    tally.engineOutputLines += del(
      secure,
      "engine_output_lines",
      "DELETE FROM engine_output_lines WHERE ou = ? AND component_def_id = ?",
      definition.ou,
      definition.id
    );
  }

  // ── Rows soft-deleted on their own, parent position still live (a block
  // removed from one row, a cleared PII sidecar).
  tally.componentValues += del(
    secure,
    "component_values",
    `DELETE FROM component_values WHERE ${window.clause}`,
    ...window.params
  );
  tally.positionPii += del(
    secure,
    "position_pii",
    `DELETE FROM position_pii WHERE ${window.clause}`,
    ...window.params
  );

  // ── The rest of a deleted plan: its buyout rows and its cached engine run.
  for (const scenario of targets.scenarios) deleteScenarioTail(secure, scenario, tally);

  tally.buyoutRows += del(
    secure,
    "buyout_rows",
    `DELETE FROM buyout_rows WHERE ${window.clause}`,
    ...window.params
  );
  tally.manualInputRows += del(
    secure,
    "manual_input_rows",
    `DELETE FROM manual_input_rows WHERE ${window.clause}`,
    ...window.params
  );
}

/** Plaintext store: plans, blocks, definitions, columns, schemes, clusters. */
function purgeLocalRows(
  local: Db,
  targets: CleanupTargets,
  window: DeletedWindow,
  tally: CleanupTally
): void {
  // Base-selector membership in BOTH directions. The forward edge cascades;
  // the referenced edge has no FK, so a purged def would leave other blocks
  // pointing at nothing.
  for (const definition of targets.definitions) {
    del(
      local,
      "component_base_refs",
      `DELETE FROM component_base_refs
        WHERE component_def_id = ? OR referenced_def_id = ?`,
      definition.id,
      definition.id
    );
  }
  tally.componentDefinitions += del(
    local,
    "cost_component_definitions",
    `DELETE FROM cost_component_definitions WHERE ${window.clause}`,
    ...window.params
  );

  tally.blocks += del(
    local,
    "block_configs",
    `DELETE FROM block_configs WHERE ${window.clause}`,
    ...window.params
  );

  tally.scenarios += del(
    local,
    "scenarios",
    `DELETE FROM scenarios WHERE ${window.clause}`,
    ...window.params
  );

  tally.fields += del(
    local,
    "field_catalog",
    `DELETE FROM field_catalog WHERE ${window.clause} AND origin = 'USER'`,
    ...window.params
  );

  for (const schemeId of targets.ssSchemeIds) {
    del(
      local,
      "ss_brackets",
      "DELETE FROM ss_brackets WHERE scheme_id = ?",
      schemeId
    );
  }
  tally.ssSchemes += del(
    local,
    "ss_schemes",
    `DELETE FROM ss_schemes WHERE ${window.clause}`,
    ...window.params
  );

  tally.allocations += del(
    local,
    "allocations",
    `DELETE FROM allocations WHERE ${window.clause}`,
    ...window.params
  );

  for (const driverId of targets.kpiDriverIds) {
    del(
      local,
      "kpi_driver_dept_patterns",
      "DELETE FROM kpi_driver_dept_patterns WHERE driver_id = ?",
      driverId
    );
    del(
      local,
      "kpi_driver_accounts",
      "DELETE FROM kpi_driver_accounts WHERE driver_id = ?",
      driverId
    );
    // The precalc cache carries no FK (built-in drivers have no parent row).
    del(
      local,
      "kpi_driver_values",
      "DELETE FROM kpi_driver_values WHERE driver_id = ?",
      driverId
    );
  }
  tally.kpiDrivers += del(
    local,
    "kpi_drivers",
    `DELETE FROM kpi_drivers WHERE ${window.clause}`,
    ...window.params
  );

  for (const clusterId of targets.hotelClusterIds) {
    del(
      local,
      "hotel_cluster_members",
      "DELETE FROM hotel_cluster_members WHERE cluster_id = ?",
      clusterId
    );
  }
  tally.hotelClusters += del(
    local,
    "hotel_clusters",
    `DELETE FROM hotel_clusters WHERE ${window.clause}`,
    ...window.params
  );
}

export interface PurgeOptions {
  /** Preview only — do the work, roll it back, return the counts. */
  dryRun?: boolean;
  /**
   * ISO timestamp. Only rows deleted STRICTLY BEFORE it are eligible; omit to
   * take everything. The automatic sweep passes a cutoff so the recent bin stays
   * undoable; the manual button passes none.
   */
  olderThan?: string;
}

/**
 * Permanently remove soft-deleted rows from both stores, install-wide.
 *
 * With `dryRun` the same work runs inside transactions that are rolled back, so
 * the returned tally is an exact preview and nothing is written. Callers must
 * pass an unlocked encrypted handle: purging only one store would leave the
 * other half orphaned.
 */
export function purgeSoftDeleted(
  local: Db,
  secure: Db,
  opts: PurgeOptions = {}
): CleanupTally {
  const tally: CleanupTally = { ...EMPTY_CLEANUP_TALLY };
  const window = deletedWindow(opts.olderThan);
  const targets = collectTargets(local, window);

  if (opts.dryRun) {
    try {
      // Nested so the throw unwinds both: secure rolls back, rethrows, local
      // rolls back, rethrows here.
      local.transaction(() => {
        secure.transaction(() => {
          scrubRemovedFieldValues(secure, targets);
          purgeSecureRows(secure, targets, window, tally);
          purgeLocalRows(local, targets, window, tally);
          throw new DryRunRollback();
        })();
      })();
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
    return tally;
  }

  secure.transaction(() => {
    scrubRemovedFieldValues(secure, targets);
    purgeSecureRows(secure, targets, window, tally);
  })();
  local.transaction(() => {
    purgeLocalRows(local, targets, window, tally);
  })();

  return tally;
}

/**
 * Permanently remove ONE plan and everything in it, from both stores.
 *
 * The Kairos server no longer lets access to a hotel stand in for access to a
 * colleague's plan, so a copy pulled under the old rules — or one whose
 * delegation has since been withdrawn — is data this machine has no business
 * holding. Soft-deleting it would not do: `softDeleteScenario` only stamps the
 * `scenarios` row, and every position, PII sidecar and component value stays
 * live in the encrypted store, invisible and entirely readable to anyone with
 * the file. The whole point of the change is that those rows go.
 *
 * Deliberately NOT `purgeSoftDeleted` with a filter: that function is
 * install-wide by design and would empty the user's own recycle bin as a side
 * effect of losing access to somebody else's plan.
 *
 * The per-row work is the same code the sweep runs, so the two cannot drift.
 * What differs is the absence of any `deleted_at` predicate — this is keyed on
 * the scenario alone, which is what confines it to one plan.
 *
 * Same ordering rationale as the sweep: encrypted store first, plaintext parent
 * last, so an interrupted purge leaves a plan row over missing values (visible,
 * re-runnable) rather than orphaned values nothing explains.
 */
export function purgeScenario(
  local: Db,
  secure: Db,
  scenario: ScenarioRef
): CleanupTally {
  const tally: CleanupTally = { ...EMPTY_CLEANUP_TALLY };

  secure.transaction(() => {
    for (const id of positionIdsInScenario(secure, scenario)) {
      deletePositionTree(secure, id, tally);
    }
    deleteScenarioTail(secure, scenario, tally);
  })();

  local.transaction(() => {
    tally.scenarios += del(
      local,
      "scenarios",
      "DELETE FROM scenarios WHERE id = ? AND ou = ?",
      scenario.id,
      scenario.ou
    );
  })();

  return tally;
}

/** Exact preview of what {@link purgeSoftDeleted} would remove. Writes nothing. */
export function scanSoftDeleted(
  local: Db,
  secure: Db,
  olderThan?: string
): CleanupTally {
  return purgeSoftDeleted(local, secure, { dryRun: true, olderThan });
}

/**
 * Rebuild both database files so the freed pages are handed back to the OS.
 * VACUUM cannot run inside a transaction, so this is deliberately separate from
 * the purge — and best-effort: a failure here costs disk space, not data.
 */
export function vacuumStores(local: Db, secure: Db): void {
  local.exec("VACUUM");
  secure.exec("VACUUM");
}
