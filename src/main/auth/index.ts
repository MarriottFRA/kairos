/**
 * Auth stack factory.
 * -----------------------------------------------------------
 * Constructs and wires the main-process auth modules in dependency order and
 * returns the two objects the IPC layer needs: the AuthController (auth domain
 * actions) and the ApiClient (authenticated transport for business data).
 *
 * Call once after app `ready` and after the local DB is initialised.
 */

import { BrowserWindow } from "electron";
import { SecureStore } from "./secureStore";
import { DeviceIdentity } from "./deviceIdentity";
import { SessionManager } from "./sessionManager";
import { ApiClient } from "./apiClient";
import { AuthController } from "./authController";
import { MsBroker } from "./msBroker";

export interface AuthStack {
  authController: AuthController;
  apiClient: ApiClient;
}

export async function createAuthStack(options: {
  baseUrl: string;
  swaOrigin: string;
  getMainWindow: () => BrowserWindow | null;
  sendToRenderer: (channel: string, payload?: unknown) => void;
}): Promise<AuthStack> {
  const secureStore = new SecureStore();
  const deviceIdentity = new DeviceIdentity();
  const sessionManager = new SessionManager({
    secureStore,
    deviceIdentity,
    baseUrl: options.baseUrl,
  });
  const apiClient = new ApiClient({ sessionManager, baseUrl: options.baseUrl });
  const msBroker = new MsBroker({
    swaOrigin: options.swaOrigin,
    getMainWindow: options.getMainWindow,
  });
  const authController = new AuthController({
    sessionManager,
    deviceIdentity,
    secureStore,
    apiClient,
    msBroker,
    sendToRenderer: options.sendToRenderer,
  });

  await authController.init(); // wire status callbacks + preload device id

  return { authController, apiClient };
}

export { AuthController } from "./authController";
export { ApiClient } from "./apiClient";
export type { PublicAuthStatus } from "./authController";
