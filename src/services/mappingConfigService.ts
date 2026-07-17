import api from './api';

// Interface for the Mapping Config from API
export interface MappingConfigResponse {
  version: string;
  is_locked: boolean;
  description: string;
  id?: number; // From API responses
  config_id?: number; // From local database
  created_at: string;
  updated_at: string;
  last_synced?: string; // From local database
  mappings?: any[]; // For GET response
}

// Interface for PATCH request
export interface MappingConfigUpdateRequest {
  version: string;
  is_locked: boolean;
  description: string;
  id?: number;
  config_id?: number;
  created_at: string;
  updated_at: string;
}

// Approval status type
export type ApprovalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DRAFT';

// Interface for Mapping entry
export interface MappingEntry {
  source_account: string | null;
  source_department: string | null;
  source_account_department: string | null;
  target_account: string | null;
  target_department: string | null;
  target_account_department: string | null;
  priority: number;
  is_active: boolean;
  id: number;
  mapping_config_id: number;
  approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
}

// Interface for mapping approval request
export interface MappingApprovalRequest {
  approval_status: 'APPROVED' | 'REJECTED';
  rejection_reason?: string;
}

// Interface for creating a new mapping request
export interface CreateMappingRequest {
  source_account?: string | null;
  source_department?: string | null;
  source_account_department?: string | null;
  target_account?: string | null;
  target_department?: string | null;
  target_account_department?: string | null;
  priority?: number;
  is_active?: boolean;
}


class MappingConfigService {
  /**
   * Fetch mapping configuration from API
   * @param configId The configuration ID
   * @returns Promise<MappingConfigResponse> The mapping configuration
   */
  async getMappingConfig(configId: number): Promise<MappingConfigResponse> {
    try {
      const response = await api.get(`/mappings/configs/${configId}`);

      if (!response.ok) {
        if (response.status === 422) {
          const error = await response.json();
          throw new Error(error.detail?.[0]?.msg || 'Validation error');
        }
        const error = await response.json();
        throw new Error(error.detail || `Failed to fetch mapping config: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching mapping config:', error);
      throw error;
    }
  }

  /**
   * Update mapping configuration via API
   * @param configId The configuration ID
   * @param updateData The data to update
   * @returns Promise<MappingConfigResponse> The updated mapping configuration
   */
  async patchMappingConfig(
    configId: number,
    updateData: MappingConfigUpdateRequest
  ): Promise<MappingConfigResponse> {
    try {
      const response = await api.fetch(`/mappings/configs/${configId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      });

      if (!response.ok) {
        if (response.status === 422) {
          const error = await response.json();
          throw new Error(error.detail?.[0]?.msg || 'Validation error');
        }
        const error = await response.json();
        throw new Error(error.detail || `Failed to update mapping config: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error updating mapping config:', error);
      throw error;
    }
  }

  /**
   * Store mapping config in local database
   * @param config The mapping configuration to store
   */
  async storeMappingConfig(config: MappingConfigResponse): Promise<void> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        await window.ipcApi.sendIpcRequest('db:store-mapping-config', {
          config_id: config.id,
          version: config.version,
          is_locked: config.is_locked,
          description: config.description,
          created_at: config.created_at,
          updated_at: config.updated_at
        });
        // console.log('Mapping config stored successfully');
      } catch (error) {
        console.error('Failed to store mapping config:', error);
        throw error;
      }
    }
  }

  /**
   * Get stored mapping config from local database
   * @param configId The configuration ID
   * @returns The stored mapping configuration if available
   */
  async getStoredMappingConfig(configId: number): Promise<MappingConfigResponse | null> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const stored = await window.ipcApi.sendIpcRequest('db:get-mapping-config', { config_id: configId });
        // IPC handlers return { success: true, data: ... }
        return stored?.data || null;
      } catch (error) {
        // console.warn('Failed to get stored mapping config:', error);
        return null;
      }
    }
    return null;
  }

  /**
   * Check if local mapping config needs update by comparing versions
   * @param configId The configuration ID
   * @returns true if update is needed, false otherwise
   */
  async checkIfUpdateNeeded(configId: number): Promise<boolean> {
    try {
      // Get local stored config
      const localConfig = await this.getStoredMappingConfig(configId);

      if (!localConfig) {
        // No local config, definitely needs update
        return true;
      }

      // Get remote config
      const remoteConfig = await this.getMappingConfig(configId);

      // Compare versions
      if (localConfig.version !== remoteConfig.version) {
        // console.log(`Version mismatch for config ${configId}: local=${localConfig.version}, remote=${remoteConfig.version}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error checking if update needed:', error);
      // On error, assume update is needed
      return true;
    }
  }

  /**
   * Fetch mappings for a specific configuration from API
   * @param configId The configuration ID
   * @returns Promise<MappingEntry[]> Array of mappings
   */
  async getMappingsFromAPI(configId: number): Promise<MappingEntry[]> {
    try {
      const response = await api.get(`/mappings/configs/${configId}/mappings`);

      if (!response.ok) {
        if (response.status === 422) {
          const error = await response.json();
          throw new Error(error.detail?.[0]?.msg || 'Validation error');
        }
        const error = await response.json();
        throw new Error(error.detail || `Failed to fetch mappings: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching mappings:', error);
      throw error;
    }
  }

  /**
   * Replace all mappings for a config in the database
   * @param configId The configuration ID
   * @param mappings The new mappings to store
   */
  async replaceMappings(configId: number, mappings: MappingEntry[]): Promise<void> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        await window.ipcApi.sendIpcRequest('db:replace-mappings', {
          config_id: configId,
          mappings: mappings
        });
        // console.log(`Replaced ${mappings.length} mappings for config ${configId}`);
      } catch (error) {
        console.error('Failed to replace mappings:', error);
        throw error;
      }
    }
  }

  /**
   * Get stored mappings from local database
   * @param configId The configuration ID
   * @returns The stored mappings if available
   */
  async getStoredMappings(configId: number): Promise<MappingEntry[]> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const stored = await window.ipcApi.sendIpcRequest('db:get-mappings', { config_id: configId });
        // IPC handlers return { success: true, data: ... }
        return stored?.data || [];
      } catch (error) {
        // console.warn('Failed to get stored mappings:', error);
        return [];
      }
    }
    return [];
  }

  /**
   * Check if mappings exist for a configuration
   * @param configId The configuration ID
   * @returns true if mappings exist, false otherwise
   */
  async hasMappings(configId: number): Promise<boolean> {
    const mappings = await this.getStoredMappings(configId);
    return mappings.length > 0;
  }

  /**
   * Sync mapping configuration and mappings: fetch from API and store locally if needed
   * @param configId The configuration ID
   * @returns The synced mapping configuration
   */
  async syncMappingConfig(configId: number): Promise<MappingConfigResponse> {
    try {
      // First check if we have the config stored locally
      const localConfig = await this.getStoredMappingConfig(configId);

      // Get remote config to compare versions
      const remoteConfig = await this.getMappingConfig(configId);

      let needsMappingUpdate = false;

      if (!localConfig) {
        await this.storeMappingConfig(remoteConfig);
        needsMappingUpdate = true;
      } else if (localConfig.version !== remoteConfig.version) {
        await this.storeMappingConfig(remoteConfig);
        needsMappingUpdate = true;
      } else {
        // Config versions match, check if we have mappings
        const hasMappingsStored = await this.hasMappings(configId);
        if (!hasMappingsStored) {
          needsMappingUpdate = true;
        }
      }

      // Download and replace mappings if needed
      if (needsMappingUpdate) {
        // console.log(`Downloading mappings for config ${configId}...`);
        const mappings = await this.getMappingsFromAPI(configId);
        // console.log(`Downloaded ${mappings.length} mappings, replacing in database...`);
        await this.replaceMappings(configId, mappings);
        // console.log(`Successfully synced mappings for config ${configId}`);
      } else {
        // console.log(`Mappings for config ${configId} are up to date`);
      }

      return remoteConfig;
    } catch (error) {
      console.error('Error syncing mapping config:', error);
      throw error;
    }
  }

  /**
   * Get mapping count for a configuration
   * @param configId The configuration ID
   * @returns The number of mappings stored
   */
  async getMappingCount(configId: number): Promise<number> {
    const mappings = await this.getStoredMappings(configId);
    return mappings.length;
  }

  /**
   * Get all stored mapping configs from local database
   * @returns Array of stored mapping configurations
   */
  async getAllStoredMappingConfigs(): Promise<MappingConfigResponse[]> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const response = await window.ipcApi.sendIpcRequest('db:get-all-mapping-configs');
        // console.log('getAllStoredMappingConfigs response:', response);
        // IPC handlers return { success: true, data: ... }
        const configs = response?.data || [];
        // console.log('Extracted configs:', configs);
        return configs;
      } catch (error) {
        // console.warn('Failed to get all stored mapping configs:', error);
        return [];
      }
    }
    return [];
  }

  /**
   * Get pending mappings from API
   * @param configId Optional configuration ID to filter by
   * @returns Promise<MappingEntry[]> Array of pending mappings
   */
  async getPendingMappingsFromAPI(configId?: number): Promise<MappingEntry[]> {
    try {
      let endpoint = `/mappings/mappings/pending`;
      if (configId !== undefined) {
        endpoint += `?config_id=${configId}`;
      }

      const response = await api.get(endpoint);

      if (!response.ok) {
        if (response.status === 422) {
          const error = await response.json();
          throw new Error(error.detail?.[0]?.msg || 'Validation error');
        }
        const error = await response.json();
        throw new Error(error.detail || `Failed to fetch pending mappings: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching pending mappings:', error);
      throw error;
    }
  }

  /**
   * Approve or reject a mapping via API
   * @param mappingId The mapping ID to approve/reject
   * @param approvalRequest The approval request data
   * @returns Promise<MappingEntry> The updated mapping
   */
  async approveMapping(mappingId: number, approvalRequest: MappingApprovalRequest): Promise<MappingEntry> {
    try {
      const response = await api.post(`/mappings/mappings/${mappingId}/approve`, approvalRequest);

      if (!response.ok) {
        if (response.status === 422) {
          const error = await response.json();
          throw new Error(error.detail?.[0]?.msg || 'Validation error');
        }
        const error = await response.json();
        throw new Error(error.detail || `Failed to approve mapping: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error approving mapping:', error);
      throw error;
    }
  }

  /**
   * Get mappings by approval status from local database
   * @param configId Optional configuration ID to filter by
   * @param approvalStatus The approval status to filter by
   * @returns Promise<MappingEntry[]> Array of mappings with the specified status
   */
  async getStoredMappingsByApprovalStatus(
    configId: number | null,
    approvalStatus: ApprovalStatus
  ): Promise<MappingEntry[]> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const stored = await window.ipcApi.sendIpcRequest('db:get-mappings-by-approval-status', {
          config_id: configId,
          approval_status: approvalStatus
        });
        return stored?.data || [];
      } catch (error) {
        console.error('Failed to get stored mappings by approval status:', error);
        return [];
      }
    }
    return [];
  }

  /**
   * Update mapping approval status in local database
   * @param mappingId The mapping ID
   * @param approvalStatus The new approval status
   * @param approvedBy The user who approved/rejected
   */
  async updateLocalMappingApprovalStatus(
    mappingId: number,
    approvalStatus: ApprovalStatus,
    approvedBy: string | null
  ): Promise<void> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        await window.ipcApi.sendIpcRequest('db:update-mapping-approval-status', {
          mapping_id: mappingId,
          approval_status: approvalStatus,
          approved_by: approvedBy
        });
      } catch (error) {
        console.error('Failed to update local mapping approval status:', error);
        throw error;
      }
    }
  }

  /**
   * Create a new mapping request via API
   * @param configId The configuration ID to add the mapping to
   * @param mappingData The mapping data to create
   * @returns Promise<MappingEntry> The created mapping (with PENDING_APPROVAL status)
   */
  async createMapping(configId: number, mappingData: CreateMappingRequest): Promise<MappingEntry> {
    try {
      const response = await api.post(`/mappings/configs/${configId}/mappings`, mappingData);

      if (!response.ok) {
        if (response.status === 422) {
          const error = await response.json();
          throw new Error(error.detail?.[0]?.msg || 'Validation error');
        }
        const error = await response.json();
        throw new Error(error.detail || `Failed to create mapping: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error creating mapping:', error);
      throw error;
    }
  }

}

export default new MappingConfigService();