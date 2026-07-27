/**
 * Block inputs in the flat grid row.
 * -----------------------------------------------------------
 * Per-row block inputs (component_values) are folded into the same flat
 * PositionRow the grid edits, under namespaced keys:
 *
 *   blk:<defId>:rate       MULTIPLIER — the per-row multiplier
 *   blk:<defId>:amount     FLAT_MONTHLY — amount per month (yearlyValue slot)
 *   blk:<defId>:qty        COUNT_RATE — the count
 *   blk:<defId>:unitRate   COUNT_RATE — the rate
 *   blk:<defId>:m1..m12    CUSTOM_MONTHLY — exploded months (monthlyValues)
 *   blk:<defId>:eligible   POOL_SPREAD — shares the pot? (boolean)
 *
 * One source of truth: grid editing, optimistic updates and the live
 * simulation all read the row; the write path diffs these keys back into
 * ComponentValuePatch entries (see changedBlockKeys / blockPatchesFromRow).
 * This module is pure and shared by renderer + main-side tests.
 */

import { BlockDto } from "../blocks/ipc";
import { ComponentValuePatch, ComponentValueRecord } from "./ipc";
import { coerceBooleanCell, PositionRow } from "./rowModel";

const MONTHS = 12;

export type BlockSlot =
  | "rate"
  | "amount"
  | "qty"
  | "unitRate"
  | "openingBase"
  | "eligible"
  | `m${number}`;

/**
 * Slots the grid renders as a tick box rather than a number.
 *
 * "eligible" persists into the ComponentValue.rate column as 0/1 — that column
 * is meaningless for POOL_SPREAD (its definition is DIRECT_ABS, never
 * PERCENT_OF), so reusing it keeps the whole feature free of a secure-store
 * migration. It also leaves room to reinterpret the number as a participation
 * weight later (0 = out, 2 = a double share) without touching storage.
 */
export const BOOLEAN_BLOCK_SLOTS: ReadonlySet<BlockSlot> = new Set<BlockSlot>([
  "eligible",
]);

export const BLOCK_KEY_PREFIX = "blk:";

export function blockFieldKey(defId: string, slot: BlockSlot): string {
  return `${BLOCK_KEY_PREFIX}${defId}:${slot}`;
}

/** The editable input slots a block type puts on each row. */
export function blockInputSlots(block: BlockDto): BlockSlot[] {
  switch (block.blockType) {
    case "MULTIPLIER":
      return ["rate"];
    case "FLAT_MONTHLY":
      return ["amount"];
    case "COUNT_RATE":
      return ["qty", "unitRate"];
    case "CUSTOM_MONTHLY":
      return Array.from({ length: MONTHS }, (_, m) => `m${m + 1}` as BlockSlot);
    case "SOCIAL_SECURITY":
      // Fully computed from salary + scheme, except the prior-year opening base:
      // a CUMULATIVE, non-January scheme carries one per (position, scheme).
      return block.ssCumulativeNonJan ? ["openingBase"] : [];
    case "POOL_SPREAD":
      // The column exists in both eligibility modes — under a RULE it is
      // read-only and shows what the block config decided, which is the point:
      // the user can always see who is in the pool. Only MANUAL mode stores a
      // value (see buildBlockColumns, which locks the cell under a RULE).
      return ["eligible"];
  }
}

/** All numeric-input row keys a block contributes (totals are computed). */
export function blockRowKeys(block: BlockDto): string[] {
  return blockInputSlots(block).map((slot) =>
    blockFieldKey(block.costDefId, slot)
  );
}

/** Per-row account cells — present only while the block is "unlocked". */
export function blockAccountKey(defId: string): string {
  return `${BLOCK_KEY_PREFIX}${defId}:account`;
}
export function blockStatsAccountKey(defId: string): string {
  return `${BLOCK_KEY_PREFIX}${defId}:statsAccount`;
}

/** The account row keys a block currently exposes (lock-state dependent). */
export function blockAccountRowKeys(block: BlockDto): string[] {
  const keys: string[] = [];
  if (!block.accountLocked) keys.push(blockAccountKey(block.costDefId));
  if (block.blockType === "COUNT_RATE" && !block.statsAccountLocked) {
    keys.push(blockStatsAccountKey(block.costDefId));
  }
  return keys;
}

/**
 * The block's read-only full-year Total. NOT a stored row key — the grid and
 * the position form both resolve it from the live simulation's BlockResultsById
 * (see blockColumns.buildBlockColumns / PositionFormDialog). It lives here so
 * the pure form model can name the cell without importing the renderer.
 */
export function blockTotalKey(block: BlockDto): string {
  return `${BLOCK_KEY_PREFIX}${block.costDefId}:total`;
}

// ---------------------------------------------------------------------------
// Storage -> row
// ---------------------------------------------------------------------------

/** Fold one position's component values into its flat row (mutates copy-in;
 *  call right after toRow). Values are keyed by the block's COST def — the
 *  stat def of a dual block shares the same stored row. */
export function applyComponentValuesToRow(
  row: PositionRow,
  values: ComponentValueRecord[] | undefined,
  blocks: BlockDto[]
): PositionRow {
  if (!values || values.length === 0 || blocks.length === 0) return row;
  const byDef = new Map(values.map((value) => [value.componentDefId, value]));

  for (const block of blocks) {
    const value = byDef.get(block.costDefId);
    if (!value) continue;
    for (const slot of blockInputSlots(block)) {
      const key = blockFieldKey(block.costDefId, slot);
      if (slot === "rate") row[key] = value.rate ?? null;
      else if (slot === "amount") row[key] = value.yearlyValue ?? null;
      else if (slot === "qty") row[key] = value.qty ?? null;
      else if (slot === "unitRate") row[key] = value.unitRate ?? null;
      else if (slot === "openingBase") row[key] = value.ssOpeningBase ?? null;
      else if (slot === "eligible") row[key] = (value.rate ?? 0) > 0;
      else {
        const month = Number(slot.slice(1));
        row[key] = value.monthlyValues?.[month - 1] ?? null;
      }
    }
    if (!block.accountLocked) {
      row[blockAccountKey(block.costDefId)] = value.accountCode ?? null;
    }
    if (block.blockType === "COUNT_RATE" && !block.statsAccountLocked) {
      row[blockStatsAccountKey(block.costDefId)] = value.statsAccountCode ?? null;
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Row -> storage patch
// ---------------------------------------------------------------------------

/** Diff two rows over the blocks' input + account keys. */
export function changedBlockKeys(
  oldRow: PositionRow,
  newRow: PositionRow,
  blocks: BlockDto[]
): string[] {
  const changed: string[] = [];
  for (const block of blocks) {
    for (const key of [...blockRowKeys(block), ...blockAccountRowKeys(block)]) {
      if (!Object.is(oldRow[key], newRow[key])) changed.push(key);
    }
  }
  return changed;
}

/** Coercion for block inputs — pasted text becomes numbers, junk reverts to
 *  the previous value, empty clears to null. Account cells are strings; empty
 *  normalizes to null ("use the block's default account"). */
export function sanitizeBlockInputs(
  row: PositionRow,
  oldRow: PositionRow,
  blocks: BlockDto[]
): PositionRow {
  const out = { ...row };
  for (const block of blocks) {
    for (const slot of blockInputSlots(block)) {
      const key = blockFieldKey(block.costDefId, slot);
      const value = out[key];
      if (BOOLEAN_BLOCK_SLOTS.has(slot)) {
        // Only normalize a key the row actually carries. Materializing a `false`
        // where there was nothing would read as a change on every unrelated
        // edit, enqueueing a pointless write for every position.
        if (!(key in out)) continue;
        // Same normalization the catalog's BOOLEAN fields get in sanitizeRow —
        // a pasted "TRUE"/"0"/"" must reach the grid as a real boolean or the
        // checkbox renderer and the is-true filter disagree.
        out[key] = coerceBooleanCell(value);
        continue;
      }
      if (value === undefined || value === null) continue;
      if (value === "") {
        out[key] = null;
        continue;
      }
      const num = typeof value === "number" ? value : Number(String(value).trim());
      out[key] = Number.isFinite(num) ? num : oldRow[key] ?? null;
    }
    for (const key of blockAccountRowKeys(block)) {
      const value = out[key];
      if (value === undefined || value === null) continue;
      const text = String(value).trim();
      out[key] = text === "" ? null : text;
    }
  }
  return out;
}

/**
 * Map changed block keys back to sparse ComponentValuePatch entries. Month
 * keys promote to the whole rebuilt monthlyValues vector (the storage
 * granularity — one JSON column), mirroring how position vectors patch.
 */
export function blockPatchesFromRow(
  row: PositionRow,
  changedKeys: string[],
  blocks: BlockDto[]
): ComponentValuePatch[] {
  const blockByDef = new Map(blocks.map((block) => [block.costDefId, block]));
  const byDef = new Map<string, ComponentValuePatch["fields"]>();
  const touchedMonthsByDef = new Set<string>();

  for (const key of changedKeys) {
    if (!key.startsWith(BLOCK_KEY_PREFIX)) continue;
    const rest = key.slice(BLOCK_KEY_PREFIX.length);
    const sep = rest.lastIndexOf(":");
    if (sep <= 0) continue;
    const defId = rest.slice(0, sep);
    const slot = rest.slice(sep + 1);
    if (!blockByDef.has(defId)) continue;

    const fields = byDef.get(defId) ?? {};
    if (slot === "rate") fields.rate = numberOrNull(row[key]);
    else if (slot === "amount") fields.yearlyValue = numberOrNull(row[key]);
    else if (slot === "qty") fields.qty = numberOrNull(row[key]);
    else if (slot === "unitRate") fields.unitRate = numberOrNull(row[key]);
    else if (slot === "openingBase") fields.ssOpeningBase = numberOrNull(row[key]);
    // The tick box rides the rate column as 0/1 — see BOOLEAN_BLOCK_SLOTS.
    else if (slot === "eligible") fields.rate = row[key] === true ? 1 : 0;
    else if (slot === "account") fields.accountCode = stringOrNull(row[key]);
    else if (slot === "statsAccount") fields.statsAccountCode = stringOrNull(row[key]);
    else if (/^m\d{1,2}$/.test(slot)) touchedMonthsByDef.add(defId);
    else continue;
    byDef.set(defId, fields);
  }

  for (const defId of touchedMonthsByDef) {
    const fields = byDef.get(defId) ?? {};
    const months: number[] = [];
    for (let m = 1; m <= MONTHS; m++) {
      const value = row[blockFieldKey(defId, `m${m}` as BlockSlot)];
      const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
      months.push(num);
    }
    fields.monthlyValues = months;
    byDef.set(defId, fields);
  }

  return [...byDef.entries()].map(([componentDefId, fields]) => ({
    positionId: row.id,
    componentDefId,
    fields,
  }));
}

/** Rebuild engine ComponentValue wire records from a row (for the live sim). */
export function rowToComponentValues(
  row: PositionRow,
  blocks: BlockDto[]
): ComponentValueRecord[] {
  const out: ComponentValueRecord[] = [];
  for (const block of blocks) {
    const record: ComponentValueRecord = {
      positionId: row.id,
      componentDefId: block.costDefId,
      rate: null,
      yearlyValue: null,
      monthlyValues: null,
      qty: null,
      unitRate: null,
      ssOpeningBase: null,
      accountCode: null,
      statsAccountCode: null,
      updatedAt: "",
    };
    let hasValue = false;
    for (const slot of blockInputSlots(block)) {
      const value = row[blockFieldKey(block.costDefId, slot)];
      if (BOOLEAN_BLOCK_SLOTS.has(slot)) {
        // Only a ticked row is worth a record; an unticked one is indistinguishable
        // from "never touched" as far as the pool spread is concerned.
        if (value === true) {
          record.rate = 1;
          hasValue = true;
        }
        continue;
      }
      const num =
        typeof value === "number" && Number.isFinite(value) ? value : null;
      if (num === null) continue;
      hasValue = true;
      if (slot === "rate") record.rate = num;
      else if (slot === "amount") record.yearlyValue = num;
      else if (slot === "qty") record.qty = num;
      else if (slot === "unitRate") record.unitRate = num;
      else if (slot === "openingBase") record.ssOpeningBase = num;
      else {
        const month = Number(slot.slice(1));
        record.monthlyValues = record.monthlyValues ?? new Array(MONTHS).fill(0);
        record.monthlyValues[month - 1] = num;
      }
    }
    if (!block.accountLocked) {
      const account = stringOrNull(row[blockAccountKey(block.costDefId)]);
      if (account !== null) {
        record.accountCode = account;
        hasValue = true;
      }
    }
    if (block.blockType === "COUNT_RATE" && !block.statsAccountLocked) {
      const statsAccount = stringOrNull(row[blockStatsAccountKey(block.costDefId)]);
      if (statsAccount !== null) {
        record.statsAccountCode = statsAccount;
        hasValue = true;
      }
    }
    if (hasValue) out.push(record);
  }
  return out;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}
