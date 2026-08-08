/**
 * IPC Module Index
 * Main entry point for IPC system setup
 */

import { ipcRegistry } from "./registry";
import { createAuthHandlers, createCalendarHandlers, createDataHandlers, createMappingTablesHandlers, createSettingsHandlers, createAppHandlers, createWindowHandlers, createPositionsHandlers, createPositionDefaultsHandlers, createBudgetImportHandlers, createBstPushHandlers, createLegacyImportHandlers, createOracleImportHandlers, createKpiDriversHandlers, createManualInputHandlers, createBlocksHandlers, createHotelClustersHandlers, createSocialSecurityHandlers, createAllocationsHandlers, createMaintenanceHandlers, createKairosSyncHandlers } from "./handlers";
import { createAuthDebugHandlers } from "./handlers/authDebug"; // [AUTH-DEBUG]
import { KAIROS_SYNC_CHANNELS } from "../shared/kairosSync/ipc";
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
  const { authController, apiClient, sendToRenderer, logger, devServerUrl } = deps;

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

  // [AUTH-DEBUG] Register temporary sign-in tracing handlers (arm/disarm only —
  // the tracing itself lives in main/auth/authDebug.ts and is off by default).
  const authDebugHandlers = createAuthDebugHandlers(sendToRenderer);
  Object.entries(authDebugHandlers).forEach(([channel, handler]) => {
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

  // Register Maintenance handlers (storage cleanup: purge soft-deleted rows
  // from both stores). Deliberately NOT OU-gated — cleanup spans every hotel
  // by definition; the secure-DB session lock is the gate instead.
  const maintenanceHandlers = createMaintenanceHandlers();
  Object.entries(maintenanceHandlers).forEach(([channel, handler]) => {
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

  // Register Budget-import handlers (pull a hotel's Excel budget file into the
  // plaintext local store). OU-gated — a pull can only land in its own hotel.
  const budgetImportHandlers = createBudgetImportHandlers();
  Object.entries(budgetImportHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register BST-push handlers (recalculate, then write the Results rows back
  // into the hotel's Excel BST). OU-gated, and the handlers additionally refuse
  // any file whose own OU or budget year disagrees with the selection.
  const bstPushHandlers = createBstPushHandlers();
  Object.entries(bstPushHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register legacy-Excel import handlers (one-shot migration off the old
  // Payroll Budget Tool workbook). OU-gated: an import can only ever land in
  // the selected hotel, and only in a plan that has no positions yet.
  const legacyImportHandlers = createLegacyImportHandlers();
  Object.entries(legacyImportHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register Oracle-report import handlers (append the associates an Oracle HR
  // export lists to the selected plan — the port of Add_New_Rows_Oracle).
  // OU-gated like the rest. Unlike the legacy import this one runs into a plan
  // that already has positions: its guard is the employee number, not emptiness.
  const oracleImportHandlers = createOracleImportHandlers();
  Object.entries(oracleImportHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register KPI-driver handlers (define/persist/precompute reusable budget
  // aggregates in the plaintext local store). OU-gated like budget import.
  const kpiDriversHandlers = createKpiDriversHandlers();
  Object.entries(kpiDriversHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register Manual-input handlers (hand-entered cost lines in the encrypted
  // secure store). OU-gated; the secure DB must be unlocked (post sign-in).
  const manualInputHandlers = createManualInputHandlers();
  Object.entries(manualInputHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register Blocks handlers (user-facing block configs that compile into
  // cost-component definitions, plaintext local store). OU-gated.
  const blocksHandlers = createBlocksHandlers();
  Object.entries(blocksHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register Social Security / NI scheme handlers (OU-scoped scheme configs in
  // the plaintext local store — brackets + caps the engine already runs). Same
  // OU-gate as blocks.
  const socialSecurityHandlers = createSocialSecurityHandlers();
  Object.entries(socialSecurityHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register Allocations handlers (per-hotel spread definitions in the plaintext
  // local store; the grid is computed on demand from the scenario's active
  // positions in the encrypted store). OU-gated like blocks.
  const allocationsHandlers = createAllocationsHandlers();
  Object.entries(allocationsHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler, [ouGate]);
  });

  // Register Hotel-cluster handlers (cross-OU cluster reference data in the
  // plaintext store + the one explicit multi-scope membership read/clear).
  // Deliberately NOT OU-gated — a cluster spans hotels by definition; the
  // channels that touch positions are gated by the secure-DB session lock
  // (sign-in) instead. Global middleware (sender validation, security, error
  // handling) still applies.
  const hotelClustersHandlers = createHotelClustersHandlers();
  Object.entries(hotelClustersHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(channel, handler);
  });

  // Register Kairos server-sync handlers (publish/pull a plan, the OU structure
  // document, delegation, PII, BST and the artifacts). Everything plan-scoped is
  // OU-gated like the rest; the three cross-property reads below are not,
  // because they span hotels by definition — the same exception hotel clusters
  // already makes. Server-side authority is re-resolved on every request
  // regardless: the OU gate stops a request naming the wrong hotel, it does not
  // decide what the user may see.
  // The administration reads are estate-wide by definition — "every plan with an
  // ineligible owner" and "who exported what" name no hotel and cannot be gated
  // on one. They are gated instead where it counts: the server refuses them to
  // anyone who is not an administrator, which is also how the client finds out
  // whether it should render the surface at all.
  const CROSS_OU_SYNC_CHANNELS = new Set<string>([
    KAIROS_SYNC_CHANNELS.myDelegations,
    KAIROS_SYNC_CHANNELS.clusters,
    KAIROS_SYNC_CHANNELS.clusterDivergence,
    KAIROS_SYNC_CHANNELS.adminProbe,
    KAIROS_SYNC_CHANNELS.adminHotels,
    KAIROS_SYNC_CHANNELS.adminPlans,
    KAIROS_SYNC_CHANNELS.adminAudit,
    KAIROS_SYNC_CHANNELS.adminDownloads,
    KAIROS_SYNC_CHANNELS.adminUserScope,
    KAIROS_SYNC_CHANNELS.adminBundle,
  ]);
  const kairosSyncHandlers = createKairosSyncHandlers(apiClient);
  Object.entries(kairosSyncHandlers).forEach(([channel, handler]) => {
    ipcRegistry.register(
      channel,
      handler,
      CROSS_OU_SYNC_CHANNELS.has(channel) ? [] : [ouGate]
    );
  });

  // Initialize the registry (sets up the main IPC listener)
  ipcRegistry.initialize();

  if (logger) {
    logger.info("IPC system initialized with modular handlers and middleware");
    logger.debug("Registered channels:", ipcRegistry.getRegisteredChannels());
  }
}

// `ipcRegistry` is already re-exported by `export * from "./registry"` above.