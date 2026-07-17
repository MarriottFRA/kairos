/**
 * Settings IPC Handlers
 * Handles settings storage in SQLite database with improved modularity
 */

import { IpcHandler, IpcResult } from "../types";
import { getUserSettings, setUserSettings, deleteUserSetting } from "../../local_db";

interface SingleSettingRequest {
  key: string;
}

interface SingleSettingUpdate {
  key: string;
  value: any;
}

export class SettingsHandlers {
  /**
   * Get all settings from database
   */
  getAllSettings: IpcHandler<void, IpcResult<Record<string, any>>> = async (_event, _request) => {
    try {
      const settingsJson = await getUserSettings();
      const settings = JSON.parse(settingsJson);

      return {
        success: true,
        data: settings,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("Failed to get all settings:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: {},
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Get a single setting from database
   */
  getSingleSetting: IpcHandler<any, IpcResult<any>> = async (_event, request) => {
    try {
      if (!request?.key) {
        throw new Error("Setting key is required");
      }

      const settingsJson = await getUserSettings();
      const settings = JSON.parse(settingsJson);
      const value = settings[request.key];

      return {
        success: true,
        data: value,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error(`Failed to get setting ${request?.key}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: undefined,
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Set a single setting in database
   */
  setSingleSetting: IpcHandler<any, IpcResult<void>> = async (_event, request) => {
    try {
      if (!request?.key) {
        throw new Error("Setting key is required");
      }

      // Get existing settings
      const settingsJson = await getUserSettings();
      const existingSettings = JSON.parse(settingsJson);

      // Update with new value
      const updatedSettings = {
        ...existingSettings,
        [request.key]: request.value,
      };

      // Save back to database
      await setUserSettings(updatedSettings);

      return {
        success: true,
        data: undefined,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error(`Failed to set setting ${request?.key}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: undefined,
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Set multiple settings in database (bulk update)
   */
  setBulkSettings: IpcHandler<Record<string, any>, IpcResult<void>> = async (_event, request) => {
    try {
      if (!request) {
        throw new Error("Settings data is required");
      }

      // Get existing settings
      const settingsJson = await getUserSettings();
      const existingSettings = JSON.parse(settingsJson);

      // Merge with new settings
      const updatedSettings = {
        ...existingSettings,
        ...request,
      };

      // Save back to database
      await setUserSettings(updatedSettings);

      return {
        success: true,
        data: undefined,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("Failed to set bulk settings:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: undefined,
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Delete a specific setting
   */
  deleteSetting: IpcHandler<any, IpcResult<void>> = async (_event, request) => {
    try {
      if (!request?.key) {
        throw new Error("Setting key is required");
      }

      await deleteUserSetting(request.key);

      return {
        success: true,
        data: undefined,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error(`Failed to delete setting ${request?.key}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: undefined,
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Clear all settings (reset to empty)
   */
  clearAllSettings: IpcHandler<void, IpcResult<void>> = async (_event, _request) => {
    try {
      // Clear all settings by setting an empty object
      await setUserSettings({});

      return {
        success: true,
        data: undefined,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("Failed to clear all settings:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: undefined,
        timestamp: Date.now(),
      };
    }
  };

  // Legacy handlers for backward compatibility
  /**
   * Legacy get handler - returns all settings in old format
   */
  legacyGet: IpcHandler<void, IpcResult<any>> = async (_event, _request) => {
    try {
      const settingsJson = await getUserSettings();
      const settings = JSON.parse(settingsJson);

      // Transform to legacy format if needed
      const legacySettings = {
        mode: settings.themeMode || "light",
        themeMode: settings.themeMode || "light",
        selectedHotelOu: settings.selectedHotelOu || null,
        ...settings
      };

      return {
        success: true,
        data: legacySettings,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("Failed to get settings (legacy):", error);
      return {
        success: true,
        data: { mode: "light", themeMode: "light" },
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Legacy set handler - accepts old format and converts to new
   */
  legacySet: IpcHandler<any, IpcResult<void>> = async (_event, request) => {
    try {
      if (!request?.data) {
        return {
          success: true,
          data: undefined,
          timestamp: Date.now(),
        };
      }

      // Get existing settings
      const settingsJson = await getUserSettings();
      const existingSettings = JSON.parse(settingsJson);

      // Handle legacy format conversion
      const settingsToSave: Record<string, any> = {
        ...existingSettings,
      };

      // Handle themeMode/mode compatibility
      if (request.data.themeMode !== undefined) {
        settingsToSave.themeMode = request.data.themeMode;
      } else if (request.data.mode !== undefined) {
        settingsToSave.themeMode = request.data.mode;
      }

      // Copy over other settings
      Object.keys(request.data).forEach(key => {
        if (key !== 'mode') {
          settingsToSave[key] = request.data[key];
        }
      });

      await setUserSettings(settingsToSave);

      return {
        success: true,
        data: undefined,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("Failed to save settings (legacy):", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: undefined,
        timestamp: Date.now(),
      };
    }
  };
}

export function createSettingsHandlers() {
  const handlers = new SettingsHandlers();

  return {
    // New modular handlers
    "settings-get-all": handlers.getAllSettings,
    "settings-get-single": handlers.getSingleSetting,
    "settings-set-single": handlers.setSingleSetting,
    "settings-set-bulk": handlers.setBulkSettings,
    "settings-delete": handlers.deleteSetting,
    "settings-clear": handlers.clearAllSettings,

    // Legacy handlers for backward compatibility
    "settings-get": handlers.legacyGet,
    "settings-set": handlers.legacySet,
  };
}