/**
 * Validation Service
 * ==================
 *
 * Frontend service for interacting with the validation system.
 * Fetches validation metadata from the API and executes validations via IPC.
 *
 * Flow:
 * 1. API returns validation metadata (name, display_name, is_required, etc.)
 * 2. The 'name' field is used to look up the validation function locally
 * 3. Validation functions are defined in validationDefinitions.ts
 */

import api from './api';

// Types for Validations from API
export interface Validation {
  id: number;
  name: string;
  display_name: string;
  is_required: boolean;
  description: string;
  ou: string;
  sequence: number;
}

class ValidationService {
  /**
   * Get list of locally registered validation names
   * Useful for debugging/verifying which validations are available
   * @returns Promise with array of validation names
   */
  async getRegisteredValidationNames(): Promise<string[]> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const result = await window.ipcApi.sendIpcRequest('validation:get-all', {});
        return result?.data || [];
      } catch (error) {
        console.error('Failed to get registered validations:', error);
        return [];
      }
    }
    return [];
  }

  /**
   * Check if a validation is registered locally
   * @param validationName The name of the validation to check
   * @returns Promise with boolean indicating if validation exists
   */
  async isValidationRegistered(validationName: string): Promise<boolean> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const result = await window.ipcApi.sendIpcRequest('validation:check-exists', { validationName });
        return result?.data?.exists || false;
      } catch (error) {
        console.error('Failed to check validation:', error);
        return false;
      }
    }
    return false;
  }

  /**
   * Fetch validations metadata from API (if you want API-configured validations)
   * This returns the list of validations configured in the backend
   * @param ou The organizational unit (hotel) identifier
   * @returns Promise<Validation[]> Array of validations from API
   */
  async getValidations(ou: string): Promise<Validation[]> {
    const response = await api.get(`/validations/ou/${ou}`);

    if (!response.ok) {
      if (response.status === 422) {
        const error = await response.json();
        throw new Error(error.detail?.[0]?.msg || 'Validation error');
      }
      const error = await response.json();
      throw new Error(error.detail || 'Failed to fetch validations');
    }

    return await response.json();
  }

  /**
   * Cache validations locally for offline access
   * @param ou The organizational unit
   * @param validations The validations to cache
   */
  async cacheValidations(ou: string, validations: Validation[]): Promise<void> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        await window.ipcApi.sendIpcRequest('db:store-validations', {
          ou,
          validations
        });
        // console.log('Validations cached successfully');
      } catch (cacheError) {
        // console.warn('Failed to cache validations:', cacheError);
      }
    }
  }

  /**
   * Get cached validations for offline access
   * @param ou The organizational unit
   * @returns Cached validations if available
   */
  async getCachedValidations(ou: string): Promise<Validation[] | null> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const cached = await window.ipcApi.sendIpcRequest('db:get-validations', { ou });
        return cached?.data || null;
      } catch (error) {
        // console.warn('Failed to get cached validations:', error);
        return null;
      }
    }
    return null;
  }

  /**
   * Fetch validations and sync
   * @param ou The organizational unit
   * @param silent If true, don't throw errors (for background sync)
   * @returns Promise<Validation[]> Array of validations
   */
  async fetchAndSyncValidations(ou: string, silent: boolean = false): Promise<Validation[]> {
    try {
      // Update cache metadata to "fetching"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `validations_${ou}`,
          status: 'fetching'
        }).catch(() => {});
      }

      // Fetch validations from API
      const validations = await this.getValidations(ou);

      // Cache the validations
      await this.cacheValidations(ou, validations);

      // Update cache metadata to "success"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `validations_${ou}`,
          status: 'success'
        }).catch(() => {});
      }

      return validations;
    } catch (error) {
      console.error('Error fetching and syncing validations:', error);

      // Update cache metadata to "failed"
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:update-cache-metadata', {
          key: `validations_${ou}`,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        }).catch(() => {});
      }

      // Try to return cached data if available
      const cached = await this.getCachedValidations(ou);
      if (cached) {
        // console.log('Returning cached validations due to error');
        return cached;
      }

      if (silent) {
        return [];
      }

      throw error;
    }
  }

  /**
   * Get validations with cache-first strategy
   * Returns cached validations immediately, then fetches fresh data in background
   * @param ou The organizational unit
   * @param onUpdate Callback when fresh data arrives
   */
  async getValidationsCacheFirst(
    ou: string,
    onUpdate?: (validations: Validation[]) => void
  ): Promise<Validation[]> {
    // Get cached validations first
    const cached = await this.getCachedValidations(ou);

    // Fetch fresh data in background and call onUpdate when it arrives
    this.fetchAndSyncValidations(ou, true)
      .then(freshData => {
        if (onUpdate && JSON.stringify(cached) !== JSON.stringify(freshData)) {
          onUpdate(freshData);
        }
      })
      .catch(error => {
        console.error('Background fetch failed:', error);
      });

    return cached || [];
  }

  /**
   * Run a validation check via IPC (using the validation registry)
   * @param validationName The name of the validation to run
   * @param ou The organizational unit
   * @param period Optional period for validation
   * @returns Validation result
   */
  async runValidation(
    validationName: string,
    ou: string,
    period?: { year?: number; month?: number }
  ): Promise<{
    success: boolean;
    errors?: string[];
    warnings?: string[];
    recordCount?: number;
  }> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const result = await window.ipcApi.sendIpcRequest('validation:run', {
          validationName,
          ou,
          period
        });
        return result?.data || { success: false };
      } catch (error) {
        console.error('Failed to run validation:', error);
        throw error;
      }
    }
    throw new Error('IPC API not available');
  }

  /**
   * Run multiple validations by name
   * @param validationNames Array of validation names to run
   * @param ou The organizational unit
   * @param period Optional period for validation
   * @param stopOnFirstError Stop execution on first error
   * @returns Array of validation results
   */
  async runMultipleValidations(
    validationNames: string[],
    ou: string,
    period?: { year?: number; month?: number },
    stopOnFirstError: boolean = false
  ): Promise<any[]> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const result = await window.ipcApi.sendIpcRequest('validation:run-all', {
          validationNames,
          ou,
          period,
          stopOnFirstError
        });
        return result?.data || [];
      } catch (error) {
        console.error('Failed to run validations:', error);
        throw error;
      }
    }
    throw new Error('IPC API not available');
  }
}

export default new ValidationService();
