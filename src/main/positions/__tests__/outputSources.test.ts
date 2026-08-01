/**
 * Results as a union of four sources.
 * -----------------------------------------------------------
 * The Results page stopped being "whatever the engine produced": manual input,
 * allocations and buyouts post into the same dept × account table. Because the
 * BST push sends exactly these rows, a mistake here reaches a real workbook —
 * so each projector is pinned on the rule that makes it different from the
 * others, plus the read path that merges them and the drill-down that takes
 * them apart again.
 *
 * The buyout case is a regression test: those rows were loaded, compiled,
 * summed into the in-memory aggregate, fingerprinted and scenario-cloned, and
 * then silently dropped on the way to storage, because projectOutputLines only
 * walked positionLines() and a buyout has no position.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { MANUAL_INPUT_TABLES_SQL } from "../../manualInput/schema";
import type { DepartmentAgg } from "../../../shared/allocations/compute";
import {
  computeFingerprint,
  cumulativeStatDefIds,
  projectAllocationLines,
  projectBuyoutLines,
  projectManualLines,
  readOutputLines,
  readOutputs,
  toMonthlyDeltas,
  writeRun,
} from "../outputsRepo";
import { resolveOuScope } from "../ouScope";
import {
  ENGINE_OUTPUTS_SQL,
  POSITIONS_STRUCTURE_TABLES_SQL,
  POSITIONS_VALUE_TABLES_SQL,
} from "../schema";

type Db = InstanceType<typeof Database>;

const OU = "OU12345";
const SCENARIO = "scenario-1";
const scope = resolveOuScope({ ou: OU });
const NOW = "2026-07-28T00:00:00.000Z";

let valuesDb: Db;
let structureDb: Db;

beforeEach(() => {
  valuesDb = new Database(":memory:");
  valuesDb.exec(POSITIONS_VALUE_TABLES_SQL);
  valuesDb.exec(ENGINE_OUTPUTS_SQL);
  valuesDb.exec(MANUAL_INPUT_TABLES_SQL);

  structureDb = new Database(":memory:");
  structureDb.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  structureDb.exec(ALLOCATIONS_SQL);
});

const months = (value: number) => new Array(12).fill(value);

/** A level carried the way the BST reads one: loaded in January, unchanged after. */
const janOnly = (value: number) => [value, ...new Array(11).fill(0)];

function manualRow(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    description: "Agency labour",
    departmentCode: "D0410",
    costAccount: "A500100",
    statsAccount: "A971100",
    rate: null as number | null,
    stats: months(10),
    amounts: months(250),
    ...over,
  };
}

function dept(code: string, headcount: number): DepartmentAgg {
  return {
    departmentCode: code,
    metrics: {
      headcount,
      fte: headcount,
      manhoursWorked: 0,
      manhoursPaid: 0,
      baseSalary: 0,
      contractDays: 0,
      vacationDays: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// The level encoding
// ---------------------------------------------------------------------------

describe("toMonthlyDeltas", () => {
  it("loads a flat level once, in January", () => {
    expect(toMonthlyDeltas(months(5))).toEqual(janOnly(5));
  });

  it("loads a level in the month it first appears", () => {
    const march = [0, 0, ...new Array(10).fill(5)];
    expect(toMonthlyDeltas(march)).toEqual([0, 0, 5, ...new Array(9).fill(0)]);
  });

  it("emits a negative movement when a level drops", () => {
    const leaver = [...new Array(8).fill(5), ...new Array(4).fill(0)];
    expect(toMonthlyDeltas(leaver)).toEqual([5, 0, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0]);
  });

  it("is lossless — the running sum is the original level series", () => {
    const levels = [0, 3, 3, 7, 7, 7, 4, 4, 4, 4, 9, 9];
    const deltas = toMonthlyDeltas(levels);
    let running = 0;
    expect(deltas.map((delta) => (running += delta))).toEqual(levels);
  });

  it("squashes float noise between nominally equal months to a true zero", () => {
    // 100/3 computed twice can differ in the last bits; a split must not read
    // as "January plus eleven microscopic adjustments".
    const third = 100 / 3;
    const noisy = months(third).map((value, m) => (m % 2 ? value + 1e-13 : value));
    expect(toMonthlyDeltas(noisy)).toEqual(janOnly(third));
  });

  it("treats a short or ragged series as zeroes rather than NaN", () => {
    expect(toMonthlyDeltas([2, 2])).toEqual([2, 0, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("cumulativeStatDefIds", () => {
  it("picks the headcount stats and nothing else", () => {
    const ids = cumulativeStatDefIds([
      { id: "sys-poscount:OU", kind: "STAT", statKind: "HEADCOUNT" },
      { id: "sys-stat:OU:HEADCOUNT", kind: "STAT", statKind: "HEADCOUNT" },
      { id: "custom-heads", kind: "STAT", statKind: "HEADCOUNT" },
      // Hours genuinely accrue month by month, and FTE is a ratio — neither is
      // a level the BST accumulates.
      { id: "sys-stat:OU:HOURS", kind: "STAT", statKind: "HOURS" },
      { id: "sys-stat:OU:FTE", kind: "STAT", statKind: "FTE" },
      { id: "base-salary", kind: "BASE_SALARY" },
    ]);
    expect([...ids].sort()).toEqual([
      "custom-heads",
      "sys-poscount:OU",
      "sys-stat:OU:HEADCOUNT",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Manual input
// ---------------------------------------------------------------------------

describe("projectManualLines", () => {
  it("posts the typed amount when there is no rate", () => {
    const lines = projectManualLines([manualRow()]);
    const cost = lines.find((line) => line.componentDefId === "manual:cost")!;
    expect(cost.months).toEqual(months(250));
    expect(cost.total).toBe(3000);
    expect(cost.source).toBe("MANUAL");
    expect(cost.sourceRef).toBe("m1");
  });

  it("derives the amount from stats x rate when a rate is set", () => {
    const lines = projectManualLines([manualRow({ rate: 12.5 })]);
    const cost = lines.find((line) => line.componentDefId === "manual:cost")!;
    // 10 units x 12.5 — the typed amounts (250) are ignored, exactly as the
    // Manual Input grid displays it.
    expect(cost.months).toEqual(months(125));
    expect(cost.detail).toMatchObject({ rateDriven: true, rate: 12.5 });
  });

  it("posts the units to the stats account, unscaled by the rate", () => {
    const lines = projectManualLines([manualRow({ rate: 12.5 })]);
    const stats = lines.find((line) => line.componentDefId === "manual:stats")!;
    expect(stats.account).toBe("A971100");
    expect(stats.months).toEqual(months(10));
  });

  it("skips each side independently when its account is blank", () => {
    expect(
      projectManualLines([manualRow({ costAccount: "" })]).map(
        (line) => line.componentDefId
      )
    ).toEqual(["manual:stats"]);
    expect(
      projectManualLines([manualRow({ statsAccount: "" })]).map(
        (line) => line.componentDefId
      )
    ).toEqual(["manual:cost"]);
    expect(
      projectManualLines([manualRow({ costAccount: "", statsAccount: "" })])
    ).toEqual([]);
  });

  it("falls back to a label when the row has no description", () => {
    const lines = projectManualLines([manualRow({ description: "   " })]);
    expect(lines[0].label).toBe("Manual input");
  });
});

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

describe("projectAllocationLines", () => {
  const departments = [dept("D0410", 3), dept("D0420", 1)];

  it("posts the percentage as a plain number, in January only", () => {
    const lines = projectAllocationLines(
      [
        {
          id: "a1",
          name: "Laundry",
          spreadBase: "HEADCOUNT",
          excludedDepartments: [],
          injectAccount: "A975010",
        },
      ],
      departments
    );

    const front = lines.find((line) => line.dept === "D0410")!;
    // 3 of 4 heads = 75, not 0.75 — a share out of 100, loaded once. The BST
    // reads a split as the running sum of its months, so repeating it would
    // report 900% by December.
    expect(front.months).toEqual(janOnly(75));
    expect(front.total).toBe(75);
    expect(front.account).toBe("A975010");
    expect(front.source).toBe("ALLOCATION");
    expect(front.detail).toMatchObject({ percent: 75, spreadBase: "HEADCOUNT" });
  });

  it("posts an explicit zero for an excluded department", () => {
    const lines = projectAllocationLines(
      [
        {
          id: "a1",
          name: "Laundry",
          spreadBase: "HEADCOUNT",
          excludedDepartments: ["D0410"],
          injectAccount: "A975010",
        },
      ],
      departments
    );

    const excluded = lines.find((line) => line.dept === "D0410")!;
    // Present and zero, not absent: "considered and given nothing" is a
    // different statement from "not considered".
    expect(excluded.months).toEqual(months(0));
    expect(excluded.detail).toMatchObject({ excluded: true });
    // The remaining department re-normalizes to the whole share — 100, in January.
    expect(lines.find((line) => line.dept === "D0420")!.months).toEqual(janOnly(100));
  });

  it("posts nothing when the allocation has no inject account (Blank contract)", () => {
    expect(
      projectAllocationLines(
        [
          {
            id: "a1",
            name: "Laundry",
            spreadBase: "HEADCOUNT",
            excludedDepartments: [],
            injectAccount: "",
          },
        ],
        departments
      )
    ).toEqual([]);
  });

  it("keeps one line per department unique under the composite primary key", () => {
    const lines = projectAllocationLines(
      [
        {
          id: "a1",
          name: "Laundry",
          spreadBase: "FLAT",
          excludedDepartments: [],
          injectAccount: "A975010",
        },
      ],
      departments
    );
    const keys = lines.map((line) => `${line.positionId}|${line.componentDefId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// Buyouts
// ---------------------------------------------------------------------------

describe("projectBuyoutLines", () => {
  it("carries the twelve monthly values verbatim", () => {
    const monthly = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const lines = projectBuyoutLines([
      {
        id: "b1",
        departmentCode: "D0410",
        accountCode: "A988990",
        monthlyValues: monthly,
        deletedAt: null,
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].months).toEqual(monthly);
    expect(lines[0].total).toBe(78);
    expect(lines[0].source).toBe("BUYOUT");
  });

  it("skips blank-account and soft-deleted rows", () => {
    expect(
      projectBuyoutLines([
        {
          id: "b1",
          departmentCode: "D0410",
          accountCode: "",
          monthlyValues: months(5),
          deletedAt: null,
        },
        {
          id: "b2",
          departmentCode: "D0410",
          accountCode: "A988990",
          monthlyValues: months(5),
          deletedAt: NOW,
        },
      ])
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

describe("readOutputs over mixed sources", () => {
  it("merges every source into one dept x account row and reports each origin", () => {
    writeRun(
      valuesDb,
      scope,
      SCENARIO,
      { fingerprint: "fp", computedAt: NOW, positionCount: 1 },
      [
        {
          positionId: "p1",
          componentDefId: "c1",
          label: "Base Salary",
          dept: "D0410",
          account: "A500100",
          months: months(100),
          total: 1200,
          source: "ENGINE",
          sourceRef: "p1",
        },
        ...projectManualLines([
          manualRow({ statsAccount: "", amounts: months(50) }),
        ]),
        ...projectBuyoutLines([
          {
            id: "b1",
            departmentCode: "D0410",
            accountCode: "A500100",
            monthlyValues: months(10),
            deletedAt: null,
          },
        ]),
      ]
    );

    const { rows } = readOutputs(structureDb, valuesDb, scope, SCENARIO);
    expect(rows).toHaveLength(1);
    // 100 engine + 50 manual + 10 buyout, per month.
    expect(rows[0].months[0]).toBe(160);
    expect(rows[0].total).toBe(1920);
    expect(rows[0].sources).toEqual(["ENGINE", "MANUAL", "BUYOUT"]);
    expect(rows[0].valueKind).toBe("currency");
  });

  it("merges spellings of the same combo, because the BST push cannot tell them apart", () => {
    writeRun(
      valuesDb,
      scope,
      SCENARIO,
      { fingerprint: "fp", computedAt: NOW, positionCount: 1 },
      [
        {
          positionId: "p1",
          componentDefId: "c1",
          label: "Base Salary",
          dept: "D0410",
          account: "A500100",
          months: months(100),
          total: 1200,
          source: "ENGINE",
          sourceRef: "p1",
        },
        // Manual Input lets the Dept Code be typed when no mapping tables are
        // loaded — same combo to the workbook, different string here.
        {
          positionId: "manual:m1",
          componentDefId: "manual:cost",
          label: "Overtime",
          dept: "0410",
          account: "500100",
          months: months(50),
          total: 600,
          source: "MANUAL",
          sourceRef: "m1",
        },
      ]
    );

    const { rows } = readOutputs(structureDb, valuesDb, scope, SCENARIO);
    expect(rows).toHaveLength(1);
    expect(rows[0].dept).toBe("D0410");
    expect(rows[0].account).toBe("A500100");
    expect(rows[0].months[0]).toBe(150);
    expect(rows[0].sources).toEqual(["ENGINE", "MANUAL"]);

    // …and the drill-down still finds both, despite being asked in one spelling.
    const lines = readOutputLines(valuesDb, scope, SCENARIO, "D0410", "A500100");
    expect(lines.map((line) => line.source).sort()).toEqual(["ENGINE", "MANUAL"]);
  });

  it("marks an allocation-only row as a percent, but a shared account as a count", () => {
    writeRun(
      valuesDb,
      scope,
      SCENARIO,
      { fingerprint: "fp", computedAt: NOW, positionCount: 0 },
      [
        ...projectAllocationLines(
          [
            {
              id: "a1",
              name: "Laundry",
              spreadBase: "FLAT",
              excludedDepartments: [],
              injectAccount: "A975010",
            },
          ],
          [dept("D0410", 1), dept("D0420", 1)]
        ),
        // A real statistic sharing the allocation's account in one department:
        // the numbers are ordinary counts again and must not be shown as a %.
        {
          positionId: "p1",
          componentDefId: "c1",
          label: "Headcount",
          dept: "D0420",
          account: "A975010",
          months: months(4),
          total: 48,
          source: "ENGINE",
          sourceRef: "p1",
        },
      ]
    );

    const { rows } = readOutputs(structureDb, valuesDb, scope, SCENARIO);
    const pure = rows.find((row) => row.dept === "D0410")!;
    const shared = rows.find((row) => row.dept === "D0420")!;
    expect(pure.valueKind).toBe("percent");
    expect(pure.months[0]).toBeCloseTo(50);
    expect(shared.valueKind).toBe("count");
  });
});

// ---------------------------------------------------------------------------
// The drill-down
// ---------------------------------------------------------------------------

describe("readOutputLines", () => {
  function seedPosition(id: string, jobType: string, headcount: number, pii: {
    title?: string;
    extra?: Record<string, unknown>;
  }) {
    valuesDb
      .prepare(
        `INSERT INTO positions (id, ou, scenario_id, department_code, job_type_code,
           headcount, updated_at) VALUES (?, ?, ?, 'D0410', ?, ?, ?)`
      )
      .run(id, OU, SCENARIO, jobType, headcount, NOW);
    valuesDb
      .prepare(
        `INSERT INTO position_pii (position_id, ou, scenario_id, first_name,
           last_name, title, extra_values, updated_at)
         VALUES (?, ?, ?, 'Anna', 'Kalnina', ?, ?, ?)`
      )
      .run(
        id,
        OU,
        SCENARIO,
        pii.title ?? null,
        JSON.stringify(pii.extra ?? {}),
        NOW
      );
  }

  beforeEach(() => {
    seedPosition("p1", "MGR", 4, { title: "Front Desk Agent" });
    seedPosition("p2", "SUP", 1, { extra: { standardJobTitle: "Night Auditor" } });
    seedPosition("p3", "HRLY", 1, {});

    writeRun(
      valuesDb,
      scope,
      SCENARIO,
      { fingerprint: "fp", computedAt: NOW, positionCount: 3 },
      [
        {
          positionId: "p1",
          componentDefId: "c1",
          label: "Base Salary",
          dept: "D0410",
          account: "A988310",
          months: [10, 900, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
          total: 1010,
          source: "ENGINE",
          sourceRef: "p1",
        },
        {
          positionId: "p2",
          componentDefId: "c1",
          label: "Base Salary",
          dept: "D0410",
          account: "A988310",
          months: months(500),
          total: 6000,
          source: "ENGINE",
          sourceRef: "p2",
        },
        {
          positionId: "p3",
          componentDefId: "c1",
          label: "Base Salary",
          dept: "D0410",
          account: "A988310",
          months: months(1),
          total: 12,
          source: "ENGINE",
          sourceRef: "p3",
        },
      ]
    );
  });

  it("resolves a display name through title -> standard title -> classification", () => {
    const lines = readOutputLines(valuesDb, scope, SCENARIO, "D0410", "A988310");
    const names = lines.map((line) => line.displayName).sort();
    expect(names).toEqual(["Front Desk Agent", "HRLY", "Night Auditor"]);
  });

  it("never exposes an employee name", () => {
    const lines = readOutputLines(valuesDb, scope, SCENARIO, "D0410", "A988310");
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("Anna");
    expect(serialized).not.toContain("Kalnina");
  });

  it("carries the Count so four identical people are not read as one", () => {
    const lines = readOutputLines(valuesDb, scope, SCENARIO, "D0410", "A988310");
    expect(lines.find((line) => line.displayName === "Front Desk Agent")!.headcount).toBe(4);
  });

  it("ranks by the year total by default", () => {
    const lines = readOutputLines(valuesDb, scope, SCENARIO, "D0410", "A988310");
    expect(lines[0].displayName).toBe("Night Auditor"); // 6000
  });

  it("ranks by the chosen month when one is given", () => {
    // February: p1 spikes to 900 and outranks p2's flat 500.
    const lines = readOutputLines(valuesDb, scope, SCENARIO, "D0410", "A988310", 1);
    expect(lines[0].displayName).toBe("Front Desk Agent");
  });

  it("names non-engine lines from their own label, not a position", () => {
    writeRun(
      valuesDb,
      scope,
      SCENARIO,
      { fingerprint: "fp", computedAt: NOW, positionCount: 0 },
      projectManualLines([manualRow({ statsAccount: "" })])
    );
    const lines = readOutputLines(valuesDb, scope, SCENARIO, "D0410", "A500100");
    expect(lines[0].displayName).toBe("Agency labour");
    expect(lines[0].headcount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

describe("computeFingerprint covers the new sources", () => {
  const fingerprint = () =>
    computeFingerprint(structureDb, valuesDb, scope, SCENARIO);

  it("changes when a manual input row is added or edited", () => {
    const before = fingerprint();
    valuesDb
      .prepare(
        `INSERT INTO manual_input_rows (id, ou, scenario_id, created_at, updated_at)
         VALUES ('m1', ?, ?, ?, ?)`
      )
      .run(OU, SCENARIO, NOW, NOW);
    const added = fingerprint();
    expect(added).not.toBe(before);

    valuesDb
      .prepare(`UPDATE manual_input_rows SET updated_at = ? WHERE id = 'm1'`)
      .run("2026-07-29T00:00:00.000Z");
    expect(fingerprint()).not.toBe(added);
  });

  it("changes when an allocation is added or edited", () => {
    const before = fingerprint();
    structureDb
      .prepare(
        `INSERT INTO allocations (id, ou, name, spread_base, updated_at)
         VALUES ('a1', ?, 'Laundry', 'HEADCOUNT', ?)`
      )
      .run(OU, NOW);
    const added = fingerprint();
    expect(added).not.toBe(before);

    structureDb
      .prepare(`UPDATE allocations SET inject_account = 'A975010', updated_at = ? WHERE id = 'a1'`)
      .run("2026-07-29T00:00:00.000Z");
    expect(fingerprint()).not.toBe(added);
  });
});
