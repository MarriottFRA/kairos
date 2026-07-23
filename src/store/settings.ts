import { create } from "zustand";
import { ThemeMode } from "../theme/settings";
import { settingsService, SETTINGS_KEYS, AppSettings, PartialSettings, UiScaleMode } from "../services/settingsService";

type SettingsState = {
  // Settings values
  themeMode: ThemeMode;
  uiScaleMode: UiScaleMode;
  uiScale: number;
  selectedHotelOu: string | null;
  selectedDepartment: string | null;
  selectedAccount: string | null;
  selectedPeriod: string | null;
  selectedScenario: string | null;
  autoSave: boolean;
  notificationEnabled: boolean;
  language: string;
  currency: string;
  dateFormat: string;
  numberFormat: string;
  financialDataVersion: string;
  // Excel export settings
  excelExportSelectedMonth: number;
  excelExportSelectedYear: number;
  excelExportYtdStartMonth: number;
  excelExportYtdStartYear: number;
  excelExportYtdEndMonth: number;
  excelExportYtdEndYear: number;
  // Protea Report Pack settings
  proteaReportPackSelectedMonth: number;
  proteaReportPackSelectedYear: number;
  proteaReportPackYtdStartMonth: number;
  proteaReportPackYtdStartYear: number;
  proteaReportPackYtdEndMonth: number;
  proteaReportPackYtdEndYear: number;
  // Protea Budget Pack settings
  proteaBudgetPackStartMonth: number;
  proteaBudgetPackStartYear: number;
  proteaBudgetPackEndMonth: number;
  proteaBudgetPackEndYear: number;
  // Shared report settings
  includeDetailBreakdown: boolean;
  includeBanquetingBreakdown: boolean;
  // Planning context (set on the Home page, read everywhere else)
  budgetYear: number;
  planningScenarioId: string;

  // Loading state
  loading: boolean;
  initialized: boolean;

  // Actions
  toggleTheme: () => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setUiScale: (factor: number) => Promise<void>;
  setUiScaleMode: (mode: UiScaleMode) => Promise<void>;
  resetUiScaleToAuto: () => Promise<void>;
  setSelectedHotelOu: (ou: string | null) => Promise<void>;
  setSelectedDepartment: (dept: string | null) => Promise<void>;
  setSelectedAccount: (account: string | null) => Promise<void>;
  setSelectedPeriod: (period: string | null) => Promise<void>;
  setSelectedScenario: (scenario: string | null) => Promise<void>;
  setAutoSave: (enabled: boolean) => Promise<void>;
  setNotificationEnabled: (enabled: boolean) => Promise<void>;
  setLanguage: (language: string) => Promise<void>;
  setCurrency: (currency: string) => Promise<void>;
  setDateFormat: (format: string) => Promise<void>;
  setNumberFormat: (format: string) => Promise<void>;
  setFinancialDataVersion: (version: string) => Promise<void>;
  // Excel export setters
  setExcelExportSelectedMonth: (month: number) => Promise<void>;
  setExcelExportSelectedYear: (year: number) => Promise<void>;
  setExcelExportYtdStartMonth: (month: number) => Promise<void>;
  setExcelExportYtdStartYear: (year: number) => Promise<void>;
  setExcelExportYtdEndMonth: (month: number) => Promise<void>;
  setExcelExportYtdEndYear: (year: number) => Promise<void>;
  // Protea Report Pack setters
  setProteaReportPackSelectedMonth: (month: number) => Promise<void>;
  setProteaReportPackSelectedYear: (year: number) => Promise<void>;
  setProteaReportPackYtdStartMonth: (month: number) => Promise<void>;
  setProteaReportPackYtdStartYear: (year: number) => Promise<void>;
  setProteaReportPackYtdEndMonth: (month: number) => Promise<void>;
  setProteaReportPackYtdEndYear: (year: number) => Promise<void>;
  // Protea Budget Pack setters
  setProteaBudgetPackStartMonth: (month: number) => Promise<void>;
  setProteaBudgetPackStartYear: (year: number) => Promise<void>;
  setProteaBudgetPackEndMonth: (month: number) => Promise<void>;
  setProteaBudgetPackEndYear: (year: number) => Promise<void>;
  // Shared report setters
  setIncludeDetailBreakdown: (enabled: boolean) => Promise<void>;
  setIncludeBanquetingBreakdown: (enabled: boolean) => Promise<void>;
  // Planning context setters
  setBudgetYear: (year: number) => Promise<void>;
  setPlanningScenarioId: (scenarioId: string) => Promise<void>;
  updateMultipleSettings: (settings: Partial<AppSettings>) => Promise<void>;

  // Load and save
  loadSettingsFromDb: () => Promise<void>;
  saveSettingsToDb: () => Promise<void>;
  resetAllSettings: () => Promise<void>;
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  // Initial state - will be overwritten when settings are loaded
  themeMode: "light",
  uiScaleMode: "manual",
  uiScale: 1.0,
  selectedHotelOu: null,
  selectedDepartment: null,
  selectedAccount: null,
  selectedPeriod: null,
  selectedScenario: "ACT",
  autoSave: true,
  notificationEnabled: true,
  language: "en",
  currency: "USD",
  dateFormat: "MM/DD/YYYY",
  numberFormat: "1,234.56",
  financialDataVersion: "MAIN",
  // Excel export defaults
  excelExportSelectedMonth: new Date().getMonth() + 1,
  excelExportSelectedYear: new Date().getFullYear(),
  excelExportYtdStartMonth: 1,
  excelExportYtdStartYear: new Date().getFullYear(),
  excelExportYtdEndMonth: new Date().getMonth() + 1,
  excelExportYtdEndYear: new Date().getFullYear(),
  // Protea Report Pack defaults
  proteaReportPackSelectedMonth: new Date().getMonth() + 1,
  proteaReportPackSelectedYear: new Date().getFullYear(),
  proteaReportPackYtdStartMonth: 1,
  proteaReportPackYtdStartYear: new Date().getFullYear(),
  proteaReportPackYtdEndMonth: new Date().getMonth() + 1,
  proteaReportPackYtdEndYear: new Date().getFullYear(),
  // Protea Budget Pack defaults (next year since budget packs review future budgets)
  proteaBudgetPackStartMonth: 1,
  proteaBudgetPackStartYear: new Date().getFullYear() + 1,
  proteaBudgetPackEndMonth: 12,
  proteaBudgetPackEndYear: new Date().getFullYear() + 1,
  // Shared report defaults
  includeDetailBreakdown: false,
  includeBanquetingBreakdown: false,
  // Planning context defaults
  budgetYear: new Date().getFullYear(),
  planningScenarioId: "",
  loading: false,
  initialized: false,

  // Theme actions
  toggleTheme: async () => {
    const current = get().themeMode;
    const next = current === "light" ? "dark" : "light";
    set({ themeMode: next });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.THEME_MODE, next);
    } catch (error) {
      console.error("Failed to save theme mode:", error);
      // Revert on error
      set({ themeMode: current });
    }
  },

  setThemeMode: async (mode) => {
    const previous = get().themeMode;
    set({ themeMode: mode });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.THEME_MODE, mode);
    } catch (error) {
      console.error("Failed to save theme mode:", error);
      // Revert on error
      set({ themeMode: previous });
    }
  },

  // UI scale: dragging the slider implies manual mode; persist both keys atomically
  setUiScale: async (factor) => {
    const prevMode = get().uiScaleMode;
    const prevFactor = get().uiScale;
    set({ uiScaleMode: "manual", uiScale: factor });

    try {
      await settingsService.setSettings({
        [SETTINGS_KEYS.UI_SCALE_MODE]: "manual",
        [SETTINGS_KEYS.UI_SCALE]: factor,
      });
    } catch (error) {
      console.error("Failed to save UI scale:", error);
      // Revert on error
      set({ uiScaleMode: prevMode, uiScale: prevFactor });
    }
  },

  setUiScaleMode: async (mode) => {
    const previous = get().uiScaleMode;
    set({ uiScaleMode: mode });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.UI_SCALE_MODE, mode);
    } catch (error) {
      console.error("Failed to save UI scale mode:", error);
      set({ uiScaleMode: previous });
    }
  },

  resetUiScaleToAuto: async () => {
    const previous = get().uiScaleMode;
    set({ uiScaleMode: "auto" });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.UI_SCALE_MODE, "auto");
    } catch (error) {
      console.error("Failed to reset UI scale to auto:", error);
      set({ uiScaleMode: previous });
    }
  },

  // Hotel selection
  setSelectedHotelOu: async (ou) => {
    const previous = get().selectedHotelOu;
    set({ selectedHotelOu: ou });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.SELECTED_HOTEL_OU, ou);
    } catch (error) {
      console.error("Failed to save selected hotel:", error);
      // Revert on error
      set({ selectedHotelOu: previous });
    }
  },

  // Department selection
  setSelectedDepartment: async (dept) => {
    const previous = get().selectedDepartment;
    set({ selectedDepartment: dept });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.SELECTED_DEPARTMENT, dept);
    } catch (error) {
      console.error("Failed to save selected department:", error);
      set({ selectedDepartment: previous });
    }
  },

  // Account selection
  setSelectedAccount: async (account) => {
    const previous = get().selectedAccount;
    set({ selectedAccount: account });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.SELECTED_ACCOUNT, account);
    } catch (error) {
      console.error("Failed to save selected account:", error);
      set({ selectedAccount: previous });
    }
  },

  // Period selection
  setSelectedPeriod: async (period) => {
    const previous = get().selectedPeriod;
    set({ selectedPeriod: period });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.SELECTED_PERIOD, period);
    } catch (error) {
      console.error("Failed to save selected period:", error);
      set({ selectedPeriod: previous });
    }
  },

  // Scenario selection
  setSelectedScenario: async (scenario) => {
    const previous = get().selectedScenario;
    set({ selectedScenario: scenario });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.SELECTED_SCENARIO, scenario);
    } catch (error) {
      console.error("Failed to save selected scenario:", error);
      set({ selectedScenario: previous });
    }
  },

  // Auto-save setting
  setAutoSave: async (enabled) => {
    const previous = get().autoSave;
    set({ autoSave: enabled });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.AUTO_SAVE, enabled);
    } catch (error) {
      console.error("Failed to save auto-save setting:", error);
      set({ autoSave: previous });
    }
  },

  // Notification setting
  setNotificationEnabled: async (enabled) => {
    const previous = get().notificationEnabled;
    set({ notificationEnabled: enabled });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.NOTIFICATION_ENABLED, enabled);
    } catch (error) {
      console.error("Failed to save notification setting:", error);
      set({ notificationEnabled: previous });
    }
  },

  // Language setting
  setLanguage: async (language) => {
    const previous = get().language;
    set({ language });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.LANGUAGE, language);
    } catch (error) {
      console.error("Failed to save language:", error);
      set({ language: previous });
    }
  },

  // Currency setting
  setCurrency: async (currency) => {
    const previous = get().currency;
    set({ currency });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.CURRENCY, currency);
    } catch (error) {
      console.error("Failed to save currency:", error);
      set({ currency: previous });
    }
  },

  // Date format setting
  setDateFormat: async (format) => {
    const previous = get().dateFormat;
    set({ dateFormat: format });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.DATE_FORMAT, format);
    } catch (error) {
      console.error("Failed to save date format:", error);
      set({ dateFormat: previous });
    }
  },

  // Number format setting
  setNumberFormat: async (format) => {
    const previous = get().numberFormat;
    set({ numberFormat: format });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.NUMBER_FORMAT, format);
    } catch (error) {
      console.error("Failed to save number format:", error);
      set({ numberFormat: previous });
    }
  },

  // Financial data version setting (MAIN or OWNR)
  setFinancialDataVersion: async (version) => {
    const previous = get().financialDataVersion;
    set({ financialDataVersion: version });

    try {
      await settingsService.setSetting(SETTINGS_KEYS.FINANCIAL_DATA_VERSION, version);
    } catch (error) {
      console.error("Failed to save financial data version:", error);
      set({ financialDataVersion: previous });
    }
  },

  // Excel export settings
  setExcelExportSelectedMonth: async (month) => {
    const previous = get().excelExportSelectedMonth;
    set({ excelExportSelectedMonth: month });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.EXCEL_EXPORT_SELECTED_MONTH, month);
    } catch (error) {
      console.error("Failed to save excel export selected month:", error);
      set({ excelExportSelectedMonth: previous });
    }
  },

  setExcelExportSelectedYear: async (year) => {
    const previous = get().excelExportSelectedYear;
    set({ excelExportSelectedYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.EXCEL_EXPORT_SELECTED_YEAR, year);
    } catch (error) {
      console.error("Failed to save excel export selected year:", error);
      set({ excelExportSelectedYear: previous });
    }
  },

  setExcelExportYtdStartMonth: async (month) => {
    const previous = get().excelExportYtdStartMonth;
    set({ excelExportYtdStartMonth: month });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.EXCEL_EXPORT_YTD_START_MONTH, month);
    } catch (error) {
      console.error("Failed to save excel export YTD start month:", error);
      set({ excelExportYtdStartMonth: previous });
    }
  },

  setExcelExportYtdStartYear: async (year) => {
    const previous = get().excelExportYtdStartYear;
    set({ excelExportYtdStartYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.EXCEL_EXPORT_YTD_START_YEAR, year);
    } catch (error) {
      console.error("Failed to save excel export YTD start year:", error);
      set({ excelExportYtdStartYear: previous });
    }
  },

  setExcelExportYtdEndMonth: async (month) => {
    const previous = get().excelExportYtdEndMonth;
    set({ excelExportYtdEndMonth: month });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.EXCEL_EXPORT_YTD_END_MONTH, month);
    } catch (error) {
      console.error("Failed to save excel export YTD end month:", error);
      set({ excelExportYtdEndMonth: previous });
    }
  },

  setExcelExportYtdEndYear: async (year) => {
    const previous = get().excelExportYtdEndYear;
    set({ excelExportYtdEndYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.EXCEL_EXPORT_YTD_END_YEAR, year);
    } catch (error) {
      console.error("Failed to save excel export YTD end year:", error);
      set({ excelExportYtdEndYear: previous });
    }
  },

  // Protea Report Pack settings
  setProteaReportPackSelectedMonth: async (month) => {
    const previous = get().proteaReportPackSelectedMonth;
    set({ proteaReportPackSelectedMonth: month });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_REPORT_PACK_SELECTED_MONTH, month);
    } catch (error) {
      console.error("Failed to save Protea report pack selected month:", error);
      set({ proteaReportPackSelectedMonth: previous });
    }
  },

  setProteaReportPackSelectedYear: async (year) => {
    const previous = get().proteaReportPackSelectedYear;
    set({ proteaReportPackSelectedYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_REPORT_PACK_SELECTED_YEAR, year);
    } catch (error) {
      console.error("Failed to save Protea report pack selected year:", error);
      set({ proteaReportPackSelectedYear: previous });
    }
  },

  setProteaReportPackYtdStartMonth: async (month) => {
    const previous = get().proteaReportPackYtdStartMonth;
    set({ proteaReportPackYtdStartMonth: month });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_START_MONTH, month);
    } catch (error) {
      console.error("Failed to save Protea report pack YTD start month:", error);
      set({ proteaReportPackYtdStartMonth: previous });
    }
  },

  setProteaReportPackYtdStartYear: async (year) => {
    const previous = get().proteaReportPackYtdStartYear;
    set({ proteaReportPackYtdStartYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_START_YEAR, year);
    } catch (error) {
      console.error("Failed to save Protea report pack YTD start year:", error);
      set({ proteaReportPackYtdStartYear: previous });
    }
  },

  setProteaReportPackYtdEndMonth: async (month) => {
    const previous = get().proteaReportPackYtdEndMonth;
    set({ proteaReportPackYtdEndMonth: month });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_END_MONTH, month);
    } catch (error) {
      console.error("Failed to save Protea report pack YTD end month:", error);
      set({ proteaReportPackYtdEndMonth: previous });
    }
  },

  setProteaReportPackYtdEndYear: async (year) => {
    const previous = get().proteaReportPackYtdEndYear;
    set({ proteaReportPackYtdEndYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_END_YEAR, year);
    } catch (error) {
      console.error("Failed to save Protea report pack YTD end year:", error);
      set({ proteaReportPackYtdEndYear: previous });
    }
  },

  // Protea Budget Pack settings
  setProteaBudgetPackStartMonth: async (month) => {
    const previous = get().proteaBudgetPackStartMonth;
    set({ proteaBudgetPackStartMonth: month });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_BUDGET_PACK_START_MONTH, month);
    } catch (error) {
      console.error("Failed to save Protea budget pack start month:", error);
      set({ proteaBudgetPackStartMonth: previous });
    }
  },

  setProteaBudgetPackStartYear: async (year) => {
    const previous = get().proteaBudgetPackStartYear;
    set({ proteaBudgetPackStartYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_BUDGET_PACK_START_YEAR, year);
    } catch (error) {
      console.error("Failed to save Protea budget pack start year:", error);
      set({ proteaBudgetPackStartYear: previous });
    }
  },

  setProteaBudgetPackEndMonth: async (month) => {
    const previous = get().proteaBudgetPackEndMonth;
    set({ proteaBudgetPackEndMonth: month });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_BUDGET_PACK_END_MONTH, month);
    } catch (error) {
      console.error("Failed to save Protea budget pack end month:", error);
      set({ proteaBudgetPackEndMonth: previous });
    }
  },

  setProteaBudgetPackEndYear: async (year) => {
    const previous = get().proteaBudgetPackEndYear;
    set({ proteaBudgetPackEndYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PROTEA_BUDGET_PACK_END_YEAR, year);
    } catch (error) {
      console.error("Failed to save Protea budget pack end year:", error);
      set({ proteaBudgetPackEndYear: previous });
    }
  },

  // Shared report settings
  setIncludeDetailBreakdown: async (enabled) => {
    const previous = get().includeDetailBreakdown;
    set({ includeDetailBreakdown: enabled });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.INCLUDE_DETAIL_BREAKDOWN, enabled);
    } catch (error) {
      console.error("Failed to save include segment detail setting:", error);
      set({ includeDetailBreakdown: previous });
    }
  },

  setIncludeBanquetingBreakdown: async (enabled) => {
    const previous = get().includeBanquetingBreakdown;
    set({ includeBanquetingBreakdown: enabled });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.INCLUDE_BANQUETING_BREAKDOWN, enabled);
    } catch (error) {
      console.error("Failed to save banqueting breakdown setting:", error);
      set({ includeBanquetingBreakdown: previous });
    }
  },

  // Planning context setters
  setBudgetYear: async (year) => {
    const previous = get().budgetYear;
    set({ budgetYear: year });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.BUDGET_YEAR, year);
    } catch (error) {
      console.error("Failed to save budget year setting:", error);
      set({ budgetYear: previous });
    }
  },

  setPlanningScenarioId: async (scenarioId) => {
    const previous = get().planningScenarioId;
    set({ planningScenarioId: scenarioId });
    try {
      await settingsService.setSetting(SETTINGS_KEYS.PLANNING_SCENARIO_ID, scenarioId);
    } catch (error) {
      console.error("Failed to save planning scenario setting:", error);
      set({ planningScenarioId: previous });
    }
  },

  // Update multiple settings at once
  updateMultipleSettings: async (settings) => {
    // Store previous state for rollback
    const previousState = {
      themeMode: get().themeMode,
      selectedHotelOu: get().selectedHotelOu,
      selectedDepartment: get().selectedDepartment,
      selectedAccount: get().selectedAccount,
      selectedPeriod: get().selectedPeriod,
      selectedScenario: get().selectedScenario,
      autoSave: get().autoSave,
      notificationEnabled: get().notificationEnabled,
      language: get().language,
      currency: get().currency,
      dateFormat: get().dateFormat,
      numberFormat: get().numberFormat,
      financialDataVersion: get().financialDataVersion,
    };

    // Update local state immediately
    const updates: Partial<SettingsState> = {};
    if (SETTINGS_KEYS.THEME_MODE in settings) updates.themeMode = settings[SETTINGS_KEYS.THEME_MODE]!;
    if (SETTINGS_KEYS.SELECTED_HOTEL_OU in settings) updates.selectedHotelOu = settings[SETTINGS_KEYS.SELECTED_HOTEL_OU]!;
    if (SETTINGS_KEYS.SELECTED_DEPARTMENT in settings) updates.selectedDepartment = settings[SETTINGS_KEYS.SELECTED_DEPARTMENT]!;
    if (SETTINGS_KEYS.SELECTED_ACCOUNT in settings) updates.selectedAccount = settings[SETTINGS_KEYS.SELECTED_ACCOUNT]!;
    if (SETTINGS_KEYS.SELECTED_PERIOD in settings) updates.selectedPeriod = settings[SETTINGS_KEYS.SELECTED_PERIOD]!;
    if (SETTINGS_KEYS.SELECTED_SCENARIO in settings) updates.selectedScenario = settings[SETTINGS_KEYS.SELECTED_SCENARIO]!;
    if (SETTINGS_KEYS.AUTO_SAVE in settings) updates.autoSave = settings[SETTINGS_KEYS.AUTO_SAVE]!;
    if (SETTINGS_KEYS.NOTIFICATION_ENABLED in settings) updates.notificationEnabled = settings[SETTINGS_KEYS.NOTIFICATION_ENABLED]!;
    if (SETTINGS_KEYS.LANGUAGE in settings) updates.language = settings[SETTINGS_KEYS.LANGUAGE]!;
    if (SETTINGS_KEYS.CURRENCY in settings) updates.currency = settings[SETTINGS_KEYS.CURRENCY]!;
    if (SETTINGS_KEYS.DATE_FORMAT in settings) updates.dateFormat = settings[SETTINGS_KEYS.DATE_FORMAT]!;
    if (SETTINGS_KEYS.NUMBER_FORMAT in settings) updates.numberFormat = settings[SETTINGS_KEYS.NUMBER_FORMAT]!;
    if (SETTINGS_KEYS.FINANCIAL_DATA_VERSION in settings) updates.financialDataVersion = settings[SETTINGS_KEYS.FINANCIAL_DATA_VERSION]!;
    if (SETTINGS_KEYS.INCLUDE_DETAIL_BREAKDOWN in settings) updates.includeDetailBreakdown = settings[SETTINGS_KEYS.INCLUDE_DETAIL_BREAKDOWN]!;
    if (SETTINGS_KEYS.INCLUDE_BANQUETING_BREAKDOWN in settings) updates.includeBanquetingBreakdown = settings[SETTINGS_KEYS.INCLUDE_BANQUETING_BREAKDOWN]!;

    set(updates);

    try {
      await settingsService.setSettings(settings);
    } catch (error) {
      console.error("Failed to save multiple settings:", error);
      // Revert all changes on error
      set(previousState);
    }
  },

  // Load all settings from database
  loadSettingsFromDb: async () => {
    if (get().initialized) {
      // console.log("Settings already initialized, skipping load");
      return;
    }

    try {
      set({ loading: true });

      // Initialize the settings service
      await settingsService.initialize();

      // Get all settings
      const settings = await settingsService.getAllSettings();

      // Update store with loaded settings
      set({
        themeMode: settings[SETTINGS_KEYS.THEME_MODE],
        uiScaleMode: settings[SETTINGS_KEYS.UI_SCALE_MODE],
        uiScale: settings[SETTINGS_KEYS.UI_SCALE],
        selectedHotelOu: settings[SETTINGS_KEYS.SELECTED_HOTEL_OU],
        selectedDepartment: settings[SETTINGS_KEYS.SELECTED_DEPARTMENT],
        selectedAccount: settings[SETTINGS_KEYS.SELECTED_ACCOUNT],
        selectedPeriod: settings[SETTINGS_KEYS.SELECTED_PERIOD],
        selectedScenario: settings[SETTINGS_KEYS.SELECTED_SCENARIO],
        autoSave: settings[SETTINGS_KEYS.AUTO_SAVE],
        notificationEnabled: settings[SETTINGS_KEYS.NOTIFICATION_ENABLED],
        language: settings[SETTINGS_KEYS.LANGUAGE],
        currency: settings[SETTINGS_KEYS.CURRENCY],
        dateFormat: settings[SETTINGS_KEYS.DATE_FORMAT],
        numberFormat: settings[SETTINGS_KEYS.NUMBER_FORMAT],
        financialDataVersion: settings[SETTINGS_KEYS.FINANCIAL_DATA_VERSION],
        // Excel export settings
        excelExportSelectedMonth: settings[SETTINGS_KEYS.EXCEL_EXPORT_SELECTED_MONTH],
        excelExportSelectedYear: settings[SETTINGS_KEYS.EXCEL_EXPORT_SELECTED_YEAR],
        excelExportYtdStartMonth: settings[SETTINGS_KEYS.EXCEL_EXPORT_YTD_START_MONTH],
        excelExportYtdStartYear: settings[SETTINGS_KEYS.EXCEL_EXPORT_YTD_START_YEAR],
        excelExportYtdEndMonth: settings[SETTINGS_KEYS.EXCEL_EXPORT_YTD_END_MONTH],
        excelExportYtdEndYear: settings[SETTINGS_KEYS.EXCEL_EXPORT_YTD_END_YEAR],
        // Protea Report Pack settings
        proteaReportPackSelectedMonth: settings[SETTINGS_KEYS.PROTEA_REPORT_PACK_SELECTED_MONTH],
        proteaReportPackSelectedYear: settings[SETTINGS_KEYS.PROTEA_REPORT_PACK_SELECTED_YEAR],
        proteaReportPackYtdStartMonth: settings[SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_START_MONTH],
        proteaReportPackYtdStartYear: settings[SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_START_YEAR],
        proteaReportPackYtdEndMonth: settings[SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_END_MONTH],
        proteaReportPackYtdEndYear: settings[SETTINGS_KEYS.PROTEA_REPORT_PACK_YTD_END_YEAR],
        // Protea Budget Pack settings
        proteaBudgetPackStartMonth: settings[SETTINGS_KEYS.PROTEA_BUDGET_PACK_START_MONTH],
        proteaBudgetPackStartYear: settings[SETTINGS_KEYS.PROTEA_BUDGET_PACK_START_YEAR],
        proteaBudgetPackEndMonth: settings[SETTINGS_KEYS.PROTEA_BUDGET_PACK_END_MONTH],
        proteaBudgetPackEndYear: settings[SETTINGS_KEYS.PROTEA_BUDGET_PACK_END_YEAR],
        // Shared report settings
        includeDetailBreakdown: settings[SETTINGS_KEYS.INCLUDE_DETAIL_BREAKDOWN],
        includeBanquetingBreakdown: settings[SETTINGS_KEYS.INCLUDE_BANQUETING_BREAKDOWN],
        // Planning context
        budgetYear: settings[SETTINGS_KEYS.BUDGET_YEAR],
        planningScenarioId: settings[SETTINGS_KEYS.PLANNING_SCENARIO_ID],
        initialized: true,
      });

      // console.log("Settings loaded from database:", settings);
    } catch (error) {
      console.error("Failed to load settings from database:", error);
      // Mark as initialized even on error to prevent infinite retries
      set({ initialized: true });
    } finally {
      set({ loading: false });
    }
  },

  // Save all current settings to database
  saveSettingsToDb: async () => {
    try {
      const state = get();
      // Deliberately partial: the Excel-export and Protea-pack keys are written
      // by their own setters, so this bulk save only covers the general prefs.
      const settings: PartialSettings = {
        [SETTINGS_KEYS.THEME_MODE]: state.themeMode,
        [SETTINGS_KEYS.UI_SCALE_MODE]: state.uiScaleMode,
        [SETTINGS_KEYS.UI_SCALE]: state.uiScale,
        [SETTINGS_KEYS.SELECTED_HOTEL_OU]: state.selectedHotelOu,
        [SETTINGS_KEYS.SELECTED_DEPARTMENT]: state.selectedDepartment,
        [SETTINGS_KEYS.SELECTED_ACCOUNT]: state.selectedAccount,
        [SETTINGS_KEYS.SELECTED_PERIOD]: state.selectedPeriod,
        [SETTINGS_KEYS.SELECTED_SCENARIO]: state.selectedScenario,
        [SETTINGS_KEYS.AUTO_SAVE]: state.autoSave,
        [SETTINGS_KEYS.NOTIFICATION_ENABLED]: state.notificationEnabled,
        [SETTINGS_KEYS.LANGUAGE]: state.language,
        [SETTINGS_KEYS.CURRENCY]: state.currency,
        [SETTINGS_KEYS.DATE_FORMAT]: state.dateFormat,
        [SETTINGS_KEYS.NUMBER_FORMAT]: state.numberFormat,
        [SETTINGS_KEYS.FINANCIAL_DATA_VERSION]: state.financialDataVersion,
        [SETTINGS_KEYS.INCLUDE_DETAIL_BREAKDOWN]: state.includeDetailBreakdown,
        [SETTINGS_KEYS.INCLUDE_BANQUETING_BREAKDOWN]: state.includeBanquetingBreakdown,
      };

      await settingsService.setSettings(settings);
      // console.log("All settings saved to database");
    } catch (error) {
      console.error("Failed to save settings to database:", error);
      throw error;
    }
  },

  // Reset all settings to defaults
  resetAllSettings: async () => {
    try {
      set({ loading: true });

      // Reset in service
      await settingsService.resetAllSettings();

      // Get the default values
      const settings = await settingsService.getAllSettings();

      // Update store with defaults
      set({
        themeMode: settings[SETTINGS_KEYS.THEME_MODE],
        uiScaleMode: settings[SETTINGS_KEYS.UI_SCALE_MODE],
        uiScale: settings[SETTINGS_KEYS.UI_SCALE],
        selectedHotelOu: settings[SETTINGS_KEYS.SELECTED_HOTEL_OU],
        selectedDepartment: settings[SETTINGS_KEYS.SELECTED_DEPARTMENT],
        selectedAccount: settings[SETTINGS_KEYS.SELECTED_ACCOUNT],
        selectedPeriod: settings[SETTINGS_KEYS.SELECTED_PERIOD],
        selectedScenario: settings[SETTINGS_KEYS.SELECTED_SCENARIO],
        autoSave: settings[SETTINGS_KEYS.AUTO_SAVE],
        notificationEnabled: settings[SETTINGS_KEYS.NOTIFICATION_ENABLED],
        language: settings[SETTINGS_KEYS.LANGUAGE],
        currency: settings[SETTINGS_KEYS.CURRENCY],
        dateFormat: settings[SETTINGS_KEYS.DATE_FORMAT],
        numberFormat: settings[SETTINGS_KEYS.NUMBER_FORMAT],
        financialDataVersion: settings[SETTINGS_KEYS.FINANCIAL_DATA_VERSION],
        includeDetailBreakdown: settings[SETTINGS_KEYS.INCLUDE_DETAIL_BREAKDOWN],
        includeBanquetingBreakdown: settings[SETTINGS_KEYS.INCLUDE_BANQUETING_BREAKDOWN],
      });

      // console.log("All settings reset to defaults");
    } catch (error) {
      console.error("Failed to reset settings:", error);
      throw error;
    } finally {
      set({ loading: false });
    }
  },
}));

// Export convenience hooks for specific settings
export const useThemeMode = () => useSettingsStore((s) => s.themeMode);
export const useUiScaleMode = () => useSettingsStore((s) => s.uiScaleMode);
export const useUiScale = () => useSettingsStore((s) => s.uiScale);
export const useSelectedHotel = () => useSettingsStore((s) => s.selectedHotelOu);
export const useSelectedDepartment = () => useSettingsStore((s) => s.selectedDepartment);
export const useSelectedAccount = () => useSettingsStore((s) => s.selectedAccount);
export const useSelectedPeriod = () => useSettingsStore((s) => s.selectedPeriod);
export const useSelectedScenario = () => useSettingsStore((s) => s.selectedScenario);
export const useAutoSave = () => useSettingsStore((s) => s.autoSave);
export const useNotificationEnabled = () => useSettingsStore((s) => s.notificationEnabled);
export const useFinancialDataVersion = () => useSettingsStore((s) => s.financialDataVersion);
export const useLanguage = () => useSettingsStore((s) => s.language);
export const useCurrency = () => useSettingsStore((s) => s.currency);
export const useDateFormat = () => useSettingsStore((s) => s.dateFormat);
export const useNumberFormat = () => useSettingsStore((s) => s.numberFormat);
export const useIncludeDetailBreakdown = () => useSettingsStore((s) => s.includeDetailBreakdown);
export const useIncludeBanquetingBreakdown = () => useSettingsStore((s) => s.includeBanquetingBreakdown);
export const useBudgetYear = () => useSettingsStore((s) => s.budgetYear);
export const usePlanningScenarioId = () => useSettingsStore((s) => s.planningScenarioId);