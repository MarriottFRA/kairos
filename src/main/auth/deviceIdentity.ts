/**
 * DeviceIdentity — device_id + device_secret ownership in the main process.
 * -----------------------------------------------------------
 * Ported from the former renderer logic (src/services/auth.ts
 * generateDeviceCredentials, lines 116-193). Now the single source of truth.
 *
 *   - device_id:     a stable per-install identifier, persisted in user_settings
 *                    (plain — it is not a secret). Generated once, then reused.
 *   - device_secret: re-derived from stable hardware identifiers + the permanent
 *                    salt on EVERY launch. Never persisted. Required both for
 *                    /devices/verify and for every /auth/refresh.
 *
 * IMPORTANT (byte-compatibility): the device_secret string must reproduce EXACTLY
 * what the renderer produced previously, or already-registered devices will fail
 * /devices/verify. The only renderer-specific input was `navigator.platform`,
 * which we reproduce via navigatorPlatform(). All other inputs come from the
 * shared hardware module (identical raw values) and the permanent salt (DB).
 */

import crypto from "crypto";
import * as db from "../../local_db";
import {
  gatherHardwareInfo,
  navigatorPlatform,
} from "../system/hardwareInfo";

const DEVICE_ID_KEY = "deviceId";

export class DeviceIdentity {
  private deviceId: string | null = null;

  /**
   * Return the persisted device_id, generating and storing one on first run.
   */
  async getDeviceId(): Promise<string> {
    if (this.deviceId) {
      return this.deviceId;
    }

    // getUserSettings(key) returns the parsed value, or the string "null" if absent.
    const stored = await db.getUserSettings(DEVICE_ID_KEY);
    if (stored && stored !== "null") {
      this.deviceId = stored as string;
      return this.deviceId;
    }

    // First run on this machine: mint a stable UUID and persist it once.
    const newId = crypto.randomUUID();
    await db.setUserSettings({ [DEVICE_ID_KEY]: newId });
    this.deviceId = newId;
    return newId;
  }

  /**
   * Re-derive the device_secret from hardware + permanent salt.
   * Mirrors the renderer's SHA-256(components.join('||')) hex exactly.
   */
  async getDeviceSecret(): Promise<string> {
    const permanentSalt = await db.getPermanentSalt();
    const hw = await gatherHardwareInfo();

    // Order and fallbacks MUST match the historical renderer derivation.
    const components = [
      navigatorPlatform(),
      permanentSalt,
      hw.machineId || "UNKNOWN",
      hw.biosSerial || "UNKNOWN",
      hw.motherboardSerial || "UNKNOWN",
      hw.diskSerial || "UNKNOWN",
      hw.cpuInfo.model || "UNKNOWN", // model name only, not core count
    ];

    return crypto
      .createHash("sha256")
      .update(components.join("||"), "utf8")
      .digest("hex");
  }

  /**
   * Convenience: both credentials together (used by verify / register / refresh).
   */
  async getCredentials(): Promise<{ deviceId: string; deviceSecret: string }> {
    const [deviceId, deviceSecret] = await Promise.all([
      this.getDeviceId(),
      this.getDeviceSecret(),
    ]);
    return { deviceId, deviceSecret };
  }
}
