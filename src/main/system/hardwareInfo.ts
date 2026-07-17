/**
 * Shared Hardware Fingerprint Provider
 * -----------------------------------------------------------
 * Single source of truth for reading stable hardware identifiers used for
 * device fingerprinting. Consumed by:
 *   - the `hardware:get-info` IPC handler (src/ipc/handlers/hardware.ts)
 *   - main-process device identity / device_secret derivation
 *     (src/main/auth/deviceIdentity.ts)
 *
 * Keeping this in one place guarantees the renderer-facing hardware info and
 * the main-process device_secret are derived from identical raw values.
 */

import os from "os";
import { machineIdSync } from "node-machine-id";
import si from "systeminformation";

export interface HardwareInfo {
  machineId: string;
  biosSerial: string;
  motherboardSerial: string;
  diskSerial: string;
  macAddresses: string[];
  cpuInfo: {
    model: string;
    cores: number;
  };
  memoryTotal: number; // in GB
  hostname: string;
  username: string;
}

/**
 * Get MAC addresses from all network interfaces (physical only).
 */
export function getMacAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const macs: string[] = [];

  for (const name in interfaces) {
    const iface = interfaces[name];
    if (iface) {
      for (const addr of iface) {
        // Only include physical MAC addresses (not internal/virtual)
        if (addr.mac && addr.mac !== "00:00:00:00:00:00") {
          macs.push(addr.mac);
        }
      }
    }
  }

  return [...new Set(macs)]; // Remove duplicates
}

/**
 * Get BIOS serial number using systeminformation.
 */
export async function getBiosSerial(): Promise<string> {
  try {
    const bios = await si.bios();
    return bios.serial || "UNKNOWN";
  } catch (error) {
    console.error("Error getting BIOS serial:", error);
    return "UNKNOWN";
  }
}

/**
 * Get motherboard serial number using systeminformation.
 */
export async function getMotherboardSerial(): Promise<string> {
  try {
    const baseboard = await si.baseboard();
    return baseboard.serial || "UNKNOWN";
  } catch (error) {
    console.error("Error getting motherboard serial:", error);
    return "UNKNOWN";
  }
}

/**
 * Get primary disk serial number using systeminformation.
 */
export async function getDiskSerial(): Promise<string> {
  try {
    const diskLayout = await si.diskLayout();
    if (diskLayout && diskLayout.length > 0) {
      return diskLayout[0].serialNum || "UNKNOWN";
    }
    return "UNKNOWN";
  } catch (error) {
    console.error("Error getting disk serial:", error);
    return "UNKNOWN";
  }
}

/**
 * Get machine ID using node-machine-id (stable across all platforms).
 */
export function getMachineId(): string {
  try {
    return machineIdSync();
  } catch (error) {
    console.error("Error getting machine ID:", error);
    return "UNKNOWN";
  }
}

/**
 * Reproduce the renderer's `navigator.platform` string from the main process.
 *
 * The device_secret has historically been derived (in the renderer) using
 * `navigator.platform`. Node's `process.platform` uses different tokens
 * (e.g. "win32" vs "Win32"), so we map it back to the Chromium value to keep
 * device_secret byte-for-byte identical — otherwise already-registered
 * devices would fail /devices/verify and be forced to re-register.
 */
export function navigatorPlatform(): string {
  switch (process.platform) {
    case "win32":
      return "Win32"; // Chromium reports "Win32" on 32- and 64-bit Windows
    case "darwin":
      return "MacIntel";
    case "linux":
      return "Linux x86_64";
    default:
      return process.platform;
  }
}

/**
 * Gather the full hardware fingerprint. Serial reads run concurrently.
 */
export async function gatherHardwareInfo(): Promise<HardwareInfo> {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();

  const [biosSerial, motherboardSerial, diskSerial] = await Promise.all([
    getBiosSerial(),
    getMotherboardSerial(),
    getDiskSerial(),
  ]);

  return {
    machineId: getMachineId(),
    biosSerial,
    motherboardSerial,
    diskSerial,
    macAddresses: getMacAddresses(),
    cpuInfo: {
      model: cpus[0]?.model || "Unknown",
      cores: cpus.length,
    },
    memoryTotal: Math.round(totalMemory / 1024 ** 3), // Convert to GB
    hostname: os.hostname(),
    username: os.userInfo().username,
  };
}
