/**
 * Cluster positions — translating hotel-specific ids between member hotels.
 * -----------------------------------------------------------
 * Most of a position copies across hotels verbatim: department, account and
 * job-type codes are global reference data, and SYSTEM field keys come from one
 * seed. Two things do not, and this module is the only place that reconciles
 * them:
 *
 *   block inputs   a block's id is a per-OU uuid (`block_configs.id`), so a row
 *                  value keyed `<uuid>:cost` is meaningless in another hotel.
 *   USER fields    a user-added column's key is a per-OU `u_<uuid>`, and the
 *                  same column added in two hotels has two unrelated keys.
 *
 * Neither has a stored correlator, so the only available match is the LABEL the
 * user typed. That is inherently fuzzy, which sets the rules here:
 *
 *   - match on label AND kind (block type / storage+data type), never label alone
 *   - require exactly ONE live candidate; two is a guess, and guessing attaches
 *     real money to the wrong block
 *   - never create a block or a column in the target hotel — mirroring a person
 *     must not silently reshape another hotel's cost architecture
 *   - every miss becomes a ClusterSyncSkip that the UI shows; silent loss is the
 *     one outcome this feature cannot have
 *
 * The permanent SYSTEM definitions are the happy exception: their ids are
 * OU-parameterised (`sys-base:<ou>`), so they translate exactly. They are built
 * from the shared id helpers rather than by rewriting the suffix, so a change to
 * the id shape cannot quietly desync the two.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  baseSalaryDefId,
  blockCostDefId,
  blockStatDefId,
  holidayAccrualDefId,
  positionCountDefId,
  systemStatDefId,
  vacationCostDefId,
} from "../../shared/blocks/ipc";
import {
  ClusterSyncSkip,
  normalizeLabel,
} from "../../shared/positions/clusterSync";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

/**
 * A translation either resolves to the target hotel's id, or is skipped.
 *
 * Two nullable fields rather than a discriminated union: this project compiles
 * without `strict`, so a union keyed on a boolean does not narrow at call sites
 * and every use would need a cast. `id` non-null means success; `skip` is set
 * exactly when it is null.
 */
export interface Translation {
  id: string | null;
  skip: ClusterSyncSkip | null;
}

/**
 * Every permanent system definition id, in source→target pairs.
 *
 * Enumerated from the shared helpers so this list is checked by the compiler
 * against their signatures rather than by string surgery on the `:<ou>` suffix.
 */
function systemDefPairs(sourceOu: string, targetOu: string): Map<string, string> {
  const builders: Array<(ou: string) => string> = [
    baseSalaryDefId,
    positionCountDefId,
    holidayAccrualDefId,
    vacationCostDefId,
    (ou) => systemStatDefId(ou, "HOURS"),
    (ou) => systemStatDefId(ou, "HEADCOUNT"),
    (ou) => systemStatDefId(ou, "FTE"),
  ];
  return new Map(builders.map((build) => [build(sourceOu), build(targetOu)]));
}

interface BlockRow {
  id: string;
  block_type: string;
  label: string;
}

function liveBlocks(db: Db, ou: string): BlockRow[] {
  return prepared(
    db,
    `SELECT id, block_type, label FROM block_configs
      WHERE ou = ? AND deleted_at IS NULL`
  ).all(ou) as BlockRow[];
}

/**
 * A reusable source→target translator for one hotel pair.
 *
 * Built once per target hotel per sync (the catalogs are read up front) because
 * a materialise can carry a dozen block values and a propagate fires on every
 * keystroke-batch.
 */
export interface ClusterTranslator {
  targetOu: string;
  /** Translate a component_values.component_def_id. */
  defId(sourceDefId: string): Translation;
  /** Translate a catalog field key. SYSTEM keys pass straight through — they
   *  are identical in every hotel; USER keys are matched by label. */
  fieldKey(sourceKey: string): Translation;
}

export function buildTranslator(
  structureDb: Db,
  sourceOu: string,
  targetOu: string
): ClusterTranslator {
  const systemDefs = systemDefPairs(sourceOu, targetOu);

  // Source blocks by id, target blocks indexed by (type, normalised label).
  // A label used twice in the target hotel maps to null: ambiguous, so skipped.
  const sourceBlocks = new Map(
    liveBlocks(structureDb, sourceOu).map((row) => [row.id, row])
  );
  const targetByLabel = new Map<string, string | null>();
  for (const row of liveBlocks(structureDb, targetOu)) {
    const key = `${row.block_type}|${normalizeLabel(row.label)}`;
    targetByLabel.set(key, targetByLabel.has(key) ? null : row.id);
  }

  // USER fields, same shape. Keyed by (storage, data type, normalised label) so
  // a text note never adopts a number column's values.
  interface FieldRow {
    field_key: string;
    storage: string;
    data_type: string;
    default_label: string;
    custom_label: string | null;
    origin: string;
  }
  const readFields = (ou: string): FieldRow[] =>
    prepared(
      structureDb,
      `SELECT field_key, storage, data_type, default_label, custom_label, origin
         FROM field_catalog
        WHERE ou = ? AND deleted_at IS NULL`
    ).all(ou) as FieldRow[];
  const effectiveLabel = (row: FieldRow): string =>
    normalizeLabel(row.custom_label || row.default_label);

  const sourceFields = new Map(
    readFields(sourceOu).map((row) => [row.field_key, row])
  );
  const targetFieldByLabel = new Map<string, string | null>();
  for (const row of readFields(targetOu)) {
    if (row.origin !== "USER") continue;
    const key = `${row.storage}|${row.data_type}|${effectiveLabel(row)}`;
    targetFieldByLabel.set(key, targetFieldByLabel.has(key) ? null : row.field_key);
  }

  const miss = (
    label: string,
    kind: ClusterSyncSkip["kind"],
    reason: ClusterSyncSkip["reason"]
  ): Translation => ({ id: null, skip: { targetOu, label, kind, reason } });

  return {
    targetOu,

    defId(sourceDefId: string): Translation {
      const system = systemDefs.get(sourceDefId);
      if (system) return { id: system, skip: null };

      // Block-compiled ids are `<blockId>:cost` / `<blockId>:stat`. Split on the
      // LAST colon: a uuidv7 has none, but never assume the id shape here.
      const cut = sourceDefId.lastIndexOf(":");
      const blockId = cut === -1 ? sourceDefId : sourceDefId.slice(0, cut);
      const suffix = cut === -1 ? "" : sourceDefId.slice(cut + 1);
      const source = sourceBlocks.get(blockId);
      if (!source) {
        // The value's own block is gone from the source hotel (deleted since
        // the row was written). Nothing to name, nothing to match.
        return miss(sourceDefId, "BLOCK", "NO_MATCH");
      }

      const match = targetByLabel.get(
        `${source.block_type}|${normalizeLabel(source.label)}`
      );
      if (match === undefined) return miss(source.label, "BLOCK", "NO_MATCH");
      if (match === null) return miss(source.label, "BLOCK", "AMBIGUOUS");

      const id =
        suffix === "cost"
          ? blockCostDefId(match)
          : suffix === "stat"
            ? blockStatDefId(match)
            : `${match}:${suffix}`;
      return { id, skip: null };
    },

    fieldKey(sourceKey: string): Translation {
      const source = sourceFields.get(sourceKey);
      // Unknown to the source catalog: pass through and let the target's own
      // catalog validation reject it, rather than inventing a skip reason.
      if (!source || source.origin !== "USER") return { id: sourceKey, skip: null };

      const match = targetFieldByLabel.get(
        `${source.storage}|${source.data_type}|${effectiveLabel(source)}`
      );
      const label = source.custom_label || source.default_label;
      if (match === undefined) return miss(label, "FIELD", "NO_MATCH");
      if (match === null) return miss(label, "FIELD", "AMBIGUOUS");
      return { id: match, skip: null };
    },
  };
}
