/**
 * ACCPAC COMPS IMPORT PROCESSOR
 * ==============================
 *
 * This processor handles the import of ACCPAC complimentary rooms data from CSV files.
 * Unlike other imports, this processor does NOT use mappings - it always loads to a fixed
 * account (A961662) and department (D0010).
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
 * ACCPAC Comps Import Processor
 *
 * This processor imports ACCPAC complimentary rooms data from CSV files.
 * It sums all "Rooms Rented" values and creates a single entry for the fixed
 * account/department combination. No mapping is required.
 */
export class AccpacCompsImportProcessor extends BaseImportProcessor {
  /**
   * Fixed target account - never changes
   */
  private readonly TARGET_ACCOUNT = 'A961662';

  /**
   * Fixed target department - never changes
   */
  private readonly TARGET_DEPARTMENT = 'D0010';

  /**
   * STEP 1: DEFINE METADATA
   */
  metadata: ImportProcessorMetadata = {
    // Unique identifier
    id: 'accpac_comps_import',

    // Display name shown in the UI
    name: 'ACCPAC Comps Import',

    // Detailed description of what this import does
    description: 'Imports ACCPAC complimentary rooms data from CSV files. Sums all "Rooms Rented" and loads to fixed account A961662 and department D0010. No mapping required.',

    // Category for grouping in UI
    category: 'ACCPAC',

    // File formats this processor can handle
    supportedFormats: ['csv'],

    // Whether this import is required for system operation
    required: false,

    // Processing order
    order: 12,

    // List columns that MUST exist in the import file
    requiredColumns: [
      'Guest Name',
      'Company Name',
      'Requested By',
      'Authorized By',
      'Date',
      'Rooms Rented',
      'Bed Nights',
      'Remarks'
    ],

    // List columns that are optional but recognized
    optionalColumns: [],

    // Validation rules shown to users
    validationRules: [
      'CSV file must contain all required columns: Guest Name, Company Name, Requested By, Authorized By, Date, Rooms Rented, Bed Nights, Remarks',
      'All "Rooms Rented" values will be summed and loaded to account A961662 and department D0010',
      'Zero comp rooms is acceptable - will import 0 as the amount'
    ],

    // Tags for filtering/searching
    tags: ['accpac', 'comps', 'complimentary', 'rooms'],

    // Version of this processor
    version: '1.0.0'
  };

  /**
   * STEP 2: VALIDATION
   */
  async validate(filePath: string, fileType: string, options?: ImportOptions): Promise<ValidationResult> {
    // console.log(`[${this.metadata.id}] Running validation`);
    try {
      const parsed = await this.getParsedFile(filePath, fileType, options);
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

      // Calculate total rooms rented for informational purposes
      let totalRoomsRented = 0;
      let validRows = 0;
      for (const row of parsed.data) {
        const roomsRented = parseFloat(row['Rooms Rented']) || 0;
        totalRoomsRented += roomsRented;
        if (roomsRented !== 0) {
          validRows++;
        }
      }

      // Add informational warnings
      if (totalRoomsRented === 0) {
        warnings.push('Total Rooms Rented is 0 - this is acceptable and will be imported as 0');
      } else {
        warnings.push(`Total Rooms Rented: ${totalRoomsRented} (from ${validRows} non-zero rows)`);
      }
      warnings.push(`Target: Account ${this.TARGET_ACCOUNT}, Department ${this.TARGET_DEPARTMENT}`);

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
    // console.log(`[${this.metadata.id}] Processing ${parsed.rowCount} rows`);
    const startTime = new Date();
    const warnings: string[] = [];
    let processedRows = 0;

    try {
      // Step 1: Get import configuration
      const year = options?.custom?.year;
      const month = options?.custom?.month;
      const ou = options?.custom?.ou;

      if (!year || !month || !ou) {
        throw new Error('Missing required import options: year, month, or ou');
      }

      // Generate import batch ID: "accpac_comps_import_YYYY-MM-DD_HH-MM-SS"
      const now = new Date();
      const batchId = `accpac_comps_import_${now.toISOString().replace(/[:.]/g, '-')}`;

      // Step 2: Get hotel currency from metadata
      const currency = await this.getHotelCurrency(ou);
      if (!currency) {
        warnings.push('Hotel currency not found, defaulting to USD');
      }
      const finalCurrency = currency || 'USD';

      // Step 3: Sum all "Rooms Rented" values
      let totalRoomsRented = 0;
      let rowsWithData = 0;

      for (const row of parsed.data) {
        const roomsRented = parseFloat(row['Rooms Rented']) || 0;
        totalRoomsRented += roomsRented;
        if (roomsRented !== 0) {
          rowsWithData++;
        }
      }

      // console.log(`[${this.metadata.id}] Total Rooms Rented: ${totalRoomsRented} (from ${rowsWithData} non-zero rows)`);
      // Step 4: Create single staging entry (even if total is 0)
      const periodCombo = `${year}-${String(month).padStart(2, '0')}`;
      const comboId = `${this.TARGET_DEPARTMENT}_${this.TARGET_ACCOUNT}`;

      const stagingEntry = {
        dep_acc_combo_id: comboId,
        month,
        year,
        period_combo: periodCombo,
        scenario: 'ACT',
        amount: totalRoomsRented,
        currency: finalCurrency,
        ou,
        department: this.TARGET_DEPARTMENT,
        account: this.TARGET_ACCOUNT,
        version: 'MAIN',
        source_account: 'COMPS',
        source_department: null,
        source_description: 'Complimentary Rooms',
        mapping_status: 'mapped', // Always mapped since we use fixed account/department
        import_batch_id: batchId
      };

      // Step 5: Insert into staging table (additive - no truncation)
      // console.log(`[${this.metadata.id}] Inserting single aggregated row into staging...`);
      await db.insertBatchStagingData([stagingEntry]);
      processedRows = 1;

      // Add informational warnings
      if (totalRoomsRented === 0) {
        warnings.push('Imported 0 comp rooms - this is acceptable');
      }
      warnings.push(`Loaded to Account: ${this.TARGET_ACCOUNT}, Department: ${this.TARGET_DEPARTMENT}`);

      // console.log(`[${this.metadata.id}] Import completed: ${processedRows} staging row created from ${parsed.rowCount} source rows`);
      const endTime = new Date();

      return {
        success: true,
        rowCount: parsed.rowCount,
        processedRows,
        skippedRows: 0,
        failedRows: 0,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: {
          importType: this.metadata.id,
          batchId,
          message: `ACCPAC comps import completed successfully`,
          totalRoomsRented,
          rowsWithData,
          targetAccount: this.TARGET_ACCOUNT,
          targetDepartment: this.TARGET_DEPARTMENT,
          period: `${year}-${String(month).padStart(2, '0')}`,
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
        failedRows: parsed.rowCount - processedRows,
        errors: [error instanceof Error ? error.message : 'Unknown processing error'],
        stats: {
          startTime,
          endTime: new Date()
        }
      };
    }
  }

  /**
   * STEP 4: ROW VALIDATION
   * No validation needed - we just sum the values
   */
  async validateRow(row: any, rowIndex: number): Promise<true | string> {
    return true;
  }

  /**
   * STEP 5: ROW TRANSFORMATION
   * No transformation needed - we just sum the values
   */
  async transformRow(row: any, rowIndex: number): Promise<any | null> {
    return row;
  }

  /**
   * STEP 6: PRE-IMPORT HOOK
   */
  async preImport(filePath: string, options?: ImportOptions): Promise<void> {
    await super.preImport(filePath, options);

    // console.log(`[${this.metadata.id}] Preparing for ACCPAC comps import...`);
    // console.log(`[${this.metadata.id}] Target: Account ${this.TARGET_ACCOUNT}, Department ${this.TARGET_DEPARTMENT}`);
    // console.log(`[${this.metadata.id}] Pre-import setup complete`);
  }

  /**
   * STEP 7: POST-IMPORT HOOK
   */
  async postImport(result: ImportResult, options?: ImportOptions): Promise<void> {
    await super.postImport(result, options);

    // console.log(`[${this.metadata.id}] Running post-import tasks...`);
    // console.log(`[${this.metadata.id}] Post-import tasks complete`);
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
        // console.log(`[${this.metadata.id}] Found currency for OU ${ou}: ${hotel.currency}`);
        return hotel.currency;
      }

      // console.warn(`[${this.metadata.id}] No currency found for OU ${ou}`);
      return null;
    } catch (error) {
      console.error(`[${this.metadata.id}] Error getting hotel currency:`, error);
      return null;
    }
  }
}
