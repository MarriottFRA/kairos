/**
 * A cleared numeric has to be storable — which is what makes Undo work.
 *
 * sanitizeRow protects a paste: text it cannot parse reverts to the value that
 * was already there, so a stray word in a pasted column cannot blank a salary.
 * That guard used to catch an explicit `null` too — `toNumber(null, NaN)` is
 * NaN like any other junk — and the two are not the same thing. `null` is a
 * value ("no number here"); unparseable text is a mistake.
 *
 * The Edit Position form's Ctrl+Z is where the conflation showed. Undo replays
 * the whole pre-edit row back through the ordinary write path, so an undo of a
 * cell that was BLANK before the edit handed sanitizeRow a null — which came
 * back out as the number the user had just typed. changedFieldKeys then saw no
 * difference, nothing was queued, and the row silently kept the edit: the form
 * showed the old value while the store and every result kept the new one, until
 * the next load put the new one back on screen too.
 *
 * It compounded. The FIRST undo on a field that had never been written (key
 * absent, not null) did persist, as a null — so that undo turned the field into
 * the shape that breaks, and every later edit+undo on that cell was dead.
 *
 * The same fix is what makes the two auto/override fields — Manhours Worked and
 * the cluster multiplier — clearable at all: their valueSetters return null for
 * "go back to auto", and sanitizeRow was overwriting that too.
 */

import { describe, expect, it } from "vitest";
import { GridColDef } from "@mui/x-data-grid-premium";
import {
  buildColumns,
  ColumnFactoryContext,
} from "../../../components/positions/columnFactory";
import { commitValue } from "../../../components/positions/gridValueBridge";
import { BUILTIN_CATALOG } from "../fieldSeed";
import { SALARY_ENTRY_MODE_KEY, vectorKey } from "../fields";
import { PositionRow, changedFieldKeys, sanitizeRow, toPatch } from "../rowModel";
import { staticDerivedRowValues } from "../derivedRowValues";

const CTX: ColumnFactoryContext = {
  masked: false,
  numberFormat: new Intl.NumberFormat("en-GB"),
  departments: [],
  accounts: [],
  derived: staticDerivedRowValues({ manhoursWorkedById: new Map([["p1", 1800]]) }),
  hotelClusters: [],
  currentOu: "H001",
};

const COLUMNS = new Map(
  buildColumns(BUILTIN_CATALOG, CTX).map((column) => [column.field, column] as const)
);

function col(field: string): GridColDef<PositionRow> {
  const found = COLUMNS.get(field);
  if (!found) throw new Error(`no column for ${field}`);
  return found;
}

/** The page's handleRowUpdate, minus the block and department-autofill lanes
 *  (neither is involved here). Returns null when it would enqueue nothing. */
function write(
  newRow: PositionRow,
  oldRow: PositionRow
): { row: PositionRow; fields: Record<string, unknown> } | null {
  const sanitized = sanitizeRow(newRow, oldRow, BUILTIN_CATALOG);
  const changed = changedFieldKeys(oldRow, sanitized, BUILTIN_CATALOG);
  if (changed.length === 0) return null;
  return {
    row: sanitized,
    fields: toPatch(sanitized, changed, BUILTIN_CATALOG).positionFields,
  };
}

/** Type a value into `field`, then Ctrl+Z — which replays the pre-edit row. */
function editThenUndo(start: PositionRow, field: string, typed: unknown) {
  const edit = write(commitValue(col(field), start, typed), start);
  if (!edit) throw new Error(`the edit itself did not persist (${field})`);
  return write(start, edit.row);
}

/** Settled once through sanitizeRow, the way a row loaded from the store is:
 *  the salary pair and the divisor are already reconciled, so a later diff
 *  reports only what the test actually changed. */
const BASE: PositionRow = (() => {
  const seed: PositionRow = {
    id: "p1",
    payType: "SALARIED",
    increaseMonth: 13,
    dailyContractHours: 8,
    vacationDays: 20,
    monthlyBaseSalary: 3000,
    [SALARY_ENTRY_MODE_KEY]: "MONTHLY",
  };
  return sanitizeRow(seed, seed, BUILTIN_CATALOG);
})();

const VAC_1 = vectorKey("vacationMonthlyWeights", 1);

describe("undo back to a blank cell", () => {
  // One case per storage shape a blank can take, because they take different
  // routes out: an engine scalar coerces null to 0 in the repo, an extra-value
  // key is dropped from the JSON blob, and a vector member promotes to the
  // whole rebuilt array.
  const CASES: Array<[string, string, unknown]> = [
    ["yearly days (extra value)", "contractYearlyDays", 300],
    ["vacation weight (vector member)", VAC_1, 2],
    ["monthly basic (engine scalar)", "monthlyBaseSalary", 4200],
    ["manhours worked (auto unless overridden)", "yearlyHoursWorked", 4],
  ];

  for (const [name, field, typed] of CASES) {
    it(`${name} — persists the blank`, () => {
      const undone = editThenUndo({ ...BASE, [field]: null }, field, typed);
      expect(undone, "undo enqueued nothing").not.toBeNull();
    });
  }

  it("a field that was never written stays undoable afterwards", () => {
    // The trap that made this look like "undo works once, then never again":
    // the first undo persists null, and null used to be the unstorable shape.
    const first = editThenUndo({ ...BASE }, "contractYearlyDays", 300);
    expect(first?.fields.contractYearlyDays ?? null).toBeNull();
    const reloaded: PositionRow = { ...BASE, contractYearlyDays: null };
    expect(editThenUndo(reloaded, "contractYearlyDays", 300)).not.toBeNull();
  });
});

describe("clearing a numeric", () => {
  it("stores the clear rather than putting the old number back", () => {
    const row: PositionRow = { ...BASE, contractYearlyDays: 365 };
    const patch = write(commitValue(col("contractYearlyDays"), row, null), row);
    expect(patch?.fields.contractYearlyDays ?? null).toBeNull();
  });

  it("drops a Manhours override back to auto", () => {
    // gridValueBridge already proves the setter returns null here; what this
    // pins is that the write path keeps it, so the row resumes tracking the
    // calendar instead of staying frozen on the override.
    const row: PositionRow = { ...BASE, yearlyHoursWorked: 1900 };
    const patch = write(commitValue(col("yearlyHoursWorked"), row, null), row);
    expect(patch?.fields.yearlyHoursWorked ?? null).toBeNull();
  });

  it("still reverts unparseable text — the paste guard is untouched", () => {
    const row: PositionRow = { ...BASE, contractYearlyDays: 365 };
    const junk: PositionRow = { ...row, contractYearlyDays: "not a number" };
    expect(write(junk, row)).toBeNull();
    // An empty pasted cell reverts too: clipboard blanks arrive as "", and a
    // half-filled pasted column must not wipe the rows it does not cover.
    expect(write({ ...row, contractYearlyDays: "" }, row)).toBeNull();
  });
});
