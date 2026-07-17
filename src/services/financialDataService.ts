import api from './api';

export interface FinancialDataRecord {
  id: number;
  ou: string;
  period: string;
  department: string;
  account: string;
  amount: number;
  scenario: 'Actuals' | 'Budget' | 'Forecast';
  version: string;
  currency: string;
  load_id: string;
  load_date: string;
}

export interface ServerPeriodVersion {
  period: string;
  last_updated: string;
}

export interface LocalPeriodVersion {
  period: string;
  last_modified: string;
}

export interface IncrementalSyncResult {
  success: boolean;
  totalCount: number;
  updatedPeriods: string[];
  skippedPeriods: string[];
  orphanedPeriods: string[];
  message: string;
}

class FinancialDataService {
  /**
   * Fetch financial data from the API for a given OU
   */
  async fetchFinancialData(ou: string): Promise<FinancialDataRecord[]> {
    const response = await api.get(`/act-bud-fcst-data/?ou=${ou}`);

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Access denied to this OU');
      }
      const error = await response.json();
      throw new Error(error.detail || 'Failed to fetch financial data');
    }

    const data = await response.json();
    return data;
  }

  /**
   * Import financial data from API and store locally
   */
  async importFinancialData(ou: string): Promise<{ success: boolean; count: number; message: string }> {
    try {
      // Fetch data from API
      const records = await this.fetchFinancialData(ou);

      if (!records || records.length === 0) {
        return {
          success: true,
          count: 0,
          message: 'No financial data found for this OU'
        };
      }

      // Store data in local database via IPC
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:store-financial-data', {
          ou,
          records
        });

        return {
          success: true,
          count: records.length,
          message: `Successfully imported ${records.length} financial records`
        };
      } else {
        throw new Error('IPC API not available');
      }
    } catch (error: any) {
      console.error('Failed to import financial data:', error);
      throw error;
    }
  }

  /**
   * Get stored financial data count for an OU
   */
  async getStoredDataCount(ou: string): Promise<number> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const response = await window.ipcApi.sendIpcRequest('db:get-financial-data-count', { ou });
        return response.data || 0;
      } catch (error) {
        // console.warn('Failed to get stored data count:', error);
        return 0;
      }
    }
    return 0;
  }

  /**
   * Get last import timestamp for an OU
   */
  async getLastImportTimestamp(ou: string): Promise<string | null> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const response = await window.ipcApi.sendIpcRequest('db:get-financial-data-last-import', { ou });
        return response.data || null;
      } catch (error) {
        // console.warn('Failed to get last import timestamp:', error);
        return null;
      }
    }
    return null;
  }

  /**
   * Fetch period version metadata from server (lightweight call)
   * Returns last_updated timestamp for each period
   */
  async fetchServerVersions(ou: string): Promise<ServerPeriodVersion[]> {
    const response = await api.get(`/act-bud-fcst-data/versions/?ou=${ou}`);

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Access denied to this OU');
      }
      const error = await response.json();
      throw new Error(error.detail || 'Failed to fetch server versions');
    }

    return await response.json();
  }

  /**
   * Fetch financial data for specific periods only
   */
  async fetchFinancialDataForPeriods(ou: string, periods: string[]): Promise<FinancialDataRecord[]> {
    const periodsParam = periods.join(',');
    const response = await api.get(`/act-bud-fcst-data/?ou=${ou}&periods=${periodsParam}`);

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Access denied to this OU');
      }
      const error = await response.json();
      throw new Error(error.detail || 'Failed to fetch financial data');
    }

    return await response.json();
  }

  /**
   * Get local period versions from SQLite
   */
  async getLocalVersions(ou: string): Promise<LocalPeriodVersion[]> {
    if (typeof window !== 'undefined' && window.ipcApi) {
      try {
        const response = await window.ipcApi.sendIpcRequest('db:get-financial-data-local-versions', { ou });
        return response.data || [];
      } catch (error) {
        console.warn('Failed to get local versions:', error);
        return [];
      }
    }
    return [];
  }

  /**
   * Incremental sync: Compare server vs local versions and only fetch changed periods
   */
  async importFinancialDataIncremental(ou: string): Promise<IncrementalSyncResult> {
    try {
      // 1. Fetch server versions (lightweight metadata call)
      const serverVersions = await this.fetchServerVersions(ou);

      if (!serverVersions || serverVersions.length === 0) {
        // Server authoritatively reports zero periods for this OU.
        // Treat every local period as an orphan and remove via the same
        // per-period delete path used in the normal reconciliation branch.
        // Staging is untouched — getLocalVersions only reads financial_data.
        const localVersions = await this.getLocalVersions(ou);
        const orphanPeriods = localVersions.map(v => v.period);
        if (orphanPeriods.length > 0 && typeof window !== 'undefined' && window.ipcApi) {
          await window.ipcApi.sendIpcRequest('db:delete-synced-financial-data-for-periods', {
            ou,
            periods: orphanPeriods
          });
        }
        return {
          success: true,
          totalCount: 0,
          updatedPeriods: [],
          skippedPeriods: [],
          orphanedPeriods: orphanPeriods,
          message: orphanPeriods.length > 0
            ? `Remote OU has no periods. Removed ${orphanPeriods.length} local period(s). Staging untouched.`
            : 'No financial data on server and nothing local to reconcile.'
        };
      }

      // 2. Get local versions
      const localVersions = await this.getLocalVersions(ou);
      const localVersionMap = new Map(
        localVersions.map(v => [v.period, v.last_modified])
      );

      // 3. Compare and find outdated periods
      const outdatedPeriods: string[] = [];
      const skippedPeriods: string[] = [];

      for (const serverVersion of serverVersions) {
        const localLastModified = localVersionMap.get(serverVersion.period);

        if (!localLastModified) {
          // Period doesn't exist locally, needs to be fetched
          outdatedPeriods.push(serverVersion.period);
        } else if (serverVersion.last_updated !== localLastModified) {
          // Both values originate from the server and are stored verbatim,
          // so byte-equality is the honest check. Any divergence — server
          // newer, local newer, or any other mismatch — means state has
          // drifted and the period should be refetched. This pairs with the
          // orphan-period deletion above to give full bidirectional
          // reconciliation, removing the need for users to guess and hit
          // a manual force-reset.
          outdatedPeriods.push(serverVersion.period);
        } else {
          skippedPeriods.push(serverVersion.period);
        }
      }

      // 3b. Detect orphan periods: present locally, absent from server manifest.
      // Absence in the manifest is the deletion signal — there are no tombstones.
      // Staging is structurally invisible here (localVersionMap comes from
      // financial_data only).
      const serverPeriodSet = new Set(serverVersions.map(v => v.period));
      const orphanPeriods = [...localVersionMap.keys()].filter(p => !serverPeriodSet.has(p));
      if (orphanPeriods.length > 0 && typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:delete-synced-financial-data-for-periods', {
          ou,
          periods: orphanPeriods
        });
      }

      // 4. If nothing to update, return early
      if (outdatedPeriods.length === 0) {
        const orphanNote = orphanPeriods.length > 0
          ? ` Removed ${orphanPeriods.length} orphan period(s).`
          : '';
        return {
          success: true,
          totalCount: 0,
          updatedPeriods: [],
          skippedPeriods,
          orphanedPeriods: orphanPeriods,
          message: `All periods are up to date.${orphanNote}`
        };
      }

      // 5. Fetch only the outdated periods
      const records = await this.fetchFinancialDataForPeriods(ou, outdatedPeriods);

      if (!records || records.length === 0) {
        return {
          success: true,
          totalCount: 0,
          updatedPeriods: outdatedPeriods,
          skippedPeriods,
          orphanedPeriods: orphanPeriods,
          message: `No records found for ${outdatedPeriods.length} period(s)`
        };
      }

      // 6. Store data for specific periods via IPC
      if (typeof window !== 'undefined' && window.ipcApi) {
        await window.ipcApi.sendIpcRequest('db:store-financial-data-for-periods', {
          ou,
          records,
          periods: outdatedPeriods
        });

        return {
          success: true,
          totalCount: records.length,
          updatedPeriods: outdatedPeriods,
          skippedPeriods,
          orphanedPeriods: orphanPeriods,
          message: `Updated ${outdatedPeriods.length} period(s) with ${records.length} records. Skipped ${skippedPeriods.length} up-to-date period(s).${orphanPeriods.length > 0 ? ` Removed ${orphanPeriods.length} orphan period(s).` : ''}`
        };
      } else {
        throw new Error('IPC API not available');
      }
    } catch (error: any) {
      console.error('Failed to perform incremental sync:', error);
      throw error;
    }
  }

  /**
   * Full import (original behavior) - use when incremental fails or for initial load
   */
  async importFinancialDataFull(ou: string): Promise<{ success: boolean; count: number; message: string }> {
    return this.importFinancialData(ou);
  }
}

export default new FinancialDataService();
