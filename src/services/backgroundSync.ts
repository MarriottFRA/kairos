/**
 * Background Sync Service
 * ========================
 *
 * Manages periodic background synchronization of cached data from the API.
 * Updates local SQLite cache without blocking the UI.
 *
 * Features:
 * - Periodic sync every 5 minutes
 * - Respects cache age (only syncs if data is stale)
 * - Handles errors gracefully without interrupting app
 * - Can be manually triggered
 * - Tracks sync status in cache_metadata table
 */

import authService from './auth';
import importConfigService from './importConfigService';
import mappingTablesService from './mappingTablesService';
import dailyFinancialSyncService from './dailyFinancialSyncService';

class BackgroundSyncService {
  private syncInterval: number = 5 * 60 * 1000; // 5 minutes
  private intervalId: NodeJS.Timeout | null = null;
  private isSyncing: boolean = false;
  private currentOU: string | null = null;

  /**
   * Start the background sync service
   */
  start(ou?: string) {
    if (this.intervalId) {
      // console.log('[BackgroundSync] Service already running');
      return;
    }

    if (ou) {
      this.currentOU = ou;
    }

    // console.log('[BackgroundSync] Starting service...');
    // Start periodic sync
    this.intervalId = setInterval(() => {
      this.syncAll();
    }, this.syncInterval);

    // Initial sync after a short delay to let the app initialize
    setTimeout(() => {
      this.syncAll();
    }, 10000); // 10 seconds delay
  }

  /**
   * Stop the background sync service
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      // console.log('[BackgroundSync] Service stopped');
    }
  }

  /**
   * Set the current organizational unit (hotel) to sync
   */
  setOU(ou: string) {
    this.currentOU = ou;
    // console.log(`[BackgroundSync] OU set to: ${ou}`);
    // Trigger an immediate sync for the new OU
    this.syncAll();
  }

  /**
   * Sync all data in the background
   */
  async syncAll() {
    // Prevent concurrent syncs
    if (this.isSyncing) {
      // console.log('[BackgroundSync] Sync already in progress, skipping...');
      return;
    }

    // Can't sync without an OU
    if (!this.currentOU) {
      // console.log('[BackgroundSync] No OU selected, skipping sync');
      return;
    }

    // Check if user has an active (device-verified) session. The token lives in
    // the main process now; we gate on the cached security level instead.
    if (authService.getSecurityLevel() < 2) {
      // console.log('[BackgroundSync] No active session, skipping sync');
      return;
    }

    this.isSyncing = true;
    // console.log(`[BackgroundSync] Starting sync for OU: ${this.currentOU}`);
    try {
      // Sync hotels
      await this.syncHotels();

      // Sync import groups for current OU
      await this.syncImportGroups(this.currentOU);

      // Sync mapping tables (version-based, lightweight check)
      await this.syncMappingTables();

      // Sync financial data (once-per-day check)
      await this.syncFinancialData(this.currentOU);

      // Drop staging rows now superseded by the synced financial data
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:auto-clean-staging', {}).catch((err: unknown) => {
          console.error('[BackgroundSync] Failed to clean staging after sync:', err);
        });
      }

      // console.log('[BackgroundSync] Sync completed successfully');
    } catch (error) {
      console.error('[BackgroundSync] Sync failed:', error);
      // Don't throw - we don't want to interrupt the app
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync hotels cache
   */
  private async syncHotels() {
    try {
      // Check if cache needs refresh (only if older than 60 minutes)
      if (typeof window !== 'undefined' && window.ipcApi) {
        const shouldRefresh = await window.ipcApi.sendIpcRequest('db:should-refresh-cache', {
          key: 'hotels',
          maxAgeMinutes: 60
        });

        if (!shouldRefresh.data) {
          // console.log('[BackgroundSync] Hotels cache is fresh, skipping');
          return;
        }
      }

      // console.log('[BackgroundSync] Syncing hotels...');
      // Update cache metadata to "fetching"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: 'hotels',
          status: 'fetching'
        });
      }

      // Fetch fresh hotels from API
      const hotels = await authService.getHotels();

      if (hotels.length > 0 && typeof window !== 'undefined' && window.ipcApi) {
        // Cache hotels
        await window.ipcApi.sendIpcRequest('db:cache-hotels', { hotels });

        // Update cache metadata to "success"
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: 'hotels',
          status: 'success'
        });

        // console.log(`[BackgroundSync] Successfully synced ${hotels.length} hotels`);
      }
    } catch (error) {
      console.error('[BackgroundSync] Failed to sync hotels:', error);

      // Update cache metadata to "failed"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: 'hotels',
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  /**
   * Sync import groups for a specific OU
   */
  private async syncImportGroups(ou: string) {
    try {
      // Check if cache needs refresh (only if older than 30 minutes)
      if (typeof window !== 'undefined' && window.ipcApi) {
        const shouldRefresh = await window.ipcApi.sendIpcRequest('db:should-refresh-cache', {
          key: `import_groups_${ou}`,
          maxAgeMinutes: 30
        });

        if (!shouldRefresh.data) {
          // console.log(`[BackgroundSync] Import groups for ${ou} are fresh, skipping`);
          return;
        }
      }

      // console.log(`[BackgroundSync] Syncing import groups for ${ou}...`);
      // Update cache metadata to "fetching"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `import_groups_${ou}`,
          status: 'fetching'
        });
      }

      // Fetch and sync import groups (this also syncs mapping configs)
      await importConfigService.fetchAndSyncImportGroups(ou);

      // Update cache metadata to "success"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `import_groups_${ou}`,
          status: 'success'
        });
      }

      // console.log(`[BackgroundSync] Successfully synced import groups for ${ou}`);
    } catch (error) {
      console.error(`[BackgroundSync] Failed to sync import groups for ${ou}:`, error);

      // Update cache metadata to "failed"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `import_groups_${ou}`,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  /**
   * Sync mapping tables (account maps, department maps, combos)
   * Gated by 30-min cache age to avoid frequent API calls for remote users.
   * The version check itself is lightweight (single API call), but we still
   * respect the cache age to keep network usage minimal.
   */
  private async syncMappingTables() {
    try {
      // Check if cache needs refresh (only if older than 30 minutes)
      if (typeof window !== 'undefined' && window.ipcApi) {
        const shouldRefresh = await window.ipcApi.sendIpcRequest('db:should-refresh-cache', {
          key: 'mapping_tables',
          maxAgeMinutes: 30
        });

        if (!shouldRefresh.data) {
          return;
        }

        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: 'mapping_tables',
          status: 'fetching'
        });
      }

      await mappingTablesService.syncMappingTables();

      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: 'mapping_tables',
          status: 'success'
        });
      }
    } catch (error) {
      console.error('[BackgroundSync] Failed to sync mapping tables:', error);

      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: 'mapping_tables',
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  /**
   * Perform daily financial data check for the current OU
   * Uses once-per-day gating internally
   */
  private async syncFinancialData(ou: string) {
    try {
      await dailyFinancialSyncService.performDailyCheck(ou);
    } catch (error) {
      console.error('[BackgroundSync] Failed to sync financial data:', error);
    }
  }

  /**
   * Manually trigger a sync
   */
  async triggerSync() {
    // console.log('[BackgroundSync] Manual sync triggered');
    await this.syncAll();
  }
}

// Export singleton instance
export const backgroundSyncService = new BackgroundSyncService();
export default backgroundSyncService;
