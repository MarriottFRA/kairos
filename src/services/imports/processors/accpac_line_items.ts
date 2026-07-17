/**
 * ACCPAC LINE ITEMS IMPORT PROCESSOR
 * ===================================
 *
 * This processor handles the import of ACCPAC line items from CSV files.
 * It validates and processes line item data for integration into the system.
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
 * ACCPAC Line Items Import Processor
 *
 * This processor imports ACCPAC line items from CSV files.
 * It will validate the data structure and process each line item
 * according to business rules.
 */
export class AccpacLineItemsProcessor extends BaseImportProcessor {
  /**
   * STEP 1: DEFINE METADATA
   */
  metadata: ImportProcessorMetadata = {
    // Unique identifier
    id: 'accpac_line_items',

    // Display name shown in the UI
    name: 'ACCPAC Line Items',

    // Detailed description of what this import does
    description: 'Imports ACCPAC line items from CSV files. Validates and processes line item data for integration into the system.',

    // Category for grouping in UI
    category: 'ACCPAC',

    // File formats this processor can handle
    supportedFormats: ['csv'],

    // Whether this import is required for system operation
    required: true,

    // Processing order
    order: 10,

    // List columns that MUST exist in the import file
    requiredColumns: [
      'FILETYPE',
      'FILEVERSION',
      'PROPCODE',
      'BUSDATE',
      'ACCTCODE',
      'ACCTDESC',
      'ENDINGBALANCE',
      'ACTIVITY'
    ],

    // List columns that are optional but recognized
    optionalColumns: [],

    // Validation rules shown to users
    validationRules: [
      'CSV file must contain all required columns: FILETYPE, FILEVERSION, PROPCODE, BUSDATE, ACCTCODE, ACCTDESC, ENDINGBALANCE, ACTIVITY',
      'PROPCODE in first data row must match hotel Local ID 1',
      'BUSDATE must match the selected import period (format: YYYYMM)',
      'Only ACTIVITY column values are imported (ENDINGBALANCE contains YTD and is not used)'
    ],

    // Tags for filtering/searching
    tags: ['accpac', 'line-items', 'financial'],

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

      // Validate PROPCODE against hotel's local_id_1
      if (parsed.data.length > 0) {
        const firstRow = parsed.data[0];
        const propCode = firstRow.PROPCODE;

        // Get the hotel's local_id_1 from options or database
        const expectedPropCode = await this.getHotelLocalId1(options);

        if (!expectedPropCode) {
          errors.push('Unable to retrieve hotel Local ID 1 from settings');
        } else if (propCode !== expectedPropCode) {
          errors.push(`PROPCODE mismatch: Expected "${expectedPropCode}" but found "${propCode}" in first data row`);
        }
      } else {
        errors.push('File contains no data rows');
      }

      // Validate BUSDATE format and match with selected period
      if (parsed.data.length > 0) {
        const firstRow = parsed.data[0];
        const busDate = firstRow.BUSDATE;

        // Get expected period from options
        const expectedPeriod = this.getExpectedPeriod(options);

        if (!expectedPeriod) {
          errors.push('Import period (year and month) must be selected before validating');
        } else {
          // Validate BUSDATE format (should be YYYYMM)
          if (!/^\d{6}$/.test(busDate)) {
            errors.push(`BUSDATE format is invalid: "${busDate}". Expected format: YYYYMM (e.g., 202307)`);
          } else if (busDate !== expectedPeriod) {
            errors.push(`BUSDATE mismatch: Expected "${expectedPeriod}" but found "${busDate}"`);
          }
        }
      }

      // Return validation result
      if (errors.length > 0) {
        return {
          isValid: false,
          rowCount: parsed.rowCount,
          columnCount: parsed.columns.length,
          detectedColumns: parsed.columns,
          errors,
          warnings,
          fileInfo: {
            size: 0,
            encoding: 'utf-8',
            hasHeaders: true
          },
          sampleData: parsed.data.slice(0, 3)
        };
      }

      return {
        isValid: true,
        rowCount: parsed.rowCount,
        columnCount: parsed.columns.length,
        detectedColumns: parsed.columns,
        warnings: [
          `CSV file validated successfully - ${parsed.rowCount} rows detected`,
          `PROPCODE validated: ${parsed.data[0].PROPCODE}`,
          `BUSDATE validated: ${parsed.data[0].BUSDATE}`
        ],
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
   * Get the hotel's local_id_1 from the database
   */
  private async getHotelLocalId1(options?: ImportOptions): Promise<string | null> {
    try {
      // Check if local_id_1 is provided in options
      if (options?.custom?.localId1) {
        // console.log(`[${this.metadata.id}] Using local_id_1 from options:`, options.custom.localId1);
        return options.custom.localId1;
      }

      // Get the selected OU from options
      const ou = options?.custom?.ou;
      if (!ou) {
        console.error(`[${this.metadata.id}] No OU provided in options`, options);
        return null;
      }

      // console.log(`[${this.metadata.id}] Looking up local_id_1 for OU:`, ou);
      // Query the database for the hotel's local_id_1
      // This runs in the main process, so we can access the database directly
      try {
        const hotelsJson = await db.getCachedHotels();
        const hotels = JSON.parse(hotelsJson);
        // console.log(`[${this.metadata.id}] Found ${hotels.length} cached hotels:`, hotels);
        // Find the hotel matching the OU
        const hotel = hotels.find((h: any) => h.ou === ou);
        // console.log(`[${this.metadata.id}] Matched hotel for OU ${ou}:`, hotel);
        if (hotel && hotel.local_id_1) {
          // console.log(`[${this.metadata.id}] Found local_id_1:`, hotel.local_id_1);
          return hotel.local_id_1;
        } else if (hotel) {
          // console.warn(`[${this.metadata.id}] Hotel found but local_id_1 is empty:`, hotel);
        } else {
          // console.warn(`[${this.metadata.id}] No hotel found matching OU ${ou}`);
        }
      } catch (dbError) {
        console.error(`[${this.metadata.id}] Database error:`, dbError);
      }

      return null;
    } catch (error) {
      console.error(`[${this.metadata.id}] Error getting hotel local_id_1:`, error);
      return null;
    }
  }

  /**
   * Get the expected period in YYYYMM format from options
   */
  private getExpectedPeriod(options?: ImportOptions): string | null {
    if (!options?.custom?.year || !options?.custom?.month) {
      return null;
    }

    const year = options.custom.year;
    const month = String(options.custom.month).padStart(2, '0');

    return `${year}${month}`;
  }

  /**
   * STEP 3: PROCESS ROWS
   */
  protected async processRows(parsed: ParsedFile, options?: ImportOptions): Promise<ImportResult> {
    // console.log(`[${this.metadata.id}] Processing ${parsed.rowCount} rows`);
    const startTime = new Date();
    const warnings: string[] = [];
    let processedRows = 0;
    let mappedRows = 0;
    let unmappedRows = 0;

    try {
      // Step 1: Get import configuration
      const year = options?.custom?.year;
      const month = options?.custom?.month;
      const ou = options?.custom?.ou;

      if (!year || !month || !ou) {
        throw new Error('Missing required import options: year, month, or ou');
      }

      // Generate import batch ID: "accpac_line_items_YYYY-MM-DD_HH-MM-SS"
      const now = new Date();
      const batchId = `accpac_line_items_${now.toISOString().replace(/[:.]/g, '-')}`;

      // Step 2: Get hotel currency from metadata
      const currency = await this.getHotelCurrency(ou);
      if (!currency) {
        warnings.push('Hotel currency not found, defaulting to USD');
      }
      const finalCurrency = currency || 'USD';

      // Step 3: Truncate staging table
      // console.log(`[${this.metadata.id}] Truncating staging table...`);
      await db.clearStagingTable(ou);

      // Step 4: Group rows by mapped combo and aggregate ACTIVITY
      // This handles the case where multiple source rows map to the same target combo
      const aggregatedData = await this.aggregateAndMapRows(parsed.data, year, month, ou, finalCurrency, batchId);

      // Step 5: Batch insert into staging table
      // console.log(`[${this.metadata.id}] Inserting ${aggregatedData.length} aggregated rows into staging...`);
      const batchSize = 100;

      for (let i = 0; i < aggregatedData.length; i += batchSize) {
        const batch = aggregatedData.slice(i, i + batchSize);
        await db.insertBatchStagingData(batch);
        processedRows += batch.length;
      }

      // Step 6: Count mapped vs unmapped
      const mappingStats = await db.getStagingMappingStats();
      mappedRows = mappingStats.mapped || 0;
      unmappedRows = mappingStats.unmapped || 0;

      // console.log(`[${this.metadata.id}] Import completed: ${processedRows} rows processed (${mappedRows} mapped, ${unmappedRows} unmapped)`);
      // Step 7: Generate report
      const unmappedAccounts = await db.getUnmappedAccounts();

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
          message: `ACCPAC line items import completed successfully`,
          mappingStats: {
            total: processedRows,
            mapped: mappedRows,
            unmapped: unmappedRows,
            unmappedPercentage: processedRows > 0 ? ((unmappedRows / processedRows) * 100).toFixed(2) + '%' : '0%'
          },
          unmappedAccounts: unmappedAccounts.length > 0 ? unmappedAccounts : undefined,
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
   */
  async validateRow(row: any, rowIndex: number): Promise<true | string> {
    // TODO: Implement row-level validation
    // - Check required fields
    // - Validate data types
    // - Check business rules

    return true;
  }

  /**
   * STEP 5: ROW TRANSFORMATION
   */
  async transformRow(row: any, rowIndex: number): Promise<any | null> {
    // TODO: Implement row transformation
    // - Clean and transform the data
    // - Map fields to internal structure
    // - Add metadata

    return row;
  }

  /**
   * STEP 6: PRE-IMPORT HOOK
   */
  async preImport(filePath: string, options?: ImportOptions): Promise<void> {
    await super.preImport(filePath, options);

    // console.log(`[${this.metadata.id}] Preparing for ACCPAC line items import...`);
    // TODO: Add pre-import setup
    // - Check database connection
    // - Create backup
    // - Clear staging tables
    // - Check dependencies

    // console.log(`[${this.metadata.id}] Pre-import setup complete`);
  }

  /**
   * STEP 7: POST-IMPORT HOOK
   */
  async postImport(result: ImportResult, options?: ImportOptions): Promise<void> {
    await super.postImport(result, options);

    // console.log(`[${this.metadata.id}] Running post-import tasks...`);
    // TODO: Add post-import tasks
    // - Send notifications
    // - Update statistics
    // - Trigger dependent processes
    // - Clean up temp files

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

  /**
   * Aggregate rows by mapped combo and sum ACTIVITY amounts
   * Handles multiple source rows mapping to the same target combo
   */
  private async aggregateAndMapRows(
    rows: any[],
    year: number,
    month: number,
    ou: string,
    currency: string,
    batchId: string
  ): Promise<any[]> {
    // console.log(`[${this.metadata.id}] Aggregating and mapping ${rows.length} rows...`);
    // Get all mappings for config_id = 10
    const mappings = await db.getMappings(10);
    // console.log(`[${this.metadata.id}] Loaded ${mappings.length} mappings for config_id = 10`);
    // Build a lookup map for faster access
    const mappingLookup = new Map<string, any>();
    for (const mapping of mappings) {
      if (mapping.source_account && mapping.is_active) {
        mappingLookup.set(mapping.source_account, mapping);
      }
    }

    // Aggregate data by combo key
    const aggregationMap = new Map<string, any>();

    for (const row of rows) {
      const sourceAccount = row.ACCTCODE?.trim();
      const sourceDescription = row.ACCTDESC?.trim() || '';
      const activity = parseFloat(row.ACTIVITY) || 0;

      // Skip rows with no ACCTCODE or zero activity
      if (!sourceAccount) {
        // console.warn(`[${this.metadata.id}] Skipping row with missing ACCTCODE`);
        continue;
      }

      if (activity === 0) {
        continue; // Skip rows with zero activity
      }

      // Skip rooms revenue accounts (5xxxRS) — imported via Opera instead
      if (/^5\d+RS$/.test(sourceAccount)) {
        continue;
      }

      // Lookup mapping
      const mapping = mappingLookup.get(sourceAccount);

      let targetAccount: string | null = null;
      let targetDepartment: string | null = null;
      let mappingStatus = 'unmapped';
      let comboId: string | null = null;

      if (mapping && mapping.target_account && mapping.target_department) {
        targetAccount = mapping.target_account;
        targetDepartment = mapping.target_department;
        mappingStatus = 'mapped';
        comboId = `${targetDepartment}_${targetAccount}`;
      } else if (mapping && (mapping.target_account || mapping.target_department)) {
        targetAccount = mapping.target_account;
        targetDepartment = mapping.target_department;
        mappingStatus = 'partial';
        comboId = targetAccount && targetDepartment ? `${targetDepartment}_${targetAccount}` : null;
      }

      // Create aggregation key: combo_id + source_account (to track source separately)
      const aggKey = `${comboId || 'UNMAPPED'}_${sourceAccount}`;

      if (aggregationMap.has(aggKey)) {
        // Add to existing aggregate
        const existing = aggregationMap.get(aggKey);
        existing.amount += activity;
      } else {
        // Create new aggregate entry
        const periodCombo = `${year}-${String(month).padStart(2, '0')}`;

        aggregationMap.set(aggKey, {
          dep_acc_combo_id: comboId || 'UNMAPPED',
          month,
          year,
          period_combo: periodCombo,
          scenario: 'ACT',
          amount: activity,
          currency,
          ou,
          department: targetDepartment,
          account: targetAccount,
          version: 'MAIN',
          source_account: sourceAccount,
          source_department: null,
          source_description: sourceDescription,
          mapping_status: mappingStatus,
          import_batch_id: batchId
        });
      }
    }

    const result = Array.from(aggregationMap.values());
    // console.log(`[${this.metadata.id}] Aggregated ${rows.length} rows into ${result.length} staging records`);
    return result;
  }

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
}
