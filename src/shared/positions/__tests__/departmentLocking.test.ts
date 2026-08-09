/**
 * The grid's department lock.
 *
 * Once a plan is published and departments are delegated, the grid must let the
 * user edit exactly what a save would accept — no more, and no less. The server
 * hands us that answer as `writable` on `/department-ownership`, where it IS the
 * write predicate, so the only way to be wrong here is to apply it wrongly.
 *
 * Three cases carry real consequences:
 *
 * - **`undefined` means unrestricted.** A plan that was never published has no
 *   server-side authority to consult, and a hotel that never opts into sync must
 *   not notice this code exists.
 * - **An empty set means nothing is writable**, which is the opposite. Confusing
 *   the two either locks an offline hotel out of its own file or hands a
 *   revoked delegate a fully editable grid.
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
import {
  EditabilityContext,
  buildColumns,
  cellEditable,
} from "../../../components/positions/columnFactory";
import { departmentUnassigned, rowDepartmentWritable } from "../writeScope";

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
    vacationCostById: new Map(),
    manhoursWorkedById: new Map(),
    fteById: new Map(),
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
      cellEditable(row("D0410"), column, ctx({ writableDepartments: new Set(["D0410"]) }))
    ).toBe(true);
  });

  it("locks a department the user does not hold", () => {
    expect(
      cellEditable(row("D0610"), column, ctx({ writableDepartments: new Set(["D0410"]) }))
    ).toBe(false);
  });

  it("locks a department the OWNER has delegated away", () => {
    // The server reports writable:false for it, and the owner's route back is to
    // withdraw the delegation. Per the brief, and not a bug.
    const asOwnerWithRoomsDelegated = ctx({
      writableDepartments: new Set(["D0610", "D0710"]),
    });
    expect(cellEditable(row("D0410"), column, asOwnerWithRoomsDelegated)).toBe(false);
    expect(cellEditable(row("D0610"), column, asOwnerWithRoomsDelegated)).toBe(true);
  });

  it("leaves a row with no department editable so a delegate can give it one", () => {
    // Deliberately inverted. Locking it covered the department picker itself, so
    // a row a delegate had just created could never be classified — not through
    // the grid, the row form, or a paste. It stays unpublishable either way;
    // `filterToWriteScope` is what enforces that, and it has not changed.
    expect(
      cellEditable(row(""), column, ctx({ writableDepartments: new Set(["D0410"]) }))
    ).toBe(true);
  });

  it("still locks an unassigned row when the writable set is empty", () => {
    // A revoked delegate must not gain an editing surface out of the change
    // above. Nothing to assign it to means nothing to unlock.
    expect(
      cellEditable(row(""), column, ctx({ writableDepartments: new Set<string>() }))
    ).toBe(false);
  });

  it("still locks an unassigned row while an administrator holds the plan", () => {
    expect(
      cellEditable(
        row(""),
        column,
        ctx({ writableDepartments: new Set(["D0410"]), planLocked: true })
      )
    ).toBe(false);
  });

  it("locks everything when the set is empty", () => {
    // A revoked delegate. Emphatically NOT the same as undefined.
    expect(
      cellEditable(row("D0410"), column, ctx({ writableDepartments: new Set<string>() }))
    ).toBe(false);
  });

  it("locks everything while the plan is held by an administrator", () => {
    expect(
      cellEditable(
        row("D0410"),
        column,
        ctx({ writableDepartments: new Set(["D0410"]), planLocked: true })
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
      vacationCostById: new Map(),
      manhoursWorkedById: new Map(),
      fteById: new Map(),
      hotelClusters: [],
      currentOu: OU,
    });
    const maskedColumn = columns.find((candidate) => candidate.field === maskedKey);
    if (!maskedColumn) return;

    expect(
      cellEditable(
        row("D0410"),
        maskedColumn,
        ctx({ masked: true, writableDepartments: new Set(["D0410"]) })
      )
    ).toBe(false);
  });

  it("gives the same answer every time for the same row and context", () => {
    // The resolver caches per (context, row); a cache that answered differently
    // on the second call would make the grid flicker between editable and not.
    const scope = ctx({ writableDepartments: new Set(["D0410"]) });
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
    const before = ctx({ writableDepartments: new Set(["D0410"]) });
    const after = ctx({ writableDepartments: new Set<string>() });
    const target = row("D0410");

    expect(cellEditable(target, column, before)).toBe(true);
    expect(cellEditable(target, column, after)).toBe(false);
  });
});

/**
 * The row form applies the same rules as the grid.
 *
 * `PositionFormDialog` builds its own `EditabilityContext` and calls the same
 * `cellEditable`. It used to omit `writableDepartments` and `planLocked`, which
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
      writableDepartments: new Set(["D0410"]),
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
      writableDepartments: new Set(["D0410"]),
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
    { name: "holds one department", scope: { writableDepartments: new Set(["D0410"]) } },
    { name: "revoked", scope: { writableDepartments: new Set<string>() } },
    {
      name: "held by an administrator",
      scope: { writableDepartments: new Set(["D0410"]), planLocked: true },
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

describe("departmentUnassigned", () => {
  it("is false with no scope — an unpublished plan has no owner-only branch", () => {
    expect(departmentUnassigned(row(""), {})).toBe(false);
  });

  it("is true for a blank department once a scope exists", () => {
    expect(
      departmentUnassigned(row(""), { writableDepartments: new Set(["D0410"]) })
    ).toBe(true);
  });

  it("is false once the row has been classified", () => {
    expect(
      departmentUnassigned(row("D0410"), { writableDepartments: new Set(["D0410"]) })
    ).toBe(false);
  });
});
