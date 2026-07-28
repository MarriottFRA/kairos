/**
 * BST Push — send the Results page's numbers into the hotel's Excel BST.
 * -----------------------------------------------------------
 * The mirror of BST Pull, and deliberately never automatic: the user may have a
 * different year or revision of the file open, so a push is always an explicit
 * act against a file they choose.
 *
 * The screen is one linear task in three states — choose, review, done — rather
 * than a dashboard, because that is the shape of the job. Everything on the
 * review state exists to answer one of four questions:
 *   "Is this the right file?"   → the identity card, matched against the app's
 *                                 own scope, with the guards as hard stops.
 *   "Which months change?"      → the month strip, where each column is chosen
 *                                 independently — protect the actualized head
 *                                 of the year, rework the tail.
 *   "What gets wiped?"          → the clear rules card, counted against THIS
 *                                 workbook, including what the rules miss.
 *   "What won't land?"          → the tiles, which are also the grid's filter.
 *
 * Month values are shown exactly as they will sit in the BST cell (currency
 * already divided by 1000), so nobody has to do that conversion in their head
 * to sanity-check a push.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Switch,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import UploadFileIcon from "@mui/icons-material/UploadFile";

import ClearRulesCard from "../../components/bstPush/ClearRulesCard";
import MonthPlanBar, {
  MONTH_ACTION_META,
  describeMonthPlan,
} from "../../components/bstPush/MonthPlanBar";
import PushPlanGrid from "../../components/bstPush/PushPlanGrid";
import {
  BstPushCommitResult,
  BstPushConfig,
  BstPushOptions,
  BstPushPlan,
  BstPushPreviewResult,
  BstPushRefusal,
  BstPushReport,
  DEFAULT_BST_PUSH_CONFIG,
  DEFAULT_BST_PUSH_OPTIONS,
  isEmptyMonthPlan,
} from "../../shared/bstPush/ipc";
import {
  commitBstPush,
  loadBstPushConfig,
  previewBstPush,
  revealBstFile,
  saveBstPushConfig,
} from "../../services/bstPushService";
import { loadOutputs } from "../../services/outputsService";
import { listScenarios } from "../../services/scenarioService";
import { MONTH_LONG } from "../../shared/calendar";
import { OutputsResponse, ScenarioDto } from "../../shared/positions/ipc";
import { resolvePlanningScenario } from "../../shared/positions/scenarioResolve";
import {
  useBudgetYear,
  usePlanningScenarioId,
  useSelectedHotel,
} from "../../store/settings";

type Stage = "idle" | "review" | "done";
type RowFilter = "all" | "problems";
type Toast = { severity: "success" | "error" | "info"; message: string } | null;

const count = (n: number) => n.toLocaleString();

// ── Small presentational pieces ─────────────────────────────────────

/** One number from the plan, big enough to read at a glance and clickable
 *  when it corresponds to a row filter — the summary IS the filter. */
function StatTile({
  value,
  label,
  tone = "default",
  active = false,
  onClick,
  hint,
}: {
  value: string;
  label: string;
  tone?: "default" | "good" | "bad";
  active?: boolean;
  onClick?: () => void;
  hint?: string;
}) {
  const tile = (
    <Paper
      variant="outlined"
      onClick={onClick}
      sx={(theme) => {
        const accent =
          tone === "bad"
            ? theme.palette.error.main
            : tone === "good"
              ? theme.palette.success.main
              : theme.palette.text.secondary;
        return {
          px: 2,
          py: 1.25,
          minWidth: 132,
          borderRadius: 2,
          cursor: onClick ? "pointer" : "default",
          borderColor: active ? accent : theme.palette.divider,
          backgroundColor: active ? alpha(accent, 0.08) : "transparent",
          transition: theme.transitions.create([
            "border-color",
            "background-color",
          ]),
          "&:hover": onClick
            ? { borderColor: accent, backgroundColor: alpha(accent, 0.06) }
            : undefined,
        };
      }}
    >
      <Typography
        variant="h5"
        sx={(theme) => ({
          fontWeight: 700,
          lineHeight: 1.1,
          fontFamily: "'IBM Plex Mono', monospace",
          color:
            tone === "bad"
              ? theme.palette.error.main
              : tone === "good"
                ? theme.palette.success.main
                : theme.palette.text.primary,
        })}
      >
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Paper>
  );
  return hint ? <Tooltip title={hint}>{tile}</Tooltip> : tile;
}

/** A `label · value` pair from the target file, with a tick when it matches
 *  what Kairos has selected. The tick is the "right file?" answer. */
function Fact({
  label,
  value,
  matched,
}: {
  label: string;
  value: string;
  matched?: boolean;
}) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", lineHeight: 1.4 }}
      >
        {label}
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {value}
        </Typography>
        {matched && (
          <CheckCircleIcon color="success" sx={{ fontSize: 15, flexShrink: 0 }} />
        )}
      </Stack>
    </Box>
  );
}

// ── Copy for every way a push can be refused ─────────────────────────

function refusalCopy(
  refusal: BstPushRefusal
): { title: string; body: string } | null {
  switch (refusal.outcome) {
    case "cancelled":
      return null;
    case "ou_mismatch":
      return {
        title: "That BST belongs to a different hotel",
        body:
          `"${refusal.sourceFileName}" declares ${refusal.fileOu}, but Kairos ` +
          `has ${refusal.selectedOu} selected. Switch hotel in the top bar, or ` +
          `pick that hotel's BST. Nothing was changed.`,
      };
    case "year_mismatch":
      return {
        title:
          refusal.fileYear == null
            ? "That BST does not state its budget year"
            : `That BST is a ${refusal.fileYear} budget`,
        body:
          refusal.fileYear == null
            ? `"${refusal.sourceFileName}" has no budget year in Setup Fields, so ` +
              `Kairos cannot confirm it matches your ${refusal.selectedYear} plan. ` +
              `Nothing was changed.`
            : `You are pushing the ${refusal.selectedYear} plan. Change the budget ` +
              `year in the top bar, or pick the ${refusal.selectedYear} BST. ` +
              `Nothing was changed.`,
      };
    case "file_locked":
      return {
        title: "That file is open in Excel",
        body:
          `Close "${refusal.sourceFileName}" and try again. Excel writes the ` +
          `whole workbook when it saves, so it would discard the push.`,
      };
    case "not_bst_file":
      return { title: "That is not a BST", body: refusal.reason };
    case "unsupported_layout":
      return {
        title: "Kairos will not write to that workbook",
        body: `${refusal.reason} Nothing was changed.`,
      };
    case "no_outputs":
      return {
        title: "There is nothing to push",
        body:
          "This scenario has no results. Add positions and recalculate on the " +
          "Results page first.",
      };
    case "no_months":
      return {
        title: "Every month is set to leave alone",
        body:
          "Nothing was changed. Choose at least one month to replace, add to " +
          "or clear before pushing.",
      };
    default:
      return { title: "The push could not start", body: "" };
  }
}

/** One sentence describing precisely what the button will do. */
function consequence(plan: BstPushPlan): string {
  const parts = [`${describeMonthPlan(plan.options.months)}.`];

  if (plan.cellCount > 0) {
    parts.push(
      `Writes ${count(plan.cellCount)} cell${plan.cellCount === 1 ? "" : "s"}` +
        ` across ${count(plan.writeCount)} row${plan.writeCount === 1 ? "" : "s"}` +
        ` on ${count(plan.departmentCount)} sheet${plan.departmentCount === 1 ? "" : "s"}.`
    );
  }
  if (plan.zeroCellCount > 0) {
    parts.push(
      `Zeroes ${count(plan.zeroCellCount)} cell${plan.zeroCellCount === 1 ? "" : "s"}` +
        ` matching the clear rules.`
    );
  }
  parts.push(
    plan.options.backup
      ? "A backup is saved beside the file first."
      : "No backup will be made."
  );
  return parts.join(" ");
}

/** Plain-text report for the clipboard. */
function reportText(report: BstPushReport): string {
  const lines: string[] = [
    `BST Push — ${report.file.sourceFileName}`,
    `Hotel: ${report.file.hotelName ?? "—"} (${report.file.ou})`,
    `Budget year: ${report.file.year ?? "—"}`,
    `Months: ${describeMonthPlan(report.options.months)}`,
    `Clear rules: ${report.clearScope.prefixes.join(", ") || "none"}`,
    `Rows written: ${report.writeCount}`,
    `Cells written: ${report.cellCount}`,
    `Cells cleared: ${report.zeroCellCount}`,
    `Sheets touched: ${report.sheetsTouched}`,
    `Rows not written: ${report.problemCount}`,
    `Backup: ${report.backupPath ?? "none"}`,
    "",
    "Per month:",
    ...report.monthPlan.map(
      (entry) =>
        `  ${MONTH_LONG[entry.month - 1].padEnd(10)} ` +
        `${MONTH_ACTION_META[entry.action].label.padEnd(13)} ` +
        `${entry.writeCells} written, ${entry.clearCells} cleared`
    ),
  ];
  const problems = report.rows.filter(
    (row) => row.status === "no_row" || row.status === "no_sheet"
  );
  if (problems.length > 0) {
    lines.push("", "Not written:");
    for (const row of problems) {
      lines.push(
        `  ${row.combo}  ${row.accountName || row.departmentName || ""} — ` +
          `${row.status === "no_sheet" ? "no department sheet" : "no account row"}`
      );
    }
  }
  if (report.warnings.length > 0) {
    lines.push("", "Worth knowing:");
    for (const warning of report.warnings) lines.push(`  • ${warning}`);
  }
  return lines.join("\n");
}

// ── The page ────────────────────────────────────────────────────────

export default function BstPush() {
  const ou = useSelectedHotel();
  const budgetYear = useBudgetYear();
  const planningScenarioId = usePlanningScenarioId();

  const [scenario, setScenario] = useState<ScenarioDto | null>(null);
  const [outputs, setOutputs] = useState<OutputsResponse | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [options, setOptions] = useState<BstPushOptions>(DEFAULT_BST_PUSH_OPTIONS);
  const [plan, setPlan] = useState<BstPushPlan | null>(null);
  const [report, setReport] = useState<BstPushReport | null>(null);
  const [refusal, setRefusal] = useState<BstPushRefusal | null>(null);

  const [busy, setBusy] = useState<null | "preview" | "refresh" | "commit">(null);
  const [filter, setFilter] = useState<RowFilter>("all");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [error, setError] = useState<string | null>(null);

  // The saved clear rules + last-used month plan. Main owns it; this is a
  // display copy, and `rulesRevision` is what makes a rule edit re-preview.
  const [pushConfig, setPushConfig] = useState<BstPushConfig>(
    DEFAULT_BST_PUSH_CONFIG
  );
  const [savingRules, setSavingRules] = useState(false);
  const [rulesRevision, setRulesRevision] = useState(0);

  // ── Resolve the planning scenario (same ladder as Results) ──
  useEffect(() => {
    if (!ou) {
      setScenario(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const scenarios = await listScenarios(ou, budgetYear);
        if (!cancelled) {
          setScenario(resolvePlanningScenario(scenarios, budgetYear, planningScenarioId));
        }
      } catch (err) {
        console.error("Failed to resolve scenario for BST push:", err);
        if (!cancelled) setScenario(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ou, budgetYear, planningScenarioId]);

  // ── What is available to push (the run stamp shown before choosing a file) ──
  useEffect(() => {
    if (!ou || !scenario) {
      setOutputs(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await loadOutputs(ou, scenario.id);
        if (!cancelled) setOutputs(response);
      } catch (err) {
        console.error("Failed to load outputs for BST push:", err);
        if (!cancelled) setOutputs(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ou, scenario]);

  // ── The saved rules and month plan ──
  // Restored rather than reset, because the same hotel repeats a very similar
  // selection every month and rebuilding it each visit would be the single most
  // annoying thing about this page.
  useEffect(() => {
    if (!ou) return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await loadBstPushConfig(ou);
        if (cancelled) return;
        setPushConfig(saved);
        setOptions({ months: saved.months, backup: saved.backup });
      } catch (err) {
        console.error("Failed to read the saved BST push config:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ou]);

  // Leaving the scope invalidates any in-flight review.
  useEffect(() => {
    setStage("idle");
    setPlan(null);
    setReport(null);
    setRefusal(null);
  }, [ou, budgetYear, planningScenarioId]);

  const scopeReady = Boolean(ou && scenario);

  const applyPreview = useCallback((result: BstPushPreviewResult) => {
    if (result.outcome === "ready") {
      setPlan(result.plan);
      setOptions(result.plan.options);
      setRefusal(null);
      setStage("review");
      return;
    }
    if (result.outcome !== "cancelled") setRefusal(result);
  }, []);

  const handleChooseFile = useCallback(async () => {
    if (!ou || !scenario) return;
    setBusy("preview");
    setError(null);
    setRefusal(null);
    try {
      applyPreview(
        await previewBstPush({ ou, year: budgetYear, scenarioId: scenario.id }, options)
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [ou, scenario, budgetYear, options, applyPreview]);

  /** Change an option and remember it for next time. */
  const updateOptions = useCallback(
    (next: BstPushOptions) => {
      setOptions(next);
      if (!ou) return;
      void saveBstPushConfig(ou, { months: next.months, backup: next.backup })
        .then(setPushConfig)
        .catch((err) =>
          console.error("Failed to save the BST push config:", err)
        );
    },
    [ou]
  );

  /**
   * Save a changed rule set. The plan's cell counts depend on it, so bumping
   * `rulesRevision` deliberately falls into the same debounced re-preview an
   * option change uses — the numbers on screen are never left describing rules
   * that are no longer in force.
   */
  const handleSaveRules = useCallback(
    async (prefixes: string[]) => {
      if (!ou) return;
      setSavingRules(true);
      try {
        setPushConfig(await saveBstPushConfig(ou, { clearPrefixes: prefixes }));
        setRulesRevision((revision) => revision + 1);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSavingRules(false);
      }
    },
    [ou]
  );

  // ── Re-preview when something that changes the plan changes ──
  // The numbers on this screen must be true, and only main can recompute them
  // against the real file. Held in a ref so the effect below can depend on the
  // month plan and the rule set alone — `backup` is deliberately absent,
  // because it changes nothing about what gets written.
  //
  // The month strip stays live while this runs — a recalculation against a
  // 90 MB workbook is not quick, and locking the tiles for its duration would
  // make setting nine months a nine-round-trip chore. That means several
  // previews can be in flight at once, so each carries a sequence number and
  // only the newest is allowed to land; a slow earlier one is dropped rather
  // than left to overwrite the plan the user is actually looking at.
  const planFilePath = plan?.file.filePath ?? null;
  const refreshSeq = useRef(0);
  const refreshRef = useRef<() => void>(() => undefined);
  refreshRef.current = () => {
    if (!planFilePath || !ou || !scenario) return;
    const seq = ++refreshSeq.current;
    setBusy("refresh");
    void (async () => {
      try {
        const result = await previewBstPush(
          { ou, year: budgetYear, scenarioId: scenario.id },
          options,
          planFilePath
        );
        if (seq !== refreshSeq.current) return;
        if (result.outcome === "ready") setPlan(result.plan);
        else applyPreview(result);
      } catch (err) {
        if (seq === refreshSeq.current) setError((err as Error).message);
      } finally {
        if (seq === refreshSeq.current) setBusy(null);
      }
    })();
  };

  // A newly chosen file already arrives with its options applied, so the first
  // run after one lands must not re-fetch.
  const settledOptions = useRef<string | null>(null);
  const optionKey = `${planFilePath}|${options.months.join(",")}|r${rulesRevision}`;
  useEffect(() => {
    if (!planFilePath) {
      settledOptions.current = null;
      return;
    }
    if (settledOptions.current === null) {
      settledOptions.current = optionKey;
      return;
    }
    if (settledOptions.current === optionKey) return;
    settledOptions.current = optionKey;
    const timer = setTimeout(() => refreshRef.current(), 350);
    return () => clearTimeout(timer);
  }, [optionKey, planFilePath]);

  const handleCommit = useCallback(async () => {
    if (!ou || !scenario || !plan) return;
    setConfirmOpen(false);
    setBusy("commit");
    setError(null);
    try {
      const result: BstPushCommitResult = await commitBstPush(
        { ou, year: budgetYear, scenarioId: scenario.id },
        plan.file.filePath,
        options
      );
      if (result.outcome === "ok") {
        setReport(result.report);
        setStage("done");
        setFilter("all");
      } else if (result.outcome !== "cancelled") {
        setRefusal(result);
        setStage("idle");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [ou, scenario, budgetYear, plan, options]);

  const startOver = useCallback(() => {
    setStage("idle");
    setPlan(null);
    setReport(null);
    setRefusal(null);
    setFilter("all");
  }, []);

  const shownRows = useMemo(() => {
    const rows = stage === "done" ? (report?.rows ?? []) : (plan?.rows ?? []);
    if (filter === "all") return rows;
    return rows.filter(
      (row) => row.status === "no_row" || row.status === "no_sheet"
    );
  }, [stage, report, plan, filter]);

  const refusalMessage = refusal ? refusalCopy(refusal) : null;
  const working = busy !== null;

  // ── Header, shared by every state ──
  const header = (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1, mb: 2 }}
    >
      <UploadFileIcon color="primary" />
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        BST Push
      </Typography>
      {stage !== "idle" && (
        <Button size="small" startIcon={<ArrowBackIcon />} onClick={startOver}>
          {stage === "done" ? "Push another" : "Choose a different file"}
        </Button>
      )}
      <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
        <Chip
          size="small"
          variant="outlined"
          label={ou ?? "No hotel"}
          sx={{ height: 28, fontWeight: 600 }}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`Budget ${budgetYear}`}
          sx={{ height: 28, fontWeight: 600 }}
        />
        <Chip
          size="small"
          variant="outlined"
          color="primary"
          label={scenario?.label ?? "No scenario"}
          sx={{ height: 28, fontWeight: 600 }}
        />
      </Stack>
    </Stack>
  );

  return (
    <Box
      sx={{
        p: 2,
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 64px)",
        minHeight: 0,
        // The review state stacks a lot above the grid — file card, tiles, the
        // month strip, the rules card. Scroll rather than crush the grid.
        overflowY: "auto",
      }}
    >
      {header}

      {!ou && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Select a hotel from the switcher in the top bar to push its budget.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {refusalMessage && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          onClose={() => setRefusal(null)}
          action={
            <Button color="inherit" size="small" onClick={handleChooseFile}>
              Choose another file
            </Button>
          }
        >
          <AlertTitle>{refusalMessage.title}</AlertTitle>
          {refusalMessage.body}
        </Alert>
      )}

      {stage === "idle" && (
        <IdleState
          scopeReady={scopeReady}
          busy={busy}
          outputs={outputs}
          budgetYear={budgetYear}
          onChoose={handleChooseFile}
        />
      )}

      {stage !== "idle" && (plan || report) && (
        <>
          <FileCard
            file={(stage === "done" ? report! : plan!).file}
            ou={ou}
            budgetYear={budgetYear}
            done={stage === "done"}
            report={stage === "done" ? report : null}
            onReveal={async (target) => {
              try {
                await revealBstFile(ou ?? "", target);
              } catch (err) {
                setToast({ severity: "error", message: (err as Error).message });
              }
            }}
          />

          <SummaryTiles
            source={stage === "done" ? report! : plan!}
            filter={filter}
            onFilter={setFilter}
          />

          {stage === "review" && plan && (
            <Stack spacing={1.5} sx={{ mb: 1.5 }}>
              {/* Only a commit locks these — a refresh must not, or every
                  edit would cost a full round-trip before the next one. */}
              <MonthPlanBar
                monthPlan={plan.monthPlan}
                actions={options.months}
                disabled={busy === "commit"}
                onChange={(months) => updateOptions({ ...options, months })}
              />
              <ClearRulesCard
                prefixes={pushConfig.clearPrefixes}
                clearScope={plan.clearScope}
                saving={savingRules}
                disabled={busy === "commit"}
                onSave={(prefixes) => void handleSaveRules(prefixes)}
              />
              <Box>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={options.backup}
                      disabled={working}
                      onChange={(event) =>
                        updateOptions({ ...options, backup: event.target.checked })
                      }
                    />
                  }
                  label={
                    <Typography variant="body2">
                      Back up the file before writing
                    </Typography>
                  }
                />
              </Box>
            </Stack>
          )}

          {stage === "done" && report && (
            <Box sx={{ mb: 1.5 }}>
              <MonthPlanBar monthPlan={report.monthPlan} readOnly />
            </Box>
          )}

          {(stage === "done" ? report! : plan!).warnings.length > 0 && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              <AlertTitle sx={{ mb: 0.5 }}>
                Worth knowing ({(stage === "done" ? report! : plan!).warnings.length})
              </AlertTitle>
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                {(stage === "done" ? report! : plan!).warnings.map((warning) => (
                  <li key={warning}>
                    <Typography variant="body2">{warning}</Typography>
                  </li>
                ))}
              </Box>
            </Alert>
          )}

          <Box sx={{ flex: 1, minHeight: 320, position: "relative" }}>
            {busy === "refresh" && (
              <LinearProgress
                sx={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 3 }}
              />
            )}
            <PushPlanGrid
              rows={shownRows}
              monthActions={(stage === "done" ? report! : plan!).options.months}
              loading={busy === "refresh" || busy === "commit"}
              emptyMessage={
                filter === "problems"
                  ? "Every row found its place in the BST."
                  : "No rows to push."
              }
            />
          </Box>

          {stage === "review" && plan && (
            <CommitBar
              plan={plan}
              busy={busy}
              onPush={() => setConfirmOpen(true)}
              onCancel={startOver}
            />
          )}

          {stage === "done" && report && (
            <DoneBar
              report={report}
              onCopy={async () => {
                await navigator.clipboard.writeText(reportText(report));
                setToast({ severity: "success", message: "Report copied." });
              }}
              onDone={startOver}
            />
          )}
        </>
      )}

      <ConfirmPushDialog
        open={confirmOpen}
        plan={plan}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleCommit}
      />

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)}>
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

// ── States ──────────────────────────────────────────────────────────

function IdleState({
  scopeReady,
  busy,
  outputs,
  budgetYear,
  onChoose,
}: {
  scopeReady: boolean;
  busy: Stage | null | string;
  outputs: OutputsResponse | null;
  budgetYear: number;
  onChoose: () => void;
}) {
  const rowCount = outputs?.rows.length ?? 0;
  const nothingToPush = Boolean(outputs) && rowCount === 0;

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Paper
        variant="outlined"
        sx={{ p: 4, maxWidth: 620, width: "100%", borderRadius: 3 }}
      >
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
              Push this plan into the BST
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Kairos recalculates the scenario, opens the BST you pick, and writes
              the Results rows into each department sheet&apos;s budget columns
              (Jan–Dec). Currency lands in thousands and statistics in units, just
              as the BST stores them.
            </Typography>
          </Box>

          <Divider />

          {/* What is on its way — answers "is this current?" before any file is picked. */}
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
          >
            <Typography variant="body2" color="text.secondary">
              Ready to send:
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={`${count(rowCount)} result row${rowCount === 1 ? "" : "s"}`}
              sx={{ fontWeight: 600 }}
            />
            {outputs?.run && (
              <Chip
                size="small"
                variant="outlined"
                color={outputs.stale ? "warning" : "success"}
                label={
                  outputs.stale
                    ? "Inputs changed since the last calculation"
                    : `Calculated ${new Date(outputs.run.computedAt).toLocaleString()}`
                }
              />
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
            {outputs?.stale
              ? "No need to recalculate first — the push always recalculates before it writes."
              : "The push recalculates before it writes, so what lands is always current."}
          </Typography>

          {nothingToPush && (
            <Alert severity="info">
              This scenario has no results for {budgetYear}. Add positions and
              recalculate on the Results page first.
            </Alert>
          )}

          <Button
            variant="contained"
            size="large"
            disableElevation
            startIcon={
              busy === "preview" ? (
                <CircularProgress size={18} color="inherit" />
              ) : (
                <UploadFileIcon />
              )
            }
            onClick={onChoose}
            disabled={!scopeReady || Boolean(busy) || nothingToPush}
          >
            {busy === "preview" ? "Reading the BST…" : "Choose BST file…"}
          </Button>

          <Typography variant="caption" color="text.secondary">
            Nothing is written until you review the plan and confirm. You choose
            which months are touched, and which accounts are cleared, on the next
            screen — counted against the file you pick. Kairos refuses any file
            whose own hotel or budget year disagrees with your selection.
          </Typography>
        </Stack>
      </Paper>
    </Box>
  );
}

function FileCard({
  file,
  ou,
  budgetYear,
  done,
  report,
  onReveal,
}: {
  file: BstPushPlan["file"];
  ou: string | null;
  budgetYear: number;
  done: boolean;
  report: BstPushReport | null;
  onReveal: (path: string) => void;
}) {
  return (
    <Paper
      variant="outlined"
      sx={(theme) => ({
        p: 2,
        mb: 1.5,
        borderRadius: 2,
        borderColor: done ? theme.palette.success.main : theme.palette.divider,
        backgroundColor: done
          ? alpha(theme.palette.success.main, 0.06)
          : "transparent",
      })}
    >
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1.5 }}
      >
        {done ? (
          <CheckCircleIcon color="success" />
        ) : (
          <DescriptionOutlinedIcon color="action" />
        )}
        <Box sx={{ minWidth: 220, flex: "1 1 260px" }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
            {file.sourceFileName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {done ? "Pushed · " : ""}
            {file.filePath}
          </Typography>
        </Box>

        <Fact
          label="Hotel"
          value={file.hotelName ?? "—"}
          matched={Boolean(ou) && file.ou === ou}
        />
        <Fact label="OU" value={file.ou} matched={Boolean(ou) && file.ou === ou} />
        <Fact
          label="Budget year"
          value={file.year ? String(file.year) : "—"}
          matched={file.year === budgetYear}
        />
        <Fact label="Currency" value={file.currency ?? "—"} />
        <Fact
          label="Dept sheets"
          value={count(file.departmentSheetCount)}
        />

        {done && report?.backupPath && (
          <Button
            size="small"
            startIcon={<FolderOpenIcon />}
            onClick={() => onReveal(report.backupPath as string)}
            sx={{ ml: "auto" }}
          >
            Show backup
          </Button>
        )}
        {done && (
          <Button
            size="small"
            startIcon={<FolderOpenIcon />}
            onClick={() => onReveal(file.filePath)}
            sx={{ ml: report?.backupPath ? 0 : "auto" }}
          >
            Show BST
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

function SummaryTiles({
  source,
  filter,
  onFilter,
}: {
  source: BstPushPlan | BstPushReport;
  filter: RowFilter;
  onFilter: (next: RowFilter) => void;
}) {
  const written = "departmentCount" in source ? source.departmentCount : null;
  const past = !("departmentCount" in source);

  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{ mb: 1.5, flexWrap: "wrap", rowGap: 1.5 }}
    >
      {written !== null && (
        <StatTile value={count(written)} label="Department sheets" />
      )}
      <StatTile
        value={count(source.writeCount)}
        label={past ? "Rows written" : "Rows to write"}
        tone="good"
        active={filter === "all"}
        onClick={() => onFilter("all")}
        hint="Show every row"
      />
      <StatTile
        value={count(source.cellCount)}
        label={past ? "Cells written" : "Cells to write"}
      />
      {source.zeroCellCount > 0 && (
        <StatTile
          value={count(source.zeroCellCount)}
          label={past ? "Cells cleared" : "Cells to clear"}
          hint={`Rows matching the clear rules (${source.clearScope.prefixes.join(", ") || "none"}), zeroed in every cleared month`}
        />
      )}
      <StatTile
        value={count(source.problemCount)}
        label={past ? "Rows not written" : "Rows that can't land"}
        tone={source.problemCount > 0 ? "bad" : "default"}
        active={filter === "problems"}
        onClick={() => onFilter(source.problemCount > 0 ? "problems" : "all")}
        hint={
          source.problemCount > 0
            ? "Show only the rows the BST has no home for"
            : "Every row found its place"
        }
      />
    </Stack>
  );
}

function CommitBar({
  plan,
  busy,
  onPush,
  onCancel,
}: {
  plan: BstPushPlan;
  busy: string | null;
  onPush: () => void;
  onCancel: () => void;
}) {
  return (
    <Paper
      elevation={0}
      sx={(theme) => ({
        mt: 1.5,
        px: 2,
        py: 1.5,
        borderRadius: 2,
        border: `1px solid ${theme.palette.divider}`,
        backgroundColor: alpha(theme.palette.primary.main, 0.04),
      })}
    >
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
      >
        <Typography variant="body2" sx={{ flex: "1 1 320px" }}>
          {consequence(plan)}
        </Typography>
        <Button onClick={onCancel} disabled={Boolean(busy)}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          size="large"
          startIcon={
            busy === "commit" ? (
              <CircularProgress size={18} color="inherit" />
            ) : (
              <UploadFileIcon />
            )
          }
          onClick={onPush}
          disabled={
            Boolean(busy) ||
            isEmptyMonthPlan(plan.options.months) ||
            // A clear-only push writes no rows but still changes the file, so
            // the row count alone is not the test for "does anything happen".
            (plan.cellCount === 0 && plan.zeroCellCount === 0)
          }
        >
          {busy === "commit" ? "Writing…" : "Push to BST"}
        </Button>
      </Stack>
    </Paper>
  );
}

function DoneBar({
  report,
  onCopy,
  onDone,
}: {
  report: BstPushReport;
  onCopy: () => void;
  onDone: () => void;
}) {
  return (
    <Paper
      elevation={0}
      sx={(theme) => ({
        mt: 1.5,
        px: 2,
        py: 1.5,
        borderRadius: 2,
        border: `1px solid ${theme.palette.success.main}`,
        backgroundColor: alpha(theme.palette.success.main, 0.06),
      })}
    >
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
      >
        <Typography variant="body2" sx={{ flex: "1 1 320px" }}>
          Wrote {count(report.cellCount)} cell
          {report.cellCount === 1 ? "" : "s"} across{" "}
          {count(report.writeCount)} row{report.writeCount === 1 ? "" : "s"}
          {report.zeroCellCount > 0
            ? ` and cleared ${count(report.zeroCellCount)}`
            : ""}
          , on {count(report.sheetsTouched)} department sheet
          {report.sheetsTouched === 1 ? "" : "s"}.
          {report.backupPath
            ? " The original was backed up beside the file."
            : " No backup was made."}{" "}
          Open the BST in Excel — it recalculates itself on open.
        </Typography>
        <Button startIcon={<ContentCopyIcon />} onClick={onCopy}>
          Copy report
        </Button>
        <Button variant="contained" disableElevation onClick={onDone}>
          Done
        </Button>
      </Stack>
    </Paper>
  );
}

function ConfirmPushDialog({
  open,
  plan,
  onClose,
  onConfirm,
}: {
  open: boolean;
  plan: BstPushPlan | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!plan) return null;
  const untouched: string[] = plan.options.months
    .map((action, index) => (action === "skip" ? String(MONTH_LONG[index]) : null))
    .filter((name): name is string => name !== null);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Push into {plan.file.sourceFileName}?</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2 }}>
          The budget columns you chose are replaced with values. Any driver
          formula the BST had in those cells is gone afterwards — that is what a
          push is for, but there is no undo inside Excel.
        </Alert>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {consequence(plan)}
        </Typography>

        {/* The highest-stakes fact on the screen: what is NOT being touched. */}
        <Alert severity={untouched.length > 0 ? "success" : "info"} sx={{ mb: 1.5 }}>
          {untouched.length > 0
            ? `${untouched.join(", ")} ${untouched.length === 1 ? "is" : "are"} left exactly as ${untouched.length === 1 ? "it is" : "they are"}.`
            : "Every month is being written or cleared — nothing is left as it is."}
        </Alert>

        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
          <Chip
            size="small"
            label={`${count(plan.writeCount)} rows`}
            variant="outlined"
          />
          <Chip
            size="small"
            label={`${count(plan.cellCount)} cells`}
            variant="outlined"
          />
          {plan.zeroCellCount > 0 && (
            <Chip
              size="small"
              color="warning"
              label={`${count(plan.zeroCellCount)} cells cleared`}
              variant="outlined"
            />
          )}
          <Chip
            size="small"
            label={`${count(plan.departmentCount)} sheets`}
            variant="outlined"
          />
          {plan.problemCount > 0 && (
            <Chip
              size="small"
              color="error"
              label={`${count(plan.problemCount)} rows can't land`}
            />
          )}
        </Stack>
        {plan.problemCount > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: "block" }}>
            The rows that can&apos;t land are listed in the report afterwards, so
            you can add them in the BST and push again.
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disableElevation onClick={onConfirm}>
          Push to BST
        </Button>
      </DialogActions>
    </Dialog>
  );
}
