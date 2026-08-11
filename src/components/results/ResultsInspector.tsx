/**
 * ResultsInspector — "where did this number come from?"
 *
 * Results is a union of four origins (engine, manual input, allocations,
 * buyouts) aggregated to dept × account, and the BST push sends exactly these
 * rows. That makes traceability a requirement rather than a nicety: every number
 * that reaches the workbook has to be explainable on the page it came from.
 *
 * A docked panel rather than a dialog, because the question is usually asked
 * across several cells in a row ("why is February high — and March?"). The grid
 * stays visible and the panel re-reads as the selection moves.
 *
 * Three questions, one surface:
 *   - a month cell  -> the lines contributing to that month, biggest first
 *   - the Year cell -> the same lines with all twelve months
 *   - a department  -> which accounts roll up, and their totals
 *
 * It shows the JOB TITLE and the Count, never an employee name. The title is
 * not masked anywhere in this app (the field catalog is explicit that it
 * "describes the post, not the person"), and the drill-down query deliberately
 * never selects first_name / last_name. "Front Desk Agent x4" answers the
 * question; the individual behind it is not the question.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import CloseIcon from "@mui/icons-material/Close";
import { OutputLineDto, OutputValueKind } from "../../shared/positions/ipc";
import { loadOutputLines } from "../../services/outputsService";
import { MONTH_SHORT, ResultRow, ResultSelection } from "./ResultsGrid";
import { formatResultValue, yearValueOf } from "./format";
import { SourceChip } from "./sourceMeta";

export const INSPECTOR_WIDTH = 340;

/**
 * Below this viewport width the panel stops being a dock and becomes an
 * overlay. Derived, not picked: the grid's own columns (dept + account + source
 * + twelve months + Year ≈ 1500px) plus the panel plus the navigation rail —
 * past that the dock is taking space the table cannot spare.
 */
const MIN_WIDTH_FOR_DOCK = 1500;

export interface ResultsInspectorProps {
  selection: ResultSelection | null;
  /** Every visible row — the department view is assembled from these. */
  rows: ResultRow[];
  ou: string;
  scenarioId: string;
  onClose: () => void;
}

/** A one-line explanation of a non-engine line, from its stored detail blob. */
function detailHint(line: OutputLineDto): string | null {
  const detail = line.detail ?? {};
  if (line.source === "MANUAL") {
    const side = detail.side === "stats" ? "units" : "amount";
    if (detail.rateDriven && typeof detail.rate === "number") {
      return `Manual ${side} · units x ${detail.rate}`;
    }
    return `Manual ${side} · typed`;
  }
  if (line.source === "ALLOCATION") {
    const percent =
      typeof detail.percent === "number" ? `${detail.percent.toFixed(2)}%` : null;
    const base = typeof detail.spreadBase === "string" ? detail.spreadBase : null;
    const parts = [percent, base ? `by ${base.toLowerCase().replace(/_/g, " ")}` : null]
      .filter(Boolean)
      .join(" · ");
    return detail.excluded ? `Excluded from this split${parts ? ` · ${parts}` : ""}` : parts || null;
  }
  if (line.source === "BUYOUT") return "Bypasses the engine";
  if (line.source === "SETUP") {
    const setting = typeof detail.setting === "string" ? detail.setting : "Setup value";
    return `${setting} · from the Home page`;
  }
  return null;
}

export default function ResultsInspector({
  selection,
  rows,
  ou,
  scenarioId,
  onClose,
}: ResultsInspectorProps) {
  const [lines, setLines] = useState<OutputLineDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Docked beside the grid, or slid in over it?
   *
   * The dock costs the grid a fixed 340px. That is a fair trade at a desk and a
   * bad one on a laptop, where it would leave the table too narrow to read the
   * months the panel is explaining. The threshold is the width at which the
   * grid still shows a full year after paying for the panel.
   */
  const overlay = useMediaQuery(`(max-width:${MIN_WIDTH_FOR_DOCK}px)`);

  // Hold the last real selection through the close transition so the panel does
  // not flash empty on its way out (same trick as PositionFormDialog).
  const lastSelection = useRef<ResultSelection | null>(null);
  if (selection) lastSelection.current = selection;
  const shown = selection ?? lastSelection.current;

  const row = useMemo(
    () =>
      shown && !shown.isDeptGroup
        ? rows.find((r) => r.dept === shown.dept && r.account === shown.account)
        : undefined,
    [rows, shown]
  );

  /** The department view: which accounts make up this department. */
  const deptRows = useMemo(
    () =>
      shown?.isDeptGroup
        ? rows
            .filter((r) => r.dept === shown.dept)
            .slice()
            .sort((a, b) => Math.abs(yearValueOf(b)) - Math.abs(yearValueOf(a)))
        : [],
    [rows, shown]
  );

  useEffect(() => {
    if (!selection || selection.isDeptGroup || !ou || !scenarioId) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadOutputLines(
      ou,
      scenarioId,
      selection.dept,
      selection.account,
      selection.month ?? undefined
    )
      .then((result) => {
        if (!cancelled) setLines(result);
      })
      .catch((err) => {
        console.error("Failed to load output lines:", err);
        if (!cancelled) {
          setError((err as Error).message ?? "Failed to load the breakdown");
          setLines([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection, ou, scenarioId]);

  if (!shown) return null;

  const kind: OutputValueKind = row?.valueKind ?? "currency";
  const isMonth = shown.month !== null;
  const scopeLabel = shown.isDeptGroup
    ? "Department"
    : isMonth
      ? new Date(2000, shown.month as number, 1).toLocaleString("en", {
          month: "long",
        })
      : "Full year";

  /** One line's number under the current scope. */
  const valueOf = (line: OutputLineDto) =>
    isMonth ? line.months[shown.month as number] ?? 0 : line.total;

  const linesTotal = lines.reduce((sum, line) => sum + valueOf(line), 0);

  const panel = (
    <Box
      sx={
        overlay
          ? {
              // Slid in over the grid: it owns its own edge and padding, since
              // there is no sibling column to sit beside.
              width: INSPECTOR_WIDTH,
              maxWidth: "100vw",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              p: 2,
            }
          : {
              width: INSPECTOR_WIDTH,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderLeft: 1,
              borderColor: "divider",
              pl: 2,
              ml: 2,
            }
      }
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", mb: 1.5 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="overline"
            sx={{ color: "text.secondary", lineHeight: 1.4 }}
          >
            Inspect
          </Typography>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
            {shown.isDeptGroup
              ? shown.dept || "(No department)"
              : `${shown.dept || "—"} · ${shown.account}`}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {scopeLabel}
          </Typography>
          {/* The grid's Source cell is a summary; the full set of origins for
              this row is spelled out here, next to the lines it explains. */}
          {row?.sources && row.sources.length > 0 && (
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.75, flexWrap: "wrap", rowGap: 0.5 }}>
              {row.sources.map((source) => (
                <SourceChip key={source} source={source} />
              ))}
            </Stack>
          )}
        </Box>
        <IconButton size="small" onClick={onClose} aria-label="Close inspector">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Divider />

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", py: 1.5 }}>
        {shown.isDeptGroup ? (
          <DepartmentBreakdown rows={deptRows} />
        ) : loading ? (
          <Stack sx={{ alignItems: "center", py: 3 }}>
            <CircularProgress size={20} />
          </Stack>
        ) : error ? (
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        ) : lines.length === 0 ? (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            No lines behind this cell. Recalculate if the results are out of
            date.
          </Typography>
        ) : (
          <Stack spacing={1.25}>
            {lines.map((line, index) => (
              <LineRow
                key={`${line.source}:${line.sourceRef}:${line.label}:${index}`}
                line={line}
                value={valueOf(line)}
                kind={kind}
                showMonths={!isMonth}
              />
            ))}
          </Stack>
        )}
      </Box>

      {!shown.isDeptGroup && lines.length > 0 && (
        <>
          <Divider />
          <Stack
            direction="row"
            sx={{ alignItems: "baseline", justifyContent: "space-between", py: 1.25 }}
          >
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              Total
            </Typography>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 700,
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {formatResultValue(linesTotal, kind)}
            </Typography>
          </Stack>
        </>
      )}
    </Box>
  );

  if (!overlay) return panel;

  // Narrow window: slide the same panel in over the grid rather than taking a
  // third of it. Deliberately NOT a modal — no backdrop, no focus trap, no
  // scroll lock — because the grid underneath has to stay clickable: the
  // question is usually asked across several cells in a row, and the panel
  // re-reads as the selection moves.
  return (
    <Drawer
      anchor="right"
      open={!!selection}
      onClose={onClose}
      variant="temporary"
      hideBackdrop
      ModalProps={{
        keepMounted: true,
        disableEnforceFocus: true,
        disableScrollLock: true,
      }}
      slotProps={{ paper: { sx: { boxShadow: 6 } } }}
    >
      {panel}
    </Drawer>
  );
}

/** One contributing line: what it is, what it is worth, where it came from. */
function LineRow({
  line,
  value,
  kind,
  showMonths,
}: {
  line: OutputLineDto;
  value: number;
  kind: OutputValueKind;
  showMonths: boolean;
}) {
  const hint = detailHint(line);
  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "baseline", justifyContent: "space-between" }}
      >
        <Stack
          direction="row"
          spacing={0.75}
          sx={{ alignItems: "center", minWidth: 0 }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {line.displayName}
          </Typography>
          {/* The Count multiplier — "x4" is the difference between one salary
              and four identical ones, and it is not visible anywhere else here. */}
          {line.headcount !== null && line.headcount !== 1 && (
            <Chip
              size="small"
              variant="outlined"
              label={`x${line.headcount}`}
              sx={{ height: 17, fontSize: "0.625rem" }}
            />
          )}
        </Stack>
        <Typography
          variant="body2"
          sx={{ fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" }}
        >
          {formatResultValue(value, kind)}
        </Typography>
      </Stack>

      <Stack
        direction="row"
        spacing={0.75}
        sx={{ alignItems: "center", mt: 0.25 }}
      >
        <SourceChip source={line.source} dense />
        <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
          {hint ?? line.label}
        </Typography>
      </Stack>

      {showMonths && <MonthStrip months={line.months} kind={kind} />}
    </Box>
  );
}

/** Twelve months at a glance — only shown when the whole year is in scope. */
function MonthStrip({
  months,
  kind,
}: {
  months: number[];
  kind: OutputValueKind;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "repeat(6, 1fr)",
        gap: 0.25,
        mt: 0.5,
      }}
    >
      {months.map((value, index) => (
        <Tooltip key={index} title={MONTH_SHORT[index]}>
          <Box
            sx={{
              px: 0.5,
              py: 0.25,
              borderRadius: 0.5,
              bgcolor: "action.hover",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "0.625rem",
              textAlign: "right",
              color: value === 0 ? "text.disabled" : "text.secondary",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {formatResultValue(value, kind)}
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
}

/**
 * A department group: which accounts roll up into it. Answered from the rows
 * already in memory — no round trip for a question the page can already see.
 */
function DepartmentBreakdown({ rows }: { rows: ResultRow[] }) {
  if (rows.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Nothing posted to this department.
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {rows.length} account{rows.length === 1 ? "" : "s"} · click an account
        row for its lines
      </Typography>
      {rows.map((row) => (
        <Stack
          key={`${row.dept}|${row.account}`}
          direction="row"
          spacing={1}
          sx={{ alignItems: "baseline", justifyContent: "space-between" }}
        >
          <Stack
            direction="row"
            spacing={0.75}
            sx={{ alignItems: "center", minWidth: 0 }}
          >
            <Typography variant="body2" noWrap>
              {row.account}
            </Typography>
            {row.sources.map((source) => (
              <SourceChip key={source} source={source} dense />
            ))}
          </Stack>
          <Typography
            variant="body2"
            sx={{
              fontFamily: "'IBM Plex Mono', monospace",
              whiteSpace: "nowrap",
            }}
          >
            {formatResultValue(yearValueOf(row), row.valueKind)}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}
