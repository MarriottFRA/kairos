/**
 * Results — the generated budget output (dept × account, monthly).
 * -----------------------------------------------------------
 * Read-only presentation of the persisted run for the selected hotel + planning
 * scenario. Recalculate re-runs the engine over the SAVED data and overwrites
 * the stored output (calculation-only blocks — blank account — never appear
 * here). A fingerprint compare drives the "out of date" chip whenever any input
 * changed since the run: positions, blocks, calendar, KPI recalc, a budget
 * pull, manual input or an allocation.
 *
 * The rows are a union of four origins — the engine, Manual Input, allocations
 * and buyouts — each tagged with its source. Because the BST push sends exactly
 * what this page shows, every number that can reach the workbook has to be
 * explainable here: clicking any cell opens the inspector with the individual
 * lines behind it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  InputAdornment,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SubjectOutlinedIcon from "@mui/icons-material/SubjectOutlined";
import { OutputsResponse, SECURE_DB_LOCKED } from "../../shared/positions/ipc";
import ResultsGrid, {
  ResultRow,
  ResultSelection,
  rowIdOf,
} from "../../components/results/ResultsGrid";
import ResultsInspector from "../../components/results/ResultsInspector";
import { loadOutputs, recalcOutputs } from "../../services/outputsService";
import { listScenarios } from "../../services/scenarioService";
import { ScenarioDto } from "../../shared/positions/ipc";
import { resolvePlanningScenario } from "../../shared/positions/scenarioResolve";
import {
  useBudgetYear,
  usePlanningScenarioId,
  useSelectedHotel,
} from "../../store/settings";
import { usePlanScope } from "../../hooks/usePlanScope";
import PartialScopeAlert from "../../components/sync/PartialScopeAlert";

type Kind = "all" | "costs" | "stats";

export default function Results() {
  const selectedHotelOu = useSelectedHotel();
  const budgetYear = useBudgetYear();
  const planningScenarioId = usePlanningScenarioId();

  // Totals under-report silently under a partial scope. See PartialScopeAlert.
  const planScope = usePlanScope(selectedHotelOu, planningScenarioId);

  const [scenario, setScenario] = useState<ScenarioDto | null>(null);
  const [outputs, setOutputs] = useState<OutputsResponse | null>(null);
  const [kind, setKind] = useState<Kind>("all");
  const [quickFilter, setQuickFilter] = useState("");
  // On by default: the whole point of the descriptions is that a GL code is not
  // readable, and anyone who wants the compact view flips this off.
  const [showDescriptions, setShowDescriptions] = useState(true);
  const [loading, setLoading] = useState(false);
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ResultSelection | null>(null);

  // ── Resolve the planning scenario (same healing as the Positions page) ──
  useEffect(() => {
    if (!selectedHotelOu) {
      setScenario(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const scenarios = await listScenarios(selectedHotelOu, budgetYear);
        if (cancelled) return;
        setScenario(
          resolvePlanningScenario(scenarios, budgetYear, planningScenarioId)
        );
      } catch (err) {
        console.error("Failed to resolve scenario for results:", err);
        if (!cancelled) setScenario(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, budgetYear, planningScenarioId]);

  const surfaceError = useCallback((err: unknown, fallback: string) => {
    const message = err instanceof Error ? err.message : fallback;
    setError(
      message === SECURE_DB_LOCKED
        ? "The secure store is locked — sign out and back in to load results."
        : message
    );
  }, []);

  // ── Load the stored outputs when the scope changes ──
  useEffect(() => {
    if (!selectedHotelOu || !scenario) {
      setOutputs(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const response = await loadOutputs(selectedHotelOu, scenario.id);
        if (!cancelled) setOutputs(response);
      } catch (err) {
        console.error("Failed to load outputs:", err);
        if (!cancelled) {
          surfaceError(err, "Failed to load results");
          setOutputs(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, scenario, surfaceError]);

  const handleRecalc = useCallback(() => {
    if (!selectedHotelOu || !scenario) return;
    setRecalcBusy(true);
    setError(null);
    void (async () => {
      try {
        setOutputs(await recalcOutputs(selectedHotelOu, scenario.id));
      } catch (err) {
        console.error("Recalculate failed:", err);
        surfaceError(err, "Recalculate failed");
      } finally {
        setRecalcBusy(false);
      }
    })();
  }, [selectedHotelOu, scenario, surfaceError]);

  const rows = useMemo<ResultRow[]>(() => {
    const all = outputs?.rows ?? [];
    const filtered =
      kind === "all" ? all : all.filter((row) => row.isStats === (kind === "stats"));
    return filtered.map((row) => ({ ...row, id: rowIdOf(row) }));
  }, [outputs, kind]);

  // A selection that no longer exists (filter change, recalculate) must not
  // leave the inspector explaining a row the user can no longer see.
  useEffect(() => {
    if (!selection || selection.isDeptGroup) return;
    const stillThere = rows.some(
      (row) => row.dept === selection.dept && row.account === selection.account
    );
    if (!stillThere) setSelection(null);
  }, [rows, selection]);

  /** Components whose lines were computed but had no account to post to, worst
   *  first — the "where did my number go" explanation. */
  const unposted = useMemo(
    () =>
      Object.entries(outputs?.diagnostics?.unpostedByLabel ?? {}).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      ),
    [outputs]
  );

  const neverCalculated = !!outputs && outputs.run === null;

  return (
    <Box
      sx={{ p: 2, display: "flex", flexDirection: "column", height: "calc(100vh - 64px)", minHeight: 0 }}
    >
      {!selectedHotelOu && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Select a hotel from the switcher in the top bar to see its results.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {planScope.scopeKind === "PARTIAL" && (
        // Results are still shown — a delegate needs to see their own
        // departments' numbers — but the TOTALS are the lie, because they
        // under-report with nothing to say anything is missing. The banner is
        // the disclosure; it stays until the scope widens.
        <PartialScopeAlert
          surface="results"
          departments={planScope.ownership?.departments.map((row) => row.code) ?? null}
        />
      )}
      {outputs?.diagnostics &&
        (unposted.length > 0 || outputs.diagnostics.allZeroPositions > 0) && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            onClose={() =>
              setOutputs((prev) => (prev ? { ...prev, diagnostics: undefined } : prev))
            }
          >
            {unposted.length > 0 && (
              <>
                Calculated but not posted — no account set on the Positions grid:{" "}
                {unposted
                  .map(([label, count]) => `${label} (${count} position${count === 1 ? "" : "s"})`)
                  .join(", ")}
                . These lines still feed any block that uses them as a base; set
                their account codes to see them here.
              </>
            )}
            {unposted.length > 0 && outputs.diagnostics.allZeroPositions > 0 && <br />}
            {outputs.diagnostics.allZeroPositions > 0 && (
              <>
                {outputs.diagnostics.allZeroPositions} active position
                {outputs.diagnostics.allZeroPositions === 1 ? "" : "s"} produced only
                zeros — check the salary/hourly rate, working months, and Count.
              </>
            )}
          </Alert>
        )}

      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
        <Button
          variant="contained"
          disableElevation
          startIcon={
            recalcBusy ? <CircularProgress size={16} color="inherit" /> : <CalculateOutlinedIcon />
          }
          onClick={handleRecalc}
          disabled={!selectedHotelOu || !scenario || recalcBusy}
          sx={{ height: 36, px: 2 }}
        >
          {recalcBusy ? "Calculating…" : "Recalculate"}
        </Button>

        {outputs?.run && (
          <Tooltip
            title={`${outputs.run.lineCount} lines from ${outputs.run.positionCount} positions`}
          >
            <Chip
              size="small"
              variant="outlined"
              color={outputs.stale ? "warning" : "success"}
              label={
                outputs.stale
                  ? "Out of date — inputs changed since this was calculated"
                  : `Calculated ${new Date(outputs.run.computedAt).toLocaleString()}`
              }
              sx={{ height: 28, fontWeight: 600 }}
            />
          </Tooltip>
        )}

        <ToggleButtonGroup
          exclusive
          size="small"
          value={kind}
          onChange={(_event, next: Kind | null) => next && setKind(next)}
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="costs">Costs</ToggleButton>
          <ToggleButton value="stats">Statistics</ToggleButton>
        </ToggleButtonGroup>

        <TextField
          size="small"
          placeholder="Search accounts, departments, blocks…"
          value={quickFilter}
          onChange={(event) => setQuickFilter(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ width: 260, "& .MuiOutlinedInput-root": { height: 36 } }}
        />

        <Tooltip title="Show account and department descriptions">
          <ToggleButton
            size="small"
            value="descriptions"
            selected={showDescriptions}
            onChange={() => setShowDescriptions((previous) => !previous)}
            sx={{ height: 36, px: 1.25 }}
          >
            <SubjectOutlinedIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>

        <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
          <Chip size="small" variant="outlined" label={`Budget ${budgetYear}`} sx={{ height: 28, fontWeight: 600 }} />
          <Chip
            size="small"
            variant="outlined"
            color="primary"
            label={scenario?.label ?? "No scenario"}
            sx={{ height: 28, fontWeight: 600 }}
          />
        </Stack>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        {neverCalculated && !loading ? (
          <Alert
            severity="info"
            action={
              <Button color="inherit" size="small" onClick={handleRecalc} disabled={recalcBusy}>
                Recalculate
              </Button>
            }
          >
            No results yet for {budgetYear} — {scenario?.label ?? "this scenario"}.
            Recalculate to generate the budget output from your positions and blocks.
          </Alert>
        ) : (
          <>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <ResultsGrid
                rows={rows}
                loading={loading || recalcBusy}
                selection={selection}
                onSelect={setSelection}
                quickFilter={quickFilter}
                showDescriptions={showDescriptions}
              />
            </Box>
            {selection && selectedHotelOu && scenario && (
              <ResultsInspector
                selection={selection}
                rows={rows}
                ou={selectedHotelOu}
                scenarioId={scenario.id}
                onClose={() => setSelection(null)}
              />
            )}
          </>
        )}
      </Box>

      {outputs?.run && rows.length === 0 && !loading && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
          The last run produced no output lines — check that your positions are
          active and your blocks have accounts.
        </Typography>
      )}
      {/* The run DID produce rows; the grid looks empty because the search hid
          them. Saying "no output lines" here would be a lie. */}
      {rows.length > 0 && quickFilter.trim() !== "" && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
          Showing rows matching “{quickFilter.trim()}” —{" "}
          <Box
            component="span"
            onClick={() => setQuickFilter("")}
            sx={{ cursor: "pointer", textDecoration: "underline" }}
          >
            clear the search
          </Box>{" "}
          to see the whole budget.
        </Typography>
      )}
    </Box>
  );
}
