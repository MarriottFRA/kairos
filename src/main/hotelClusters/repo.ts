/**
 * Hotel-clusters repository.
 *
 * Cluster definitions are CROSS-OU reference data in the plaintext structure
 * store, so — uniquely among the data repos — these functions take NO OuScope.
 * The two functions against the encrypted store below are the "separate
 * explicit multi-scope API" promised by src/main/positions/ouScope.ts: the
 * only queries in the app that read or write positions across OUs, kept
 * narrow and in this one greppable place so positionsRepo's structural
 * OU-gating stays intact.
 *
 * Every function takes the Database handle explicitly (vitest runs these
 * against in-memory databases).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { uuidv7 } from "../../shared/engine/ids";
import {
  HotelClusterDto,
  HotelClusterInput,
  HotelClusterMember,
  isValidClusterWeight,
} from "../../shared/hotelClusters/ipc";
import { normalizeOu } from "../positions/ouScope";
import { prepared } from "../positions/stmtCache";

type Db = InstanceType<typeof Database>;

interface ClusterRow {
  id: string;
  name: string;
  sort_order: number;
  updated_at: string;
}

interface MemberRow {
  cluster_id: string;
  ou: string;
  weight: number;
}

export function listClusters(db: Db): HotelClusterDto[] {
  const clusters = prepared(
    db,
    `SELECT id, name, sort_order, updated_at
       FROM hotel_clusters
      WHERE deleted_at IS NULL
      ORDER BY sort_order, id`
  ).all() as ClusterRow[];
  if (clusters.length === 0) return [];

  const members = prepared(
    db,
    `SELECT m.cluster_id, m.ou, m.weight
       FROM hotel_cluster_members m
       JOIN hotel_clusters c ON c.id = m.cluster_id
      WHERE c.deleted_at IS NULL
      ORDER BY m.sort_order, m.ou`
  ).all() as MemberRow[];

  const byCluster = new Map<string, HotelClusterMember[]>();
  for (const member of members) {
    const list = byCluster.get(member.cluster_id) ?? [];
    list.push({ ou: member.ou, weight: member.weight });
    byCluster.set(member.cluster_id, list);
  }

  return clusters.map((row) => ({
    id: row.id,
    name: row.name,
    members: byCluster.get(row.id) ?? [],
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates and canonicalizes; error strings are user-facing (blocks idiom). */
function validateInput(
  db: Db,
  input: HotelClusterInput
): { name: string; members: HotelClusterMember[] } {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A cluster name is required.");

  const clash = prepared(
    db,
    `SELECT id FROM hotel_clusters
      WHERE deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id <> ?`
  ).get(name, input.id ?? "") as { id: string } | undefined;
  if (clash) throw new Error("A cluster with this name already exists.");

  const rawMembers = Array.isArray(input.members) ? input.members : [];
  if (rawMembers.length === 0) {
    throw new Error("A cluster needs at least one hotel.");
  }

  const seen = new Set<string>();
  const members: HotelClusterMember[] = rawMembers.map((member) => {
    const ou = normalizeOu(member?.ou);
    if (!ou) {
      throw new Error(`"${String(member?.ou ?? "")}" is not a valid hotel OU.`);
    }
    if (seen.has(ou)) {
      throw new Error(`Hotel ${ou} appears more than once in the cluster.`);
    }
    seen.add(ou);
    if (!isValidClusterWeight(member?.weight)) {
      throw new Error(
        `Hotel ${ou} needs a weight between 0 (exclusive) and 1.`
      );
    }
    return { ou, weight: member.weight };
  });

  return { name, members };
}

// ---------------------------------------------------------------------------
// Mutations (plaintext store)
// ---------------------------------------------------------------------------

/**
 * Create or update a cluster. One transaction: upsert the parent, rewrite the
 * member set. INVARIANT: every member change stamps hotel_clusters.updated_at
 * — the engine-output staleness fingerprint probes MAX(updated_at) on the
 * parent table, so a weight edit that skipped the stamp would leave Results
 * silently stale-blind. Pinned by a repo test.
 */
export function saveCluster(
  db: Db,
  input: HotelClusterInput,
  opts: { now: string }
): string {
  const { name, members } = validateInput(db, input);

  const existing = input.id
    ? (prepared(
        db,
        `SELECT id, sort_order FROM hotel_clusters
          WHERE id = ? AND deleted_at IS NULL`
      ).get(input.id) as { id: string; sort_order: number } | undefined)
    : undefined;
  if (input.id && !existing) {
    throw new Error("This cluster no longer exists.");
  }

  const id = existing?.id ?? uuidv7();
  const sortOrder = existing?.sort_order ?? nextSortOrder(db);

  db.transaction(() => {
    prepared(
      db,
      `INSERT INTO hotel_clusters (id, name, sort_order, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at,
         deleted_at = NULL`
    ).run(id, name, sortOrder, opts.now);

    prepared(db, `DELETE FROM hotel_cluster_members WHERE cluster_id = ?`).run(
      id
    );
    members.forEach((member, index) => {
      prepared(
        db,
        `INSERT INTO hotel_cluster_members (cluster_id, ou, weight, sort_order)
         VALUES (?, ?, ?, ?)`
      ).run(id, member.ou, member.weight, (index + 1) * 10);
    });
  })();

  return id;
}

function nextSortOrder(db: Db): number {
  const row = prepared(
    db,
    `SELECT COALESCE(MAX(sort_order), 0) AS top FROM hotel_clusters`
  ).get() as { top: number };
  return row.top + 10;
}

/**
 * Soft-delete a cluster definition. The caller (IPC handler) is responsible
 * for clearing assignments first via clearAssignmentsAllOus — the two live in
 * different database files, so there is no single transaction across them;
 * clear-then-delete keeps the failure mode benign (assignments cleared but
 * cluster still listed beats a deleted cluster with live assignments).
 * Members are kept (a future restore needs them; ON DELETE CASCADE only fires
 * on a hard purge).
 */
export function deleteCluster(db: Db, id: string, opts: { now: string }): void {
  const result = prepared(
    db,
    `UPDATE hotel_clusters SET updated_at = ?, deleted_at = ?
      WHERE id = ? AND deleted_at IS NULL`
  ).run(opts.now, opts.now, id);
  if (result.changes === 0) {
    throw new Error("This cluster no longer exists.");
  }
}

// ---------------------------------------------------------------------------
// The explicit multi-scope API (encrypted store, ALL OUs)
// ---------------------------------------------------------------------------

export interface AssignedPositionRow {
  id: string;
  ou: string;
  scenario_id: string;
  active: number;
  headcount: number;
  department_code: string;
  cluster_multiplier_override: number | null;
  cluster_link_id: string;
  title: string | null;
}

/**
 * Assigned positions across ALL OUs for one cluster — the explicit
 * multi-scope READ. PII exposure is deliberately minimal: `title` names the
 * post, not the person (non-masked by design, see fieldSeed.ts), and nothing
 * else leaves position_pii.
 */
export function listAssignedPositionsAllOus(
  valuesDb: Db,
  clusterId: string
): AssignedPositionRow[] {
  return prepared(
    valuesDb,
    `SELECT p.id, p.ou, p.scenario_id, p.active, p.headcount,
            p.department_code, p.cluster_multiplier_override, p.cluster_link_id,
            pii.title
       FROM positions p
       LEFT JOIN position_pii pii
              ON pii.position_id = p.id AND pii.deleted_at IS NULL
      WHERE p.cluster = ? AND p.deleted_at IS NULL
      ORDER BY p.ou, p.scenario_id, p.id`
  ).all(clusterId) as AssignedPositionRow[];
}

/**
 * Clear every assignment of one cluster across ALL OUs — the explicit
 * multi-scope WRITE, used by delete (user-confirmed: deleting a cluster
 * auto-clears its positions back to no cluster / multiplier 1). Stamps
 * updated_at so the positions staleness probe catches the change.
 *
 * Also breaks up the cluster-position groups (cluster_link_id): with no cluster
 * there is nothing left to keep the rows in step, so each hotel keeps its own
 * row as an ordinary standalone position. The ROWS always survive — deleting a
 * cluster definition must never delete budgeted cost.
 */
export function clearAssignmentsAllOus(
  valuesDb: Db,
  clusterId: string,
  opts: { now: string }
): number {
  const result = prepared(
    valuesDb,
    `UPDATE positions
        SET cluster = '', cluster_multiplier_override = NULL,
            cluster_link_id = '', updated_at = ?
      WHERE cluster = ? AND deleted_at IS NULL`
  ).run(opts.now, clusterId);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Scenario metadata (plaintext store) — enrichment for the members view
// ---------------------------------------------------------------------------

export interface ScenarioMeta {
  label: string;
  year: number;
}

export function scenarioMetaById(db: Db): Map<string, ScenarioMeta> {
  const rows = prepared(
    db,
    `SELECT id, label, year FROM scenarios WHERE deleted_at IS NULL`
  ).all() as Array<{ id: string; label: string; year: number }>;
  return new Map(rows.map((row) => [row.id, { label: row.label, year: row.year }]));
}
