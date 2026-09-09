/**
 * Reports — the built-in definitions evaluated for the selected hotel under
 * a column configuration, with a drill-down and an Excel export.
 *
 * Source policy (decided 2026-09-09): the BST pull is the record and the
 * default. "Include unpushed plan data" is an opt-in behind a dialog, marked
 * on the page and on every export, and the drift banner nudges toward a push
 * in both modes. See shared/reports/columnConfig.ts for what the columns read.
 *
 * Layout (decided 2026-09-09): a settings bar across the top — what is
 * shown on the first row, how it is shown and the status chips on the
 * second — above a collapsible rail of reports and the report itself. The
 * position-based reports keep their own controls inside the report.
 *
 * Modelled on the Results page: the scenario resolves and heals the same
 * way, the stale chip is the same test, a locked secure store asks for
 * re-auth the same way.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  Snackbar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import ReceiptLongOutlinedIcon from "@mui/icons-material/ReceiptLongOutlined";
import PaymentsOutlinedIcon from "@mui/icons-material/PaymentsOutlined";
import HotelOutlinedIcon from "@mui/icons-material/HotelOutlined";
import BarChartOutlinedIcon from "@mui/icons-material/BarChartOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import SummarizeOutlinedIcon from "@mui/icons-material/SummarizeOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import PersonSearchOutlinedIcon from "@mui/icons-material/PersonSearchOutlined";
import ApartmentOutlinedIcon from "@mui/icons-material/ApartmentOutlined";
import SendOutlinedIcon from "@mui/icons-material/SendOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import BalanceOutlinedIcon from "@mui/icons-material/BalanceOutlined";
import { SECURE_DB_LOCKED, ScenarioDto } from "../../shared/positions/ipc";
import { resolvePlanningScenario } from "../../shared/positions/scenarioResolve";
import type { ReportColumnSpec } from "../../shared/reports/columns";
import type {
  ReportDefinitionDetail,
  ReportDefinitionSummary,
  ReportsEvaluateColumnsResponse,
} from "../../shared/reports/ipc";
import { hasDrift } from "../../shared/reports/sources";
import { WEEKLY_HOURS_ORIGIN_LABELS } from "../../shared/reports/weeklyHours";
import { describeEffectiveWeek } from "../../shared/positions/effectiveWeek";
import { PackPage, SUMMARY_REPORTING_PAGE_ID } from "../../shared/reports/packs";
import type { BucketMeta } from "../../shared/budgetImport/ipc";
import { THOUSANDS_CAPTION } from "../../components/reports/format";
import {
  AtomCombosOptions,
  evaluatePackPage,
  evaluateReportColumns,
  exportPack,
  exportReport,
  getReportDefinition,
  listPackPages,
  listReportDefinitions,
} from "../../services/reportsService";
import { listScenarios } from "../../services/scenarioService";
import { getBudgetImportSummary } from "../../services/budgetImportService";
import { useBudgetYear, usePlanningScenarioId, useSelectedHotel } from "../../store/settings";
import authService from "../../services/auth";
import { usePlanScope } from "../../hooks/usePlanScope";
import PartialScopeAlert from "../../components/sync/PartialScopeAlert";
import ReportGrid, { VersusMode, comparisonColumns } from "../../components/reports/ReportGrid";
import ReportInspector from "../../components/reports/ReportInspector";
import DriftBanner from "../../components/reports/DriftBanner";
import UnpushedPlanDialog from "../../components/reports/UnpushedPlanDialog";
import PositionBridge from "../../components/reports/PositionBridge";
import StaffingOverview from "../../components/reports/StaffingOverview";
import FteReconciliation from "../../components/reports/FteReconciliation";
import ReportRail, { RailEntry, useRailOpen } from "../../components/reports/ReportRail";
import BetaNotice, { SUBMIT_TOOLTIP } from "../../components/reports/BetaNotice";
import ColumnConfigDialog from "../../components/reports/ColumnConfigDialog";
import {
  ColumnConfig,
  DEFAULT_COLUMN_CONFIG,
  ScenarioRef,
  SourceMode,
  buildConfigColumns,
  describeColumnConfig,
  normalizeColumnConfig,
} from "../../shared/reports/columnConfig";

const NO_OPTIONS: AtomCombosOptions = {};

/** The rail entries that are not built-in definitions. */
const SUMMARY_ID = "__summary_reporting";
const PACK_ID = "__budget_pack";
const BRIDGE_ID = "__payroll_bridge";
const STAFFING_ID = "__staffing_overview";
const FTE_RECON_ID = "__fte_reconciliation";

const DEFINITION_ICONS: Record<string, React.ReactNode> = {
  summary_pl: <ReceiptLongOutlinedIcon />,
  payroll_fte_summary: <PaymentsOutlinedIcon />,
  rooms_kpi: <HotelOutlinedIcon />,
  staffing_stats: <BarChartOutlinedIcon />,
};

const OWN_PATH_ENTRIES: RailEntry[] = [
  {
    id: PACK_ID,
    name: "Budget pack",
    description: "Summary by department group, hotel total, one page per department",
    icon: <MenuBookOutlinedIcon />,
  },
  {
    id: BRIDGE_ID,
    name: "Payroll bridge",
    description: "Each department's payroll, position by position",
    icon: <AccountTreeOutlinedIcon />,
  },
  {
    id: STAFFING_ID,
    name: "Staffing overview",
    description: "Head count and FTE per department group, by job title",
    icon: <GroupsOutlinedIcon />,
  },
  {
    id: FTE_RECON_ID,
    name: "FTE reconciliation",
    description: "The Positions grid's FTE beside the account-derived FTE, per department",
    icon: <BalanceOutlinedIcon />,
  },
];

/**
 * Designed, not built. They sit at the foot of the rail so the shape of what
 * is coming is visible without pretending it works — see ReportRail.
 */
const COMING_SOON_ENTRIES: RailEntry[] = [
  {
    id: "__position_details",
    name: "Position details",
    description: "One position in full: pay, hours and every block, month by month",
    icon: <PersonSearchOutlinedIcon />,
    comingSoon: true,
  },
  {
    id: "__department_details",
    name: "Department details",
    description: "One department in full: its positions, blocks and accounts",
    icon: <ApartmentOutlinedIcon />,
    comingSoon: true,
  },
];

/** The column configuration is remembered per hotel, per install. */
const columnsStorageKey = (ou: string) => `kairos.reports.columns.${ou}`;

function readStoredColumns(ou: string): ColumnConfig {
  try {
    const raw = window.localStorage.getItem(columnsStorageKey(ou));
    return raw ? normalizeColumnConfig(JSON.parse(raw)) : DEFAULT_COLUMN_CONFIG;
  } catch {
    return DEFAULT_COLUMN_CONFIG;
  }
}

function writeStoredColumns(ou: string, config: ColumnConfig): void {
  try {
    window.localStorage.setItem(columnsStorageKey(ou), JSON.stringify(config));
  } catch {
    // A private window or blocked storage: the choice lasts the session.
  }
}

const CONTROL_HEIGHT = 36;

const VERSUS_STORAGE_KEY = "kairos.reports.versus";

function readStoredVersus(): VersusMode {
  try {
    const raw = window.localStorage.getItem(VERSUS_STORAGE_KEY);
    return raw === "abs" || raw === "pct" || raw === "off" ? raw : "pct";
  } catch {
    return "pct";
  }
}

export default function Reports() {
  const navigate = useNavigate();
  const selectedHotelOu = useSelectedHotel();
  const budgetYear = useBudgetYear();
  const planningScenarioId = usePlanningScenarioId();

  // The hotel's name is server-owned; best effort, for the export's title.
  // Offline the OU stands in — a report still exports.
  const [hotelName, setHotelName] = useState<string>("");
  useEffect(() => {
    setHotelName(selectedHotelOu ?? "");
    if (!selectedHotelOu) return;
    let cancelled = false;
    authService
      .getHotels()
      .then((list) => {
        const match = list.find((h) => h.ou === selectedHotelOu);
        if (!cancelled && match?.hotel_name) setHotelName(match.hotel_name);
      })
      .catch((): void => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu]);

  const [definitions, setDefinitions] = useState<ReportDefinitionSummary[]>([]);
  const [definitionId, setDefinitionId] = useState<string>("");
  const [detail, setDetail] = useState<ReportDefinitionDetail | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDto[]>([]);
  const [scenarioId, setScenarioId] = useState<string>("");
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(DEFAULT_COLUMN_CONFIG);
  const [configOpen, setConfigOpen] = useState(false);
  const [buckets, setBuckets] = useState<BucketMeta[]>([]);
  const [mode, setMode] = useState<SourceMode>("bst");
  const [months, setMonths] = useState(false);
  const [thousands, setThousands] = useState(false);
  // The in-cell difference of the months view: which kind, and against which
  // comparison when there is more than one. The kind is a lasting preference.
  const [versus, setVersusState] = useState<VersusMode>(readStoredVersus);
  const [versusAgainst, setVersusAgainst] = useState<string | null>(null);
  const setVersus = useCallback((next: VersusMode) => {
    setVersusState(next);
    try {
      window.localStorage.setItem(VERSUS_STORAGE_KEY, next);
    } catch {
      // A private window or blocked storage: the choice lasts the session.
    }
  }, []);
  const [grid, setGrid] = useState<ReportsEvaluateColumnsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [askOverlay, setAskOverlay] = useState(false);
  const [packPages, setPackPages] = useState<PackPage[]>([]);
  const [packPageId, setPackPageId] = useState<string>("summary");
  const [includeDepartments, setIncludeDepartments] = useState(true);
  const [railOpen, setRailOpen] = useRailOpen();
  const isPack = definitionId === PACK_ID;
  const isBridge = definitionId === BRIDGE_ID;
  const isStaffing = definitionId === STAFFING_ID;
  const isFteRecon = definitionId === FTE_RECON_ID;
  // The own-path reports: position-based, no columns/inspector, their own controls.
  const isOwnPath = isBridge || isStaffing || isFteRecon;
  // "Summary reporting" is a pack page shown as a report of its own: it is
  // evaluated and exported through the pack, with its page id fixed.
  const isSummary = definitionId === SUMMARY_ID;
  const usesPack = isPack || isSummary;
  const pageId = isSummary ? SUMMARY_REPORTING_PAGE_ID : packPageId;

  const planScope = usePlanScope(selectedHotelOu, scenarioId || planningScenarioId);

  const surfaceError = useCallback((err: unknown, fallback: string) => {
    const message = err instanceof Error ? err.message : fallback;
    setError(
      message === SECURE_DB_LOCKED
        ? "The secure store is locked — sign out and back in to load reports."
        : message
    );
  }, []);

  // ── Definitions ──
  useEffect(() => {
    if (!selectedHotelOu) return;
    let cancelled = false;
    listReportDefinitions(selectedHotelOu)
      .then((list) => {
        if (cancelled) return;
        setDefinitions(list);
        setDefinitionId((current) => current || list[0]?.id || "");
      })
      .catch((err) => surfaceError(err, "Failed to list the reports"));
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, surfaceError]);

  useEffect(() => {
    if (!selectedHotelOu || !definitionId || usesPack || isOwnPath) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    getReportDefinition(selectedHotelOu, definitionId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, definitionId, usesPack, isOwnPath]);

  // ── Scenarios: all years, the planning one selected by default ──
  useEffect(() => {
    if (!selectedHotelOu) {
      setScenarios([]);
      setScenarioId("");
      return;
    }
    let cancelled = false;
    listScenarios(selectedHotelOu, budgetYear)
      .then((list) => {
        if (cancelled) return;
        setScenarios(list);
        setScenarioId((current) =>
          current && list.some((s) => s.id === current)
            ? current
            : resolvePlanningScenario(list, budgetYear, planningScenarioId)?.id ?? ""
        );
      })
      .catch((err) => surfaceError(err, "Failed to list the scenarios"));
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, budgetYear, planningScenarioId, surfaceError]);

  // ── The column configuration, per hotel, and the pull's buckets for its labels ──
  useEffect(() => {
    if (!selectedHotelOu) {
      setColumnConfig(DEFAULT_COLUMN_CONFIG);
      setBuckets([]);
      return;
    }
    setColumnConfig(readStoredColumns(selectedHotelOu));
    let cancelled = false;
    getBudgetImportSummary(selectedHotelOu)
      .then((summary) => {
        if (!cancelled) setBuckets(summary?.buckets ?? []);
      })
      .catch(() => {
        if (!cancelled) setBuckets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu]);

  const applyColumnConfig = useCallback(
    (next: ColumnConfig) => {
      setColumnConfig(next);
      setConfigOpen(false);
      if (selectedHotelOu) writeStoredColumns(selectedHotelOu, next);
    },
    [selectedHotelOu]
  );

  const scenario = scenarios.find((s) => s.id === scenarioId) ?? null;
  const scenarioRefs = useMemo<ScenarioRef[]>(
    () => scenarios.map((s) => ({ id: s.id, label: s.label, year: s.year })),
    [scenarios]
  );

  const columns = useMemo<ReportColumnSpec[] | null>(() => {
    if (!scenario) return null;
    return buildConfigColumns(columnConfig, {
      scenario: { id: scenario.id, label: scenario.label, year: scenario.year },
      mode,
      scenarios: scenarioRefs,
      buckets,
    });
  }, [scenario, scenarioRefs, buckets, columnConfig, mode]);

  const columnsSummary = useMemo(
    () => describeColumnConfig(columnConfig, scenarioRefs, buckets),
    [columnConfig, scenarioRefs, buckets]
  );

  // ── The pack's pages, for the columns' sources ──
  useEffect(() => {
    if (!selectedHotelOu || !isPack || !columns) {
      setPackPages([]);
      return;
    }
    let cancelled = false;
    listPackPages(selectedHotelOu, columns)
      .then((response) => {
        if (cancelled) return;
        setPackPages(response.pages);
        setPackPageId((current) => (response.pages.some((p) => p.id === current) ? current : "summary"));
      })
      .catch((err) => surfaceError(err, "Failed to list the budget pack"));
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, isPack, columns, surfaceError]);

  // ── Evaluate ──
  useEffect(() => {
    if (!selectedHotelOu || !definitionId || !columns || isOwnPath) {
      setGrid(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const evaluation = usesPack
      ? evaluatePackPage(selectedHotelOu, pageId, columns).then((response) => {
          if (!cancelled) setDetail(response.detail);
          return response;
        })
      : evaluateReportColumns(selectedHotelOu, definitionId, columns);
    evaluation
      .then((response) => {
        if (!cancelled) setGrid(response);
      })
      .catch((err) => {
        if (!cancelled) {
          surfaceError(err, "Failed to evaluate the report");
          setGrid(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, definitionId, columns, usesPack, isOwnPath, pageId, surfaceError]);

  useEffect(() => {
    setSelectedRow(null);
  }, [definitionId, columns, pageId]);

  // A pack page's atoms resolve against the page, laid out from every column.
  const inspectorOptions = useMemo<AtomCombosOptions>(
    () => (usesPack && columns ? { pack: { pageId, columns } } : NO_OPTIONS),
    [usesPack, columns, pageId]
  );

  const primary = grid?.columns[0] ?? null;
  const drift = primary?.drift ?? null;
  const comparisons = useMemo(() => (grid ? comparisonColumns(grid) : []), [grid]);

  const warnings = useMemo(() => {
    const codes = new Map<string, string>();
    for (const column of grid?.columns ?? []) {
      for (const w of column.warnings) {
        if (w.code === "PLAN_NOT_PUSHED") continue; // the banner says it
        if (!codes.has(w.code)) codes.set(w.code, w.message);
      }
    }
    return [...codes.entries()];
  }, [grid]);

  const handleMode = (next: SourceMode | null) => {
    if (!next || next === mode) return;
    if (next === "plan") setAskOverlay(true);
    else setMode("bst");
  };

  const handleExport = useCallback(() => {
    if (!selectedHotelOu || !definitionId || !columns) return;
    setExporting(true);
    void (async () => {
      try {
        const result = isPack
          ? await exportPack(selectedHotelOu, columns, { months, thousands, hotelName, includeDepartments })
          : isSummary
            ? await exportPack(selectedHotelOu, columns, {
                months,
                thousands,
                hotelName,
                includeDepartments: false,
                pageId: SUMMARY_REPORTING_PAGE_ID,
              })
            : await exportReport(selectedHotelOu, definitionId, columns, { months, thousands, hotelName });
        if (result.outcome === "saved") setNotice(`Saved ${result.path} (${result.sheets} sheets)`);
      } catch (err) {
        surfaceError(err, "Export failed");
      } finally {
        setExporting(false);
      }
    })();
  }, [selectedHotelOu, definitionId, columns, months, thousands, hotelName, isPack, isSummary, includeDepartments, surfaceError]);

  const railEntries = useMemo<RailEntry[]>(
    () => [
      ...definitions.map(
        (d): RailEntry => ({
          id: d.id,
          name: d.name,
          description: d.description,
          icon: DEFINITION_ICONS[d.id] ?? <TableChartOutlinedIcon />,
        })
      ),
      {
        id: SUMMARY_ID,
        name: "Summary reporting",
        description: "Hotel stats and sales, then heads, hours and payroll per department group",
        icon: <SummarizeOutlinedIcon />,
      },
      ...OWN_PATH_ENTRIES,
      ...COMING_SOON_ENTRIES,
    ],
    [definitions]
  );

  // Not wired to anything yet — a signpost, not a control. It sits on the
  // settings bar rather than inside the beta banner because submitting is a
  // permanent action and the banner is temporary; when it goes live, only
  // `disabled` and `onClick` change. See components/reports/BetaNotice.tsx.
  const submitButton = (
    <Tooltip title={SUBMIT_TOOLTIP}>
      <span>
        <Button
          variant="contained"
          size="small"
          disabled
          startIcon={<SendOutlinedIcon />}
          sx={{ height: CONTROL_HEIGHT }}
        >
          Submit budget
        </Button>
      </span>
    </Tooltip>
  );

  const statusChips = !isOwnPath && (
    <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center", flexWrap: "wrap", rowGap: 0.5 }}>
      {primary?.run && (
        <Chip
          size="small"
          variant="outlined"
          color={primary.run.stale ? "warning" : "success"}
          label={
            primary.run.stale
              ? "Results out of date — inputs changed since the last calculation"
              : `Calculated ${new Date(primary.run.computedAt).toLocaleString()}`
          }
          sx={{ height: 28, fontWeight: 600 }}
        />
      )}
      {primary?.bst[0] && (
        <Chip
          size="small"
          variant="outlined"
          label={`BST ${primary.bst[0].bucketType ?? ""} ${primary.bst[0].year ?? ""}`.trim()}
          sx={{ height: 28, fontWeight: 600 }}
        />
      )}
      {primary?.weeklyHours && (
        <Tooltip
          title={
            `FTE lines divide hours by this week × 52. Read from ${WEEKLY_HOURS_ORIGIN_LABELS[primary.weeklyHours.origin]}.` +
            (primary.weeklyHours.derivation ? ` ${describeEffectiveWeek(primary.weeklyHours.derivation)}` : "")
          }
        >
          <Chip
            size="small"
            variant="outlined"
            color={primary.weeklyHours.origin === "derived" || primary.weeklyHours.origin === "setup" ? "warning" : "default"}
            label={`${primary.weeklyHours.value.toFixed(2)}h effective week`}
            sx={{ height: 28, fontWeight: 600 }}
          />
        </Tooltip>
      )}
    </Stack>
  );

  return (
    <Box sx={{ display: "flex", height: "calc(100vh - 64px)", minHeight: 0 }}>
      {/* The rail owns the page's left edge; everything else — alerts,
          settings, the report — lives in the pane beside it. */}
      <ReportRail
        entries={railEntries}
        selectedId={definitionId}
        onSelect={setDefinitionId}
        open={railOpen}
        onOpenChange={setRailOpen}
      />

      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", p: 1.5, pl: 0 }}>
      <BetaNotice />
      {!selectedHotelOu && (
        <Alert severity="info" sx={{ mb: 1 }}>
          Select a hotel from the switcher in the top bar to see its reports.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {planScope.scopeKind === "PARTIAL" && (
        <PartialScopeAlert
          surface="results"
          departments={planScope.ownership?.departments.map((row) => row.code) ?? null}
        />
      )}
      {mode === "plan" && (
        <Alert severity="error" variant="filled" sx={{ mb: 1 }} icon={false}>
          <strong>UNPUSHED PLAN DATA</strong> — this report lays Kairos results over the BST. Every export
          is marked the same way. Push to the BST to report on the record.
        </Alert>
      )}
      {drift && hasDrift(drift) && (
        <DriftBanner drift={drift} mode={mode} onGoToPush={() => navigate("/signed-in-landing/bst-push")} />
      )}

      {/* ── Settings bar ── */}
      <Box sx={{ borderBottom: 1, borderColor: "divider", pb: 1, mb: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 0.75 }}>
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel id="rep-scenario">Scenario</InputLabel>
            <Select
              labelId="rep-scenario"
              label="Scenario"
              value={scenarioId}
              onChange={(event) => setScenarioId(String(event.target.value))}
            >
              {scenarios.map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.label} {s.year}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {!isOwnPath && (
            <>
              <Tooltip title="Choose what the budget is compared against">
                <Button
                  variant="outlined"
                  size="small"
                  color="inherit"
                  startIcon={<TuneOutlinedIcon />}
                  onClick={() => setConfigOpen(true)}
                  sx={{ height: CONTROL_HEIGHT, textTransform: "none", fontWeight: 500, maxWidth: 360 }}
                >
                  <Typography variant="body2" noWrap component="span">
                    {columnsSummary}
                  </Typography>
                </Button>
              </Tooltip>

              {isPack && (
                <FormControl size="small" sx={{ minWidth: 240 }}>
                  <InputLabel id="rep-page">Page</InputLabel>
                  <Select
                    labelId="rep-page"
                    label="Page"
                    value={packPages.some((p) => p.id === packPageId) ? packPageId : ""}
                    onChange={(event) => setPackPageId(String(event.target.value))}
                  >
                    {packPages.map((p) => (
                      <MenuItem key={p.id} value={p.id} sx={{ pl: p.kind === "department" ? 4 : 2 }}>
                        {p.kind === "group" ? `${p.group} — summary` : p.title}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}

              <Tooltip title="The BST pull is the record. Including unpushed plan data is an opt-in, marked everywhere.">
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={mode}
                  onChange={(_event, next: SourceMode | null) => handleMode(next)}
                >
                  <ToggleButton value="bst">BST (pushed)</ToggleButton>
                  <ToggleButton value="plan" color="warning">
                    Include unpushed plan
                  </ToggleButton>
                </ToggleButtonGroup>
              </Tooltip>

              <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
                {isPack && (
                  <Tooltip title="One sheet per department after each group summary">
                    <ToggleButton
                      size="small"
                      value="departments"
                      selected={includeDepartments}
                      onChange={() => setIncludeDepartments((previous) => !previous)}
                      sx={{ height: CONTROL_HEIGHT, px: 1.25 }}
                    >
                      Department sheets
                    </ToggleButton>
                  </Tooltip>
                )}
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={exporting ? <CircularProgress size={14} color="inherit" /> : <FileDownloadOutlinedIcon />}
                  onClick={handleExport}
                  disabled={!grid || exporting}
                  sx={{ height: CONTROL_HEIGHT }}
                >
                  {isPack ? "Export pack" : "Export to Excel"}
                </Button>
                {submitButton}
              </Stack>
            </>
          )}

          {/* The position-based reports have no settings of their own on this
              bar, so Submit needs its own push to the right edge. */}
          {isOwnPath && <Box sx={{ ml: "auto" }}>{submitButton}</Box>}
        </Stack>

        {!isOwnPath && (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 0.5, mt: 0.75 }}>
            <Tooltip title="Twelve months and the total, or the total alone">
              <ToggleButtonGroup
                exclusive
                size="small"
                value={months ? "months" : "total"}
                onChange={(_event, next: string | null) => next && setMonths(next === "months")}
              >
                <ToggleButton value="total" sx={{ height: 28 }}>
                  Totals
                </ToggleButton>
                <ToggleButton value="months" sx={{ height: 28 }}>
                  Months
                </ToggleButton>
              </ToggleButtonGroup>
            </Tooltip>

            {months && (
              <Tooltip title="Under each figure of the primary column, its difference against the comparison: as an amount, as a percent, or not at all. Hover a cell for both figures and both differences.">
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={versus}
                  onChange={(_event, next: VersusMode | null) => next && setVersus(next)}
                >
                  <ToggleButton value="pct" sx={{ height: 28 }}>
                    ±%
                  </ToggleButton>
                  <ToggleButton value="abs" sx={{ height: 28 }}>
                    ±
                  </ToggleButton>
                  <ToggleButton value="off" sx={{ height: 28 }}>
                    No versus
                  </ToggleButton>
                </ToggleButtonGroup>
              </Tooltip>
            )}

            {months && versus !== "off" && comparisons.length > 1 && (
              <FormControl size="small" sx={{ minWidth: 180 }}>
                <InputLabel id="reports-versus-against">Versus</InputLabel>
                <Select
                  labelId="reports-versus-against"
                  label="Versus"
                  value={comparisons.some((c) => c.id === versusAgainst) ? versusAgainst : comparisons[0].id}
                  onChange={(event) => setVersusAgainst(String(event.target.value))}
                  sx={{ height: 28, fontSize: "0.8125rem" }}
                >
                  {comparisons.map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      {c.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <Tooltip title={THOUSANDS_CAPTION}>
              <ToggleButton
                size="small"
                value="thousands"
                selected={thousands}
                onChange={() => setThousands((previous) => !previous)}
                sx={{ height: 28, px: 1.25 }}
              >
                000s
              </ToggleButton>
            </Tooltip>

            {thousands && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {THOUSANDS_CAPTION}
              </Typography>
            )}

            {warnings.map(([code, message]) => (
              <Tooltip key={code} title={message}>
                <Chip size="small" color="warning" variant="outlined" label={code.toLowerCase().replace(/_/g, " ")} />
              </Tooltip>
            ))}

            {statusChips}
          </Stack>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {isOwnPath ? (
            selectedHotelOu && scenario ? (
              isBridge ? (
                <PositionBridge
                  ou={selectedHotelOu}
                  scenario={scenario}
                  scenarios={scenarios}
                  hotelName={hotelName}
                  onError={surfaceError}
                  onNotice={setNotice}
                />
              ) : isFteRecon ? (
                <FteReconciliation
                  ou={selectedHotelOu}
                  scenario={scenario}
                  hotelName={hotelName}
                  onError={surfaceError}
                  onNotice={setNotice}
                />
              ) : (
                <StaffingOverview
                  ou={selectedHotelOu}
                  scenario={scenario}
                  scenarios={scenarios}
                  hotelName={hotelName}
                  onError={surfaceError}
                  onNotice={setNotice}
                />
              )
            ) : (
              <Alert severity="info">Pick a scenario.</Alert>
            )
          ) : grid ? (
            <ReportGrid
              grid={grid}
              months={months}
              thousands={thousands}
              versus={months ? versus : "off"}
              versusAgainst={versusAgainst}
              loading={loading}
              selectedRow={selectedRow}
              onSelectRow={setSelectedRow}
            />
          ) : loading ? (
            <Stack sx={{ alignItems: "center", py: 6 }}>
              <CircularProgress />
            </Stack>
          ) : (
            <Alert severity="info">Pick a scenario and a report.</Alert>
          )}
        </Box>

        {!isOwnPath && grid && selectedRow !== null && selectedHotelOu && (
          <ReportInspector
            detail={detail}
            grid={grid}
            rowIndex={selectedRow}
            ou={selectedHotelOu}
            definitionId={definitionId}
            options={inspectorOptions}
            onClose={() => setSelectedRow(null)}
          />
        )}
      </Box>
      </Box>

      <ColumnConfigDialog
        open={configOpen}
        config={columnConfig}
        scenarioId={scenarioId}
        scenarios={scenarioRefs}
        buckets={buckets}
        onCancel={() => setConfigOpen(false)}
        onSave={applyColumnConfig}
      />
      <UnpushedPlanDialog
        open={askOverlay}
        onCancel={() => setAskOverlay(false)}
        onConfirm={() => {
          setAskOverlay(false);
          setMode("plan");
        }}
      />
      <Snackbar
        open={!!notice}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        message={notice}
      />
    </Box>
  );
}
