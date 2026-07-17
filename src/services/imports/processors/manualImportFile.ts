/**
 * MANUAL IMPORT FILE PROCESSOR
 * ============================
 *
 * This processor handles the import of pre-mapped data from Excel files.
 * Unlike other imports, this processor does NOT use mappings - the file already
 * contains the target department and account codes (pre-mapped data).
 *
 * Expected columns:
 * - MIGL Dep: Target department (already has "D" prefix)
 * - MIGL Acc: Target account (already has "A" prefix)
 * - MIGL Description: Description of the line item
 * - Local Amount: The amount to import
 * - Notes: Additional notes
 *
 * The data is aggregated by department+account combination, summing amounts.
 *
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
import * as db from '../../../local_db';

/**
 * Manual Import File Processor
 *
 * This processor imports pre-mapped data from Excel files.
 * The file must contain a sheet named "Import" with the required columns.
 * Data is aggregated by department+account combination.
 */
export class ManualImportFileProcessor extends BaseImportProcessor {
  /**
   * Source account identifier - indicates data is pre-mapped
   */
  private readonly SOURCE_ACCOUNT = 'MANUAL_PREMAPPED';

  /**
   * Sheet name to read from Excel file
   */
  private readonly SHEET_NAME = 'Import';

  /**
   * STEP 1: DEFINE METADATA
   */
  metadata: ImportProcessorMetadata = {
    // Unique identifier - must match API configuration
    id: 'manual_import_file',

    // Display name shown in the UI
    name: 'Manual Import File',

    // Detailed description of what this import does
    description: 'Imports pre-mapped data from Excel files. The file must contain target department and account codes. Data is aggregated by department+account combination.',

    // Category for grouping in UI
    category: 'Manual',

    // File formats this processor can handle
    supportedFormats: ['xlsx', 'xls'],

    // Whether this import is required for system operation
    required: false,

    // Processing order
    order: 5,

    // List columns that MUST exist in the import file
    requiredColumns: [
      'MIGL Dep',
      'MIGL Acc',
      'MIGL Description',
      'Local Amount',
      'Notes'
    ],

    // List columns that are optional but recognized
    optionalColumns: [],

    // Validation rules shown to users
    validationRules: [
      'Excel file must contain a sheet named "Import"',
      'Sheet must contain all required columns: MIGL Dep, MIGL Acc, MIGL Description, Local Amount, Notes',
      'MIGL Dep should contain department codes (e.g., D0010)',
      'MIGL Acc should contain account codes (e.g., A961662)',
      'Rows with the same department+account combination will be aggregated (amounts summed)'
    ],

    // Tags for filtering/searching
    tags: ['manual', 'premapped', 'excel', 'import'],

    // Version of this processor
    version: '1.0.0'
  };

  /**
   * STEP 2: VALIDATION
   */
  async validate(filePath: string, fileType: string, options?: ImportOptions): Promise<ValidationResult> {
    try {
      // Parse file with specific sheet name
      const parseOptions = {
        ...options,
        sheetName: this.SHEET_NAME
      };
      const parsed = await this.getParsedFile(filePath, fileType, parseOptions);
      const errors: string[] = [];
      const warnings: string[] = [];

      // Check for required columns
      const missingColumns = this.metadata.requiredColumns?.filter(
        col => !parsed.columns.includes(col)
      ) || [];

      if (missingColumns.length > 0) {
        errors.push(`Missing required columns: ${missingColumns.join(', ')}`);
      }

      // If we have missing columns, stop validation here
      if (errors.length > 0) {
        return {
          isValid: false,
          rowCount: parsed.rowCount,
          columnCount: parsed.columns.length,
          detectedColumns: parsed.columns,
          missingRequiredColumns: missingColumns,
          errors,
          fileInfo: {
            size: 0,
            encoding: 'utf-8',
            hasHeaders: true
          }
        };
      }

      // Analyze data for informational purposes
      let totalAmount = 0;
      let validRows = 0;
      let rowsWithMissingDep = 0;
      let rowsWithMissingAcc = 0;
      const uniqueCombos = new Set<string>();

      for (const row of parsed.data) {
        const dep = row['MIGL Dep']?.toString().trim();
        const acc = row['MIGL Acc']?.toString().trim();
        const amount = parseFloat(row['Local Amount']) || 0;

        if (!dep) rowsWithMissingDep++;
        if (!acc) rowsWithMissingAcc++;

        if (dep && acc) {
          uniqueCombos.add(`${dep}_${acc}`);
          totalAmount += amount;
          validRows++;
        }
      }

      // Add informational warnings
      if (rowsWithMissingDep > 0) {
        warnings.push(`${rowsWithMissingDep} rows have missing department codes`);
      }
      if (rowsWithMissingAcc > 0) {
        warnings.push(`${rowsWithMissingAcc} rows have missing account codes`);
      }
      warnings.push(`Total Amount: ${totalAmount.toLocaleString()} (from ${validRows} valid rows)`);
      warnings.push(`Unique department+account combinations: ${uniqueCombos.size}`);

      return {
        isValid: true,
        rowCount: parsed.rowCount,
        columnCount: parsed.columns.length,
        detectedColumns: parsed.columns,
        warnings,
        fileInfo: {
          size: 0,
          encoding: 'utf-8',
          hasHeaders: true
        },
        sampleData: parsed.data.slice(0, 3)
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
   * STEP 3: PROCESS ROWS
   */
  protected async processRows(parsed: ParsedFile, options?: ImportOptions): Promise<ImportResult> {
    const startTime = new Date();
    const warnings: string[] = [];
    let processedRows = 0;
    let skippedRows = 0;

    try {
      // Step 1: Get import configuration from user selection
      const year = options?.custom?.year;
      const month = options?.custom?.month;
      const ou = options?.custom?.ou;

      if (!year || !month || !ou) {
        throw new Error('Missing required import options: year, month, or ou');
      }

      // Generate import batch ID
      const now = new Date();
      const batchId = `manual_import_file_${now.toISOString().replace(/[:.]/g, '-')}`;

      // Step 2: Get hotel currency from metadata
      const currency = await this.getHotelCurrency(ou);
      if (!currency) {
        warnings.push('Hotel currency not found, defaulting to USD');
      }
      const finalCurrency = currency || 'USD';

      // Step 3: Aggregate rows by department+account combination
      const aggregationMap = new Map<string, {
        department: string;
        account: string;
        amount: number;
        descriptions: string[];
        notes: string[];
      }>();

      for (const row of parsed.data) {
        const dep = row['MIGL Dep']?.toString().trim();
        const acc = row['MIGL Acc']?.toString().trim();
        const amount = parseFloat(row['Local Amount']) || 0;
        const description = row['MIGL Description']?.toString().trim() || '';
        const notes = row['Notes']?.toString().trim() || '';

        // Skip rows with missing department or account
        if (!dep || !acc) {
          skippedRows++;
          continue;
        }

        const comboKey = `${dep}_${acc}`;

        if (aggregationMap.has(comboKey)) {
          const existing = aggregationMap.get(comboKey)!;
          existing.amount += amount;
          if (description && !existing.descriptions.includes(description)) {
            existing.descriptions.push(description);
          }
          if (notes && !existing.notes.includes(notes)) {
            existing.notes.push(notes);
          }
        } else {
          aggregationMap.set(comboKey, {
            department: dep,
            account: acc,
            amount,
            descriptions: description ? [description] : [],
            notes: notes ? [notes] : []
          });
        }
      }

      // Step 4: Create staging entries
      const periodCombo = `${year}-${String(month).padStart(2, '0')}`;
      const stagingEntries: any[] = [];

      for (const [comboId, data] of aggregationMap) {
        const stagingEntry = {
          dep_acc_combo_id: comboId,
          month,
          year,
          period_combo: periodCombo,
          scenario: 'ACT',
          amount: data.amount,
          currency: finalCurrency,
          ou,
          department: data.department,
          account: data.account,
          version: 'MAIN',
          source_account: this.SOURCE_ACCOUNT,
          source_department: null,
          source_description: data.descriptions.join('; ') || 'Manual Import',
          mapping_status: 'mapped', // Always mapped since data is pre-mapped
          import_batch_id: batchId
        };

        stagingEntries.push(stagingEntry);
      }

      // Step 5: Insert into staging table
      if (stagingEntries.length > 0) {
        await db.insertBatchStagingData(stagingEntries);
        processedRows = stagingEntries.length;
      }

      // Add summary warnings
      if (skippedRows > 0) {
        warnings.push(`Skipped ${skippedRows} rows due to missing department or account`);
      }
      warnings.push(`Created ${processedRows} aggregated staging entries from ${parsed.rowCount} source rows`);

      const endTime = new Date();

      return {
        success: true,
        rowCount: parsed.rowCount,
        processedRows,
        skippedRows,
        failedRows: 0,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: {
          importType: this.metadata.id,
          batchId,
          message: 'Manual import completed successfully',
          aggregatedCombos: aggregationMap.size,
          totalAmount: Array.from(aggregationMap.values()).reduce((sum, d) => sum + d.amount, 0),
          period: periodCombo,
          currency: finalCurrency
        },
        stats: {
          startTime,
          endTime,
          duration: endTime.getTime() - startTime.getTime()
        }
      };
    } catch (error) {
      console.error(`[${this.metadata.id}] Processing error:`, error);
      return {
        success: false,
        rowCount: parsed.rowCount,
        processedRows,
        failedRows: parsed.rowCount - processedRows - skippedRows,
        errors: [error instanceof Error ? error.message : 'Unknown processing error'],
        stats: {
          startTime,
          endTime: new Date()
        }
      };
    }
  }

  /**
   * Override getParsedFile to use specific sheet name
   */
  protected async getParsedFile(filePath: string, fileType: string, options?: ImportOptions): Promise<ParsedFile> {
    // Ensure we use the correct sheet name
    const parseOptions = {
      ...options,
      sheetName: options?.sheetName || this.SHEET_NAME
    };
    return super.getParsedFile(filePath, fileType, parseOptions);
  }

  /**
   * STEP 4: ROW VALIDATION
   */
  async validateRow(row: any, rowIndex: number): Promise<true | string> {
    const dep = row['MIGL Dep']?.toString().trim();
    const acc = row['MIGL Acc']?.toString().trim();

    if (!dep || !acc) {
      return `Row ${rowIndex + 1}: Missing department or account`;
    }

    return true;
  }

  /**
   * STEP 5: ROW TRANSFORMATION
   */
  async transformRow(row: any, rowIndex: number): Promise<any | null> {
    return row;
  }

  /**
   * STEP 6: PRE-IMPORT HOOK
   */
  async preImport(filePath: string, options?: ImportOptions): Promise<void> {
    await super.preImport(filePath, options);
  }

  /**
   * STEP 7: POST-IMPORT HOOK
   */
  async postImport(result: ImportResult, options?: ImportOptions): Promise<void> {
    await super.postImport(result, options);
  }

  /**
   * HELPER METHODS
   */

  /**
   * Get hotel currency from metadata
   */
  private async getHotelCurrency(ou: string): Promise<string | null> {
    try {
      const hotelsJson = await db.getCachedHotels();
      const hotels = JSON.parse(hotelsJson);
      const hotel = hotels.find((h: any) => h.ou === ou);

      if (hotel && hotel.currency) {
        return hotel.currency;
      }

      return null;
    } catch (error) {
      console.error(`[${this.metadata.id}] Error getting hotel currency:`, error);
      return null;
    }
  }
}
