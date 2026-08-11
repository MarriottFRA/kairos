/**
 * Cluster positions — sibling rows across the member hotels.
 * -----------------------------------------------------------
 * A hotel cluster splits one person's cost across its member hotels, and each
 * hotel books its own weighted share, so the costing model has always needed one
 * position ROW per member hotel. What was missing was the link between them:
 * users created the same Director of HR three times and edited it three times.
 *
 * This module is that link. Rows of one shared person carry the same
 * `positions.cluster_link_id`, and it maintains them:
 *
 *   materialise   assigning a cluster to a row creates the sibling rows in the
 *                 cluster's other member hotels
 *   propagate     an edit to any sibling is re-applied to the others (peer
 *                 model — no home hotel, last write wins)
 *   cascade       delete/restore of one sibling applies to the group
 *   unlink        clearing the cluster leaves the siblings as ordinary
 *                 standalone rows — never deletes them
 *   membership    adding a hotel to a cluster back-fills its rows; removing one
 *                 unlinks (never deletes) what it already had
 *
 * It is the second of the two sanctioned cross-OU APIs (see ouScope.ts). Every
 * write still goes through a scope minted for the target hotel, so no statement
 * here is less OU-bound than an ordinary single-hotel write.
 *
 * TWO RULES DO THE SCOPING WORK, and both matter:
 *
 * 1. Sync only fires when the source row sits in its hotel's resolved planning
 *    scenario for the year. A row being edited in a what-if scenario stays put:
 *    leaking speculative numbers into three hotels' budgets is worse than the
 *    what-if simply not being shared.
 * 2. Targets are resolved per member hotel as ONE scenario — that hotel's
 *    planning scenario for the SAME year. This is what keeps a link id safe
 *    across a year roll-forward: a clone carries the id forward, so 2026 and
 *    2027 both hold a group with that id, and the year filter means an edit to
 *    2027 can never reach into 2026.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { uuidv7 } from "../../shared/engine/ids";
import {
  ClusterSyncResult,
  ClusterSyncSkip,
  EMPTY_CLUSTER_SYNC,
  mergeClusterSync,
  syncsByKey,
} from "../../shared/positions/clusterSync";
import { FieldDef } from "../../shared/positions/fields";
import { ComponentValuePatch } from "../../shared/positions/ipc";
import { resolvePlanningScenario } from "../../shared/positions/scenarioResolve";
import { listClusters } from "../hotelClusters/repo";
import { ClusterTranslator, buildTranslator } from "./clusterBlockMap";
import { OuScope, resolveOuScope } from "./ouScope";
import {
  FieldLookup,
  applyUpdate,
  splitPiiFields,
  splitPositionFields,
} from "./positionWrites";
import { prepared } from "./stmtCache";
import { ensureDefaultScenario, getFieldCatalog, listScenarios } from "./structureRepo";

type Db = InstanceType<typeof Database>;

export interface SyncDeps {
  /** Plaintext store: clusters, scenarios, blocks, field catalogs. */
  structureDb: Db;
  /** Encrypted store: the position rows themselves. */
  valuesDb: Db;
  /** One stamp for the whole enclosing batch. */
  stamp: string;
  mintId?: () => string;
}

/** One member hotel's mirror target: the hotel and the scenario rows land in. */
interface SyncTarget {
  scope: OuScope;
  scenarioId: string;
  translator: ClusterTranslator;
  lookup: FieldLookup;
}

const newId = (deps: SyncDeps) => (deps.mintId ?? uuidv7)();

// ---------------------------------------------------------------------------
// Scenario resolution
// ---------------------------------------------------------------------------

function scenarioYear(
  structureDb: Db,
  scope: OuScope,
  scenarioId: string
): number | null {
  const row = prepared(
    structureDb,
    `SELECT year FROM scenarios WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(scenarioId, scope.ou) as { year?: number } | undefined;
  return row?.year ?? null;
}

/**
 * The one scenario a hotel's grid shows for a year, creating the seeded
 * "Planning" row if the hotel has nothing for that year yet.
 *
 * Uses the same ladder as the renderer with no persisted preference: that
 * preference is a single app-global id which only ever matches the hotel the
 * user currently has selected, so for every OTHER hotel the renderer falls
 * through to exactly this answer.
 */
function planningScenarioIdFor(
  structureDb: Db,
  scope: OuScope,
  year: number
): string | null {
  ensureDefaultScenario(structureDb, scope, year);
  const resolved = resolvePlanningScenario(
    listScenarios(structureDb, scope),
    year
  );
  return resolved?.id ?? null;
}

/** Rule 1: is this row's scenario the one that hotel's grid shows? */
function isPlanningScenario(
  structureDb: Db,
  scope: OuScope,
  scenarioId: string,
  year: number
): boolean {
  const resolved = resolvePlanningScenario(
    listScenarios(structureDb, scope),
    year
  );
  return resolved?.id === scenarioId;
}

/**
 * The mirror targets for one cluster: every member hotel except the source,
 * each with its planning scenario, a translator, and its own field catalog.
 *
 * Reading the catalog also seeds it (getFieldCatalog → ensureFieldCatalogSeed),
 * which is what lets a hotel that has never had its Positions page opened still
 * receive a mirrored row.
 */
function resolveTargets(
  deps: SyncDeps,
  clusterId: string,
  sourceOu: string,
  year: number
): SyncTarget[] {
  const cluster = listClusters(deps.structureDb).find((c) => c.id === clusterId);
  if (!cluster) return []; // dangling assignment — resolves to weight 1, no group

  const targets: SyncTarget[] = [];
  for (const member of cluster.members) {
    if (member.ou === sourceOu) continue;
    let scope: OuScope;
    try {
      scope = resolveOuScope(member.ou);
    } catch {
      continue; // a malformed member OU is a cluster-config problem, not ours
    }
    const scenarioId = planningScenarioIdFor(deps.structureDb, scope, year);
    if (!scenarioId) continue;
    targets.push({
      scope,
      scenarioId,
      translator: buildTranslator(deps.structureDb, sourceOu, scope.ou),
      lookup: fieldLookup(deps.structureDb, scope),
    });
  }
  return targets;
}

function fieldLookup(structureDb: Db, scope: OuScope): FieldLookup {
  const catalog = getFieldCatalog(structureDb, scope);
  return new Map(catalog.fields.map((field) => [field.key, field]));
}

// ---------------------------------------------------------------------------
// Sibling lookup
// ---------------------------------------------------------------------------

export interface SiblingRow {
  id: string;
  ou: string;
  scenario_id: string;
}

/**
 * The other rows of a group, restricted to the resolved target scenarios.
 *
 * The restriction is the year/scenario guard: rows carrying the same link id in
 * an earlier year (a roll-forward clone) or in a what-if scenario of the same
 * year are deliberately not siblings for the purposes of a write.
 */
function siblingsIn(
  valuesDb: Db,
  linkId: string,
  targets: readonly SyncTarget[],
  excludeId: string
): Array<SiblingRow & { target: SyncTarget }> {
  if (!linkId || targets.length === 0) return [];
  const byOu = new Map(targets.map((target) => [target.scope.ou, target]));
  const rows = prepared(
    valuesDb,
    `SELECT id, ou, scenario_id FROM positions
      WHERE cluster_link_id = ? AND deleted_at IS NULL`
  ).all(linkId) as SiblingRow[];

  const out: Array<SiblingRow & { target: SyncTarget }> = [];
  for (const row of rows) {
    if (row.id === excludeId) continue;
    const target = byOu.get(row.ou);
    if (!target || target.scenarioId !== row.scenario_id) continue;
    out.push({ ...row, target });
  }
  return out;
}

/** Every row of a group in any hotel/scenario — for unlink and delete, which
 *  are group-wide by intent rather than scoped to one year's targets. */
function allSiblings(
  valuesDb: Db,
  linkId: string,
  excludeId: string
): SiblingRow[] {
  if (!linkId) return [];
  return (
    prepared(
      valuesDb,
      `SELECT id, ou, scenario_id FROM positions
        WHERE cluster_link_id = ? AND id <> ?`
    ).all(linkId, excludeId) as SiblingRow[]
  );
}

// ---------------------------------------------------------------------------
// Materialise
// ---------------------------------------------------------------------------

const COPIED_POSITION_COLUMNS = `
  active, department_code, job_type_code, cluster, pay_type, headcount,
  seasonality, monthly_base_salary, hourly_rate, additional_monthly_costs,
  merit_increase_pct, manual_yearly_increase, increase_month,
  daily_contract_hours, yearly_hours_worked, vacation_days,
  vacation_monthly_weights, accrual_days_per_month`;

/**
 * Create the sibling rows for one source row in every other member hotel.
 *
 * Deliberately NOT copied: fte (a hotel derives it from its own calendar and
 * full-time yardstick), cluster_multiplier_override (per-hotel, and only legal
 * for a single-member cluster), and lineage_id (a mirror starts its own
 * year-over-year lineage — it is a different hotel's row, not a clone of this
 * one). extra_values is filtered to the keys that mean the same thing in the
 * target hotel; block values are translated or skipped.
 */
function materializeInto(
  deps: SyncDeps,
  sourceScope: OuScope,
  sourceId: string,
  linkId: string,
  target: SyncTarget
): { created?: { ou: string; positionId: string }; skips: ClusterSyncSkip[] } {
  const skips: ClusterSyncSkip[] = [];

  // Already mirrored into this hotel's scenario? Nothing to do — this is what
  // makes materialise idempotent under queue retries and membership re-saves.
  const existing = prepared(
    deps.valuesDb,
    `SELECT 1 FROM positions
      WHERE cluster_link_id = ? AND ou = ? AND scenario_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).get(linkId, target.scope.ou, target.scenarioId);
  if (existing) return { skips };

  const positionId = newId(deps);
  const inserted = prepared(
    deps.valuesDb,
    `INSERT INTO positions (
       id, ou, scenario_id, lineage_id, cluster_link_id, ${COPIED_POSITION_COLUMNS},
       extra_values, updated_at)
     SELECT ?, ?, ?, ?, ?, ${COPIED_POSITION_COLUMNS}, '{}', ?
       FROM positions
      WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).run(
    positionId,
    target.scope.ou,
    target.scenarioId,
    positionId,
    linkId,
    deps.stamp,
    sourceId,
    sourceScope.ou
  );
  if (inserted.changes === 0) return { skips };

  // Extras and PII go through the ordinary patch path so the target hotel's own
  // catalog validates them — a key it does not have is dropped, not forced in.
  const source = prepared(
    deps.valuesDb,
    `SELECT extra_values FROM positions WHERE id = ? AND ou = ?`
  ).get(sourceId, sourceScope.ou) as { extra_values?: string } | undefined;
  const extras = translateExtras(
    parseJson(source?.extra_values),
    target,
    skips,
    "POSITION_EXTRA"
  );
  if (Object.keys(extras).length > 0) {
    applyUpdate(
      deps.valuesDb,
      "positions",
      "id",
      positionId,
      target.scope,
      splitPositionFields(extras, target.lookup),
      deps.stamp
    );
  }

  copyPii(deps, sourceScope, sourceId, positionId, target, skips);
  copyComponentValues(deps, sourceScope, sourceId, positionId, target, skips);

  return { created: { ou: target.scope.ou, positionId }, skips };
}

function parseJson(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/**
 * Filter a source extra_values blob to what the target hotel can hold: SYSTEM
 * keys pass through (one seed, same key everywhere), USER keys are matched by
 * label or skipped.
 */
function translateExtras(
  extras: Record<string, unknown>,
  target: SyncTarget,
  skips: ClusterSyncSkip[],
  storage: FieldDef["storage"]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extras)) {
    const translated = target.translator.fieldKey(key);
    if (!translated.id) {
      skips.push(translated.skip);
      continue;
    }
    const def = target.lookup.get(translated.id);
    if (!def || def.storage !== storage) continue;
    out[translated.id] = value;
  }
  return out;
}

function copyPii(
  deps: SyncDeps,
  sourceScope: OuScope,
  sourceId: string,
  targetId: string,
  target: SyncTarget,
  skips: ClusterSyncSkip[]
): void {
  const pii = prepared(
    deps.valuesDb,
    `SELECT hiring_date, emp_number, last_name, first_name, title, extra_values
       FROM position_pii
      WHERE position_id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(sourceId, sourceScope.ou) as Record<string, unknown> | undefined;
  if (!pii) return;

  prepared(
    deps.valuesDb,
    `INSERT INTO position_pii (
       position_id, ou, scenario_id, hiring_date, emp_number, last_name,
       first_name, title, extra_values, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
     ON CONFLICT(position_id) DO NOTHING`
  ).run(
    targetId,
    target.scope.ou,
    target.scenarioId,
    pii.hiring_date ?? null,
    pii.emp_number ?? null,
    pii.last_name ?? null,
    pii.first_name ?? null,
    pii.title ?? null,
    deps.stamp
  );

  const extras = translateExtras(
    parseJson(pii.extra_values),
    target,
    skips,
    "PII_EXTRA"
  );
  if (Object.keys(extras).length > 0) {
    applyUpdate(
      deps.valuesDb,
      "position_pii",
      "position_id",
      targetId,
      target.scope,
      splitPiiFields(extras, target.lookup),
      deps.stamp
    );
  }
}

/** Block inputs — the fuzzy half. Each value's definition is translated into
 *  the target hotel's own block, or reported as a skip and left out. */
function copyComponentValues(
  deps: SyncDeps,
  sourceScope: OuScope,
  sourceId: string,
  targetId: string,
  target: SyncTarget,
  skips: ClusterSyncSkip[]
): void {
  const values = prepared(
    deps.valuesDb,
    `SELECT component_def_id, rate, yearly_value, monthly_values, qty, unit_rate,
            ss_opening_base, account_code, stats_account_code
       FROM component_values
      WHERE position_id = ? AND ou = ? AND deleted_at IS NULL`
  ).all(sourceId, sourceScope.ou) as Array<Record<string, unknown>>;

  for (const value of values) {
    const translated = target.translator.defId(String(value.component_def_id));
    if (!translated.id) {
      skips.push(translated.skip);
      continue;
    }
    prepared(
      deps.valuesDb,
      `INSERT INTO component_values (
         position_id, component_def_id, ou, scenario_id, rate, yearly_value,
         monthly_values, qty, unit_rate, ss_opening_base, account_code,
         stats_account_code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(position_id, component_def_id) DO UPDATE SET
         rate = excluded.rate,
         yearly_value = excluded.yearly_value,
         monthly_values = excluded.monthly_values,
         qty = excluded.qty,
         unit_rate = excluded.unit_rate,
         ss_opening_base = excluded.ss_opening_base,
         account_code = excluded.account_code,
         stats_account_code = excluded.stats_account_code,
         updated_at = excluded.updated_at,
         deleted_at = NULL`
    ).run(
      targetId,
      translated.id,
      target.scope.ou,
      target.scenarioId,
      value.rate ?? null,
      value.yearly_value ?? null,
      value.monthly_values ?? null,
      value.qty ?? null,
      value.unit_rate ?? null,
      value.ss_opening_base ?? null,
      value.account_code ?? null,
      value.stats_account_code ?? null,
      deps.stamp
    );
  }
}

// ---------------------------------------------------------------------------
// Propagate
// ---------------------------------------------------------------------------

/** Keep only the fields that travel, translating USER keys for this hotel. */
function translatePatch(
  fields: Record<string, unknown>,
  sourceLookup: FieldLookup,
  target: SyncTarget,
  skips: ClusterSyncSkip[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const sourceDef = sourceLookup.get(key);
    // Vector names ("seasonality") are not catalog keys but are always synced.
    if (!sourceDef) {
      if (key === "seasonality" || key === "additionalMonthlyCosts" ||
          key === "vacationMonthlyWeights") {
        out[key] = value;
      }
      continue;
    }
    if (sourceDef.origin === "SYSTEM") {
      if (!syncsByKey(sourceDef)) continue;
      if (!target.lookup.has(key)) continue;
      out[key] = value;
      continue;
    }
    const translated = target.translator.fieldKey(key);
    if (!translated.id) {
      skips.push(translated.skip);
      continue;
    }
    if (!target.lookup.has(translated.id)) continue;
    out[translated.id] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The batch-write entry point
// ---------------------------------------------------------------------------

/** State of a touched row BEFORE the batch ran — captured by batchWrite so an
 *  assignment change (none → cluster, cluster → other, cluster → none) is
 *  detectable after the fact. */
export interface RowBefore {
  cluster: string;
  clusterLinkId: string;
}

export interface ClusterSyncInput {
  sourceScope: OuScope;
  scenarioId: string;
  before: Map<string, RowBefore>;
  /** Catalog-keyed patches applied to each row in this batch (creates and
   *  patches merged), used verbatim as the propagation payload. */
  positionFields: Map<string, Record<string, unknown>>;
  piiFields: Map<string, Record<string, unknown>>;
  componentPatches: ComponentValuePatch[];
  softDeleteIds: readonly string[];
  restoreIds: readonly string[];
  sourceLookup: FieldLookup;
}

/**
 * Run every cluster-position effect for one batch write. Called from inside
 * batchWrite's transaction, so a mirrored row can never half-exist: either the
 * user's edit and all of its sibling effects land, or none do.
 */
export function runClusterSync(
  deps: SyncDeps,
  input: ClusterSyncInput
): ClusterSyncResult {
  const { sourceScope, scenarioId } = input;
  const year = scenarioYear(deps.structureDb, sourceScope, scenarioId);
  if (year === null) return EMPTY_CLUSTER_SYNC;
  // Rule 1: what-if scenarios keep to themselves.
  if (!isPlanningScenario(deps.structureDb, sourceScope, scenarioId, year)) {
    return EMPTY_CLUSTER_SYNC;
  }

  const touched = new Set<string>([
    ...input.positionFields.keys(),
    ...input.piiFields.keys(),
    ...input.componentPatches.map((patch) => patch.positionId),
    ...input.softDeleteIds,
    ...input.restoreIds,
  ]);
  if (touched.size === 0) return EMPTY_CLUSTER_SYNC;

  const results: ClusterSyncResult[] = [];
  const targetCache = new Map<string, SyncTarget[]>();
  const targetsFor = (clusterId: string): SyncTarget[] => {
    let targets = targetCache.get(clusterId);
    if (!targets) {
      targets = resolveTargets(deps, clusterId, sourceScope.ou, year);
      targetCache.set(clusterId, targets);
    }
    return targets;
  };

  for (const id of touched) {
    const after = prepared(
      deps.valuesDb,
      `SELECT cluster, cluster_link_id, deleted_at FROM positions
        WHERE id = ? AND ou = ?`
    ).get(id, sourceScope.ou) as
      | { cluster: string; cluster_link_id: string; deleted_at: string | null }
      | undefined;
    if (!after) continue;

    const before = input.before.get(id) ?? { cluster: "", clusterLinkId: "" };

    // ── Deletes and restores travel first: a deleted row has nothing to sync ──
    if (input.softDeleteIds.includes(id) && after.cluster_link_id) {
      results.push(cascade(deps, after.cluster_link_id, id, "DELETE"));
      continue;
    }
    if (input.restoreIds.includes(id) && after.cluster_link_id) {
      results.push(cascade(deps, after.cluster_link_id, id, "RESTORE"));
      continue;
    }
    if (after.deleted_at) continue;

    const assignmentChanged = before.cluster !== after.cluster;

    // ── Left a cluster (cleared, or switched away) → unlink the old group ──
    if (assignmentChanged && before.clusterLinkId) {
      results.push(unlink(deps, before.clusterLinkId, id));
    }

    // ── Not in a cluster: nothing further ──
    if (!after.cluster) {
      if (after.cluster_link_id) clearLink(deps, sourceScope, id);
      continue;
    }

    // ── Joined a cluster (or switched to another) → mint a group, mirror out ──
    let linkId = after.cluster_link_id;
    if (assignmentChanged || !linkId) {
      linkId = newId(deps);
      prepared(
        deps.valuesDb,
        `UPDATE positions SET cluster_link_id = ?, updated_at = ?
          WHERE id = ? AND ou = ?`
      ).run(linkId, deps.stamp, id, sourceScope.ou);

      const created: ClusterSyncResult = {
        created: [],
        unlinked: 0,
        propagated: 0,
        skips: [],
      };
      for (const target of targetsFor(after.cluster)) {
        const result = materializeInto(deps, sourceScope, id, linkId, target);
        if (result.created) created.created.push(result.created);
        created.skips.push(...result.skips);
      }
      results.push(created);
      continue;
    }

    // ── Ordinary edit to a linked row → push it to the siblings ──
    results.push(
      propagate(deps, input, id, linkId, targetsFor(after.cluster))
    );
  }

  return mergeClusterSync(results);
}

function propagate(
  deps: SyncDeps,
  input: ClusterSyncInput,
  sourceId: string,
  linkId: string,
  targets: readonly SyncTarget[]
): ClusterSyncResult {
  const result: ClusterSyncResult = {
    created: [],
    unlinked: 0,
    propagated: 0,
    skips: [],
  };

  const positionFields = input.positionFields.get(sourceId) ?? {};
  const piiFields = input.piiFields.get(sourceId) ?? {};
  const componentPatches = input.componentPatches.filter(
    (patch) => patch.positionId === sourceId
  );
  if (
    Object.keys(positionFields).length === 0 &&
    Object.keys(piiFields).length === 0 &&
    componentPatches.length === 0
  ) {
    return result;
  }

  const siblings = siblingsIn(deps.valuesDb, linkId, targets, sourceId);
  // A member hotel with no sibling row yet (cluster gained a hotel while this
  // group already existed, or a row was deleted there): mirror it now rather
  // than leaving the group permanently short a hotel.
  const covered = new Set(siblings.map((sibling) => sibling.ou));
  for (const target of targets) {
    if (covered.has(target.scope.ou)) continue;
    const made = materializeInto(deps, input.sourceScope, sourceId, linkId, target);
    if (made.created) result.created.push(made.created);
    result.skips.push(...made.skips);
  }

  for (const sibling of siblings) {
    const { target } = sibling;
    let touched = 0;

    const fields = translatePatch(
      positionFields,
      input.sourceLookup,
      target,
      result.skips
    );
    if (Object.keys(fields).length > 0) {
      touched += applyUpdate(
        deps.valuesDb,
        "positions",
        "id",
        sibling.id,
        target.scope,
        splitPositionFields(fields, target.lookup),
        deps.stamp
      );
    }

    const pii = translatePatch(piiFields, input.sourceLookup, target, result.skips);
    if (Object.keys(pii).length > 0) {
      prepared(
        deps.valuesDb,
        `INSERT INTO position_pii (position_id, ou, scenario_id, updated_at)
         SELECT id, ou, scenario_id, ? FROM positions
          WHERE id = ? AND ou = ?
         ON CONFLICT(position_id) DO NOTHING`
      ).run(deps.stamp, sibling.id, target.scope.ou);
      touched += applyUpdate(
        deps.valuesDb,
        "position_pii",
        "position_id",
        sibling.id,
        target.scope,
        splitPiiFields(pii, target.lookup),
        deps.stamp
      );
    }

    for (const patch of componentPatches) {
      const translated = target.translator.defId(patch.componentDefId);
      if (!translated.id) {
        result.skips.push(translated.skip);
        continue;
      }
      touched += writeComponentValue(
        deps,
        sibling.id,
        translated.id,
        target,
        patch.fields
      );
    }

    if (touched > 0) result.propagated += 1;
  }

  return result;
}

/** Mirror of the component-value lane of batchWrite, bound to a sibling. */
function writeComponentValue(
  deps: SyncDeps,
  positionId: string,
  componentDefId: string,
  target: SyncTarget,
  fields: ComponentValuePatch["fields"]
): number {
  const COLUMNS: Record<string, string> = {
    rate: "rate",
    yearlyValue: "yearly_value",
    monthlyValues: "monthly_values",
    qty: "qty",
    unitRate: "unit_rate",
    ssOpeningBase: "ss_opening_base",
    accountCode: "account_code",
    // Department codes are global reference data (no ou column), so a per-row
    // booking override means the same thing in every member hotel.
    departmentCode: "department_code",
    statsAccountCode: "stats_account_code",
  };
  const entries = Object.entries(fields ?? {}).filter(
    ([key, value]) => value !== undefined && COLUMNS[key]
  );
  if (entries.length === 0) return 0;

  prepared(
    deps.valuesDb,
    `INSERT INTO component_values (position_id, component_def_id, ou, scenario_id, updated_at)
     SELECT id, ?, ou, scenario_id, ? FROM positions
      WHERE id = ? AND ou = ? AND scenario_id = ? AND deleted_at IS NULL
     ON CONFLICT(position_id, component_def_id) DO NOTHING`
  ).run(
    componentDefId,
    deps.stamp,
    positionId,
    target.scope.ou,
    target.scenarioId
  );

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    sets.push(`${COLUMNS[key]} = ?`);
    params.push(
      key === "monthlyValues" && Array.isArray(value)
        ? JSON.stringify(value)
        : (value as unknown)
    );
  }
  return prepared(
    deps.valuesDb,
    `UPDATE component_values SET ${sets.join(", ")}, updated_at = ?, deleted_at = NULL
      WHERE position_id = ? AND component_def_id = ? AND ou = ?`
  ).run(...params, deps.stamp, positionId, componentDefId, target.scope.ou).changes;
}

// ---------------------------------------------------------------------------
// Unlink / cascade
// ---------------------------------------------------------------------------

function clearLink(deps: SyncDeps, scope: OuScope, id: string): void {
  prepared(
    deps.valuesDb,
    `UPDATE positions SET cluster_link_id = '', updated_at = ?
      WHERE id = ? AND ou = ?`
  ).run(deps.stamp, id, scope.ou);
}

/**
 * Break a group up, leaving every other hotel's row in place as an ordinary
 * standalone position.
 *
 * Deliberately keeps the rows: the user cleared ONE row's cluster, which is a
 * statement about that row. Destroying three hotels' cost data as a side effect
 * of a cell edit is not a recoverable mistake.
 */
function unlink(deps: SyncDeps, linkId: string, exceptId: string): ClusterSyncResult {
  const siblings = allSiblings(deps.valuesDb, linkId, exceptId);
  for (const sibling of siblings) {
    prepared(
      deps.valuesDb,
      `UPDATE positions
          SET cluster = '', cluster_link_id = '', cluster_multiplier_override = NULL,
              updated_at = ?
        WHERE id = ? AND ou = ?`
    ).run(deps.stamp, sibling.id, sibling.ou);
  }
  return { created: [], unlinked: siblings.length, propagated: 0, skips: [] };
}

/**
 * Delete or restore every other row of the group.
 *
 * Group-wide rather than target-scoped: the confirmation the user answered says
 * which hotels are affected, and a row in a hotel that has since left the
 * cluster has already been unlinked, so it is not reachable here.
 */
function cascade(
  deps: SyncDeps,
  linkId: string,
  exceptId: string,
  mode: "DELETE" | "RESTORE"
): ClusterSyncResult {
  const siblings = allSiblings(deps.valuesDb, linkId, exceptId);
  const deletedAt = mode === "DELETE" ? deps.stamp : null;
  const guard = mode === "DELETE" ? "deleted_at IS NULL" : "deleted_at IS NOT NULL";
  let propagated = 0;

  for (const sibling of siblings) {
    propagated += prepared(
      deps.valuesDb,
      `UPDATE positions SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND ou = ? AND ${guard}`
    ).run(deletedAt, deps.stamp, sibling.id, sibling.ou).changes;
    // Both sidecars key on position_id and carry their own deleted_at.
    for (const table of ["position_pii", "component_values"] as const) {
      prepared(
        deps.valuesDb,
        `UPDATE ${table} SET deleted_at = ?, updated_at = ?
          WHERE position_id = ? AND ou = ? AND ${guard}`
      ).run(deletedAt, deps.stamp, sibling.id, sibling.ou);
    }
  }

  return { created: [], unlinked: 0, propagated, skips: [] };
}

// ---------------------------------------------------------------------------
// Membership changes (called from the cluster save handler)
// ---------------------------------------------------------------------------

/**
 * Reconcile every cluster-position group of one cluster after its member list
 * changed.
 *
 *   hotel added    each existing group mirrors into it (that IS the point of
 *                  adding a hotel to a cluster)
 *   hotel removed  its rows are unlinked and left standalone — never deleted.
 *                  Editing a weight table must not be able to destroy a hotel's
 *                  budgeted cost.
 *
 * Runs per budget year, since a group exists per year (see the header note on
 * link ids surviving a roll-forward).
 */
export function syncClusterMembership(
  deps: SyncDeps,
  clusterId: string
): ClusterSyncResult {
  const cluster = listClusters(deps.structureDb).find((c) => c.id === clusterId);
  if (!cluster) return EMPTY_CLUSTER_SYNC;
  const memberOus = new Set(cluster.members.map((member) => member.ou));

  const rows = prepared(
    deps.valuesDb,
    `SELECT id, ou, scenario_id, cluster_link_id FROM positions
      WHERE cluster = ? AND deleted_at IS NULL`
  ).all(clusterId) as Array<SiblingRow & { cluster_link_id: string }>;

  const results: ClusterSyncResult[] = [];

  // ── Hotels that left: unlink their rows, clear the assignment ──
  for (const row of rows) {
    if (memberOus.has(row.ou)) continue;
    prepared(
      deps.valuesDb,
      `UPDATE positions
          SET cluster = '', cluster_link_id = '', cluster_multiplier_override = NULL,
              updated_at = ?
        WHERE id = ? AND ou = ?`
    ).run(deps.stamp, row.id, row.ou);
    results.push({ created: [], unlinked: 1, propagated: 0, skips: [] });
  }

  // ── Hotels that joined: back-fill from one seed row per group ──
  const seeds = new Map<string, SiblingRow & { cluster_link_id: string }>();
  for (const row of rows) {
    if (!row.cluster_link_id || !memberOus.has(row.ou)) continue;
    // Any surviving member row can seed the mirror; they are kept in sync, so
    // the first one encountered is as good as any.
    if (!seeds.has(row.cluster_link_id)) seeds.set(row.cluster_link_id, row);
  }

  for (const [linkId, seed] of seeds) {
    let scope: OuScope;
    try {
      scope = resolveOuScope(seed.ou);
    } catch {
      continue;
    }
    const year = scenarioYear(deps.structureDb, scope, seed.scenario_id);
    if (year === null) continue;
    if (!isPlanningScenario(deps.structureDb, scope, seed.scenario_id, year)) {
      continue;
    }
    const result: ClusterSyncResult = {
      created: [],
      unlinked: 0,
      propagated: 0,
      skips: [],
    };
    for (const target of resolveTargets(deps, clusterId, scope.ou, year)) {
      const made = materializeInto(deps, scope, seed.id, linkId, target);
      if (made.created) result.created.push(made.created);
      result.skips.push(...made.skips);
    }
    results.push(result);
  }

  return mergeClusterSync(results);
}

/**
 * Adopt a standalone row into an existing group — the "we already created this
 * person by hand in all three hotels" fix, offered from the Clusters screen.
 *
 * Adds the link and then pushes the group's current shared values onto the row,
 * so adopting converges the duplicate rather than leaving two versions of the
 * truth. Its block inputs and user columns are left alone: those are the parts
 * that legitimately differ per hotel.
 */
export function adoptIntoGroup(
  deps: SyncDeps,
  linkId: string,
  adopteeId: string,
  adopteeOu: string
): void {
  const scope = resolveOuScope(adopteeOu);
  const seed = prepared(
    deps.valuesDb,
    `SELECT id, ou, cluster FROM positions
      WHERE cluster_link_id = ? AND deleted_at IS NULL
      ORDER BY id LIMIT 1`
  ).get(linkId) as { id: string; ou: string; cluster: string } | undefined;
  if (!seed) throw new Error("That cluster position no longer exists.");

  const adoptee = prepared(
    deps.valuesDb,
    `SELECT scenario_id FROM positions
      WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(adopteeId, scope.ou) as { scenario_id?: string } | undefined;
  if (!adoptee?.scenario_id) throw new Error("That position no longer exists.");

  prepared(
    deps.valuesDb,
    `UPDATE positions SET cluster_link_id = ?, cluster = ?, updated_at = ?
      WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).run(linkId, seed.cluster, deps.stamp, adopteeId, scope.ou);

  const sourceScope = resolveOuScope(seed.ou);
  const target: SyncTarget = {
    scope,
    scenarioId: adoptee.scenario_id,
    translator: buildTranslator(deps.structureDb, seed.ou, scope.ou),
    lookup: fieldLookup(deps.structureDb, scope),
  };
  const skips: ClusterSyncSkip[] = [];

  // Copy the shared columns off the seed row, straight across — these are the
  // engine columns the group agrees on (fte and the multiplier are excluded by
  // COPIED_POSITION_COLUMNS, and cluster is set above).
  prepared(
    deps.valuesDb,
    `UPDATE positions AS target
        SET (${COPIED_POSITION_COLUMNS}, updated_at) = (
              SELECT ${COPIED_POSITION_COLUMNS}, ?
                FROM positions AS seed
               WHERE seed.id = ? AND seed.ou = ?)
      WHERE target.id = ? AND target.ou = ?`
  ).run(deps.stamp, seed.id, sourceScope.ou, adopteeId, scope.ou);

  copyPii(deps, sourceScope, seed.id, adopteeId, target, skips);
}
