/**
 * PositionBridge — the payroll line, explained by the positions under it.
 *
 * For a scenario: the headline figures a DOF reads first (payroll, heads,
 * FTE, payroll per FTE, hours), the plan against what the BST holds, then a
 * matrix — a row per position grouped by department, and across the top the
 * payroll accounts as a tree from the account map (L12 → L14 → L18 → L21 →
 * account). The depth selector opens the whole tree to a level; the chevron
 * on a header opens or folds one group, and an open group ends in its
 * subtotal. Non-engine lines are rows of their own, so the department
 * subtotal is exactly the P&L's Total Payroll for that department. Clicking
 * a row lists the block lines behind it.
 *
 * A compared scenario adds its payroll and the difference, matched by
 * lineage; "Show change" turns every figure into this − compared instead.
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
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import {
  DataGridPremium,
  GridColDef,
  GridColumnGroupingModel,
  GridRowClassNameParams,
} from "@mui/x-data-grid-premium";
import type { ScenarioDto } from "../../shared/positions/ipc";
import {
  BRIDGE_BUCKET_LABELS,
  BRIDGE_STAT_BUCKETS,
  BridgeBucket,
  BridgeCell,
  BridgeRow,
  PositionBridgeResponse,
  bucketTotal,
  indexByLineage,
  payrollTotal,
  summarize,
} from "../../shared/reports/bridge";
import {
  BRIDGE_DEPTHS,
  BridgeLayoutItem,
  BridgeMatrixColumn,
  DEFAULT_BRIDGE_DEPTH,
  activePayrollAccounts,
  amountsOf,
  buildAccountTree,
  depthLabel,
  expandedForDepth,
  isExpandable,
  layoutMatrix,
  sumAccounts,
} from "../../shared/reports/bridgeMatrix";
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
  /** Matrix and statistic columns, by field. */
  values: Record<string, number>;
  payroll: number;
  compare: number | null;
  delta: number | null;
  status: "" | "inactive" | "deleted" | "new" | "removed";
  row: BridgeRow;
}

type GroupNode = GridColumnGroupingModel[number]["children"][number];

const money = (value: number | null | undefined) => formatReportValue(value, "currency");
const matrixField = (column: BridgeMatrixColumn) => `m_${column.node.id}`;
const statField = (bucket: BridgeBucket) => `s_${bucket}`;

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

/** A header's open/fold chevron — stops the click before it sorts the column. */
function HeaderToggle({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <Stack direction="row" spacing={0.25} sx={{ alignItems: "center", minWidth: 0 }}>
      <IconButton
        size="small"
        aria-label={open ? `Fold ${label}` : `Open ${label}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        sx={{ p: 0.25 }}
      >
        {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
      </IconButton>
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
        {label}
      </Box>
    </Stack>
  );
}

/** Account → this − compared. */
function changeOf(own: readonly BridgeCell[], other: readonly BridgeCell[]): Map<string, number> {
  const out = amountsOf(own);
  for (const [account, total] of amountsOf(other)) out.set(account, (out.get(account) ?? 0) - total);
  return out;
}

export default function PositionBridge({ ou, scenario, scenarios, hotelName, onError, onNotice }: PositionBridgeProps) {
  const navigate = useNavigate();
  const [compareId, setCompareId] = useState<string>("");
  const [dept, setDept] = useState<string>("");
  const [data, setData] = useState<PositionBridgeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [depth, setDepth] = useState<number>(DEFAULT_BRIDGE_DEPTH);
  /** Header clicks since the depth was last chosen; null = just the depth. */
  const [opened, setOpened] = useState<Set<string> | null>(null);
  const [showChange, setShowChange] = useState(false);

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
  const comparedDepartments = useMemo(
    () => (data?.compare ? data.compare.departments.filter((d) => !dept || d.code === dept) : []),
    [data, dept]
  );
  const summary = useMemo(() => summarize(departments), [departments]);

  // The column tree: only the payroll accounts with a value under the filter
  // (on either side of a comparison).
  const tree = useMemo(
    () => buildAccountTree(data ? activePayrollAccounts(data.accounts, [...departments, ...comparedDepartments]) : []),
    [data, departments, comparedDepartments]
  );
  const expanded = useMemo(() => opened ?? expandedForDepth(tree, depth), [opened, tree, depth]);
  const layout = useMemo(() => layoutMatrix(tree, expanded), [tree, expanded]);
  const statBuckets = useMemo(
    () =>
      BRIDGE_STAT_BUCKETS.filter((b) =>
        [...departments, ...comparedDepartments].some((d) => d.totals.some((c) => c.bucket === b))
      ),
    [departments, comparedDepartments]
  );

  const toggle = useCallback(
    (key: string) =>
      setOpened((previous) => {
        const next = new Set(previous ?? expandedForDepth(tree, depth));
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [tree, depth]
  );

  const bstPayroll = useMemo(() => {
    if (!data?.bst.available) return null;
    let sum = 0;
    for (const d of departments) {
      const held = data.bst.byDept[d.code] ?? {};
      for (const cell of d.totals) if (cell.bucket === "payroll") sum += held[cell.account] ?? 0;
    }
    return sum;
  }, [data, departments]);

  const compareIndex = useMemo(() => (data?.compare ? indexByLineage(data.compare.departments) : null), [data]);
  const compareLabel = scenarios.find((s) => s.id === compareId);
  const change = showChange && compareIndex !== null;

  const rows = useMemo<GridRow[]>(() => {
    const valuesOf = (amounts: ReadonlyMap<string, number>, stat: (b: BridgeBucket) => number) => {
      const values: Record<string, number> = {};
      for (const column of layout.columns) values[matrixField(column)] = sumAccounts(amounts, column.node.accounts);
      for (const b of statBuckets) values[statField(b)] = stat(b);
      return values;
    };
    const out: GridRow[] = [];
    const matched = new Set<string>();
    for (const d of departments) {
      for (const r of d.rows) {
        const other = compareIndex && r.lineageId ? compareIndex.get(r.lineageId) ?? null : null;
        if (other) matched.add(other.key);
        const otherCells = change && other ? other.cells : [];
        const payroll = payrollTotal(r.cells);
        const compare = compareIndex ? (other ? payrollTotal(other.cells) : 0) : null;
        const count = (own: number | null, theirs: number | null | undefined) =>
          change && own !== null ? own - (theirs ?? 0) : own;
        out.push({
          id: r.key,
          dept: d.code,
          deptName: d.name,
          label: r.source === "ENGINE" ? r.label || r.jobTypeCode || r.positionId || "" : r.label,
          grade: r.jobTypeCode ?? "",
          source: r.source,
          headcount: count(r.headcount, other?.headcount),
          fte: count(r.fte, other?.fte),
          values: valuesOf(changeOf(r.cells, otherCells), (b) => bucketTotal(r.cells, b) - bucketTotal(otherCells, b)),
          payroll: change ? payroll - (compare ?? 0) : payroll,
          compare,
          delta: compare === null ? null : payroll - compare,
          status: r.deleted ? "deleted" : !r.active ? "inactive" : compareIndex && r.lineageId && !other ? "new" : "",
          row: r,
        });
      }
    }
    // Positions only in the compared scenario.
    for (const d of comparedDepartments) {
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
          headcount: change ? -(r.headcount ?? 0) : null,
          fte: change ? -(r.fte ?? 0) : null,
          values: change
            ? valuesOf(changeOf([], r.cells), (b) => -bucketTotal(r.cells, b))
            : valuesOf(new Map(), () => 0),
          payroll: change ? -compare : 0,
          compare,
          delta: -compare,
          status: "removed",
          row: r,
        });
      }
    }
    return out;
  }, [departments, comparedDepartments, compareIndex, change, layout, statBuckets]);

  const columns = useMemo<GridColDef<GridRow>[]>(() => {
    const numeric = (
      field: string,
      headerName: string,
      get: (row: GridRow) => number | null,
      format: "currency" | "number" | "ratio" = "currency",
      width = 120
    ): GridColDef<GridRow> => ({
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
    const matrixColumn = (column: BridgeMatrixColumn): GridColDef<GridRow> => {
      const field = matrixField(column);
      const base = numeric(field, column.kind === "subtotal" ? "Total" : column.label, (r) => r.values[field] ?? 0, "currency", column.kind === "account" ? 140 : 130);
      const node = column.node;
      if (column.kind === "subtotal") {
        return { ...base, description: column.label, cellClassName: "bridge-cell--num bridge-cell--subtotal" };
      }
      if (column.kind === "account") return { ...base, description: `${node.account} · ${node.label}` };
      return {
        ...base,
        headerAlign: "left",
        description: node.accounts.length === 1 ? `${node.label} — account ${node.accounts[0]}` : `${node.label} — ${node.accounts.length} accounts`,
        ...(isExpandable(node)
          ? { renderHeader: () => <HeaderToggle label={node.label} open={false} onToggle={() => toggle(node.key)} /> }
          : {}),
      };
    };
    return [
      { field: "dept", headerName: "Department", width: 110 },
      {
        field: "label",
        headerName: "Position",
        width: 240,
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
      { field: "grade", headerName: "Grade", width: 130 },
      numeric("headcount", "Count", (r) => r.headcount, "number", 80),
      numeric("fte", "FTE", (r) => r.fte, "ratio", 80),
      ...layout.columns.map(matrixColumn),
      ...statBuckets.map((b) => numeric(statField(b), BRIDGE_BUCKET_LABELS[b], (r) => r.values[statField(b)] ?? 0, "number", 110)),
      numeric("payroll", change ? "Payroll change" : "Total payroll", (r) => r.payroll, "currency", 130),
      ...(compareIndex && !change
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
  }, [layout, statBuckets, compareIndex, compareLabel, change, toggle]);

  // Every open group becomes a header over its children and subtotal.
  const columnGroupingModel = useMemo<GridColumnGroupingModel>(() => {
    const toNode = (item: BridgeLayoutItem): GroupNode =>
      item.type === "column"
        ? { field: matrixField(item.column) }
        : {
            groupId: item.node.id,
            headerName: item.node.label,
            description: `${item.node.label} — ${item.node.accounts.length} accounts`,
            renderHeaderGroup: () => <HeaderToggle label={item.node.label} open onToggle={() => toggle(item.node.key)} />,
            children: item.items.map(toNode),
          };
    return layout.items.filter((item) => item.type === "group").map(toNode) as GridColumnGroupingModel;
  }, [layout, toggle]);

  const aggregationModel = useMemo(
    () => Object.fromEntries(columns.filter((c) => c.type === "number").map((c) => [c.field, "sum"] as const)),
    [columns]
  );

  const handleExport = useCallback(() => {
    setExporting(true);
    void (async () => {
      try {
        const result = await exportPositionBridge(ou, scenario.id, { dept: dept || undefined, hotelName, depth });
        if (result.outcome === "saved") onNotice(`Saved ${result.path} (${result.sheets} sheets)`);
      } catch (err) {
        onError(err, "Export failed");
      } finally {
        setExporting(false);
      }
    })();
  }, [ou, scenario.id, dept, hotelName, depth, onError, onNotice]);

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
        <Tooltip title="How far to open the account tree. The chevrons on the headers open or fold one group.">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={depth}
            onChange={(_e, value: number | null) => {
              if (value === null) return;
              setDepth(value);
              setOpened(null);
            }}
            aria-label="Account detail"
            sx={{ height: 36 }}
          >
            {BRIDGE_DEPTHS.map((d) => (
              <ToggleButton key={d} value={d} sx={{ px: 1.25, textTransform: "none" }}>
                {depthLabel(d)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Tooltip>
        <Tooltip title={compareId ? "Show every figure as this scenario minus the compared one" : "Pick a scenario to compare with first"}>
          <FormControlLabel
            control={<Switch size="small" checked={showChange} disabled={!compareId} onChange={(e) => setShowChange(e.target.checked)} />}
            label="Show change"
            sx={{ mr: 0 }}
          />
        </Tooltip>
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

      {change && (
        <Alert severity="info" sx={{ mb: 1.5, py: 0 }}>
          Every figure is this scenario minus {compareLabel ? `${compareLabel.label} ${compareLabel.year}` : "the compared scenario"}.
        </Alert>
      )}

      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <DataGridPremium
            rows={rows}
            columns={columns}
            columnGroupingModel={columnGroupingModel}
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
            disableColumnReorder
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
              "& .bridge-cell--subtotal": { fontWeight: 700, bgcolor: "action.hover" },
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
                  {selectedRow.row.headcount !== null && selectedRow.row.headcount !== 1 ? ` · ×${selectedRow.row.headcount}` : ""}
                </Typography>
              </Box>
              <IconButton size="small" onClick={() => setSelected(null)} aria-label="Close">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
            <Divider />
            <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", py: 1 }}>
              <Stack spacing={1}>
                {selectedRow.row.lines.map((line, index) => {
                  const account = data?.accounts.find((a) => a.code === line.account);
                  return (
                    <Stack key={`${line.account}:${line.label}:${index}`} direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" noWrap>
                          {line.label || line.account}
                        </Typography>
                        <Tooltip title={account?.path.map((step) => step.label).join(" › ") ?? ""}>
                          <Typography variant="caption" color="text.secondary" noWrap component="div">
                            {line.account}
                            {account?.name ? ` · ${account.name}` : ""}
                            {line.encoding === "LEVEL" ? " · level" : ""}
                          </Typography>
                        </Tooltip>
                      </Box>
                      <Tooltip title={line.months.map((m) => formatReportValue(m, "number")).join(" · ")}>
                        <Typography variant="body2" sx={{ fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" }}>
                          {formatReportValue(line.total, line.encoding === "LEVEL" || line.account.startsWith("9") ? "number" : "currency")}
                        </Typography>
                      </Tooltip>
                    </Stack>
                  );
                })}
              </Stack>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}
