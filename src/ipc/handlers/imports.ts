/**
 * Import IPC Handlers
 * ===================
 *
 * Electron IPC handlers for import operations.
 * These handlers bridge between the renderer process and the import system.
 */

import ImportRegistry from '../../services/imports/core/registry';
import type { IpcHandler } from '../types';
import type { ImportOptions } from '../../services/imports/core/interfaces';

/**
 * Create import-related IPC handlers
 * These handlers bridge between the Electron IPC and the ImportRegistry
 */
export function createImportsHandlers(): Record<string, IpcHandler> {
  // Initialize the registry
  ImportRegistry.initialize();

  return {
    /**
     * Execute an import with file dialog
     * Frontend usage: await ipcRenderer.invoke('imports:execute', 'customer_data')
     */
    'imports:execute': async (_event, importName: string, options?: ImportOptions) => {
      // console.log(`[IPC] Executing import: ${importName}`);
      try {
        const response = await ImportRegistry.executeImport(importName, options);

        // console.log(`[IPC] Import result:`, {
        //   importName,
        //   success: response.success,
        //   rowCount: response.result?.rowCount,
        //   error: response.error
        // });

        // Convert to legacy format for backward compatibility
        return {
          success: response.success,
          rowCount: response.result?.rowCount || 0,
          message: response.error ||
                  (response.result?.metadata?.message as string) ||
                  `Import ${response.success ? 'completed' : 'failed'}`,
          error: response.error,
          data: response.result?.data,
          filePath: response.filePath
        };
      } catch (error) {
        console.error(`[IPC] Import error:`, error);
        return {
          success: false,
          rowCount: 0,
          message: `Import error: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    },

    /**
     * Execute import with a specific file path
     * Frontend usage: await ipcRenderer.invoke('imports:executeWithFile', { importName: 'customer_data', filePath: '/path/to/file.csv' })
     */
    'imports:executeWithFile': async (_event, request: { importName: string, filePath: string, options?: ImportOptions }) => {
      const { importName, filePath, options } = request;
      // console.log(`[IPC] Executing import with file: ${importName}, path: ${filePath}`);
      try {
        const response = await ImportRegistry.executeImportWithFile(importName, filePath, options);

        // console.log(`[IPC] Import with file result:`, {
        //   importName,
        //   filePath,
        //   success: response.success,
        //   rowCount: response.result?.rowCount
        // });

        // Convert to legacy format for backward compatibility
        return {
          success: response.success,
          rowCount: response.result?.rowCount || 0,
          message: response.error ||
                  (response.result?.metadata?.message as string) ||
                  `Import ${response.success ? 'completed' : 'failed'}`,
          error: response.error,
          data: response.result?.data,
          filePath: response.filePath
        };
      } catch (error) {
        console.error(`[IPC] Import with file error:`, error);
        return {
          success: false,
          rowCount: 0,
          message: `Import error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          filePath
        };
      }
    },

    /**
     * Quick test import - just count rows without processing
     * Frontend usage: await ipcRenderer.invoke('imports:testCount', { filePath: '/path/to/file.csv' })
     */
    'imports:testCount': async (_event, request: { filePath: string, importName?: string }) => {
      const { filePath, importName = 'test_import' } = request;
      // console.log(`[IPC] Test counting rows in: ${filePath}`);
      try {
        const response = await ImportRegistry.executeTestImport(filePath, importName);

        return {
          success: response.success,
          rowCount: response.result?.rowCount || 0,
          testMode: true,
          message: response.error || `Found ${response.result?.rowCount || 0} rows`,
          filePath: response.filePath,
          columns: response.result?.metadata?.columns,
          sampleData: response.result?.metadata?.sampleData
        };
      } catch (error) {
        console.error(`[IPC] Test count error:`, error);
        return {
          success: false,
          rowCount: 0,
          testMode: true,
          message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          filePath
        };
      }
    },

    /**
     * Get list of available import methods
     * Frontend usage: await ipcRenderer.invoke('imports:getAvailable')
     */
    'imports:getAvailable': async () => {
      const metadata = ImportRegistry.getAllMetadata();

      // console.log(`[IPC] Available import methods:`, metadata.map(m => m.id));
      return {
        success: true,
        methods: metadata.map(m => ({
          name: m.id,
          displayName: m.name,
          description: m.description,
          type: m.category,
          required: m.required,
          order: m.order,
          supportedFormats: m.supportedFormats,
          tags: m.tags
        }))
      };
    },

    /**
     * Get import method details
     * Frontend usage: await ipcRenderer.invoke('imports:getMethodDetails', 'customer_data')
     */
    'imports:getMethodDetails': async (_event, importName: string) => {
      const processor = ImportRegistry.getProcessor(importName);

      if (!processor) {
        return {
          success: false,
          message: `Import method '${importName}' not found`
        };
      }

      // Return processor metadata with all details
      const metadata = processor.metadata;
      return {
        success: true,
        details: {
          name: metadata.id,
          displayName: metadata.name,
          description: metadata.description,
          category: metadata.category,
          available: true,
          supportedFormats: metadata.supportedFormats,
          requiredColumns: metadata.requiredColumns,
          optionalColumns: metadata.optionalColumns,
          validationRules: metadata.validationRules,
          tags: metadata.tags,
          version: metadata.version,
          required: metadata.required,
          order: metadata.order,
          sampleDataUrl: metadata.sampleDataUrl
        }
      };
    },

    /**
     * Validate a file for a specific import processor
     * Frontend usage: await ipcRenderer.invoke('imports:validateFile', { importName: 'customer_data', filePath: '/path/to/file.csv', fileType: 'csv' })
     */
    'imports:validateFile': async (_event, params: {
      importName: string;
      filePath: string;
      fileType?: string;
      options?: ImportOptions;
    }) => {
      const { importName, filePath, options } = params;

      // console.log(`[IPC] Validating file for import: ${importName}, path: ${filePath}`);
      try {
        const validationResult = await ImportRegistry.validateFile(importName, filePath, options);

        // console.log(`[IPC] Validation result:`, {
        //   importName,
        //   isValid: validationResult.isValid,
        //   rowCount: validationResult.rowCount
        // });

        return {
          success: validationResult.isValid,
          validation: validationResult,
          message: validationResult.errors?.join(', ') ||
                  (validationResult.isValid ? 'Validation successful' : 'Validation failed')
        };
      } catch (error) {
        console.error(`[IPC] Validation error:`, error);
        return {
          success: false,
          message: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    },

    /**
     * Preview file contents
     * Frontend usage: await ipcRenderer.invoke('imports:preview', { importName: 'customer_data', filePath: '/path/to/file.csv', rows: 10 })
     */
    'imports:preview': async (_event, params: {
      importName: string;
      filePath: string;
      rows?: number;
    }) => {
      const { importName, filePath, rows = 10 } = params;

      // console.log(`[IPC] Previewing file for import: ${importName}, path: ${filePath}`);
      try {
        const previewData = await ImportRegistry.previewFile(importName, filePath, rows);

        return {
          success: true,
          data: previewData,
          rowCount: previewData.length,
          message: `Preview of first ${previewData.length} rows`
        };
      } catch (error) {
        console.error(`[IPC] Preview error:`, error);
        return {
          success: false,
          data: [],
          rowCount: 0,
          message: `Preview error: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    },

    /**
     * Process import with custom options
     * Frontend usage: await ipcRenderer.invoke('imports:processWithOptions', { importId: 'customer_data', filePath: '/path/to/file.csv', options: { ... } })
     */
    'imports:processWithOptions': async (_event, params: {
      importId: string;
      filePath?: string;
      options?: ImportOptions;
    }) => {
      const { importId, filePath, options } = params;

      // console.log(`[IPC] Processing import with options: ${importId}`);
      try {
        const response = filePath
          ? await ImportRegistry.executeImportWithFile(importId, filePath, options)
          : await ImportRegistry.executeImport(importId, options);

        return {
          success: response.success,
          importId: response.importId,
          filePath: response.filePath,
          validation: response.validation,
          result: response.result,
          error: response.error,
          duration: response.duration
        };
      } catch (error) {
        console.error(`[IPC] Process with options error:`, error);
        return {
          success: false,
          importId,
          filePath,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    },

    /**
     * Get import statistics
     * Frontend usage: await ipcRenderer.invoke('imports:getStatistics')
     */
    'imports:getStatistics': async () => {
      const stats = ImportRegistry.getStatistics();

      return {
        success: true,
        statistics: stats
      };
    },

    /**
     * Get processors by category
     * Frontend usage: await ipcRenderer.invoke('imports:getByCategory', 'Customer Data')
     */
    'imports:getByCategory': async (_event, category: string) => {
      const processors = ImportRegistry.getByCategory(category);

      return {
        success: true,
        processors: processors.map(p => ({
          id: p.metadata.id,
          name: p.metadata.name,
          description: p.metadata.description,
          required: p.metadata.required,
          order: p.metadata.order
        }))
      };
    }
  };
}