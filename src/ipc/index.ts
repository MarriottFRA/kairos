/**
 * IPC Module Index
 * Main entry point for IPC system setup
 */

import { ipcRegistry } from "./registry";
import { createAuthHandlers, createCalendarHandlers, createDataHandlers, createMappingTablesHandlers, createSettingsHandlers, createAppHandlers, createWindowHandlers, createPositionsHandlers, createPositionDefaultsHandlers } from "./handlers";
import {
  loggingMiddleware,
  errorHandlingMiddleware,
  performanceMiddleware,
  securityMiddleware,
  senderValidationMiddleware,
  ouScopeMiddleware
} from "./middleware";
import type { AuthController } from "../main/auth/authController";
import type { ApiClient } from "../main/auth/apiClient";

export * from "./types";
export * from "./registry";
export * from "./middleware";
export * from "./handlers";

/**
 * Initialize the IPC system with all handlers and middleware
 */
export function initializeIpc(deps: {
  authController: AuthController;
  apiClient: ApiClient;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  logger?: any;
  /** Vite dev-server origin (dev only); trusted alongside file:// senders. */
  devServerUrl?: string | null;
}) {
  const { authController, apiClient, logger, devServerUrl } = deps;

  // Set up global middleware. Sender validation runs first so untrusted frames
  // are rejected before any handler logic executes.
  ipcRegistry.use(senderValidationMiddleware([devServerUrl ?? ""].filter(Boolean)));
  ipcRegistry.use(securityMiddleware());
  ipcRegistry.use(errorHandlingMiddleware(logger));
  ipcRegistry.use(loggingMiddleware(logger));
  ipcRegistry.use(performanceMiddleware(1000)); // 1 second slow threshold

  // Register auth handlers (backed by the main-process AuthController)
  const authHandlers = createAuthHandlers(authController);
  Object.entries(authHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register business data handler (allowlisted authenticated transport)
  const dataHandlers = createDataHandlers(apiClient);
  Object.entries(dataHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register mapping-tables handlers (version-gated sync of the cached reference
  // tables into the plaintext local store; fetches through the same ApiClient).
  const mappingTablesHandlers = createMappingTablesHandlers(apiClient);
  Object.entries(mappingTablesHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Settings handlers
  const settingsHandlers = createSettingsHandlers();
  Object.entries(settingsHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Calendar handlers (budget/forecast calendar in the local store)
  const calendarHandlers = createCalendarHandlers();
  Object.entries(calendarHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Position safe-defaults handlers (seeds for new positions, local store)
  const positionDefaultsHandlers = createPositionDefaultsHandlers();
  Object.entries(positionDefaultsHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register App handlers
  const appHandlers = createAppHandlers();
  Object.entries(appHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Window handlers (UI scaling / zoom)
  const windowHandlers = createWindowHandlers();
  Object.entries(windowHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Positions handlers (positions grid: scenarios, field catalog,
  // encrypted position values + PII). Every channel is OU-gated.
  const positionsHandlers = createPositionsHandlers();
  const ouGate = ouScopeMiddleware();
  Object.entries(positionsHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Initialize the registry (sets up the main IPC listener)
  ipcRegistry.initialize();

  if (logger) {
    logger.info("IPC system initialized with modular handlers and middleware");
    logger.debug("Registered channels:", ipcRegistry.getRegisteredChannels());
  }
}

// `ipcRegistry` is already re-exported by `export * from "./registry"` above.