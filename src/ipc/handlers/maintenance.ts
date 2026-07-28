/**
 * Maintenance IPC handlers — the storage-cleanup surface in Settings.
 *
 * Install-wide by design (every hotel, both stores), so these channels are
 * deliberately NOT OU-gated; they are gated by the secure-DB session lock
 * instead — a purge that ran with the encrypted store locked would drop
 * plaintext parents and leave their encrypted values behind.
 */

import fs from "fs";
import type { IpcHandler } from "../types";
import { localDbHandle } from "../../local_db";
import { isSecureDatabaseUnlocked, secureDb } from "../../secure_db";
import { LOCAL_DB_PATH, SECURE_DB_PATH } from "../../main/paths";
import {
  purgeSoftDeleted,
  scanSoftDeleted,
  vacuumStores,
} from "../../main/maintenance/cleanupRepo";
import {
  readAutoCleanupConfig,
  retentionCutoff,
  setAutoCleanupRetention,
} from "../../main/maintenance/autoCleanup";
import {
  AutoCleanupConfig,
  CleanupPurgeResponse,
  CleanupScanResponse,
  DEFAULT_AUTO_CLEANUP_CONFIG,
  EMPTY_CLEANUP_TALLY,
  MAINTENANCE_CHANNELS,
  SetAutoCleanupRequest,
  cleanupTotal,
} from "../../shared/maintenance/ipc";

/** Combined on-disk size of both stores. WAL/SHM sidecars are ignored — they
 *  are transient and would make the "reclaimed" figure noise. */
function databaseBytes(): number {
  let total = 0;
  for (const file of [LOCAL_DB_PATH, SECURE_DB_PATH]) {
    try {
      total += fs.statSync(file).size;
    } catch {
      /* not created yet — contributes nothing */
    }
  }
  return total;
}

export function createMaintenanceHandlers(): Record<string, IpcHandler> {
  return {
    [MAINTENANCE_CHANNELS.scanDeleted]: async (): Promise<CleanupScanResponse> => {
      let autoCleanup: AutoCleanupConfig;
      try {
        autoCleanup = await readAutoCleanupConfig();
      } catch {
        autoCleanup = { ...DEFAULT_AUTO_CLEANUP_CONFIG };
      }

      if (!isSecureDatabaseUnlocked()) {
        return {
          tally: { ...EMPTY_CLEANUP_TALLY },
          total: 0,
          secureAvailable: false,
          databaseBytes: databaseBytes(),
          autoCleanup,
          autoEligible: 0,
        };
      }

      const local = localDbHandle();
      const secure = secureDb();
      const tally = scanSoftDeleted(local, secure);
      // Second pass through the window, so the card can say how much of the
      // backlog the sweep will take by itself.
      const cutoff = retentionCutoff(autoCleanup.retentionDays);
      const autoEligible = cutoff
        ? cleanupTotal(scanSoftDeleted(local, secure, cutoff))
        : 0;

      return {
        tally,
        total: cleanupTotal(tally),
        secureAvailable: true,
        databaseBytes: databaseBytes(),
        autoCleanup,
        autoEligible,
      };
    },

    [MAINTENANCE_CHANNELS.setAutoCleanup]: async (
      _event,
      request: SetAutoCleanupRequest
    ): Promise<AutoCleanupConfig> =>
      setAutoCleanupRetention(request?.retentionDays),

    // DESTRUCTIVE and irreversible: everything the scan listed is gone, along
    // with every undo path that depended on it (the Positions undo snackbar,
    // "Recently removed" columns, block restore). The UI gates this behind an
    // explicit confirmation showing the counts.
    [MAINTENANCE_CHANNELS.purgeDeleted]: async (): Promise<CleanupPurgeResponse> => {
      if (!isSecureDatabaseUnlocked()) {
        throw new Error(
          "Sign in before cleaning up — the encrypted store is locked."
        );
      }
      const local = localDbHandle();
      const secure = secureDb();

      const before = databaseBytes();
      const tally = purgeSoftDeleted(local, secure);
      try {
        vacuumStores(local, secure);
      } catch (error) {
        // The rows are already gone; only the space give-back failed.
        console.error("[Maintenance] VACUUM after cleanup failed:", error);
      }

      return {
        tally,
        total: cleanupTotal(tally),
        bytesReclaimed: Math.max(0, before - databaseBytes()),
      };
    },
  };
}
