/**
 * Protea Budget Pack IPC Handlers
 * ================================
 * Handles Protea Budget Pack generation requests from the renderer process.
 */

import { dialog } from 'electron';
import { IpcHandler, IpcResult } from "../types";
import proteaBudgetPackService, { ProteaBudgetPackConfig } from "../../services/proteaBudgetPackService";
import * as db from "../../local_db";

// ============================================================================
// HANDLER CLASS
// ============================================================================

export class ProteaBudgetPackHandlers {
  /**
   * Generates a Protea Budget Pack and saves it to a user-selected location
   */
  generateReportHandler: IpcHandler = async (event, request: ProteaBudgetPackConfig): Promise<IpcResult> => {
    try {
      // Look up the actual hotel name from cache
      const hotelName = await db.getHotelNameByOU(request.ou);
      if (hotelName) {
        request.hotelName = hotelName;
      }

      // Build default filename
      const startStr = `${request.startYear}-${String(request.startMonth).padStart(2, '0')}`;
      const endStr = `${request.endYear}-${String(request.endMonth).padStart(2, '0')}`;
      const safeFileName = (hotelName || request.hotelName).replace(/[^a-zA-Z0-9]/g, '_');
      const defaultFileName = `${safeFileName}_Protea_Budget_Pack_${startStr}_to_${endStr}.xlsx`;

      // Show save dialog
      const result = await dialog.showSaveDialog({
        title: 'Save Protea Budget Pack',
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
      await proteaBudgetPackService.generateReport(request, filePath);

      return {
        success: true,
        data: { filePath },
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Error generating Protea Budget Pack:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate Protea Budget Pack',
        timestamp: Date.now()
      };
    }
  };
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createProteaBudgetPackHandlers() {
  const handlers = new ProteaBudgetPackHandlers();
  return {
    'protea:generate-budget-pack': handlers.generateReportHandler,
  };
}
