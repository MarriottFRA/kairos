/**
 * Centralized Settings Service
 * Handles all app settings persistence with SQLite database
 * Provides a modular and scalable approach for settings management
 */

import { ThemeMode } from "../theme/settings";

// UI scale mode: "auto" fits the scale to the app window size; "manual" uses a saved factor
export type UiScaleMode = "auto" | "manual";

// Define all possible settings keys as a const enum for type safety
export const SETTINGS_KEYS = {
  THEME_MODE: 'themeMode',
  UI_SCALE_MODE: 'uiScaleMode',
  UI_SCALE: 'uiScale',
  SELECTED_HOTEL_OU: 'selectedHotelOu',
  SELECTED_DEPARTMENT: 'selectedDepartment',
  SELECTED_ACCOUNT: 'selectedAccount',
  SELECTED_PERIOD: 'selectedPeriod',
  SELECTED_SCENARIO: 'selectedScenario',
  AUTO_SAVE: 'autoSave',
  NOTIFICATION_ENABLED: 'notificationEnabled',
  LANGUAGE: 'language',
  CURRENCY: 'currency',
  DATE_FORMAT: 'dateFormat',
  NUMBER_FORMAT: 'numberFormat',
  FINANCIAL_DATA_VERSION: 'financialDataVersion',
  // Excel export settings
  EXCEL_EXPORT_SELECTED_MONTH: 'excelExportSelectedMonth',
  EXCEL_EXPORT_SELECTED_YEAR: 'excelExportSelectedYear',
  EXCEL_EXPORT_YTD_START_MONTH: 'excelExportYtdStartMonth',
  EXCEL_EXPORT_YTD_START_YEAR: 'excelExportYtdStartYear',
  EXCEL_EXPORT_YTD_END_MONTH: 'excelExportYtdEndMonth',
  EXCEL_EXPORT_YTD_END_YEAR: 'excelExportYtdEndYear',
  // Protea Report Pack settings
  PROTEA_REPORT_PACK_SELECTED_MONTH: 'proteaReportPackSelectedMonth',
  PROTEA_REPORT_PACK_SELECTED_YEAR: 'proteaReportPackSelectedYear',
  PROTEA_REPORT_PACK_YTD_START_MONTH: 'proteaReportPackYtdStartMonth',
  PROTEA_REPORT_PACK_YTD_START_YEAR: 'proteaReportPackYtdStartYear',
  PROTEA_REPORT_PACK_YTD_END_MONTH: 'proteaReportPackYtdEndMonth',
  PROTEA_REPORT_PACK_YTD_END_YEAR: 'proteaReportPackYtdEndYear',
  // Protea Budget Pack settings
  PROTEA_BUDGET_PACK_START_MONTH: 'proteaBudgetPackStartMonth',
  PROTEA_BUDGET_PACK_START_YEAR: 'proteaBudgetPackStartYear',
  PROTEA_BUDGET_PACK_END_MONTH: 'proteaBudgetPackEndMonth',
  PROTEA_BUDGET_PACK_END_YEAR: 'proteaBudgetPackEndYear',
  // Shared report settings
  INCLUDE_DETAIL_BREAKDOWN: 'includeDetailBreakdown',
  INCLUDE_BANQUETING_BREAKDOWN: 'includeBanquetingBreakdown',
} as const;

export type SettingsKey = typeof SETTINGS_KEYS[keyof typeof SETTINGS_KEYS];

// Define the shape of all settings with their types
export interface AppSettings {
  [SETTINGS_KEYS.THEME_MODE]: ThemeMode;
  [SETTINGS_KEYS.UI_SCALE_MODE]: UiScaleMode;
  [SETTINGS_KEYS.UI_SCALE]: number;
  [SETTINGS_KEYS.SELECTED_HOTEL_OU]: string | null;
  [SETTINGS_KEYS.SELECTED_DEPARTMENT]: string | null;
  [SETTINGS_KEYS.SELECTED_ACCOUNT]: string | null;
  [SETTINGS_KEYS.SELECTED_PERIOD]: string | null;
  [SETTINGS_KEYS.SELECTED_SCENARIO]: string | null;
  [SETTINGS_KEYS.AUTO_SAVE]: boolean;
  [SETTINGS_KEYS.NOTIFICATION_ENABLED]: boolean;
  [SETTINGS_KEYS.LANGUAGE]: string;
  [SETTINGS_KEYS.CURRENCY]: string;
  [SETTINGS_KEYS.DATE_FORMAT]: string;
  [SETTINGS_KEYS.NUMBER_FORMAT]: string;
  [SETTINGS_KEYS.FINANCIAL_DATA_VERSION]: string;
  // Excel export settings
  [SETTINGS_KEYS.EXCEL_EXPORT_SELECTED_MONTH]: number;
  [SETTINGS_KEYS.EXCEL_EXPORT_SELECTED_YEAR]: number;
  [SETTINGS_KEYS.EXCEL_EXPORT_YTD_START_MONTH]: number;
  [SETTINGS_KEYS.EXCEL_EXPORT_YTD_START_YEAR]: number;
  [SETTINGS_KEYS.EXCEL_EXPORT_YTD_END_MONTH]: number;
  [SETTINGS_KEYS.EXCEL_EXPORT_YTD_END_YEAR]: number;
  // Protea Report Pack settings
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_SELECTED_MONTH]: number;
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_SELECTED_YEAR]: number;
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_START_MONTH]: number;
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_START_YEAR]: number;
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_END_MONTH]: number;
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_END_YEAR]: number;
  // Protea Budget Pack settings
  [SETTINGS_KEYS.PROTEA_BUDGET_PACK_START_MONTH]: number;
  [SETTINGS_KEYS.PROTEA_BUDGET_PACK_START_YEAR]: number;
  [SETTINGS_KEYS.PROTEA_BUDGET_PACK_END_MONTH]: number;
  [SETTINGS_KEYS.PROTEA_BUDGET_PACK_END_YEAR]: number;
  // Shared report settings
  [SETTINGS_KEYS.INCLUDE_DETAIL_BREAKDOWN]: boolean;
  [SETTINGS_KEYS.INCLUDE_BANQUETING_BREAKDOWN]: boolean;
}

// Default values for all settings
const currentYear = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;

export const DEFAULT_SETTINGS: AppSettings = {
  [SETTINGS_KEYS.THEME_MODE]: "light",
  // Default to native 100% (manual @ 1.0): full fidelity and no fractional-zoom
  // compositing cost. "auto" (fit-to-window) remains an opt-in the user can enable.
  [SETTINGS_KEYS.UI_SCALE_MODE]: "manual",
  [SETTINGS_KEYS.UI_SCALE]: 1.0,
  [SETTINGS_KEYS.SELECTED_HOTEL_OU]: null,
  [SETTINGS_KEYS.SELECTED_DEPARTMENT]: null,
  [SETTINGS_KEYS.SELECTED_ACCOUNT]: null,
  [SETTINGS_KEYS.SELECTED_PERIOD]: null,
  [SETTINGS_KEYS.SELECTED_SCENARIO]: "ACT",
  [SETTINGS_KEYS.AUTO_SAVE]: true,
  [SETTINGS_KEYS.NOTIFICATION_ENABLED]: true,
  [SETTINGS_KEYS.LANGUAGE]: "en",
  [SETTINGS_KEYS.CURRENCY]: "USD",
  [SETTINGS_KEYS.DATE_FORMAT]: "MM/DD/YYYY",
  [SETTINGS_KEYS.NUMBER_FORMAT]: "1,234.56",
  [SETTINGS_KEYS.FINANCIAL_DATA_VERSION]: "MAIN",
  // Excel export defaults
  [SETTINGS_KEYS.EXCEL_EXPORT_SELECTED_MONTH]: currentMonth,
  [SETTINGS_KEYS.EXCEL_EXPORT_SELECTED_YEAR]: currentYear,
  [SETTINGS_KEYS.EXCEL_EXPORT_YTD_START_MONTH]: 1,
  [SETTINGS_KEYS.EXCEL_EXPORT_YTD_START_YEAR]: currentYear,
  [SETTINGS_KEYS.EXCEL_EXPORT_YTD_END_MONTH]: currentMonth,
  [SETTINGS_KEYS.EXCEL_EXPORT_YTD_END_YEAR]: currentYear,
  // Protea Report Pack defaults
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_SELECTED_MONTH]: currentMonth,
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_SELECTED_YEAR]: currentYear,
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_START_MONTH]: 1,
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_START_YEAR]: currentYear,
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_END_MONTH]: currentMonth,
  [SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_END_YEAR]: currentYear,
  // Protea Budget Pack defaults (next year since budget packs review future budgets)
  [SETTINGS_KEYS.PROTEA_BUDGET_PACK_START_MONTH]: 1,
  [SETTINGS_KEYS.PROTEA_BUDGET_PACK_START_YEAR]: currentYear + 1,
  [SETTINGS_KEYS.PROTEA_BUDGET_PACK_END_MONTH]: 12,
  [SETTINGS_KEYS.PROTEA_BUDGET_PACK_END_YEAR]: currentYear + 1,
  // Shared report settings
  [SETTINGS_KEYS.INCLUDE_DETAIL_BREAKDOWN]: false,
  [SETTINGS_KEYS.INCLUDE_BANQUETING_BREAKDOWN]: false,
};

// Type-safe partial settings for updates
export type PartialSettings = Partial<AppSettings>;

class SettingsService {
  private cache: Map<SettingsKey, any> = new Map();
  private initialized = false;
  private syncQueue: Set<SettingsKey> = new Set();
  private ipcApi: any = null;

  constructor() {
    // Initialize IPC API reference
    if (typeof window !== 'undefined') {
      this.ipcApi = (window as any)?.ipcApi;
    }
  }

  /**
   * Initialize the settings service by loading all settings from database
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const allSettings = await this.loadAllSettings();
      // Populate cache with loaded settings or defaults
      Object.entries(DEFAULT_SETTINGS).forEach(([key, defaultValue]) => {
        const loadedValue = allSettings[key];
        this.cache.set(key as SettingsKey, loadedValue !== undefined ? loadedValue : defaultValue);
      });
      this.initialized = true;
      // console.log('Settings service initialized with:', this.cache);
    } catch (error) {
      console.error('Failed to initialize settings service:', error);
      // Use defaults on error
      Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => {
        this.cache.set(key as SettingsKey, value);
      });
      this.initialized = true;
    }
  }

  /**
   * Get a single setting value
   */
  async getSetting<K extends SettingsKey>(key: K): Promise<AppSettings[K]> {
    // Ensure service is initialized
    if (!this.initialized) {
      await this.initialize();
    }

    // Check cache first
    if (this.cache.has(key)) {
      return this.cache.get(key) as AppSettings[K];
    }

    // If not in cache, load from database
    try {
      const value = await this.loadSetting(key);
      if (value !== undefined) {
        this.cache.set(key, value);
        return value as AppSettings[K];
      }
    } catch (error) {
      console.error(`Failed to load setting ${key}:`, error);
    }

    // Return default if all else fails
    return DEFAULT_SETTINGS[key] as AppSettings[K];
  }

  /**
   * Get multiple settings at once
   */
  async getSettings<K extends SettingsKey>(...keys: K[]): Promise<Pick<AppSettings, K>> {
    const result = {} as Pick<AppSettings, K>;

    for (const key of keys) {
      result[key] = await this.getSetting(key);
    }

    return result;
  }

  /**
   * Get all settings
   */
  async getAllSettings(): Promise<AppSettings> {
    if (!this.initialized) {
      await this.initialize();
    }

    const settings = {} as AppSettings;
    for (const key of Object.values(SETTINGS_KEYS)) {
      // Writing through a union-typed key narrows the target to `never`; the
      // value is correct by construction since `key` indexes AppSettings.
      (settings as Record<SettingsKey, unknown>)[key as SettingsKey] =
        await this.getSetting(key as SettingsKey);
    }
    return settings;
  }

  /**
   * Set a single setting value
   */
  async setSetting<K extends SettingsKey>(key: K, value: AppSettings[K]): Promise<void> {
    // Update cache immediately for responsive UI
    this.cache.set(key, value);

    // Save to database
    try {
      await this.saveSetting(key, value);
      // console.log(`Setting ${key} saved:`, value);
    } catch (error) {
      console.error(`Failed to save setting ${key}:`, error);
      // Add to sync queue for retry
      this.syncQueue.add(key);
      throw error;
    }
  }

  /**
   * Set multiple settings at once
   */
  async setSettings(settings: PartialSettings): Promise<void> {
    // Update cache immediately
    Object.entries(settings).forEach(([key, value]) => {
      if (value !== undefined) {
        this.cache.set(key as SettingsKey, value);
      }
    });

    // Save to database
    try {
      await this.saveSettings(settings);
      // console.log('Settings saved:', settings);
    } catch (error) {
      console.error('Failed to save settings:', error);
      // Add to sync queue for retry
      Object.keys(settings).forEach(key => this.syncQueue.add(key as SettingsKey));
      throw error;
    }
  }

  /**
   * Reset a setting to its default value
   */
  async resetSetting<K extends SettingsKey>(key: K): Promise<void> {
    const defaultValue = DEFAULT_SETTINGS[key];
    await this.setSetting(key, defaultValue);
  }

  /**
   * Reset all settings to defaults
   */
  async resetAllSettings(): Promise<void> {
    await this.setSettings(DEFAULT_SETTINGS);
  }

  /**
   * Load a single setting from database
   */
  private async loadSetting(key: string): Promise<any> {
    if (!this.ipcApi?.sendIpcRequest) {
      throw new Error('IPC API not available');
    }

    const response = await this.ipcApi.sendIpcRequest('settings-get-single', { key });
    if (response?.success && response.data !== undefined) {
      return response.data;
    }
    return undefined;
  }

  /**
   * Load all settings from database
   */
  private async loadAllSettings(): Promise<Record<string, any>> {
    if (!this.ipcApi?.sendIpcRequest) {
      // console.warn('IPC API not available, using defaults');
      return {};
    }

    try {
      const response = await this.ipcApi.sendIpcRequest('settings-get-all');
      if (response?.success && response.data) {
        return response.data;
      }
    } catch (error) {
      console.error('Failed to load settings from database:', error);
    }
    return {};
  }

  /**
   * Save a single setting to database
   */
  private async saveSetting(key: string, value: any): Promise<void> {
    if (!this.ipcApi?.sendIpcRequest) {
      throw new Error('IPC API not available');
    }

    const response = await this.ipcApi.sendIpcRequest('settings-set-single', { key, value });
    if (!response?.success) {
      throw new Error(`Failed to save setting ${key}`);
    }
  }

  /**
   * Save multiple settings to database
   */
  private async saveSettings(settings: Record<string, any>): Promise<void> {
    if (!this.ipcApi?.sendIpcRequest) {
      throw new Error('IPC API not available');
    }

    const response = await this.ipcApi.sendIpcRequest('settings-set-bulk', settings);
    if (!response?.success) {
      throw new Error('Failed to save settings');
    }
  }

  /**
   * Sync any queued settings to database (for retry logic)
   */
  async syncPendingSettings(): Promise<void> {
    if (this.syncQueue.size === 0) {
      return;
    }

    const pending = Array.from(this.syncQueue);
    const settings: PartialSettings = {};

    for (const key of pending) {
      if (this.cache.has(key)) {
        // See getAllSettings: union-keyed writes need the widened target.
        (settings as Record<SettingsKey, unknown>)[key] = this.cache.get(key);
      }
    }

    try {
      await this.saveSettings(settings);
      this.syncQueue.clear();
      // console.log('Synced pending settings:', settings);
    } catch (error) {
      console.error('Failed to sync pending settings:', error);
    }
  }

  /**
   * Subscribe to setting changes (for future implementation)
   */
  subscribe(key: SettingsKey, callback: (value: any) => void): () => void {
    // TODO: Implement subscription mechanism for real-time updates
    return () => {};
  }

  /**
   * Prepare settings for cloud sync (for future implementation)
   */
  async prepareForCloudSync(): Promise<Record<string, any>> {
    const allSettings = await this.getAllSettings();
    return {
      ...allSettings,
      lastModified: new Date().toISOString(),
      deviceId: await this.getDeviceId(),
    };
  }

  /**
   * Get or generate a unique device ID for cloud sync
   */
  private async getDeviceId(): Promise<string> {
    // TODO: Implement proper device ID generation and storage
    return 'local-device-' + Date.now();
  }
}

// Export singleton instance
export const settingsService = new SettingsService();

// Export convenience functions for common operations
export const getSetting = settingsService.getSetting.bind(settingsService);
export const setSetting = settingsService.setSetting.bind(settingsService);
export const getSettings = settingsService.getSettings.bind(settingsService);
export const setSettings = settingsService.setSettings.bind(settingsService);
export const getAllSettings = settingsService.getAllSettings.bind(settingsService);
export const resetSetting = settingsService.resetSetting.bind(settingsService);
export const resetAllSettings = settingsService.resetAllSettings.bind(settingsService);
export const initializeSettings = settingsService.initialize.bind(settingsService);