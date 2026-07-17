/**
 * Import Registry
 * ==============
 *
 * Central registry for managing all import processors.
 * This is the main entry point for accessing and executing imports.
 */

import { dialog } from 'electron';
import * as path from 'path';
import {
  IImportProcessor,
  ImportProcessorMetadata,
  ImportOptions,
  ImportResult,
  ValidationResult
} from './interfaces';
import { getFileType, validateFile } from '../utils/fileParser';

// Import processors
import { TestImportProcessor } from '../processors/testImport';
import { AccpacLineItemsProcessor } from '../processors/accpac_line_items';
import { AccpacLineItems13Processor } from '../processors/accpac_line_items_13';
import { AccpacWorksheetImportProcessor } from '../processors/accpacWorksheetImport';
import { AccpacCompsImportProcessor } from '../processors/accpacCompsImport';
import { OperaRoomSegImportProcessor } from '../processors/operaRoomSegImport';
import { ManualImportFileProcessor } from '../processors/manualImportFile';

/**
 * Import execution request
 */
export interface ImportExecutionRequest {
  /** Import processor ID */
  importId: string;

  /** File path (optional - will show dialog if not provided) */
  filePath?: string;

  /** Import options */
  options?: ImportOptions;
}

/**
 * Import execution response
 */
export interface ImportExecutionResponse {
  /** Whether the import succeeded */
  success: boolean;

  /** Import processor ID */
  importId: string;

  /** File path that was processed */
  filePath?: string;

  /** Validation result */
  validation?: ValidationResult;

  /** Import result */
  result?: ImportResult;

  /** Error message if failed */
  error?: string;

  /** Execution time in milliseconds */
  duration?: number;
}

/**
 * Central registry for all import processors
 * Singleton pattern for global access
 */
export class ImportRegistry {
  /** Map of processor ID to processor instance */
  private static processors: Map<string, IImportProcessor> = new Map();

  /** Whether the registry has been initialized */
  private static initialized = false;

  /** Prevent instantiation */
  private constructor() {}

  /**
   * Initialize the registry with all available processors
   * This is called automatically on first use
   */
  static initialize(): void {
    if (this.initialized) {
      // console.log('[ImportRegistry] Already initialized');
      return;
    }

    // console.log('[ImportRegistry] Initializing...');
    // Register all processors here
    // Add new processors as you create them

    // Test processor (always first)
    this.register(new TestImportProcessor());

    // Production processors
    this.register(new AccpacLineItemsProcessor());
    this.register(new AccpacLineItems13Processor());
    this.register(new AccpacWorksheetImportProcessor());
    this.register(new AccpacCompsImportProcessor());
    this.register(new OperaRoomSegImportProcessor());
    this.register(new ManualImportFileProcessor());

    // TODO: Register additional processors here
    // this.register(new CustomerDataImportProcessor());
    // this.register(new InventoryImportProcessor());
    // this.register(new TransactionHistoryImportProcessor());
    // this.register(new EmployeeRecordsImportProcessor());
    // this.register(new BookingReservationsImportProcessor());

    this.initialized = true;
    // console.log(`[ImportRegistry] Initialized with ${this.processors.size} processors`);
  }

  /**
   * Register a new import processor
   * @param processor The processor to register
   */
  static register(processor: IImportProcessor): void {
    const id = processor.metadata.id;

    if (this.processors.has(id)) {
      // console.warn(`[ImportRegistry] Processor '${id}' already registered, replacing...`);
    }

    this.processors.set(id, processor);
    // console.log(`[ImportRegistry] Registered processor: ${processor.metadata.name} (${id})`);
  }

  /**
   * Unregister a processor
   * @param id Processor ID to unregister
   */
  static unregister(id: string): boolean {
    if (this.processors.has(id)) {
      const processor = this.processors.get(id);
      if (processor && processor.cleanup) {
        processor.cleanup().catch(console.error);
      }
      this.processors.delete(id);
      // console.log(`[ImportRegistry] Unregistered processor: ${id}`);
      return true;
    }
    return false;
  }

  /**
   * Get a processor by ID
   * @param id Processor ID
   * @returns Processor instance or undefined
   */
  static getProcessor(id: string): IImportProcessor | undefined {
    this.initialize();
    return this.processors.get(id);
  }

  /**
   * Get all registered processors
   * @returns Array of all processors
   */
  static getAllProcessors(): IImportProcessor[] {
    this.initialize();
    return Array.from(this.processors.values());
  }

  /**
   * Get all processor metadata for UI display
   * @returns Array of processor metadata sorted by order
   */
  static getAllMetadata(): ImportProcessorMetadata[] {
    this.initialize();
    return Array.from(this.processors.values())
      .map(p => p.metadata)
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Get processors by category
   * @param category Category to filter by
   * @returns Array of processors in that category
   */
  static getByCategory(category: string): IImportProcessor[] {
    this.initialize();
    return Array.from(this.processors.values())
      .filter(p => p.metadata.category === category);
  }

  /**
   * Get required processors only
   * @returns Array of required processors
   */
  static getRequiredProcessors(): IImportProcessor[] {
    this.initialize();
    return Array.from(this.processors.values())
      .filter(p => p.metadata.required);
  }

  /**
   * Search processors by tags
   * @param tags Tags to search for
   * @returns Array of matching processors
   */
  static searchByTags(tags: string[]): IImportProcessor[] {
    this.initialize();
    return Array.from(this.processors.values())
      .filter(p => {
        if (!p.metadata.tags) return false;
        return tags.some(tag => p.metadata.tags!.includes(tag));
      });
  }

  /**
   * Validate a file for a specific import processor
   * @param importId Processor ID
   * @param filePath File path to validate
   * @param options Validation options
   * @returns Validation result
   */
  static async validateFile(
    importId: string,
    filePath: string,
    options?: ImportOptions
  ): Promise<ValidationResult> {
    this.initialize();
    const processor = this.getProcessor(importId);

    if (!processor) {
      return {
        isValid: false,
        rowCount: 0,
        columnCount: 0,
        detectedColumns: [],
        errors: [`Import processor '${importId}' not found`]
      };
    }

    try {
      // First validate the file itself
      const fileValidation = await validateFile(filePath);
      if (!fileValidation.valid) {
        return {
          isValid: false,
          rowCount: 0,
          columnCount: 0,
          detectedColumns: [],
          errors: [fileValidation.error || 'File validation failed']
        };
      }

      const fileType = fileValidation.fileType || getFileType(filePath);

      // Check if processor supports this file type
      if (!processor.metadata.supportedFormats.includes(fileType)) {
        return {
          isValid: false,
          rowCount: 0,
          columnCount: 0,
          detectedColumns: [],
          errors: [`File type '${fileType}' not supported by this import processor`]
        };
      }

      // Run processor validation
      return await processor.validate(filePath, fileType, options);
    } catch (error) {
      console.error(`[ImportRegistry] Validation error:`, error);
      return {
        isValid: false,
        rowCount: 0,
        columnCount: 0,
        detectedColumns: [],
        errors: [error instanceof Error ? error.message : 'Validation failed']
      };
    }
  }

  /**
   * Execute an import with file dialog
   * Shows a file picker and processes the selected file
   * @param importId Processor ID
   * @param options Import options
   * @returns Execution response
   */
  static async executeImport(
    importId: string,
    options?: ImportOptions
  ): Promise<ImportExecutionResponse> {
    this.initialize();
    const startTime = Date.now();

    const processor = this.getProcessor(importId);
    if (!processor) {
      return {
        success: false,
        importId,
        error: `Import processor '${importId}' not found`
      };
    }

    try {
      // Show file picker dialog
      const dialogResult = await dialog.showOpenDialog({
        title: `Select File for ${processor.metadata.name}`,
        properties: ['openFile'],
        filters: this.getFileFilters(processor.metadata.supportedFormats)
      });

      if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
        return {
          success: false,
          importId,
          error: 'File selection canceled'
        };
      }

      const filePath = dialogResult.filePaths[0];

      // Execute with the selected file
      const result = await this.executeImportWithFile(importId, filePath, options);
      result.duration = Date.now() - startTime;
      return result;
    } catch (error) {
      console.error(`[ImportRegistry] Import execution error:`, error);
      return {
        success: false,
        importId,
        error: error instanceof Error ? error.message : 'Import execution failed',
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Execute an import with a specific file path
   * @param importId Processor ID
   * @param filePath Path to the file
   * @param options Import options
   * @returns Execution response
   */
  static async executeImportWithFile(
    importId: string,
    filePath: string,
    options?: ImportOptions
  ): Promise<ImportExecutionResponse> {
    this.initialize();
    const startTime = Date.now();

    // console.log(`[ImportRegistry] Executing import '${importId}' with file: ${filePath}`);
    const processor = this.getProcessor(importId);
    if (!processor) {
      return {
        success: false,
        importId,
        filePath,
        error: `Import processor '${importId}' not found`
      };
    }

    try {
      // Validate file first (unless skipped)
      let validation: ValidationResult | undefined;
      if (!options?.skipValidation) {
        validation = await this.validateFile(importId, filePath, options);
        if (!validation.isValid) {
          return {
            success: false,
            importId,
            filePath,
            validation,
            error: `Validation failed: ${validation.errors?.join(', ') || 'Invalid file'}`,
            duration: Date.now() - startTime
          };
        }
      }

      // Get file type
      const fileType = getFileType(filePath);

      // Process the file
      const result = await processor.process(filePath, fileType, options);

      return {
        success: result.success,
        importId,
        filePath,
        validation,
        result,
        error: result.success ? undefined : result.errors?.join(', '),
        duration: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[ImportRegistry] Import execution error:`, error);
      return {
        success: false,
        importId,
        filePath,
        error: error instanceof Error ? error.message : 'Import execution failed',
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Execute a quick test import (row counting only)
   * @param filePath Path to the file
   * @param importId Optional specific processor to use (defaults to test_import)
   * @returns Test result with row count
   */
  static async executeTestImport(
    filePath: string,
    importId: string = 'test_import'
  ): Promise<ImportExecutionResponse> {
    return this.executeImportWithFile(importId, filePath, {
      testMode: true,
      skipValidation: true,
      skipPreImport: true,
      skipPostImport: true
    });
  }

  /**
   * Preview file contents
   * @param importId Processor ID
   * @param filePath File path
   * @param rows Number of rows to preview
   * @returns Preview data
   */
  static async previewFile(
    importId: string,
    filePath: string,
    rows: number = 10
  ): Promise<any[]> {
    this.initialize();
    const processor = this.getProcessor(importId);

    if (!processor) {
      throw new Error(`Import processor '${importId}' not found`);
    }

    if (!processor.preview) {
      throw new Error(`Processor '${importId}' does not support preview`);
    }

    const fileType = getFileType(filePath);
    return processor.preview(filePath, fileType, rows);
  }

  /**
   * Get file filters for dialog
   * @param formats Supported formats
   * @returns File filter array for Electron dialog
   */
  private static getFileFilters(formats: string[]): Electron.FileFilter[] {
    const filters: Electron.FileFilter[] = [];

    // Add specific filters
    if (formats.includes('csv')) {
      filters.push({ name: 'CSV Files', extensions: ['csv'] });
    }
    if (formats.includes('xlsx') || formats.includes('xls')) {
      filters.push({ name: 'Excel Files', extensions: ['xlsx', 'xls', 'xlsm', 'xlsb'] });
    }
    if (formats.includes('json')) {
      filters.push({ name: 'JSON Files', extensions: ['json'] });
    }
    if (formats.includes('txt')) {
      filters.push({ name: 'Text Files', extensions: ['txt'] });
    }

    // Add combined filter if multiple types
    if (filters.length > 1) {
      const allExtensions = filters.flatMap(f => f.extensions);
      filters.unshift({
        name: 'Supported Files',
        extensions: allExtensions
      });
    }

    // Always add all files option
    filters.push({ name: 'All Files', extensions: ['*'] });

    return filters;
  }

  /**
   * Clean up all processors
   * Called on application shutdown
   */
  static async cleanup(): Promise<void> {
    // console.log('[ImportRegistry] Cleaning up all processors...');
    const cleanupPromises: Promise<void>[] = [];
    for (const processor of this.processors.values()) {
      if (processor.cleanup) {
        cleanupPromises.push(processor.cleanup());
      }
    }

    await Promise.all(cleanupPromises);
    this.processors.clear();
    this.initialized = false;

    // console.log('[ImportRegistry] Cleanup complete');
  }

  /**
   * Get import statistics
   * @returns Statistics about registered imports
   */
  static getStatistics(): {
    totalProcessors: number;
    byCategory: Record<string, number>;
    requiredCount: number;
    supportedFormats: string[];
  } {
    this.initialize();

    const byCategory: Record<string, number> = {};
    const formats = new Set<string>();

    for (const processor of this.processors.values()) {
      // Count by category
      const category = processor.metadata.category;
      byCategory[category] = (byCategory[category] || 0) + 1;

      // Collect formats
      processor.metadata.supportedFormats.forEach(f => formats.add(f));
    }

    return {
      totalProcessors: this.processors.size,
      byCategory,
      requiredCount: this.getRequiredProcessors().length,
      supportedFormats: Array.from(formats)
    };
  }
}

// Export as default
export default ImportRegistry;