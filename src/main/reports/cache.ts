/**
 * In-memory holders for the report engine's built sources and indexes,
 * keyed by the database handle (the stmtCache.ts idiom).
 *
 * The secure handle is recreated on every unlock, so a WeakMap keyed by the
 * handle makes lock/unlock cycles self-cleaning: close the connection and its
 * entries are collected with it. Each entry carries the stamp it was built
 * from; a caller that presents a different stamp gets a rebuild, so nothing
 * here needs explicit invalidation — the stamp IS the invalidation.
 */

import type Database from "better-sqlite3-multiple-ciphers";

type Db = InstanceType<typeof Database>;

interface Entry {
  stamp: string;
  value: unknown;
}

const holders = new WeakMap<Db, Map<string, Entry>>();

/**
 * The value built for `key` under `stamp`, building it once per stamp. A new
 * stamp replaces the old entry outright — there is only ever one live value
 * per key, so memory stays bounded by the number of keys.
 */
export function memo<T>(db: Db, key: string, stamp: string, build: () => T): T {
  let entries = holders.get(db);
  if (!entries) {
    entries = new Map();
    holders.set(db, entries);
  }
  const entry = entries.get(key);
  if (entry && entry.stamp === stamp) return entry.value as T;
  const value = build();
  entries.set(key, { stamp, value });
  return value;
}

/** Drop what is held for a handle. Tests use it; production relies on the
 *  WeakMap. */
export function clearMemo(db: Db): void {
  holders.delete(db);
}
