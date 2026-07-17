/**
 * App IPC Handlers
 * Handles app-level operations like version checks and updates
 */

import { autoUpdater, net } from 'electron';
import { BrowserWindow, app } from 'electron';
import type { IpcHandler } from '../types';

// Use app.isPackaged to properly detect production vs development
// app.isPackaged is true when running from a built/installed app
// app.isPackaged is false when running with npm start
const isDev = !app.isPackaged;

// Store the latest release info when update is available
let latestReleaseInfo: { version: string; releaseNotes: string } | null = null;

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
  return {
    'app:get-version': async () => {
      return { version: app.getVersion() };
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
  };
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
