/**
 * Import System Main Entry Point
 * ==============================
 *
 * This is the main entry point for the import system.
 * It exports all necessary components for use throughout the application.
 */

// Core exports
export { default as ImportRegistry } from './core/registry';
export { BaseImportProcessor } from './core/baseProcessor';

// Interface exports
export type {
  IImportProcessor,
  ImportProcessorMetadata,
  ImportOptions,
  ImportResult,
  ValidationResult,
  ImportProgress,
  ImportError,
  ImportSession,
  ParsedFile,
  BatchResult
} from './core/interfaces';

// Utility exports
export {
  parseFile,
  parseCSVFile,
  parseExcelFile,
  parseJSONFile,
  getFileType,
  isSupportedFileType,
  getFileInfo,
  countFileRows,
  streamParseCSV,
  validateFile
} from './utils/fileParser';

// Processor exports
export { TestImportProcessor } from './processors/testImport';

/**
 * Quick start guide for creating a new import processor:
 * =====================================================
 *
 * 1. Copy src/services/imports/processors/testImport.ts as a template
 * 2. Rename the file and class to match your import (e.g., customerImport.ts)
 * 3. Update the metadata to describe your import
 * 4. Implement validateRow() for row-level validation
 * 5. Implement transformRow() for data transformation
 * 6. Register your processor in src/services/imports/core/registry.ts
 * 7. Test your import using the test mode first
 *
 * Example usage from frontend:
 * ```typescript
 * // Quick row count (test mode)
 * const testResult = await ipcRenderer.invoke('imports:testCount', {
 *   filePath: '/path/to/file.csv'
 * });
 * console.log(`File has ${testResult.rowCount} rows`);
 *
 * // Full import with validation
 * const result = await ipcRenderer.invoke('imports:processWithOptions', {
 *   importId: 'customer_data',
 *   filePath: '/path/to/file.csv',
 *   options: {
 *     skipValidation: false,
 *     batchSize: 1000
 *   }
 * });
 *
 * // Get available imports
 * const available = await ipcRenderer.invoke('imports:getAvailable');
 * console.log('Available imports:', available.methods);
 *
 * // Validate file before import
 * const validation = await ipcRenderer.invoke('imports:validateFile', {
 *   importName: 'customer_data',
 *   filePath: '/path/to/file.csv'
 * });
 * if (validation.success) {
 *   console.log(`File is valid with ${validation.validation.rowCount} rows`);
 * }
 * ```
 *
 * Available IPC channels:
 * - imports:execute - Execute with file dialog
 * - imports:executeWithFile - Execute with specific file
 * - imports:testCount - Quick row count
 * - imports:getAvailable - List all processors
 * - imports:getMethodDetails - Get processor details
 * - imports:validateFile - Validate file only
 * - imports:preview - Preview file contents
 * - imports:processWithOptions - Process with custom options
 * - imports:getStatistics - Get import statistics
 * - imports:getByCategory - Get processors by category
 */

// Initialize the registry on module load
import ImportRegistry from './core/registry';
ImportRegistry.initialize();