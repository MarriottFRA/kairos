/**
 * FteReconciliation — the Positions grid's FTE beside the FTE the reports
 * derive from the accounts, per department, grouped as the budget pack
 * groups departments.
 *
 * Left, what the grid shows (manager FTE, everyone else, total, heads);
 * right, what the accounts give (manager heads, the hours that drive FTE,
 * hours ÷ a full-timer's year, total); then the difference. The work week
 * the account side divided by sits in a chip with where it was read from,
 * because a surprising FTE is nearly always a surprising divisor.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Stack, Tooltip } from "@mui/material";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { DataGridPremium, GridColDef, GridColumnGroupingModel } from "@mui/x-data-grid-premium";
import type { ScenarioDto } from "../../shared/positions/ipc";
import type { FteReconciliationCells, FteReconciliationResponse } from "../../shared/reports/fteReconciliation";
import type { Format } from "../../shared/reports/types";
import { WEEKLY_HOURS_ORIGIN_LABELS } from "../../shared/reports/weeklyHours";
import { describeEffectiveWeek } from "../../shared/positions/effectiveWeek";
import { exportFteReconciliation, loadFteReconciliation } from "../../services/reportsService";
import { formatReportValue } from "./format";

export interface FteReconciliationProps {
  ou: string;
  scenario: ScenarioDto;
  hotelName: string;
  onError: (error: unknown, fallback: string) => void;
  onNotice: (message: string) => void;
}

interface GridRow {
  id: string;
  groupKey: string;
  dept: string;
  name: string;
  [field: string]: string | number | null;
}

interface ColumnDef {
  field: string;
  headerName: string;
  format: Format;
  pick: (cells: FteReconciliationCells) => number;
}

const GRID_COLUMNS: ColumnDef[] = [
  { field: "grid_managers", headerName: "Managers", format: "ratio", pick: (c) => c.grid.managers },
  { field: "grid_others", headerName: "Others", format: "ratio", pick: (c) => c.grid.others },
  { field: "grid_total", headerName: "Total FTE", format: "ratio", pick: (c) => c.grid.total },
  { field: "grid_heads", headerName: "Heads", format: "number", pick: (c) => c.grid.heads },
];
const ACCOUNT_COLUMNS: ColumnDef[] = [
  { field: "acc_managers", headerName: "Manager heads", format: "ratio", pick: (c) => c.accounts.managerHeads },
  { field: "acc_hours", headerName: "Hours", format: "number", pick: (c) => c.accounts.hours },
  { field: "acc_hours_fte", headerName: "Hours ÷ FTE hrs", format: "ratio", pick: (c) => c.accounts.hoursFte },
  { field: "acc_total", headerName: "Total FTE", format: "ratio", pick: (c) => c.accounts.total },
];
const VARIANCE_COLUMN: ColumnDef = { field: "variance", headerName: "Accounts − grid", format: "ratio", pick: (c) => c.variance };
const ALL_COLUMNS = [...GRID_COLUMNS, ...ACCOUNT_COLUMNS, VARIANCE_COLUMN];

const groupKeyOf = (index: number, label: string) => `${String(index).padStart(3, "0")}|${label}`;
const groupLabelOf = (key: string) => key.slice(key.indexOf("|") + 1);

export default function FteReconciliation({ ou, scenario, hotelName, onError, onNotice }: FteReconciliationProps) {
  const [data, setData] = useState<FteReconciliationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadFteReconciliation(ou, scenario.id)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((err) => {
        if (!cancelled) {
          onError(err, "Failed to load the FTE reconciliation");
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ou, scenario.id, onError]);

  const rows = useMemo<GridRow[]>(() => {
    if (!data) return [];
    const out: GridRow[] = [];
    data.groups.forEach((group, index) => {
      for (const row of group.rows) {
        const item: GridRow = { id: `${group.label}|${row.dept}`, groupKey: groupKeyOf(index, group.label), dept: row.dept, name: `${row.dept} · ${row.name}` };
        for (const column of ALL_COLUMNS) item[column.field] = column.pick(row);
        out.push(item);
      }
    });
    return out;
  }, [data]);

  const columns = useMemo<GridColDef<GridRow>[]>(
    () => [
      { field: "name", headerName: "Department", width: 280 },
      ...ALL_COLUMNS.map(
        (column): GridColDef<GridRow> => ({
          field: column.field,
          headerName: column.headerName,
          width: column.field === "acc_hours" ? 110 : 104,
          type: "number",
          align: "right",
          headerAlign: "right",
          valueFormatter: (value: number | null) => formatReportValue(value, column.format),
          cellClassName: (params) => {
            const classes = ["fte-cell--num"];
            const value = params.value as number | null;
            if (column.field === "variance" && typeof value === "number" && Math.abs(value) >= 0.005) classes.push("fte-cell--diff");
            return classes.join(" ");
          },
        })
      ),
    ],
    []
  );

  const columnGroupingModel = useMemo<GridColumnGroupingModel>(
    () => [
      { groupId: "grid", headerName: "Positions grid", headerAlign: "center", children: GRID_COLUMNS.map((c) => ({ field: c.field })) },
      { groupId: "accounts", headerName: "Accounts", headerAlign: "center", children: ACCOUNT_COLUMNS.map((c) => ({ field: c.field })) },
      { groupId: "variance", headerName: "Difference", headerAlign: "center", children: [{ field: VARIANCE_COLUMN.field }] },
    ],
    []
  );

  const aggregationModel = useMemo(() => Object.fromEntries(ALL_COLUMNS.map((c) => [c.field, "sum"] as const)), []);

  const handleExport = useCallback(() => {
    setExporting(true);
    void (async () => {
      try {
        const result = await exportFteReconciliation(ou, scenario.id, { hotelName });
        if (result.outcome === "saved") onNotice(`Saved ${result.path} (${result.sheets} sheets)`);
      } catch (err) {
        onError(err, "Export failed");
      } finally {
        setExporting(false);
      }
    })();
  }, [ou, scenario.id, hotelName, onError, onNotice]);

  const warnings = useMemo(() => {
    const codes = new Map<string, string>();
    for (const w of data?.warnings ?? []) if (!codes.has(w.code)) codes.set(w.code, w.message);
    return [...codes.entries()];
  }, [data]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={exporting ? <CircularProgress size={14} color="inherit" /> : <FileDownloadOutlinedIcon />}
          onClick={handleExport}
          disabled={!data || exporting}
          sx={{ height: 36 }}
        >
          Export reconciliation
        </Button>
        <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
          {data?.weeklyHours && (
            <Tooltip
              title={
                `Read from ${WEEKLY_HOURS_ORIGIN_LABELS[data.weeklyHours.origin]}. One FTE = ${Math.round(data.fteHoursYear)} hours a year (the effective week × 52).` +
                (data.weeklyHours.derivation ? ` ${describeEffectiveWeek(data.weeklyHours.derivation)}` : "")
              }
            >
              <Chip
                size="small"
                variant="outlined"
                color={data.weeklyHours.origin === "derived" || data.weeklyHours.origin === "setup" ? "warning" : "default"}
                label={`${data.weeklyHours.value.toFixed(2)}h effective week · ${Math.round(data.fteHoursYear)} hrs per FTE`}
                sx={{ height: 28, fontWeight: 600 }}
              />
            </Tooltip>
          )}
          {data?.run ? (
            <Chip
              size="small"
              variant="outlined"
              color={data.run.stale ? "warning" : "success"}
              label={data.run.stale ? "Results out of date — the positions changed since the last calculation" : `Calculated ${new Date(data.run.computedAt).toLocaleString()}`}
              sx={{ height: 28, fontWeight: 600 }}
            />
          ) : (
            data && (
              <Chip size="small" variant="outlined" color="warning" label="Never calculated — the account side is empty" sx={{ height: 28, fontWeight: 600 }} />
            )
          )}
        </Stack>
      </Stack>

      {warnings.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ mb: 1, flexWrap: "wrap", rowGap: 0.5 }}>
          {warnings.map(([code, message]) => (
            <Tooltip key={code} title={message}>
              <Chip size="small" color="warning" variant="outlined" label={code.toLowerCase().replace(/_/g, " ")} />
            </Tooltip>
          ))}
        </Stack>
      )}

      <Alert severity="info" sx={{ mb: 2 }}>
        The grid side is each position's contract-derived FTE × count × cluster share. The account side is what every report reads:
        manager heads (A988101 / A988113) as they are, plus staff hours (excl. overtime, manager and buyout hours) ÷ the standard
        work week × 52. Buyout Labour is on neither side.
      </Alert>

      {data && data.unmappedDepartments.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {data.unmappedDepartments.length === 1
            ? `Department ${data.unmappedDepartments[0]} has no group in the mapping tables and is listed under "Unmapped departments".`
            : `Departments ${data.unmappedDepartments.join(", ")} have no group in the mapping tables and are listed under "Unmapped departments".`}
        </Alert>
      )}

      <Box sx={{ flex: 1, minHeight: 0 }}>
        <DataGridPremium
          rows={rows}
          columns={columns}
          columnGroupingModel={columnGroupingModel}
          loading={loading}
          rowGroupingModel={["groupKey"]}
          groupingColDef={{
            headerName: "Department group",
            width: 260,
            valueFormatter: (value: unknown) => groupLabelOf(String(value ?? "")),
          }}
          defaultGroupingExpansionDepth={-1}
          initialState={{ aggregation: { model: aggregationModel } }}
          aggregationModel={aggregationModel}
          disableRowSelectionOnClick
          disableColumnMenu
          rowHeight={32}
          columnHeaderHeight={36}
          sx={{
            borderRadius: 2,
            "& .fte-cell--num": { fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.8125rem" },
            "& .fte-cell--diff": { color: "warning.main", fontWeight: 600 },
            "& .MuiDataGrid-columnHeader--filledGroup .MuiDataGrid-columnHeaderTitleContainer": { fontWeight: 700 },
          }}
        />
      </Box>
    </Box>
  );
}
