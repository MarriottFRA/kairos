/**
 * Daily Financial Data Sync Service
 * ==================================
 *
 * Provides a "once-per-day" check for financial data updates.
 * Only performs the check when accessing the report page.
 * Stores the last successful check date per OU in SQLite.
 * Failed checks do NOT count - allows retry on next report access.
 */

import financialDataService from './financialDataService';
import authService from './auth';

export interface DailySyncCheckResult {
  checked: boolean;       // Was a check actually performed?
  hasUpdates: boolean;    // Was new data downloaded?
  updatedPeriods: string[];
  skippedPeriods: string[];
  message: string;
  error?: string;
}

class DailyFinancialSyncService {
  // Prevent concurrent checks for the same OU
  private checkInProgress: Map<string, boolean> = new Map();

  /**
   * Get today's date in YYYY-MM-DD format (local timezone)
   */
  private getTodayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Check if we've already verified today for this OU
   */
  async hasCheckedToday(ou: string): Promise<boolean> {
    try {
      if (typeof window !== 'undefined' && window.ipcApi) {
        const response = await window.ipcApi.sendIpcRequest(
          'db:get-financial-data-last-check-date',
          { ou }
        );

        if (!response.success || !response.data) {
          return false; // Never checked or error - should check
        }

        const lastCheckDate = response.data as string;
        const today = this.getTodayDateString();

        return lastCheckDate === today;
      }
      return false;
    } catch (error) {
      console.warn('[DailyFinancialSync] Error checking last check date:', error);
      return false; // On error, allow check
    }
  }

  /**
   * Record a successful sync check
   */
  private async recordSuccessfulCheck(ou: string, checkResult: 'up_to_date' | 'updated'): Promise<void> {
    try {
      if (typeof window !== 'undefined' && window.ipcApi) {
        const today = this.getTodayDateString();
        const timestamp = new Date().toISOString();

        await window.ipcApi.sendIpcRequest('db:set-financial-data-sync-check', {
          ou,
          checkDate: today,
          checkTimestamp: timestamp,
          checkResult
        });
      }
    } catch (error) {
      console.error('[DailyFinancialSync] Error recording sync check:', error);
      // Don't throw - recording failure shouldn't break the sync
    }
  }

  /**
   * Perform the daily sync check for an OU
   *
   * Behavior:
   * - Returns immediately if already checked today (success)
   * - Returns immediately if check already in progress
   * - Returns immediately if not authenticated
   * - Performs incremental sync and records result on SUCCESS
   * - On FAILURE: does NOT record (allows retry on next access)
   */
  async performDailyCheck(ou: string): Promise<DailySyncCheckResult> {
    // Prevent concurrent checks for same OU
    if (this.checkInProgress.get(ou)) {
      return {
        checked: false,
        hasUpdates: false,
        updatedPeriods: [],
        skippedPeriods: [],
        message: 'Check already in progress'
      };
    }

    try {
      this.checkInProgress.set(ou, true);

      // Check for an active (device-verified) session. The token is owned by the
      // main process now; gate on the cached security level instead.
      if (authService.getSecurityLevel() < 2) {
        return {
          checked: false,
          hasUpdates: false,
          updatedPeriods: [],
          skippedPeriods: [],
          message: 'Not authenticated'
        };
      }

      // Check if already verified today
      const alreadyChecked = await this.hasCheckedToday(ou);
      if (alreadyChecked) {
        return {
          checked: false,
          hasUpdates: false,
          updatedPeriods: [],
          skippedPeriods: [],
          message: 'Already checked today'
        };
      }

      // Perform incremental sync (lightweight version check + download if needed)
      // console.log(`[DailyFinancialSync] Performing daily check for OU: ${ou}`);
      const result = await financialDataService.importFinancialDataIncremental(ou);

      // Record successful check
      const checkResult = result.updatedPeriods.length > 0 ? 'updated' : 'up_to_date';
      await this.recordSuccessfulCheck(ou, checkResult);

      // console.log(`[DailyFinancialSync] Check complete for OU ${ou}:`, result.message);

      return {
        checked: true,
        hasUpdates: result.updatedPeriods.length > 0,
        updatedPeriods: result.updatedPeriods,
        skippedPeriods: result.skippedPeriods,
        message: result.message
      };

    } catch (error: any) {
      console.error('[DailyFinancialSync] Check failed:', error);

      // Do NOT record failed check - allows retry on next access
      return {
        checked: false,
        hasUpdates: false,
        updatedPeriods: [],
        skippedPeriods: [],
        message: 'Check failed',
        error: error.message || 'Unknown error'
      };

    } finally {
      this.checkInProgress.set(ou, false);
    }
  }
}

export const dailyFinancialSyncService = new DailyFinancialSyncService();
export default dailyFinancialSyncService;
