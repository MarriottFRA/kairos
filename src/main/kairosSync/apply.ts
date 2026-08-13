/**
 * Pulled entities → local rows.
 * -----------------------------------------------------------
 * The inverse of `collect.ts`. Takes a page of `/changes` (or the PII stream,
 * which is the same shape with a different envelope) and writes it into the two
 * local stores.
 *
 * ## Order
 *
 * The server sends `applyOrder` on `/sync/heads` rather than us hard-coding it,
 * precisely so the two cannot disagree about whether a component value may land
 * before its position. Entities are grouped by type and applied in that order;
 * an unrecognised type is skipped rather than guessed at, because a future
 * server that adds one is not a reason for this client to write rows it does not
 * understand into tables it does not know about.
 *
 * ## Deletes
 *
 * A tombstone from the server sets `deleted_at` — it does not remove the row.
 * The local stores are soft-delete throughout (Settings → Storage cleanup is the
 * only thing that hard-deletes), and a hard delete here would break the
 * `lineage_id` history that carries a role from one budget year to the next.
 *
 * ## Writes are one transaction per page
 *
 * A half-applied page with a recorded watermark is unrecoverable — the missing
 * rows never appear in a future delta. The watermark is written by `pull.ts`
 * only after the last page, and each page lands atomically here.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { prepared } from "../positions/stmtCache";
import {
  ENTITY_SPECS,
  PublishedEntityType,
  Row,
  isPublishedType,
} from "../../shared/kairosSync/entityMap";
import { ChangeEntity } from "../../shared/kairosSync/protocol";

type Db = InstanceType<typeof Database>;

/** The columns that identify a row, per type — the ON CONFLICT target. */
const KEY_COLUMNS: Record<PublishedEntityType, string[]> = {
  scenario: ["id"],
  position: ["id"],
  position_pii: ["position_id"],
  component_value: ["position_id", "component_def_id"],
  buyout_row: ["id"],
  manual_input_row: ["id"],
  engine_run: ["ou", "scenario_id"],
};

const TABLES: Record<PublishedEntityType, string> = {
  scenario: "scenarios",
  position: "positions",
  position_pii: "position_pii",
  component_value: "component_values",
  buyout_row: "buyout_rows",
  manual_input_row: "manual_input_rows",
  engine_run: "engine_runs",
};

/** Which store each type lives in — the same split as `collect.ts`. */
const SECURE_TYPES: ReadonlySet<PublishedEntityType> = new Set([
  "position",
  "position_pii",
  "component_value",
  "buyout_row",
  "manual_input_row",
  "engine_run",
]);

export interface ApplyDeps {
  localDb: Db;
  secureDb: Db;
}

export interface ApplyResult {
  applied: number;
  deleted: number;
  /** Types the server sent that this client version does not know. */
  skippedTypes: string[];
  /**
   * Rows put aside because their parent position is not in the store yet.
   *
   * Only with `deferMissingParents`, and only the two types whose FK points at
   * `positions(id)`. `/changes` orders rows by server sequence, not by type, and
   * a page boundary can therefore land a component value a page ahead of the
   * position it belongs to — each page commits its own transaction, so "later
   * this page" is not enough. The caller retries these after the last page,
   * when every position that is coming has arrived.
   */
  deferred: ChangeEntity[];
}

/**
 * Build the upsert for one type, once, from the shape of a mapped row.
 *
 * SQL is derived from the row's own keys rather than written out per table:
 * seven near-identical INSERT … ON CONFLICT statements would be seven places to
 * forget a column when the schema next gains one, and the mapping in
 * `entityMap.ts` is already the single list of what a row consists of.
 */
function upsertSql(entityType: PublishedEntityType, columns: string[]): string {
  const keys = KEY_COLUMNS[entityType];
  const updatable = columns.filter((column) => !keys.includes(column));
  const assignments = updatable
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  return `
    INSERT INTO ${TABLES[entityType]} (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
    ON CONFLICT(${keys.join(", ")}) DO UPDATE SET ${assignments}
  `;
}

/**
 * Apply one page of entities.
 *
 * `order` is the server's `applyOrder`. Types outside it are appended in the
 * order they arrived rather than dropped — a type the server knows and did not
 * list is still a type we can write, and the dependency question only arises for
 * the two that name a parent.
 */
export function applyEntities(
  deps: ApplyDeps,
  entities: ChangeEntity[],
  order: readonly string[],
  opts?: { deferMissingParents?: boolean }
): ApplyResult {
  const byType = new Map<string, ChangeEntity[]>();
  for (const entity of entities) {
    const bucket = byType.get(entity.entityType);
    if (bucket) bucket.push(entity);
    else byType.set(entity.entityType, [entity]);
  }

  const ordered = [
    ...order.filter((type) => byType.has(type)),
    ...[...byType.keys()].filter((type) => !order.includes(type)),
  ];

  const result: ApplyResult = { applied: 0, deleted: 0, skippedTypes: [], deferred: [] };
  const localWork: Array<() => void> = [];
  const secureWork: Array<() => void> = [];

  for (const type of ordered) {
    if (!isPublishedType(type)) {
      result.skippedTypes.push(type);
      continue;
    }
    const db = SECURE_TYPES.has(type) ? deps.secureDb : deps.localDb;
    const queue = SECURE_TYPES.has(type) ? secureWork : localWork;
    const spec = ENTITY_SPECS[type];

    for (const entity of byType.get(type) ?? []) {
      // A tombstone with no payload still has to land: the only way to record
      // "this row is dead" is to write deleted_at on the row we already hold.
      if (entity.payload === null) {
        if (entity.deleted) {
          queue.push(() => markDeleted(db, type, entity.entityId));
          result.deleted += 1;
        }
        continue;
      }

      const row = spec.fromPayload(entity.payload);
      // The server's `deleted` flag is authoritative over whatever the payload's
      // own deletedAt happens to say — a purge carries a stale payload.
      if (entity.deleted && row.deleted_at == null) {
        row.deleted_at = entity.clientUpdatedAt ?? new Date().toISOString();
      }
      if (entity.deleted) result.deleted += 1;
      else result.applied += 1;

      queue.push(() => {
        try {
          upsertRow(db, type, row);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            opts?.deferMissingParents === true &&
            /FOREIGN KEY/i.test(message) &&
            missingParentPositionId(db, type, entity) !== null
          ) {
            // Not lost, not counted: the caller re-applies these after the
            // last page, once the parent has had every chance to arrive.
            if (entity.deleted) result.deleted -= 1;
            else result.applied -= 1;
            result.deferred.push(entity);
            return;
          }
          throw describeApplyFailure(db, error, type, entity);
        }
      });
    }
  }

  // One transaction per store. Two rather than one because the stores are
  // separate SQLite files with no shared transaction; the pull is re-runnable
  // from the same watermark, so a crash between them costs a repeat, not data.
  if (localWork.length > 0) {
    deps.localDb.transaction(() => localWork.forEach((run) => run()))();
  }
  if (secureWork.length > 0) {
    deps.secureDb.transaction(() => secureWork.forEach((run) => run()))();
  }

  return result;
}

/**
 * Turn a bare SQLite error into one that names the row it died on.
 *
 * "FOREIGN KEY constraint failed" reaches the Sync page with no way to tell
 * WHICH of ten thousand rows was the problem, and the only two FKs on this
 * path both point at `positions(id)` — so when that is the failure, look the
 * parent up and say whether it is missing or merely arrived after its
 * children. The full detail also goes to the main-process console, which is
 * where a dev build's terminal shows it.
 */
function describeApplyFailure(
  db: Db,
  error: unknown,
  entityType: PublishedEntityType,
  entity: ChangeEntity
): Error {
  const message = error instanceof Error ? error.message : String(error);
  let diagnosis = "";
  if (
    /FOREIGN KEY/i.test(message) &&
    (entityType === "component_value" || entityType === "position_pii")
  ) {
    const missing = missingParentPositionId(db, entityType, entity);
    diagnosis =
      missing !== null
        ? ` Its position ${missing} is not on this computer — ` +
          "the server sent this row without its parent position."
        : " Its position exists locally, so the failure is on another key.";
  }
  console.error("[kairosSync] apply failed", {
    entityType,
    entityId: entity.entityId,
    department: entity.department,
    deleted: entity.deleted,
    serverSeq: entity.serverSeq,
    sqlite: message,
    diagnosis: diagnosis.trim(),
  });
  return new Error(
    `Could not write ${entityType} ${entity.entityId}` +
      (entity.department ? ` (department ${entity.department})` : "") +
      `: ${message}.${diagnosis}`
  );
}

/**
 * The id of the parent position a child row needs and the store lacks, or null
 * when it is present (or the type has no parent).
 *
 * Both FKs on this path point at `positions(id)`: `component_value` carries the
 * parent in the first half of its composite id, `position_pii` IS the parent id.
 * A soft-deleted parent still satisfies the constraint, so no deleted_at filter.
 */
function missingParentPositionId(
  db: Db,
  entityType: PublishedEntityType,
  entity: ChangeEntity
): string | null {
  let positionId: string;
  if (entityType === "component_value") {
    const cut = entity.entityId.indexOf(":");
    if (cut <= 0) return null;
    positionId = entity.entityId.slice(0, cut);
  } else if (entityType === "position_pii") {
    positionId = entity.entityId;
  } else {
    return null;
  }
  const held =
    prepared(db, `SELECT 1 FROM positions WHERE id = ?`).get(positionId) !== undefined;
  return held ? null : positionId;
}

function upsertRow(db: Db, entityType: PublishedEntityType, row: Row): void {
  const columns = Object.keys(row);
  prepared(db, upsertSql(entityType, columns)).run(
    ...(columns.map((column) => row[column]) as never[])
  );
}

/**
 * Mark a row deleted without a payload to rebuild it from.
 *
 * Soft delete, and only if we hold the row — inserting a stub for a tombstone we
 * never had would create a phantom row keyed on nothing, which the next
 * manifest would then report as a difference forever.
 */
function markDeleted(db: Db, entityType: PublishedEntityType, entityId: string): void {
  const keys = KEY_COLUMNS[entityType];
  const values = splitEntityId(entityType, entityId);
  if (values.length !== keys.length) return;

  const where = keys.map((column) => `${column} = ?`).join(" AND ");
  const table = TABLES[entityType];
  // engine_runs has no deleted_at — it is a single metadata row per scenario,
  // rewritten wholesale by each recalculation, so a tombstone deletes it.
  const sql =
    entityType === "engine_run"
      ? `DELETE FROM ${table} WHERE ${where}`
      : `UPDATE ${table} SET deleted_at = COALESCE(deleted_at, ?) WHERE ${where}`;

  const args =
    entityType === "engine_run" ? values : [new Date().toISOString(), ...values];
  prepared(db, sql).run(...(args as never[]));
}

/**
 * Recover a row's key columns from its entity id.
 *
 * Only two types have a composite key on the wire: `component_value` is
 * `"{positionId}:{componentDefId}"`, and `engine_run` is keyed `(ou, scenario)`
 * locally but published under the scenario id alone — so it cannot be located
 * from the id and is handled by the caller passing an OU-scoped delete instead.
 */
function splitEntityId(entityType: PublishedEntityType, entityId: string): string[] {
  if (entityType === "component_value") {
    const cut = entityId.indexOf(":");
    if (cut < 0) return [];
    return [entityId.slice(0, cut), entityId.slice(cut + 1)];
  }
  if (entityType === "engine_run") {
    // Needs (ou, scenario_id) and we only have the scenario id. A tombstone for
    // a recalculation is meaningless anyway — the local engine reproduces it —
    // so this is deliberately a no-op rather than a guess at the OU.
    return [];
  }
  return [entityId];
}
