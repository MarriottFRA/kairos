import api from './api';
import mappingConfigService from './mappingConfigService';

// Types for Import Groups
export interface Import {
  id: number;
  name: string;
  displayName: string;
  description: string;
  order: number;
  mapping_config_id: number;
  required: boolean;
  fileTypes: string[];
  requiredColumns: string[];
  optionalColumns: string[];
  validationRules: string[];
}

export interface ImportGroup {
  group_name: string;
  imports: Import[];
}

class ImportGroupsService {
  /**
   * Fetch import groups for a specific hotel/OU
   * @param ou The organizational unit (hotel) identifier
   * @returns Promise<ImportGroup[]> Array of import groups
   */
  async getImportGroups(ou: string): Promise<ImportGroup[]> {
    const response = await api.get(`/hotels/${ou}/import_groups`);

    if (!response.ok) {
      if (response.status === 422) {
        const error = await response.json();
        throw new Error(error.detail?.[0]?.msg || 'Validation error');
      }
      const error = await response.json();
      throw new Error(error.detail || 'Failed to fetch import groups');
    }

    return await response.json();
  }

  /**
   * Get unique group names from import groups
   * @param importGroups Array of import groups
   * @returns Array of unique group names
   */
  getUniqueGroupNames(importGroups: ImportGroup[]): string[] {
    return [...new Set(importGroups.map(group => group.group_name))];
  }

  /**
   * Get imports for a specific group
   * @param importGroups Array of import groups
   * @param groupName The group name to filter by
   * @returns Array of imports for the specified group
   */
  getImportsByGroup(importGroups: ImportGroup[], groupName: string): Import[] {
    const group = importGroups.find(g => g.group_name === groupName);
    return group ? group.imports : [];
  }

  /**
   * Cache import groups locally for offline access
   * @param ou The organizational unit
   * @param importGroups The import groups to cache
   */
  async cacheImportGroups(ou: string, importGroups: ImportGroup[]): Promise<void> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        await window.ipcApi.sendIpcRequest('db:store-import-groups', {
          ou,
          importGroups
        });
        // console.log('Import groups cached successfully');
      } catch (cacheError) {
        // console.warn('Failed to cache import groups:', cacheError);
      }
    }
  }

  /**
   * Get cached import groups for offline access
   * @param ou The organizational unit
   * @returns Cached import groups if available
   */
  async getCachedImportGroups(ou: string): Promise<ImportGroup[] | null> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const cached = await window.ipcApi.sendIpcRequest('db:get-import-groups', { ou });
        // IPC handlers return { success: true, data: ... }
        return cached?.data || null;
      } catch (error) {
        // console.warn('Failed to get cached import groups:', error);
        return null;
      }
    }
    return null;
  }

  /**
   * Sync all mapping configurations for imports in an OU
   * @param ou The organizational unit
   * @returns Promise<void>
   */
  async syncMappingConfigsForOU(ou: string): Promise<void> {
    try {
      // console.log(`Starting sync for OU: ${ou}`);
      // First check if we have import groups cached for this OU
      let importGroups = await this.getCachedImportGroups(ou);
      // console.log(`Cached import groups for ${ou}:`, importGroups?.length || 0);
      // If no cached groups, we need to fetch from API
      if (!importGroups || importGroups.length === 0) {
        // console.log(`No cached import groups found for ${ou}, fetching from API first...`);
        importGroups = await this.getImportGroups(ou);
        // console.log(`Fetched ${importGroups.length} import groups for ${ou}`);
        // Extract mapping config IDs directly from fetched groups
        const configIds = new Set<number>();
        for (const group of importGroups) {
          for (const imp of group.imports) {
            if (imp.mapping_config_id) {
              configIds.add(imp.mapping_config_id);
            }
          }
        }

        if (configIds.size > 0) {
          // console.log(`Syncing ${configIds.size} mapping configs BEFORE caching import groups...`);
          // Sync mapping configs FIRST
          const syncPromises = Array.from(configIds).map(configId =>
            mappingConfigService.syncMappingConfig(configId)
              .catch(error => {
                console.error(`Failed to sync mapping config ${configId}:`, error);
                return null;
              })
          );

          await Promise.all(syncPromises);
          // console.log(`Completed syncing mapping configs`);
        }

        // NOW cache the import groups (after mapping configs are stored)
        await this.cacheImportGroups(ou, importGroups);
        // console.log(`Cached ${importGroups.length} import groups for ${ou}`);
      } else {
        // Import groups are already cached, just sync any missing mapping configs
        const configIds = await this.getMappingConfigIdsForOU(ou);
        // console.log(`Found mapping config IDs for ${ou}:`, configIds);
        if (configIds.length === 0) {
          // console.log(`No mapping configs to sync for OU ${ou}`);
          return;
        }

        // console.log(`Syncing ${configIds.length} mapping configs for OU ${ou}...`);
        // Sync each mapping config
        const syncPromises = configIds.map(configId =>
          mappingConfigService.syncMappingConfig(configId)
            .catch(error => {
              console.error(`Failed to sync mapping config ${configId}:`, error);
              return null;
            })
        );

        await Promise.all(syncPromises);
        // console.log(`Completed syncing mapping configs for OU ${ou}`);
      }
    } catch (error) {
      console.error('Error syncing mapping configs for OU:', error);
      throw error;
    }
  }

  /**
   * Get all unique mapping config IDs for an OU
   * @param ou The organizational unit
   * @returns Array of mapping config IDs
   */
  async getMappingConfigIdsForOU(ou: string): Promise<number[]> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const result = await window.ipcApi.sendIpcRequest('db:get-mapping-config-ids-for-ou', { ou });
        // IPC handlers return { success: true, data: ... }
        return result?.data || [];
      } catch (error) {
        // console.warn('Failed to get mapping config IDs:', error);
        return [];
      }
    }
    return [];
  }

  /**
   * Fetch import groups and sync with mapping configs
   * @param ou The organizational unit
   * @param silent If true, don't throw errors (for background sync)
   * @returns Promise<ImportGroup[]> Array of import groups with synced mappings
   */
  async fetchAndSyncImportGroups(ou: string, silent: boolean = false): Promise<ImportGroup[]> {
    try {
      // Update cache metadata to "fetching"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `import_groups_${ou}`,
          status: 'fetching'
        }).catch(() => {}); // Ignore errors
      }

      // Fetch import groups from API
      const importGroups = await this.getImportGroups(ou);

      // IMPORTANT: Sync mapping configs BEFORE caching import groups
      // because imports table has foreign key to mapping_configs table

      // Extract all unique mapping config IDs from the import groups
      const configIds = new Set<number>();
      for (const group of importGroups) {
        for (const imp of group.imports) {
          if (imp.mapping_config_id) {
            configIds.add(imp.mapping_config_id);
          }
        }
      }

      // console.log(`Found ${configIds.size} unique mapping configs to sync for OU ${ou}`);
      // Sync each mapping config BEFORE storing import groups
      if (configIds.size > 0) {
        const syncPromises = Array.from(configIds).map(configId =>
          mappingConfigService.syncMappingConfig(configId)
            .catch(error => {
              console.error(`Failed to sync mapping config ${configId}:`, error);
              return null;
            })
        );

        await Promise.all(syncPromises);
        // console.log(`Completed syncing ${configIds.size} mapping configs`);
      }

      // NOW cache the import groups (after mapping configs are stored)
      await this.cacheImportGroups(ou, importGroups);

      // Update cache metadata to "success"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `import_groups_${ou}`,
          status: 'success'
        }).catch(() => {}); // Ignore errors
      }

      return importGroups;
    } catch (error) {
      console.error('Error fetching and syncing import groups:', error);

      // Update cache metadata to "failed"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `import_groups_${ou}`,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        }).catch(() => {}); // Ignore errors
      }

      // Try to return cached data if available
      const cached = await this.getCachedImportGroups(ou);
      if (cached) {
        // console.log('Returning cached import groups due to error');
        return cached;
      }

      if (silent) {
        return []; // Return empty array for background sync
      }

      throw error;
    }
  }

  /**
   * Get import groups with cache-first strategy
   * Returns cached data immediately, then fetches fresh data in background
   * @param ou The organizational unit
   * @param onUpdate Callback when fresh data is available
   */
  async getImportGroupsCacheFirst(
    ou: string,
    onUpdate?: (groups: ImportGroup[]) => void
  ): Promise<ImportGroup[]> {
    // Try to get cached data first
    const cached = await this.getCachedImportGroups(ou);

    // Start background fetch (don't await)
    this.fetchAndSyncImportGroups(ou, true)
      .then(freshData => {
        // Only notify if data changed
        if (onUpdate && JSON.stringify(cached) !== JSON.stringify(freshData)) {
          onUpdate(freshData);
        }
      })
      .catch(error => {
        console.error('Background fetch failed:', error);
      });

    // Return cached data immediately (or empty if no cache)
    return cached || [];
  }
}

export default new ImportGroupsService();