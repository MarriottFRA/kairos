/**
 * The two accounts a Classification decides.
 * -----------------------------------------------------------
 * Both hang off the same field (jobTypeCode) and are deliberately NOT the same
 * kind of thing, which is the distinction this file exists to hold:
 *
 *   Headcount     — DERIVED. A calculated column; nothing is stored and nothing
 *                   on the row can contradict it (see positionAccounts.test.ts,
 *                   which walks it all the way to a compiled line).
 *   Working Hours — DEFAULTED. A normal editable pick that the grade fills in;
 *                   a post booking somewhere special keeps what the user chose.
 *
 * So the tests below are mostly about the second one's edges: when the default
 * applies, when it must not, and that it never fights a hand-picked account.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG, JOB_TYPE_OPTIONS } from "../fieldSeed";
import { ACCOUNT_FIELD_KEYS, accountAllowed } from "../fields";
import { PositionRow, sanitizeRow } from "../rowModel";
import {
  headcountAccountForJobType,
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE,
  STAFFING_ACCOUNT_FILTER,
  STATS_ACCOUNT_FILTER,
  workingHoursAccountForJobType,
  WORKING_HOURS_ACCOUNT_BY_JOB_TYPE,
} from "../systemAccounts";

const HOURS = ACCOUNT_FIELD_KEYS.hours;

/** A row carrying just what these rules read. */
function rowWith(overrides: Partial<PositionRow> = {}): PositionRow {
  return { id: "p1", payType: "SALARIED", increaseMonth: 13, ...overrides };
}

/** Commit `changes` onto `before` the way the grid does. */
function commit(before: PositionRow, changes: Partial<PositionRow>): PositionRow {
  return sanitizeRow({ ...before, ...changes }, before, BUILTIN_CATALOG);
}

describe("Working Hours account defaults from the Classification", () => {
  it("fills the grade's account when the Classification is picked", () => {
    const cases: Array<[string, string | null]> = [
      ["Manager", "A988308"],
      ["Manager (Non Exempt)", "A988308"],
      ["Supervisor", "A988699"],
      ["Associate", "A988699"],
      ["Casual", "A988699"],
      // Bought-in hours are not staffed, so the grade books none — and the
      // default has to be able to say that, not just leave the last value.
      ["Buyout Labour", null],
    ];
    for (const [jobTypeCode, account] of cases) {
      const out = commit(rowWith({ jobTypeCode: null, [HOURS]: null }), {
        jobTypeCode,
      });
      expect(out[HOURS]).toBe(account);
    }
  });

  it("refills when the Classification changes, including back to none", () => {
    const associate = commit(rowWith({ jobTypeCode: null }), {
      jobTypeCode: "Associate",
    });
    expect(associate[HOURS]).toBe("A988699");

    const promoted = commit(associate, { jobTypeCode: "Manager" });
    expect(promoted[HOURS]).toBe("A988308");

    const boughtIn = commit(promoted, { jobTypeCode: "Buyout Labour" });
    expect(boughtIn[HOURS]).toBeNull();
  });

  it("leaves a hand-picked account alone on every later edit", () => {
    // The whole reason this is a default and not a derivation: a post that books
    // somewhere special must survive the next edit to any other column.
    const special = commit(
      commit(rowWith({ jobTypeCode: "Associate" }), { jobTypeCode: "Manager" }),
      { [HOURS]: "A988777" }
    );
    expect(special[HOURS]).toBe("A988777");

    const later = commit(special, { monthlyBaseSalary: 4200 });
    expect(later[HOURS]).toBe("A988777");
  });

  it("does not overwrite an account set in the same commit as the grade", () => {
    // A pasted row carrying both means both — the more specific of the two wins.
    const out = commit(rowWith({ jobTypeCode: "Associate", [HOURS]: "A988699" }), {
      jobTypeCode: "Manager",
      [HOURS]: "A988777",
    });
    expect(out[HOURS]).toBe("A988777");
  });

  it("re-applies the grade's default over a custom account when the grade moves", () => {
    // The flip side of the rule above: once the post is a different grade, the
    // account it used to book to is no longer the better answer.
    const special = commit(rowWith({ jobTypeCode: "Manager" }), {
      [HOURS]: "A988777",
    });
    expect(commit(special, { jobTypeCode: "Supervisor" })[HOURS]).toBe("A988699");
  });

  it("stays editable — the field is stored, not calculated", () => {
    const def = BUILTIN_CATALOG.fields.find((field) => field.key === HOURS)!;
    expect(def.storage).toBe("POSITION_EXTRA");
    expect(def.editable).toBe(true);
    // ...and its picker offers the staffing family, not the whole stats range.
    expect(def.dropdownSource).toEqual({
      kind: "accounts",
      filter: STAFFING_ACCOUNT_FILTER,
    });
  });

  it("keeps the Headcount account calculated, not defaulted", () => {
    const def = BUILTIN_CATALOG.fields.find(
      (field) => field.key === ACCOUNT_FIELD_KEYS.headcount
    )!;
    expect(def.storage).toBe("COMPUTED");
    expect(def.editable).toBe(false);
    expect(def.dropdownSource).toBeUndefined();
    // Nothing is written for it, so a grade change cannot leave a value behind.
    const out = commit(rowWith({ jobTypeCode: "Associate" }), {
      jobTypeCode: "Manager",
    });
    expect(out[ACCOUNT_FIELD_KEYS.headcount]).toBeUndefined();
  });
});

describe("the per-grade account tables", () => {
  const TABLES = [
    ["headcount", HEADCOUNT_ACCOUNT_BY_JOB_TYPE],
    ["working hours", WORKING_HOURS_ACCOUNT_BY_JOB_TYPE],
  ] as const;

  it("maps only real classifications", () => {
    // The tables live in systemAccounts (the engine paths import them) while the
    // Classification list lives in the field seed, so nothing but this stops the
    // two forking — a renamed grade would silently stop booking.
    const grades = new Set(JOB_TYPE_OPTIONS.map((option) => option.value));
    for (const [, table] of TABLES) {
      for (const grade of Object.keys(table)) expect(grades.has(grade)).toBe(true);
    }
  });

  it("books only to staffing statistics accounts", () => {
    for (const [, table] of TABLES) {
      for (const account of Object.values(table)) {
        // Counts and hours belong on the Statistics side of Results...
        expect(accountAllowed(account, STATS_ACCOUNT_FILTER)).toBe(true);
        // ...and inside the A988 family the Working Hours picker offers, so a
        // defaulted account is always one the user could have picked themselves.
        expect(accountAllowed(account, STAFFING_ACCOUNT_FILTER)).toBe(true);
      }
    }
  });

  it("invents nothing for a grade it does not name", () => {
    for (const jobTypeCode of ["", "Chief Wizard", "  ", null, undefined, 7]) {
      expect(headcountAccountForJobType(jobTypeCode)).toBe("");
      expect(workingHoursAccountForJobType(jobTypeCode)).toBe("");
    }
  });
});
