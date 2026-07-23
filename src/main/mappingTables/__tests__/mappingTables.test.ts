/**
 * Mapping-tables tests — repo against in-memory SQLite + version-gated sync
 * against a stub ApiClient. Covers: atomic replace, wide level round-trip,
 * clear, and the four sync outcomes (up-to-date, synced, forced rebuild,
 * 404 → unavailable leaving the cache intact).
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { MAPPING_TABLES_SQL } from "../schema";
import {
  clearAllTables,
  getCounts,
  getStatus,
  getStoredVersion,
  listAccounts,
  listDepartments,
  replaceAllTables,
} from "../repo";
import { syncMappingTables } from "../sync";
import { ApiError } from "../../auth/apiClient";
import type { ApiClient } from "../../auth/apiClient";

type Db = InstanceType<typeof Database>;

const NOW = "2026-07-22T00:00:00.000Z";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MAPPING_TABLES_SQL);
});

function sampleData(version = "v1") {
  return {
    accountMaps: [
      {
        base_account: "1000",
        account_description_detail_level_max: "Cash",
        level_0: "Assets",
        level_30: "Leaf",
      },
    ],
    departmentMaps: [
      {
        base_department: "FO",
        department_description_detail_level_max: "Front Office",
        level_0: "Rooms",
      },
    ],
    combos: [
      { id: 1, account: "1000", department: "FO", description: "Cash / FO" },
      { id: 2, account: "1000", department: "FO", description: null },
    ],
    version,
  };
}

/** Minimal ApiClient stand-in: getJson resolves per-path from a script. */
function stubApiClient(
  routes: Record<string, unknown | (() => unknown)>
): ApiClient {
  return {
    async getJson<T>(path: string): Promise<T> {
      if (!(path in routes)) throw new ApiError(404, `no route ${path}`);
      const entry = routes[path];
      const value = typeof entry === "function" ? (entry as () => unknown)() : entry;
      if (value instanceof Error) throw value;
      return value as T;
    },
  } as unknown as ApiClient;
}

describe("mapping-tables repo", () => {
  it("replaces all three tables atomically and round-trips wide levels", () => {
    replaceAllTables(db, sampleData("v1"), NOW);

    expect(getCounts(db)).toEqual({
      accountMaps: 1,
      departmentMaps: 1,
      combos: 2,
    });
    expect(getStoredVersion(db)).toBe("v1");

    const account = db
      .prepare("SELECT * FROM account_maps WHERE base_account = '1000'")
      .get() as Record<string, unknown>;
    expect(account.level_0).toBe("Assets");
    expect(account.level_30).toBe("Leaf");
    // Unspecified levels persist as NULL, not "undefined".
    expect(account.level_15).toBeNull();

    const nullDesc = db
      .prepare("SELECT description FROM account_department_combos WHERE id = 2")
      .get() as { description: string | null };
    expect(nullDesc.description).toBeNull();
  });

  it("replacing swaps the full set rather than appending", () => {
    replaceAllTables(db, sampleData("v1"), NOW);
    const next = sampleData("v2");
    next.accountMaps[0].base_account = "2000";
    replaceAllTables(db, next, NOW);

    expect(getCounts(db).accountMaps).toBe(1);
    expect(getStoredVersion(db)).toBe("v2");
    expect(
      db.prepare("SELECT 1 FROM account_maps WHERE base_account = '1000'").get()
    ).toBeUndefined();
  });

  it("clearAllTables empties data and drops the stored version", () => {
    replaceAllTables(db, sampleData("v1"), NOW);
    clearAllTables(db);

    expect(getCounts(db)).toEqual({
      accountMaps: 0,
      departmentMaps: 0,
      combos: 0,
    });
    expect(getStoredVersion(db)).toBeNull();
    expect(getStatus(db).lastSyncedAt).toBeNull();
  });

  it("lists departments as code + name, name-sorted, code fallback for null", () => {
    replaceAllTables(
      db,
      {
        ...sampleData("v1"),
        departmentMaps: [
          { base_department: "FO", department_description_detail_level_max: "Front Office" },
          { base_department: "HK", department_description_detail_level_max: "Housekeeping" },
          { base_department: "ZZ", department_description_detail_level_max: null },
        ],
      },
      NOW
    );

    expect(listDepartments(db)).toEqual([
      { code: "FO", name: "Front Office" },
      { code: "HK", name: "Housekeeping" },
      // Null description falls back to the code as its own label, and sorts by
      // that fallback ("ZZ" after the named two).
      { code: "ZZ", name: "ZZ" },
    ]);
  });

  it("returns no departments before the first sync", () => {
    expect(listDepartments(db)).toEqual([]);
  });

  it("lists accounts as code + description, code-sorted, code fallback for null", () => {
    replaceAllTables(
      db,
      {
        ...sampleData("v1"),
        accountMaps: [
          { base_account: "A9200", account_description_detail_level_max: "Headcount" },
          { base_account: "A5100", account_description_detail_level_max: "Salaries" },
          { base_account: "A5900", account_description_detail_level_max: null },
        ],
      },
      NOW
    );

    // Sorted by code (GL order), null description falls back to the code.
    expect(listAccounts(db)).toEqual([
      { code: "A5100", name: "Salaries" },
      { code: "A5900", name: "A5900" },
      { code: "A9200", name: "Headcount" },
    ]);
  });

  it("returns no accounts before the first sync", () => {
    expect(listAccounts(db)).toEqual([]);
  });
});

describe("mapping-tables sync", () => {
  const data = {
    account_maps: sampleData().accountMaps,
    department_maps: sampleData().departmentMaps,
    version: "v1",
  };
  const combos = { combos: sampleData().combos };

  it("pulls and stores when there is no cached version", async () => {
    const api = stubApiClient({
      "/mapping-tables/version": { version: "v1" },
      "/mapping-tables/data": data,
      "/mapping-tables/combos": combos,
    });

    const result = await syncMappingTables(db, api, NOW);
    expect(result.outcome).toBe("synced");
    expect(getCounts(db).combos).toBe(2);
    expect(getStoredVersion(db)).toBe("v1");
  });

  it("skips the bulk pull when the cached version matches", async () => {
    replaceAllTables(db, sampleData("v1"), NOW);
    let dataCalls = 0;
    const api = stubApiClient({
      "/mapping-tables/version": { version: "v1" },
      "/mapping-tables/data": () => {
        dataCalls++;
        return data;
      },
      "/mapping-tables/combos": combos,
    });

    const result = await syncMappingTables(db, api, NOW);
    expect(result.outcome).toBe("up-to-date");
    expect(dataCalls).toBe(0);
  });

  it("re-pulls when the server version has moved", async () => {
    replaceAllTables(db, sampleData("v1"), NOW);
    const api = stubApiClient({
      "/mapping-tables/version": { version: "v2" },
      "/mapping-tables/data": { ...data, version: "v2" },
      "/mapping-tables/combos": combos,
    });

    const result = await syncMappingTables(db, api, NOW);
    expect(result.outcome).toBe("synced");
    expect(getStoredVersion(db)).toBe("v2");
  });

  it("forces a pull even when the version matches", async () => {
    replaceAllTables(db, sampleData("v1"), NOW);
    let dataCalls = 0;
    const api = stubApiClient({
      "/mapping-tables/version": { version: "v1" },
      "/mapping-tables/data": () => {
        dataCalls++;
        return data;
      },
      "/mapping-tables/combos": combos,
    });

    const result = await syncMappingTables(db, api, NOW, { force: true });
    expect(result.outcome).toBe("synced");
    expect(dataCalls).toBe(1);
  });

  it("reports unavailable on 404 and leaves an existing cache intact", async () => {
    replaceAllTables(db, sampleData("v1"), NOW);
    const api = stubApiClient({}); // every path 404s

    const result = await syncMappingTables(db, api, NOW);
    expect(result.outcome).toBe("unavailable");
    // Cache untouched.
    expect(getCounts(db).accountMaps).toBe(1);
    expect(getStoredVersion(db)).toBe("v1");
  });
});
