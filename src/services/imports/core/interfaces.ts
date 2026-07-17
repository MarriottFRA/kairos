/**
 * Core Interfaces and Types for Import System
 * ============================================
 *
 * This file contains all the type definitions and interfaces used by the import system.
 * When creating a new import processor, you'll implement the IImportProcessor interface.
 */

/**
 * Import processor metadata
 * Describes the import type and its capabilities
 */
export interface ImportProcessorMetadata {
  /** Unique identifier for the import (e.g., 'customer_data', 'inventory_management') */
  id: string;

  /** Display name shown in UI (e.g., 'Customer Data Import') */
  name: string;

  /** Detailed description explaining what this import does */
  description: string;

  /** Category for grouping imports (e.g., 'Guest Data', 'Inventory', 'Financial', 'Testing') */
  category: string;

  /** File formats this processor can handle (e.g., ['csv', 'xlsx', 'xls']) */
  supportedFormats: string[];

  /** Whether this import is mandatory for system operation */
  required: boolean;

  /** Processing order - lower numbers process first (use -1 for test imports) */
  order: number;

  /** Columns that MUST be present in the import file */
  requiredColumns?: string[];

  /** Columns that are optional but recognized by this processor */
  optionalColumns?: string[];

  /** URL to download a sample CSV template for users */
  sampleDataUrl?: string;

  /** Human-readable validation rules shown to users */
  validationRules?: string[];

  /** Tags for filtering/searching imports */
  tags?: string[];

  /** Version of this import processor */
  version?: string;
}

/**
 * Import validation result
 * Returned after validating a file before processing
 */
export interface ValidationResult {
  /** Whether the file passed validation */
  isValid: boolean;

  /** Number of data rows detected (excluding headers) */
  rowCount: number;

  /** Number of columns detected */
  columnCount: number;

  /** List of column names found in the file */
  detectedColumns: string[];

  /** Required columns that are missing from the file */
  missingRequiredColumns?: string[];

  /** Unrecognized columns that will be ignored */
  unknownColumns?: string[];

  /** Validation errors that prevent processing */
  errors?: string[];

  /** Warnings that don't prevent processing */
  warnings?: string[];

  /** Information about the file being validated */
  fileInfo?: {
    size: number;
    encoding: string;
    delimiter?: string;
    hasHeaders?: boolean;
  };

  /** Sample of first few rows for preview */
  sampleData?: any[];
}

/**
 * Import processing result
 * Contains the outcome of the import operation
 */
export interface ImportResult {
  /** Whether the import completed successfully */
  success: boolean;

  /** Total number of rows in the file */
  rowCount: number;

  /** Number of rows successfully processed */
  processedRows?: number;

  /** Number of rows skipped (duplicates, invalid, etc.) */
  skippedRows?: number;

  /** Number of rows that failed processing */
  failedRows?: number;

  /** Processing errors */
  errors?: string[];

  /** Processing warnings */
  warnings?: string[];

  /** Parsed and processed data (optional - for when data needs to be returned) */
  data?: any[];

  /** Additional metadata about the import */
  metadata?: Record<string, any>;

  /** Processing statistics */
  stats?: {
    startTime?: Date;
    endTime?: Date;
    duration?: number;
    memoryUsed?: number;
  };
}

/**
 * Options for import processing
 * Allows customization of import behavior
 */
export interface ImportOptions {
  /** Skip validation phase (useful for testing) */
  skipValidation?: boolean;

  /** Skip pre-import hooks */
  skipPreImport?: boolean;

  /** Skip post-import hooks */
  skipPostImport?: boolean;

  /** Run in test mode (just count rows, no actual processing) */
  testMode?: boolean;

  /** Number of rows to preview (for preview operations) */
  previewRows?: number;

  /** Custom delimiter for CSV files */
  delimiter?: string;

  /** Custom encoding for text files */
  encoding?: string;

  /** Sheet name for Excel files */
  sheetName?: string;

  /** Whether to use database transaction */
  useTransaction?: boolean;

  /** Batch size for processing large files */
  batchSize?: number;

  /** Whether to stop on first error */
  stopOnError?: boolean;

  /** Custom field mappings */
  fieldMappings?: Record<string, string>;

  /** Additional processor-specific options */
  custom?: Record<string, any>;
}

/**
 * Core import processor interface
 * All import processors MUST implement this interface
 */
export interface IImportProcessor {
  /** Metadata describing this processor */
  metadata: ImportProcessorMetadata;

  /**
   * Pre-import hook - runs before validation
   * Use for setup tasks like checking dependencies, creating temp directories, etc.
   * @param filePath - Path to the file being imported
   * @param options - Import options
   */
  preImport?(filePath: string, options?: ImportOptions): Promise<void>;

  /**
   * Validate the file before processing
   * Checks structure, required columns, data types, etc.
   * @param filePath - Path to the file to validate
   * @param fileType - File extension (csv, xlsx, xls)
   * @param options - Import options
   * @returns Validation result with details
   */
  validate(filePath: string, fileType: string, options?: ImportOptions): Promise<ValidationResult>;

  /**
   * Process the import file
   * Performs the actual data import and transformation
   * @param filePath - Path to the file to process
   * @param fileType - File extension
   * @param options - Import options
   * @returns Import result with statistics
   */
  process(filePath: string, fileType: string, options?: ImportOptions): Promise<ImportResult>;

  /**
   * Post-import hook - runs after successful processing
   * Use for cleanup, notifications, triggering other processes, etc.
   * @param result - The import result
   * @param options - Import options
   */
  postImport?(result: ImportResult, options?: ImportOptions): Promise<void>;

  /**
   * Get a preview of the file contents
   * Returns first N rows for user verification
   * @param filePath - Path to the file
   * @param fileType - File extension
   * @param rows - Number of rows to preview (default: 10)
   * @returns Array of preview data
   */
  preview?(filePath: string, fileType: string, rows?: number): Promise<any[]>;

  /**
   * Transform a single row of data
   * Override this to customize how each row is processed
   * @param row - Raw row data from file
   * @param rowIndex - Index of the row being processed
   * @returns Transformed row or null to skip
   */
  transformRow?(row: any, rowIndex: number): Promise<any | null>;

  /**
   * Validate a single row of data
   * Override this to add custom row-level validation
   * @param row - Row data to validate
   * @param rowIndex - Index of the row
   * @returns True if valid, error message if invalid
   */
  validateRow?(row: any, rowIndex: number): Promise<true | string>;

  /**
   * Clean up any resources used by this processor
   * Called when processor is being destroyed or app is shutting down
   */
  cleanup?(): Promise<void>;
}

/**
 * File parsing result
 * Returned by file parser utilities
 */
export interface ParsedFile {
  /** Parsed data rows */
  data: any[];

  /** Number of data rows */
  rowCount: number;

  /** Column names */
  columns: string[];

  /** File metadata */
  metadata?: {
    delimiter?: string;
    encoding?: string;
    hasHeaders?: boolean;
    sheetName?: string;
  };
}

/**
 * Import progress event
 * Used for progress reporting during long operations
 */
export interface ImportProgress {
  /** Current phase of import */
  phase: 'validating' | 'processing' | 'finalizing';

  /** Current progress (0-100) */
  progress: number;

  /** Current row being processed */
  currentRow?: number;

  /** Total rows to process */
  totalRows?: number;

  /** Current status message */
  message?: string;

  /** Estimated time remaining in seconds */
  estimatedTimeRemaining?: number;
}

/**
 * Import error details
 * Provides detailed error information
 */
export interface ImportError {
  /** Error code for programmatic handling */
  code: string;

  /** Human-readable error message */
  message: string;

  /** Row number where error occurred */
  rowNumber?: number;

  /** Column name where error occurred */
  columnName?: string;

  /** The invalid value that caused the error */
  invalidValue?: any;

  /** Stack trace for debugging */
  stack?: string;

  /** Whether this error is recoverable */
  recoverable?: boolean;
}

/**
 * Batch processing result
 * Used when processing files in batches
 */
export interface BatchResult {
  /** Batch number */
  batchNumber: number;

  /** Number of rows in this batch */
  rowCount: number;

  /** Number of successfully processed rows */
  processedRows: number;

  /** Number of failed rows */
  failedRows: number;

  /** Errors in this batch */
  errors?: ImportError[];
}

/**
 * Import session
 * Tracks the overall import session across multiple files or batches
 */
export interface ImportSession {
  /** Unique session ID */
  sessionId: string;

  /** Session start time */
  startTime: Date;

  /** Session end time */
  endTime?: Date;

  /** List of files processed in this session */
  files: string[];

  /** Overall statistics */
  stats: {
    totalFiles: number;
    successfulFiles: number;
    failedFiles: number;
    totalRows: number;
    processedRows: number;
    failedRows: number;
  };

  /** Session-level errors */
  errors?: ImportError[];
}