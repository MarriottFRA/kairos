/**
 * Window IPC Handlers
 * Owns UI scaling via Electron's zoom factor. All scale logic lives in the main
 * process so it can measure a zoom-independent window size (avoiding the feedback
 * loop that would occur if the renderer measured its own zoomed viewport).
 */

import { BrowserWindow } from "electron";
import type { IpcHandler } from "../types";

type ScaleMode = "auto" | "manual";

// ── Tuning knobs ─────────────────────────────────────────────
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.0; // only ever scale down — never magnify the UI
// Window content width (DIP) at which auto ≈ 1.0. A large/maximized window on a
// 4k display (~3840) renders at 1.0; smaller windows scale down proportionally.
const REFERENCE_WIDTH = 3840;

// Current policy shared across the (single) app window. Updated by the renderer
// once settings load; defaults to native 1.0 (manual) so the pre-login screens
// render at full fidelity. A saved policy may switch it to auto or another factor.
let policy: { mode: ScaleMode; factor: number } = { mode: "manual", factor: 1 };

// Windows we've already wired resize/load listeners onto.
const wired = new WeakSet<BrowserWindow>();
// Last factor actually pushed to each window, so we can skip redundant relayouts.
const lastApplied = new WeakMap<BrowserWindow, number>();

// Debounce window for the auto-mode resize recompute (ms). Dragging a window edge
// fires many resize events/sec; each setZoomFactor triggers a relayout, so we only
// re-zoom once the drag settles.
const RESIZE_DEBOUNCE_MS = 120;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Derive a scale from the window's own content width (zoom-independent). */
function computeAutoFactor(win: BrowserWindow): number {
  const width = win.getContentBounds().width;
  const raw = 0.6 + 0.4 * (width / REFERENCE_WIDTH);
  return clamp(Math.round(raw * 100) / 100, MIN_ZOOM, MAX_ZOOM);
}

/**
 * Apply the effective factor to a window and return it. Pass force=true after a
 * page load, where Chromium may have reset the webContents zoom back to 1 even
 * though our cached value is unchanged — the change-guard must be bypassed.
 */
function applyToWindow(win: BrowserWindow, force = false): number {
  if (win.isDestroyed()) return 1;
  const factor =
    policy.mode === "auto" ? computeAutoFactor(win) : clamp(policy.factor, MIN_ZOOM, MAX_ZOOM);
  // Skip the relayout entirely if the factor hasn't changed since last apply.
  if (force || lastApplied.get(win) !== factor) {
    win.webContents.setZoomFactor(factor);
    lastApplied.set(win, factor);
  }
  // Disable pinch / ctrl-scroll visual zoom so the factor stays authoritative.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  return factor;
}

/**
 * Attach the UI-scale behaviour to a window (idempotent). In auto mode a resize
 * recomputes the scale — which also covers a user dragging the app to a different
 * monitor and resizing it there. The zoom factor can reset when a new page loads,
 * so we reassert it on every finished load.
 */
export function attachUiScale(win: BrowserWindow): void {
  if (wired.has(win)) return;
  wired.add(win);

  // Debounced auto recompute — coalesces the burst of resize events from an
  // interactive drag into a single re-zoom once the size settles.
  let resizeTimer: NodeJS.Timeout | null = null;
  const recompute = () => {
    if (policy.mode !== "auto") return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      applyToWindow(win);
    }, RESIZE_DEBOUNCE_MS);
  };
  win.on("resize", recompute);
  // A finished load may have reset the zoom to 1 — force reassert it.
  win.webContents.on("did-finish-load", () => applyToWindow(win, true));

  // Apply immediately for the current content (login / loading screens).
  applyToWindow(win);
}

/**
 * Create window-related IPC handlers.
 */
export function createWindowHandlers(): Record<string, IpcHandler> {
  return {
    "window:set-ui-scale": async (
      event,
      req: { mode: ScaleMode; factor?: number }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { applied: false };

      policy = {
        mode: req?.mode === "manual" ? "manual" : "auto",
        factor: clamp(Number(req?.factor) || 1, MIN_ZOOM, MAX_ZOOM),
      };

      attachUiScale(win); // idempotent — also ensures resize listeners exist
      const effectiveFactor = applyToWindow(win);
      return { applied: true, effectiveFactor };
    },
  };
}
