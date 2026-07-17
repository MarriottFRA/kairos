import api from './api';

export interface UploadPeriod {
  id: number;
  ou: string;
  period: string;
  is_locked: boolean;
  uploaded_by: number;
  signed_by: number;
  created_at: string;
  updated_at: string;
}

class UploadPeriodsService {
  /**
   * Get upload periods for a specific OU
   * Filters out locked periods by default as they cannot be imported to
   */
  async getUploadPeriods(ou: string, includeLocked: boolean = false): Promise<UploadPeriod[]> {
    const response = await api.get(`/upload-periods/?ou=${encodeURIComponent(ou)}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get upload periods');
    }

    const periods = await response.json() as UploadPeriod[];

    // Filter out locked periods if requested
    if (!includeLocked) {
      return periods.filter(p => !p.is_locked);
    }

    return periods;
  }

  /**
   * Get available (unlocked) upload periods for a specific OU
   */
  async getAvailableUploadPeriods(ou: string): Promise<UploadPeriod[]> {
    return this.getUploadPeriods(ou, false);
  }

  /**
   * Check if a specific period is locked
   */
  async isPeriodLocked(ou: string, period: string): Promise<boolean> {
    const periods = await this.getUploadPeriods(ou, true);
    const foundPeriod = periods.find(p => p.period === period);
    return foundPeriod?.is_locked ?? false;
  }
}

export default new UploadPeriodsService();
