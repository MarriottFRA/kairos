/**
 * Results — the generated budget output (dept × account, monthly).
 * -----------------------------------------------------------
 * Read-only presentation of the persisted engine run for the selected hotel +
 * planning scenario. Recalculate re-runs the engine over the SAVED data and
 * overwrites the stored output (calculation-only blocks — blank account —
 * never appear here). A fingerprint compare drives the "out of date" chip
 * whenever any input changed since the run: positions, blocks, calendar, KPI
 * recalc or a budget pull.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";
import { DataGridPremium, GridColDef } from "@mui/x-data-grid-premium";
import {
  OutputAggRowDto,
  OutputsResponse,
  SECURE_DB_LOCKED,
} from "../../shared/positions/ipc";
import { loadOutputs, recalcOutputs } from "../../services/outputsService";
import { listScenarios } from "../../services/scenarioService";
import { ScenarioDto } from "../../shared/positions/ipc";
import {
  useBudgetYear,
  usePlanningScenarioId,
  useSelectedHotel,
} from "../../store/settings";

type Kind = "all" | "costs" | "stats";

const MONTH_SHORT = Array.from({ length: 12 }, (_, m) =>
  new Date(2000, m, 1).toLocaleString("en", { month: "short" })
);

interface ResultRow extends OutputAggRowDto {
  id: string;
}

export default function Results() {
  const selectedHotelOu = useSelectedHotel();
  const budgetYear = useBudgetYear();
  const planningScenarioId = usePlanningScenarioId();

  const [scenario, setScenario] = useState<ScenarioDto | null>(null);
  const [outputs, setOutputs] = useState<OutputsResponse | null>(null);
  const [kind, setKind] = useState<Kind>("all");
  const [loading, setLoading] = useState(false);
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const forYear = scenarios.filter((s) => s.year === budgetYear);
        setScenario(
          forYear.find((s) => s.id === planningScenarioId) ??
            forYear.find((s) => s.label === "Planning") ??
            forYear[0] ??
            null
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
    return filtered.map((row) => ({ ...row, id: `${row.dept}|${row.account}` }));
  }, [outputs, kind]);

  const columns = useMemo<GridColDef<ResultRow>[]>(() => {
    const numberColumn = (field: string, headerName: string, index?: number): GridColDef<ResultRow> => ({
      field,
      headerName,
      width: field === "total" ? 124 : 96,
      type: "number",
      sortable: field === "total",
      cellClassName: "res-cell--num",
      valueGetter:
        index === undefined
          ? undefined
          : (_value, row) => (row ? row.months[index] : null),
      valueFormatter: (value: number | null | undefined) => {
        const num = Number(value);
        if (!Number.isFinite(num) || num === 0) return num === 0 ? "–" : "";
        return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
      },
    });

    return [
      {
        field: "dept",
        headerName: "Department",
        width: 120,
      },
      {
        field: "account",
        headerName: "Account",
        width: 130,
        renderCell: (params) => (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
            <span>{params.value as string}</span>
            {params.row?.isStats && (
              <Chip label="stat" size="small" variant="outlined" sx={{ height: 18, fontSize: "0.625rem" }} />
            )}
          </Stack>
        ),
      },
      ...MONTH_SHORT.map((name, index) => numberColumn(`m${index + 1}`, name, index)),
      numberColumn("total", "Year"),
    ];
  }, []);

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

      <Box sx={{ flex: 1, minHeight: 0 }}>
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
          <DataGridPremium
            rows={rows}
            columns={columns}
            loading={loading || recalcBusy}
            rowGroupingModel={["dept"]}
            defaultGroupingExpansionDepth={-1}
            initialState={{
              aggregation: {
                model: Object.fromEntries([
                  ...MONTH_SHORT.map((_name, index) => [`m${index + 1}`, "sum"]),
                  ["total", "sum"],
                ]),
              },
              pinnedColumns: { right: ["total"] },
            }}
            rowHeight={32}
            columnHeaderHeight={40}
            hideFooter
            sx={{
              borderRadius: 2,
              "& .res-cell--num": {
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: "0.8125rem",
              },
            }}
          />
        )}
      </Box>

      {outputs?.run && rows.length === 0 && !loading && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
          The last run produced no output lines — check that your positions are
          active and your blocks have accounts.
        </Typography>
      )}
    </Box>
  );
}
