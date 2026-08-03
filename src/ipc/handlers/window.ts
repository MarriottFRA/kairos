/**
 * Window IPC Handlers
 * Owns UI scaling via Electron's zoom factor. All scale logic lives in the main
 * process so it can measure a zoom-independent window size (avoiding the feedback
 * loop that would occur if the renderer measured its own zoomed viewport).
 */

import { BrowserWindow } from "electron";
import log from "electron-log";
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

// Float tolerance when comparing our target factor to Chromium's reported one.
// Zoom factors are quantised steps, so anything above this is a real divergence.
const FACTOR_EPSILON = 0.001;

// Debounce window for the auto-mode resize recompute (ms). Dragging a window edge
// fires many resize events/sec; each setZoomFactor triggers a relayout, so we only
// re-zoom once the drag settles.
const RESIZE_DEBOUNCE_MS = 120;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Dedicated logger for zoom-drift anomalies.
 *
 * main.ts disables electron-log's file transport outright (see RELEASING.md), so a
 * packaged build writes nothing anywhere — which would make a field recurrence of
 * the drift unprovable. This is a separate instance with its own small, capped file
 * so that decision stays untouched: nothing else writes here, and in normal
 * operation the file is never created at all.
 */
const driftLog = log.create({ logId: "ui-scale" });
driftLog.transports.console.level = "warn";
driftLog.transports.file.level = "warn";
driftLog.transports.file.fileName = "ui-scale.log";
driftLog.transports.file.maxSize = 256 * 1024;

/** Derive a scale from the window's own content width (zoom-independent). */
function computeAutoFactor(win: BrowserWindow): number {
  const width = win.getContentBounds().width;
  const raw = 0.6 + 0.4 * (width / REFERENCE_WIDTH);
  return clamp(Math.round(raw * 100) / 100, MIN_ZOOM, MAX_ZOOM);
}

/**
 * Apply the effective factor to a window and return it. Pass force=true to skip
 * the change-guard entirely (e.g. after a page load).
 *
 * The guard compares against Chromium's *actual* zoom rather than a value we
 * cached. Chromium owns this state and other paths can change it behind our back;
 * a local cache goes stale the moment that happens and then permanently suppresses
 * the one call that would correct it — the app could never recover without a
 * settings change. Reading the real value makes every apply self-healing.
 */
function applyToWindow(win: BrowserWindow, force = false): number {
  if (win.isDestroyed()) return 1;
  const factor =
    policy.mode === "auto" ? computeAutoFactor(win) : clamp(policy.factor, MIN_ZOOM, MAX_ZOOM);

  const actual = win.webContents.getZoomFactor();
  const drifted = Math.abs(actual - factor) > FACTOR_EPSILON;

  // Skip the relayout entirely when the zoom is already what we want.
  if (force || drifted) {
    // A drift outside a forced reassert means something set the zoom outside this
    // module. Log it so a recurrence in the field is provable, not inferred.
    if (!force && drifted) {
      driftLog.warn(
        `zoom drift corrected: observed ${actual.toFixed(3)}, expected ${factor.toFixed(3)} (mode=${policy.mode})`
      );
    }
    win.webContents.setZoomFactor(factor);
  }
  // Disable pinch / ctrl-scroll visual zoom so the factor stays authoritative.
  // Returns a promise in Electron 43 — swallow it so a window closing mid-call
  // can't surface as an unhandled rejection.
  void Promise.resolve(win.webContents.setVisualZoomLevelLimits(1, 1)).catch(() => {
    /* window went away mid-call; nothing to recover */
  });
  return factor;
}

/**
 * Attach the UI-scale behaviour to a window (idempotent). In auto mode a resize
 * recomputes the scale — which also covers a user dragging the app to a different
 * monitor and resizing it there. The zoom factor can reset when a new page loads,
 * so we reassert it on every finished load.
 *
 * We also reassert on focus, restore and in-page navigation. Those are the points
 * where an externally-changed zoom would otherwise stick: the app uses a hash
 * router, so did-finish-load never fires again after startup, and in manual mode
 * a resize is not a recompute. Each of these is a cheap read that no-ops unless
 * the zoom genuinely drifted (see the guard in applyToWindow).
 */
export function attachUiScale(win: BrowserWindow): void {
  if (wired.has(win)) return;
  wired.add(win);

  // Debounced resize handler — coalesces the burst of resize events from an
  // interactive drag into a single apply once the size settles. Manual mode has
  // nothing to recompute, but still reasserts, so the drag can't leave a drifted
  // zoom in place.
  let resizeTimer: NodeJS.Timeout | null = null;
  const recompute = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      applyToWindow(win);
    }, RESIZE_DEBOUNCE_MS);
  };
  win.on("resize", recompute);
  // A finished load may have reset the zoom to 1 — force reassert it.
  win.webContents.on("did-finish-load", () => applyToWindow(win, true));

  // Alt-Tab back, and returning from a parentless native file dialog (the import
  // and BST-push flows all open one without a parent window).
  win.on("focus", () => applyToWindow(win));
  // Minimise / restore.
  win.on("restore", () => applyToWindow(win));
  // Hash-router route changes — the only "navigation" this app performs.
  win.webContents.on("did-navigate-in-page", () => applyToWindow(win));

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
