/**
 * How each result source is presented — one record, used by both the grid's
 * chip column and the inspector.
 *
 * Results is a union of five origins now, and the whole point of showing them
 * is that a user can tell at a glance whether a number was calculated or typed.
 * Keeping the label/colour/hint in one place is what stops the grid and the
 * inspector describing the same line two different ways.
 *
 * Modelled on STATUS_META in bstPush/PushPlanGrid.tsx — the established way this
 * app explains a cell.
 */

import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import type { ChipProps } from "@mui/material/Chip";
import type { OutputSource } from "../../shared/positions/ipc";

export const SOURCE_META: Record<
  OutputSource,
  { label: string; color: ChipProps["color"]; hint: string }
> = {
  ENGINE: {
    label: "engine",
    color: "primary",
    hint: "Calculated by the payroll engine from this scenario's positions and blocks.",
  },
  MANUAL: {
    label: "manual",
    color: "warning",
    hint: "Hand-entered on the Manual Input page — not calculated from anything.",
  },
  ALLOCATION: {
    label: "alloc",
    color: "info",
    hint: "An allocation split, posted as a share out of 100 (15.23 = 15.23%) in January.",
  },
  BUYOUT: {
    label: "buyout",
    color: "secondary",
    hint: "A manual department x account override that bypasses the engine.",
  },
  SETUP: {
    label: "setup",
    color: "success",
    hint: "A hotel setup value from the Home page, reported as a statistic in January.",
  },
};

/**
 * A row's origins as ONE cell.
 *
 * A strip of chips per row turned the column into visual noise and still could
 * not be read at a glance — which was the entire point of having it. A merged
 * row legitimately mixes origins (an engine account Manual Input also posts to),
 * so the cell names the dominant one and counts the rest; the dock is where the
 * per-line breakdown belongs, because that is where the numbers are.
 */
export function SourceSummaryCell({ sources }: { sources: OutputSource[] }) {
  if (!sources || sources.length === 0) return null;

  const [primary, ...rest] = sources;
  const meta = SOURCE_META[primary] ?? SOURCE_META.ENGINE;
  const title = sources
    .map((source) => `${SOURCE_META[source]?.label ?? source}: ${SOURCE_META[source]?.hint ?? ""}`)
    .join("\n");

  return (
    <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{title}</span>}>
      <Chip
        size="small"
        variant="outlined"
        color={meta.color}
        label={rest.length > 0 ? `${meta.label} +${rest.length}` : meta.label}
        sx={{
          height: 20,
          fontSize: "0.6875rem",
          fontWeight: 600,
          "& .MuiChip-label": { px: 0.75 },
        }}
      />
    </Tooltip>
  );
}

/**
 * The blocks behind a row, as chips beside its source.
 *
 * The inspector already answers "what produced this number" perfectly, but it
 * costs a click; for the common case — one or two blocks feed an account — the
 * answer belongs in the row. An account CAN legitimately be fed by many blocks,
 * so this shows the biggest contributors and counts the rest, the same bargain
 * SourceSummaryCell strikes above.
 *
 * Deliberately colourless. The source chip is the coloured one and it answers a
 * different question (where a number came from, not what made it); giving both
 * a palette is what turned the old per-source chip strip into noise.
 */
export function BlockChips({
  labels,
  max = 2,
}: {
  labels: string[];
  max?: number;
}) {
  if (!labels || labels.length === 0) return null;

  const shown = labels.slice(0, max);
  const hidden = labels.length - shown.length;

  return (
    <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{labels.join("\n")}</span>}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", minWidth: 0 }}>
        {shown.map((label) => (
          <Chip
            key={label}
            size="small"
            variant="outlined"
            label={label}
            sx={{
              height: 20,
              maxWidth: 130,
              fontSize: "0.6875rem",
              color: "text.secondary",
              "& .MuiChip-label": {
                px: 0.75,
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
            }}
          />
        ))}
        {hidden > 0 && (
          <Chip
            size="small"
            variant="outlined"
            label={`+${hidden}`}
            sx={{
              height: 20,
              fontSize: "0.6875rem",
              color: "text.secondary",
              "& .MuiChip-label": { px: 0.625 },
            }}
          />
        )}
      </Stack>
    </Tooltip>
  );
}

/** One source chip. `dense` is the in-grid size; the inspector uses the larger. */
export function SourceChip({
  source,
  dense,
}: {
  source: OutputSource;
  dense?: boolean;
}) {
  const meta = SOURCE_META[source] ?? SOURCE_META.ENGINE;
  return (
    <Tooltip title={meta.hint}>
      <Chip
        size="small"
        variant="outlined"
        color={meta.color}
        label={meta.label}
        sx={{
          height: dense ? 18 : 22,
          fontSize: dense ? "0.625rem" : "0.6875rem",
          fontWeight: 600,
          "& .MuiChip-label": { px: dense ? 0.625 : 1 },
        }}
      />
    </Tooltip>
  );
}
