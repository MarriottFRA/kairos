/**
 * App IPC Handlers
 * Handles app-level operations like version checks and updates
 */

import { autoUpdater, net, shell } from 'electron';
import { BrowserWindow, app } from 'electron';
import type { IpcHandler } from '../types';
import { SWA_ORIGIN } from '../../config';
import {
  isSecureDatabaseUnlocked,
  rebuildSecureSchema,
  revealSecureDbKeyForDev,
} from '../../secure_db';
import { rebuildLocalSchema } from '../../local_db';

// Use app.isPackaged to properly detect production vs development
// app.isPackaged is true when running from a built/installed app
// app.isPackaged is false when running with npm start
const isDev = !app.isPackaged;

// Store the latest release info when update is available
let latestReleaseInfo: { version: string; releaseNotes: string } | null = null;

// Electron's Windows autoUpdater emits "Update URL is not set" if
// checkForUpdates() runs before setFeedURL(). main.ts flips this once
// update-electron-app has configured the feed, so the renderer's manual check
// can never race ahead of it.
let autoUpdaterReady = false;

/** Called by main.ts right after update-electron-app has set the feed URL. */
export function markAutoUpdaterReady(): void {
  autoUpdaterReady = true;
}

/**
 * Fetch latest release info from GitHub
 */
async function fetchLatestRelease(): Promise<{ version: string; releaseNotes: string } | null> {
  try {
    // Use Electron's net.fetch (Chromium stack) so this honours the system
    // certificate store / proxy — same reasoning as the auth transport. Node's
    // https module would reject a corporate SSL-inspection cert.
    const response = await net.fetch(
      'https://api.github.com/repos/MarriottFRA/kairos/releases/latest',
      {
        method: 'GET',
        headers: { 'User-Agent': 'Kairos-Update-Checker' },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      // console.log('[AppHandlers] Failed to fetch release info:', response.status);
      return null;
    }

    const release = await response.json();
    return {
      version: release.tag_name?.replace(/^v/, '') || release.name || 'Unknown',
      releaseNotes: release.body || '',
    };
  } catch (err) {
    console.error('[AppHandlers] Error fetching release info:', err);
    return null;
  }
}

/**
 * Create app-related IPC handlers
 */
export function createAppHandlers(): Record<string, IpcHandler> {
  const handlers: Record<string, IpcHandler> = {
    'app:get-version': async () => {
      return { version: app.getVersion() };
    },

    // Open a portal link in the user's default browser. main.ts already routes
    // window.open() to shell.openExternal, but the sandboxed renderer gets a
    // null handle either way and so cannot tell success from failure — this
    // channel throws, which lets the UI fall back to its copy-link affordance.
    // Deliberately allowlisted to the SWA origin so it never degrades into a
    // generic "open whatever the renderer asks for" primitive.
    'app:open-external': async (_event, rawUrl) => {
      let url: URL;
      try {
        url = new URL(String(rawUrl));
      } catch {
        throw new Error('Not a valid URL');
      }
      if (url.origin !== new URL(SWA_ORIGIN).origin) {
        throw new Error(`Refusing to open non-portal URL: ${url.origin}`);
      }
      await shell.openExternal(url.toString());
      return { success: true };
    },

    'app:check-for-updates': async () => {
      // console.log('[AppHandlers] Checking for updates...');
      // console.log('[AppHandlers] Current version:', app.getVersion());
      // console.log('[AppHandlers] isDev:', isDev);
      if (isDev) {
        // console.log('[AppHandlers] DEV MODE: Auto-updater only works in packed builds');
        // console.log('[AppHandlers] To test updates, run: npm run package');
        return {
          updateAvailable: false,
          currentVersion: app.getVersion(),
          latestVersion: app.getVersion(),
          devMode: true,
          message: 'Update checks only work in production builds'
        };
      }

      // Defensive: if the feed URL isn't configured yet, calling
      // checkForUpdates() would emit "Update URL is not set" and paint the
      // error screen. update-electron-app's own startup check covers this
      // launch anyway, so just report "nothing to do" and let the renderer
      // continue into the app.
      if (!autoUpdaterReady) {
        return {
          updateAvailable: false,
          currentVersion: app.getVersion(),
          latestVersion: app.getVersion(),
          devMode: false,
          checking: false,
        };
      }

      try {
        // Trigger manual update check
        // Note: update-electron-app already handles automatic checks
        // This is for manual user-initiated checks
        autoUpdater.checkForUpdates();

        // console.log('[AppHandlers] Update check initiated');
        // Events will be triggered automatically, so just acknowledge the request
        return {
          updateAvailable: false, // Will be updated via events
          currentVersion: app.getVersion(),
          latestVersion: app.getVersion(),
          devMode: false,
          checking: true
        };
      } catch (error: any) {
        console.error('[AppHandlers] Update check failed:', error.message);
        throw error;
      }
    },

    'app:download-update': async () => {
      if (isDev) {
        // console.log('[AppHandlers] DEV MODE: Skipping download');
        return { success: true, devMode: true };
      }
      // console.log('[AppHandlers] Download is handled automatically by update-electron-app');
      // update-electron-app handles downloads automatically
      return { success: true, message: 'Download handled automatically' };
    },

    'app:install-update': async () => {
      if (isDev) {
        // console.log('[AppHandlers] DEV MODE: Skipping install');
        return { success: true, devMode: true };
      }
      // console.log('[AppHandlers] Installing update and restarting...');
      // For Squirrel.Windows, quitAndInstall() with no parameters is correct
      autoUpdater.quitAndInstall();
      return { success: true };
    },

    // DESTRUCTIVE escape hatch: drop and recreate every feature table in both
    // stores from the current schema baseline. For a database whose schema has
    // drifted from the code (e.g. a store stamped past a migration whose body
    // was later finalised) — the app's own IF NOT EXISTS startup DDL cannot add
    // a missing column, so this rebuild is the fix. Wipes ALL positions, PII,
    // component values, buyouts, manual input, cached outputs (encrypted store)
    // and every scenario, definition, calendar, mapping, budget import, KPI
    // driver, block and hotel cluster (plaintext store). Preserves the session,
    // device identity, and app settings. The UI gates this behind an explicit,
    // data-loss-warned confirmation and reloads afterwards.
    'app:rebuild-database': async () => {
      // The encrypted store must be unlocked to be rebuilt (a rebuild needs the
      // live key); this is only reachable from Settings while signed in.
      if (!isSecureDatabaseUnlocked()) {
        throw new Error(
          'Sign in before rebuilding — the encrypted store is locked.'
        );
      }
      rebuildSecureSchema();
      rebuildLocalSchema();
      return { success: true };
    },
  };

  // DEV ONLY: reveal the derived secure-DB key so a signed-in developer can open
  // kairos_secure.db in an external SQLite tool. The channel is not registered at
  // all in a packaged build, so production ships no key-reveal path over IPC; the
  // reveal helper itself is double-guarded on app.isPackaged regardless. Surfaced
  // behind a buried, dev-only control in Settings — it reuses the live session's
  // key with no re-auth, and returns nothing unless the secure DB is unlocked.
  if (isDev) {
    handlers['app:dev-secure-db-key'] = async () => revealSecureDbKeyForDev();
  }

  return handlers;
}

/**
 * Setup auto-updater event forwarding to renderer
 * Call this from main.ts after window is created
 *
 * Note: Electron's native autoUpdater (used by update-electron-app)
 * provides simpler events than electron-updater. Some events may not
 * include detailed information like version or progress.
 */
export function setupAutoUpdaterEvents(mainWindow: BrowserWindow | null): void {
  if (!mainWindow) return;

  // Note: Native autoUpdater doesn't provide version info in the event
  // We'll fetch it from GitHub when needed
  autoUpdater.on('update-available', async () => {
    // console.log('[AutoUpdater] Update available event received');
    // Fetch release info from GitHub
    const releaseInfo = await fetchLatestRelease();

    if (releaseInfo) {
      latestReleaseInfo = releaseInfo;
      // console.log('[AutoUpdater] Fetched release info:', releaseInfo);
      mainWindow.webContents.send('update-available', releaseInfo);
    } else {
      // console.log('[AutoUpdater] Could not fetch release info, using fallback');
      mainWindow.webContents.send('update-available', {
        version: 'Latest version',
        releaseNotes: '',
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    // console.log('[AutoUpdater] No update available');
    latestReleaseInfo = null;
    mainWindow.webContents.send('update-not-available');
  });

  // Note: Native autoUpdater doesn't emit download-progress events
  // The download happens automatically and silently

  autoUpdater.on('update-downloaded', () => {
    // console.log('[AutoUpdater] Update downloaded and ready to install');
    mainWindow.webContents.send('update-downloaded');
  });

  autoUpdater.on('error', (error) => {
    console.error('[AutoUpdater] Error:', error);
    latestReleaseInfo = null;
    const errorMessage = error instanceof Error ? error.message : 'Update failed';
    mainWindow.webContents.send('update-error', errorMessage);
  });
}
