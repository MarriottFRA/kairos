/**
 * Base Import Processor Abstract Class
 * =====================================
 *
 * This abstract class provides common functionality for all import processors.
 * Extend this class when creating new import processors to get built-in features.
 */

import {
  IImportProcessor,
  ImportProcessorMetadata,
  ValidationResult,
  ImportResult,
  ImportOptions,
  ParsedFile
} from './interfaces';
import { parseFile } from '../utils/fileParser';
import * as fs from 'fs/promises';

/**
 * Abstract base class for import processors
 * Provides common functionality and default implementations
 */
export abstract class BaseImportProcessor implements IImportProcessor {
  /** Processor metadata - must be defined by subclasses */
  abstract metadata: ImportProcessorMetadata;

  /** Track if processor has been initialized */
  protected initialized: boolean = false;

  /** Store parsed file data for reuse between validate and process */
  protected cachedParsedFile?: ParsedFile;
  protected cachedFilePath?: string;

  /**
   * Initialize the processor
   * Override to add custom initialization logic
   */
  protected async initialize(): Promise<void> {
    if (this.initialized) return;

    // console.log(`[${this.metadata.id}] Initializing processor: ${this.metadata.name}`);
    this.initialized = true;
  }

  /**
   * Pre-import hook with default implementation
   * Override to add custom pre-import logic
   */
  async preImport(filePath: string, options?: ImportOptions): Promise<void> {
    await this.initialize();

    if (options?.skipPreImport) {
      // console.log(`[${this.metadata.id}] Skipping pre-import hooks`);
      return;
    }

    // console.log(`[${this.metadata.id}] Running pre-import hooks for: ${filePath}`);
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Check file size
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      throw new Error('File is empty');
    }
    if (stats.size > 100 * 1024 * 1024) { // 100MB limit by default
      // console.warn(`[${this.metadata.id}] Large file detected (${Math.round(stats.size / 1024 / 1024)}MB)`);
    }
  }

  /**
   * Default validation implementation
   * Override to add custom validation logic
   */
  async validate(filePath: string, fileType: string, options?: ImportOptions): Promise<ValidationResult> {
    // console.log(`[${this.metadata.id}] Validating file: ${filePath}`);
    // Skip validation if requested
    if (options?.skipValidation) {
      // console.log(`[${this.metadata.id}] Skipping validation (skipValidation=true)`);
      return {
        isValid: true,
        rowCount: 0,
        columnCount: 0,
        detectedColumns: [],
        warnings: ['Validation was skipped']
      };
    }

    try {
      // Parse the file
      const parsed = await this.getParsedFile(filePath, fileType, options);

      // Check for required columns
      const missingColumns = this.metadata.requiredColumns?.filter(
        col => !parsed.columns.includes(col)
      ) || [];

      // Check for unknown columns
      const knownColumns = [
        ...(this.metadata.requiredColumns || []),
        ...(this.metadata.optionalColumns || [])
      ];
      const unknownColumns = knownColumns.length > 0
        ? parsed.columns.filter(col => !knownColumns.includes(col))
        : [];

      // Get file stats
      const fileStats = await fs.stat(filePath);

      // Prepare warnings
      const warnings: string[] = [];
      if (parsed.rowCount === 0) {
        warnings.push('File contains no data rows');
      }
      if (parsed.rowCount > 10000) {
        warnings.push(`Large dataset detected (${parsed.rowCount} rows). Processing may take time.`);
      }
      if (unknownColumns.length > 0) {
        warnings.push(`Unknown columns will be ignored: ${unknownColumns.join(', ')}`);
      }

      // Get sample data for preview
      const sampleData = parsed.data.slice(0, 5);

      return {
        isValid: missingColumns.length === 0 && parsed.rowCount > 0,
        rowCount: parsed.rowCount,
        columnCount: parsed.columns.length,
        detectedColumns: parsed.columns,
        missingRequiredColumns: missingColumns.length > 0 ? missingColumns : undefined,
        unknownColumns: unknownColumns.length > 0 ? unknownColumns : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        fileInfo: {
          size: fileStats.size,
          encoding: parsed.metadata?.encoding || 'utf-8',
          delimiter: parsed.metadata?.delimiter,
          hasHeaders: parsed.metadata?.hasHeaders !== false
        },
        sampleData
      };
    } catch (error) {
      console.error(`[${this.metadata.id}] Validation error:`, error);
      return {
        isValid: false,
        rowCount: 0,
        columnCount: 0,
        detectedColumns: [],
        errors: [error instanceof Error ? error.message : 'Unknown validation error']
      };
    }
  }

  /**
   * Default processing implementation
   * Override to add custom processing logic
   */
  async process(filePath: string, fileType: string, options?: ImportOptions): Promise<ImportResult> {
    // console.log(`[${this.metadata.id}] Processing file: ${filePath}`);
    const startTime = new Date();

    try {
      // Run pre-import hooks
      await this.preImport(filePath, options);

      // Validate unless skipped
      if (!options?.skipValidation) {
        const validation = await this.validate(filePath, fileType, options);
        if (!validation.isValid) {
          return {
            success: false,
            rowCount: validation.rowCount,
            errors: validation.errors || ['Validation failed']
          };
        }
      }

      // Test mode - just return row count
      if (options?.testMode) {
        // console.log(`[${this.metadata.id}] Running in test mode - counting rows only`);
        const parsed = await this.getParsedFile(filePath, fileType, options);
        return {
          success: true,
          rowCount: parsed.rowCount,
          processedRows: 0,
          skippedRows: 0,
          metadata: {
            testMode: true,
            importType: this.metadata.id
          }
        };
      }

      // Parse the file
      const parsed = await this.getParsedFile(filePath, fileType, options);

      // Process rows
      const result = await this.processRows(parsed, options);

      // Add timing information
      const endTime = new Date();
      result.stats = {
        startTime,
        endTime,
        duration: endTime.getTime() - startTime.getTime()
      };

      // Run post-import hooks
      if (!options?.skipPostImport) {
        await this.postImport(result, options);
      }

      return result;
    } catch (error) {
      console.error(`[${this.metadata.id}] Processing error:`, error);
      return {
        success: false,
        rowCount: 0,
        errors: [error instanceof Error ? error.message : 'Processing failed']
      };
    } finally {
      // Clear cache
      this.clearCache();
    }
  }

  /**
   * Process individual rows
   * Override this method to implement actual data processing
   */
  protected async processRows(parsed: ParsedFile, options?: ImportOptions): Promise<ImportResult> {
    // console.log(`[${this.metadata.id}] Processing ${parsed.rowCount} rows`);
    let processedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    const errors: string[] = [];
    const processedData: any[] = [];

    // Process in batches if specified
    const batchSize = options?.batchSize || 100;
    const stopOnError = options?.stopOnError || false;

    for (let i = 0; i < parsed.data.length; i += batchSize) {
      const batch = parsed.data.slice(i, i + batchSize);

      for (let j = 0; j < batch.length; j++) {
        const rowIndex = i + j;
        const row = batch[j];

        try {
          // Validate row if validator exists
          if (this.validateRow) {
            const validationResult = await this.validateRow(row, rowIndex);
            if (validationResult !== true) {
              errors.push(`Row ${rowIndex + 1}: ${validationResult}`);
              failedRows++;
              if (stopOnError) throw new Error(validationResult);
              continue;
            }
          }

          // Transform row if transformer exists
          const transformedRow = this.transformRow
            ? await this.transformRow(row, rowIndex)
            : row;

          if (transformedRow === null) {
            skippedRows++;
            continue;
          }

          processedData.push(transformedRow);
          processedRows++;
        } catch (error) {
          failedRows++;
          const errorMsg = `Row ${rowIndex + 1}: ${error instanceof Error ? error.message : 'Processing failed'}`;
          errors.push(errorMsg);

          if (stopOnError) {
            break;
          }
        }
      }

      if (stopOnError && errors.length > 0) {
        break;
      }
    }

    return {
      success: failedRows === 0,
      rowCount: parsed.rowCount,
      processedRows,
      skippedRows,
      failedRows,
      errors: errors.length > 0 ? errors : undefined,
      data: options?.testMode ? undefined : processedData,
      metadata: {
        importType: this.metadata.id,
        timestamp: new Date().toISOString(),
        batchSize
      }
    };
  }

  /**
   * Default post-import hook
   * Override to add custom post-import logic
   */
  async postImport(result: ImportResult, options?: ImportOptions): Promise<void> {
    if (options?.skipPostImport) {
      // console.log(`[${this.metadata.id}] Skipping post-import hooks`);
      return;
    }

    // console.log(`[${this.metadata.id}] Running post-import hooks`);
    // console.log(`[${this.metadata.id}] Import completed:`, {
    //   success: result.success,
    //   processed: result.processedRows,
    //   skipped: result.skippedRows,
    //   failed: result.failedRows
    // });
  }

  /**
   * Preview file contents
   */
  async preview(filePath: string, fileType: string, rows: number = 10): Promise<any[]> {
    // console.log(`[${this.metadata.id}] Generating preview for: ${filePath}`);
    try {
      const parsed = await this.getParsedFile(filePath, fileType, {
        previewRows: rows
      });

      return parsed.data.slice(0, rows);
    } catch (error) {
      console.error(`[${this.metadata.id}] Preview error:`, error);
      return [];
    }
  }

  /**
   * Transform a single row (override in subclasses)
   */
  async transformRow?(row: any, rowIndex: number): Promise<any | null>;

  /**
   * Validate a single row (override in subclasses)
   */
  async validateRow?(row: any, rowIndex: number): Promise<true | string>;

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // console.log(`[${this.metadata.id}] Cleaning up processor`);
    this.clearCache();
    this.initialized = false;
  }

  /**
   * Get parsed file with caching
   */
  protected async getParsedFile(
    filePath: string,
    fileType: string,
    options?: ImportOptions
  ): Promise<ParsedFile> {
    // Use cache if available and same file
    if (this.cachedParsedFile && this.cachedFilePath === filePath) {
      // console.log(`[${this.metadata.id}] Using cached parsed file`);
      return this.cachedParsedFile;
    }

    // Parse the file
    const parsed = await parseFile(filePath, fileType, {
      delimiter: options?.delimiter,
      encoding: options?.encoding,
      sheetName: options?.sheetName,
      limit: options?.previewRows
    });

    // Cache for reuse
    this.cachedParsedFile = parsed;
    this.cachedFilePath = filePath;

    return parsed;
  }

  /**
   * Clear cached data
   */
  protected clearCache(): void {
    this.cachedParsedFile = undefined;
    this.cachedFilePath = undefined;
  }

  /**
   * Log a message with processor context
   */
  protected log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const prefix = `[${this.metadata.id}]`;
    switch (level) {
      case 'error':
        console.error(prefix, message);
        break;
      case 'warn':
        // console.warn(prefix, message);
        break;
      default:
        // console.log(prefix, message);
    }
  }
}