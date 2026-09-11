/**
 * Submit data — where a hotel submits its budget's staffing data to head
 * office. Opened from the top of the Reports rail, but it is not a report:
 * it has none of the settings bar and evaluates nothing.
 *
 * Pick a plan and the submission it goes into (BUD today; forecasts arrive
 * later as their own tags), laid out source → destination with an arrow
 * between. The year is NOT picked here: it is the app's budget year from the
 * app bar, and a year that is not open yet says so instead of building.
 * Main builds the submission — recalculating the plan first when its results
 * are missing or out of date — and the page shows what would go before
 * anything is sent. Sending REPLACES the hotel's
 * earlier submission for the same slot and year: one submission per hotel
 * per tag, by design (2026-09-11). No publish gate and no owner gate: a
 * delegate with the departments can submit, and so can a hotel that only
 * ever works locally.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import SendOutlinedIcon from "@mui/icons-material/SendOutlined";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import type { ScenarioDto } from "../../shared/positions/ipc";
import { SECURE_DB_LOCKED } from "../../shared/positions/ipc";
import { resolvePlanningScenario } from "../../shared/positions/scenarioResolve";
import type { SubmissionPreviewResponse, SubmissionReceipt, SubmissionStatusEntry } from "../../shared/submission/ipc";
import {
  ENABLED_SUBMISSION_SLOTS,
  ENABLED_SUBMISSION_YEARS,
  SUBMISSION_SLOTS,
  submissionHeaderOf,
  submissionTag,
} from "../../shared/submission/schema";
import { listScenarios } from "../../services/scenarioService";
import { usePlanningScenarioId } from "../../store/settings";
import { fetchSubmissionStatus, previewSubmission, sendSubmission } from "../../services/submissionService";

export interface SubmitDataProps {
  ou: string;
  hotelName: string;
  /** The app-wide budget year — the year picker's starting point when it is open. */
  budgetYear: number;
}

const SLOT_LABELS: Record<string, string> = { BUD: "Budget", FCST: "Forecast", ACT: "Actual" };

const enabledSlots = new Set<string>(ENABLED_SUBMISSION_SLOTS);
const enabledYears = new Set<number>(ENABLED_SUBMISSION_YEARS);

function describeError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : fallback;
  return message === SECURE_DB_LOCKED
    ? "The secure store is locked — sign out and back in to build the submission."
    : message;
}

const when = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

const fmt = (value: unknown, decimals = 2): string => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : "—";
};

export default function SubmitData({ ou, hotelName, budgetYear }: SubmitDataProps) {
  const [slot, setSlot] = useState<string>(ENABLED_SUBMISSION_SLOTS[0]);
  // The year is the app's budget year (the chip in the app bar), never a
  // second choice here: one year for the whole app, so a plan and its
  // submission can't disagree about it.
  const year = budgetYear;
  const yearOpen = enabledYears.has(year);
  const planningScenarioId = usePlanningScenarioId();
  const [scenarios, setScenarios] = useState<ScenarioDto[]>([]);
  const [scenarioId, setScenarioId] = useState<string>("");

  const [preview, setPreview] = useState<SubmissionPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);

  const [status, setStatus] = useState<SubmissionStatusEntry[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);

  // ── Plans for the chosen year ──
  useEffect(() => {
    if (!ou) {
      setScenarios([]);
      setScenarioId("");
      return;
    }
    let cancelled = false;
    listScenarios(ou, year)
      .then((all) => {
        if (cancelled) return;
        // The list comes back with EVERY year's plans (the year only makes
        // sure that year's default "Planning" exists), so filter it here the
        // way the app bar's ScenarioPicker does. Otherwise a hotel sees
        // "Planning" once per year it has ever planned, with no way to tell
        // them apart, and could send last year's plan as this year's.
        const list = all.filter((s) => s.year === year);
        setScenarios(list);
        setScenarioId((current) =>
          current && list.some((s) => s.id === current)
            ? current
            : resolvePlanningScenario(list, year, planningScenarioId)?.id ?? ""
        );
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(describeError(err, "Failed to list the plans"));
      });
    return () => {
      cancelled = true;
    };
  }, [ou, year, planningScenarioId]);

  // ── What the server holds ──
  const loadStatus = useCallback(() => {
    if (!ou) return;
    setStatusError(null);
    fetchSubmissionStatus(ou)
      .then((response) => setStatus(response.submissions))
      .catch((err) => {
        setStatus(null);
        setStatusError(describeError(err, "The submission status could not be read"));
      });
  }, [ou]);
  useEffect(loadStatus, [loadStatus]);

  // ── The preview: built afresh whenever the choice changes ──
  const loadPreview = useCallback(() => {
    if (!ou || !scenarioId || !yearOpen) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    setPreviewError(null);
    previewSubmission({ ou, scenarioId, slot, year, hotelName })
      .then((response) => {
        if (!cancelled) setPreview(response);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(describeError(err, "Failed to build the submission"));
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ou, scenarioId, slot, year, yearOpen, hotelName]);
  useEffect(loadPreview, [loadPreview]);

  // Anything that changes the choice retires the last receipt.
  useEffect(() => {
    setReceipt(null);
    setSendError(null);
  }, [ou, scenarioId, slot, year]);

  const scenario = scenarios.find((s) => s.id === scenarioId) ?? null;
  const tag = submissionTag(slot, year);
  const current = useMemo(
    () => status?.find((entry) => entry.slot === slot && entry.year === year) ?? null,
    [status, slot, year]
  );
  const header = preview ? submissionHeaderOf(preview.payload) : null;

  const submit = async () => {
    setConfirmOpen(false);
    if (!ou || !scenarioId) return;
    setSending(true);
    setSendError(null);
    try {
      const response = await sendSubmission({ ou, scenarioId, slot, year, hotelName });
      setReceipt(response.receipt);
      loadStatus();
    } catch (err) {
      setSendError(describeError(err, "Failed to submit"));
    } finally {
      setSending(false);
    }
  };

  const canSubmit = Boolean(ou && scenarioId && yearOpen && preview && !previewing && !sending);

  return (
    <Box sx={{ maxWidth: 760, pt: 1 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 2 }}>
        <SendOutlinedIcon color="primary" />
        <Box>
          <Typography variant="h6" component="h1">
            Submit data
          </Typography>
          {hotelName && (
            <Typography variant="body2" color="text.secondary">
              {hotelName}
            </Typography>
          )}
        </Box>
      </Stack>

      {/* ── The choice ── */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Sends the plan's staffing data — every active position with its contract, pay inputs and
          calculated heads, FTE and hours, plus the manual input and buyout rows. Names and employee
          numbers never leave the hotel. Money by account is not included; the ledger carries that.
        </Typography>
        {/* Source → destination: the plan goes INTO the submission. */}
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          sx={{ alignItems: { xs: "stretch", sm: "flex-start" } }}
        >
          <FormControl size="small" sx={{ flex: 1, minWidth: 0 }}>
            <InputLabel id="submit-plan">Plan</InputLabel>
            <Select
              labelId="submit-plan"
              id="submit-plan-select"
              label="Plan"
              value={scenarioId}
              onChange={(e) => setScenarioId(String(e.target.value))}
              displayEmpty={scenarios.length === 0}
            >
              {scenarios.length === 0 && (
                <MenuItem value="" disabled>
                  No plans for {year}
                </MenuItem>
              )}
              {scenarios.map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.label}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>The plan whose data is sent</FormHelperText>
          </FormControl>

          <Box
            aria-hidden
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "text.secondary",
              height: { sm: 40 },
              transform: { xs: "rotate(90deg)", sm: "none" },
            }}
          >
            <ArrowForwardIcon />
          </Box>

          <FormControl size="small" sx={{ flex: 1, minWidth: 0 }}>
            <InputLabel id="submit-slot">Submission</InputLabel>
            <Select
              labelId="submit-slot"
              id="submit-slot-select"
              label="Submission"
              value={slot}
              onChange={(e) => setSlot(String(e.target.value))}
              renderValue={(value) => `${SLOT_LABELS[value] ?? value} ${year}`}
            >
              {SUBMISSION_SLOTS.map((s) => (
                <MenuItem key={s} value={s} disabled={!enabledSlots.has(s)}>
                  {SLOT_LABELS[s] ?? s} {year} ({submissionTag(s, year)})
                  {!enabledSlots.has(s) ? " — not open yet" : ""}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>Year {year} comes from the budget year in the top bar</FormHelperText>
          </FormControl>
        </Stack>

        {!yearOpen && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Submissions for {year} are not open yet. To submit{" "}
            {ENABLED_SUBMISSION_YEARS.join(" or ")}, switch the budget year in the top bar.
          </Alert>
        )}
      </Paper>

      {/* ── What would go ── */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
          <Typography variant="subtitle1" sx={{ flex: 1 }}>
            What will be sent
          </Typography>
          {previewing && <CircularProgress size={18} />}
          <Button size="small" startIcon={<RefreshIcon />} onClick={loadPreview} disabled={!scenarioId || previewing}>
            Rebuild
          </Button>
        </Stack>

        {previewError && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {previewError}
          </Alert>
        )}

        {!scenarioId && !previewError && (
          <Typography variant="body2" color="text.secondary">
            Choose a plan to see what it would submit.
          </Typography>
        )}

        {preview && header && (
          <>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1, mb: 1.5 }}>
              <Chip label={`${tag} · ${scenario?.label ?? "plan"}`} color="primary" variant="outlined" />
              <Chip label={`${preview.counts.positions} positions`} />
              <Chip label={`${preview.counts.manualRows} manual rows`} />
              <Chip label={`${preview.counts.buyoutRows} buyout rows`} />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Contract week {fmt(header.contract_week)} h · effective week {fmt(header.effective_week, 4)} h ·
              full-timer {fmt(header.full_time_hours_year, 0)} h a year · calculated {when(String(header.engine_computed_at ?? ""))}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Heads at December {fmt(sumColumn(preview, "calc_heads_year"), 0)} · FTE {fmt(sumColumn(preview, "calc_fte_year"))} ·
              hours {fmt(sumColumn(preview, "calc_hours_total_year"), 0)}
            </Typography>

            {preview.warnings.length > 0 && (
              <Stack spacing={1} sx={{ mt: 1.5 }}>
                {preview.warnings.map((w) => (
                  <Alert key={`${w.code}|${w.message}`} severity="warning">
                    {w.message}
                  </Alert>
                ))}
              </Stack>
            )}

            <Button
              size="small"
              sx={{ mt: 1.5 }}
              onClick={() => setColumnsOpen((open) => !open)}
              endIcon={columnsOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            >
              Columns
            </Button>
            <Collapse in={columnsOpen}>
              <Stack spacing={1} sx={{ mt: 1 }}>
                {(
                  [
                    ["Submission", preview.payload.submission],
                    ["Positions", preview.payload.positions],
                    ["Manual rows", preview.payload.manualRows],
                    ["Buyout rows", preview.payload.buyoutRows],
                  ] as const
                ).map(([label, table]) => (
                  <Box key={label}>
                    <Typography variant="caption" color="text.secondary">
                      {label} — {table.rows.length} rows × {table.columns.length} columns
                    </Typography>
                    <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-word" }}>
                      {table.columns.join(", ")}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </Collapse>
          </>
        )}
      </Paper>

      {/* ── Send ── */}
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
          <Box sx={{ flex: 1 }}>
            {statusError ? (
              <Typography variant="body2" color="text.secondary">
                Submission status unavailable: {statusError}
              </Typography>
            ) : status === null ? (
              <Typography variant="body2" color="text.secondary">
                Checking what has been submitted…
              </Typography>
            ) : current ? (
              <Typography variant="body2" color="text.secondary">
                {tag} last submitted {when(current.submittedAt)} by {current.submittedBy || "unknown"}
                {current.scenarioLabel ? ` from "${current.scenarioLabel}"` : ""}. Submitting again replaces it.
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {tag} has not been submitted for this hotel yet.
              </Typography>
            )}
          </Box>
          <Button
            variant="contained"
            startIcon={sending ? <CircularProgress size={16} color="inherit" /> : <SendOutlinedIcon />}
            disabled={!canSubmit}
            onClick={() => setConfirmOpen(true)}
          >
            {sending ? "Submitting…" : "Submit"}
          </Button>
        </Stack>

        {sendError && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {sendError}
          </Alert>
        )}
        {receipt && (
          <Alert severity="success" sx={{ mt: 1.5 }}>
            {receipt.replaced ? "Replaced" : "Submitted"} {submissionTag(receipt.slot, receipt.year)} at {when(receipt.receivedAt)}
            {receipt.submittedBy ? ` as ${receipt.submittedBy}` : ""} — {receipt.counts.positions} positions,{" "}
            {receipt.counts.manualRows} manual rows, {receipt.counts.buyoutRows} buyout rows received.
          </Alert>
        )}
      </Paper>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        If the plan's results are out of date, submitting calculates it first — the same as Recalculate on
        the Results page.
      </Typography>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Submit {tag}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This sends "{scenario?.label ?? "the plan"}" for {hotelName || ou} as the {tag} submission
            {current ? ", replacing the one submitted " + when(current.submittedAt) : ""}. One submission is kept
            per hotel and tag.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={submit}>
            Submit
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/** Σ of one numeric column over the positions table. */
function sumColumn(preview: SubmissionPreviewResponse, column: string): number {
  const index = preview.payload.positions.columns.indexOf(column);
  if (index < 0) return 0;
  let total = 0;
  for (const row of preview.payload.positions.rows) total += Number(row[index]) || 0;
  return total;
}
