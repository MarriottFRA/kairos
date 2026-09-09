/**
 * PositionBridge — the payroll line, explained by the positions under it.
 *
 * For a scenario: the headline figures a DOF reads first (payroll, heads,
 * FTE, payroll per FTE, hours), the plan against what the BST holds, then a
 * grid grouped by department with a row per position (title, grade, count,
 * FTE, the account buckets, total payroll) and the non-engine lines as rows
 * of their own — so the department subtotal is exactly the P&L's Total
 * Payroll for that department. Clicking a row lists the block lines behind
 * it. A compared scenario adds its payroll and the difference, matched by
 * lineage; positions only on one side say so.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { DataGridPremium, GridColDef, GridRowClassNameParams } from "@mui/x-data-grid-premium";
import type { ScenarioDto } from "../../shared/positions/ipc";
import {
  BRIDGE_BUCKET_LABELS,
  BRIDGE_BUCKET_ORDER,
  BridgeBucket,
  BridgeRow,
  PAYROLL_BUCKETS,
  PositionBridgeResponse,
  bucketTotal,
  indexByLineage,
  payrollTotal,
  summarize,
} from "../../shared/reports/bridge";
import { exportPositionBridge, loadPositionBridge } from "../../services/reportsService";
import { formatReportValue } from "./format";
import { SourceChip } from "../results/sourceMeta";

export interface PositionBridgeProps {
  ou: string;
  scenario: ScenarioDto;
  scenarios: ScenarioDto[];
  hotelName: string;
  onError: (error: unknown, fallback: string) => void;
  onNotice: (message: string) => void;
}

interface GridRow {
  id: string;
  dept: string;
  deptName: string;
  label: string;
  grade: string;
  source: BridgeRow["source"];
  headcount: number | null;
  fte: number | null;
  buckets: Partial<Record<BridgeBucket, number>>;
  payroll: number;
  compare: number | null;
  delta: number | null;
  status: "" | "inactive" | "deleted" | "new" | "removed";
  row: BridgeRow;
}

const money = (value: number | null | undefined) => formatReportValue(value, "currency");

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Paper variant="outlined" sx={{ px: 2, py: 1.25, minWidth: 150 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" sx={{ fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.2 }}>
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
    </Paper>
  );
}

export default function PositionBridge({ ou, scenario, scenarios, hotelName, onError, onNotice }: PositionBridgeProps) {
  const navigate = useNavigate();
  const [compareId, setCompareId] = useState<string>("");
  const [dept, setDept] = useState<string>("");
  const [data, setData] = useState<PositionBridgeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadPositionBridge(ou, scenario.id, { compareScenarioId: compareId || undefined })
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((err) => {
        if (!cancelled) {
          onError(err, "Failed to load the payroll bridge");
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ou, scenario.id, compareId, onError]);

  const departments = useMemo(
    () => (data ? data.departments.filter((d) => !dept || d.code === dept) : []),
    [data, dept]
  );
  const summary = useMemo(() => summarize(departments), [departments]);
  const buckets = useMemo<BridgeBucket[]>(() => {
    const seen = new Set<BridgeBucket>();
    for (const d of departments) for (const c of d.totals) seen.add(c.bucket);
    return BRIDGE_BUCKET_ORDER.filter((b) => seen.has(b));
  }, [departments]);

  const bstPayroll = useMemo(() => {
    if (!data?.bst.available) return null;
    let sum = 0;
    for (const d of departments) {
      const held = data.bst.byDept[d.code] ?? {};
      for (const cell of d.totals) if (PAYROLL_BUCKETS.has(cell.bucket)) sum += held[cell.account] ?? 0;
    }
    return sum;
  }, [data, departments]);

  const compareIndex = useMemo(() => (data?.compare ? indexByLineage(data.compare.departments) : null), [data]);
  const compareLabel = scenarios.find((s) => s.id === compareId);

  const rows = useMemo<GridRow[]>(() => {
    const out: GridRow[] = [];
    const matched = new Set<string>();
    for (const d of departments) {
      for (const r of d.rows) {
        const other = compareIndex && r.lineageId ? compareIndex.get(r.lineageId) ?? null : null;
        if (other) matched.add(other.key);
        const payroll = payrollTotal(r.cells);
        const compare = compareIndex ? (other ? payrollTotal(other.cells) : 0) : null;
        out.push({
          id: r.key,
          dept: d.code,
          deptName: d.name,
          label: r.source === "ENGINE" ? r.label || r.jobTypeCode || r.positionId || "" : r.label,
          grade: r.jobTypeCode ?? "",
          source: r.source,
          headcount: r.headcount,
          fte: r.fte,
          buckets: Object.fromEntries(buckets.map((b) => [b, bucketTotal(r.cells, b)])),
          payroll,
          compare,
          delta: compare === null ? null : payroll - compare,
          status: r.deleted ? "deleted" : !r.active ? "inactive" : compareIndex && r.lineageId && !other ? "new" : "",
          row: r,
        });
      }
    }
    // Positions only in the compared scenario.
    if (data?.compare) {
      for (const d of data.compare.departments) {
        if (dept && d.code !== dept) continue;
        for (const r of d.rows) {
          if (r.source !== "ENGINE" || matched.has(r.key) || !r.lineageId) continue;
          const compare = payrollTotal(r.cells);
          out.push({
            id: `cmp:${r.key}`,
            dept: d.code,
            deptName: d.name,
            label: r.label || r.jobTypeCode || "",
            grade: r.jobTypeCode ?? "",
            source: r.source,
            headcount: null,
            fte: null,
            buckets: {},
            payroll: 0,
            compare,
            delta: -compare,
            status: "removed",
            row: r,
          });
        }
      }
    }
    return out;
  }, [departments, buckets, compareIndex, data, dept]);

  const columns = useMemo<GridColDef<GridRow>[]>(() => {
    const numeric = (field: string, headerName: string, get: (row: GridRow) => number | null, format: "currency" | "number" | "ratio" = "currency", width = 120): GridColDef<GridRow> => ({
      field,
      headerName,
      width,
      type: "number",
      align: "right",
      headerAlign: "right",
      valueGetter: (_value, row) => (row?.row ? get(row) : null),
      valueFormatter: (value: number | null) => formatReportValue(value, format),
      cellClassName: "bridge-cell--num",
    });
    return [
      { field: "dept", headerName: "Department", width: 110 },
      {
        field: "label",
        headerName: "Position",
        width: 260,
        renderCell: (params) =>
          params.row?.row ? (
            <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
              {params.row.source !== "ENGINE" && <SourceChip source={params.row.source} dense />}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{params.value as string}</span>
              {params.row.status && (
                <Chip
                  size="small"
                  variant="outlined"
                  color={params.row.status === "new" ? "success" : params.row.status === "removed" ? "error" : "default"}
                  label={params.row.status}
                  sx={{ height: 18, fontSize: "0.625rem" }}
                />
              )}
            </Stack>
          ) : null,
      },
      { field: "grade", headerName: "Grade", width: 140 },
      numeric("headcount", "Count", (r) => r.headcount, "number", 90),
      numeric("fte", "FTE", (r) => r.fte, "ratio", 90),
      ...buckets.map((b) =>
        numeric(`b_${b}`, BRIDGE_BUCKET_LABELS[b], (r) => r.buckets[b] ?? 0, b === "hours" || b === "heads" ? "number" : "currency")
      ),
      numeric("payroll", "Total payroll", (r) => r.payroll, "currency", 130),
      ...(compareIndex
        ? [
            numeric("compare", compareLabel ? `${compareLabel.label} ${compareLabel.year}` : "Compared", (r) => r.compare, "currency", 130),
            {
              ...numeric("delta", "Difference", (r) => r.delta, "currency", 120),
              cellClassName: (params: { value?: unknown }) =>
                `bridge-cell--num ${typeof params.value === "number" && params.value !== 0 ? (params.value < 0 ? "bridge-cell--good" : "bridge-cell--bad") : ""}`,
            },
          ]
        : []),
    ];
  }, [buckets, compareIndex, compareLabel]);

  const aggregationModel = useMemo(
    () =>
      Object.fromEntries(
        ["headcount", "fte", ...buckets.map((b) => `b_${b}`), "payroll", "compare", "delta"].map((f) => [f, "sum"] as const)
      ),
    [buckets]
  );

  const handleExport = useCallback(() => {
    setExporting(true);
    void (async () => {
      try {
        const result = await exportPositionBridge(ou, scenario.id, { dept: dept || undefined, hotelName });
        if (result.outcome === "saved") onNotice(`Saved ${result.path} (${result.sheets} sheets)`);
      } catch (err) {
        onError(err, "Export failed");
      } finally {
        setExporting(false);
      }
    })();
  }, [ou, scenario.id, dept, hotelName, onError, onNotice]);

  const selectedRow = rows.find((r) => r.id === selected) ?? null;
  const difference = bstPayroll === null ? null : summary.payroll - bstPayroll;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="bridge-dept">Department</InputLabel>
          <Select labelId="bridge-dept" label="Department" value={dept} onChange={(e) => setDept(String(e.target.value))}>
            <MenuItem value="">All departments</MenuItem>
            {(data?.departments ?? []).map((d) => (
              <MenuItem key={d.code} value={d.code}>
                {d.code} · {d.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="bridge-compare">Compare with</InputLabel>
          <Select labelId="bridge-compare" label="Compare with" value={compareId} onChange={(e) => setCompareId(String(e.target.value))}>
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
        <Button
          variant="outlined"
          size="small"
          startIcon={exporting ? <CircularProgress size={14} color="inherit" /> : <FileDownloadOutlinedIcon />}
          onClick={handleExport}
          disabled={!data || exporting}
          sx={{ height: 36 }}
        >
          Export bridge
        </Button>
        <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
          {data?.run && (
            <Chip
              size="small"
              variant="outlined"
              color={data.run.stale ? "warning" : "success"}
              label={data.run.stale ? "Results out of date — recalculate" : `Calculated ${new Date(data.run.computedAt).toLocaleString()}`}
              sx={{ height: 28, fontWeight: 600 }}
            />
          )}
        </Stack>
      </Stack>

      {data && !data.run && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This scenario has not been calculated yet — open Results and Recalculate.
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} sx={{ mb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
        <Stat label="Total payroll" value={money(summary.payroll)} hint={`${departments.length} department${departments.length === 1 ? "" : "s"}`} />
        <Stat label="Heads" value={formatReportValue(summary.heads, "number")} />
        <Stat label="FTE" value={formatReportValue(summary.fte, "ratio")} />
        <Stat label="Payroll per FTE" value={money(summary.payrollPerFte)} />
        <Stat label="Hours" value={formatReportValue(summary.hours, "number")} />
        <Paper
          variant="outlined"
          sx={{ px: 2, py: 1.25, minWidth: 320, borderColor: difference ? "warning.main" : undefined }}
        >
          <Typography variant="caption" color="text.secondary">
            Plan vs BST {data?.bst.bucket ? `(${data.bst.bucket})` : ""}
          </Typography>
          {bstPayroll === null ? (
            <Typography variant="body2">No BST pull for this hotel — nothing to reconcile against.</Typography>
          ) : (
            <Stack direction="row" spacing={2} sx={{ alignItems: "baseline" }}>
              <Typography variant="body2">
                BST <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{money(bstPayroll)}</b>
              </Typography>
              <Typography variant="body2" color={difference ? "warning.main" : "success.main"}>
                {difference ? `Plan is ${money(Math.abs(difference))} ${difference > 0 ? "above" : "below"} the BST — push before reviewing` : "In step with the BST"}
              </Typography>
              {!!difference && (
                <Button size="small" onClick={() => navigate("/signed-in-landing/bst-push")}>
                  Go to BST Push
                </Button>
              )}
            </Stack>
          )}
        </Paper>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <DataGridPremium
            rows={rows}
            columns={columns}
            loading={loading}
            rowGroupingModel={["dept"]}
            groupingColDef={{
              headerName: "Department",
              width: 220,
              valueFormatter: (value: unknown) => {
                const code = String(value ?? "");
                const name = data?.departments.find((d) => d.code === code)?.name;
                return name ? `${code} · ${name}` : code;
              },
            }}
            defaultGroupingExpansionDepth={-1}
            initialState={{ aggregation: { model: aggregationModel }, pinnedColumns: { right: ["payroll"] } }}
            aggregationModel={aggregationModel}
            disableRowSelectionOnClick
            onRowClick={(params) => {
              if ((params.row as GridRow).row) setSelected(params.row.id as string);
            }}
            getRowClassName={(params: GridRowClassNameParams<GridRow>) =>
              params.row.id === selected ? "bridge-row--selected" : ""
            }
            rowHeight={32}
            columnHeaderHeight={40}
            sx={{
              borderRadius: 2,
              "& .bridge-cell--num": { fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.8125rem" },
              "& .bridge-cell--good": { color: "success.main" },
              "& .bridge-cell--bad": { color: "error.main" },
              "& .bridge-row--selected": { bgcolor: "action.selected" },
              "& .MuiDataGrid-cell": { cursor: "pointer" },
            }}
          />
        </Box>
        {selectedRow && (
          <Box sx={{ width: 360, flexShrink: 0, borderLeft: 1, borderColor: "divider", pl: 2, ml: 2, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <Stack direction="row" sx={{ alignItems: "flex-start", mb: 1 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="overline" color="text.secondary">
                  Lines behind this row
                </Typography>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
                  {selectedRow.label}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {selectedRow.dept} · {selectedRow.grade}
                  {selectedRow.headcount !== null && selectedRow.headcount !== 1 ? ` · ×${selectedRow.headcount}` : ""}
                </Typography>
              </Box>
              <IconButton size="small" onClick={() => setSelected(null)} aria-label="Close">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
            <Divider />
            <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", py: 1 }}>
              <Stack spacing={1}>
                {selectedRow.row.lines.map((line, index) => (
                  <Stack key={`${line.account}:${line.label}:${index}`} direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" noWrap>
                        {line.label || line.account}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {line.account}
                        {data?.accounts.find((a) => a.code === line.account)?.name ? ` · ${data.accounts.find((a) => a.code === line.account)!.name}` : ""}
                        {line.encoding === "LEVEL" ? " · level" : ""}
                      </Typography>
                    </Box>
                    <Tooltip title={line.months.map((m) => formatReportValue(m, "number")).join(" · ")}>
                      <Typography variant="body2" sx={{ fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" }}>
                        {formatReportValue(line.total, line.encoding === "LEVEL" || line.account.startsWith("9") ? "number" : "currency")}
                      </Typography>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}
