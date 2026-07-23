/**
 * BudgetValuesGrid — the DataGridPremium that visualizes one import's rows
 * (or a preview sample). One row per combo, 36 month cells grouped by bucket.
 */

import { useMemo } from "react";
import Box from "@mui/material/Box";
import { DataGridPremium } from "@mui/x-data-grid-premium";
import { BucketMeta, WideBudgetRow } from "../../shared/budgetImport/ipc";
import { buildBudgetColumns } from "./columns";

export interface BudgetValuesGridProps {
  rows: WideBudgetRow[];
  buckets: BucketMeta[];
  loading?: boolean;
  /** Compact height for the preview sample; omit for the full-height viewer. */
  height?: number | string;
  /** Show the built-in toolbar (filter / density / export). */
  showToolbar?: boolean;
}

export default function BudgetValuesGrid({
  rows,
  buckets,
  loading = false,
  height = "100%",
  showToolbar = false,
}: BudgetValuesGridProps) {
  const { columns, grouping } = useMemo(
    () => buildBudgetColumns(buckets),
    [buckets]
  );

  return (
    <Box sx={{ height, width: "100%" }}>
      <DataGridPremium
        rows={rows}
        columns={columns}
        columnGroupingModel={grouping}
        loading={loading}
        density="compact"
        disableRowSelectionOnClick
        showToolbar={showToolbar}
        initialState={{
          pinnedColumns: { left: ["combo", "dept", "account"] },
        }}
        hideFooter
        rowBufferPx={200}
        sx={{
          "& .MuiDataGrid-columnHeaderTitle": { fontWeight: 600 },
        }}
      />
    </Box>
  );
}
