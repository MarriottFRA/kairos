/**
 * secure v7 — restating pre-v31 seasonal rows onto the Full year Input Basis.
 *
 * The promise this migration makes is narrow and absolute: no budget number
 * moves. `monthly_base_salary` is the engine's only salary input and the
 * migration never writes it, so what these tests actually pin is (a) that it
 * stays byte-identical, (b) that the Annual FACE is restated so the row still
 * reads back as the same money, and (c) that full-year rows — everybody's
 * ordinary positions — are not touched at all, because every row it touches is a
 * row this device then has to publish.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  POSITIONS_VALUE_TABLES_SQL,
  applyInputBasisRestatement,
} from "../schema";

type Db = InstanceType<typeof Database>;

const MONTHS = 12;
const BEFORE = "2026-01-01T00:00:00.000Z";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(POSITIONS_VALUE_TABLES_SQL);
});

/** Twelve months of 1s, the first `workingMonths` of them worked. */
function seasonality(workingMonths: number): number[] {
  return Array.from({ length: MONTHS }, (_v, m) => (m < workingMonths ? 1 : 0));
}

function insert(
  id: string,
  monthlyBaseSalary: number,
  workingMonths: number,
  extras: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO positions (
       id, ou, scenario_id, lineage_id, department_code, job_type_code,
       seasonality, monthly_base_salary, extra_values, updated_at
     ) VALUES (?, 'OU11111', 's1', ?, '0410', 'Associate', ?, ?, ?, ?)`
  ).run(
    id,
    id,
    JSON.stringify(seasonality(workingMonths)),
    monthlyBaseSalary,
    JSON.stringify(extras),
    BEFORE
  );
}

function read(id: string): {
  monthly: number;
  extras: Record<string, unknown>;
  updatedAt: string;
} {
  const row = db
    .prepare(
      `SELECT monthly_base_salary, extra_values, updated_at FROM positions WHERE id = ?`
    )
    .get(id) as {
    monthly_base_salary: number;
    extra_values: string;
    updated_at: string;
  };
  return {
    monthly: row.monthly_base_salary,
    extras: JSON.parse(row.extra_values) as Record<string, unknown>,
    updatedAt: row.updated_at,
  };
}

describe("seasonal rows are restated, not repriced", () => {
  it("rewrites the Annual face so the monthly figure can stay put", () => {
    // A nine-month row typed as 45,000/yr: 45,000 ÷ 9 = 5,000 a month under the
    // old working-months divisor. On the full-year basis the same 5,000 a month
    // is stated as 60,000 ÷ 12 — a different yearly figure for an identical
    // budget, which is exactly what the contract days beside it always implied.
    insert("seasonal", 5_000, 9, {
      salaryEntryMode: "ANNUAL",
      annualBaseSalary: 45_000,
      annualDivisorBasis: "WORKING_MONTHS",
    });

    applyInputBasisRestatement(db);

    const after = read("seasonal");
    expect(after.monthly).toBe(5_000);
    expect(after.extras.annualDivisorBasis).toBe("TWELVE");
    expect(after.extras.annualBaseSalary).toBe(60_000);
  });

  it("restates a row that never carried the key at all", () => {
    // Written before v19: no basis, no salary entry mode. It read as MONTHLY, so
    // its Annual face was only ever derived at load — there is nothing stored to
    // rewrite, and writing one would be storing a number nobody typed.
    insert("legacy", 5_000, 6, {});

    applyInputBasisRestatement(db);

    const after = read("legacy");
    expect(after.monthly).toBe(5_000);
    expect(after.extras.annualDivisorBasis).toBe("TWELVE");
    expect(after.extras).not.toHaveProperty("annualBaseSalary");
  });

  it("leaves the Annual face alone on a row that types Monthly", () => {
    insert("monthly", 4_000, 6, {
      salaryEntryMode: "MONTHLY",
      annualBaseSalary: 24_000,
      annualDivisorBasis: "WORKING_MONTHS",
    });

    applyInputBasisRestatement(db);

    const after = read("monthly");
    expect(after.monthly).toBe(4_000);
    expect(after.extras.annualDivisorBasis).toBe("TWELVE");
    // Untouched: hydrateBasicSalary re-derives it on the new basis at load.
    expect(after.extras.annualBaseSalary).toBe(24_000);
  });

  it("keeps every other extra value", () => {
    insert("extras", 5_000, 9, {
      salaryEntryMode: "ANNUAL",
      annualBaseSalary: 45_000,
      contractYearlyDays: 365,
      salaryAccountCode: "A501101",
    });

    applyInputBasisRestatement(db);

    const after = read("extras");
    expect(after.extras.contractYearlyDays).toBe(365);
    expect(after.extras.salaryAccountCode).toBe("A501101");
  });
});

describe("rows it must not touch", () => {
  it("does not write a full-year row", () => {
    // The sync guarantee: a plan with no seasonal positions publishes nothing
    // after the upgrade. updated_at is the assertion because the change feed's
    // pending count is a timestamp query.
    insert("full", 5_000, 12, {
      salaryEntryMode: "ANNUAL",
      annualBaseSalary: 60_000,
      annualDivisorBasis: "WORKING_MONTHS",
    });

    applyInputBasisRestatement(db);

    const after = read("full");
    expect(after.updatedAt).toBe(BEFORE);
    expect(after.extras.annualDivisorBasis).toBe("WORKING_MONTHS");
    expect(after.extras.annualBaseSalary).toBe(60_000);
  });

  it("does not write a row whose months add up to 11.999999999", () => {
    // Twelve JSON reals need not sum to exactly 12. Without the epsilon this row
    // would be restated — and published — for a rounding artefact.
    const almost = new Array<number>(MONTHS).fill(1);
    almost[11] = 0.999999999;
    db.prepare(
      `INSERT INTO positions (
         id, ou, scenario_id, lineage_id, department_code, job_type_code,
         seasonality, monthly_base_salary, extra_values, updated_at
       ) VALUES ('drift', 'OU11111', 's1', 'drift', '0410', 'Associate', ?, 5000, '{}', ?)`
    ).run(JSON.stringify(almost), BEFORE);

    applyInputBasisRestatement(db);

    expect(read("drift").updatedAt).toBe(BEFORE);
  });

  it("does not write a row that already says TWELVE", () => {
    insert("already", 5_000, 6, {
      salaryEntryMode: "ANNUAL",
      annualBaseSalary: 60_000,
      annualDivisorBasis: "TWELVE",
    });

    applyInputBasisRestatement(db);

    expect(read("already").updatedAt).toBe(BEFORE);
  });

  it("survives an unreadable blob instead of throwing", () => {
    db.prepare(
      `INSERT INTO positions (
         id, ou, scenario_id, lineage_id, department_code, job_type_code,
         seasonality, monthly_base_salary, extra_values, updated_at
       ) VALUES ('broken', 'OU11111', 's1', 'broken', '0410', 'Associate',
                 'not json', 5000, '{}', ?)`
    ).run(BEFORE);
    insert("good", 5_000, 9, { salaryEntryMode: "ANNUAL", annualBaseSalary: 45_000 });

    expect(() => applyInputBasisRestatement(db)).not.toThrow();
    expect(read("broken").updatedAt).toBe(BEFORE);
    expect(read("good").extras.annualBaseSalary).toBe(60_000);
  });
});

describe("re-running it", () => {
  it("is idempotent — the second pass writes nothing", () => {
    insert("seasonal", 5_000, 9, {
      salaryEntryMode: "ANNUAL",
      annualBaseSalary: 45_000,
      annualDivisorBasis: "WORKING_MONTHS",
    });

    applyInputBasisRestatement(db);
    const once = read("seasonal");
    applyInputBasisRestatement(db);
    const twice = read("seasonal");

    expect(twice).toEqual(once);
    // Specifically: the Annual face is not restated a second time (60,000, not
    // 720,000), because the first pass left the row saying TWELVE.
    expect(twice.extras.annualBaseSalary).toBe(60_000);
  });
});
