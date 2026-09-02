/**
 * useGridStatePersistence — save/restore the user's grid layout.
 * -----------------------------------------------------------
 * Restores the exported DataGrid state (column order/width/visibility, pinned
 * columns, density, aggregation) from the settings store before the grid
 * mounts, and persists it (debounced 1 s) whenever the user rearranges the
 * grid. Row data and preference-panel state are stripped before saving.
 *
 * `persistLayout` is the same save for rearrangements the grid does not
 * announce: changing the `columns` prop rebuilds the column order silently (no
 * columnOrderChange event), so a reorder that came from outside the grid would
 * otherwise be undone by the older saved layout on the next mount. The debounce
 * is what makes it safe to call during the render that causes the change — the
 * export runs a second later, from the committed grid.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GridInitialState,
  useGridApiRef,
} from "@mui/x-data-grid-premium";
import { settingsService, SETTINGS_KEYS } from "../services/settingsService";

const SAVE_DEBOUNCE_MS = 1000;

const LAYOUT_EVENTS = [
  "columnOrderChange",
  "columnWidthChange",
  "columnVisibilityModelChange",
  "pinnedColumnsChange",
  "densityChange",
  "aggregationModelChange",
] as const;

export function useGridStatePersistence(
  apiRef: ReturnType<typeof useGridApiRef>,
  gridMounted: boolean
) {
  /** undefined = still loading; null = nothing saved. */
  const [restoredState, setRestoredState] = useState<
    GridInitialState | null | undefined
  >(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await settingsService.getSetting(
          SETTINGS_KEYS.POSITIONS_GRID_STATE
        );
        if (cancelled) return;
        setRestoredState(raw ? (JSON.parse(raw) as GridInitialState) : null);
      } catch {
        if (!cancelled) setRestoredState(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveNow = useCallback(() => {
    timerRef.current = null;
    try {
      const state = apiRef.current?.exportState();
      if (!state) return;
      // Layout only — rows/filters/panels don't belong in a saved layout.
      delete (state as Record<string, unknown>).rows;
      delete (state as Record<string, unknown>).preferencePanel;
      delete (state as Record<string, unknown>).filter;
      void settingsService.setSetting(
        SETTINGS_KEYS.POSITIONS_GRID_STATE,
        JSON.stringify(state)
      );
    } catch (error) {
      console.warn("Failed to persist grid layout:", error);
    }
  }, [apiRef]);

  const persistLayout = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }, [saveNow]);

  useEffect(() => {
    if (!gridMounted || !apiRef.current) return;
    const unsubscribers = LAYOUT_EVENTS.map((event) =>
      apiRef.current!.subscribeEvent(event as never, persistLayout)
    );
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      // Flush rather than cancel: the last rearrangement before leaving the
      // page is the one most likely to look lost, and the grid is still
      // exportable here.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        saveNow();
      }
    };
  }, [apiRef, gridMounted, persistLayout, saveNow]);

  return { restoredState, persistLayout };
}
