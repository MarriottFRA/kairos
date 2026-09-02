/**
 * useGridStatePersistence — save/restore the user's grid layout.
 * -----------------------------------------------------------
 * Restores the exported DataGrid state (column order/width/visibility, pinned
 * columns, density, aggregation) from the settings store before the grid
 * mounts, and persists it (debounced 1 s) whenever the user rearranges the
 * grid. Row data and preference-panel state are stripped before saving.
 */

import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    if (!gridMounted || !apiRef.current) return;

    const persist = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
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
      }, SAVE_DEBOUNCE_MS);
    };

    const unsubscribers = LAYOUT_EVENTS.map((event) =>
      apiRef.current!.subscribeEvent(event as never, persist)
    );
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [apiRef, gridMounted]);

  return restoredState;
}
