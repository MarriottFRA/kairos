/**
 * CellSelectionStats — the Excel status-bar readout for a selected cell range.
 *
 * Select three salary cells and this says what they come to. Nothing more: it
 * is a floating pill in the bottom-right corner of the grid, it appears at two
 * selected cells and disappears again, and it never takes a click (see
 * pointerEvents below).
 *
 * WHY IT SUBSCRIBES TO THE API INSTEAD OF TAKING A PROP
 *
 * The obvious wiring — `onCellSelectionModelChange` on the grid, `setState` on
 * the page — is the one thing that must not happen here. That callback fires
 * once per cell entered during a drag, so it would re-render the page AND the
 * grid a few hundred times per drag, on grids whose props are deliberately held
 * behind memos precisely so that never happens (see the stable-prop notes in
 * PositionsGrid). Subscribing to `cellSelectionChange` off the apiRef instead
 * keeps the whole feature inside this component: the grid gains no prop, the
 * page gains no state, and the only thing that re-renders is this pill.
 *
 * The second half of that guarantee is the rAF coalescing. A drag across 400
 * cells publishes 400 events; `schedule` collapses every event that lands in
 * one frame into a single recompute, so the cost is bounded by frames on screen
 * rather than by cells crossed.
 *
 * FILTERS ARE ALREADY HANDLED. `getSelectedCellsAsArray` walks the grid's
 * visible rows and keeps only selected cells found there, so a row the user
 * filtered out after selecting it is gone from the total by construction —
 * which is also what Excel does. Group headers and the aggregation footer ARE
 * in that list though, and their cells hold sums of the leaves beside them, so
 * they are skipped explicitly or every grouped total would count twice.
 */

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Fade from "@mui/material/Fade";
import type { SxProps, Theme } from "@mui/material/styles";
import type { useGridApiRef } from "@mui/x-data-grid-premium";

/**
 * The `user-select` fix every `cellSelection` grid needs. Spread into the
 * grid's own `sx`.
 *
 * This is a performance fix, not a styling choice. With `cellSelection` on, MUI
 * adds `root--disableUserSelection` to the grid ROOT on cellMouseDown and
 * removes it on mouseup (useGridCellSelection), to stop a range drag from also
 * dragging a text selection. That class sets `user-select: none`, which is an
 * INHERITED property — so flipping it on the root makes the browser
 * re-propagate computed style to every descendant. At a full viewport that is
 * ~1000 cells, twice per click and four times per double click, and it is the
 * whole reason clicking a cell lags while arrow keys (which never touch the
 * class) stay instant.
 *
 * Declaring it up front means the root's computed value is already `none`, so
 * MUI's toggle no longer changes anything and the recalculation stops at the
 * root. Nothing is lost: a cellSelection grid never allowed drag-to-select text
 * anyway — that is precisely what MUI was toggling the class to prevent — and
 * Ctrl+C still copies through the grid's own clipboard handling.
 */
export const CELL_SELECTION_PERF_SX: SxProps<Theme> = {
  userSelect: "none",
  // Editors are the exception: text inside an open cell editor must still be
  // selectable, and `user-select` would otherwise inherit straight into them.
  "& input, & textarea": { userSelect: "text" },
};

/**
 * Ceiling on cells read per recompute.
 *
 * Unreachable by the shortcuts these grids offer — Ctrl+Space selects one
 * column (~1000 cells) and there is deliberately no select-all — but a drag
 * auto-scrolls, so the range a mouse can build has no natural bound. Past this
 * the readout stops rather than spends a visible frame on arithmetic nobody
 * asked for.
 */
const MAX_CELLS = 20_000;

/** Below two cells there is nothing to add up, and a pill on every click is noise. */
const MIN_CELLS = 2;

interface Stats {
  /** Numeric cells actually summed — not cells selected. */
  count: number;
  sum: number;
  avg: number;
  /** The range ran past MAX_CELLS and these numbers cover only part of it. */
  partial: boolean;
}

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

type GridApiRef = ReturnType<typeof useGridApiRef>;

function computeStats(api: NonNullable<GridApiRef["current"]>): Stats | null {
  const cells = api.getSelectedCellsAsArray();
  if (cells.length < MIN_CELLS) return null;

  const limit = Math.min(cells.length, MAX_CELLS);
  let count = 0;
  let sum = 0;
  for (let index = 0; index < limit; index += 1) {
    const { id, field } = cells[index];
    // Group headers and the aggregation footer carry sums of the rows below
    // them; counting those alongside their own leaves double-counts the range.
    if (api.getRowNode(id)?.type !== "leaf") continue;
    const value = api.getCellValue(id, field);
    // Deliberately no coercion: a numeric-looking string in a text column is a
    // job code or an employee number far more often than it is money.
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    count += 1;
    sum += value;
  }

  if (count === 0) return null;
  return { count, sum, avg: sum / count, partial: cells.length > limit };
}

function sameStats(a: Stats | null, b: Stats | null): boolean {
  if (a === null || b === null) return a === b;
  return a.count === b.count && a.sum === b.sum && a.partial === b.partial;
}

export interface CellSelectionStatsProps {
  apiRef: GridApiRef;
  /**
   * Distance from the bottom of the grid, in px. Raise it clear of the grid
   * footer where one is shown — the pill is decoration and must never sit over
   * the row count or the horizontal scrollbar.
   */
  bottom?: number;
}

export default function CellSelectionStats({
  apiRef,
  bottom = 8,
}: CellSelectionStatsProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  // Read inside the rAF callback so a recompute never closes over a stale
  // value; `stats` itself is not in the effect's deps for the same reason.
  const statsRef = useRef<Stats | null>(null);
  const shownRef = useRef<Stats | null>(null);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return undefined;

    let frame = 0;
    const recompute = () => {
      frame = 0;
      const next = computeStats(api);
      if (sameStats(statsRef.current, next)) return;
      statsRef.current = next;
      setStats(next);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(recompute);
    };

    const unsubscribes = [
      api.subscribeEvent("cellSelectionChange", schedule),
      // A filter applied while a range is selected shrinks what the range
      // covers, and the selection model itself does not change when it does.
      api.subscribeEvent("filteredRowsSet", schedule),
    ];

    return () => {
      if (frame) cancelAnimationFrame(frame);
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [apiRef]);

  // What the pill prints, which is not the same as what is selected: clearing
  // the numbers with the selection would empty the pill before it had finished
  // fading out. A render-time cache rather than state — it never causes a
  // render of its own, it only survives the one the fade-out already triggers.
  if (stats) shownRef.current = stats;
  const shown = shownRef.current;

  return (
    <Fade in={stats !== null} appear={false}>
      <Box
        sx={{
          position: "absolute",
          right: 12,
          bottom,
          zIndex: 4,
          // The pill floats over live cells. Never let it swallow a click meant
          // for the grid underneath — there is nothing to click on it anyway.
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 1.5,
          py: 0.5,
          borderRadius: 1.5,
          border: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          boxShadow: 3,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "0.75rem",
          whiteSpace: "nowrap",
        }}
      >
        <Stat label="Count" value={statLabel(shown, "count")} />
        <Stat label="Sum" value={statLabel(shown, "sum")} />
        <Stat label="Avg" value={statLabel(shown, "avg")} />
      </Box>
    </Fade>
  );
}

function statLabel(stats: Stats | null, key: "count" | "sum" | "avg"): string {
  if (!stats) return "";
  if (key === "count") return `${NUMBER_FORMAT.format(stats.count)}${stats.partial ? "+" : ""}`;
  return NUMBER_FORMAT.format(stats[key]);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box component="span" sx={{ display: "flex", gap: 0.5 }}>
      <Box component="span" sx={{ color: "text.secondary" }}>
        {label}
      </Box>
      <Box component="span" sx={{ fontWeight: 700 }}>
        {value}
      </Box>
    </Box>
  );
}
