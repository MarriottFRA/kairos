/**
 * Electron Main Process with Modular IPC Architecture
 * -----------------------------------------------------------
 */

import { app, BrowserWindow, session, shell } from "electron";
import { autoUpdater } from "electron";
import { updateElectronApp } from "update-electron-app";
import log from "electron-log";
import path from "path";
import dotenv from "dotenv";
import { closeLocalDatabase, initializeDatabase } from "./local_db";
import { closeSecureDatabase } from "./secure_db";
import { initializeIpc } from "./ipc";
import { setupAutoUpdaterEvents, markAutoUpdaterReady } from "./ipc/handlers/app";
import { attachUiScale } from "./ipc/handlers/window";
import { createAuthStack } from "./main/auth";
import { API_BASE_URL, SWA_ORIGIN } from "./config";

// ────────────────────────────────────────────────────────────
// 0) ENV + GLOBAL DECLS (Vite globals, .env loading)
// ────────────────────────────────────────────────────────────

dotenv.config();

// ────────────────────────────────────────────────────────────
// Configure electron-log for auto-updater debugging
// Logs are disabled in production
// ────────────────────────────────────────────────────────────
log.transports.file.level = false;

/**
 * Vite's Electron plugin exposes these build-time globals.
 * Declare them so TypeScript is happy in this file.
 */
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL:
  | string
  | undefined;
declare const MAIN_WINDOW_VITE_NAME:
  | string
  | undefined;

// ────────────────────────────────────────────────────────────
// 1) SECURITY + APP SINGLETON GUARD
//    Prevent multiple instances and ensure safe defaults.
// ────────────────────────────────────────────────────────────

/**
 * Never allow two instances to run simultaneously.
 * Required for consistent deep-link handling and DB/file locks.
 */
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  // When a second instance tries to launch, focus the existing window
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Squirrel (Windows) install/uninstall shortcut handler — exit early.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (require("electron-squirrel-startup")) {
    app.quit();
  }
} catch {
  // ignore if not present
}

// ────────────────────────────────────────────────────────────
// 2) TYPES + LIGHTWEIGHT LOGGER
// ────────────────────────────────────────────────────────────

type Nullable<T> = T | null;

/**
 * Tiny logger wrapper — swap for a structured logger in prod (e.g. pino).
 * Learner-friendly but production-safe: gate debug by NODE_ENV.
 */
const LOG_LEVEL =
  (process.env.LOG_LEVEL ?? "").toLowerCase(); // "debug" to force debug logging
const isDev = process.env.NODE_ENV !== "production";
const logger = {
  info: (...args: unknown[]) => console.log("[INFO ]", ...args),
  warn: (...args: unknown[]) => console.warn("[WARN ]", ...args),
  error: (...args: unknown[]) => console.error("[ERROR]", ...args),
  debug: (...args: unknown[]) => {
    if (isDev || LOG_LEVEL === "debug") {
      // console.debug("[DEBUG]", ...args);
    }
  },
};

// ────────────────────────────────────────────────────────────
// 3) WINDOW MANAGEMENT (main window creation + utilities)
// ────────────────────────────────────────────────────────────

let mainWindow: Nullable<BrowserWindow> = null;

// Window icon (title bar / taskbar / alt-tab). The main process runs from
// .vite/build, and `src/` is excluded from the package, so this has to be
// resolved differently per build: packaged copies live in resources/ via
// packagerConfig.extraResource. On Windows the exe icon usually wins anyway,
// but Linux and the dev run both rely on this path.
const WINDOW_ICON = app.isPackaged
  ? path.join(process.resourcesPath, "kairos_logo.png")
  : path.join(__dirname, "../../src/images/kairos_logo.png");

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false, // show when ready-to-show for smoother UX
    autoHideMenuBar: true, // Hide menu bar (File, Edit, View, Window)
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true, // critical for security
      sandbox: true, // renderer runs sandboxed; preload only uses ipcRenderer/contextBridge
      webSecurity: true, // renderer no longer calls the API directly (main owns all network)
      devTools: true, // Keep devTools available but don't open by default
    },
  });

  // Wire UI scaling before any content loads. The default policy is native 1.0, so
  // the update-checker, loading and login screens render at full fidelity. The
  // renderer pushes the persisted policy (which may switch to auto or a saved
  // factor) once settings load.
  attachUiScale(mainWindow);

  // Harden navigation: deny popups and block navigation away from app content.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Open any external link in the user's browser, never a new Electron window.
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const current = mainWindow?.webContents.getURL() ?? "";
    // Allow in-app navigation (hash router / same document); block everything else.
    if (navigationUrl.split("#")[0] !== current.split("#")[0]) {
      event.preventDefault();
    }
  });

  // Load the UI (Vite dev or production file).
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    const rendererPath = path.join(
      __dirname,
      `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`
    );
    logger.info('Loading renderer from:', rendererPath);
    logger.info('__dirname:', __dirname);
    logger.info('MAIN_WINDOW_VITE_NAME:', MAIN_WINDOW_VITE_NAME);
    void mainWindow.loadFile(rendererPath);
  }

  // Log any load failures
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error('Failed to load:', validatedURL, 'Error:', errorDescription, 'Code:', errorCode);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    // DevTools can be opened with Ctrl+Shift+I or F12 (Electron default shortcuts)
    // No automatic opening in production or development
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Safe send to renderer (no-op if window gone). */
function sendToRenderer(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ────────────────────────────────────────────────────────────
// 4) MODULAR IPC SYSTEM INITIALIZATION
//    Using the new registry-based architecture
// ────────────────────────────────────────────────────────────

// The IPC handlers are now organized in separate modules and
// initialized through the registry system. See src/ipc/ for details.

/**
 * Apply a Content-Security-Policy to all renderer responses. The renderer loads
 * only local content and talks to main over IPC (never the network), so the
 * policy can be strict. In dev we relax it for the Vite dev server (HMR needs
 * inline/eval scripts and a websocket connection).
 */
function setupContentSecurityPolicy(devServerUrl?: string): void {
  const isDev = Boolean(devServerUrl);
  const policy = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; ")
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'", // MUI/Emotion inject inline styles
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'", // renderer makes no direct network calls
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

// ────────────────────────────────────────────────────────────
// 5) AUTO-UPDATER CONFIGURATION
// ────────────────────────────────────────────────────────────

/**
 * Configure auto-updater using update-electron-app
 * This works with Electron Forge + Squirrel.Windows
 * Only runs in packaged/production builds
 *
 * Must run BEFORE the renderer is loaded: UpdateChecker fires
 * `app:check-for-updates` from its mount effect, and Electron's Windows
 * autoUpdater throws "Update URL is not set" if checkForUpdates() is called
 * before update-electron-app has had a chance to call setFeedURL(). The IPC
 * hop beats the paint round-trip, so initialising on `ready-to-show` lost
 * that race and surfaced the error card on every launch.
 */
function initializeAutoUpdater(): void {
  if (!app.isPackaged) {
    logger.info("Auto-updater disabled in development mode");
    return;
  }

  logger.info("Initializing auto-updater for packaged app");

  // Initialize update-electron-app with configuration
  updateElectronApp({
    updateInterval: '10 minutes',
    logger: log,
    notifyUser: false, // We handle notifications via IPC to renderer
  });

  // The feed URL is set synchronously inside updateElectronApp() (the app is
  // already ready by now), so manual checks are safe from here on.
  markAutoUpdaterReady();

  // Set up event listeners for Electron's native autoUpdater
  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates...");
    logger.info("Checking for updates...");
  });

  autoUpdater.on("update-available", () => {
    log.info("Update available");
    logger.info("Update available");
  });

  autoUpdater.on("update-not-available", () => {
    log.info("No updates available");
    logger.info("No updates available");
  });

  autoUpdater.on("update-downloaded", () => {
    log.info("Update downloaded");
    logger.info("Update downloaded");
  });

  autoUpdater.on("error", (err) => {
    log.error("Auto-updater error:", err);
    logger.error("Auto-updater error:", err);
  });
}

// ────────────────────────────────────────────────────────────
// 6) APP LIFECYCLE (create window, init DB & IPC)
// ────────────────────────────────────────────────────────────

app.on("ready", async () => {
  try {
    // Initialize local database before anything that reads it (auth stack, IPC).
    await initializeDatabase();

    // Build the main-process auth stack (owns tokens, refresh loop, device secret).
    // Must come after DB init (reads permanent salt / device id) and after `ready`
    // (safeStorage requires the app to be ready).
    const { authController, apiClient } = await createAuthStack({
      baseUrl: API_BASE_URL,
      swaOrigin: SWA_ORIGIN,
      // Lazy getter: the main window is created later in this handler, so the
      // broker resolves it on demand (when the user triggers a sign-in).
      getMainWindow: () => mainWindow,
      sendToRenderer,
    });

    // Apply CSP to renderer responses (strict in prod, relaxed for Vite in dev).
    setupContentSecurityPolicy(MAIN_WINDOW_VITE_DEV_SERVER_URL);

    // Initialize the modular IPC system with the auth stack.
    initializeIpc({
      authController,
      apiClient,
      sendToRenderer,
      logger,
      devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL ?? null,
    });

    createMainWindow();

    // Setup auto-updater event forwarding to renderer
    setupAutoUpdaterEvents(mainWindow);

    // Configure the updater in the same tick as createMainWindow(), before the
    // renderer can execute any JS, so the feed URL is already set when
    // UpdateChecker asks for a manual check. Listeners above are registered
    // first so the automatic startup check can't fire into a void.
    initializeAutoUpdater();
  } catch (err) {
    logger.error("Startup error:", err);
    // In a real prod app, consider user-facing error UI here.
  }
});

// Close both databases on the way out so each WAL is checkpointed into its main
// file and the -wal/-shm sidecars are retired, rather than left for the next
// launch to recover.
app.on("will-quit", () => {
  closeSecureDatabase();
  closeLocalDatabase();
});

// Cross-platform window behavior
app.on("window-all-closed", () => {
  // On macOS, apps typically remain active until Cmd+Q
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // Re-create a window if the dock icon is clicked and no windows are open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// Global safety nets (don’t crash silently in prod).
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason);
});
