/**
 * Cluster positions — sibling rows across the member hotels.
 *
 * Covers the whole life cycle against in-memory databases (the positionsStore
 * pattern): materialise on assignment, peer propagation, what stays per-hotel,
 * delete/restore cascade, unlink, membership changes, block/USER-field
 * translation, and the two scoping rules (planning scenario only, same year).
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { buildFieldMap } from "../../../shared/positions/rowModel";
import { blockCostDefId } from "../../../shared/blocks/ipc";
import { applyStructureColumns } from "../../blocks/schema";
import { applyHotelClustersV13 } from "../../hotelClusters/schema";
import { saveCluster } from "../../hotelClusters/repo";
import {
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
  applyValueStoreV12,
} from "../schema";
import { OuScope, resolveOuScope } from "../ouScope";
import {
  getFieldCatalog,
  saveFieldCatalog,
  saveScenario,
} from "../structureRepo";
import { batchWrite, loadScenarioValues } from "../positionsRepo";
import { adoptIntoGroup, syncClusterMembership } from "../clusterSync";

type Db = InstanceType<typeof Database>;

const HOTEL_A = resolveOuScope("OU11111");
const HOTEL_B = resolveOuScope("OU22222");
const HOTEL_C = resolveOuScope("OU33333");
const YEAR = 2026;

let structureDb: Db;
let valuesDb: Db;

beforeEach(() => {
  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  applyStructureColumns(structureDb);
  applyHotelClustersV13(structureDb);
  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const lookupFor = (scope: OuScope) =>
  buildFieldMap(getFieldCatalog(structureDb, scope));

/** Each hotel's planning scenario for the year. */
function planningScenarios(...scopes: OuScope[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const scope of scopes) {
    out.set(
      scope.ou,
      saveScenario(structureDb, scope, { year: YEAR, label: "Planning" }).id
    );
  }
  return out;
}

function write(
  scope: OuScope,
  scenarioId: string,
  request: Parameters<typeof batchWrite>[2]
) {
  return batchWrite(
    valuesDb,
    scope,
    { ...request, ou: scope.ou, scenarioId },
    lookupFor(scope),
    new Set(collectDefIds(request)),
    structureDb
  );
}

function collectDefIds(request: any): string[] {
  return (request.componentValuePatches ?? []).map(
    (patch: any) => patch.componentDefId
  );
}

function rowsIn(scope: OuScope, scenarioId: string) {
  return loadScenarioValues(valuesDb, scope, scenarioId).positions;
}

/** A block in one hotel, so component values have something to key on. */
function makeBlock(scope: OuScope, id: string, label: string, type = "MULTIPLIER") {
  structureDb
    .prepare(
      `INSERT INTO block_configs (id, ou, block_type, label, config, sort_order, updated_at)
       VALUES (?, ?, ?, ?, '{}', 10, '2026-01-01T00:00:00.000Z')`
    )
    .run(id, scope.ou, type, label);
  return id;
}

/** Assign a fresh position to a cluster — the trigger for materialisation. */
function createAssigned(
  scope: OuScope,
  scenarioId: string,
  clusterId: string,
  fields: Record<string, unknown> = {}
) {
  const id = `pos-${scope.ou}-${Object.keys(fields).length}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const response = write(scope, scenarioId, {
    creates: [
      {
        id,
        fields: {
          departmentCode: "0410",
          jobTypeCode: "Associate",
          monthlyBaseSalary: 3000,
          cluster: clusterId,
          ...fields,
        },
        pii: { title: "Director of HR" },
      },
    ],
  } as any);
  return { id, response };
}

// ---------------------------------------------------------------------------
// Materialise
// ---------------------------------------------------------------------------

describe("materialise", () => {
  it("creates a row in every other member hotel when a position joins a cluster", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B, HOTEL_C);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR Cluster",
        members: [
          { ou: HOTEL_A.ou, weight: 0.4 },
          { ou: HOTEL_B.ou, weight: 0.3 },
          { ou: HOTEL_C.ou, weight: 0.3 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );

    const { id, response } = createAssigned(
      HOTEL_A,
      scenarios.get(HOTEL_A.ou)!,
      clusterId
    );

    expect(response.clusterSync?.created).toHaveLength(2);
    const b = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!);
    const c = rowsIn(HOTEL_C, scenarios.get(HOTEL_C.ou)!);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(b[0].monthlyBaseSalary).toBe(3000);
    expect(b[0].departmentCode).toBe("0410");
    expect(b[0].cluster).toBe(clusterId);

    // One group, three rows, three distinct row ids.
    const a = rowsIn(HOTEL_A, scenarios.get(HOTEL_A.ou)!);
    expect(a[0].clusterLinkId).toBeTruthy();
    expect(b[0].clusterLinkId).toBe(a[0].clusterLinkId);
    expect(c[0].clusterLinkId).toBe(a[0].clusterLinkId);
    expect(new Set([a[0].id, b[0].id, c[0].id]).size).toBe(3);
    expect(a[0].id).toBe(id);
  });

  it("copies the title across, so the mirror is recognisable", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    createAssigned(HOTEL_A, scenarios.get(HOTEL_A.ou)!, clusterId);

    const mirrored = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)[0];
    const pii = valuesDb
      .prepare(`SELECT title FROM position_pii WHERE position_id = ?`)
      .get(mirrored.id) as { title: string };
    expect(pii.title).toBe("Director of HR");
  });

  it("is idempotent — a repeated write does not create a second mirror", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    const { id } = createAssigned(HOTEL_A, scenarios.get(HOTEL_A.ou)!, clusterId);

    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      positionPatches: [{ id, fields: { monthlyBaseSalary: 3100 } }],
    } as any);

    expect(rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)).toHaveLength(1);
  });

  it("does not mirror out of a what-if scenario", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const whatIf = saveScenario(structureDb, HOTEL_A, {
      year: YEAR,
      label: "Aggressive",
    });
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );

    const { response } = createAssigned(HOTEL_A, whatIf.id, clusterId);
    expect(response.clusterSync?.created ?? []).toHaveLength(0);
    expect(rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

describe("propagation", () => {
  function threeHotelGroup() {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B, HOTEL_C);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.4 },
          { ou: HOTEL_B.ou, weight: 0.3 },
          { ou: HOTEL_C.ou, weight: 0.3 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    const { id } = createAssigned(HOTEL_A, scenarios.get(HOTEL_A.ou)!, clusterId);
    return { scenarios, clusterId, aId: id };
  }

  it("pushes an edit made in ANY hotel to the others — there is no home hotel", () => {
    const { scenarios } = threeHotelGroup();
    // Edit from hotel C, the last one to be created.
    const cRow = rowsIn(HOTEL_C, scenarios.get(HOTEL_C.ou)!)[0];
    write(HOTEL_C, scenarios.get(HOTEL_C.ou)!, {
      positionPatches: [{ id: cRow.id, fields: { monthlyBaseSalary: 4200 } }],
    } as any);

    expect(rowsIn(HOTEL_A, scenarios.get(HOTEL_A.ou)!)[0].monthlyBaseSalary).toBe(4200);
    expect(rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)[0].monthlyBaseSalary).toBe(4200);
  });

  it("propagates PII edits", () => {
    const { scenarios, aId } = threeHotelGroup();
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      piiPatches: [{ positionId: aId, fields: { title: "Cluster HR Director" } }],
    } as any);

    const bRow = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)[0];
    const pii = valuesDb
      .prepare(`SELECT title FROM position_pii WHERE position_id = ?`)
      .get(bRow.id) as { title: string };
    expect(pii.title).toBe("Cluster HR Director");
  });

  it("keeps the multiplier override per-hotel — it is only ever this hotel's business", () => {
    const { scenarios, aId } = threeHotelGroup();
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      positionPatches: [{ id: aId, fields: { clusterMultiplierOverride: 0.9 } }],
    } as any);

    expect(
      rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)[0].clusterMultiplierOverride
    ).toBeNull();
  });

  it("does not reach into another YEAR's rows sharing the same link id", () => {
    const { scenarios, aId } = threeHotelGroup();
    const linkId = rowsIn(HOTEL_A, scenarios.get(HOTEL_A.ou)!)[0].clusterLinkId;

    // Simulate a roll-forward: next year's rows carry the link id forward.
    const nextA = saveScenario(structureDb, HOTEL_A, { year: 2027, label: "Planning" });
    const nextB = saveScenario(structureDb, HOTEL_B, { year: 2027, label: "Planning" });
    for (const [scope, scenario] of [
      [HOTEL_A, nextA],
      [HOTEL_B, nextB],
    ] as const) {
      valuesDb
        .prepare(
          `INSERT INTO positions (id, ou, scenario_id, lineage_id, cluster_link_id,
                                  monthly_base_salary, updated_at)
           VALUES (?, ?, ?, ?, ?, 9999, '2026-01-01T00:00:00.000Z')`
        )
        .run(`next-${scope.ou}`, scope.ou, scenario.id, `next-${scope.ou}`, linkId);
    }

    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      positionPatches: [{ id: aId, fields: { monthlyBaseSalary: 5000 } }],
    } as any);

    expect(rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)[0].monthlyBaseSalary).toBe(5000);
    expect(rowsIn(HOTEL_B, nextB.id)[0].monthlyBaseSalary).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// Block inputs — the label-matched half
// ---------------------------------------------------------------------------

describe("block translation", () => {
  function pairWithBlocks(labelInB: string | null, extraInB?: string) {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    const blockA = makeBlock(HOTEL_A, "blk-a", "Pension 5%");
    if (labelInB) makeBlock(HOTEL_B, "blk-b", labelInB);
    if (extraInB) makeBlock(HOTEL_B, "blk-b2", extraInB);
    return { scenarios, clusterId, blockA };
  }

  it("mirrors a block value into the target hotel's block of the same type and label", () => {
    const { scenarios, clusterId, blockA } = pairWithBlocks("pension  5%");
    const id = `pos-block-src`;
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      creates: [{ id, fields: { cluster: clusterId, monthlyBaseSalary: 3000 } }],
      componentValuePatches: [
        { positionId: id, componentDefId: blockCostDefId(blockA), fields: { rate: 5 } },
      ],
    } as any);

    const bRow = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)[0];
    const value = valuesDb
      .prepare(
        `SELECT component_def_id, rate FROM component_values WHERE position_id = ?`
      )
      .get(bRow.id) as { component_def_id: string; rate: number };
    expect(value.component_def_id).toBe(blockCostDefId("blk-b"));
    expect(value.rate).toBe(5);
  });

  it("skips — visibly — when the target hotel has no matching block", () => {
    const { scenarios, clusterId, blockA } = pairWithBlocks(null);
    const id = "pos-block-nomatch";
    const response = write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      creates: [{ id, fields: { cluster: clusterId } }],
      componentValuePatches: [
        { positionId: id, componentDefId: blockCostDefId(blockA), fields: { rate: 5 } },
      ],
    } as any);

    expect(response.clusterSync?.skips).toEqual([
      {
        targetOu: HOTEL_B.ou,
        label: "Pension 5%",
        kind: "BLOCK",
        reason: "NO_MATCH",
      },
    ]);
    const bRow = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)[0];
    const count = valuesDb
      .prepare(`SELECT COUNT(*) AS n FROM component_values WHERE position_id = ?`)
      .get(bRow.id) as { n: number };
    expect(count.n).toBe(0);
  });

  it("refuses to guess when the target hotel has two blocks with that label", () => {
    const { scenarios, clusterId, blockA } = pairWithBlocks("Pension 5%", "Pension 5%");
    const id = "pos-block-ambiguous";
    const response = write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      creates: [{ id, fields: { cluster: clusterId } }],
      componentValuePatches: [
        { positionId: id, componentDefId: blockCostDefId(blockA), fields: { rate: 5 } },
      ],
    } as any);

    expect(response.clusterSync?.skips?.[0]).toMatchObject({
      label: "Pension 5%",
      reason: "AMBIGUOUS",
    });
  });
});

// ---------------------------------------------------------------------------
// User-defined columns
// ---------------------------------------------------------------------------

describe("user columns", () => {
  function userField(scope: OuScope, label: string): string {
    saveFieldCatalog(structureDb, scope, [
      {
        create: {
          section: "pii",
          dataType: "TEXT",
          storage: "POSITION_EXTRA",
          defaultLabel: label,
        },
      } as any,
    ]);
    const field = getFieldCatalog(structureDb, scope).fields.find(
      (candidate) => candidate.origin === "USER" && candidate.defaultLabel === label
    );
    return field!.key;
  }

  it("matches a user column by label, so its value travels under the other hotel's key", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    const keyA = userField(HOTEL_A, "Contract Ref");
    const keyB = userField(HOTEL_B, "contract ref");
    expect(keyA).not.toBe(keyB);

    const id = "pos-user-field";
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      creates: [{ id, fields: { cluster: clusterId, [keyA]: "C-9912" } }],
    } as any);

    const bRow = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)[0];
    expect(bRow.extraValues[keyB]).toBe("C-9912");
  });

  it("reports a skip when the other hotel has no such column, and never creates one", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    const keyA = userField(HOTEL_A, "Contract Ref");

    const id = "pos-user-field-miss";
    const response = write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      creates: [{ id, fields: { cluster: clusterId, [keyA]: "C-9912" } }],
    } as any);

    expect(response.clusterSync?.skips?.[0]).toMatchObject({
      label: "Contract Ref",
      kind: "FIELD",
      reason: "NO_MATCH",
    });
    const bFields = getFieldCatalog(structureDb, HOTEL_B).fields.filter(
      (field) => field.origin === "USER"
    );
    expect(bFields).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Delete / restore / unlink
// ---------------------------------------------------------------------------

describe("delete, restore and unlink", () => {
  function pair() {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    const { id } = createAssigned(HOTEL_A, scenarios.get(HOTEL_A.ou)!, clusterId);
    return { scenarios, clusterId, aId: id };
  }

  it("deleting one hotel's row deletes the whole group", () => {
    const { scenarios, aId } = pair();
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, { softDeleteIds: [aId] } as any);

    expect(rowsIn(HOTEL_A, scenarios.get(HOTEL_A.ou)!)).toHaveLength(0);
    expect(rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)).toHaveLength(0);
  });

  it("undo restores the whole group", () => {
    const { scenarios, aId } = pair();
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, { softDeleteIds: [aId] } as any);
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, { restoreIds: [aId] } as any);

    expect(rowsIn(HOTEL_A, scenarios.get(HOTEL_A.ou)!)).toHaveLength(1);
    expect(rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!)).toHaveLength(1);
  });

  it("clearing the cluster leaves the other hotels' rows standalone — never deletes them", () => {
    const { scenarios, aId } = pair();
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      positionPatches: [{ id: aId, fields: { cluster: "" } }],
    } as any);

    const bRows = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].cluster).toBe("");
    expect(bRows[0].clusterLinkId).toBe("");
    expect(rowsIn(HOTEL_A, scenarios.get(HOTEL_A.ou)!)[0].clusterLinkId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Membership changes
// ---------------------------------------------------------------------------

describe("membership changes", () => {
  it("back-fills a hotel added to a cluster that already has positions", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B, HOTEL_C);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    createAssigned(HOTEL_A, scenarios.get(HOTEL_A.ou)!, clusterId);
    expect(rowsIn(HOTEL_C, scenarios.get(HOTEL_C.ou)!)).toHaveLength(0);

    saveCluster(
      structureDb,
      {
        id: clusterId,
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.4 },
          { ou: HOTEL_B.ou, weight: 0.3 },
          { ou: HOTEL_C.ou, weight: 0.3 },
        ],
      },
      { now: "2026-07-28T00:00:00.000Z" }
    );
    syncClusterMembership(
      { structureDb, valuesDb, stamp: "2026-07-28T00:00:00.000Z" },
      clusterId
    );

    const cRows = rowsIn(HOTEL_C, scenarios.get(HOTEL_C.ou)!);
    expect(cRows).toHaveLength(1);
    expect(cRows[0].monthlyBaseSalary).toBe(3000);
  });

  it("unlinks — never deletes — the rows of a hotel removed from the cluster", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    createAssigned(HOTEL_A, scenarios.get(HOTEL_A.ou)!, clusterId);

    saveCluster(
      structureDb,
      { id: clusterId, name: "HR", members: [{ ou: HOTEL_A.ou, weight: 1 }] },
      { now: "2026-07-28T00:00:00.000Z" }
    );
    syncClusterMembership(
      { structureDb, valuesDb, stamp: "2026-07-28T00:00:00.000Z" },
      clusterId
    );

    const bRows = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].cluster).toBe("");
    expect(bRows[0].clusterLinkId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Adoption (the duplicate fix)
// ---------------------------------------------------------------------------

describe("adopting a hand-made duplicate", () => {
  it("links the standalone row into the group and converges it onto the shared values", () => {
    const scenarios = planningScenarios(HOTEL_A, HOTEL_B);
    const clusterId = saveCluster(
      structureDb,
      {
        name: "HR",
        members: [
          { ou: HOTEL_A.ou, weight: 0.5 },
          { ou: HOTEL_B.ou, weight: 0.5 },
        ],
      },
      { now: "2026-07-27T00:00:00.000Z" }
    );
    const { id: aId } = createAssigned(
      HOTEL_A,
      scenarios.get(HOTEL_A.ou)!,
      clusterId
    );
    const linkId = rowsIn(HOTEL_A, scenarios.get(HOTEL_A.ou)!)[0].clusterLinkId;

    // The duplicate the user typed by hand in hotel B, before clusters existed.
    const dupId = "pos-b-manual";
    write(HOTEL_B, scenarios.get(HOTEL_B.ou)!, {
      creates: [
        {
          id: dupId,
          fields: { departmentCode: "0410", monthlyBaseSalary: 2500 },
          pii: { title: "HR Director" },
        },
      ],
    } as any);

    adoptIntoGroup(
      { structureDb, valuesDb, stamp: "2026-07-28T00:00:00.000Z" },
      linkId,
      dupId,
      HOTEL_B.ou
    );

    const adopted = rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!).find(
      (row) => row.id === dupId
    )!;
    expect(adopted.clusterLinkId).toBe(linkId);
    expect(adopted.cluster).toBe(clusterId);
    expect(adopted.monthlyBaseSalary).toBe(3000); // converged onto the group

    // And it now moves with the group.
    write(HOTEL_A, scenarios.get(HOTEL_A.ou)!, {
      positionPatches: [{ id: aId, fields: { monthlyBaseSalary: 3300 } }],
    } as any);
    expect(
      rowsIn(HOTEL_B, scenarios.get(HOTEL_B.ou)!).find((row) => row.id === dupId)!
        .monthlyBaseSalary
    ).toBe(3300);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("secure v2 migration", () => {
  it("adds cluster_link_id to an existing store and links nothing retroactively", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE positions (
        id TEXT PRIMARY KEY, ou TEXT NOT NULL, scenario_id TEXT NOT NULL,
        cluster TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO positions (id, ou, scenario_id, cluster, updated_at)
         VALUES ('p1', 'OU11111', 's1', 'cluster-1', '2026-01-01T00:00:00.000Z')`
      )
      .run();

    applyValueStoreV12(legacy);
    applyValueStoreV12(legacy); // idempotent

    const row = legacy
      .prepare(`SELECT cluster, cluster_link_id FROM positions WHERE id = 'p1'`)
      .get() as { cluster: string; cluster_link_id: string };
    expect(row.cluster).toBe("cluster-1");
    expect(row.cluster_link_id).toBe("");
  });
});
