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
 *      `deleted: true` with a payload, exactly like any other update. The one
 *      exception is a row the server has never held — see `toCommitEntities`.
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
import {
  DepartmentWritePolicy,
  canWriteDepartment,
} from "../../shared/kairosSync/writePolicy";
import { clusterSnapshotContext, stampClusterSnapshot } from "./clusterSnapshot";

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

/** Why a local row can never be published, whoever is publishing it. */
export type UnpublishableReason = "EMPTY_KEY" | "ORPHANED_LOCALLY";

/**
 * A row that is broken here rather than refused there.
 *
 * The distinction is the whole point of the type. The server answers these with
 * `PII_KEY_MISMATCH` or `MISSING_PAYLOAD`, which the Sync page renders as a
 * refusal — and a refusal reads as "the server does not trust you", when the
 * truth is a leftover on this computer that nothing on the server could ever
 * have matched.
 */
export interface UnpublishableRow {
  entityType: PublishedEntityType;
  entityId: string;
  parentId: string | null;
  reason: UnpublishableReason;
}

export interface CollectResult {
  entities: LocalEntity[];
  /** Never sent. Reported so the user can be told, not so they can retry. */
  unpublishable: UnpublishableRow[];
  /**
   * The types actually read out of the local stores on this pass.
   *
   * `position_pii` is missing from it when the property has personal-data
   * storage switched off — and a type that was never looked at cannot support
   * the inference "the shadow has it, we do not, therefore it was deleted". See
   * `purgesFor`, which is where that inference used to destroy them.
   */
  scannedTypes: ReadonlySet<PublishedEntityType>;
}

/**
 * Plan-wide by construction, not by a missing department code.
 *
 * `scenario` and `engine_run` have `departmentOf: () => null` in `ENTITY_SPECS`:
 * they are the plan's own rows and there is no department that could ever
 * authorise them. Deciding this on the TYPE rather than on `department === null`
 * matters, because the write scope can err wide — `writeScopeFor` falls back to
 * the relation's capability when `/department-ownership` has never been cached —
 * and a wide scope must still not put a delegate's name on the plan row. That
 * combination is where the wall of `STRUCTURE_OWNER_ONLY` came from.
 */
export const PLAN_WIDE_ENTITY_TYPES: ReadonlySet<PublishedEntityType> = new Set([
  "scenario",
  "engine_run",
]);

/**
 * Every publishable row of a plan, mapped, hashed, and in dependency order.
 *
 * Inherited rows get their department filled in from their parent position, so
 * the write-scope filter downstream can decide about them without a join. The
 * server derives the same value independently and does not read ours.
 *
 * Two classes of row are dropped here rather than sent and refused. Both are
 * local damage, and both used to reach the server looking like a permission
 * problem — see `UnpublishableRow`.
 */
export function collectLocalEntities(
  deps: CollectDeps,
  options: CollectOptions
): CollectResult {
  const { ou, planId } = options;
  const includePii = options.includePii !== false;

  // Parent department lookup, built once from the positions pass.
  const departmentByPosition = new Map<string, string | null>();
  const out: LocalEntity[] = [];
  const unpublishable: UnpublishableRow[] = [];
  const scannedTypes = new Set<PublishedEntityType>();

  // The cluster definitions this machine holds — positions get their effective
  // cluster ratio stamped into the payload before hashing, so the ratio
  // travels to machines that lack the definitions. Every other site that
  // hashes a position payload stamps the same way; see clusterSnapshot.ts.
  const clusters = clusterSnapshotContext(deps.localDb);

  for (const entityType of PUBLISH_ORDER) {
    if (entityType === "position_pii" && !includePii) continue;
    scannedTypes.add(entityType);

    for (const row of rowsFor(deps, entityType, ou, planId)) {
      const mapped = toEntity(
        entityType,
        entityType === "position" ? stampClusterSnapshot(row, clusters) : row
      );
      if (entityType === "position") {
        departmentByPosition.set(mapped.entityId, mapped.department);
      }

      /**
       * An id the server cannot key on.
       *
       * `str()` in `entityMap` turns a NULL column into `""`, so this is what a
       * `position_pii` row with a null `position_id` actually looks like by the
       * time it gets here — and since its id and its parent id are the same
       * expression, both come out empty and the row reads as plan-wide.
       */
      if (mapped.entityId === "") {
        unpublishable.push({
          entityType,
          entityId: mapped.entityId,
          parentId: mapped.parentId,
          reason: "EMPTY_KEY",
        });
        continue;
      }

      const inherited = INHERITED_ENTITY_TYPES.has(entityType);
      if (inherited) {
        /**
         * `has`, not `get(...) ?? null`.
         *
         * An ABSENT parent and a parent with NO department are opposite
         * situations, and collapsing them to `null` classified an orphan as
         * plan-wide — the second half of the same bug. `PUBLISH_ORDER`
         * guarantees positions have already been walked, so a miss here really
         * does mean the parent is gone.
         */
        if (mapped.parentId === null || !departmentByPosition.has(mapped.parentId)) {
          unpublishable.push({
            entityType,
            entityId: mapped.entityId,
            parentId: mapped.parentId,
            reason: "ORPHANED_LOCALLY",
          });
          continue;
        }
      }

      const department = inherited
        ? departmentByPosition.get(mapped.parentId as string) ?? null
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

  return { entities: out, unpublishable, scannedTypes };
}

/** What a caller may write. */
export interface WriteScope {
  /** OWNER and ADMIN_LEASE write structure; DELEGATE does not. */
  canWriteStructure: boolean;
  /**
   * The department ceiling and floor — the SAME object the grid locks against,
   * derived once by `departmentWritePolicy`. Sharing it is the point: the grid
   * offering an edit this filter then withholds is a silent lost write, and it
   * is exactly what happened while the two were separately-derived flat sets.
   */
  departmentPolicy: DepartmentWritePolicy;
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
    const allowed = PLAN_WIDE_ENTITY_TYPES.has(entity.entityType)
      ? // The type decides, not the department code. See PLAN_WIDE_ENTITY_TYPES.
        scope.canWriteStructure
      : entity.department === null
        ? scope.canWriteStructure
        : canWriteDepartment(scope.departmentPolicy, entity.department);
    (allowed ? publishable : withheld).push(entity);
  }

  return { publishable, withheld };
}

export interface CommitOptions {
  /**
   * Whether "not in the shadow" may be read as "the server has never held it".
   *
   * True in every ordinary case. False only when the shadow itself is suspect —
   * an empty shadow for a plan the server has a version for, which is what a
   * rebuilt local store looks like until `rebuildShadowFromServer` has run.
   * Getting that case wrong the other way would drop a real deletion, so it
   * falls back to sending the tombstone and letting the server decide.
   */
  shadowIsComplete?: boolean;
}

/**
 * Can an absent shadow entry be read as "the server has never held this row"?
 *
 * On its own it cannot: a rebuilt local store has an empty shadow for a plan the
 * server may be full of. Paired with a base version of zero it can — there is
 * nothing there to have held anything.
 *
 * Exported because more than the publish path asks this question. The pending
 * counter behind the Sync badge asks it too, and the two disagreeing is what put
 * a plan into "needs attention" with nothing on it that a publish would send.
 */
export function shadowIsComplete(shadowSize: number, baseVersion: number): boolean {
  return shadowSize > 0 || baseVersion === 0;
}

/**
 * Would a publish carry this row?
 *
 * The single definition of "changed since the server last confirmed it", used by
 * the collector and by the pending counter. Any second copy of this comparison
 * drifts, and when it drifts the user is told they have changes to publish that
 * publishing does not clear.
 *
 * See the tombstone note on `toCommitEntities` for the `shadowIsComplete` half.
 */
export function isUnsent(
  known: ShadowRow | null | undefined,
  local: { hash: string; deleted: boolean },
  shadowIsComplete = true
): boolean {
  if (known) return known.hash !== local.hash || known.deleted !== local.deleted;
  return !(local.deleted && shadowIsComplete);
}

/**
 * Turn mapped rows into the commit entities that actually need sending.
 *
 * A row whose hash already matches the shadow is skipped outright rather than
 * sent and returned as `unchanged`: the server would answer correctly either
 * way, but on a plan where two cells changed that is the difference between a
 * 400-byte request and a two-megabyte one.
 *
 * ## A tombstone for a row the server never had says nothing
 *
 * Add a position, publish before giving it a department, delete it because it
 * was a mistake — and the delete is a soft delete, so the row is still here with
 * `deleted_at` set and still gets collected. It has no shadow entry, because the
 * publish that would have created one was rejected, so every later publish sends
 * it again and the server rejects it again: `DEPARTMENT_UNASSIGNED`, for ever,
 * on a row that no longer appears in the grid and therefore cannot be given the
 * department the message asks for. Downloading changes reports nothing, quite
 * correctly — the server has never seen this row and there is nothing to
 * reconcile.
 *
 * A tombstone is a fact about a row the other clients already have. Where they
 * never had it, there is no fact to send, whatever the reason the row failed to
 * land the first time. Dropping it here is what lets the warning clear itself on
 * the next publish.
 */
export function toCommitEntities(
  entities: LocalEntity[],
  shadow: Map<string, ShadowRow>,
  options: CommitOptions = {}
): CommitEntity[] {
  const complete = options.shadowIsComplete !== false;
  const out: CommitEntity[] = [];

  for (const entity of entities) {
    const known = shadow.get(shadowKey(entity.entityType, entity.entityId));
    if (!isUnsent(known, entity, complete)) continue;
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
 * What makes an absence a deletion rather than a blind spot.
 *
 * Every field here exists because a row was missing from the collected set for a
 * reason that had nothing to do with anybody deleting it.
 */
export interface PurgeGuard {
  /**
   * The types actually read this pass — `CollectResult.scannedTypes`.
   *
   * With personal-data storage switched off, `position_pii` is never read, so
   * every PII row the shadow remembers looked deleted and every publish sent a
   * purge for it. The switch means "stop sending these", not "destroy the ones
   * already there" — erasure is a separate, deliberate act (see `pii.ts`).
   */
  scannedTypes?: ReadonlySet<string>;
  /** Rows that ARE here but could not be mapped. Local damage, not a deletion. */
  unpublishable?: readonly UnpublishableRow[];
  /** False for a delegate: the plan's own rows are not theirs to delete. */
  canWriteStructure?: boolean;
}

/**
 * Rows the server holds that we have hard-deleted locally.
 *
 * The 30-day tombstone cleanup in Settings removes rows outright, and a plain
 * absence is indistinguishable from "never existed" — so the server keeps
 * serving them and every client resurrects them. `op: "purge"` is how the death
 * gets recorded. Only ever emitted for rows the shadow says we published.
 *
 * ## The inference is only safe if we actually looked
 *
 * "In the shadow, not in this list" reads as a deletion, and that is true only
 * when the list is everything this computer holds. Pass a list narrowed by
 * anything else and the narrowing becomes a delete instruction:
 *
 * - **Write scope.** Called with the post-scope `publishable` set, a delegate's
 *   every publish sent purges for the plan's own `scenario` and `engine_run`
 *   rows and for every position outside their departments — rows they had
 *   downloaded, not deleted. The server refused them, so nothing was lost, but
 *   each one was still counted and reported to the user as a deletion. That is
 *   the "2 deletions recorded" on a publish that deleted nothing. Pass the FULL
 *   collected set; the guard below covers what scope still has to say.
 * - **A type that was not read at all** — see `scannedTypes`.
 * - **A row that is present but broken** — see `unpublishable`. An orphaned
 *   sidecar is damage on this computer, and answering it by deleting the
 *   server's copy destroys the only intact one left.
 */
export function purgesFor(
  entities: LocalEntity[],
  shadow: Map<string, ShadowRow>,
  guard: PurgeGuard = {}
): CommitEntity[] {
  const present = new Set(
    entities.map((entity) => shadowKey(entity.entityType, entity.entityId))
  );
  for (const row of guard.unpublishable ?? []) {
    present.add(shadowKey(row.entityType, row.entityId));
  }
  const out: CommitEntity[] = [];

  for (const [key, known] of shadow) {
    if (present.has(key) || known.deleted) continue;
    if (guard.scannedTypes && !guard.scannedTypes.has(known.entityType)) continue;
    // A delegate re-running the engine replaces `engine_run` rows under new ids,
    // which leaves the old ones absent locally and looking exactly like a
    // deletion — of a plan-wide row that was never theirs to delete.
    if (
      guard.canWriteStructure === false &&
      PLAN_WIDE_ENTITY_TYPES.has(known.entityType as PublishedEntityType)
    ) {
      continue;
    }
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
