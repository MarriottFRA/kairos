/**
 * Template Export IPC Handlers
 * ============================
 * Handles CSV template download requests from the renderer process.
 * Generates header-only CSV files for manual data entry.
 */

import { dialog } from 'electron';
import * as fs from 'fs';
import { IpcHandler, IpcResult } from "../types";

// Template definitions: templateId -> { headers, defaultFileName }
const TEMPLATES: Record<string, { headers: string[]; defaultFileName: string }> = {
  line_items: {
    headers: ['FILETYPE', 'FILEVERSION', 'PROPCODE', 'BUSDATE', 'ACCTCODE', 'ACCTDESC', 'ENDINGBALANCE', 'ACTIVITY'],
    defaultFileName: 'ACCPAC_Line_Items_Template.csv',
  },
  worksheet_line_items: {
    headers: ['FILETYPE', 'FILEVERSION', 'PROPCODE', 'BUSDATE', 'ACCTCODE', 'ACCTDESC', 'WORKSHEETITEMCODE', 'PERIODAMT'],
    defaultFileName: 'ACCPAC_Worksheet_Line_Items_Template.csv',
  },
};

export class TemplateExportHandlers {
  /**
   * Downloads a CSV template with headers only
   */
  downloadCsvTemplateHandler: IpcHandler = async (_event, request: { templateId: string }): Promise<IpcResult> => {
    try {
      const template = TEMPLATES[request.templateId];
      if (!template) {
        return {
          success: false,
          error: `Unknown template: ${request.templateId}`,
          timestamp: Date.now(),
        };
      }

      const result = await dialog.showSaveDialog({
        title: 'Save CSV Template',
        defaultPath: template.defaultFileName,
        filters: [
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });

      if (result.canceled || !result.filePath) {
        return {
          success: false,
          error: 'Save cancelled by user',
          timestamp: Date.now(),
        };
      }

      let filePath = result.filePath;
      if (!filePath.toLowerCase().endsWith('.csv')) {
        filePath += '.csv';
      }

      const csvContent = template.headers.join(',') + '\n';
      fs.writeFileSync(filePath, csvContent, 'utf-8');

      return {
        success: true,
        data: { filePath },
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('Error saving CSV template:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save CSV template',
        timestamp: Date.now(),
      };
    }
  };
}

export function createTemplateExportHandlers() {
  const handlers = new TemplateExportHandlers();
  return {
    'template:download-csv': handlers.downloadCsvTemplateHandler,
  };
}
