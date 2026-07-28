/**
 * The twelve month columns of the push, as twelve tiles.
 *
 * This is the whole control surface for what a push does. It replaced a global
 * overwrite/add toggle, a "clear first" switch and a "from month N" dropdown,
 * because none of those could express the thing a hotel actually needs by
 * autumn: Jan–Sep hold actuals and must not be touched, Oct–Dec are still being
 * re-forecast and should be wiped and rewritten. That is a per-column decision,
 * so the control is per column.
 *
 * Each tile carries its own numbers — what Kairos would write into that month,
 * how many cells it writes, how many it clears — so the consequence of an
 * action is visible on the thing you click rather than in a sentence somewhere
 * else. The same component renders the result afterwards (`readOnly`), so
 * "what will happen" and "what happened" are read in the same place, in the
 * same shape.
 */

import { useState } from "react";
import {
  Box,
  Button,
  Chip,
  Divider,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

import {
  MONTH_ACTIONS,
  MonthAction,
  MonthPlanEntry,
  PUSH_MONTHS,
  clearsColumn,
  writesValues,
} from "../../shared/bstPush/ipc";
import { MONTH_LONG, MONTH_SHORT, formatMonthRanges } from "../../shared/calendar";

type ActionColor = "default" | "primary" | "info" | "warning";

/** Label, colour and the plain-English consequence of each action, in one place
 *  — the same pattern STATUS_META established for the plan grid. */
export const MONTH_ACTION_META: Record<
  MonthAction,
  { label: string; short: string; color: ActionColor; hint: string }
> = {
  skip: {
    label: "Leave alone",
    short: "Skip",
    color: "default",
    hint: "This column is never touched. Use it to protect actuals.",
  },
  replace: {
    label: "Replace",
    short: "Replace",
    color: "primary",
    hint:
      "Clear every row the clear rules cover in this column, then write " +
      "Kairos values. The BST ends up equal to Kairos.",
  },
  add: {
    label: "Add to",
    short: "Add",
    color: "info",
    hint:
      "Add Kairos values on top of what the BST already holds. Nothing is " +
      "cleared, so pushing this month twice double-counts it.",
  },
  clear: {
    label: "Clear out",
    short: "Clear",
    color: "warning",
    hint:
      "Zero every row the clear rules cover in this column and write nothing " +
      "back, leaving it empty.",
  },
};

const ACTION_TINT: Record<ActionColor, string> = {
  default: "text.disabled",
  primary: "primary.main",
  info: "info.main",
  warning: "warning.main",
};

function compact(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "–";
  const abs = Math.abs(value);
  if (abs >= 1000) return `${Math.round(value / 1000).toLocaleString()}k`;
  return value.toLocaleString(undefined, { maximumFractionDigits: abs < 10 ? 1 : 0 });
}

function MonthTile({
  entry,
  readOnly,
  disabled,
  onPick,
}: {
  entry: MonthPlanEntry;
  readOnly: boolean;
  disabled: boolean;
  onPick: (action: MonthAction) => void;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const meta = MONTH_ACTION_META[entry.action];
  const tint = ACTION_TINT[meta.color];
  const isIdle = entry.action === "skip";

  // Clicking the tile body cycles; the caret picks directly. Cycling is what
  // makes setting nine months to "skip" quick, which is the common edit.
  const cycle = () => {
    const next = MONTH_ACTIONS[(MONTH_ACTIONS.indexOf(entry.action) + 1) % MONTH_ACTIONS.length];
    onPick(next);
  };

  return (
    <Box
      sx={{
        border: (theme) => `1px solid ${theme.palette.divider}`,
        borderLeft: 3,
        borderLeftColor: isIdle ? "divider" : tint,
        borderRadius: 1.5,
        px: 1, py: 0.75,
        opacity: isIdle ? 0.62 : 1,
        backgroundColor: (theme) =>
          isIdle ? "transparent" : theme.palette.action.hover,
        transition: "opacity 120ms, background-color 120ms",
      }}
    >
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>
          {MONTH_SHORT[entry.month - 1]}
        </Typography>
        {readOnly ? (
          (entry.writeCells > 0 || entry.clearCells > 0) && (
            <CheckCircleIcon sx={{ fontSize: 15, color: tint }} />
          )
        ) : (
          <Tooltip title={`Choose what happens to ${MONTH_LONG[entry.month - 1]}`}>
            <span>
              <ExpandMoreIcon
                onClick={(event) => {
                  if (disabled) return;
                  event.stopPropagation();
                  setAnchor(event.currentTarget as unknown as HTMLElement);
                }}
                sx={{
                  fontSize: 16,
                  color: "text.secondary",
                  cursor: disabled ? "default" : "pointer",
                }}
              />
            </span>
          </Tooltip>
        )}
      </Stack>

      <Tooltip
        title={
          <>
            <strong>{MONTH_LONG[entry.month - 1]} — {meta.label}.</strong> {meta.hint}
            <br />
            {entry.writeCells.toLocaleString()} cell(s) written,{" "}
            {entry.clearCells.toLocaleString()} cleared.
          </>
        }
      >
        <Box
          onClick={readOnly || disabled ? undefined : cycle}
          sx={{ cursor: readOnly || disabled ? "default" : "pointer", mt: 0.25 }}
        >
          <Typography
            sx={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "0.8125rem",
              fontWeight: 600,
              color: writesValues(entry.action) ? "text.primary" : "text.disabled",
            }}
          >
            {writesValues(entry.action) ? compact(entry.writeTotal) : "–"}
          </Typography>
          <Chip
            size="small"
            label={meta.short}
            color={meta.color === "default" ? undefined : meta.color}
            variant={meta.color === "default" ? "outlined" : "filled"}
            sx={{ mt: 0.5, height: 19, width: "100%", fontSize: "0.625rem", fontWeight: 700 }}
          />
          <Typography
            variant="caption"
            sx={{ display: "block", mt: 0.25, color: "text.secondary", fontSize: "0.625rem" }}
          >
            {clearsColumn(entry.action)
              ? `${entry.clearCells.toLocaleString()} cleared`
              : " "}
          </Typography>
        </Box>
      </Tooltip>

      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {MONTH_ACTIONS.map((action) => (
          <MenuItem
            key={action}
            selected={action === entry.action}
            onClick={() => {
              onPick(action);
              setAnchor(null);
            }}
          >
            <Stack>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {MONTH_ACTION_META[action].label}
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary", maxWidth: 320 }}>
                {MONTH_ACTION_META[action].hint}
              </Typography>
            </Stack>
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

/** "Replacing Oct–Dec · leaving Jan–Sep alone" — the plan in one line. */
export function describeMonthPlan(months: MonthAction[]): string {
  const phrases: string[] = [];
  const byAction: Record<MonthAction, number[]> = {
    skip: [], replace: [], add: [], clear: [],
  };
  months.forEach((action, index) => byAction[action].push(index));

  const verb: Record<MonthAction, string> = {
    replace: "Replacing",
    add: "Adding to",
    clear: "Clearing",
    skip: "Leaving alone",
  };
  for (const action of ["replace", "add", "clear", "skip"] as MonthAction[]) {
    const indices = byAction[action];
    if (indices.length === 0) continue;
    phrases.push(
      indices.length === PUSH_MONTHS
        ? `${verb[action]} every month`
        : `${verb[action]} ${formatMonthRanges(indices)}`
    );
  }
  return phrases.join(" · ");
}

export interface MonthPlanBarProps {
  monthPlan: MonthPlanEntry[];
  /**
   * The live selection, when it is ahead of `monthPlan`. Recomputing the plan
   * is a round-trip to main, so binding the tiles to what came back would leave
   * a click looking like it did nothing for as long as the recalculation takes.
   * The verb answers instantly; only the counts underneath catch up.
   */
  actions?: MonthAction[];
  onChange?: (months: MonthAction[]) => void;
  /** Report mode: no editing, ticks on the columns that changed. */
  readOnly?: boolean;
  disabled?: boolean;
}

export default function MonthPlanBar({
  monthPlan,
  actions,
  onChange,
  readOnly = false,
  disabled = false,
}: MonthPlanBarProps) {
  const months = actions ?? monthPlan.map((entry) => entry.action);

  const setAll = (action: MonthAction) =>
    onChange?.(Array.from({ length: PUSH_MONTHS }, () => action));

  const setLastThree = () =>
    onChange?.(
      Array.from({ length: PUSH_MONTHS }, (_unused, index) =>
        index >= PUSH_MONTHS - 3 ? "replace" : "skip"
      )
    );

  const setOne = (index: number, action: MonthAction) => {
    const next = [...months];
    next[index] = action;
    onChange?.(next);
  };

  const totalWrite = monthPlan.reduce((sum, entry) => sum + entry.writeCells, 0);
  const totalClear = monthPlan.reduce((sum, entry) => sum + entry.clearCells, 0);

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 1 }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {readOnly ? "What landed" : "Months to push"}
        </Typography>
        {!readOnly && (
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", rowGap: 0.75 }}>
            <Button size="small" disabled={disabled} onClick={() => setAll("replace")}
              sx={{ textTransform: "none" }}>
              Replace all
            </Button>
            <Button size="small" disabled={disabled} onClick={setLastThree}
              sx={{ textTransform: "none" }}>
              Last 3 months only
            </Button>
            <Button size="small" disabled={disabled} onClick={() => setAll("clear")}
              sx={{ textTransform: "none" }}>
              Clear every month
            </Button>
            <Button size="small" disabled={disabled} onClick={() => setAll("skip")}
              sx={{ textTransform: "none" }}>
              Touch nothing
            </Button>
          </Stack>
        )}
      </Stack>

      <Box
        sx={{
          mt: 1.25,
          display: "grid",
          gap: 0.75,
          gridTemplateColumns: {
            xs: "repeat(3, 1fr)",
            sm: "repeat(6, 1fr)",
            lg: "repeat(12, 1fr)",
          },
        }}
      >
        {monthPlan.map((entry, index) => (
          <MonthTile
            key={entry.month}
            entry={{ ...entry, action: months[index] ?? entry.action }}
            readOnly={readOnly}
            disabled={disabled}
            onPick={(action) => setOne(index, action)}
          />
        ))}
      </Box>

      <Divider sx={{ my: 1.25 }} />

      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 0.5 }}
      >
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {describeMonthPlan(months)}
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {totalWrite.toLocaleString()} cell(s) {readOnly ? "written" : "to write"} ·{" "}
          {totalClear.toLocaleString()} {readOnly ? "cleared" : "to clear"}
        </Typography>
      </Stack>

      {!readOnly && (
        <Stack direction="row" spacing={1.5} sx={{ mt: 0.75, flexWrap: "wrap", rowGap: 0.5 }}>
          {MONTH_ACTIONS.map((action) => (
            <Tooltip key={action} title={MONTH_ACTION_META[action].hint}>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                <Box
                  sx={{
                    width: 9, height: 9, borderRadius: "50%",
                    border: (theme) => `1px solid ${theme.palette.divider}`,
                    backgroundColor: ACTION_TINT[MONTH_ACTION_META[action].color],
                  }}
                />
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {MONTH_ACTION_META[action].label}
                </Typography>
              </Stack>
            </Tooltip>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
