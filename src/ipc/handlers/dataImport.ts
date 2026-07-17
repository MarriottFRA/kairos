/**
 * Data Import IPC Handlers
 * Handles file import, validation, and data import operations
 *
 * This handler integrates with the ImportProcessors service to provide
 * a flexible, extensible import system that can handle multiple import types.
 */

import { IpcHandler } from "../types";
import { ImportColumn } from "../../types/dataImport";
import {
  ImportRegistry,
  ImportProcessorMetadata,
  ValidationResult as ProcessorValidationResult,
  ImportResult
} from "../../services/imports";
import { DataImportPageConfig, ImportCardConfig } from "../../types/pageConfig";

export class DataImportHandlers {
  /**
   * Initialize the import registry on handler creation
   */
  constructor() {
    // Ensure the import registry is initialized
    ImportRegistry.initialize();
  }

  /**
   * Get list of available imports
   * Returns metadata for all registered import processors
   */
  getAvailableImports: IpcHandler<void, ImportProcessorMetadata[]> = async () => {
    try {
      const metadata = ImportRegistry.getAllMetadata();
      return metadata;
    } catch (error) {
      console.error('Error getting available imports:', error);
      return [];
    }
  };

  /**
   * Get import processor by ID
   * Returns detailed metadata for a specific import type
   */
  getImportDetails: IpcHandler<{ importId: string }, ImportProcessorMetadata | null> = async (_event, { importId }) => {
    try {
      const processor = ImportRegistry.getProcessor(importId);
      return processor ? processor.metadata : null;
    } catch (error) {
      console.error('Error getting import details:', error);
      return null;
    }
  };

  /**
   * Validate an uploaded file for import
   * Uses the appropriate processor to validate file structure and content
   */
  validateDataImportFile: IpcHandler<
    { importId: string; filePath: string; fileType: string },
    { isValid: boolean; columns?: ImportColumn[]; rowCount?: number; errors?: string[] }
  > = async (_event, { importId, filePath, fileType }) => {
    try {
      // Get the appropriate processor for this import type
      const processor = ImportRegistry.getProcessor(importId);

      if (!processor) {
        return {
          isValid: false,
          rowCount: 0,
          errors: [`Unknown import type: ${importId}`]
        };
      }

      // Validate using the processor
      const validationResult: ProcessorValidationResult = await processor.validate(filePath, fileType);

      // Convert processor columns to ImportColumn format
      const columns: ImportColumn[] = validationResult.detectedColumns.map(col => ({
        name: col,
        required: processor.metadata.requiredColumns?.includes(col) || false,
        dataType: 'string' // Default, could be enhanced based on data analysis
      }));

      return {
        isValid: validationResult.isValid,
        columns,
        rowCount: validationResult.rowCount,
        errors: validationResult.errors ||
                (validationResult.missingRequiredColumns?.length
                  ? [`Missing required columns: ${validationResult.missingRequiredColumns.join(', ')}`]
                  : undefined)
      };
    } catch (error) {
      console.error('Error validating Data Import file:', error);
      return {
        isValid: false,
        rowCount: 0,
        errors: [error instanceof Error ? error.message : 'Unknown validation error']
      };
    }
  };

  /**
   * Count rows in a file
   * Quick operation that just counts rows without full validation
   */
  countFileRows: IpcHandler<
    { filePath: string; fileType: string },
    { rowCount: number; error?: string }
  > = async (_event, { filePath, fileType }) => {
    try {
      // Use a simple processor just for counting
      const processor = ImportRegistry.getAllProcessors()[0]; // Use any processor for parsing

      if (!processor) {
        return {
          rowCount: 0,
          error: 'No processors available'
        };
      }

      const validationResult = await processor.validate(filePath, fileType);

      return {
        rowCount: validationResult.rowCount
      };
    } catch (error) {
      console.error('Error counting file rows:', error);
      return {
        rowCount: 0,
        error: error instanceof Error ? error.message : 'Failed to count rows'
      };
    }
  };

  /**
   * Import a validated file
   * Processes the file using the appropriate import processor
   */
  importDataImportFile: IpcHandler<
    { importId: string; filePath: string; fileType: string; mapping?: Record<string, string> },
    { processed: number; failed: number; errors?: string[] }
  > = async (_event, { importId, filePath, fileType, mapping }) => {
    try {
      // Get the appropriate processor
      const processor = ImportRegistry.getProcessor(importId);

      if (!processor) {
        return {
          processed: 0,
          failed: 0,
          errors: [`Unknown import type: ${importId}`]
        };
      }

      // Process the import
      const result: ImportResult = await processor.process(filePath, fileType, { mapping });

      // Call post-process hook if available
      if (processor.postProcess && result.success) {
        await processor.postProcess(result);
      }

      return {
        processed: result.processedRows || 0,
        failed: result.skippedRows || 0,
        errors: result.errors
      };
    } catch (error) {
      console.error('Error importing Data Import file:', error);
      return {
        processed: 0,
        failed: 0,
        errors: [error instanceof Error ? error.message : 'Unknown import error']
      };
    }
  };

  /**
   * Get a preview of file contents
   * Returns first few rows for user verification
   */
  getDataImportFilePreview: IpcHandler<
    { filePath: string; fileType: string; rows?: number },
    { headers: string[]; data: any[][] }
  > = async (_event, { filePath, fileType, rows = 5 }) => {
    try {
      // Use any processor for preview (they all can parse files)
      const processor = ImportRegistry.getAllProcessors()[0];

      if (!processor) {
        return {
          headers: [],
          data: []
        };
      }

      // If processor has preview method, use it
      if (processor.preview) {
        const previewData = await processor.preview(filePath, fileType, rows);
        const headers = previewData.length > 0 ? Object.keys(previewData[0]) : [];
        const data = previewData.map(row => Object.values(row));

        return {
          headers,
          data
        };
      }

      // Otherwise, do a basic validation to get column info
      const validationResult = await processor.validate(filePath, fileType);

      return {
        headers: validationResult.detectedColumns,
        data: [] // No data preview if processor doesn't support it
      };
    } catch (error) {
      console.error('Error getting file preview:', error);
      return {
        headers: [],
        data: []
      };
    }
  };

  /**
   * Compile all imported data
   * Moves data from staging to final processing area
   */
  compileDataImport: IpcHandler<
    { sessionId: string; hotelId: string },
    { success: boolean; recordsCompiled: number }
  > = async (_event, { }) => {
    try {
      // TODO: Implement actual data compilation logic
      // This will:
      // 1. Retrieve all imported data from staging
      // 2. Run validation checks across all data sets
      // 3. Apply business rules and transformations
      // 4. Check for data consistency and relationships
      // 5. Move to final processing area
      // 6. Clear staging area
      // 7. Return compilation results

      // Stub implementation - simulates compilation
      await new Promise(resolve => setTimeout(resolve, 3000)); // Simulate compilation time

      return {
        success: true,
        recordsCompiled: Math.floor(Math.random() * 5000) + 1000
      };
    } catch (error) {
      console.error('Error compiling Data Import data:', error);
      return {
        success: false,
        recordsCompiled: 0
      };
    }
  };

  /**
   * Get page configuration for data import page
   * Returns the complete JSON config for rendering the import UI
   */
  getPageConfig: IpcHandler<void, DataImportPageConfig> = async () => {
    try {
      // Get all registered import processors
      const metadata = ImportRegistry.getAllMetadata();

      // Convert processor metadata to import card configs
      const importCards: ImportCardConfig[] = metadata.map((meta) => ({
        id: meta.id,
        displayName: meta.name,
        description: meta.description,
        icon: this.getCategoryIcon(meta.category),
        category: meta.category,
        fileTypes: meta.supportedFormats,
        required: meta.required,
        order: meta.order,
        requiredColumns: meta.requiredColumns,
        optionalColumns: meta.optionalColumns,
        validationRules: meta.validationRules,
      }));

      // Build the complete page config
      const pageConfig: DataImportPageConfig = {
        header: {
          title: 'Import Data',
          subtitle: 'Upload and process your hotel data files',
          icon: '', // Clean, professional design without emojis
          gradient: {
            from: '#667eea',
            to: '#764ba2',
          },
          stats: [
            {
              label: 'Completed',
              value: 0,
              color: 'primary',
              dynamic: true,
            },
            {
              label: 'Total Files',
              value: importCards.length,
              color: 'secondary',
              dynamic: false,
            },
          ],
        },
        importCards: importCards,
        actions: [
          {
            id: 'restart',
            label: 'Restart Import',
            icon: 'refresh',
            variant: 'secondary',
            action: 'restart',
            disabled: {
              condition: 'processing',
            },
          },
          {
            id: 'start',
            label: 'Complete Import',
            icon: 'check_circle',
            variant: 'primary',
            action: 'startImport',
            disabled: {
              condition: 'requiredMissing',
            },
            gradient: {
              from: '#667eea',
              to: '#764ba2',
            },
          },
        ],
        infoSection: {
          severity: 'info',
          title: 'Sequential Import Process',
          items: [
            'Files are validated automatically upon selection',
            'Required files must be uploaded before starting import',
            'Imports must be completed sequentially - each import is locked until the previous one completes',
            'Each import includes pre-processing, import, and post-processing steps',
            'Data from all imports is blended together into a unified dataset',
            'Files cannot be changed once import starts - use "Restart Import" to start over',
            'All data is saved to your secure staging area',
          ],
        },
        importMode: 'sequential',
        enableCompilation: true,
        compilationMessage: 'Blending data from all imports...',
      };

      return pageConfig;
    } catch (error) {
      console.error('Error getting page config:', error);
      // Return a minimal config on error
      return {
        header: {
          title: 'Import Data',
          icon: '📊',
          gradient: { from: '#667eea', to: '#764ba2' },
        },
        importCards: [],
        actions: [],
        infoSection: {
          severity: 'error',
          title: 'Configuration Error',
          items: ['Failed to load page configuration'],
        },
        importMode: 'sequential',
      };
    }
  };

  /**
   * Get category icon - returns empty string for clean, professional look
   */
  private getCategoryIcon(_category: string): string {
    return ''; // Professional design without emojis
  }

  /**
   * Process multiple imports in sequence
   * Handles a batch of imports with proper ordering
   */
  processBatchImport: IpcHandler<
    { imports: Array<{ importId: string; filePath: string; fileType: string }> },
    { totalProcessed: number; totalFailed: number; results: Array<{ importId: string; success: boolean; processed: number; failed: number; errors?: string[] }> }
  > = async (_event, { imports }) => {
    const results: Array<{ importId: string; success: boolean; processed: number; failed: number; errors?: string[] }> = [];
    let totalProcessed = 0;
    let totalFailed = 0;

    // Sort imports by processor order
    const sortedImports = imports.sort((a, b) => {
      const processorA = ImportRegistry.getProcessor(a.importId);
      const processorB = ImportRegistry.getProcessor(b.importId);
      return (processorA?.metadata.order || 999) - (processorB?.metadata.order || 999);
    });

    // Process each import sequentially
    for (const importData of sortedImports) {
      try {
        const processor = ImportRegistry.getProcessor(importData.importId);

        if (!processor) {
          results.push({
            importId: importData.importId,
            success: false,
            processed: 0,
            failed: 0,
            errors: [`Unknown import type: ${importData.importId}`]
          });
          continue;
        }

        // Validate first
        const validationResult = await processor.validate(importData.filePath, importData.fileType);

        if (!validationResult.isValid) {
          results.push({
            importId: importData.importId,
            success: false,
            processed: 0,
            failed: validationResult.rowCount,
            errors: validationResult.errors
          });
          totalFailed += validationResult.rowCount;
          continue;
        }

        // Process the import
        const importResult = await processor.process(importData.filePath, importData.fileType);

        results.push({
          importId: importData.importId,
          success: importResult.success,
          processed: importResult.processedRows || 0,
          failed: importResult.skippedRows || 0,
          errors: importResult.errors
        });

        totalProcessed += importResult.processedRows || 0;
        totalFailed += importResult.skippedRows || 0;

        // Post-process if available
        if (processor.postProcess && importResult.success) {
          await processor.postProcess(importResult);
        }
      } catch (error) {
        results.push({
          importId: importData.importId,
          success: false,
          processed: 0,
          failed: 0,
          errors: [error instanceof Error ? error.message : 'Processing failed']
        });
      }
    }

    return {
      totalProcessed,
      totalFailed,
      results
    };
  };
}

// Factory function to create and register Data Import handlers
export function createDataImportHandlers() {
  const handlers = new DataImportHandlers();

  return {
    'dataImport:getPageConfig': handlers.getPageConfig,
    'dataImport:getAvailableImports': handlers.getAvailableImports,
    'dataImport:getImportDetails': handlers.getImportDetails,
    'dataImport:validateFile': handlers.validateDataImportFile,
    'dataImport:countRows': handlers.countFileRows,
    'dataImport:importFile': handlers.importDataImportFile,
    'dataImport:getFilePreview': handlers.getDataImportFilePreview,
    'dataImport:compileData': handlers.compileDataImport,
    'dataImport:processBatch': handlers.processBatchImport,
  };
}