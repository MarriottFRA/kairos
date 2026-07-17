/**
 * TEST IMPORT PROCESSOR - TEMPLATE FOR NEW IMPORTS
 * ================================================
 *
 * This is a fully documented test import processor that serves two purposes:
 * 1. Provides a quick row counter for testing files without validation
 * 2. Acts as a template for creating new import processors
 *
 * HOW TO CREATE A NEW IMPORT PROCESSOR:
 * -------------------------------------
 * 1. Copy this file and rename it (e.g., 'myDataImport.ts')
 * 2. Update the class name and metadata
 * 3. Implement your validation logic in validateRow()
 * 4. Implement your transformation logic in transformRow()
 * 5. Add any custom pre/post processing if needed
 * 6. Register your processor in the ImportRegistry
 *
 * @author Your Name
 * @version 1.0.0
 */

import { BaseImportProcessor } from '../core/baseProcessor';
import {
  ImportProcessorMetadata,
  ValidationResult,
  ImportResult,
  ImportOptions,
  ParsedFile
} from '../core/interfaces';

/**
 * Test Import Processor
 *
 * This processor is designed for quick file testing and row counting.
 * It skips most validation and processing steps to provide instant feedback.
 *
 * Use this when you need to:
 * - Quickly check how many rows are in a file
 * - Test file parsing without running full validation
 * - Verify file format compatibility
 *
 * CUSTOMIZATION GUIDE:
 * - Change the metadata to describe your import
 * - Add requiredColumns for your data structure
 * - Implement validateRow() for row-level validation
 * - Implement transformRow() for data transformation
 * - Override processRows() for custom processing logic
 */
export class TestImportProcessor extends BaseImportProcessor {
  /**
   * STEP 1: DEFINE YOUR METADATA
   * ============================
   * This metadata describes your import processor to the system.
   * Update all fields to match your specific import requirements.
   */
  metadata: ImportProcessorMetadata = {
    // Unique identifier - use snake_case (e.g., 'customer_data', 'product_inventory')
    id: 'test_import',

    // Display name shown in the UI
    name: 'Test Import (CSV Row Counter)',

    // Detailed description of what this import does
    description: 'Reads CSV files and returns the actual row count. Perfect for quickly verifying CSV file contents and ensuring the import system is working correctly.',

    // Category for grouping in UI (e.g., 'Customer Data', 'Financial', 'Inventory')
    category: 'Testing',

    // File formats this processor can handle
    supportedFormats: ['csv', 'xlsx', 'xls'],

    // Whether this import is required for system operation
    required: false,

    // Processing order (-1 means it appears first in the list)
    order: -1,

    // CUSTOMIZE THESE FOR YOUR IMPORT:
    // List columns that MUST exist in the import file
    requiredColumns: [
      // Example: 'customer_id', 'email', 'first_name', 'last_name'
      // For test import, we don't require any specific columns
    ],

    // List columns that are optional but recognized
    optionalColumns: [
      // Example: 'phone', 'address', 'preferred_language'
      // For test import, we accept any columns
    ],

    // Validation rules shown to users
    validationRules: [
      'Reads CSV files and counts actual data rows',
      'Returns real row count from the selected file',
      'Provides sample data preview from the file'
    ],

    // Tags for filtering/searching
    tags: ['test', 'diagnostic', 'quick', 'row-counter'],

    // Version of this processor
    version: '1.0.0'
  };

  /**
   * STEP 2: CUSTOMIZE VALIDATION (OPTIONAL)
   * =======================================
   * Override the validate method if you need custom validation logic.
   * The test import skips validation for speed.
   *
   * For a real import, you would:
   * 1. Check for required columns
   * 2. Validate data types
   * 3. Check for duplicates
   * 4. Verify foreign key references
   */
  async validate(filePath: string, fileType: string, options?: ImportOptions): Promise<ValidationResult> {
    // console.log(`[${this.metadata.id}] Running quick validation for test mode`);
    // For test import, we do minimal validation
    // Just check if we can parse the file and count rows
    try {
      const parsed = await this.getParsedFile(filePath, fileType, options);

      // In test mode, we always return valid with actual file information
      return {
        isValid: true,
        rowCount: parsed.rowCount,
        columnCount: parsed.columns.length,
        detectedColumns: parsed.columns,
        warnings: [`CSV file validated successfully - ${parsed.rowCount} rows detected`],
        fileInfo: {
          size: 0, // Will be filled by base class
          encoding: 'utf-8',
          hasHeaders: true
        },
        sampleData: parsed.data.slice(0, 3) // Show first 3 rows as sample
      };
    } catch (error) {
      return {
        isValid: false,
        rowCount: 0,
        columnCount: 0,
        detectedColumns: [],
        errors: [`Failed to parse file: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * STEP 3: CUSTOMIZE PROCESSING
   * ============================
   * Override processRows for custom processing logic.
   * Test import reads the actual CSV file and returns the real row count.
   *
   * For a real import, this would:
   * 1. Transform each row
   * 2. Save to database
   * 3. Update related records
   * 4. Generate reports
   */
  protected async processRows(parsed: ParsedFile, options?: ImportOptions): Promise<ImportResult> {
    // console.log(`[${this.metadata.id}] Reading CSV file - found ${parsed.rowCount} rows`);
    // Return the actual row count from the parsed CSV file
    const actualRowCount = parsed.rowCount;

    // In test mode, we just count the rows without processing them
    // This provides real feedback about the file being imported
    return {
      success: true,
      rowCount: actualRowCount, // Return the actual row count from the CSV
      processedRows: actualRowCount, // Mark all rows as "processed" (counted)
      skippedRows: 0,
      failedRows: 0,
      metadata: {
        testMode: true,
        importType: this.metadata.id,
        message: `Test import completed: Successfully read ${actualRowCount} rows from CSV file with ${parsed.columns.length} columns`,
        columns: parsed.columns,
        sampleData: parsed.data.slice(0, 5), // Include first 5 rows as sample for preview
        fileInfo: {
          totalRows: actualRowCount,
          totalColumns: parsed.columns.length,
          columnNames: parsed.columns
        }
      },
      stats: {
        startTime: new Date(),
        endTime: new Date()
      }
    };
  }

  /**
   * STEP 4: ROW VALIDATION (OPTIONAL)
   * =================================
   * Implement this method to validate individual rows.
   * Return true if valid, or an error message if invalid.
   *
   * Example for a customer import:
   * ```typescript
   * async validateRow(row: any, rowIndex: number): Promise<true | string> {
   *   // Check required fields
   *   if (!row.email) return 'Email is required';
   *   if (!this.isValidEmail(row.email)) return 'Invalid email format';
   *
   *   // Check data types
   *   if (row.age && isNaN(row.age)) return 'Age must be a number';
   *
   *   // Check business rules
   *   if (row.age && row.age < 18) return 'Customer must be 18 or older';
   *
   *   return true;
   * }
   * ```
   */
  async validateRow(row: any, rowIndex: number): Promise<true | string> {
    // Test import accepts all rows
    return true;

    // TEMPLATE FOR REAL VALIDATION:
    /*
    // Check for required fields
    if (!row.customer_id) {
      return `Missing customer_id`;
    }

    // Validate email format
    if (row.email && !this.isValidEmail(row.email)) {
      return `Invalid email format: ${row.email}`;
    }

    // Validate numeric fields
    if (row.age && (isNaN(row.age) || row.age < 0)) {
      return `Invalid age value: ${row.age}`;
    }

    // Check date formats
    if (row.birth_date && !this.isValidDate(row.birth_date)) {
      return `Invalid date format: ${row.birth_date}`;
    }

    // All validations passed
    return true;
    */
  }

  /**
   * STEP 5: ROW TRANSFORMATION (OPTIONAL)
   * =====================================
   * Transform each row before processing.
   * Return null to skip a row, or the transformed data.
   *
   * Example transformation:
   * ```typescript
   * async transformRow(row: any, rowIndex: number): Promise<any | null> {
   *   // Skip empty rows
   *   if (!row.customer_id) return null;
   *
   *   // Transform the data
   *   return {
   *     customerId: row.customer_id.trim().toUpperCase(),
   *     email: row.email?.toLowerCase(),
   *     fullName: `${row.first_name} ${row.last_name}`,
   *     age: parseInt(row.age),
   *     createdAt: new Date(),
   *     source: 'import'
   *   };
   * }
   * ```
   */
  async transformRow(row: any, rowIndex: number): Promise<any | null> {
    // Test import returns rows as-is
    return row;

    // TEMPLATE FOR REAL TRANSFORMATION:
    /*
    // Skip rows with missing required data
    if (!row.customer_id) {
      return null; // This row will be counted as 'skipped'
    }

    // Clean and transform the data
    const transformed = {
      // Map and clean fields
      customerId: row.customer_id?.toString().trim(),
      email: row.email?.toString().toLowerCase().trim(),
      firstName: this.capitalizeFirst(row.first_name),
      lastName: this.capitalizeFirst(row.last_name),

      // Parse numeric values
      age: row.age ? parseInt(row.age) : null,
      creditLimit: row.credit_limit ? parseFloat(row.credit_limit) : 0,

      // Parse dates
      birthDate: row.birth_date ? new Date(row.birth_date) : null,

      // Add metadata
      importedAt: new Date(),
      importBatch: `import_${Date.now()}`,
      rowNumber: rowIndex + 1
    };

    return transformed;
    */
  }

  /**
   * STEP 6: PRE-IMPORT HOOK (OPTIONAL)
   * ==================================
   * Override this to add custom setup before import starts.
   *
   * Examples:
   * - Create backup of existing data
   * - Clear temporary tables
   * - Check system resources
   * - Validate dependencies
   */
  async preImport(filePath: string, options?: ImportOptions): Promise<void> {
    await super.preImport(filePath, options);

    // Test import doesn't need pre-import setup
    // console.log(`[${this.metadata.id}] Test import starting - no setup needed`);
    // TEMPLATE FOR REAL PRE-IMPORT:
    /*
    // console.log(`[${this.metadata.id}] Preparing for import...`);
    // Example: Check if database is accessible
    // await this.checkDatabaseConnection();

    // Example: Create backup
    // await this.backupExistingData();

    // Example: Clear staging tables
    // await this.clearStagingTables();

    // Example: Check for enough disk space
    // await this.checkDiskSpace(filePath);

    // console.log(`[${this.metadata.id}] Pre-import setup complete`);
    */
  }

  /**
   * STEP 7: POST-IMPORT HOOK (OPTIONAL)
   * ===================================
   * Override this to add custom cleanup after import completes.
   *
   * Examples:
   * - Send notification emails
   * - Update statistics
   * - Trigger dependent processes
   * - Clean up temporary files
   */
  async postImport(result: ImportResult, options?: ImportOptions): Promise<void> {
    await super.postImport(result, options);

    // Test import doesn't need post-import cleanup
    // console.log(`[${this.metadata.id}] Test import complete - no cleanup needed`);
    // TEMPLATE FOR REAL POST-IMPORT:
    /*
    // console.log(`[${this.metadata.id}] Running post-import tasks...`);
    if (result.success) {
      // Example: Send success notification
      // await this.sendNotification({
      //   type: 'success',
      //   message: `Import completed: ${result.processedRows} rows processed`
      // });

      // Example: Update import statistics
      // await this.updateStatistics(result);

      // Example: Trigger dependent processes
      // await this.triggerDependentImports();

    } else {
      // Example: Send failure notification
      // await this.sendNotification({
      //   type: 'error',
      //   message: `Import failed: ${result.errors?.join(', ')}`
      // });

      // Example: Rollback changes
      // await this.rollbackChanges();
    }

    // Example: Clean up temp files
    // await this.cleanupTempFiles();

    // console.log(`[${this.metadata.id}] Post-import tasks complete`);
    */
  }

  /**
   * HELPER METHODS
   * =============
   * Add any helper methods your processor needs.
   * These are examples you might use in a real import.
   */

  /**
   * Validate email format
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validate date format
   */
  private isValidDate(dateString: string): boolean {
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date.getTime());
  }

  /**
   * Capitalize first letter
   */
  private capitalizeFirst(str: string | undefined): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }

  /**
   * Format phone number
   */
  private formatPhone(phone: string | undefined): string | null {
    if (!phone) return null;
    // Remove all non-digits
    const digits = phone.replace(/\D/g, '');
    // Format as needed
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return digits;
  }
}

/**
 * STEP 8: REGISTER YOUR PROCESSOR
 * ===============================
 * Don't forget to register your processor in the ImportRegistry!
 *
 * In src/services/imports/core/registry.ts, add:
 * ```typescript
 * import { TestImportProcessor } from '../processors/testImport';
 *
 * // In the initialize() method:
 * this.register(new TestImportProcessor());
 * ```
 *
 * Your import will then be available through:
 * - IPC: 'imports:execute' with importId 'test_import'
 * - Registry: ImportRegistry.getProcessor('test_import')
 *
 * TESTING YOUR NEW IMPORT:
 * -----------------------
 * 1. Test with a small file first
 * 2. Check validation catches bad data
 * 3. Verify transformations work correctly
 * 4. Test error handling with invalid files
 * 5. Check performance with large files
 *
 * COMMON PATTERNS:
 * ---------------
 * - Batch Processing: Process rows in chunks to manage memory
 * - Duplicate Detection: Check for existing records before inserting
 * - Foreign Key Validation: Verify references exist in related tables
 * - Data Enrichment: Add calculated fields or lookup values
 * - Audit Trail: Log all changes for compliance
 * - Rollback Support: Allow undoing imports if needed
 *
 * PERFORMANCE TIPS:
 * ----------------
 * - Use batch size of 100-1000 rows for database inserts
 * - Consider streaming for very large files
 * - Use database transactions for consistency
 * - Index lookup fields before import
 * - Clear caches between batches
 *
 * ERROR HANDLING:
 * --------------
 * - Always validate data before processing
 * - Provide clear error messages with row numbers
 * - Consider partial success scenarios
 * - Log all errors for debugging
 * - Allow retrying failed rows
 */