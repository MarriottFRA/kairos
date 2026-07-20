// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from "electron";

// ────────────────────────────────────────────────────────────
// Channel allowlist for the generic domain dispatch (`sendIpcRequest`).
// The renderer may only reach these explicitly-approved channel families.
// Auth is NOT here — it is exposed as the separate, typed `authApi` surface.
// Business API calls go through the single allowlisted `data:fetch` channel.
// ────────────────────────────────────────────────────────────
const ALLOWED_CHANNEL_PREFIXES = [
  "calendar:",
  "data:fetch",
  "settings-",
  "settings:",
  "app:",
  "window:",
] as const;

// Legacy channel names still used by some renderer call sites → canonical names.
const LEGACY_CHANNEL_MAP: Record<string, string> = {};

function resolveChannel(request: string): string {
  const channel = LEGACY_CHANNEL_MAP[request] || request;
  const allowed = ALLOWED_CHANNEL_PREFIXES.some((prefix) =>
    prefix.endsWith(":") || prefix.endsWith("-")
      ? channel.startsWith(prefix)
      : channel === prefix
  );
  if (!allowed) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
  return channel;
}

/** Unwrap the { success, data } envelope or throw on failure. */
async function invokeUnwrapped(channel: string, ...args: unknown[]): Promise<unknown> {
  const result = await ipcRenderer.invoke("ipcMain", channel, ...args);
  if (result && typeof result === "object" && "success" in result) {
    if (!(result as any).success) {
      throw new Error((result as any).error || "Unknown error occurred");
    }
    return (result as any).data;
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────
export interface PublicAuthStatus {
  securityLevel: number;
  isActive: boolean;
  deviceId: string | null;
  devicePending: boolean;
  encryptionAvailable: boolean;
  lastUserEmail: string | null;
  tpmBound: boolean;
}

/**
 * Real per-step progress for the device security screen, pushed by main as each
 * step of the verify/register flow starts and finishes. `skipped` is a normal
 * outcome, not an error — machines with no TPM legitimately skip those steps.
 */
export interface DeviceProgressEvent {
  phase: "verify" | "register";
  step: string;
  state: "active" | "done" | "skipped" | "failed";
  detail?: string;
}

export interface IpcApi {
  sendIpcRequest: (request: string, ...args: unknown[]) => Promise<unknown>;
  // Auto-updater events (main -> renderer)
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
}

export interface AuthApi {
  beginMicrosoftSignIn: (p?: { silent?: boolean }) => Promise<{ email: string }>;
  microsoftSignOut: () => Promise<{ success: true }>;
  register: (p: { email: string }) => Promise<unknown>;
  login: (p: { email: string }) => Promise<{ settings: unknown }>;
  registerDevice: () => Promise<{ status: string; deviceId: string }>;
  verifyDevice: (p?: { phase?: "verify" | "register" }) => Promise<{
    deviceId: string;
    securityLevel: number;
  }>;
  logout: () => Promise<{ success: true }>;
  getStatus: () => Promise<PublicAuthStatus>;
  resume: () => Promise<PublicAuthStatus>;
  hasResumableSession: () => Promise<boolean>;
  onAuthStatusChanged: (cb: (status: PublicAuthStatus) => void) => void;
  offAuthStatusChanged: (cb: (status: PublicAuthStatus) => void) => void;
  onSessionExpired: (cb: () => void) => void;
  offSessionExpired: (cb: () => void) => void;
  onDeviceProgress: (cb: (event: DeviceProgressEvent) => void) => void;
  offDeviceProgress: (cb: (event: DeviceProgressEvent) => void) => void;
}

// ────────────────────────────────────────────────────────────
// Renderer <- Main event bridging. We keep a map from the caller's callback to
// the wrapped ipcRenderer listener so off* can remove the correct listener.
// ────────────────────────────────────────────────────────────
const statusListeners = new WeakMap<
  (status: PublicAuthStatus) => void,
  (event: any, status: PublicAuthStatus) => void
>();
const expiredListeners = new WeakMap<() => void, (event: any) => void>();
const progressListeners = new WeakMap<
  (event: DeviceProgressEvent) => void,
  (event: any, payload: DeviceProgressEvent) => void
>();

// ────────────────────────────────────────────────────────────
// Expose the generic domain dispatch (business/data/db/settings/...).
// ────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld("ipcApi", {
  sendIpcRequest: async (request: string, ...args: unknown[]): Promise<unknown> => {
    const channel = resolveChannel(request);
    const result = await ipcRenderer.invoke("ipcMain", channel, ...args);
    // Preserve the existing contract: callers receive the full envelope object.
    if (result && typeof result === "object" && "success" in result) {
      if (!(result as any).success) {
        throw new Error((result as any).error || "Unknown error occurred");
      }
      return result;
    }
    return result;
  },
  onUpdateAvailable: (callback: (event: any, info: any) => void) =>
    ipcRenderer.on("update-available", callback),
  onUpdateNotAvailable: (callback: () => void) =>
    ipcRenderer.on("update-not-available", callback),
  onDownloadProgress: (callback: (event: any, progress: any) => void) =>
    ipcRenderer.on("download-progress", callback),
  onUpdateDownloaded: (callback: () => void) =>
    ipcRenderer.on("update-downloaded", callback),
  onUpdateError: (callback: (event: any, error: string) => void) =>
    ipcRenderer.on("update-error", callback),
  offUpdateAvailable: (callback: (event: any, info: any) => void) =>
    ipcRenderer.off("update-available", callback),
  offUpdateNotAvailable: (callback: () => void) =>
    ipcRenderer.off("update-not-available", callback),
  offDownloadProgress: (callback: (event: any, progress: any) => void) =>
    ipcRenderer.off("download-progress", callback),
  offUpdateDownloaded: (callback: () => void) =>
    ipcRenderer.off("update-downloaded", callback),
  offUpdateError: (callback: (event: any, error: string) => void) =>
    ipcRenderer.off("update-error", callback),
});

// ────────────────────────────────────────────────────────────
// Expose the narrow, typed auth domain surface. No tokens ever cross this
// bridge — only opaque success/failure of named domain actions plus status.
// ────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld("authApi", {
  beginMicrosoftSignIn: (p?: { silent?: boolean }) =>
    invokeUnwrapped("auth:beginMicrosoftSignIn", p),
  microsoftSignOut: () => invokeUnwrapped("auth:microsoftSignOut"),
  register: (p: { email: string }) => invokeUnwrapped("auth:register", p),
  login: (p: { email: string }) => invokeUnwrapped("auth:login", p),
  registerDevice: () => invokeUnwrapped("auth:registerDevice"),
  verifyDevice: (p?: { phase?: "verify" | "register" }) =>
    invokeUnwrapped("auth:verifyDevice", p),
  logout: () => invokeUnwrapped("auth:logout"),
  getStatus: () => invokeUnwrapped("auth:getStatus"),
  resume: () => invokeUnwrapped("auth:resume"),
  hasResumableSession: () => invokeUnwrapped("auth:hasResumableSession"),

  onAuthStatusChanged: (cb: (status: PublicAuthStatus) => void) => {
    const wrapped = (_event: any, status: PublicAuthStatus) => cb(status);
    statusListeners.set(cb, wrapped);
    ipcRenderer.on("auth:status-changed", wrapped);
  },
  offAuthStatusChanged: (cb: (status: PublicAuthStatus) => void) => {
    const wrapped = statusListeners.get(cb);
    if (wrapped) {
      ipcRenderer.off("auth:status-changed", wrapped);
      statusListeners.delete(cb);
    }
  },
  onSessionExpired: (cb: () => void) => {
    const wrapped = (_event: any) => cb();
    expiredListeners.set(cb, wrapped);
    ipcRenderer.on("auth:session-expired", wrapped);
  },
  offSessionExpired: (cb: () => void) => {
    const wrapped = expiredListeners.get(cb);
    if (wrapped) {
      ipcRenderer.off("auth:session-expired", wrapped);
      expiredListeners.delete(cb);
    }
  },
  onDeviceProgress: (cb: (event: DeviceProgressEvent) => void) => {
    const wrapped = (_event: any, payload: DeviceProgressEvent) => cb(payload);
    progressListeners.set(cb, wrapped);
    ipcRenderer.on("auth:device-progress", wrapped);
  },
  offDeviceProgress: (cb: (event: DeviceProgressEvent) => void) => {
    const wrapped = progressListeners.get(cb);
    if (wrapped) {
      ipcRenderer.off("auth:device-progress", wrapped);
      progressListeners.delete(cb);
    }
  },
});
