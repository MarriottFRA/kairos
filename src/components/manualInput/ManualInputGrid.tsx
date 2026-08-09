/**
 * ManualInputGrid — the DataGridPremium for hand-entered cost lines.
 *
 * Columns/groups come from buildManualColumns. Cell edits and clipboard pastes
 * both flow through processRowUpdate (owned by the page, which persists per row).
 * Amount cells are locked (non-editable) while a row is rate-driven — that closes
 * typing AND paste in one place, via isCellEditable. Row-selection checkboxes
 * feed the page's Apply-spread / Delete actions; the v9 selection model is
 * resolved to a flat id array before it leaves the grid.
 *
 * The same isCellEditable now also enforces the sync write scope, using the very
 * predicate the positions grid uses. These rows are a department-scoped
 * published type, so a row typed into a department you do not hold was already
 * being dropped at publish — silently, since a withheld row is not a rejection.
 * Blocking the cell is the honest version of a refusal that was already happening.
 */

import { useCallback, useMemo } from "react";
import Box from "@mui/material/Box";
import {
  DataGridPremium,
  GridCellParams,
  GridRowClassNameParams,
  GridRowSelectionModel,
  useGridApiRef,
} from "@mui/x-data-grid-premium";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { AccountFilter } from "../../shared/positions/fields";
import { rowDepartmentWritable } from "../../shared/positions/writeScope";
import type { DepartmentPickList } from "../../shared/positions/departmentPickList";
import type { DepartmentWritePolicy } from "../../shared/kairosSync/writePolicy";
import { buildManualColumns, isRateLockedField, ManualViewMode } from "./columns";
import { isRateDriven, ManualGridRow } from "./rowModel";

export interface ManualInputGridProps {
  rows: ManualGridRow[];
  departments: DepartmentOption[];
  /** What the Department picker may offer, and what it greys. No restriction if omitted. */
  departmentPicks?: DepartmentPickList;
  accounts: AccountOption[];
  accountFilter?: AccountFilter | null;
  /** Stats-only / Amount-only / both monthly cells. */
  viewMode?: ManualViewMode;
  /** Shared grid handle, so the page can focus a freshly added row. */
  apiRef?: ReturnType<typeof useGridApiRef>;
  loading?: boolean;
  /**
   * What this user may write, derived from `/department-ownership` by
   * `departmentWritePolicy`.
   *
   * `undefined` means "no server opinion" — an unpublished plan — and every
   * cell stays editable, which is how this page has always behaved. An empty
   * allow-list is the opposite and locks everything: see `rowDepartmentWritable`.
   *
   * This page had no scope at all until now, and `manual_input_row` is a
   * department-scoped published type, so `filterToWriteScope` was quietly
   * dropping rows at publish for a department the typist did not hold. No
   * rejection, no warning — the rows simply were not there afterwards.
   */
  writePolicy?: DepartmentWritePolicy;
  /** An administrator holds a support lease: the whole plan is read-only. */
  planLocked?: boolean;
  /** Persist an edited row; returns the row the grid keeps (post-sanitize). */
  onRowUpdate: (
    newRow: ManualGridRow,
    oldRow: ManualGridRow
  ) => ManualGridRow | Promise<ManualGridRow>;
  onRowUpdateError?: (error: unknown) => void;
  /** Called with the current selection as a flat id array. */
  onSelectionChange: (ids: string[]) => void;
}

export default function ManualInputGrid({
  rows,
  departments,
  departmentPicks,
  accounts,
  accountFilter,
  viewMode = "both",
  apiRef,
  loading = false,
  writePolicy,
  planLocked,
  onRowUpdate,
  onRowUpdateError,
  onSelectionChange,
}: ManualInputGridProps) {
  const { columns, grouping } = useMemo(
    () =>
      buildManualColumns({
        departments,
        departmentPicks,
        accounts,
        accountFilter,
        viewMode,
      }),
    [departments, departmentPicks, accounts, accountFilter, viewMode]
  );

  const rowWritable = useCallback(
    (row: ManualGridRow | undefined): boolean =>
      rowDepartmentWritable(row, { writePolicy, planLocked }),
    [writePolicy, planLocked]
  );

  // Two independent locks, checked in order of authority.
  //
  // The department lock comes first because it covers the whole row: a row in
  // somebody else's department cannot be typed into at all. The same predicate
  // the positions grid uses, deliberately — including its rule that a row with
  // no department yet stays editable, which matters more here than there, since
  // "Add row" mints a row with a blank department code and the picker is the
  // only way to give it one.
  //
  // The rate lock is per-field and unrelated: the monthly Amount cells and the
  // Amount base are derived while the row is rate-driven.
  const isCellEditable = useCallback(
    (params: GridCellParams) => {
      if (!rowWritable(params.row as ManualGridRow)) return false;
      if (isRateLockedField(params.field)) {
        return !isRateDriven(params.row as ManualGridRow);
      }
      return true;
    },
    [rowWritable]
  );

  /** Greyed like a derived cell — locked, and visibly not merely empty. */
  const getRowClassName = useCallback(
    (params: GridRowClassNameParams) =>
      rowWritable(params.row as ManualGridRow) ? "" : "manual-row--locked",
    [rowWritable]
  );

  // v9 reports selection as {type, ids}: an "exclude" model means everything
  // except `ids` (a header select-all over a filtered grid).
  const handleSelectionChange = useCallback(
    (model: GridRowSelectionModel) => {
      const ids =
        model.type === "exclude"
          ? rows.map((row) => row.id).filter((id) => !model.ids.has(id))
          : [...model.ids].map(String);
      onSelectionChange(ids);
    },
    [rows, onSelectionChange]
  );

  return (
    <Box sx={{ height: "100%", width: "100%" }}>
      <DataGridPremium
        apiRef={apiRef}
        rows={rows}
        columns={columns}
        columnGroupingModel={grouping}
        loading={loading}
        density="compact"
        checkboxSelection
        disableRowSelectionOnClick
        onRowSelectionModelChange={handleSelectionChange}
        isCellEditable={isCellEditable}
        getRowClassName={getRowClassName}
        processRowUpdate={onRowUpdate}
        onProcessRowUpdateError={onRowUpdateError}
        showToolbar
        hideFooterSelectedRowCount
        rowBufferPx={200}
        sx={{
          "& .MuiDataGrid-columnHeaderTitle": { fontWeight: 600 },
          "& .pos-cell--derived": { color: "text.disabled" },
          "& .manual-row--locked": { color: "text.disabled" },
        }}
      />
    </Box>
  );
}
