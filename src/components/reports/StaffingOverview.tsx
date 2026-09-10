/**
 * StaffingOverview — head count and FTE per department group and job title,
 * split by classification (managers, supervisors, non-managers, casuals).
 *
 * A grid grouped by department group (the mapping table's grouping, as the
 * budget pack uses) with a row per title, group subtotals and the hotel
 * total in the footer; per classification a head count and an FTE column.
 * Rows roll up by the job title as typed or by the Standard Title (a
 * toggle). A compared scenario adds its columns and the variances, matched
 * by group and title. The basis is a toggle too: Accounts (default) reads
 * the calculated lines, so HC and FTE are what every report and actuals
 * carry; Positions reads the rows as they stand — the Positions grid's FTE.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { DataGridPremium, GridColDef, GridColumnGroupingModel } from "@mui/x-data-grid-premium";
import type { ScenarioDto } from "../../shared/positions/ipc";
import {
  STAFFING_BUCKETS,
  STAFFING_BUCKET_LABELS,
  STAFFING_KINDS,
  STAFFING_KIND_LABELS,
  StaffingBucket,
  StaffingCells,
  StaffingBasis,
  StaffingKind,
  StaffingOverviewResponse,
  TitleMode,
} from "../../shared/reports/staffingOverview";
import { exportStaffingOverview, loadStaffingOverview } from "../../services/reportsService";
import { formatReportValue } from "./format";

export interface StaffingOverviewProps {
  ou: string;
  scenario: ScenarioDto;
  scenarios: ScenarioDto[];
  hotelName: string;
  onError: (error: unknown, fallback: string) => void;
  onNotice: (message: string) => void;
}

type Series = "b" | "c" | "v";

interface GridRow {
  id: string;
  /** Zero-padded group rank + label, so the grouping keeps the pack's order. */
  groupKey: string;
  title: string;
  [field: string]: string | number | null;
}

const fieldOf = (series: Series, kind: StaffingKind, bucket: StaffingBucket) => `${series}_${kind}_${bucket}`;
const groupKeyOf = (index: number, label: string) => `${String(index).padStart(3, "0")}|${label}`;
const groupLabelOf = (key: string) => key.slice(key.indexOf("|") + 1);

export default function StaffingOverview({ ou, scenario, scenarios, hotelName, onError, onNotice }: StaffingOverviewProps) {
  const [compareId, setCompareId] = useState<string>("");
  const [titleMode, setTitleMode] = useState<TitleMode>("title");
  const [basis, setBasis] = useState<StaffingBasis>("accounts");
  const [data, setData] = useState<StaffingOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadStaffingOverview(ou, scenario.id, { compareScenarioId: compareId || undefined, titleMode, basis })
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((err) => {
        if (!cancelled) {
          onError(err, "Failed to load the staffing overview");
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ou, scenario.id, compareId, titleMode, basis, onError]);

  const compareScenario = scenarios.find((s) => s.id === compareId) ?? null;
  const hasCompare = !!data?.compare;
  const series = useMemo<Series[]>(() => (hasCompare ? ["b", "c", "v"] : ["b"]), [hasCompare]);

  const rows = useMemo<GridRow[]>(() => {
    if (!data) return [];
    const out: GridRow[] = [];
    data.groups.forEach((group, index) => {
      for (const row of group.rows) {
        const item: GridRow = { id: `${group.label}|${row.title}`, groupKey: groupKeyOf(index, group.label), title: row.title };
        const cellsOf: Record<Series, StaffingCells | null> = { b: row.cells, c: row.compare, v: row.variance };
        for (const s of series) {
          for (const kind of STAFFING_KINDS) {
            for (const bucket of STAFFING_BUCKETS) {
              const cells = cellsOf[s];
              item[fieldOf(s, kind, bucket)] = cells ? cells[kind][bucket] : null;
            }
          }
        }
        out.push(item);
      }
    });
    return out;
  }, [data, series]);

  const columns = useMemo<GridColDef<GridRow>[]>(() => {
    const out: GridColDef<GridRow>[] = [{ field: "title", headerName: "Position", width: 260 }];
    for (const s of series) {
      for (const kind of STAFFING_KINDS) {
        for (const bucket of STAFFING_BUCKETS) {
          const field = fieldOf(s, kind, bucket);
          out.push({
            field,
            headerName: STAFFING_BUCKET_LABELS[bucket],
            width: 96,
            type: "number",
            align: "right",
            headerAlign: "right",
            valueFormatter: (value: number | null) => formatReportValue(value, kind === "hc" ? "number" : "ratio"),
            cellClassName: (params) => {
              const classes = ["staff-cell--num"];
              const value = params.value as number | null;
              // Fewer heads is the good news on a staffing line.
              if (s === "v" && typeof value === "number" && value !== 0) classes.push(value < 0 ? "staff-cell--good" : "staff-cell--bad");
              return classes.join(" ");
            },
          });
        }
      }
    }
    return out;
  }, [series]);

  const columnGroupingModel = useMemo<GridColumnGroupingModel>(() => {
    const seriesLabel: Record<Series, string> = {
      b: `${scenario.label} ${scenario.year}`,
      c: compareScenario ? `${compareScenario.label} ${compareScenario.year}` : "Compared",
      v: "Variance",
    };
    return series.map((s) => ({
      groupId: s,
      headerName: seriesLabel[s],
      headerAlign: "center",
      children: STAFFING_KINDS.map((kind) => ({
        groupId: `${s}_${kind}`,
        headerName: STAFFING_KIND_LABELS[kind],
        headerAlign: "center",
        children: STAFFING_BUCKETS.map((bucket) => ({ field: fieldOf(s, kind, bucket) })),
      })),
    }));
  }, [series, scenario, compareScenario]);

  const aggregationModel = useMemo(
    () =>
      Object.fromEntries(
        series.flatMap((s) => STAFFING_KINDS.flatMap((kind) => STAFFING_BUCKETS.map((bucket) => [fieldOf(s, kind, bucket), "sum"] as const)))
      ),
    [series]
  );

  const handleExport = useCallback(() => {
    setExporting(true);
    void (async () => {
      try {
        const result = await exportStaffingOverview(ou, scenario.id, {
          compareScenarioId: compareId || undefined,
          titleMode,
          basis,
          hotelName,
        });
        if (result.outcome === "saved") onNotice(`Saved ${result.path} (${result.sheets} sheets)`);
      } catch (err) {
        onError(err, "Export failed");
      } finally {
        setExporting(false);
      }
    })();
  }, [ou, scenario.id, compareId, titleMode, basis, hotelName, onError, onNotice]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
        <Tooltip
          title={
            basis === "accounts"
              ? "From the accounts, as every report and actuals read them: HC is the position count at year end; FTE is manager heads + hours ÷ (effective week × 52). Needs a calculated scenario."
              : "From the positions as they stand: HC is each row's Count; FTE is the Positions grid's (contract ÷ full-time week × Count × cluster share). Always current."
          }
        >
          <ToggleButtonGroup exclusive size="small" value={basis} onChange={(_event, next: StaffingBasis | null) => next && setBasis(next)}>
            <ToggleButton value="accounts">Accounts</ToggleButton>
            <ToggleButton value="positions">Positions</ToggleButton>
          </ToggleButtonGroup>
        </Tooltip>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="staff-compare">Compare with</InputLabel>
          <Select labelId="staff-compare" label="Compare with" value={compareId} onChange={(e) => setCompareId(String(e.target.value))}>
            <MenuItem value="">No comparison</MenuItem>
            {scenarios
              .filter((s) => s.id !== scenario.id)
              .map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.label} {s.year}
                </MenuItem>
              ))}
          </Select>
        </FormControl>
        <Tooltip title="Roll positions up by the job title as typed, or by the Standard Title (each falls back to the other, then to the classification)">
          <ToggleButtonGroup
            exclusive
            size="small"
            value={titleMode}
            onChange={(_event, next: TitleMode | null) => next && setTitleMode(next)}
          >
            <ToggleButton value="title">Job title</ToggleButton>
            <ToggleButton value="standard">Standard title</ToggleButton>
          </ToggleButtonGroup>
        </Tooltip>
        <Button
          variant="outlined"
          size="small"
          startIcon={exporting ? <CircularProgress size={14} color="inherit" /> : <FileDownloadOutlinedIcon />}
          onClick={handleExport}
          disabled={!data || exporting}
          sx={{ height: 36 }}
        >
          Export overview
        </Button>
        <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
          {data?.weeklyHours && (
            <Chip
              size="small"
              variant="outlined"
              label={`Effective week ${data.weeklyHours.value.toFixed(2)} h`}
              sx={{ height: 28, fontWeight: 600 }}
            />
          )}
          {/* The positions basis is current by construction; the run only matters to the accounts. */}
          {data?.basis === "accounts" && data.run && (
            <Chip
              size="small"
              variant="outlined"
              color={data.run.stale ? "warning" : "success"}
              label={data.run.stale ? "Results out of date — the positions changed since the last calculation" : `Calculated ${new Date(data.run.computedAt).toLocaleString()}`}
              sx={{ height: 28, fontWeight: 600 }}
            />
          )}
        </Stack>
      </Stack>

      {data?.warnings.map((warning) => (
        <Alert key={`${warning.code}|${warning.message}`} severity="warning" sx={{ mb: 2 }}>
          {warning.message}
        </Alert>
      ))}

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
            "& .staff-cell--num": { fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.8125rem" },
            "& .staff-cell--good": { color: "success.main" },
            "& .staff-cell--bad": { color: "error.main" },
            "& .MuiDataGrid-columnHeader--filledGroup .MuiDataGrid-columnHeaderTitleContainer": { fontWeight: 700 },
          }}
        />
      </Box>
    </Box>
  );
}
