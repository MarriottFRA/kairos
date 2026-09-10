/**
 * StaffingStatistics — heads, FTE and hours for the hotel, each department
 * group (department map level 10), each department and each position, with
 * the hours broken down by the account they post to.
 *
 * A tree: the hotel total is pinned on top; groups open onto departments,
 * departments onto the positions (and any manual input, allocation or buyout
 * lines) that make up their figures. "Show" opens every row to a depth in
 * one click; the chevrons open one at a time. The period picker reads one
 * month or the year (heads at year end, FTE the average, hours the total).
 *
 * Hours columns sit under the kind of hours they are — the ones that drive
 * FTE first, then overtime, manager, buyout — so the FTE figure explains
 * itself; "By type" folds the accounts into one column per kind when a hotel
 * posts to many.
 *
 * Grade mixing is a mark, not a column: a corner triangle on an hours cell
 * whose account more than one grade books to (amber), or where hours land on
 * the wrong side of FTE (red — manager hours counted twice, or staff hours
 * left out). The tooltip says who put how many hours there. The chip up top
 * counts them and turns the marks off; the Excel export lists them on a sheet
 * of their own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  DataGridPremium,
  GridColDef,
  GridColumnGroupingModel,
  GridRenderCellParams,
  useGridApiContext,
  useGridApiRef,
} from "@mui/x-data-grid-premium";
import type { ScenarioDto } from "../../shared/positions/ipc";
import { describeEffectiveWeek } from "../../shared/positions/effectiveWeek";
import {
  GradeMixEntry,
  GradeTier,
  HOURS_KINDS,
  HOURS_KIND_LABELS,
  HoursKind,
  StaffingStatisticsResponse,
  StaffingStatsAccount,
  StaffingStatsNode,
  YEAR_SLOT,
  describeMix,
  distortsFte,
  hoursOfKind,
  shortAccountName,
} from "../../shared/reports/staffingStatistics";
import { WEEKLY_HOURS_ORIGIN_LABELS } from "../../shared/reports/weeklyHours";
import { exportStaffingStatistics, loadStaffingStatistics } from "../../services/reportsService";
import { formatReportValue } from "./format";

export interface StaffingStatisticsProps {
  ou: string;
  scenario: ScenarioDto;
  hotelName: string;
  onError: (error: unknown, fallback: string) => void;
  onNotice: (message: string) => void;
}

/** 0 = groups, 1 = departments, 2 = positions. */
type Depth = 0 | 1 | 2;
type HoursMode = "account" | "type";

interface GridRow {
  id: string;
  path: string[];
  node: StaffingStatsNode;
  depth: number;
  hasChildren: boolean;
  [field: string]: unknown;
}

const MONTH_LABELS = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleString("en", { month: "short" }));

const TIER_CHIP: Record<GradeTier, { label: string; color: "primary" | "secondary" | "default" }> = {
  mgr: { label: "Mgr", color: "primary" },
  svsr: { label: "Svsr", color: "secondary" },
  assoc: { label: "Assoc", color: "default" },
};

const accField = (code: string) => `acc_${code}`;
const kindField = (kind: HoursKind) => `kind_${kind}`;
const entryKey = (dept: string, account: string) => `${dept}|${account}`;

function toRow(node: StaffingStatsNode, path: string[], depth: number, slot: number, accounts: readonly StaffingStatsAccount[]): GridRow {
  const v = node.values;
  const row: GridRow = {
    id: node.id,
    path,
    node,
    depth,
    hasChildren: node.children.length > 0,
    heads: v.heads[slot],
    fte_mgr: v.managerHeads[slot],
    fte_hours: v.hoursFte[slot],
    fte: v.fte[slot],
    hours: v.hours[slot],
  };
  for (const account of accounts) row[accField(account.code)] = v.byAccount[account.code]?.[slot] ?? 0;
  for (const kind of HOURS_KINDS) row[kindField(kind)] = hoursOfKind(v, accounts, kind)[slot];
  return row;
}

/** The label cell: indentation, the chevron, the name and — on a position — its grade. */
function LabelCell(params: GridRenderCellParams<GridRow>) {
  const apiRef = useGridApiContext();
  const { rowNode, row } = params;
  const node = row.node;
  const isGroup = rowNode.type === "group";
  const expanded = isGroup && rowNode.childrenExpanded;
  const depth = rowNode.type === "pinnedRow" ? 0 : rowNode.depth;
  const label = node.kind === "department" ? `${node.code} · ${node.label}` : node.label;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, pl: depth * 2.5, minWidth: 0, width: "100%" }}>
      {isGroup ? (
        <IconButton
          size="small"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={(event) => {
            event.stopPropagation();
            apiRef.current.setRowChildrenExpansion(params.id, !expanded);
          }}
          sx={{ p: 0.25 }}
        >
          {expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </IconButton>
      ) : (
        <Box sx={{ width: 26, flexShrink: 0 }} />
      )}
      <Typography
        variant="body2"
        noWrap
        title={label}
        sx={{
          fontWeight: node.kind === "hotel" || node.kind === "group" ? 700 : node.kind === "department" ? 500 : 400,
          color: node.deleted || node.kind === "other" ? "text.secondary" : "text.primary",
          fontStyle: node.kind === "other" ? "italic" : "normal",
          minWidth: 0,
        }}
      >
        {label}
        {node.deleted ? " (deleted)" : ""}
      </Typography>
      {node.kind === "group" && (
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          {node.children.length}
        </Typography>
      )}
      {node.tier && (
        <Tooltip title={node.jobTypeCode ?? ""}>
          <Chip
            size="small"
            variant="outlined"
            color={TIER_CHIP[node.tier].color}
            label={TIER_CHIP[node.tier].label}
            sx={{ height: 18, fontSize: "0.6875rem", flexShrink: 0, "& .MuiChip-label": { px: 0.75 } }}
          />
        </Tooltip>
      )}
    </Box>
  );
}

export default function StaffingStatistics({ ou, scenario, hotelName, onError, onNotice }: StaffingStatisticsProps) {
  const [data, setData] = useState<StaffingStatisticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [slot, setSlot] = useState<number>(YEAR_SLOT);
  // Opens fully expanded (user's call, 2026-09-10); collapsing is one click away.
  const [depth, setDepth] = useState<Depth>(2);
  const [hoursMode, setHoursMode] = useState<HoursMode>("account");
  const [showMix, setShowMix] = useState(true);
  const apiRef = useGridApiRef();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadStaffingStatistics(ou, scenario.id)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((err) => {
        if (!cancelled) {
          onError(err, "Failed to load the staffing statistics");
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

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const kindsPresent = useMemo(() => HOURS_KINDS.filter((kind) => accounts.some((a) => a.kind === kind)), [accounts]);
  const entries = useMemo(
    () => new Map<string, GradeMixEntry>((data?.gradeMix ?? []).map((entry) => [entryKey(entry.dept, entry.account), entry])),
    [data]
  );

  const rows = useMemo<GridRow[]>(() => {
    if (!data) return [];
    const out: GridRow[] = [];
    const visit = (node: StaffingStatsNode, path: string[], level: number) => {
      out.push(toRow(node, path, level, slot, accounts));
      for (const child of node.children) visit(child, [...path, child.id], level + 1);
    };
    for (const group of data.hotel.children) visit(group, [group.id], 0);
    return out;
  }, [data, slot, accounts]);

  const pinnedRows = useMemo(
    () => (data ? { top: [toRow(data.hotel, [data.hotel.id], 0, slot, accounts)] } : undefined),
    [data, slot, accounts]
  );

  // "Show" opens or closes every row to the chosen depth; the chevrons stay
  // free to open one at a time after that.
  const firstDepth = useRef(true);
  useEffect(() => {
    if (firstDepth.current) {
      firstDepth.current = false;
      return;
    }
    const api = apiRef.current;
    if (!api) return;
    for (const row of rows) if (row.hasChildren) api.setRowChildrenExpansion(row.id, row.depth < depth);
    // Only a change of depth re-applies it (rows left out on purpose): new
    // rows take defaultGroupingExpansionDepth instead.
  }, [depth, apiRef]);

  const mixMark = useCallback(
    (row: GridRow, cellAccounts: readonly StaffingStatsAccount[]) => {
      if (!showMix) return null;
      const flagged = cellAccounts
        .map((account) => ({ account, cell: row.node.mix[account.code] }))
        .filter((item) => item.cell && item.cell.kinds.length > 0);
      if (flagged.length === 0) return null;
      const title = flagged
        .map(
          ({ account, cell }) =>
            (cellAccounts.length > 1 ? `${account.code} ${shortAccountName(account)}: ` : "") +
            describeMix(row.node, cell!, row.node.code ? entries.get(entryKey(row.node.code, account.code)) : null)
        )
        .join("\n\n");
      const severe = flagged.some(({ cell }) => cell!.kinds.some(distortsFte));
      return { title, severe };
    },
    [showMix, entries]
  );

  const columns = useMemo<GridColDef<GridRow>[]>(() => {
    const number = (
      field: string,
      headerName: string,
      format: "number" | "ratio",
      extra: Partial<GridColDef<GridRow>> = {}
    ): GridColDef<GridRow> => ({
      field,
      headerName,
      type: "number",
      width: 96,
      align: "right",
      headerAlign: "right",
      sortable: false,
      valueFormatter: (value: number | null) => formatReportValue(value, format),
      cellClassName: () => "ss-num",
      ...extra,
    });
    const hoursColumn = (field: string, headerName: string, description: string, cellAccounts: readonly StaffingStatsAccount[]): GridColDef<GridRow> =>
      number(field, headerName, "number", {
        width: 116,
        description,
        cellClassName: (params) => {
          const mark = mixMark(params.row, cellAccounts);
          return mark ? `ss-num ss-mix ${mark.severe ? "ss-mix--error" : "ss-mix--warn"}` : "ss-num";
        },
        renderCell: (params) => {
          const text = formatReportValue(params.value as number | null, "number");
          const mark = mixMark(params.row, cellAccounts);
          if (!mark) return text;
          return (
            <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{mark.title}</span>}>
              <Box component="span" sx={{ width: "100%", textAlign: "right" }}>
                {text}
              </Box>
            </Tooltip>
          );
        },
      });

    const out: GridColDef<GridRow>[] = [
      number("heads", "Heads", "number", {
        width: 88,
        description:
          slot === YEAR_SLOT
            ? "Position count (A972540) at the year end — every grade but Buyout Labour."
            : "Position count (A972540) in the month — every grade but Buyout Labour.",
      }),
      number("fte_mgr", "Managers", "ratio", {
        description: "Manager heads (A988101 / A988113): a manager counts as one FTE by head, whatever they work.",
      }),
      number("fte_hours", "From hours", "ratio", { description: "Hours that drive FTE ÷ one full-timer's hours." }),
      number("fte", "Total", "ratio", { description: "Managers + from hours — the FTE every report shows." }),
      number("hours", "Total", "number", { width: 104, description: "Every hours account, overtime, manager and buyout hours included." }),
    ];
    if (hoursMode === "account") {
      for (const account of accounts) {
        out.push(
          hoursColumn(accField(account.code), shortAccountName(account), `${account.name ?? account.code} — ${HOURS_KIND_LABELS[account.kind]}`, [account])
        );
      }
    } else {
      for (const kind of kindsPresent) {
        const ofKind = accounts.filter((a) => a.kind === kind);
        out.push(hoursColumn(kindField(kind), HOURS_KIND_LABELS[kind], ofKind.map((a) => a.name ?? a.code).join(", "), ofKind));
      }
    }
    return out;
  }, [accounts, kindsPresent, hoursMode, slot, mixMark]);

  const columnGroupingModel = useMemo<GridColumnGroupingModel>(
    () => [
      { groupId: "g_heads", headerName: "Heads", headerAlign: "center", children: [{ field: "heads" }] },
      { groupId: "g_fte", headerName: "FTE", headerAlign: "center", children: [{ field: "fte_mgr" }, { field: "fte_hours" }, { field: "fte" }] },
      {
        groupId: "g_hours",
        headerName: "Hours",
        headerAlign: "center",
        children: [
          { field: "hours" },
          ...(hoursMode === "account"
            ? kindsPresent.map((kind) => ({
                groupId: `g_kind_${kind}`,
                headerName: HOURS_KIND_LABELS[kind],
                headerAlign: "center" as const,
                children: accounts.filter((a) => a.kind === kind).map((a) => ({ field: accField(a.code) })),
              }))
            : kindsPresent.map((kind) => ({ field: kindField(kind) }))),
        ],
      },
    ],
    [accounts, kindsPresent, hoursMode]
  );

  const handleExport = useCallback(() => {
    setExporting(true);
    void (async () => {
      try {
        const result = await exportStaffingStatistics(ou, scenario.id, { slot, hotelName });
        if (result.outcome === "saved") onNotice(`Saved ${result.path} (${result.sheets} sheets)`);
      } catch (err) {
        onError(err, "Export failed");
      } finally {
        setExporting(false);
      }
    })();
  }, [ou, scenario.id, slot, hotelName, onError, onNotice]);

  const warnings = useMemo(() => {
    const codes = new Map<string, string>();
    for (const w of data?.warnings ?? []) if (!codes.has(w.code)) codes.set(w.code, w.message);
    return [...codes.entries()];
  }, [data]);

  const mixSummary = useMemo(() => {
    const list = data?.gradeMix ?? [];
    if (list.length === 0) return null;
    const departments = new Set(list.map((entry) => entry.dept)).size;
    const severe = list.some((entry) => entry.kinds.some(distortsFte));
    return { departments, severe, count: list.length };
  }, [data]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel id="ss-period">Period</InputLabel>
          <Select labelId="ss-period" label="Period" value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
            <MenuItem value={YEAR_SLOT}>Year</MenuItem>
            {MONTH_LABELS.map((label, m) => (
              <MenuItem key={label} value={m}>
                {label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Tooltip title="Open every row to this level — the chevrons still open one row at a time">
          <ToggleButtonGroup exclusive size="small" value={depth} onChange={(_event, next: Depth | null) => next !== null && setDepth(next)}>
            <ToggleButton value={0}>Groups</ToggleButton>
            <ToggleButton value={1}>Departments</ToggleButton>
            <ToggleButton value={2}>Positions</ToggleButton>
          </ToggleButtonGroup>
        </Tooltip>
        <Tooltip title="One column per hours account, or one per kind of hours">
          <ToggleButtonGroup exclusive size="small" value={hoursMode} onChange={(_event, next: HoursMode | null) => next && setHoursMode(next)}>
            <ToggleButton value="account">By account</ToggleButton>
            <ToggleButton value="type">By type</ToggleButton>
          </ToggleButtonGroup>
        </Tooltip>
        <Tooltip title="Every group, department and position, plus a sheet of the flagged accounts — for the period shown">
          <span>
            <Button
              variant="outlined"
              size="small"
              startIcon={exporting ? <CircularProgress size={14} color="inherit" /> : <FileDownloadOutlinedIcon />}
              onClick={handleExport}
              disabled={!data || exporting}
              sx={{ height: 36 }}
            >
              Export
            </Button>
          </span>
        </Tooltip>
        <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center", flexWrap: "wrap", rowGap: 0.5 }}>
          {mixSummary && (
            <Tooltip
              title={
                <span style={{ whiteSpace: "pre-line" }}>
                  {`Marked cells are hours accounts that more than one grade books to (amber) — they can't be reported by grade — or that put hours on the wrong side of FTE (red): manager hours counted twice, or staff hours left out.\n\nHover a mark for who put how many hours there. The Excel export lists them on a "Grade mixing" sheet.\n\nClick to ${showMix ? "hide" : "show"} the marks.`}
                </span>
              }
            >
              <Chip
                size="small"
                color={mixSummary.severe ? "error" : "warning"}
                variant={showMix ? "filled" : "outlined"}
                onClick={() => setShowMix((previous) => !previous)}
                label={`Grades share hours accounts · ${mixSummary.departments} dept${mixSummary.departments === 1 ? "" : "s"}`}
                sx={{ height: 28, fontWeight: 600 }}
              />
            </Tooltip>
          )}
          {data?.weeklyHours && (
            <Tooltip
              title={
                `FTE = manager heads + FTE-driving hours ÷ one full-timer's hours. Read from ${WEEKLY_HOURS_ORIGIN_LABELS[data.weeklyHours.origin]}. One FTE = ${Math.round(data.fteHours[YEAR_SLOT])} hours a year (the effective week × 52).` +
                (data.weeklyHours.derivation ? ` ${describeEffectiveWeek(data.weeklyHours.derivation)}` : "")
              }
            >
              <Chip
                size="small"
                variant="outlined"
                color={data.weeklyHours.origin === "derived" || data.weeklyHours.origin === "setup" ? "warning" : "default"}
                label={`${data.weeklyHours.value.toFixed(2)}h effective week`}
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
            data && <Chip size="small" variant="outlined" color="warning" label="Never calculated — Recalculate on Results" sx={{ height: 28, fontWeight: 600 }} />
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

      {data && data.unmappedDepartments.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {data.unmappedDepartments.length === 1
            ? `Department ${data.unmappedDepartments[0]} has no group in the mapping tables and is listed under "Unmapped departments".`
            : `Departments ${data.unmappedDepartments.join(", ")} have no group in the mapping tables and are listed under "Unmapped departments".`}
        </Alert>
      )}

      <Box sx={{ flex: 1, minHeight: 0 }}>
        <DataGridPremium
          apiRef={apiRef}
          rows={rows}
          columns={columns}
          columnGroupingModel={columnGroupingModel}
          loading={loading}
          treeData
          getTreeDataPath={(row) => row.path}
          groupingColDef={{
            headerName: "Department group · department · position",
            width: 360,
            sortable: false,
            renderCell: (params) => <LabelCell {...(params as GridRenderCellParams<GridRow>)} />,
          }}
          defaultGroupingExpansionDepth={depth}
          pinnedRows={pinnedRows}
          getRowClassName={(params) => `ss-row--${(params.row as GridRow).node.kind}`}
          disableRowSelectionOnClick
          disableColumnMenu
          disableColumnSorting
          rowHeight={32}
          columnHeaderHeight={36}
          sx={(theme) => ({
            borderRadius: 2,
            "& .ss-num": { fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.8125rem" },
            "& .ss-row--hotel": { fontWeight: 700, backgroundColor: theme.palette.action.selected },
            "& .ss-row--group": { fontWeight: 600, backgroundColor: theme.palette.action.hover },
            "& .ss-row--position .ss-num, & .ss-row--other .ss-num": { color: theme.palette.text.secondary },
            "& .ss-mix": { position: "relative" },
            "& .ss-mix::after": {
              content: '""',
              position: "absolute",
              top: 0,
              right: 0,
              width: 0,
              height: 0,
              borderLeft: "8px solid transparent",
              borderTop: `8px solid ${theme.palette.warning.main}`,
            },
            "& .ss-mix--error::after": { borderTopColor: theme.palette.error.main },
            "& .MuiDataGrid-columnHeader--filledGroup .MuiDataGrid-columnHeaderTitleContainer": { fontWeight: 700 },
          })}
        />
      </Box>
    </Box>
  );
}
