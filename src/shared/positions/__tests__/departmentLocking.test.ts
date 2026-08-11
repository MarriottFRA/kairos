/**
 * The grid's department lock.
 *
 * Once a plan is published and departments are delegated, the grid must let the
 * user edit exactly what a save would accept — no more, and no less. The server
 * hands us that answer as `writable` on `/department-ownership`, where it IS the
 * write predicate, so the only way to be wrong here is to apply it wrongly.
 *
 * Four cases carry real consequences:
 *
 * - **No policy at all means unrestricted.** A plan that was never published has
 *   no server-side authority to consult, and a hotel that never opts into sync
 *   must not notice this code exists.
 * - **An empty allow-list means nothing is writable**, which is the opposite.
 *   Confusing the two either locks an offline hotel out of its own file or hands
 *   a revoked delegate a fully editable grid.
 * - **An unmentioned department is not a refused one.** `/department-ownership`
 *   enumerates only departments that already have rows, so a full-scope owner
 *   gets an open ceiling and a deny-list. Read as an allow-list it locked them
 *   out of any department they had just opened — and, because the publish filter
 *   read the same answer, the row was withheld, the department never gained
 *   rows, and it was therefore never enumerated. See `departmentWritePolicy`.
 * - **A row with no department stays editable, and stays unpublishable.** The
 *   server routes department-less rows to the owner-only branch, and
 *   `filterToWriteScope` withholds them locally — but LOCKING them in the grid
 *   meant a delegate could not give a row they had just created a department at
 *   all, because the lock covered the picker. The publish rule is unchanged;
 *   only the editor's.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG } from "../fieldSeed";
import { DEPARTMENT_CODE_KEY } from "../fields";
import { PositionRow } from "../rowModel";
import { staticDerivedRowValues } from "../derivedRowValues";
import {
  EditabilityContext,
  buildColumns,
  cellEditable,
} from "../../../components/positions/columnFactory";
import { departmentUnassigned, rowDepartmentWritable } from "../writeScope";
import { allowOnly, departmentWritePolicy } from "../../kairosSync/writePolicy";
import type { DepartmentOwnership } from "../../kairosSync/protocol";

const OU = "OU25RJ2";

const maskableKeys = new Set(
  BUILTIN_CATALOG.fields.filter((field) => field.maskable).map((field) => field.key)
);

/** An ordinary editable column to ask about. */
function anyEditableColumn() {
  const columns = buildColumns(BUILTIN_CATALOG, {
    masked: false,
    numberFormat: new Intl.NumberFormat(),
    departments: [],
    accounts: [],
    derived: staticDerivedRowValues(),
    hotelClusters: [],
    currentOu: OU,
  });
  const column = columns.find(
    (candidate) => candidate.editable !== false && candidate.field === "jobTypeCode"
  );
  if (!column) throw new Error("expected an editable column in the built-in catalog");
  return column;
}

function row(department: string): PositionRow {
  return { id: "p1", [DEPARTMENT_CODE_KEY]: department } as PositionRow;
}

/** A fresh context each time — the resolver caches per context object. */
function ctx(extra: Partial<EditabilityContext> = {}): EditabilityContext {
  return {
    masked: false,
    maskableKeys,
    hotelClusters: [],
    currentOu: OU,
    ...extra,
  };
}

describe("department write scope", () => {
  const column = anyEditableColumn();

  it("leaves everything editable when the plan was never published", () => {
    // undefined, not an empty set. This is the offline hotel's normal state.
    expect(cellEditable(row("D0410"), column, ctx())).toBe(true);
    expect(cellEditable(row(""), column, ctx())).toBe(true);
  });

  it("allows a department the user holds", () => {
    expect(
      cellEditable(row("D0410"), column, ctx({ writePolicy: allowOnly(["D0410"]) }))
    ).toBe(true);
  });

  it("locks a department the user does not hold", () => {
    expect(
      cellEditable(row("D0610"), column, ctx({ writePolicy: allowOnly(["D0410"]) }))
    ).toBe(false);
  });

  it("locks a department the OWNER has delegated to an ACTIVE delegate", () => {
    // The server reports writable:false for it, and the owner's route back is to
    // withdraw the delegation. Per the brief, and not a bug.
    //
    // ACTIVE is the load-bearing word — see the next test.
    const asOwnerWithRoomsDelegated = ctx({
      writePolicy: allowOnly(["D0610", "D0710"]),
    });
    expect(cellEditable(row("D0410"), column, asOwnerWithRoomsDelegated)).toBe(false);
    expect(cellEditable(row("D0610"), column, asOwnerWithRoomsDelegated)).toBe(true);
  });

  it("unlocks a department for the OWNER once the delegate hands it back", () => {
    // The case this file used to name and decline to cover, on the reasoning
    // that there was nothing here to test. There is: it is the behaviour a real
    // owner reported missing, and the reason it was missing is that the SET
    // arriving here was stale, not that this predicate was wrong.
    //
    // Once the last ACTIVE holder goes the server returns the department as
    // `writable: true, reason: null`, so it arrives in the set like any other
    // and no withdrawal is needed. The grid must not second-guess that in
    // either direction — a client that unlocked on its own would produce edits
    // `filterToWriteScope` withholds at publish without a word.
    const afterHandback = ctx({
      writePolicy: allowOnly(["D0410", "D0610", "D0710"]),
    });
    expect(cellEditable(row("D0410"), column, afterHandback)).toBe(true);
  });

  it("leaves a row with no department editable so a delegate can give it one", () => {
    // Deliberately inverted. Locking it covered the department picker itself, so
    // a row a delegate had just created could never be classified — not through
    // the grid, the row form, or a paste. It stays unpublishable either way;
    // `filterToWriteScope` is what enforces that, and it has not changed.
    expect(
      cellEditable(row(""), column, ctx({ writePolicy: allowOnly(["D0410"]) }))
    ).toBe(true);
  });

  it("still locks an unassigned row when the writable set is empty", () => {
    // A revoked delegate must not gain an editing surface out of the change
    // above. Nothing to assign it to means nothing to unlock.
    expect(
      cellEditable(row(""), column, ctx({ writePolicy: allowOnly([]) }))
    ).toBe(false);
  });

  it("still locks an unassigned row while an administrator holds the plan", () => {
    expect(
      cellEditable(
        row(""),
        column,
        ctx({ writePolicy: allowOnly(["D0410"]), planLocked: true })
      )
    ).toBe(false);
  });

  it("locks everything when the set is empty", () => {
    // A revoked delegate. Emphatically NOT the same as undefined.
    expect(
      cellEditable(row("D0410"), column, ctx({ writePolicy: allowOnly([]) }))
    ).toBe(false);
  });

  it("locks everything while the plan is held by an administrator", () => {
    expect(
      cellEditable(
        row("D0410"),
        column,
        ctx({ writePolicy: allowOnly(["D0410"]), planLocked: true })
      )
    ).toBe(false);
  });

  it("still honours the older rules inside a writable department", () => {
    // The department gate is additive: it must not accidentally unlock a masked
    // PII cell or a computed column just because the row is editable.
    const maskedKey = [...maskableKeys][0];
    const columns = buildColumns(BUILTIN_CATALOG, {
      masked: true,
      numberFormat: new Intl.NumberFormat(),
      departments: [],
      accounts: [],
      derived: staticDerivedRowValues(),
      hotelClusters: [],
      currentOu: OU,
    });
    const maskedColumn = columns.find((candidate) => candidate.field === maskedKey);
    if (!maskedColumn) return;

    expect(
      cellEditable(
        row("D0410"),
        maskedColumn,
        ctx({ masked: true, writePolicy: allowOnly(["D0410"]) })
      )
    ).toBe(false);
  });

  it("gives the same answer every time for the same row and context", () => {
    // The resolver caches per (context, row); a cache that answered differently
    // on the second call would make the grid flicker between editable and not.
    const scope = ctx({ writePolicy: allowOnly(["D0410"]) });
    const target = row("D0410");
    const other = row("D0610");
    for (let index = 0; index < 5; index += 1) {
      expect(cellEditable(target, column, scope)).toBe(true);
      expect(cellEditable(other, column, scope)).toBe(false);
    }
  });

  it("picks up a new answer when the context object changes", () => {
    // A revoked delegation must lock the grid on the next render, not at the
    // next remount — which works because a new ownership answer builds a new ctx.
    const before = ctx({ writePolicy: allowOnly(["D0410"]) });
    const after = ctx({ writePolicy: allowOnly([]) });
    const target = row("D0410");

    expect(cellEditable(target, column, before)).toBe(true);
    expect(cellEditable(target, column, after)).toBe(false);
  });
});

/**
 * The row form applies the same rules as the grid.
 *
 * `PositionFormDialog` builds its own `EditabilityContext` and calls the same
 * `cellEditable`. It used to omit `writePolicy` and `planLocked`, which
 * made it a hole straight through the lock: every field on a delegated row came
 * back editable and the form's commits went into the same write queue as the
 * grid's. These pin the two together — the point of sharing the predicate is
 * that a rule cannot be present in one caller and missing from the other.
 */
describe("the row form and the grid agree", () => {
  const column = anyEditableColumn();

  it("locks a delegated row in a context built without a cluster map", () => {
    // The form omits `clusterById` (it is a hot-path optimisation the grid
    // needs and the form does not). That must not change the answer.
    const formCtx: EditabilityContext = {
      masked: false,
      maskableKeys,
      hotelClusters: [],
      currentOu: OU,
      writePolicy: allowOnly(["D0410"]),
    };
    expect(cellEditable(row("D0410"), column, formCtx)).toBe(true);
    expect(cellEditable(row("D0610"), column, formCtx)).toBe(false);
  });

  it("honours planLocked from the form context too", () => {
    const formCtx: EditabilityContext = {
      masked: false,
      maskableKeys,
      hotelClusters: [],
      currentOu: OU,
      writePolicy: allowOnly(["D0410"]),
      planLocked: true,
    };
    expect(cellEditable(row("D0410"), column, formCtx)).toBe(false);
  });

  it("stays unrestricted when the plan was never published", () => {
    // The form is reached on an offline hotel too, and must behave exactly as it
    // did before sync existed.
    const formCtx: EditabilityContext = {
      masked: false,
      maskableKeys,
      hotelClusters: [],
      currentOu: OU,
    };
    expect(cellEditable(row(""), column, formCtx)).toBe(true);
    expect(cellEditable(row("D0610"), column, formCtx)).toBe(true);
  });
});

/**
 * One predicate, three callers.
 *
 * The rule used to be written out three times — the cell resolver, the row-menu
 * guard, and the save backstop — which is three chances for the grid to offer an
 * edit the save then refuses. They all call `rowDepartmentWritable` now, and
 * this asserts the two remaining entry points cannot drift apart again.
 */
describe("cellEditable and rowDepartmentWritable agree", () => {
  const column = anyEditableColumn();

  const scopes: Array<{ name: string; scope: Partial<EditabilityContext> }> = [
    { name: "never published", scope: {} },
    { name: "holds one department", scope: { writePolicy: allowOnly(["D0410"]) } },
    { name: "revoked", scope: { writePolicy: allowOnly([]) } },
    {
      name: "held by an administrator",
      scope: { writePolicy: allowOnly(["D0410"]), planLocked: true },
    },
  ];

  for (const { name, scope } of scopes) {
    it(`gives the same answer when ${name}`, () => {
      for (const code of ["D0410", "D0610", ""]) {
        const target = row(code);
        expect(cellEditable(target, column, ctx(scope))).toBe(
          rowDepartmentWritable(target, scope)
        );
      }
    });
  }
});

/**
 * The owner's side, built from a real ownership body rather than a hand-written
 * set — because the defect was never in the predicate, it was in what the
 * caller handed it.
 *
 * The scenario, end to end: a hotel opens a new outlet. The owner picks its
 * department on a position (the picker offers it — reference data is the source
 * of truth for a full scope) and the row locks, picker included, so there is no
 * way back from a mis-click. The publish filter reads the same answer and
 * withholds the row silently, so the department never gains a row on the
 * server, so it is never enumerated, so it is never writable.
 */
describe("a full-scope owner and a department the server has never mentioned", () => {
  const column = anyEditableColumn();

  function ownerOwnership(
    rows: Array<{ code: string; readable: boolean; writable: boolean }>,
    relation: "OWNER" | "DELEGATE" = "OWNER",
    scopeKind: "FULL" | "PARTIAL" = "FULL"
  ): DepartmentOwnership {
    return {
      planId: "plan-1",
      planVersion: 42,
      authzVersion: 7,
      me: { relation, scopeKind },
      structureEditableByMe: relation === "OWNER",
      departments: rows.map(
        (dept): DepartmentOwnership["departments"][number] => ({
          ...dept,
          reason: null,
          assignedTo: [],
        })
      ),
    };
  }

  /** Rooms delegated away, F&B theirs, Retail brand new and unmentioned. */
  const owner = ctx({
    writePolicy: departmentWritePolicy(
      ownerOwnership([
        { code: "D0410", readable: true, writable: false },
        { code: "D0610", readable: true, writable: true },
      ])
    ),
  });

  it("keeps the row editable, so a mis-click can be undone", () => {
    expect(cellEditable(row("D0910"), column, owner)).toBe(true);
  });

  it("still locks the department it delegated away", () => {
    // The half that must NOT move. An explicit `writable: false` is a refusal,
    // and the owner's route back is to withdraw the delegation.
    expect(cellEditable(row("D0410"), column, owner)).toBe(false);
    expect(cellEditable(row("D0610"), column, owner)).toBe(true);
  });

  it("locks the same unmentioned department for a DELEGATE", () => {
    // The open ceiling is gated on the relation too. A delegate holding every
    // enumerated department is still on an allow-list.
    const delegate = ctx({
      writePolicy: departmentWritePolicy(
        ownerOwnership([{ code: "D0610", readable: true, writable: true }], "DELEGATE")
      ),
    });
    expect(cellEditable(row("D0910"), column, delegate)).toBe(false);
    expect(cellEditable(row("D0610"), column, delegate)).toBe(true);
  });

  it("locks it for an owner whose own scope is PARTIAL", () => {
    // A partial-scope owner really is bounded by their own department grant, so
    // the widening must not reach them either.
    const partialOwner = ctx({
      writePolicy: departmentWritePolicy(
        ownerOwnership(
          [{ code: "D0610", readable: true, writable: true }],
          "OWNER",
          "PARTIAL"
        )
      ),
    });
    expect(cellEditable(row("D0910"), column, partialOwner)).toBe(false);
  });

  it("lets an owner who delegated everything away still start a new row", () => {
    // `holdsAnyDepartment` is what the unassigned-row rule asks, and the old
    // `size > 0` test answered no here — leaving the owner of a fully delegated
    // plan unable to create the row that would open a sixth department.
    const allDelegated = ctx({
      writePolicy: departmentWritePolicy(
        ownerOwnership([
          { code: "D0410", readable: true, writable: false },
          { code: "D0610", readable: true, writable: false },
        ])
      ),
    });
    expect(cellEditable(row(""), column, allDelegated)).toBe(true);
    expect(cellEditable(row("D0910"), column, allDelegated)).toBe(true);
    expect(cellEditable(row("D0410"), column, allDelegated)).toBe(false);
  });

  it("is still stopped by a support lease", () => {
    const leased = ctx({
      writePolicy: departmentWritePolicy(
        ownerOwnership([{ code: "D0610", readable: true, writable: true }])
      ),
      planLocked: true,
    });
    expect(cellEditable(row("D0910"), column, leased)).toBe(false);
  });
});

describe("departmentUnassigned", () => {
  it("is false with no scope — an unpublished plan has no owner-only branch", () => {
    expect(departmentUnassigned(row(""), {})).toBe(false);
  });

  it("is true for a blank department once a scope exists", () => {
    expect(
      departmentUnassigned(row(""), { writePolicy: allowOnly(["D0410"]) })
    ).toBe(true);
  });

  it("is false once the row has been classified", () => {
    expect(
      departmentUnassigned(row("D0410"), { writePolicy: allowOnly(["D0410"]) })
    ).toBe(false);
  });
});
