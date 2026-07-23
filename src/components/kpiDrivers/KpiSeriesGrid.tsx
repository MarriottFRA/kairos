/**
 * KpiSeriesGrid — the DataGridPremium that shows a KPI driver's resolved
 * series: one row per dept_key (a single "All" row for EXPLICIT, one row per
 * department for POSITION), with the 12 monthly values and an annual total.
 */

import { useMemo } from "react";
import Box from "@mui/material/Box";
import { DataGridPremium, GridColDef } from "@mui/x-data-grid-premium";
import {
  KPI_EXPLICIT_DEPT_KEY,
  KpiDriverSeries,
} from "../../shared/kpiDrivers/ipc";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const numberFmt = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

interface SeriesRow {
  id: string;
  dept: string;
  total: number;
  [month: string]: string | number;
}

export interface KpiSeriesGridProps {
  series: KpiDriverSeries[];
  height?: number | string;
}

export default function KpiSeriesGrid({
  series,
  height = 220,
}: KpiSeriesGridProps) {
  const rows = useMemo<SeriesRow[]>(
    () =>
      series.map((s) => {
        const row: SeriesRow = {
          id: s.deptKey,
          dept: s.deptKey === KPI_EXPLICIT_DEPT_KEY ? "All departments" : s.deptKey,
          total: s.values.reduce((a, b) => a + b, 0),
        };
        MONTHS.forEach((m, i) => {
          row[m] = s.values[i] ?? 0;
        });
        return row;
      }),
    [series]
  );

  const columns = useMemo<GridColDef[]>(() => {
    const monthCols: GridColDef[] = MONTHS.map((m) => ({
      field: m,
      headerName: m,
      type: "number",
      width: 84,
      valueFormatter: (value: number) => numberFmt.format(value ?? 0),
    }));
    return [
      { field: "dept", headerName: "Department", width: 160 },
      ...monthCols,
      {
        field: "total",
        headerName: "Year",
        type: "number",
        width: 110,
        valueFormatter: (value: number) => numberFmt.format(value ?? 0),
      },
    ];
  }, []);

  return (
    <Box sx={{ height, width: "100%" }}>
      <DataGridPremium
        rows={rows}
        columns={columns}
        density="compact"
        disableRowSelectionOnClick
        hideFooter
        rowBufferPx={200}
        initialState={{ pinnedColumns: { left: ["dept"], right: ["total"] } }}
        sx={{ "& .MuiDataGrid-columnHeaderTitle": { fontWeight: 600 } }}
      />
    </Box>
  );
}
