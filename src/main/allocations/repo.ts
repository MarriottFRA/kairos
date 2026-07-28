/**
 * Allocations repository — per-hotel spread definitions in the plaintext
 * structure store. OU-scoped (like blocks): every query is bound to scope.ou.
 *
 * Every function takes the Database handle explicitly (vitest runs these
 * against in-memory databases). Mutations stamp updated_at and the caller
 * re-reads the list (blocks idiom — one round-trip refresh).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { uuidv7 } from "../../shared/engine/ids";
import {
  AllocationDto,
  AllocationInput,
  normalizeAllocationInput,
} from "../../shared/allocations/ipc";
import { OuScope } from "../positions/ouScope";
import { prepared } from "../positions/stmtCache";

type Db = InstanceType<typeof Database>;

interface AllocationRow {
  id: string;
  name: string;
  spread_base: string;
  excluded_departments: string;
  inject_account: string;
  sort_order: number;
  updated_at: string;
}

function parseExcluded(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) {
      return parsed.map((code) => String(code)).filter(Boolean);
    }
  } catch {
    /* fall through */
  }
  return [];
}

export function listAllocations(db: Db, scope: OuScope): AllocationDto[] {
  const rows = prepared(
    db,
    `SELECT id, name, spread_base, excluded_departments, inject_account,
            sort_order, updated_at
       FROM allocations
      WHERE ou = ? AND deleted_at IS NULL
      ORDER BY sort_order, id`
  ).all(scope.ou) as AllocationRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    // Historic/unknown bases are surfaced as-is; the dialog re-picks a valid one.
    spreadBase: row.spread_base as AllocationDto["spreadBase"],
    excludedDepartments: parseExcluded(row.excluded_departments),
    injectAccount: row.inject_account ?? "",
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  }));
}

/**
 * Validate + canonicalize. Shape checks are shared with the dialog
 * (normalizeAllocationInput); the name-clash check needs the database, so it
 * lives here (blocks/hotelClusters idiom). Error strings are user-facing.
 */
function validateInput(db: Db, scope: OuScope, input: AllocationInput) {
  const normalized = normalizeAllocationInput(input);

  const clash = prepared(
    db,
    `SELECT id FROM allocations
      WHERE ou = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id <> ?`
  ).get(scope.ou, normalized.name, normalized.id ?? "") as
    | { id: string }
    | undefined;
  if (clash) throw new Error("An allocation with this name already exists.");

  return normalized;
}

/** Create or update an allocation; returns its id. */
export function saveAllocation(
  db: Db,
  scope: OuScope,
  input: AllocationInput,
  opts: { now: string }
): string {
  const normalized = validateInput(db, scope, input);

  const existing = normalized.id
    ? (prepared(
        db,
        `SELECT id, sort_order FROM allocations
          WHERE id = ? AND ou = ? AND deleted_at IS NULL`
      ).get(normalized.id, scope.ou) as
        | { id: string; sort_order: number }
        | undefined)
    : undefined;
  if (normalized.id && !existing) {
    throw new Error("This allocation no longer exists.");
  }

  const id = existing?.id ?? uuidv7();
  const sortOrder = existing?.sort_order ?? nextSortOrder(db, scope);

  prepared(
    db,
    `INSERT INTO allocations
       (id, ou, name, spread_base, excluded_departments, inject_account,
        sort_order, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       spread_base = excluded.spread_base,
       excluded_departments = excluded.excluded_departments,
       inject_account = excluded.inject_account,
       updated_at = excluded.updated_at,
       deleted_at = NULL`
  ).run(
    id,
    scope.ou,
    normalized.name,
    normalized.spreadBase,
    JSON.stringify(normalized.excludedDepartments),
    normalized.injectAccount,
    sortOrder,
    opts.now
  );

  return id;
}

function nextSortOrder(db: Db, scope: OuScope): number {
  const row = prepared(
    db,
    `SELECT COALESCE(MAX(sort_order), 0) AS top FROM allocations WHERE ou = ?`
  ).get(scope.ou) as { top: number };
  return row.top + 10;
}

/** Soft-delete an allocation. */
export function deleteAllocation(
  db: Db,
  scope: OuScope,
  id: string,
  opts: { now: string }
): void {
  const result = prepared(
    db,
    `UPDATE allocations SET updated_at = ?, deleted_at = ?
      WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).run(opts.now, opts.now, id, scope.ou);
  if (result.changes === 0) {
    throw new Error("This allocation no longer exists.");
  }
}
