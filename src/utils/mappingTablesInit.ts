/**
 * Mapping Tables Initialization Utility
 *
 * This module provides a simple function to sync mapping tables on application startup.
 * Call this after the user is authenticated to ensure local mapping tables are up-to-date.
 */

import mappingTablesService from '../services/mappingTablesService';

export interface MappingTablesSyncResult {
  success: boolean;
  synced: boolean;
  error?: string;
  message: string;
}

/**
 * Initialize and sync mapping tables
 *
 * This function should be called after user authentication, typically in your
 * app initialization flow. It will:
 * 1. Check if local mapping tables need updating
 * 2. Download and store updated data if needed
 * 3. Return the sync status
 *
 * @param silent - If true, suppresses console logs (default: false)
 * @returns Promise<MappingTablesSyncResult> - Sync result with status
 *
 * @example
 * ```typescript
 * // In your app initialization (after authentication):
 * import { initializeMappingTables } from './utils/mappingTablesInit';
 *
 * async function startApp() {
 *   // ... authentication logic ...
 *
 *   const result = await initializeMappingTables();
 *   if (!result.success) {
 *     console.warn('Mapping tables sync failed:', result.error);
 *     // Show warning to user if needed
 *   }
 * }
 * ```
 */
export async function initializeMappingTables(silent = false): Promise<MappingTablesSyncResult> {
  try {
    if (!silent) {
      // console.log('Checking mapping tables sync status...');
    }

    // Check if sync is needed
    const { needsSync, needsComboSync } = await mappingTablesService.checkIfSyncNeeded();

    if (!needsSync && !needsComboSync) {
      if (!silent) {
        // console.log('Mapping tables are up-to-date');
      }
      return {
        success: true,
        synced: false,
        message: 'Mapping tables are already up-to-date'
      };
    }

    // Perform sync
    if (!silent) {
      if (needsSync) {
        // console.log('Downloading account and department maps...');
      }
      if (needsComboSync) {
        // console.log('Downloading account-department combos...');
      }
    }

    const synced = await mappingTablesService.syncMappingTables();

    if (synced) {
      if (!silent) {
        // console.log('Mapping tables synced successfully');
      }
      return {
        success: true,
        synced: true,
        message: 'Mapping tables synced successfully'
      };
    } else {
      if (!silent) {
        // console.log('Mapping tables are up-to-date');
      }
      return {
        success: true,
        synced: false,
        message: 'Mapping tables are already up-to-date'
      };
    }
  } catch (error: any) {
    const errorMessage = error?.message || 'Unknown error occurred';
    if (!silent) {
      console.error('Failed to sync mapping tables:', errorMessage);
    }
    return {
      success: false,
      synced: false,
      error: errorMessage,
      message: `Failed to sync mapping tables: ${errorMessage}`
    };
  }
}

/**
 * Get the current local mapping tables version
 *
 * @returns Promise<{ version: string; combo_version: string } | null>
 */
export async function getMappingTablesVersion(): Promise<{ version: string; combo_version: string } | null> {
  try {
    return await mappingTablesService.getStoredVersion();
  } catch (error) {
    console.error('Failed to get mapping tables version:', error);
    return null;
  }
}

/**
 * Force a full sync of mapping tables regardless of version
 * Useful for troubleshooting or manual refresh
 *
 * @returns Promise<MappingTablesSyncResult>
 */
export async function forceMappingTablesSync(): Promise<MappingTablesSyncResult> {
  try {
    // console.log('Forcing mapping tables sync...');
    // Download and sync everything
    const data = await mappingTablesService.getData();
    await mappingTablesService.storeMappingTablesData(data);

    const combosData = await mappingTablesService.getCombos();
    await mappingTablesService.storeCombosData(combosData);

    // Update version (use combo_version from response if available, otherwise use main version)
    await mappingTablesService.updateVersion(
      data.version,
      combosData.combo_version || data.version
    );

    // console.log('Forced sync completed successfully');
    return {
      success: true,
      synced: true,
      message: 'Mapping tables force synced successfully'
    };
  } catch (error: any) {
    const errorMessage = error?.message || 'Unknown error occurred';
    console.error('Failed to force sync mapping tables:', errorMessage);
    return {
      success: false,
      synced: false,
      error: errorMessage,
      message: `Failed to force sync mapping tables: ${errorMessage}`
    };
  }
}
