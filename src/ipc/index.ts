/**
 * IPC Module Index
 * Main entry point for IPC system setup
 */

import { ipcRegistry } from "./registry";
import { createAuthHandlers, createDataHandlers, createDatabaseHandlers, createHardwareHandlers, createDataImportHandlers, createSettingsHandlers, createImportsHandlers, createValidationHandlers, createAppHandlers, createExcelExportHandlers, createTemplateExportHandlers, createProteaReportPackHandlers, createProteaBudgetPackHandlers, createBSTExtractHandlers, createWindowHandlers } from "./handlers";
import {
  loggingMiddleware,
  errorHandlingMiddleware,
  performanceMiddleware,
  securityMiddleware,
  senderValidationMiddleware
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

  // Register database handlers
  const dbHandlers = createDatabaseHandlers();
  Object.entries(dbHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register hardware handlers
  const hardwareHandlers = createHardwareHandlers();
  Object.entries(hardwareHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Data Import handlers
  const dataImportHandlers = createDataImportHandlers();
  Object.entries(dataImportHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Settings handlers
  const settingsHandlers = createSettingsHandlers();
  Object.entries(settingsHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Imports handlers
  const importsHandlers = createImportsHandlers();
  Object.entries(importsHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Validation handlers
  const validationHandlers = createValidationHandlers();
  Object.entries(validationHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register App handlers
  const appHandlers = createAppHandlers();
  Object.entries(appHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Excel Export handlers
  const excelExportHandlers = createExcelExportHandlers();
  Object.entries(excelExportHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Template Export handlers
  const templateExportHandlers = createTemplateExportHandlers();
  Object.entries(templateExportHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Protea Report Pack handlers
  const proteaReportPackHandlers = createProteaReportPackHandlers();
  Object.entries(proteaReportPackHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Protea Budget Pack handlers
  const proteaBudgetPackHandlers = createProteaBudgetPackHandlers();
  Object.entries(proteaBudgetPackHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register BST Extract handlers
  const bstExtractHandlers = createBSTExtractHandlers();
  Object.entries(bstExtractHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Window handlers (UI scaling / zoom)
  const windowHandlers = createWindowHandlers();
  Object.entries(windowHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Initialize the registry (sets up the main IPC listener)
  ipcRegistry.initialize();

  if (logger) {
    logger.info("IPC system initialized with modular handlers and middleware");
    logger.debug("Registered channels:", ipcRegistry.getRegisteredChannels());
  }
}

// Export the registry instance for advanced usage
export { ipcRegistry };