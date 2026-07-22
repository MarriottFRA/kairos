/**
 * Prepared-statement cache, keyed by connection.
 * -----------------------------------------------------------
 * The secure database handle is recreated on every unlock (see secure_db.ts),
 * so statements cannot be cached at module level against a single connection.
 * A WeakMap keyed by the Database instance makes lock/unlock cycles
 * self-cleaning: when a connection is closed and dropped, its statement map is
 * garbage-collected with it.
 *
 * Dynamic UPDATEs (sparse column sets from batch patches) are cached by their
 * SQL text — in practice only a handful of distinct shapes occur per session.
 */

import type Database from "better-sqlite3-multiple-ciphers";

type Db = InstanceType<typeof Database>;
/** Variadic-bind statement (ReturnType<Db["prepare"]> collapses the generic
 *  to a single-parameter signature, so it is named explicitly here). */
export type Stmt = Database.Statement<unknown[], unknown>;

const cache = new WeakMap<Db, Map<string, Stmt>>();

export function prepared(db: Db, sql: string): Stmt {
  let statements = cache.get(db);
  if (!statements) {
    statements = new Map();
    cache.set(db, statements);
  }
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare<unknown[], unknown>(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}
