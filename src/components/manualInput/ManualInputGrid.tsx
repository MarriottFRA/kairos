/**
 * ManualInputGrid — the DataGridPremium for hand-entered cost lines.
 *
 * Columns/groups come from buildManualColumns. Cell edits and clipboard pastes
 * both flow through processRowUpdate (owned by the page, which persists per row).
 * Amount cells are locked (non-editable) while a row is rate-driven — that closes
 * typing AND paste in one place, via isCellEditable. Row-selection checkboxes
 * feed the page's Apply-spread / Delete actions; the v9 selection model is
 * resolved to a flat id array before it leaves the grid.
 */

import { useCallback, useMemo } from "react";
import Box from "@mui/material/Box";
import {
  DataGridPremium,
  GridCellParams,
  GridRowSelectionModel,
  useGridApiRef,
} from "@mui/x-data-grid-premium";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { AccountFilter } from "../../shared/positions/fields";
import { buildManualColumns, isRateLockedField, ManualViewMode } from "./columns";
import { isRateDriven, ManualGridRow } from "./rowModel";

export interface ManualInputGridProps {
  rows: ManualGridRow[];
  departments: DepartmentOption[];
  accounts: AccountOption[];
  accountFilter?: AccountFilter | null;
  /** Stats-only / Amount-only / both monthly cells. */
  viewMode?: ManualViewMode;
  /** Shared grid handle, so the page can focus a freshly added row. */
  apiRef?: ReturnType<typeof useGridApiRef>;
  loading?: boolean;
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
  accounts,
  accountFilter,
  viewMode = "both",
  apiRef,
  loading = false,
  onRowUpdate,
  onRowUpdateError,
  onSelectionChange,
}: ManualInputGridProps) {
  const { columns, grouping } = useMemo(
    () => buildManualColumns({ departments, accounts, accountFilter, viewMode }),
    [departments, accounts, accountFilter, viewMode]
  );

  // The monthly Amount cells and the Amount base are read-only while the row is
  // rate-driven (Amount is the derived hours*rate).
  const isCellEditable = useCallback((params: GridCellParams) => {
    if (isRateLockedField(params.field)) {
      return !isRateDriven(params.row as ManualGridRow);
    }
    return true;
  }, []);

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
        processRowUpdate={onRowUpdate}
        onProcessRowUpdateError={onRowUpdateError}
        showToolbar
        hideFooterSelectedRowCount
        rowBufferPx={200}
        sx={{
          "& .MuiDataGrid-columnHeaderTitle": { fontWeight: 600 },
          "& .pos-cell--derived": { color: "text.disabled" },
        }}
      />
    </Box>
  );
}
