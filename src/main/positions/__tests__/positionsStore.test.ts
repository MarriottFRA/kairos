/**
 * Positions persistence tests — repositories against in-memory SQLite.
 * Covers: field-catalog seeding (idempotence + user-rename preservation),
 * scenario CRUD, batch-write round-trips, OU isolation, soft delete/restore,
 * and a save→load→compile() round trip through the engine.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { compile } from "../../../shared/engine/compile";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { SYSTEM_FIELD_SEED } from "../../../shared/positions/fieldSeed";
import {
  applyValueStoreV3,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../schema";
import { OuScope, resolveOuScope } from "../ouScope";
import {
  DEFAULT_SCENARIO_LABEL,
  ensureDefaultScenario,
  ensureFieldCatalogSeed,
  getFieldCatalog,
  listRemovedFields,
  listScenarios,
  purgeCatalogFields,
  saveFieldCatalog,
  saveScenario,
  softDeleteScenario,
} from "../structureRepo";
import {
  batchWrite,
  cloneScenarioValues,
  countExtraValueUsage,
  getPii,
  loadScenarioValues,
  scrubExtraValueKeys,
} from "../positionsRepo";
import { loadScenarioInput } from "../loadScenarioInput";

type Db = InstanceType<typeof Database>;

const OU_A = resolveOuScope("OU12345");
const OU_B = resolveOuScope("OU99999");

let structureDb: Db;
let valuesDb: Db;

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
});

function catalogFor(scope: OuScope) {
  return getFieldCatalog(structureDb, scope);
}

function lookupFor(scope: OuScope) {
  return buildFieldMap(catalogFor(scope));
}

describe("ouScope", () => {
  it("canonicalizes both accepted forms to the 7-char OU code", () => {
    // Real OU codes are alphanumeric, e.g. OU25RJ2 (as persisted by the
    // hotel switcher) — accepted verbatim, case-normalized.
    expect(resolveOuScope("OU25RJ2").ou).toBe("OU25RJ2");
    expect(resolveOuScope("ou25rj2").ou).toBe("OU25RJ2");
    expect(resolveOuScope("ou12345").ou).toBe("OU12345");
    expect(resolveOuScope({ ou: " OU00001 " }).ou).toBe("OU00001");
    // Bare 5-character codes get the OU prefix added.
    expect(resolveOuScope("25RJ2").ou).toBe("OU25RJ2");
    expect(resolveOuScope({ ou: " 00410 " }).ou).toBe("OU00410");
  });

  it("rejects everything else", () => {
    for (const bad of ["1234", "OU1234", "OU123456", "123456", "OU25RJ", "OU 25RJ2", "", null, 42]) {
      expect(() => resolveOuScope(bad as never)).toThrow(/INVALID_OU/);
    }
  });
});

describe("field catalog seed", () => {
  it("seeds every system field exactly once (idempotent)", () => {
    const first = catalogFor(OU_A);
    expect(first.fields).toHaveLength(SYSTEM_FIELD_SEED.length);

    ensureFieldCatalogSeed(structureDb, OU_A);
    ensureFieldCatalogSeed(structureDb, OU_A);
    expect(catalogFor(OU_A).fields).toHaveLength(SYSTEM_FIELD_SEED.length);
  });

  it("preserves a user rename of an unlocked field across re-seeding", () => {
    catalogFor(OU_A);
    saveFieldCatalog(structureDb, OU_A, [
      { key: "deptName", customLabel: "Division Name" },
    ]);
    ensureFieldCatalogSeed(structureDb, OU_A);

    const field = catalogFor(OU_A).fields.find((f) => f.key === "deptName");
    expect(field?.customLabel).toBe("Division Name");
  });

  it("rejects renaming and removing locked fields", () => {
    catalogFor(OU_A);
    expect(() =>
      saveFieldCatalog(structureDb, OU_A, [
        { key: "empNumber", customLabel: "Nope" },
      ])
    ).toThrow(/locked/);
    expect(() =>
      saveFieldCatalog(structureDb, OU_A, [{ key: "headcount", remove: true }])
    ).toThrow(/locked/);
  });

  it("creates user fields with generated keys and extra-value storage only", () => {
    catalogFor(OU_A);
    const updated = saveFieldCatalog(structureDb, OU_A, [
      {
        create: {
          section: "contract",
          dataType: "NUMBER",
          storage: "POSITION_EXTRA",
          defaultLabel: "Meal Allowance Days",
        },
      },
    ]);
    const created = updated.fields.find((f) => f.origin === "USER");
    expect(created?.key).toMatch(/^u_/);

    expect(() =>
      saveFieldCatalog(structureDb, OU_A, [
        {
          create: {
            section: "contract",
            dataType: "NUMBER",
            storage: "ENGINE" as never,
            defaultLabel: "Bad",
          },
        },
      ])
    ).toThrow(/extra-value/);
  });

  it("keeps catalogs separate per OU", () => {
    catalogFor(OU_A);
    saveFieldCatalog(structureDb, OU_A, [
      { key: "deptName", customLabel: "Division" },
    ]);
    const other = catalogFor(OU_B).fields.find((f) => f.key === "deptName");
    expect(other?.customLabel ?? null).toBeNull();
  });
});

describe("field removal lifecycle", () => {
  function addUserField(scope: OuScope, defaultLabel = "Badge ID"): string {
    const updated = saveFieldCatalog(structureDb, scope, [
      { create: { section: "pii", dataType: "TEXT", storage: "PII_EXTRA", defaultLabel } },
    ]);
    return updated.fields.find((f) => f.origin === "USER" && f.customLabel === null && f.defaultLabel === defaultLabel)!.key;
  }

  it("removes only user-added columns, never system ones", () => {
    catalogFor(OU_A);
    // deptName is a SYSTEM field that happens to be unlocked (renamable), but
    // it is still structural — origin, not the locked flag, is the delete gate.
    expect(() =>
      saveFieldCatalog(structureDb, OU_A, [{ key: "deptName", remove: true }])
    ).toThrow(/user-added/);
  });

  it("soft-deletes a user column and restores it losslessly", () => {
    catalogFor(OU_A);
    const key = addUserField(OU_A);

    const afterRemove = saveFieldCatalog(structureDb, OU_A, [{ key, remove: true }]);
    expect(afterRemove.fields.some((f) => f.key === key)).toBe(false);
    expect(listRemovedFields(structureDb, OU_A).map((r) => r.key)).toEqual([key]);

    const afterRestore = saveFieldCatalog(structureDb, OU_A, [{ key, restore: true }]);
    expect(afterRestore.fields.some((f) => f.key === key)).toBe(true);
    expect(listRemovedFields(structureDb, OU_A)).toHaveLength(0);
  });

  it("counts, scrubs, and purges extra-value data across scenarios", () => {
    catalogFor(OU_A);
    const key = addUserField(OU_A, "Note");

    // Same column filled in two different scenarios.
    for (const scenarioId of ["scn-a", "scn-b"]) {
      batchWrite(
        valuesDb,
        OU_A,
        {
          ou: OU_A.ou,
          scenarioId,
          creates: [
            { id: `pos-${scenarioId}`, fields: { departmentCode: "D1" }, pii: { [key]: "kept" } },
          ],
        },
        lookupFor(OU_A)
      );
    }
    expect(countExtraValueUsage(valuesDb, OU_A, key)).toBe(2);

    // Soft delete → scrub the encrypted blobs → drop the catalog row.
    saveFieldCatalog(structureDb, OU_A, [{ key, remove: true }]);
    expect(scrubExtraValueKeys(valuesDb, OU_A, [key])).toBe(2);
    expect(countExtraValueUsage(valuesDb, OU_A, key)).toBe(0);

    expect(purgeCatalogFields(structureDb, OU_A, [key])).toEqual([key]);
    expect(listRemovedFields(structureDb, OU_A)).toHaveLength(0);
  });

  it("purge only touches soft-deleted user rows", () => {
    catalogFor(OU_A);
    const key = addUserField(OU_A, "Live");
    // A live (not removed) column is not eligible — nothing is purged.
    expect(purgeCatalogFields(structureDb, OU_A, [key])).toEqual([]);
    expect(catalogFor(OU_A).fields.some((f) => f.key === key)).toBe(true);
  });
});

describe("scenarios", () => {
  it("saves, lists, and soft-deletes within one OU", () => {
    const created = saveScenario(structureDb, OU_A, {
      year: 2027,
      label: "Budget 2027",
    });
    expect(listScenarios(structureDb, OU_A)).toHaveLength(1);
    expect(listScenarios(structureDb, OU_B)).toHaveLength(0);

    softDeleteScenario(structureDb, OU_A, created.id);
    expect(listScenarios(structureDb, OU_A)).toHaveLength(0);
  });

  it("cannot soft-delete another OU's scenario", () => {
    const created = saveScenario(structureDb, OU_A, { year: 2027, label: "B27" });
    softDeleteScenario(structureDb, OU_B, created.id);
    expect(listScenarios(structureDb, OU_A)).toHaveLength(1);
  });

  it("auto-creates the default Planning scenario once per OU + year", () => {
    ensureDefaultScenario(structureDb, OU_A, 2027);
    ensureDefaultScenario(structureDb, OU_A, 2027);
    const scenarios = listScenarios(structureDb, OU_A);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].label).toBe(DEFAULT_SCENARIO_LABEL);

    // A year that already has scenarios gets nothing extra.
    saveScenario(structureDb, OU_A, { year: 2028, label: "Custom" });
    ensureDefaultScenario(structureDb, OU_A, 2028);
    expect(listScenarios(structureDb, OU_A).filter((s) => s.year === 2028)).toHaveLength(1);
  });
});

describe("batch write", () => {
  const SCENARIO = "scn-test-1";

  function createOnePosition(scope: OuScope, id = "pos-1") {
    return batchWrite(
      valuesDb,
      scope,
      {
        ou: scope.ou,
        scenarioId: SCENARIO,
        creates: [
          {
            id,
            fields: {
              departmentCode: "D110",
              jobTypeCode: "Manager",
              cluster: "Rooms",
              payType: "SALARIED",
              headcount: 2,
              fte: 1.5,
              monthlyBaseSalary: 3000,
              seasonality: [1, 1, 1, 1, 1, 1, 0.5, 0.5, 1, 1, 1, 1],
              vacationMonthlyWeights: Array(12).fill(1 / 12),
              contractYearlyDays: 365,
              salaryAccountCode: "500100",
            },
            pii: {
              empNumber: "E-1001",
              firstName: "Test",
              lastName: "Person",
              hiringDate: "2024-05-01",
            },
          },
        ],
      },
      lookupFor(scope)
    );
  }

  it("round-trips a create through load + pii", () => {
    createOnePosition(OU_A);

    const loaded = loadScenarioValues(valuesDb, OU_A, SCENARIO);
    expect(loaded.positions).toHaveLength(1);
    const position = loaded.positions[0];
    expect(position.departmentCode).toBe("D110");
    expect(position.headcount).toBe(2);
    expect(position.seasonality[6]).toBe(0.5);
    expect(position.extraValues.contractYearlyDays).toBe(365);
    expect(position.extraValues.salaryAccountCode).toBe("500100");
    // No PII on the load channel — ever.
    expect(JSON.stringify(loaded)).not.toContain("E-1001");

    const pii = getPii(valuesDb, OU_A, SCENARIO);
    expect(pii["pos-1"]?.empNumber).toBe("E-1001");
    expect(pii["pos-1"]?.hiringDate).toBe("2024-05-01");
  });

  it("applies sparse patches with field-level precision", () => {
    createOnePosition(OU_A);
    batchWrite(
      valuesDb,
      OU_A,
      {
        ou: OU_A.ou,
        scenarioId: SCENARIO,
        positionPatches: [
          {
            id: "pos-1",
            fields: {
              monthlyBaseSalary: 3500,
              seasonality: Array(12).fill(1),
              contractYearlyDays: 360,
            },
          },
        ],
        piiPatches: [{ positionId: "pos-1", fields: { lastName: "Renamed" } }],
      },
      lookupFor(OU_A)
    );

    const position = loadScenarioValues(valuesDb, OU_A, SCENARIO).positions[0];
    expect(position.monthlyBaseSalary).toBe(3500);
    expect(position.seasonality).toEqual(Array(12).fill(1));
    expect(position.extraValues.contractYearlyDays).toBe(360);
    // Untouched fields survive the sparse patch.
    expect(position.departmentCode).toBe("D110");
    expect(position.extraValues.salaryAccountCode).toBe("500100");

    const pii = getPii(valuesDb, OU_A, SCENARIO)["pos-1"];
    expect(pii.lastName).toBe("Renamed");
    expect(pii.firstName).toBe("Test");
  });

  it("clears engine scalars to their column default, never NULL", () => {
    createOnePosition(OU_A);
    // Every engine column is NOT NULL, so a cleared cell — whatever its data
    // type — must land as the default rather than fail the whole batch.
    batchWrite(
      valuesDb,
      OU_A,
      {
        ou: OU_A.ou,
        scenarioId: SCENARIO,
        positionPatches: [
          {
            id: "pos-1",
            fields: {
              jobTypeCode: "", // ENUM
              cluster: null, // TEXT
              monthlyBaseSalary: "", // NUMBER
              headcount: null, // NUMBER, defaults to 1 not 0
              increaseMonth: "", // INTEGER, 13 means "no increase"
            },
          },
        ],
      },
      lookupFor(OU_A)
    );

    const position = loadScenarioValues(valuesDb, OU_A, SCENARIO).positions[0];
    expect(position.jobTypeCode).toBe("");
    expect(position.cluster).toBe("");
    expect(position.monthlyBaseSalary).toBe(0);
    expect(position.headcount).toBe(1);
    expect(position.increaseMonth).toBe(13);
  });

  it("rejects unknown field keys instead of dropping them silently", () => {
    createOnePosition(OU_A);
    expect(() =>
      batchWrite(
        valuesDb,
        OU_A,
        {
          ou: OU_A.ou,
          scenarioId: SCENARIO,
          positionPatches: [{ id: "pos-1", fields: { notAField: 1 } }],
        },
        lookupFor(OU_A)
      )
    ).toThrow(/Unknown position field/);
  });

  it("soft-deletes and restores positions with their PII", () => {
    createOnePosition(OU_A);
    batchWrite(
      valuesDb,
      OU_A,
      { ou: OU_A.ou, scenarioId: SCENARIO, softDeleteIds: ["pos-1"] },
      lookupFor(OU_A)
    );
    expect(loadScenarioValues(valuesDb, OU_A, SCENARIO).positions).toHaveLength(0);
    expect(getPii(valuesDb, OU_A, SCENARIO)["pos-1"]).toBeUndefined();

    batchWrite(
      valuesDb,
      OU_A,
      { ou: OU_A.ou, scenarioId: SCENARIO, restoreIds: ["pos-1"] },
      lookupFor(OU_A)
    );
    expect(loadScenarioValues(valuesDb, OU_A, SCENARIO).positions).toHaveLength(1);
    expect(getPii(valuesDb, OU_A, SCENARIO)["pos-1"]?.empNumber).toBe("E-1001");
  });

  it("isolates OUs: rows written under OU A are invisible and unwritable under OU B", () => {
    createOnePosition(OU_A);

    expect(loadScenarioValues(valuesDb, OU_B, SCENARIO).positions).toHaveLength(0);
    expect(getPii(valuesDb, OU_B, SCENARIO)).toEqual({});

    // A leaked row id from another OU patches nothing.
    batchWrite(
      valuesDb,
      OU_B,
      {
        ou: OU_B.ou,
        scenarioId: SCENARIO,
        positionPatches: [{ id: "pos-1", fields: { monthlyBaseSalary: 999999 } }],
        softDeleteIds: ["pos-1"],
      },
      lookupFor(OU_B)
    );
    const position = loadScenarioValues(valuesDb, OU_A, SCENARIO).positions[0];
    expect(position.monthlyBaseSalary).toBe(3000);
  });

  it("binds rows to the scope's OU, ignoring any OU in the payload", () => {
    // The request says OU B in its payload, but the branded scope is OU A —
    // the row must land under OU A.
    batchWrite(
      valuesDb,
      OU_A,
      {
        ou: OU_B.ou,
        scenarioId: SCENARIO,
        creates: [{ id: "pos-x", fields: { departmentCode: "D1" } }],
      },
      lookupFor(OU_A)
    );
    expect(loadScenarioValues(valuesDb, OU_A, SCENARIO).positions).toHaveLength(1);
    expect(loadScenarioValues(valuesDb, OU_B, SCENARIO).positions).toHaveLength(0);
  });
});

describe("engine round trip", () => {
  it("save -> loadScenarioInput -> compile succeeds", async () => {
    const scenario = saveScenario(structureDb, OU_A, {
      year: 2027,
      label: "Budget 2027",
    });

    // Minimal component set: the one required BASE_SALARY definition.
    structureDb
      .prepare(
        `INSERT INTO cost_component_definitions
           (id, ou, kind, label, account_code, department_mode, increase_aware,
            sort_order, updated_at)
         VALUES ('def-base', ?, 'BASE_SALARY', 'Base Salary', '500100',
                 'POSITION', 1, 0, '2026-01-01T00:00:00Z')`
      )
      .run(OU_A.ou);

    batchWrite(
      valuesDb,
      OU_A,
      {
        ou: OU_A.ou,
        scenarioId: scenario.id,
        creates: [
          {
            id: "pos-rt",
            fields: {
              departmentCode: "D110",
              jobTypeCode: "Manager",
              cluster: "Rooms",
              payType: "SALARIED",
              headcount: 1,
              fte: 1,
              monthlyBaseSalary: 2500,
              seasonality: Array(12).fill(1),
              additionalMonthlyCosts: Array(12).fill(0),
              vacationMonthlyWeights: Array(12).fill(1 / 12),
              vacationDays: 30,
              dailyVacationCost: 80,
              dailyContractHours: 8,
              yearlyHoursWorked: 2080,
            },
          },
        ],
      },
      lookupFor(OU_A)
    );

    const input = await loadScenarioInput(
      structureDb,
      valuesDb,
      OU_A,
      scenario.id,
      async () => null // no saved calendar -> default real calendar
    );

    expect(input.positions).toHaveLength(1);
    expect(input.definitions).toHaveLength(1);

    const compiled = compile(input);
    expect("errors" in compiled ? compiled.errors : []).toEqual([]);
  });

  it("refuses to load a scenario that belongs to another OU", async () => {
    const scenario = saveScenario(structureDb, OU_A, { year: 2027, label: "B27" });
    await expect(
      loadScenarioInput(structureDb, valuesDb, OU_B, scenario.id, async () => null)
    ).rejects.toThrow(/not found in this hotel/);
  });
});

describe("cross-year positions", () => {
  const SOURCE = "scn-2026";
  const TARGET = "scn-2027";

  /** Deterministic ids so assertions can name the copies. */
  function sequentialIds(prefix: string) {
    let next = 0;
    return () => `${prefix}-${++next}`;
  }

  function seedTwoPositions() {
    batchWrite(
      valuesDb,
      OU_A,
      {
        ou: OU_A.ou,
        scenarioId: SOURCE,
        creates: [
          {
            id: "pos-keep",
            fields: { departmentCode: "D110", monthlyBaseSalary: 3000 },
            pii: { empNumber: "E-1", firstName: "Ada" },
          },
          {
            id: "pos-off",
            fields: {
              departmentCode: "D120",
              monthlyBaseSalary: 2000,
              active: false,
            },
          },
        ],
      },
      lookupFor(OU_A)
    );
  }

  it("gives every new position its own lineage and starts it active", () => {
    seedTwoPositions();
    const positions = loadScenarioValues(valuesDb, OU_A, SOURCE).positions;
    const keep = positions.find((p) => p.id === "pos-keep");
    const off = positions.find((p) => p.id === "pos-off");

    expect(keep?.lineageId).toBe("pos-keep");
    expect(keep?.active).toBe(true);
    expect(off?.active).toBe(false);
  });

  it("copies a scenario forward with new ids but the same lineage", () => {
    seedTwoPositions();
    const result = cloneScenarioValues(
      valuesDb,
      OU_A,
      SOURCE,
      TARGET,
      sequentialIds("copy")
    );
    expect(result.positions).toBe(2);

    const copies = loadScenarioValues(valuesDb, OU_A, TARGET).positions;
    expect(copies).toHaveLength(2);
    // New identity, carried lineage — that pairing is what makes the same role
    // traceable across years without sharing a row.
    expect(copies.map((p) => p.id).sort()).toEqual(["copy-1", "copy-2"]);
    expect(copies.map((p) => p.lineageId).sort()).toEqual(["pos-keep", "pos-off"]);
    // Inactive positions come across — retaining them is the point of the flag.
    expect(copies.find((p) => p.lineageId === "pos-off")?.active).toBe(false);

    // PII follows its position through the id remap.
    const copiedPii = getPii(valuesDb, OU_A, TARGET);
    const keepCopy = copies.find((p) => p.lineageId === "pos-keep")!;
    expect(copiedPii[keepCopy.id]?.empNumber).toBe("E-1");
  });

  it("keeps the copy independent of its source", () => {
    seedTwoPositions();
    cloneScenarioValues(valuesDb, OU_A, SOURCE, TARGET, sequentialIds("copy"));

    const copy = loadScenarioValues(valuesDb, OU_A, TARGET).positions.find(
      (p) => p.lineageId === "pos-keep"
    )!;
    batchWrite(
      valuesDb,
      OU_A,
      {
        ou: OU_A.ou,
        scenarioId: TARGET,
        positionPatches: [{ id: copy.id, fields: { monthlyBaseSalary: 3300 } }],
      },
      lookupFor(OU_A)
    );

    const source = loadScenarioValues(valuesDb, OU_A, SOURCE).positions.find(
      (p) => p.id === "pos-keep"
    );
    expect(source?.monthlyBaseSalary).toBe(3000);
  });

  it("refuses to copy into a scenario that already has positions", () => {
    seedTwoPositions();
    batchWrite(
      valuesDb,
      OU_A,
      {
        ou: OU_A.ou,
        scenarioId: TARGET,
        creates: [{ id: "pos-existing", fields: { departmentCode: "D1" } }],
      },
      lookupFor(OU_A)
    );

    expect(() =>
      cloneScenarioValues(valuesDb, OU_A, SOURCE, TARGET, sequentialIds("copy"))
    ).toThrow(/already has positions/);
    // The guard runs inside the transaction, so nothing partial is left behind.
    expect(loadScenarioValues(valuesDb, OU_A, TARGET).positions).toHaveLength(1);
  });

  it("never copies across OUs", () => {
    seedTwoPositions();
    const result = cloneScenarioValues(
      valuesDb,
      OU_B,
      SOURCE,
      TARGET,
      sequentialIds("copy")
    );
    expect(result.positions).toBe(0);
    expect(loadScenarioValues(valuesDb, OU_A, TARGET).positions).toHaveLength(0);
  });

  it("keeps inactive positions out of the engine input but in the grid", async () => {
    const scenario = saveScenario(structureDb, OU_A, { year: 2027, label: "B27" });
    batchWrite(
      valuesDb,
      OU_A,
      {
        ou: OU_A.ou,
        scenarioId: scenario.id,
        creates: [
          { id: "pos-on", fields: { departmentCode: "D110" } },
          { id: "pos-off", fields: { departmentCode: "D120", active: false } },
        ],
      },
      lookupFor(OU_A)
    );

    // The grid load keeps both — the row is retained, just not budgeted.
    expect(loadScenarioValues(valuesDb, OU_A, scenario.id).positions).toHaveLength(2);

    const input = await loadScenarioInput(
      structureDb,
      valuesDb,
      OU_A,
      scenario.id,
      async () => null
    );
    expect(input.positions.map((p) => p.id)).toEqual(["pos-on"]);
  });
});

describe("migration runner shape", () => {
  it("upgrades a pre-lineage value store in place", () => {
    // A v2 file: the positions table as it shipped, without the two columns.
    const legacy = new Database(":memory:") as Db;
    legacy.exec(`
      CREATE TABLE positions (
        id TEXT PRIMARY KEY, ou TEXT NOT NULL, scenario_id TEXT NOT NULL,
        department_code TEXT NOT NULL DEFAULT '',
        extra_values TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL, deleted_at TEXT
      );
      INSERT INTO positions (id, ou, scenario_id, updated_at)
      VALUES ('old-1', 'OU12345', 'scn', '2026-01-01T00:00:00Z');
    `);

    applyValueStoreV3(legacy);
    applyValueStoreV3(legacy); // idempotent — re-running must not throw

    const row = legacy
      .prepare("SELECT lineage_id, active FROM positions WHERE id = 'old-1'")
      .get() as { lineage_id: string; active: number };
    // Existing rows are their own lineage root and stay budgeted.
    expect(row.lineage_id).toBe("old-1");
    expect(row.active).toBe(1);
    legacy.close();
  });


  it("value-store DDL is idempotent (re-exec is safe)", () => {
    valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
    valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
    const tables = valuesDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      "buyout_rows",
      "component_values",
      "position_pii",
      "positions",
    ]);
  });

  it("structure-store DDL is idempotent", () => {
    structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
    const tables = structureDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("field_catalog");
    expect(tables.map((t) => t.name)).toContain("scenarios");
  });
});
