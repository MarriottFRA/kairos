/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/application-architecture#main-and-renderer-processes
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.ts` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

// IPC communication. The full typed shapes live in src/preload.ts (IpcApi /
// AuthApi); we expose a permissive `sendIpcRequest` here for the many legacy
// call sites while the auth surface is strongly typed via window.authApi.
declare global {
  interface Window {
    ipcApi: {
      sendIpcRequest: (request: string, ...args: unknown[]) => Promise<any>;
      onUpdateAvailable?: (callback: (event: any, info: any) => void) => void;
      onUpdateNotAvailable?: (callback: () => void) => void;
      onDownloadProgress?: (callback: (event: any, progress: any) => void) => void;
      onUpdateDownloaded?: (callback: () => void) => void;
      onUpdateError?: (callback: (event: any, error: string) => void) => void;
      offUpdateAvailable?: (callback: (event: any, info: any) => void) => void;
      offUpdateNotAvailable?: (callback: () => void) => void;
      offDownloadProgress?: (callback: (event: any, progress: any) => void) => void;
      offUpdateDownloaded?: (callback: () => void) => void;
      offUpdateError?: (callback: (event: any, error: string) => void) => void;
    };
  }
}

//Main app
import "./app";
