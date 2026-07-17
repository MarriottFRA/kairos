/**
 * IPC Types and Interfaces
 * Central type definitions for all IPC communication
 */

import { IpcMainInvokeEvent } from "electron";

// Base handler function type
export type IpcHandler<TRequest = any, TResponse = any> = (
  event: IpcMainInvokeEvent,
  request: TRequest
) => Promise<TResponse> | TResponse;

// Middleware function type
export type IpcMiddleware = (
  event: IpcMainInvokeEvent,
  channel: string,
  args: any[],
  next: () => Promise<any>
) => Promise<any>;

// Handler registration interface
export interface IpcHandlerRegistration {
  channel: string;
  handler: IpcHandler;
  middleware?: IpcMiddleware[];
}

// Result wrapper for consistent error handling
export interface IpcResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp?: number;
}

// Request/Response types for different domains
export namespace AuthTypes {
  export interface LoginRequest {
    // Add any login parameters if needed
  }
  
  export interface LoginResponse extends IpcResult {
    data?: { success: boolean };
  }
  
  export interface CheckResponse extends IpcResult {
    data?: {
      isAuthenticated: boolean;
      user: any;
    };
  }
}

export namespace DatabaseTypes {
  export interface GetPeriodsRequest {
    // Add parameters as needed
  }
  
  export interface UpdatePeriodsRequest {
    periods: any; // Define proper period type
  }
  
  export interface CreateAccountRequest {
    name: string;
    type: string;
    // Add other account fields
  }
  
  export interface Account {
    id: string;
    name: string;
    type: string;
    // Add other fields
  }
}

// Channel constants to avoid magic strings
export const IPC_CHANNELS = {
  // Auth channels
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_CHECK: 'auth:check',
  
  // Database channels
  DB_GET_PERIODS: 'db:get-periods',
  DB_UPDATE_PERIODS: 'db:update-periods',
  DB_GET_ACCOUNTS: 'db:get-accounts',
  DB_CREATE_ACCOUNT: 'db:create-account',
  DB_GET_DEPARTMENTS: 'db:get-departments',
  DB_CREATE_DEPARTMENT: 'db:create-department',
  DB_GET_COMBO_METADATA: 'db:get-combo-metadata',
  DB_CREATE_COMBO: 'db:create-combo',
  DB_GENERATE_DUMMY_DATA: 'db:generate-dummy-data',

  // Hotels cache channels
  DB_GET_CACHED_HOTELS: 'db:get-cached-hotels',
  DB_CACHE_HOTELS: 'db:cache-hotels',
  DB_CLEAR_HOTELS_CACHE: 'db:clear-hotels-cache',
  DB_IS_HOTELS_CACHE_EXPIRED: 'db:is-hotels-cache-expired',

  // Mapping config channels
  DB_STORE_MAPPING_CONFIG: 'db:store-mapping-config',
  DB_GET_MAPPING_CONFIG: 'db:get-mapping-config',
  DB_GET_ALL_MAPPING_CONFIGS: 'db:get-all-mapping-configs',
  DB_UPDATE_MAPPING_CONFIG_SYNC_TIME: 'db:update-mapping-config-sync-time',

  // Mapping channels
  DB_REPLACE_MAPPINGS: 'db:replace-mappings',
  DB_GET_MAPPINGS: 'db:get-mappings',
  DB_GET_MAPPING_COUNT: 'db:get-mapping-count',
  DB_FIND_MAPPING: 'db:find-mapping',
  DB_GET_MAPPINGS_BY_APPROVAL_STATUS: 'db:get-mappings-by-approval-status',
  DB_UPDATE_MAPPING_APPROVAL_STATUS: 'db:update-mapping-approval-status',
  DB_UPDATE_MAPPING: 'db:update-mapping',

  // Import group channels
  DB_STORE_IMPORT_GROUPS: 'db:store-import-groups',
  DB_GET_IMPORT_GROUPS: 'db:get-import-groups',
  DB_GET_MAPPING_CONFIG_IDS_FOR_OU: 'db:get-mapping-config-ids-for-ou',
  DB_HAS_IMPORT_GROUPS_CACHED: 'db:has-import-groups-cached',

  // Import session channels
  DB_CREATE_IMPORT_SESSION: 'db:create-import-session',
  DB_UPDATE_IMPORT_SESSION_STATUS: 'db:update-import-session-status',
  DB_GET_LATEST_IMPORT_SESSION: 'db:get-latest-import-session',
  DB_GET_IMPORT_SESSION: 'db:get-import-session',
  DB_GET_IMPORT_SESSIONS: 'db:get-import-sessions',

  // Staging table channels
  DB_CLEAR_STAGING_TABLE: 'db:clear-staging-table',
  DB_AUTO_CLEAN_STAGING: 'db:auto-clean-staging',
  DB_GET_STAGING_DATA: 'db:get-staging-data',
  DB_ADD_STAGING_ROW: 'db:add-staging-row',
  DB_UPDATE_STAGING_ROW: 'db:update-staging-row',
  DB_DELETE_STAGING_ROW: 'db:delete-staging-row',
  DB_CHECK_IMPORTS_EXIST: 'db:check-imports-exist',
  DB_GET_UNIQUE_ACCOUNTS: 'db:get-unique-accounts',
  DB_GET_UNIQUE_DEPARTMENTS: 'db:get-unique-departments',
  DB_GET_DEPARTMENTS_FOR_ACCOUNT: 'db:get-departments-for-account',
  DB_GET_ACCOUNTS_FOR_DEPARTMENT: 'db:get-accounts-for-department',

  // Mapping tables channels
  DB_GET_MAPPING_TABLES_VERSION: 'db:get-mapping-tables-version',
  DB_SET_MAPPING_TABLES_VERSION: 'db:set-mapping-tables-version',
  DB_STORE_ACCOUNT_MAPS: 'db:store-account-maps',
  DB_STORE_DEPARTMENT_MAPS: 'db:store-department-maps',
  DB_STORE_COMBOS: 'db:store-combos',
  DB_GET_ACCOUNT_MAPS: 'db:get-account-maps',
  DB_GET_DEPARTMENT_MAPS: 'db:get-department-maps',
  DB_GET_COMBOS: 'db:get-combos',
  DB_IS_VALID_COMBO: 'db:is-valid-combo',
  DB_GET_ACCOUNT_MAP: 'db:get-account-map',
  DB_GET_DEPARTMENT_MAP: 'db:get-department-map',

  // Financial data import channels
  DB_STORE_FINANCIAL_DATA: 'db:store-financial-data',
  DB_STORE_FINANCIAL_DATA_FOR_PERIODS: 'db:store-financial-data-for-periods',
  DB_DELETE_SYNCED_FINANCIAL_DATA_FOR_PERIODS: 'db:delete-synced-financial-data-for-periods',
  DB_GET_FINANCIAL_DATA_COUNT: 'db:get-financial-data-count',
  DB_GET_FINANCIAL_DATA_LAST_IMPORT: 'db:get-financial-data-last-import',
  DB_GET_FINANCIAL_DATA_LOCAL_VERSIONS: 'db:get-financial-data-local-versions',
  DB_GET_FINANCIAL_REPORT_DATA: 'db:get-financial-report-data',
  DB_GET_SUMMARY_PL_DATA: 'db:get-summary-pl-data',
  DB_GET_F90_PL_DATA: 'db:get-f90-pl-data',
  DB_GET_PROTEA_F90_PL_DATA: 'db:get-protea-f90-pl-data',
  DB_GET_STAGING_VS_BUDGET_DATA: 'db:get-staging-vs-budget-data',

  // Cache metadata channels
  DB_UPDATE_CACHE_METADATA: 'db:update-cache-metadata',
  DB_GET_CACHE_METADATA: 'db:get-cache-metadata',
  DB_SHOULD_REFRESH_CACHE: 'db:should-refresh-cache',

  // Validation channels
  DB_STORE_VALIDATIONS: 'db:store-validations',
  DB_GET_VALIDATIONS: 'db:get-validations',
  VALIDATION_RUN: 'validation:run',

  // Import completion state channels
  DB_GET_IMPORT_COMPLETED_STATE: 'db:get-import-completed-state',
  DB_SET_IMPORT_COMPLETED_STATE: 'db:set-import-completed-state',

  // Validation completion state channels
  DB_GET_VALIDATION_COMPLETED_STATE: 'db:get-validation-completed-state',
  DB_SET_VALIDATION_COMPLETED_STATE: 'db:set-validation-completed-state',

  // Sign-off completion state channels
  DB_GET_SIGNOFF_COMPLETED_STATE: 'db:get-signoff-completed-state',
  DB_SET_SIGNOFF_COMPLETED_STATE: 'db:set-signoff-completed-state',

  // Selected period per OU channels
  DB_GET_SELECTED_PERIOD_FOR_OU: 'db:get-selected-period-for-ou',
  DB_SET_SELECTED_PERIOD_FOR_OU: 'db:set-selected-period-for-ou',

  // Reset all completion states
  DB_RESET_ALL_COMPLETION_STATES: 'db:reset-all-completion-states',
  DB_RESET_ALL_COMPLETION_STATES_ALL_OUS: 'db:reset-all-completion-states-all-ous',

  // Manual adjustments channel
  DB_INSERT_MANUAL_ADJUSTMENTS: 'db:insert-manual-adjustments',

  // Financial data daily sync check channels
  DB_GET_FINANCIAL_DATA_LAST_CHECK_DATE: 'db:get-financial-data-last-check-date',
  DB_GET_FINANCIAL_DATA_LAST_CHECK_TIMESTAMP: 'db:get-financial-data-last-check-timestamp',
  DB_SET_FINANCIAL_DATA_SYNC_CHECK: 'db:set-financial-data-sync-check',

  // Excel export channels
  EXCEL_GENERATE_REPORT: 'excel:generate-report',
  EXCEL_GET_DEPARTMENTS_FOR_OU: 'excel:get-departments-for-ou',

  // Protea Report Pack channels
  PROTEA_GENERATE_REPORT: 'protea:generate-report',
  PROTEA_GET_DEPARTMENTS_FOR_OU: 'protea:get-departments-for-ou',
} as const;

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];