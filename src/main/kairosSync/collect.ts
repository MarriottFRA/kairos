/**
 * Local rows → publishable entities.
 * -----------------------------------------------------------
 * Reads one plan out of both stores, maps every row through `entityMap`, hashes
 * it, and compares against the shadow to decide what actually needs sending.
 *
 * Three things this has to get right, and each of them is a bug the protocol
 * cannot recover from on its own:
 *
 *   1. **Soft-deleted rows are published, not skipped.** A row with `deleted_at`
 *      set is a tombstone the server must learn about; dropping it means every
 *      other client keeps a row its owner deleted. The delete travels as
 *      `deleted: true` with a payload, exactly like any other update.
 *   2. **Positions sort before their children.** The server sorts positions
 *      first *within* a chunk, but a child whose parent lands in a LATER chunk
 *      is an `ORPHAN_ENTITY`. Ordering here is what keeps the chunker honest.
 *   3. **A delegate filters before sending.** They could publish everything and
 *      let the server reject what is out of scope, and it would be safe — but
 *      the result is a wall of `STRUCTURE_OWNER_ONLY` and
 *      `DEPARTMENT_OUT_OF_SCOPE` rejections that looks exactly like a failed
 *      save. Filtering here means a delegate's save reports what it did.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { prepared } from "../positions/stmtCache";
import { contentHash } from "./hash";
import { ShadowRow, shadowKey } from "./repo";
import { CommitEntity } from "../../shared/kairosSync/protocol";
import {
  INHERITED_ENTITY_TYPES,
  PublishedEntityType,
  Row,
  toEntity,
} from "../../shared/kairosSync/entityMap";

type Db = InstanceType<typeof Database>;

/** A local row, mapped and hashed, before any decision about sending it. */
export interface LocalEntity {
  entityType: PublishedEntityType;
  entityId: string;
  parentId: string | null;
  /** For inherited types this is the PARENT's department, resolved locally. */
  department: string | null;
  deleted: boolean;
  clientUpdatedAt: string | null;
  hash: string;
  payload: Record<string, unknown>;
}

/**
 * The publish order. Positions ahead of the two types that name a parent, and
 * `scenario` ahead of everything so a first publish creates the plan's own row
 * before anything hangs off it.
 */
export const PUBLISH_ORDER: readonly PublishedEntityType[] = [
  "scenario",
  "position",
  "position_pii",
  "component_value",
  "buyout_row",
  "manual_input_row",
  "engine_run",
];

/** Which store each type lives in. */
const SECURE_TYPES: ReadonlySet<PublishedEntityType> = new Set([
  "position",
  "position_pii",
  "component_value",
  "buyout_row",
  "manual_input_row",
  "engine_run",
]);

const SELECTS: Record<PublishedEntityType, string> = {
  scenario: `SELECT * FROM scenarios WHERE id = ? AND ou = ?`,
  position: `SELECT * FROM positions WHERE ou = ? AND scenario_id = ?`,
  position_pii: `SELECT * FROM position_pii WHERE ou = ? AND scenario_id = ?`,
  component_value: `SELECT * FROM component_values WHERE ou = ? AND scenario_id = ?`,
  buyout_row: `SELECT * FROM buyout_rows WHERE ou = ? AND scenario_id = ?`,
  manual_input_row: `SELECT * FROM manual_input_rows WHERE ou = ? AND scenario_id = ?`,
  engine_run: `SELECT * FROM engine_runs WHERE ou = ? AND scenario_id = ?`,
};

export interface CollectDeps {
  /** The plaintext store — holds `scenarios`. */
  localDb: Db;
  /** The encrypted store — holds everything else. */
  secureDb: Db;
}

export interface CollectOptions {
  ou: string;
  /** The scenario id, which is also the plan id. */
  planId: string;
  /** Skip `position_pii` entirely — the property has personal-data storage off. */
  includePii?: boolean;
}

function rowsFor(
  deps: CollectDeps,
  entityType: PublishedEntityType,
  ou: string,
  planId: string
): Row[] {
  const db = SECURE_TYPES.has(entityType) ? deps.secureDb : deps.localDb;
  const sql = SELECTS[entityType];
  // `scenarios` is keyed by its own id; everything else by (ou, scenario_id).
  const args: unknown[] = entityType === "scenario" ? [planId, ou] : [ou, planId];
  return prepared(db, sql).all(...(args as never[])) as Row[];
}

/**
 * Every publishable row of a plan, mapped, hashed, and in dependency order.
 *
 * Inherited rows get their department filled in from their parent position, so
 * the write-scope filter downstream can decide about them without a join. The
 * server derives the same value independently and does not read ours.
 */
export function collectLocalEntities(
  deps: CollectDeps,
  options: CollectOptions
): LocalEntity[] {
  const { ou, planId } = options;
  const includePii = options.includePii !== false;

  // Parent department lookup, built once from the positions pass.
  const departmentByPosition = new Map<string, string | null>();
  const out: LocalEntity[] = [];

  for (const entityType of PUBLISH_ORDER) {
    if (entityType === "position_pii" && !includePii) continue;

    for (const row of rowsFor(deps, entityType, ou, planId)) {
      const mapped = toEntity(entityType, row);
      if (entityType === "position") {
        departmentByPosition.set(mapped.entityId, mapped.department);
      }
      const department =
        mapped.parentId !== null
          ? departmentByPosition.get(mapped.parentId) ?? null
          : mapped.department;

      out.push({
        entityType,
        entityId: mapped.entityId,
        parentId: mapped.parentId,
        department,
        deleted: mapped.deleted,
        clientUpdatedAt: mapped.clientUpdatedAt,
        hash: contentHash(mapped.payload),
        payload: mapped.payload,
      });
    }
  }

  return out;
}

/** What a caller may write. `null` departments means all of them. */
export interface WriteScope {
  /** OWNER and ADMIN_LEASE write structure; DELEGATE does not. */
  canWriteStructure: boolean;
  /** null = every department. */
  departments: ReadonlySet<string> | null;
}

/**
 * Drop the rows this caller cannot write.
 *
 * A row with no department is plan-wide as far as authority goes — that is the
 * server's rule too, and it is why an unclassified position (`department_code`
 * defaulting to `''`) becomes owner-only rather than nobody's. The Sync page
 * surfaces those rows separately so they are visible rather than merely
 * excluded.
 */
export function filterToWriteScope(
  entities: LocalEntity[],
  scope: WriteScope
): { publishable: LocalEntity[]; withheld: LocalEntity[] } {
  const publishable: LocalEntity[] = [];
  const withheld: LocalEntity[] = [];

  for (const entity of entities) {
    const allowed =
      entity.department === null
        ? scope.canWriteStructure
        : scope.departments === null || scope.departments.has(entity.department);
    (allowed ? publishable : withheld).push(entity);
  }

  return { publishable, withheld };
}

/**
 * Turn mapped rows into the commit entities that actually need sending.
 *
 * A row whose hash already matches the shadow is skipped outright rather than
 * sent and returned as `unchanged`: the server would answer correctly either
 * way, but on a plan where two cells changed that is the difference between a
 * 400-byte request and a two-megabyte one.
 */
export function toCommitEntities(
  entities: LocalEntity[],
  shadow: Map<string, ShadowRow>
): CommitEntity[] {
  const out: CommitEntity[] = [];

  for (const entity of entities) {
    const known = shadow.get(shadowKey(entity.entityType, entity.entityId));
    if (known && known.hash === entity.hash && known.deleted === entity.deleted) {
      continue;
    }
    out.push({
      entityType: entity.entityType,
      entityId: entity.entityId,
      op: "upsert",
      parentId: entity.parentId,
      // Inherited types carry no department of their own on the wire; the server
      // derives it from the parent, and sending ours would be a second source of
      // truth for an authorization input.
      department: INHERITED_ENTITY_TYPES.has(entity.entityType)
        ? null
        : entity.department,
      baseHash: known ? known.hash : null,
      hash: entity.hash,
      deleted: entity.deleted,
      clientUpdatedAt: entity.clientUpdatedAt,
      payload: entity.payload,
    });
  }

  return out;
}

/**
 * Rows the server holds that we have hard-deleted locally.
 *
 * The 30-day tombstone cleanup in Settings removes rows outright, and a plain
 * absence is indistinguishable from "never existed" — so the server keeps
 * serving them and every client resurrects them. `op: "purge"` is how the death
 * gets recorded. Only ever emitted for rows the shadow says we published.
 */
export function purgesFor(
  entities: LocalEntity[],
  shadow: Map<string, ShadowRow>
): CommitEntity[] {
  const present = new Set(
    entities.map((entity) => shadowKey(entity.entityType, entity.entityId))
  );
  const out: CommitEntity[] = [];

  for (const [key, known] of shadow) {
    if (present.has(key) || known.deleted) continue;
    out.push({
      entityType: known.entityType,
      entityId: known.entityId,
      op: "purge",
      baseHash: known.hash,
      hash: null,
      deleted: true,
      clientUpdatedAt: null,
    });
  }

  return out;
}

/**
 * Split a commit into chunks that respect BOTH server ceilings.
 *
 * The byte budget is measured on the serialised entity, not on a guess: a
 * position with thirty custom fields in `extra_values` is many times the size of
 * a bare one, and a fixed entity count would either waste the budget or blow it.
 *
 * Order is preserved, so `PUBLISH_ORDER`'s guarantee that a parent is never in a
 * later chunk than its child survives the split. One entity larger than the
 * whole budget still gets its own chunk rather than being dropped — the server
 * will reject it as `PAYLOAD_TOO_LARGE` and say so, which is far better than it
 * vanishing silently on the client.
 */
export function chunkEntities(
  entities: CommitEntity[],
  limits: { commitMaxEntities: number; commitMaxBytes: number }
): CommitEntity[][] {
  const maxEntities = Math.max(1, limits.commitMaxEntities);
  const maxBytes = Math.max(1, limits.commitMaxBytes);

  const chunks: CommitEntity[][] = [];
  let current: CommitEntity[] = [];
  let bytes = 0;

  for (const entity of entities) {
    const size = Buffer.byteLength(JSON.stringify(entity), "utf8");
    const wouldOverflow =
      current.length >= maxEntities || (current.length > 0 && bytes + size > maxBytes);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entity);
    bytes += size;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
