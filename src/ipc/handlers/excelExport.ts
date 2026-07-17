/**
 * Excel Export IPC Handlers
 * =========================
 * Handles Excel report generation requests from the renderer process.
 */

import { dialog } from 'electron';
import { IpcHandler, IpcResult } from "../types";
import excelExportService, { ExcelExportConfig } from "../../services/excelExportService";
import * as db from "../../local_db";

// ============================================================================
// HANDLER CLASS
// ============================================================================

export class ExcelExportHandlers {
  /**
   * Generates an Excel report and saves it to a user-selected location
   */
  generateReportHandler: IpcHandler = async (event, request: ExcelExportConfig): Promise<IpcResult> => {
    try {
      // Look up the actual hotel name from cache
      const hotelName = await db.getHotelNameByOU(request.ou);
      if (hotelName) {
        request.hotelName = hotelName;
      }

      // Build default filename
      const monthStr = String(request.selectedMonth).padStart(2, '0');
      const safeFileName = (hotelName || request.hotelName).replace(/[^a-zA-Z0-9]/g, '_');
      const defaultFileName = `${safeFileName}_Marriott_Report_Pack_${request.selectedYear}-${monthStr}.xlsx`;

      // Show save dialog
      const result = await dialog.showSaveDialog({
        title: 'Save Marriott Excel Report Pack',
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
      await excelExportService.generateReport(request, filePath);

      return {
        success: true,
        data: { filePath },
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Error generating Excel report:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate Excel report',
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

export function createExcelExportHandlers() {
  const handlers = new ExcelExportHandlers();
  return {
    'excel:generate-report': handlers.generateReportHandler,
    'excel:get-departments-for-ou': handlers.getDepartmentsForOUHandler,
  };
}
