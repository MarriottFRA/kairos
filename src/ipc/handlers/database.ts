/**
 * Database IPC Handlers
 * Handles all database-related IPC requests
 */

import { IpcHandler } from "../types";
import { DatabaseTypes, IPC_CHANNELS } from "../types";
import * as db from "../../local_db";

export class DatabaseHandlers {
  getPeriodsHandler: IpcHandler = async (event, ...args) => {
    const result = await db.get12Periods(...args);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  updatePeriodsHandler: IpcHandler = async (event, ...args) => {
    const result = await db.update12Periods(...args);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  generateDummyDataHandler: IpcHandler = async (event, request) => {
    await db.GeneratedDummyData();
    return {
      success: true,
      data: { message: "Dummy data generated successfully" },
      timestamp: Date.now(),
    };
  };

  getAllAccountsHandler: IpcHandler = async (event, request) => {
    const result = await db.getAllAccounts();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getAllDepartmentsHandler: IpcHandler = async (event, request) => {
    const result = await db.getAllDepartments();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getAllComboMetadataHandler: IpcHandler = async (event, request) => {
    const result = await db.getAllComboMetadata();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  createAccountHandler: IpcHandler<DatabaseTypes.CreateAccountRequest> = async (event, request) => {
    const result = await db.createAccount(request);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  createDepartmentHandler: IpcHandler = async (event, request) => {
    const result = await db.createDepartment(request);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  createComboHandler: IpcHandler = async (event, request) => {
    const result = await db.createCombo(request);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Hotels cache handlers
  getCachedHotelsHandler: IpcHandler = async (event) => {
    const result = await db.getCachedHotels();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  cacheHotelsHandler: IpcHandler = async (event, hotels) => {
    const result = await db.cacheHotels(hotels);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  clearHotelsCacheHandler: IpcHandler = async (event) => {
    const result = await db.clearHotelsCache();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  isHotelsCacheExpiredHandler: IpcHandler = async (event, hoursThreshold) => {
    const result = await db.isHotelsCacheExpired(hoursThreshold);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Mapping config handlers
  storeMappingConfigHandler: IpcHandler = async (event, config) => {
    await db.storeMappingConfig(config);
    return {
      success: true,
      data: { message: "Mapping config stored successfully" },
      timestamp: Date.now(),
    };
  };

  getMappingConfigHandler: IpcHandler = async (event, request) => {
    const result = await db.getMappingConfig(request.config_id);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getAllMappingConfigsHandler: IpcHandler = async (event) => {
    const result = await db.getAllMappingConfigs();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  updateMappingConfigSyncTimeHandler: IpcHandler = async (event, request) => {
    await db.updateMappingConfigSyncTime(request.config_id);
    return {
      success: true,
      data: { message: "Sync time updated successfully" },
      timestamp: Date.now(),
    };
  };

  // Mapping handlers
  replaceMappingsHandler: IpcHandler = async (event, request) => {
    await db.replaceMappings(request.config_id, request.mappings);
    return {
      success: true,
      data: { message: `Replaced ${request.mappings.length} mappings successfully` },
      timestamp: Date.now(),
    };
  };

  getMappingsHandler: IpcHandler = async (event, request) => {
    const result = await db.getMappings(request.config_id);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getMappingCountHandler: IpcHandler = async (event, request) => {
    const result = await db.getMappingCount(request.config_id);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  findMappingHandler: IpcHandler = async (event, request) => {
    const result = await db.findMapping(
      request.config_id,
      request.source_account,
      request.source_department,
      request.include_unapproved || false
    );
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getMappingsByApprovalStatusHandler: IpcHandler = async (event, request) => {
    const result = await db.getMappingsByApprovalStatus(
      request.config_id || null,
      request.approval_status
    );
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  updateMappingApprovalStatusHandler: IpcHandler = async (event, request) => {
    await db.updateMappingApprovalStatus(
      request.mapping_id,
      request.approval_status,
      request.approved_by || null
    );
    return {
      success: true,
      data: { message: 'Mapping approval status updated successfully' },
      timestamp: Date.now(),
    };
  };

  updateMappingHandler: IpcHandler = async (event, request) => {
    const { mapping_id, ...updateData } = request;
    await db.updateMapping(mapping_id, updateData);
    return {
      success: true,
      data: { message: 'Mapping updated successfully' },
      timestamp: Date.now(),
    };
  };

  // Import group handlers
  storeImportGroupsHandler: IpcHandler = async (event, request) => {
    await db.storeImportGroups(request.ou, request.importGroups);
    return {
      success: true,
      data: { message: "Import groups stored successfully" },
      timestamp: Date.now(),
    };
  };

  getImportGroupsHandler: IpcHandler = async (event, request) => {
    const result = await db.getImportGroups(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getMappingConfigIdsForOUHandler: IpcHandler = async (event, request) => {
    const result = await db.getMappingConfigIdsForOU(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  hasImportGroupsCachedHandler: IpcHandler = async (event, request) => {
    const result = await db.hasImportGroupsCached(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Import session handlers
  createImportSessionHandler: IpcHandler = async (event, request) => {
    const sessionId = await db.createImportSession(request);
    return {
      success: true,
      data: sessionId,
      timestamp: Date.now(),
    };
  };

  updateImportSessionStatusHandler: IpcHandler = async (event, request) => {
    await db.updateImportSessionStatus(request.sessionId, request.status);
    return {
      success: true,
      data: { message: "Import session status updated successfully" },
      timestamp: Date.now(),
    };
  };

  getLatestImportSessionHandler: IpcHandler = async (event, request) => {
    const result = await db.getLatestImportSession(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getImportSessionHandler: IpcHandler = async (event, request) => {
    const result = await db.getImportSession(request.sessionId);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getImportSessionsHandler: IpcHandler = async (event, request) => {
    const result = await db.getImportSessions(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Staging table handlers
  clearStagingTableHandler: IpcHandler = async (event) => {
    await db.clearStagingTable();
    return {
      success: true,
      data: { message: "Staging table cleared successfully" },
      timestamp: Date.now(),
    };
  };

  // One-shot housekeeping: drop staging rows already mirrored in financial_data.
  // Wired from AppInitializer; never called from report read paths.
  autoCleanStagingHandler: IpcHandler = async () => {
    const cleared = await db.autoCleanStagingIfImported();
    return {
      success: true,
      data: { cleared },
      timestamp: Date.now(),
    };
  };

  getStagingDataHandler: IpcHandler = async (event, request) => {
    const result = await db.getStagingData(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Mapping tables handlers
  getMappingTablesVersionHandler: IpcHandler = async (event) => {
    const result = await db.getMappingTablesVersion();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  setMappingTablesVersionHandler: IpcHandler = async (event, request) => {
    await db.setMappingTablesVersion(request.version, request.comboVersion);
    return {
      success: true,
      data: { message: "Mapping tables version updated successfully" },
      timestamp: Date.now(),
    };
  };

  storeAccountMapsHandler: IpcHandler = async (event, request) => {
    await db.storeAccountMaps(request.accountMaps);
    return {
      success: true,
      data: { message: `Stored ${request.accountMaps.length} account maps successfully` },
      timestamp: Date.now(),
    };
  };

  storeDepartmentMapsHandler: IpcHandler = async (event, request) => {
    await db.storeDepartmentMaps(request.departmentMaps);
    return {
      success: true,
      data: { message: `Stored ${request.departmentMaps.length} department maps successfully` },
      timestamp: Date.now(),
    };
  };

  storeCombosHandler: IpcHandler = async (event, request) => {
    await db.storeAccountDepartmentCombos(request.combos);
    return {
      success: true,
      data: { message: `Stored ${request.combos.length} combos successfully` },
      timestamp: Date.now(),
    };
  };

  getAccountMapsHandler: IpcHandler = async (event) => {
    const result = await db.getAccountMaps();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getDepartmentMapsHandler: IpcHandler = async (event) => {
    const result = await db.getDepartmentMaps();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getCombosHandler: IpcHandler = async (event) => {
    const result = await db.getAccountDepartmentCombos();
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  isValidComboHandler: IpcHandler = async (event, request) => {
    const result = await db.isValidCombo(request.account, request.department);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getAccountMapHandler: IpcHandler = async (event, request) => {
    const result = await db.getAccountMapByBase(request.baseAccount);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getDepartmentMapHandler: IpcHandler = async (event, request) => {
    const result = await db.getDepartmentMapByBase(request.baseDepartment);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Financial data import handlers
  storeFinancialDataHandler: IpcHandler = async (event, request) => {
    await db.storeFinancialData(request.ou, request.records);
    return {
      success: true,
      data: { message: `Stored ${request.records.length} financial records successfully` },
      timestamp: Date.now(),
    };
  };

  storeFinancialDataForPeriodsHandler: IpcHandler = async (event, request) => {
    await db.storeFinancialDataForPeriods(request.ou, request.records, request.periods);
    return {
      success: true,
      data: { message: `Stored ${request.records.length} financial records for ${request.periods.length} periods` },
      timestamp: Date.now(),
    };
  };

  deleteSyncedFinancialDataForPeriodsHandler: IpcHandler = async (event, request) => {
    const removed = await db.deleteSyncedFinancialDataForPeriods(request.ou, request.periods);
    return {
      success: true,
      data: { removed },
      timestamp: Date.now(),
    };
  };

  getFinancialDataCountHandler: IpcHandler = async (event, request) => {
    const result = await db.getFinancialDataCount(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getFinancialDataLastImportHandler: IpcHandler = async (event, request) => {
    const result = await db.getFinancialDataLastImport(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getFinancialDataLocalVersionsHandler: IpcHandler = async (event, request) => {
    const result = await db.getFinancialDataLocalVersions(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getFinancialReportDataHandler: IpcHandler = async (event, request) => {
    const version = request.version || 'MAIN';
    const result = await db.getFinancialReportData(request.startPeriod, request.ou, version);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getSummaryPLDataHandler: IpcHandler = async (event, request) => {
    const version = request.version || 'MAIN';
    const result = await db.getSummaryPLData(
      request.startMonth,
      request.startYear,
      request.endMonth,
      request.endYear,
      request.ou,
      version
    );
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getF90PLDataHandler: IpcHandler = async (event, request) => {
    const version = request.version || 'MAIN';
    const result = await db.getF90PLData(
      request.startMonth,
      request.startYear,
      request.endMonth,
      request.endYear,
      request.ou,
      version
    );
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getProteaF90PLDataHandler: IpcHandler = async (event, request) => {
    const version = request.version || 'MAIN';
    const { PROTEA_F90_PL_ROW_CONFIG } = await import('../../services/reports/proteaF90PLRowConfig');
    const { computeInvestFactorOwnerSubgroupTotals, applyInvestSubgroupOverridesToF90Rows } = await import('../../services/reports/proteaShared');

    const jsonStr = await db.getProteaF90PLData(
      request.startMonth, request.startYear,
      request.endMonth, request.endYear,
      request.ou, version,
      PROTEA_F90_PL_ROW_CONFIG
    );
    const rows = JSON.parse(jsonStr);

    const totals = await computeInvestFactorOwnerSubgroupTotals(
      request.ou,
      request.startMonth, request.startYear,
      request.endMonth, request.endYear,
      version
    );
    applyInvestSubgroupOverridesToF90Rows(rows, totals);

    return { success: true, data: JSON.stringify(rows), timestamp: Date.now() };
  };

  getStagingVsBudgetDataHandler: IpcHandler = async (event, request) => {
    const version = request.version || 'MAIN';
    const result = await db.getStagingVsBudgetData(request.ou, version);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Cache metadata handlers
  updateCacheMetadataHandler: IpcHandler = async (event, request) => {
    await db.updateCacheMetadata(request.key, request.status, request.errorMessage);
    return {
      success: true,
      data: { message: 'Cache metadata updated successfully' },
      timestamp: Date.now(),
    };
  };

  getCacheMetadataHandler: IpcHandler = async (event, request) => {
    const result = await db.getCacheMetadata(request.key);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  shouldRefreshCacheHandler: IpcHandler = async (event, request) => {
    const result = await db.shouldRefreshCache(request.key, request.maxAgeMinutes);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Financial data daily sync check handlers
  getFinancialDataLastCheckDateHandler: IpcHandler = async (event, request) => {
    const result = await db.getFinancialDataLastCheckDate(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  getFinancialDataLastCheckTimestampHandler: IpcHandler = async (event, request) => {
    const result = await db.getFinancialDataLastCheckTimestamp(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  setFinancialDataSyncCheckHandler: IpcHandler = async (event, request) => {
    await db.setFinancialDataSyncCheck(
      request.ou,
      request.checkDate,
      request.checkTimestamp,
      request.checkResult
    );
    return {
      success: true,
      data: { message: 'Financial data sync check recorded successfully' },
      timestamp: Date.now(),
    };
  };

  // Validation handlers
  storeValidationsHandler: IpcHandler = async (event, request) => {
    await db.storeValidations(request.ou, request.validations);
    return {
      success: true,
      data: { message: 'Validations stored successfully' },
      timestamp: Date.now(),
    };
  };

  getValidationsHandler: IpcHandler = async (event, request) => {
    const result = await db.getValidations(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  // Import completion state handlers
  getImportCompletedStateHandler: IpcHandler = async (event, request) => {
    const result = await db.getImportCompletedState(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  setImportCompletedStateHandler: IpcHandler = async (event, request) => {
    await db.setImportCompletedState(request.ou, request.completed);

    // Generate derived room stats (A960001, A960003, A960102) when completing imports
    if (request.completed && request.ou) {
      const derivedCount = await db.generateDerivedRoomStats(request.ou);
      console.log(`Generated ${derivedCount} derived room stat entries for OU: ${request.ou}`);
    }

    return {
      success: true,
      data: { message: 'Import completed state updated successfully' },
      timestamp: Date.now(),
    };
  };

  // Validation completion state handlers
  getValidationCompletedStateHandler: IpcHandler = async (event, request) => {
    const result = await db.getValidationCompletedState(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  setValidationCompletedStateHandler: IpcHandler = async (event, request) => {
    await db.setValidationCompletedState(request.ou, request.completed);
    return {
      success: true,
      data: { message: 'Validation completed state updated successfully' },
      timestamp: Date.now(),
    };
  };

  // Sign-off completion state handlers
  getSignOffCompletedStateHandler: IpcHandler = async (event, request) => {
    const result = await db.getSignOffCompletedState(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  setSignOffCompletedStateHandler: IpcHandler = async (event, request) => {
    await db.setSignOffCompletedState(request.ou, request.completed);
    return {
      success: true,
      data: { message: 'Sign-off completed state updated successfully' },
      timestamp: Date.now(),
    };
  };

  // Reset all completion states handler
  resetAllCompletionStatesHandler: IpcHandler = async (event, request) => {
    await db.resetAllCompletionStates(request.ou);
    return {
      success: true,
      data: { message: 'All completion states and cached data cleared successfully' },
      timestamp: Date.now(),
    };
  };

  // Reset all completion states for ALL OUs handler
  resetAllCompletionStatesAllOUsHandler: IpcHandler = async (event, request) => {
    await db.resetAllCompletionStatesAllOUs();
    return {
      success: true,
      data: { message: 'All completion states and staging data cleared for all OUs' },
      timestamp: Date.now(),
    };
  };

  // Selected period per OU handlers
  getSelectedPeriodForOUHandler: IpcHandler = async (event, request) => {
    const result = await db.getSelectedPeriodForOU(request.ou);
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  };

  setSelectedPeriodForOUHandler: IpcHandler = async (event, request) => {
    await db.setSelectedPeriodForOU(request.ou, request.period);
    return {
      success: true,
      data: { message: 'Selected period updated successfully' },
      timestamp: Date.now(),
    };
  };

  // Manual adjustments handler
  insertManualAdjustmentsHandler: IpcHandler = async (event, request) => {
    const count = await db.insertManualAdjustments(request.adjustments);
    return {
      success: true,
      data: { message: `Inserted ${count} manual adjustment(s) successfully`, count },
      timestamp: Date.now(),
    };
  };

  // Staging row CRUD handlers
  addStagingRowHandler: IpcHandler = async (event, request) => {
    const rowid = await db.addStagingRow(request);
    return {
      success: true,
      data: { message: 'Staging row added successfully', rowid },
      timestamp: Date.now(),
    };
  };

  updateStagingRowHandler: IpcHandler = async (event, request) => {
    const updated = await db.updateStagingRow(request);
    return {
      success: true,
      data: { message: updated ? 'Staging row updated successfully' : 'No row found to update', updated },
      timestamp: Date.now(),
    };
  };

  deleteStagingRowHandler: IpcHandler = async (event, request) => {
    const deleted = await db.deleteStagingRow(request.rowid);
    return {
      success: true,
      data: { message: deleted ? 'Staging row deleted successfully' : 'No row found to delete', deleted },
      timestamp: Date.now(),
    };
  };

  checkImportsExistHandler: IpcHandler = async (event, request) => {
    const exists = await db.checkImportsExist(request.ou);
    return {
      success: true,
      data: exists,
      timestamp: Date.now(),
    };
  };

  getUniqueAccountsHandler: IpcHandler = async (event) => {
    const accounts = await db.getUniqueAccounts();
    return {
      success: true,
      data: accounts,
      timestamp: Date.now(),
    };
  };

  getUniqueDepartmentsHandler: IpcHandler = async (event) => {
    const departments = await db.getUniqueDepartments();
    return {
      success: true,
      data: departments,
      timestamp: Date.now(),
    };
  };

  getDepartmentsForAccountHandler: IpcHandler = async (event, request) => {
    const departments = await db.getDepartmentsForAccount(request.account);
    return {
      success: true,
      data: departments,
      timestamp: Date.now(),
    };
  };

  getAccountsForDepartmentHandler: IpcHandler = async (event, request) => {
    const accounts = await db.getAccountsForDepartment(request.department);
    return {
      success: true,
      data: accounts,
      timestamp: Date.now(),
    };
  };
}

// Factory function to create and register database handlers
export function createDatabaseHandlers() {
  const handlers = new DatabaseHandlers();

  return {
    [IPC_CHANNELS.DB_GET_PERIODS]: handlers.getPeriodsHandler,
    [IPC_CHANNELS.DB_UPDATE_PERIODS]: handlers.updatePeriodsHandler,
    [IPC_CHANNELS.DB_GENERATE_DUMMY_DATA]: handlers.generateDummyDataHandler,
    [IPC_CHANNELS.DB_GET_ACCOUNTS]: handlers.getAllAccountsHandler,
    [IPC_CHANNELS.DB_GET_DEPARTMENTS]: handlers.getAllDepartmentsHandler,
    [IPC_CHANNELS.DB_GET_COMBO_METADATA]: handlers.getAllComboMetadataHandler,
    [IPC_CHANNELS.DB_CREATE_ACCOUNT]: handlers.createAccountHandler,
    [IPC_CHANNELS.DB_CREATE_DEPARTMENT]: handlers.createDepartmentHandler,
    [IPC_CHANNELS.DB_CREATE_COMBO]: handlers.createComboHandler,
    [IPC_CHANNELS.DB_GET_CACHED_HOTELS]: handlers.getCachedHotelsHandler,
    [IPC_CHANNELS.DB_CACHE_HOTELS]: handlers.cacheHotelsHandler,
    [IPC_CHANNELS.DB_CLEAR_HOTELS_CACHE]: handlers.clearHotelsCacheHandler,
    [IPC_CHANNELS.DB_IS_HOTELS_CACHE_EXPIRED]: handlers.isHotelsCacheExpiredHandler,
    [IPC_CHANNELS.DB_STORE_MAPPING_CONFIG]: handlers.storeMappingConfigHandler,
    [IPC_CHANNELS.DB_GET_MAPPING_CONFIG]: handlers.getMappingConfigHandler,
    [IPC_CHANNELS.DB_GET_ALL_MAPPING_CONFIGS]: handlers.getAllMappingConfigsHandler,
    [IPC_CHANNELS.DB_UPDATE_MAPPING_CONFIG_SYNC_TIME]: handlers.updateMappingConfigSyncTimeHandler,
    [IPC_CHANNELS.DB_REPLACE_MAPPINGS]: handlers.replaceMappingsHandler,
    [IPC_CHANNELS.DB_GET_MAPPINGS]: handlers.getMappingsHandler,
    [IPC_CHANNELS.DB_GET_MAPPING_COUNT]: handlers.getMappingCountHandler,
    [IPC_CHANNELS.DB_FIND_MAPPING]: handlers.findMappingHandler,
    [IPC_CHANNELS.DB_GET_MAPPINGS_BY_APPROVAL_STATUS]: handlers.getMappingsByApprovalStatusHandler,
    [IPC_CHANNELS.DB_UPDATE_MAPPING_APPROVAL_STATUS]: handlers.updateMappingApprovalStatusHandler,
    [IPC_CHANNELS.DB_UPDATE_MAPPING]: handlers.updateMappingHandler,
    [IPC_CHANNELS.DB_STORE_IMPORT_GROUPS]: handlers.storeImportGroupsHandler,
    [IPC_CHANNELS.DB_GET_IMPORT_GROUPS]: handlers.getImportGroupsHandler,
    [IPC_CHANNELS.DB_GET_MAPPING_CONFIG_IDS_FOR_OU]: handlers.getMappingConfigIdsForOUHandler,
    [IPC_CHANNELS.DB_HAS_IMPORT_GROUPS_CACHED]: handlers.hasImportGroupsCachedHandler,
    [IPC_CHANNELS.DB_CREATE_IMPORT_SESSION]: handlers.createImportSessionHandler,
    [IPC_CHANNELS.DB_UPDATE_IMPORT_SESSION_STATUS]: handlers.updateImportSessionStatusHandler,
    [IPC_CHANNELS.DB_GET_LATEST_IMPORT_SESSION]: handlers.getLatestImportSessionHandler,
    [IPC_CHANNELS.DB_GET_IMPORT_SESSION]: handlers.getImportSessionHandler,
    [IPC_CHANNELS.DB_GET_IMPORT_SESSIONS]: handlers.getImportSessionsHandler,
    [IPC_CHANNELS.DB_CLEAR_STAGING_TABLE]: handlers.clearStagingTableHandler,
    [IPC_CHANNELS.DB_AUTO_CLEAN_STAGING]: handlers.autoCleanStagingHandler,
    [IPC_CHANNELS.DB_GET_STAGING_DATA]: handlers.getStagingDataHandler,
    [IPC_CHANNELS.DB_ADD_STAGING_ROW]: handlers.addStagingRowHandler,
    [IPC_CHANNELS.DB_UPDATE_STAGING_ROW]: handlers.updateStagingRowHandler,
    [IPC_CHANNELS.DB_DELETE_STAGING_ROW]: handlers.deleteStagingRowHandler,
    [IPC_CHANNELS.DB_CHECK_IMPORTS_EXIST]: handlers.checkImportsExistHandler,
    [IPC_CHANNELS.DB_GET_UNIQUE_ACCOUNTS]: handlers.getUniqueAccountsHandler,
    [IPC_CHANNELS.DB_GET_UNIQUE_DEPARTMENTS]: handlers.getUniqueDepartmentsHandler,
    [IPC_CHANNELS.DB_GET_DEPARTMENTS_FOR_ACCOUNT]: handlers.getDepartmentsForAccountHandler,
    [IPC_CHANNELS.DB_GET_ACCOUNTS_FOR_DEPARTMENT]: handlers.getAccountsForDepartmentHandler,
    [IPC_CHANNELS.DB_GET_MAPPING_TABLES_VERSION]: handlers.getMappingTablesVersionHandler,
    [IPC_CHANNELS.DB_SET_MAPPING_TABLES_VERSION]: handlers.setMappingTablesVersionHandler,
    [IPC_CHANNELS.DB_STORE_ACCOUNT_MAPS]: handlers.storeAccountMapsHandler,
    [IPC_CHANNELS.DB_STORE_DEPARTMENT_MAPS]: handlers.storeDepartmentMapsHandler,
    [IPC_CHANNELS.DB_STORE_COMBOS]: handlers.storeCombosHandler,
    [IPC_CHANNELS.DB_GET_ACCOUNT_MAPS]: handlers.getAccountMapsHandler,
    [IPC_CHANNELS.DB_GET_DEPARTMENT_MAPS]: handlers.getDepartmentMapsHandler,
    [IPC_CHANNELS.DB_GET_COMBOS]: handlers.getCombosHandler,
    [IPC_CHANNELS.DB_IS_VALID_COMBO]: handlers.isValidComboHandler,
    [IPC_CHANNELS.DB_GET_ACCOUNT_MAP]: handlers.getAccountMapHandler,
    [IPC_CHANNELS.DB_GET_DEPARTMENT_MAP]: handlers.getDepartmentMapHandler,
    [IPC_CHANNELS.DB_STORE_FINANCIAL_DATA]: handlers.storeFinancialDataHandler,
    [IPC_CHANNELS.DB_STORE_FINANCIAL_DATA_FOR_PERIODS]: handlers.storeFinancialDataForPeriodsHandler,
    [IPC_CHANNELS.DB_DELETE_SYNCED_FINANCIAL_DATA_FOR_PERIODS]: handlers.deleteSyncedFinancialDataForPeriodsHandler,
    [IPC_CHANNELS.DB_GET_FINANCIAL_DATA_COUNT]: handlers.getFinancialDataCountHandler,
    [IPC_CHANNELS.DB_GET_FINANCIAL_DATA_LAST_IMPORT]: handlers.getFinancialDataLastImportHandler,
    [IPC_CHANNELS.DB_GET_FINANCIAL_DATA_LOCAL_VERSIONS]: handlers.getFinancialDataLocalVersionsHandler,
    [IPC_CHANNELS.DB_GET_FINANCIAL_REPORT_DATA]: handlers.getFinancialReportDataHandler,
    [IPC_CHANNELS.DB_GET_SUMMARY_PL_DATA]: handlers.getSummaryPLDataHandler,
    [IPC_CHANNELS.DB_GET_F90_PL_DATA]: handlers.getF90PLDataHandler,
    [IPC_CHANNELS.DB_GET_PROTEA_F90_PL_DATA]: handlers.getProteaF90PLDataHandler,
    [IPC_CHANNELS.DB_GET_STAGING_VS_BUDGET_DATA]: handlers.getStagingVsBudgetDataHandler,
    [IPC_CHANNELS.DB_UPDATE_CACHE_METADATA]: handlers.updateCacheMetadataHandler,
    [IPC_CHANNELS.DB_GET_CACHE_METADATA]: handlers.getCacheMetadataHandler,
    [IPC_CHANNELS.DB_SHOULD_REFRESH_CACHE]: handlers.shouldRefreshCacheHandler,
    [IPC_CHANNELS.DB_STORE_VALIDATIONS]: handlers.storeValidationsHandler,
    [IPC_CHANNELS.DB_GET_VALIDATIONS]: handlers.getValidationsHandler,
    [IPC_CHANNELS.DB_GET_IMPORT_COMPLETED_STATE]: handlers.getImportCompletedStateHandler,
    [IPC_CHANNELS.DB_SET_IMPORT_COMPLETED_STATE]: handlers.setImportCompletedStateHandler,
    [IPC_CHANNELS.DB_GET_VALIDATION_COMPLETED_STATE]: handlers.getValidationCompletedStateHandler,
    [IPC_CHANNELS.DB_SET_VALIDATION_COMPLETED_STATE]: handlers.setValidationCompletedStateHandler,
    [IPC_CHANNELS.DB_GET_SIGNOFF_COMPLETED_STATE]: handlers.getSignOffCompletedStateHandler,
    [IPC_CHANNELS.DB_SET_SIGNOFF_COMPLETED_STATE]: handlers.setSignOffCompletedStateHandler,
    [IPC_CHANNELS.DB_GET_SELECTED_PERIOD_FOR_OU]: handlers.getSelectedPeriodForOUHandler,
    [IPC_CHANNELS.DB_SET_SELECTED_PERIOD_FOR_OU]: handlers.setSelectedPeriodForOUHandler,
    [IPC_CHANNELS.DB_RESET_ALL_COMPLETION_STATES]: handlers.resetAllCompletionStatesHandler,
    [IPC_CHANNELS.DB_RESET_ALL_COMPLETION_STATES_ALL_OUS]: handlers.resetAllCompletionStatesAllOUsHandler,
    [IPC_CHANNELS.DB_INSERT_MANUAL_ADJUSTMENTS]: handlers.insertManualAdjustmentsHandler,
    [IPC_CHANNELS.DB_GET_FINANCIAL_DATA_LAST_CHECK_DATE]: handlers.getFinancialDataLastCheckDateHandler,
    [IPC_CHANNELS.DB_GET_FINANCIAL_DATA_LAST_CHECK_TIMESTAMP]: handlers.getFinancialDataLastCheckTimestampHandler,
    [IPC_CHANNELS.DB_SET_FINANCIAL_DATA_SYNC_CHECK]: handlers.setFinancialDataSyncCheckHandler,
  };
}