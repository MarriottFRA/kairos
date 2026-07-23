/**
 * Positions persistence tests — repositories against in-memory SQLite.
 * Covers: field-catalog seeding (idempotence + user-rename preservation),
 * scenario CRUD, batch-write round-trips, OU isolation, soft delete/restore,
 * and a save→load→compile() round trip through the engine.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { compile } from "../../../shared/engine/compile";
import { simulate } from "../../../shared/engine/simulate";
import { BUDGET_IMPORT_SQL } from "../../budgetImport/schema";
import { KPI_DRIVERS_SQL } from "../../kpiDrivers/schema";
import {
  recomputeAllForOu,
  saveDriver as saveKpiDriver,
} from "../../kpiDrivers/repo";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { SEED_VERSION, SYSTEM_FIELD_SEED } from "../../../shared/positions/fieldSeed";
import {
  applyValueStoreV3,
  applyValueStoreV4,
  applyValueStoreV5,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../schema";
import { applyBlocksStructureV12 } from "../../blocks/schema";
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
import { computeFingerprint, readOutputs, writeRun } from "../outputsRepo";
import { ENGINE_OUTPUTS_SQL } from "../schema";

type Db = InstanceType<typeof Database>;

const OU_A = resolveOuScope("OU12345");
const OU_B = resolveOuScope("OU99999");

let structureDb: Db;
let valuesDb: Db;

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyBlocksStructureV12(structureDb);
  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
  valuesDb.exec(ENGINE_OUTPUTS_SQL);
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

  it("re-applies a changed system dropdownSource when the seed version climbs", () => {
    catalogFor(OU_A); // seeds at the current SEED_VERSION
    // Simulate a catalog left by an older app version (the picker on the code
    // field, no source on the name field), then roll the stored seed_version
    // back so the next read must re-apply the seed.
    const stale = structureDb.prepare(
      `UPDATE field_catalog
          SET dropdown_source = ?, seed_version = ?
        WHERE ou = ? AND field_key = ?`
    );
    stale.run(
      JSON.stringify({ kind: "departments", nameField: "deptName" }),
      SEED_VERSION - 1,
      OU_A.ou,
      "departmentCode"
    );
    stale.run(null, SEED_VERSION - 1, OU_A.ou, "deptName");

    // getFieldCatalog runs ensureFieldCatalogSeed, which must rewrite both stale
    // rows to the current seed: the picker moves onto deptName (with its
    // codeField), and departmentCode loses its source and becomes the read-only
    // code mirror.
    const fields = catalogFor(OU_A).fields;
    expect(fields.find((f) => f.key === "deptName")?.dropdownSource).toEqual({
      kind: "departments",
      codeField: "departmentCode",
    });
    expect(fields.find((f) => f.key === "departmentCode")?.dropdownSource).toBeFalsy();
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

  describe("component value patches (block inputs)", () => {
    const DEFS = new Set(["blk-1:cost", "blk-2:cost"]);

    function patchComponent(
      scope: OuScope,
      patches: Array<{
        positionId: string;
        componentDefId: string;
        fields: Record<string, unknown>;
      }>
    ) {
      return batchWrite(
        valuesDb,
        scope,
        {
          ou: scope.ou,
          scenarioId: SCENARIO,
          componentValuePatches: patches as never,
        },
        lookupFor(scope),
        DEFS
      );
    }

    it("lands in the same batch as the create and round-trips", () => {
      batchWrite(
        valuesDb,
        OU_A,
        {
          ou: OU_A.ou,
          scenarioId: SCENARIO,
          creates: [{ id: "pos-1", fields: { departmentCode: "D110" } }],
          componentValuePatches: [
            { positionId: "pos-1", componentDefId: "blk-1:cost", fields: { yearlyValue: 250 } },
          ],
        },
        lookupFor(OU_A),
        DEFS
      );

      const loaded = loadScenarioValues(valuesDb, OU_A, SCENARIO);
      expect(loaded.componentValues).toHaveLength(1);
      expect(loaded.componentValues[0]).toMatchObject({
        positionId: "pos-1",
        componentDefId: "blk-1:cost",
        yearlyValue: 250,
      });
    });

    it("merges sparse slots across batches and keeps vectors whole", () => {
      createOnePosition(OU_A);
      patchComponent(OU_A, [
        { positionId: "pos-1", componentDefId: "blk-1:cost", fields: { rate: 0.05 } },
      ]);
      patchComponent(OU_A, [
        { positionId: "pos-1", componentDefId: "blk-1:cost", fields: { qty: 12, unitRate: 30 } },
        {
          positionId: "pos-1",
          componentDefId: "blk-2:cost",
          fields: { monthlyValues: [1, 2, 3] },
        },
      ]);

      const values = loadScenarioValues(valuesDb, OU_A, SCENARIO).componentValues;
      const first = values.find((value) => value.componentDefId === "blk-1:cost")!;
      expect(first.rate).toBe(0.05); // earlier slot survives the later patch
      expect(first.qty).toBe(12);
      expect(first.unitRate).toBe(30);
      const second = values.find((value) => value.componentDefId === "blk-2:cost")!;
      expect(second.monthlyValues).toEqual([1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it("round-trips per-row account overrides (TEXT fields)", () => {
      createOnePosition(OU_A);
      patchComponent(OU_A, [
        {
          positionId: "pos-1",
          componentDefId: "blk-1:cost",
          fields: { qty: 5, accountCode: "512345", statsAccountCode: "988111" },
        },
      ]);
      const [value] = loadScenarioValues(valuesDb, OU_A, SCENARIO).componentValues;
      expect(value.accountCode).toBe("512345");
      expect(value.statsAccountCode).toBe("988111");

      // Clearing back to the block default stores NULL.
      patchComponent(OU_A, [
        { positionId: "pos-1", componentDefId: "blk-1:cost", fields: { accountCode: null } },
      ]);
      const [cleared] = loadScenarioValues(valuesDb, OU_A, SCENARIO).componentValues;
      expect(cleared.accountCode).toBeNull();
      expect(cleared.statsAccountCode).toBe("988111");

      expect(() =>
        patchComponent(OU_A, [
          { positionId: "pos-1", componentDefId: "blk-1:cost", fields: { accountCode: 42 } },
        ])
      ).toThrow(/must be a string/);
    });

    it("rejects unknown definitions and junk values", () => {
      createOnePosition(OU_A);
      expect(() =>
        patchComponent(OU_A, [
          { positionId: "pos-1", componentDefId: "ghost", fields: { rate: 1 } },
        ])
      ).toThrow(/Unknown component definition/);
      expect(() =>
        patchComponent(OU_A, [
          { positionId: "pos-1", componentDefId: "blk-1:cost", fields: { rate: "abc" } },
        ])
      ).toThrow(/must be a number/);
    });

    it("cannot attach values to another OU's position", () => {
      createOnePosition(OU_A);
      patchComponent(OU_B, [
        { positionId: "pos-1", componentDefId: "blk-1:cost", fields: { rate: 0.9 } },
      ]);
      expect(loadScenarioValues(valuesDb, OU_A, SCENARIO).componentValues).toHaveLength(0);
      expect(loadScenarioValues(valuesDb, OU_B, SCENARIO).componentValues).toHaveLength(0);
    });

    it("follows the position through soft delete and restore", () => {
      createOnePosition(OU_A);
      patchComponent(OU_A, [
        { positionId: "pos-1", componentDefId: "blk-1:cost", fields: { rate: 0.1 } },
      ]);

      batchWrite(
        valuesDb, OU_A,
        { ou: OU_A.ou, scenarioId: SCENARIO, softDeleteIds: ["pos-1"] },
        lookupFor(OU_A)
      );
      expect(loadScenarioValues(valuesDb, OU_A, SCENARIO).componentValues).toHaveLength(0);

      batchWrite(
        valuesDb, OU_A,
        { ou: OU_A.ou, scenarioId: SCENARIO, restoreIds: ["pos-1"] },
        lookupFor(OU_A)
      );
      const values = loadScenarioValues(valuesDb, OU_A, SCENARIO).componentValues;
      expect(values).toHaveLength(1);
      expect(values[0].rate).toBe(0.1);
    });
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

  it("injects a KPI-driven block as absolute values (series × multiplier)", async () => {
    // KPI + budget tables live beside the structure store in the plaintext DB.
    structureDb.exec(BUDGET_IMPORT_SQL);
    structureDb.exec(KPI_DRIVERS_SQL);

    // Budget: dept D110 revenue (A3) in bucket 1 — Jan 100, Feb 200.
    structureDb
      .prepare(
        `INSERT INTO budget_imports (id, ou, source_filename, imported_at, row_count)
         VALUES ('imp-1', ?, 'f.xlsm', '2026-01-01T00:00:00Z', 0)`
      )
      .run(OU_A.ou);
    const seedVal = structureDb.prepare(
      `INSERT INTO budget_values
         (import_id, ou, dept, account, combo, bucket_index, period, value)
       VALUES ('imp-1', ?, 'D110', 'A3001', 'D110-A3001', 1, ?, ?)`
    );
    seedVal.run(OU_A.ou, 1, 100);
    seedVal.run(OU_A.ou, 2, 200);

    // An EXPLICIT "all departments, A3" driver, then precompute its series.
    saveKpiDriver(structureDb, {
      id: "kpi-rev",
      ou: OU_A.ou,
      label: "Revenue",
      deptMode: "EXPLICIT",
      deptPatterns: ["*"],
      accountPrefixes: ["A3"],
      bucketIndex: 1,
      sortOrder: 0,
      createdBy: null,
      now: "2026-01-01T00:00:00Z",
    });
    recomputeAllForOu(structureDb, OU_A.ou, { computedAt: "2026-01-01T00:00:00Z" });

    const scenario = saveScenario(structureDb, OU_A, { year: 2027, label: "B27" });

    // Mandatory base + a KPI-driven SPREAD block (persisted as DIRECT_ABS).
    structureDb
      .prepare(
        `INSERT INTO cost_component_definitions
           (id, ou, kind, label, account_code, department_mode, increase_aware,
            sort_order, updated_at)
         VALUES ('def-base', ?, 'BASE_SALARY', 'Base Salary', '500100',
                 'POSITION', 1, 0, '2026-01-01T00:00:00Z')`
      )
      .run(OU_A.ou);
    structureDb
      .prepare(
        `INSERT INTO cost_component_definitions
           (id, ou, kind, spread_method, label, account_code, department_mode,
            increase_aware, sort_order, kpi_driver_id, updated_at)
         VALUES ('def-kpi', ?, 'SPREAD', 'DIRECT_ABS', 'KPI Line', '700000',
                 'POSITION', 0, 1, 'kpi-rev', '2026-01-01T00:00:00Z')`
      )
      .run(OU_A.ou);

    // A seasonal position with 2 identical heads — neither must affect the line.
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
              headcount: 2,
              fte: 1,
              monthlyBaseSalary: 2500,
              seasonality: [1, 0.5, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],
              vacationMonthlyWeights: Array(12).fill(1 / 12),
            },
          },
        ],
      },
      lookupFor(OU_A)
    );

    // The per-position multiplier lives in component_values.rate (× 2 here).
    valuesDb
      .prepare(
        `INSERT INTO component_values
           (position_id, component_def_id, ou, scenario_id, rate, updated_at)
         VALUES ('pos-rt', 'def-kpi', ?, ?, 2, '2026-01-01T00:00:00Z')`
      )
      .run(OU_A.ou, scenario.id);

    const input = await loadScenarioInput(
      structureDb,
      valuesDb,
      OU_A,
      scenario.id,
      async () => null
    );

    const compiled = compile(input);
    if (!("plan" in compiled)) throw new Error("compile failed");
    const result = simulate(compiled.plan);

    const kpiLine = result
      .positionLines("pos-rt" as never)
      .find((l) => l.component.id === ("def-kpi" as never))!;

    // series ['*'] = [100, 200, 0, ...] × multiplier 2 = [200, 400, 0, ...],
    // untouched by the Feb 0.5 seasonality or the 2 heads.
    expect(kpiLine.months[0]).toBe(200);
    expect(kpiLine.months[1]).toBe(400);
    expect(Array.from(kpiLine.months.slice(2))).toEqual(Array(10).fill(0));
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

describe("engine outputs", () => {
  const SCENARIO = "scn-out-1";
  const line = (
    positionId: string,
    defId: string,
    dept: string,
    account: string,
    perMonth: number
  ) => ({
    positionId,
    componentDefId: defId,
    label: defId,
    dept,
    account,
    months: new Array(12).fill(perMonth),
    total: perMonth * 12,
  });

  it("aggregates lines to dept×account and tags statistics accounts", () => {
    writeRun(
      valuesDb, OU_A, SCENARIO,
      { fingerprint: "fp-1", computedAt: "2026-01-02T00:00:00Z", positionCount: 2 },
      [
        line("p1", "blk-1:cost", "0410", "511000", 100),
        line("p2", "blk-1:cost", "0410", "511000", 50),
        line("p1", "blk-2:stat", "0410", "988200", 4),
      ]
    );

    const outputs = readOutputs(structureDb, valuesDb, OU_A, SCENARIO);
    expect(outputs.run).toMatchObject({ lineCount: 3, positionCount: 2 });
    expect(outputs.rows).toHaveLength(2);
    const cost = outputs.rows.find((row) => row.account === "511000")!;
    expect(cost.isStats).toBe(false);
    expect(cost.months[0]).toBe(150);
    expect(cost.total).toBe(1800);
    const stat = outputs.rows.find((row) => row.account === "988200")!;
    expect(stat.isStats).toBe(true);
    expect(stat.total).toBe(48);
  });

  it("overwrites wholesale on a new run and isolates OUs", () => {
    writeRun(
      valuesDb, OU_A, SCENARIO,
      { fingerprint: "fp-1", computedAt: "2026-01-02T00:00:00Z", positionCount: 1 },
      [line("p1", "blk-1:cost", "0410", "511000", 100)]
    );
    writeRun(
      valuesDb, OU_A, SCENARIO,
      { fingerprint: "fp-2", computedAt: "2026-01-03T00:00:00Z", positionCount: 1 },
      [line("p1", "blk-1:cost", "0410", "522000", 70)]
    );

    const outputs = readOutputs(structureDb, valuesDb, OU_A, SCENARIO);
    expect(outputs.rows).toHaveLength(1);
    expect(outputs.rows[0].account).toBe("522000");
    expect(readOutputs(structureDb, valuesDb, OU_B, SCENARIO).run).toBeNull();
  });

  it("reports stale when any input source drifts after the run", () => {
    batchWrite(
      valuesDb, OU_A,
      {
        ou: OU_A.ou,
        scenarioId: SCENARIO,
        creates: [{ id: "pos-1", fields: { departmentCode: "D110" } }],
      },
      lookupFor(OU_A)
    );

    const fingerprint = computeFingerprint(structureDb, valuesDb, OU_A, SCENARIO);
    writeRun(
      valuesDb, OU_A, SCENARIO,
      { fingerprint, computedAt: "2026-01-02T00:00:00Z", positionCount: 1 },
      [line("pos-1", "blk-1:cost", "D110", "511000", 10)]
    );
    expect(readOutputs(structureDb, valuesDb, OU_A, SCENARIO).stale).toBe(false);

    // Any input change drifts the fingerprint. A new position is the
    // deterministic case (COUNT moves even within the same millisecond);
    // plain edits drift via MAX(updated_at).
    batchWrite(
      valuesDb, OU_A,
      {
        ou: OU_A.ou,
        scenarioId: SCENARIO,
        creates: [{ id: "pos-2", fields: { departmentCode: "D120" } }],
      },
      lookupFor(OU_A)
    );
    expect(readOutputs(structureDb, valuesDb, OU_A, SCENARIO).stale).toBe(true);
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

  it("backfills hourly_rate on a store that already ran v3", () => {
    // A v3 file as it shipped before hourly_rate existed: lineage/active are
    // present, hourly_rate is not, and the runner would never re-run v3.
    const legacy = new Database(":memory:") as Db;
    legacy.exec(`
      CREATE TABLE positions (
        id TEXT PRIMARY KEY, ou TEXT NOT NULL, scenario_id TEXT NOT NULL,
        lineage_id TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        monthly_base_salary REAL NOT NULL DEFAULT 0,
        extra_values TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL, deleted_at TEXT
      );
      INSERT INTO positions (id, ou, scenario_id, updated_at)
      VALUES ('old-1', 'OU12345', 'scn', '2026-01-01T00:00:00Z');
    `);

    applyValueStoreV4(legacy);
    applyValueStoreV4(legacy); // idempotent — re-running must not throw

    const row = legacy
      .prepare("SELECT hourly_rate FROM positions WHERE id = 'old-1'")
      .get() as { hourly_rate: number };
    expect(row.hourly_rate).toBe(0);
    legacy.close();
  });

  it("drops the derived-rate input columns on a store that still has them", () => {
    // A pre-v5 file: the two now-derived rate columns are present and must go.
    const legacy = new Database(":memory:") as Db;
    legacy.exec(`
      CREATE TABLE positions (
        id TEXT PRIMARY KEY, ou TEXT NOT NULL, scenario_id TEXT NOT NULL,
        daily_vacation_cost REAL NOT NULL DEFAULT 0,
        accrual_cost_per_day REAL NOT NULL DEFAULT 0,
        extra_values TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL, deleted_at TEXT
      );
      INSERT INTO positions (id, ou, scenario_id, updated_at)
      VALUES ('old-1', 'OU12345', 'scn', '2026-01-01T00:00:00Z');
    `);

    applyValueStoreV5(legacy);
    applyValueStoreV5(legacy); // idempotent — re-running must not throw

    const columns = (
      legacy.prepare("PRAGMA table_info(positions)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).not.toContain("daily_vacation_cost");
    expect(columns).not.toContain("accrual_cost_per_day");
    legacy.close();
  });


  it("value-store DDL is idempotent (re-exec is safe)", () => {
    valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
    valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
    valuesDb.exec(ENGINE_OUTPUTS_SQL);
    const tables = valuesDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      "buyout_rows",
      "component_values",
      "engine_output_lines",
      "engine_runs",
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
