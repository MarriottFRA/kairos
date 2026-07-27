/**
 * Cluster positions — the sync contract.
 * -----------------------------------------------------------
 * A hotel cluster spreads ONE person's cost across its member hotels (0.5 + 0.5
 * for a shared pair; see shared/hotelClusters/resolve.ts). The costing model has
 * always required each member hotel to hold its own position row, because each
 * hotel books its own weighted share. What this module adds is the LINK between
 * those rows: they share a `cluster_link_id`, so one of them can be created,
 * edited or deleted and the others follow.
 *
 * This file is the single declaration of WHAT travels between siblings. Both the
 * materialiser (creating the sibling rows) and the propagator (pushing an edit
 * to them) read the partition from here — there is no second list to keep in
 * step. Main-process translation of the hotel-specific keys lives in
 * main/positions/clusterBlockMap.ts; the rules for when sync fires live in
 * main/positions/clusterSync.ts.
 *
 * The partition exists because only part of a position is portable:
 *
 *   travels      title/name, department, job type, pay type, salaries (incl.
 *                the annual-entry trio), headcount, seasonality, vacation,
 *                increases, contract hours, posting accounts, the cluster
 *                assignment — every SYSTEM key means the same thing in every
 *                hotel, and department/account/job-type codes are global
 *                reference data with no `ou` column.
 *
 *   translates   block inputs (a block id is a per-OU uuid) and USER catalog
 *                fields (a user key is a per-OU `u_<uuid>`). Matched by label in
 *                the target hotel, or skipped loudly.
 *
 *   stays local  fte (derived from each hotel's own calendar and full-time
 *                yardstick — forcing one hotel's FTE onto another would be
 *                wrong, and it is a COMPUTED column anyway), the cluster
 *                multiplier override (per-hotel by definition, and only legal
 *                for a single-member cluster), and row identity.
 */

import {
  ENGINE_SCALAR_COLUMNS,
  FieldDef,
  HOTEL_CLUSTER_MULT_KEY,
  PII_CORE_COLUMNS,
  VECTOR_COLUMNS,
} from "./fields";

/**
 * Row identity and the two deliberately per-hotel values. Never written to a
 * sibling, whatever the caller sends.
 *
 * `fte` is listed for documentation and defence: it is COMPUTED today (derived
 * at load from the hotel-year reference) so it cannot arrive in a patch, but a
 * future storage change must not silently start copying one hotel's derivation
 * into another's row.
 */
export const NEVER_SYNCED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "ou",
  "scenarioId",
  "lineageId",
  "clusterLinkId",
  "fte",
  HOTEL_CLUSTER_MULT_KEY,
]);

/**
 * Does this catalog field travel to the sibling rows by KEY (no translation)?
 *
 * True for every SYSTEM field with real storage: engine columns, month vectors,
 * PII core, and the SYSTEM extras (which use identical keys in every OU because
 * they come from the same seed). USER fields are false here — they are matched
 * by label per target hotel instead (see clusterBlockMap.matchUserFields).
 * COMPUTED fields are false because they are never stored anywhere.
 */
export function syncsByKey(def: FieldDef): boolean {
  if (def.origin !== "SYSTEM") return false;
  if (def.storage === "COMPUTED") return false;
  return !NEVER_SYNCED_KEYS.has(def.key);
}

/** The `positions`/`position_pii` columns a materialised sibling copies. */
export const SYNCED_POSITION_COLUMNS: readonly string[] = Object.entries(
  ENGINE_SCALAR_COLUMNS
)
  .filter(([key]) => !NEVER_SYNCED_KEYS.has(key))
  .map(([, column]) => column)
  .concat(Object.values(VECTOR_COLUMNS));

export const SYNCED_PII_COLUMNS: readonly string[] =
  Object.values(PII_CORE_COLUMNS);

/**
 * A value that could not be mirrored into one hotel.
 *
 * Surfaced in the UI, never swallowed: block and USER-field matching is by
 * label, so "nothing happened" has to be visible or a hotel silently carries a
 * position without its pension. `label` is what the user would recognise (the
 * block's or field's label), not an id.
 */
export interface ClusterSyncSkip {
  targetOu: string;
  label: string;
  kind: "BLOCK" | "FIELD";
  /** NO_MATCH: the target hotel has no such block/field. AMBIGUOUS: it has
   *  more than one with that label, so picking one would be a guess. */
  reason: "NO_MATCH" | "AMBIGUOUS";
}

/** What a write did to the other hotels — returned on the batch-write response
 *  so the grid can report it. */
export interface ClusterSyncResult {
  /** Sibling rows created by this write (the "also added to Hotel B" toast). */
  created: Array<{ ou: string; positionId: string }>;
  /** Sibling rows that stopped being part of a group (cluster cleared). */
  unlinked: number;
  /** Sibling rows that received a propagated edit. */
  propagated: number;
  skips: ClusterSyncSkip[];
}

export const EMPTY_CLUSTER_SYNC: ClusterSyncResult = {
  created: [],
  unlinked: 0,
  propagated: 0,
  skips: [],
};

/** Merge sync results from several rows in one batch. */
export function mergeClusterSync(
  results: readonly ClusterSyncResult[]
): ClusterSyncResult {
  const merged: ClusterSyncResult = {
    created: [],
    unlinked: 0,
    propagated: 0,
    skips: [],
  };
  for (const result of results) {
    merged.created.push(...result.created);
    merged.unlinked += result.unlinked;
    merged.propagated += result.propagated;
    merged.skips.push(...result.skips);
  }
  // One "Pension 5% didn't reach Hotel B" is enough however many rows hit it.
  const seen = new Set<string>();
  merged.skips = merged.skips.filter((skip) => {
    const key = `${skip.targetOu}|${skip.kind}|${skip.label}|${skip.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged;
}

/**
 * The grid row's copy of `positions.cluster_link_id`.
 *
 * Not a field-catalog key on purpose: it is never editable and never sent in a
 * patch (toPatch and changedFieldKeys both iterate the catalog, so a row key
 * outside it is inert). It exists on the row only so the grid can mark a
 * clustered position and warn before a delete takes three hotels with it.
 */
export const CLUSTER_LINK_ROW_KEY = "clusterLinkId";

/**
 * Normalised form for matching a block or field label across hotels.
 *
 * Case- and whitespace-insensitive, because "Pension 5%" and "pension  5%" are
 * the same benefit typed by two people. Nothing looser than that: a fuzzier
 * match would start attaching real costs to the wrong block.
 */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
