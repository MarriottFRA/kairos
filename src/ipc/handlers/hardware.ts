/**
 * Hardware IPC Handlers
 * Provides access to system hardware information for device fingerprinting.
 *
 * The actual hardware-reading logic lives in src/main/system/hardwareInfo.ts
 * (shared with main-process device_secret derivation) so there is exactly one
 * source of truth for these raw values.
 */

import { IpcHandler } from "../types";
import * as db from "../../local_db";
import { gatherHardwareInfo, HardwareInfo } from "../../main/system/hardwareInfo";

export type { HardwareInfo };

export class HardwareHandlers {
  /**
   * Get comprehensive hardware information.
   */
  getHardwareInfo: IpcHandler<void, HardwareInfo> = async () => {
    return {
      success: true,
      data: await gatherHardwareInfo(),
      timestamp: Date.now(),
    };
  };

  /**
   * Get or create the permanent device salt.
   * Generated once per device and never changes; stored in SQLite.
   */
  getPermanentSalt: IpcHandler<void, string> = async () => {
    try {
      const salt = await db.getPermanentSalt();
      return {
        success: true,
        data: salt,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("Error managing permanent salt:", error);
      throw new Error("Failed to get or create permanent salt");
    }
  };
}

// Factory function to create and register hardware handlers
export function createHardwareHandlers() {
  const handlers = new HardwareHandlers();

  return {
    "hardware:get-info": handlers.getHardwareInfo,
    "hardware:get-permanent-salt": handlers.getPermanentSalt,
  };
}
