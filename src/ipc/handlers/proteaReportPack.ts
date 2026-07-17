/**
 * Protea Report Pack IPC Handlers
 * ================================
 * Handles Protea Report Pack generation requests from the renderer process.
 */

import { dialog } from 'electron';
import { IpcHandler, IpcResult } from "../types";
import proteaReportPackService, { ProteaReportPackConfig } from "../../services/proteaReportPackService";
import * as db from "../../local_db";

// ============================================================================
// HANDLER CLASS
// ============================================================================

export class ProteaReportPackHandlers {
  /**
   * Generates a Protea Report Pack and saves it to a user-selected location
   */
  generateReportHandler: IpcHandler = async (event, request: ProteaReportPackConfig): Promise<IpcResult> => {
    try {
      // Look up the actual hotel name from cache
      const hotelName = await db.getHotelNameByOU(request.ou);
      if (hotelName) {
        request.hotelName = hotelName;
      }

      // Build default filename
      const monthStr = String(request.selectedMonth).padStart(2, '0');
      const safeFileName = (hotelName || request.hotelName).replace(/[^a-zA-Z0-9]/g, '_');
      const defaultFileName = `${safeFileName}_Protea_Report_Pack_${request.selectedYear}-${monthStr}.xlsx`;

      // Show save dialog
      const result = await dialog.showSaveDialog({
        title: 'Save Protea Report Pack',
        defaultPath: defaultFileName,
        filters: [
          { name: 'Excel Files', extensions: ['xlsx'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });

      if (result.canceled || !result.filePath) {
        return {
          success: false,
          error: 'Save cancelled by user',
          timestamp: Date.now()
        };
      }

      // Ensure file has .xlsx extension
      let filePath = result.filePath;
      if (!filePath.toLowerCase().endsWith('.xlsx')) {
        filePath += '.xlsx';
      }

      // Generate the report
      await proteaReportPackService.generateReport(request, filePath);

      return {
        success: true,
        data: { filePath },
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Error generating Protea Report Pack:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate Protea Report Pack',
        timestamp: Date.now()
      };
    }
  };

  /**
   * Gets list of departments that have data for a specific OU
   */
  getDepartmentsForOUHandler: IpcHandler = async (event, request: { ou: string; version?: string }): Promise<IpcResult> => {
    try {
      const departments = await db.getDepartmentsWithDataForOU(
        request.ou,
        request.version || 'MAIN'
      );

      return {
        success: true,
        data: departments,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Error getting departments for OU:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get departments',
        timestamp: Date.now()
      };
    }
  };
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createProteaReportPackHandlers() {
  const handlers = new ProteaReportPackHandlers();
  return {
    'protea:generate-report': handlers.generateReportHandler,
    'protea:get-departments-for-ou': handlers.getDepartmentsForOUHandler,
  };
}
