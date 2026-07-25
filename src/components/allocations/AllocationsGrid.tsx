/**
 * AllocationsGrid — departments (rows) × allocations (columns), each column a
 * spread normalized to 100. Read-only values (computed in main); the only
 * interaction is per-column Edit / Delete from the header menu. A pinned bottom
 * row shows each column's total (≈100, or 0 when the base has no data).
 */

import { useMemo, useState } from "react";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import {
  DataGridPremium,
  GridColDef,
  GridRenderCellParams,
} from "@mui/x-data-grid-premium";
import {
  AllocationDto,
  AllocationsViewResponse,
  spreadBaseLabel,
} from "../../shared/allocations/ipc";

interface GridRow {
  id: string;
  departmentName: string;
  values: Record<string, number>;
  isTotal?: boolean;
}

export interface AllocationsGridProps {
  view: AllocationsViewResponse;
  loading?: boolean;
  onEdit: (allocation: AllocationDto) => void;
  onDelete: (allocation: AllocationDto) => void;
}

function formatPercent(value: number | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return "–";
  return `${num.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

/** Column header: allocation name + spread base, with an Edit/Delete menu. */
function AllocationHeader({
  allocation,
  onEdit,
  onDelete,
}: {
  allocation: AllocationDto;
  onEdit: (allocation: AllocationDto) => void;
  onDelete: (allocation: AllocationDto) => void;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  return (
    <Stack
      direction="row"
      sx={{
        width: "100%",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Stack sx={{ overflow: "hidden" }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
          {allocation.name}
        </Typography>
        <Typography variant="caption" noWrap sx={{ color: "text.secondary" }}>
          {spreadBaseLabel(allocation.spreadBase)}
        </Typography>
      </Stack>
      <IconButton
        size="small"
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-label={`${allocation.name} options`}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onEdit(allocation);
          }}
        >
          Edit
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onDelete(allocation);
          }}
        >
          Delete
        </MenuItem>
      </Menu>
    </Stack>
  );
}

export default function AllocationsGrid({
  view,
  loading,
  onEdit,
  onDelete,
}: AllocationsGridProps) {
  const rows = useMemo<GridRow[]>(
    () =>
      view.departments.map((dept) => ({
        id: dept.departmentCode || "__none__",
        departmentName: dept.departmentName,
        values: dept.values,
      })),
    [view.departments]
  );

  // A pinned bottom row of column totals (each ≈100 unless the base has no data).
  const totalsRow = useMemo<GridRow>(() => {
    const values: Record<string, number> = {};
    for (const allocation of view.allocations) {
      values[allocation.id] = view.departments.reduce(
        (sum, dept) => sum + (dept.values[allocation.id] ?? 0),
        0
      );
    }
    return { id: "__total__", departmentName: "Total", values, isTotal: true };
  }, [view.allocations, view.departments]);

  const columns = useMemo<GridColDef<GridRow>[]>(() => {
    const deptColumn: GridColDef<GridRow> = {
      field: "departmentName",
      headerName: "Department",
      width: 220,
      sortable: false,
      cellClassName: (params) => (params.row.isTotal ? "alloc-cell--total" : ""),
    };
    const allocColumns = view.allocations.map(
      (allocation): GridColDef<GridRow> => ({
        field: allocation.id,
        headerName: allocation.name,
        width: 170,
        type: "number",
        sortable: false,
        headerAlign: "left",
        align: "right",
        valueGetter: (_value, row) => row.values[allocation.id] ?? 0,
        valueFormatter: (value: number) => formatPercent(value),
        cellClassName: (params) => (params.row.isTotal ? "alloc-cell--total" : ""),
        renderHeader: () => (
          <AllocationHeader
            allocation={allocation}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ),
        renderCell: (params: GridRenderCellParams<GridRow, number>) =>
          formatPercent(params.value),
      })
    );
    return [deptColumn, ...allocColumns];
  }, [view.allocations, onEdit, onDelete]);

  return (
    <DataGridPremium
      rows={rows}
      columns={columns}
      loading={loading}
      disableRowSelectionOnClick
      disableColumnMenu
      columnHeaderHeight={64}
      pinnedRows={{ bottom: [totalsRow] }}
      hideFooter
      sx={{
        borderRadius: 2,
        "& .alloc-cell--total": { fontWeight: 700 },
        "& .MuiDataGrid-pinnedRows": {
          fontWeight: 700,
        },
      }}
    />
  );
}
