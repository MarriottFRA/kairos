/**
 * BST Extract IPC Handlers
 * =========================
 * Generates a BST Extract CSV for the selected OU using a user-defined
 * period mapping. Mapping persistence reuses the existing `settings-*`
 * channels (key: `bstExtractMapping`) — no new persistence plumbing needed.
 */

import { dialog } from "electron";
import { IpcHandler, IpcResult } from "../types";
import bstExtractService, { BSTExtractConfig } from "../../services/reports/bstExtractService";

export class BSTExtractHandlers {
  generateHandler: IpcHandler = async (event, request: BSTExtractConfig): Promise<IpcResult> => {
    try {
      if (!request?.ou) {
        return { success: false, error: 'OU is required', timestamp: Date.now() };
      }
      if (!request?.mapping || Object.keys(request.mapping).length === 0) {
        return { success: false, error: 'Period mapping is required', timestamp: Date.now() };
      }

      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const safeOu = (request.ou || '').replace(/[^a-zA-Z0-9]/g, '_');
      const defaultFileName = `BST_Extract_${safeOu}_${stamp}.csv`;

      const result = await dialog.showSaveDialog({
        title: 'Save BST Extract',
        defaultPath: defaultFileName,
        filters: [
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Save cancelled by user', timestamp: Date.now() };
      }

      let filePath = result.filePath;
      if (!filePath.toLowerCase().endsWith('.csv')) filePath += '.csv';

      await bstExtractService.generate(request, filePath);

      return { success: true, data: { filePath }, timestamp: Date.now() };
    } catch (error) {
      console.error('Error generating BST Extract:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate BST Extract',
        timestamp: Date.now(),
      };
    }
  };
}

export function createBSTExtractHandlers() {
  const handlers = new BSTExtractHandlers();
  return {
    'protea:generate-bst-extract': handlers.generateHandler,
  };
}
