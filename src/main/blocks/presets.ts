/**
 * Applying a block preset.
 *
 * A preset is a short list of ordinary BlockInputs, so this is a loop over
 * saveBlock and nothing more clever. Two things it has to get right:
 *
 *  - REFERENCES. A later step names an earlier one as `$key`; the real id only
 *    exists once that step is saved, so the map is built as we go and the base
 *    is rewritten immediately before each save. saveBlock's own validation then
 *    sees real ids and rejects a broken graph the same way it would a
 *    hand-built one.
 *  - LABELS. clusterBlockMap matches blocks across a cluster's hotels by
 *    (label, block_type) and requires exactly ONE live candidate — so applying
 *    the same preset twice with the same names would break cluster sync
 *    silently. Colliding labels get a numeric suffix.
 *
 * The whole preset runs in one transaction: a step that fails to validate rolls
 * back the ones before it rather than leaving half an Overtime behind.
 * (saveBlock opens its own transaction; better-sqlite3 nests those as
 * savepoints, so the outer one still owns the rollback.)
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  findBlockPreset,
  resolvePresetRefs,
} from "../../shared/blocks/presets";
import { OuScope } from "../positions/ouScope";
import { prepared } from "../positions/stmtCache";
import { saveBlock } from "./repo";

type Db = InstanceType<typeof Database>;

/**
 * A label no live block in the OU already uses. "Pension" -> "Pension 2" ->
 * "Pension 3". Case-insensitive, because the cluster matcher is not the only
 * reader that would be confused by "Pension" and "pension" side by side.
 */
export function uniqueBlockLabel(db: Db, scope: OuScope, label: string): string {
  const rows = prepared(
    db,
    `SELECT label FROM block_configs WHERE ou = ? AND deleted_at IS NULL`
  ).all(scope.ou) as Array<{ label: string }>;
  const taken = new Set(rows.map((row) => row.label.trim().toLowerCase()));

  const base = label.trim();
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Create every block a preset describes, in order. Returns the new block ids so
 * a caller can select or scroll to them; the IPC handler currently just
 * re-reads the whole model.
 */
export function applyBlockPreset(
  db: Db,
  scope: OuScope,
  presetId: string,
  opts: { now: string }
): string[] {
  const preset = findBlockPreset(presetId);
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);

  const created: string[] = [];
  const idByKey = new Map<string, string>();

  db.transaction(() => {
    for (const step of preset.steps) {
      const id = saveBlock(
        db,
        scope,
        {
          ...step.block,
          label: uniqueBlockLabel(db, scope, step.block.label),
          base: resolvePresetRefs(step.block.base, idByKey),
        },
        opts
      );
      idByKey.set(step.key, id);
      created.push(id);
    }
  })();

  return created;
}
