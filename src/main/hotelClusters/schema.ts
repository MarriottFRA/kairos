/**
 * Hotel clusters DDL, shared between local_db.ts (migration v13) and the
 * tests. Must stay free of Electron imports — tests exec this against
 * in-memory databases.
 *
 * A hotel cluster is a named CROSS-OU group of hotels with per-hotel weights
 * (see src/shared/hotelClusters/ipc.ts). Definitions are plaintext reference
 * data; the assignment lives on the encrypted positions table (the repurposed
 * `cluster` column stores the cluster id) with no cross-file FK — dangling
 * ids resolve to weight 1 at load.
 */

import type Database from "better-sqlite3-multiple-ciphers";

export const HOTEL_CLUSTERS_SQL = `
  CREATE TABLE IF NOT EXISTS hotel_clusters (
      id         TEXT PRIMARY KEY,
      -- Deliberately NO ou column: a cluster spans OUs. Membership carries
      -- the OU.
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS hotel_cluster_members (
      cluster_id TEXT NOT NULL REFERENCES hotel_clusters(id) ON DELETE CASCADE,
      ou         TEXT NOT NULL,
      -- This hotel's share of an assigned person; validated 0 < w <= 1 at the
      -- repo. Weights across a cluster usually sum to 1 but are not forced to.
      weight     REAL NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (cluster_id, ou)
  );
  CREATE INDEX IF NOT EXISTS idx_hotel_cluster_members_ou
    ON hotel_cluster_members (ou);
`;

/** Local migration v13 — pure CREATE IF NOT EXISTS, idempotent. */
export function applyHotelClustersV13(
  handle: InstanceType<typeof Database>
): void {
  handle.exec(HOTEL_CLUSTERS_SQL);
}
