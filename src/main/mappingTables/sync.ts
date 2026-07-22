/**
 * Mapping-tables sync — version-gated download of the three reference tables.
 *
 * Flow (see the endpoint notes in the API):
 *   1. GET /mapping-tables/version          (cheap { version } probe)
 *   2. if it matches the cached version and we already hold rows → up-to-date
 *   3. GET /mapping-tables/data + /combos    (the bulk pull, ~5000 rows)
 *   4. replace all three tables + stamp the new version, atomically
 *
 * A 404 on any call means the backend has no mapping_configs row yet — there is
 * nothing to sync, so we report "unavailable" and leave any existing cache
 * intact rather than wiping it. `/combos` has no version of its own, so it
 * piggybacks on the maps version and is refetched whenever the maps are.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { ApiClient, ApiError } from "../auth/apiClient";
import {
  CombosResponse,
  MappingSyncResult,
  MappingTablesData,
  MappingVersionResponse,
} from "../../shared/mappingTables/types";
import { getCounts, getStatus, getStoredVersion, replaceAllTables } from "./repo";

type LocalDb = InstanceType<typeof Database>;

/** True when the cache holds no map rows — a version match alone isn't enough
 *  to skip the pull if we've never actually populated the tables. */
function cacheIsEmpty(db: LocalDb): boolean {
  const counts = getCounts(db);
  return counts.accountMaps === 0 && counts.departmentMaps === 0;
}

/**
 * Run a version-gated sync. With `force`, skip the version comparison and always
 * pull (used by the settings "Rebuild" action after it clears the tables).
 */
export async function syncMappingTables(
  db: LocalDb,
  apiClient: ApiClient,
  nowIso: string,
  options: { force?: boolean } = {}
): Promise<MappingSyncResult> {
  try {
    const { version: serverVersion } =
      await apiClient.getJson<MappingVersionResponse>("/mapping-tables/version");

    const stored = getStoredVersion(db);
    if (!options.force && stored === serverVersion && !cacheIsEmpty(db)) {
      return { outcome: "up-to-date", status: getStatus(db) };
    }

    // Version differs (or a rebuild forced our hand): pull both payloads. Combos
    // carry no version, so they ride along with the maps' version.
    const [data, combos] = await Promise.all([
      apiClient.getJson<MappingTablesData>("/mapping-tables/data"),
      apiClient.getJson<CombosResponse>("/mapping-tables/combos"),
    ]);

    replaceAllTables(
      db,
      {
        accountMaps: data.account_maps ?? [],
        departmentMaps: data.department_maps ?? [],
        combos: combos.combos ?? [],
        // Trust /data's version as the source of truth for what we just stored.
        version: data.version ?? serverVersion,
      },
      nowIso
    );

    return { outcome: "synced", status: getStatus(db) };
  } catch (error) {
    // Missing mapping_configs row → nothing to sync yet; keep any existing cache.
    if (error instanceof ApiError && error.status === 404) {
      return { outcome: "unavailable", status: getStatus(db) };
    }
    const message = error instanceof Error ? error.message : "Mapping sync failed";
    console.error("[mappingTables] Sync failed:", error);
    return { outcome: "error", status: getStatus(db), message };
  }
}
