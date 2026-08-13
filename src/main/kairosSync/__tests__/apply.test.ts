/**
 * Applying a pulled page into the local stores.
 *
 * The three rules with teeth: apply in the server's order, soft-delete rather
 * than remove, and never invent a row for a tombstone we never had.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../../positions/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import { applyEntities } from "../apply";
import { ChangeEntity } from "../../../shared/kairosSync/protocol";
import { FALLBACK_APPLY_ORDER } from "../../../shared/kairosSync/entityMap";

type Db = InstanceType<typeof Database>;

const OU = "OU25RJ2";
const PLAN = "plan-1";

function makeStores(): { localDb: Db; secureDb: Db } {
  const localDb = new Database(":memory:");
  localDb.pragma("foreign_keys = ON");
  localDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  const secureDb = new Database(":memory:");
  // The production stores run with FKs on; without this the constraint these
  // tests exist to exercise is silently not enforced.
  secureDb.pragma("foreign_keys = ON");
  secureDb.exec(POSITIONS_VALUE_TABLES_SQL);
  secureDb.exec(MANUAL_INPUT_TABLES_SQL);
  secureDb.exec(ENGINE_OUTPUTS_SQL);
  return { localDb, secureDb };
}

function positionEntity(id: string, overrides: Partial<ChangeEntity> = {}): ChangeEntity {
  return {
    entityType: "position",
    entityId: id,
    parentId: null,
    department: "D0410",
    deleted: false,
    clientUpdatedAt: "2026-07-01T00:00:00.000Z",
    serverSeq: 1,
    payload: {
      id,
      ou: OU,
      scenarioId: PLAN,
      lineageId: "",
      active: true,
      departmentCode: "D0410",
      jobTypeCode: "",
      cluster: "",
      clusterMultiplierOverride: null,
      clusterLinkId: "",
      payType: "SALARIED",
      headcount: 1,
      fte: 1,
      seasonality: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      monthlyBaseSalary: 3000,
      hourlyRate: 0,
      additionalMonthlyCosts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      meritIncreasePct: 0,
      manualYearlyIncrease: 0,
      increaseMonth: 13,
      dailyContractHours: 8,
      yearlyHoursWorked: 1800,
      vacationDays: 25,
      vacationMonthlyWeights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      accrualDaysPerMonth: 0,
      extraValues: {},
      updatedAt: "2026-07-01T00:00:00.000Z",
      deletedAt: null,
    },
    ...overrides,
  };
}

function componentValueEntity(positionId: string, defId: string): ChangeEntity {
  return {
    entityType: "component_value",
    entityId: `${positionId}:${defId}`,
    parentId: positionId,
    department: null,
    deleted: false,
    clientUpdatedAt: "2026-07-01T00:00:00.000Z",
    serverSeq: 2,
    payload: {
      positionId,
      componentDefId: defId,
      ou: OU,
      scenarioId: PLAN,
      rate: 0.07,
      yearlyValue: null,
      monthlyValues: null,
      qty: null,
      unitRate: null,
      ssOpeningBase: null,
      accountCode: null,
      statsAccountCode: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
      deletedAt: null,
    },
  };
}

describe("applyEntities", () => {
  it("inserts a pulled position", () => {
    const stores = makeStores();
    const result = applyEntities(stores, [positionEntity("p1")], FALLBACK_APPLY_ORDER);

    expect(result.applied).toBe(1);
    const row = stores.secureDb
      .prepare(`SELECT id, department_code, monthly_base_salary FROM positions`)
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: "p1",
      department_code: "D0410",
      monthly_base_salary: 3000,
    });
  });

  it("updates an existing row rather than duplicating it", () => {
    const stores = makeStores();
    applyEntities(stores, [positionEntity("p1")], FALLBACK_APPLY_ORDER);
    applyEntities(
      stores,
      [
        positionEntity("p1", {
          payload: { ...positionEntity("p1").payload, monthlyBaseSalary: 4000 },
        }),
      ],
      FALLBACK_APPLY_ORDER
    );

    const rows = stores.secureDb
      .prepare(`SELECT monthly_base_salary FROM positions`)
      .all() as Array<{ monthly_base_salary: number }>;
    expect(rows).toEqual([{ monthly_base_salary: 4000 }]);
  });

  it("soft-deletes a tombstone rather than removing the row", () => {
    // A hard delete would break the lineage_id history that carries a role from
    // one budget year to the next.
    const stores = makeStores();
    applyEntities(stores, [positionEntity("p1")], FALLBACK_APPLY_ORDER);
    const result = applyEntities(
      stores,
      [positionEntity("p1", { deleted: true, payload: null })],
      FALLBACK_APPLY_ORDER
    );

    expect(result.deleted).toBe(1);
    const row = stores.secureDb
      .prepare(`SELECT id, deleted_at FROM positions WHERE id = 'p1'`)
      .get() as { id: string; deleted_at: string | null };
    expect(row.id).toBe("p1");
    expect(row.deleted_at).not.toBeNull();
  });

  it("does not create a phantom row for a tombstone it never held", () => {
    // Inserting a stub would key a row on nothing, and the next manifest would
    // report it as a difference forever.
    const stores = makeStores();
    applyEntities(
      stores,
      [positionEntity("never-seen", { deleted: true, payload: null })],
      FALLBACK_APPLY_ORDER
    );
    const count = stores.secureDb
      .prepare(`SELECT COUNT(*) AS total FROM positions`)
      .get() as { total: number };
    expect(count.total).toBe(0);
  });

  it("lets the server's deleted flag win over a stale payload", () => {
    const stores = makeStores();
    applyEntities(
      stores,
      [positionEntity("p1", { deleted: true })], // payload still says deletedAt null
      FALLBACK_APPLY_ORDER
    );
    const row = stores.secureDb
      .prepare(`SELECT deleted_at FROM positions WHERE id = 'p1'`)
      .get() as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
  });

  it("applies parents before children whatever order they arrive in", () => {
    // The FK on component_values means a child written first would fail outright.
    const stores = makeStores();

    // Child listed FIRST — the apply order has to correct it.
    const result = applyEntities(
      stores,
      [componentValueEntity("p1", "def-1"), positionEntity("p1")],
      FALLBACK_APPLY_ORDER
    );
    expect(result.applied).toBe(2);
    const stored = stores.secureDb
      .prepare(`SELECT rate FROM component_values WHERE position_id = 'p1'`)
      .get() as { rate: number };
    expect(stored.rate).toBe(0.07);
  });

  it("defers a child whose parent is on a later page, and applies it on retry", () => {
    // /changes orders rows by server sequence, and each page commits alone —
    // so a component value can arrive a page ahead of its position.
    const stores = makeStores();
    const child = componentValueEntity("p9", "def-1");

    const first = applyEntities(stores, [child], FALLBACK_APPLY_ORDER, {
      deferMissingParents: true,
    });
    expect(first.deferred).toHaveLength(1);
    expect(first.applied).toBe(0);
    expect(
      stores.secureDb.prepare(`SELECT COUNT(*) AS total FROM component_values`).get()
    ).toEqual({ total: 0 });

    // The "later page" with the parent, then the caller's retry of the deferred.
    applyEntities(stores, [positionEntity("p9")], FALLBACK_APPLY_ORDER);
    const retry = applyEntities(stores, first.deferred, FALLBACK_APPLY_ORDER);
    expect(retry.applied).toBe(1);
    const stored = stores.secureDb
      .prepare(`SELECT rate FROM component_values WHERE position_id = 'p9'`)
      .get() as { rate: number };
    expect(stored.rate).toBe(0.07);
  });

  it("names the row and the missing parent when deferral is not allowed", () => {
    // The retry pass runs without deferral: a parent still missing after the
    // last page was never sent, and the error has to say which row died.
    const stores = makeStores();
    expect(() =>
      applyEntities(stores, [componentValueEntity("ghost", "def-1")], FALLBACK_APPLY_ORDER)
    ).toThrow(/component_value ghost:def-1.*position ghost is not on this computer/s);
  });

  it("writes a scenario to the plaintext store, not the encrypted one", () => {
    const stores = makeStores();
    applyEntities(
      stores,
      [
        {
          entityType: "scenario",
          entityId: PLAN,
          parentId: null,
          department: null,
          deleted: false,
          clientUpdatedAt: "2026-07-01T00:00:00.000Z",
          serverSeq: 1,
          payload: {
            id: PLAN,
            ou: OU,
            year: 2026,
            label: "Budget",
            updatedAt: "2026-07-01T00:00:00.000Z",
            deletedAt: null,
          },
        },
      ],
      FALLBACK_APPLY_ORDER
    );
    const row = stores.localDb
      .prepare(`SELECT label FROM scenarios WHERE id = ?`)
      .get(PLAN) as { label: string };
    expect(row.label).toBe("Budget");
  });

  it("skips a type this build does not understand instead of guessing", () => {
    // A newer server adding an entity type is not a reason to write rows into
    // tables we know nothing about.
    const stores = makeStores();
    const result = applyEntities(
      stores,
      [
        {
          entityType: "some_future_type",
          entityId: "x",
          parentId: null,
          department: null,
          deleted: false,
          clientUpdatedAt: null,
          serverSeq: 1,
          payload: { anything: true },
        },
      ],
      FALLBACK_APPLY_ORDER
    );
    expect(result.skippedTypes).toEqual(["some_future_type"]);
    expect(result.applied).toBe(0);
  });
});
