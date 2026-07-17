/**
 * OPERA ROOM SEGMENT IMPORT PROCESSOR
 * ====================================
 *
 * Import processor for Opera Room Segment data from Opera export files (tab-delimited text or Excel).
 * Replaces the old ACCPAC Room Revenue import.
 * Mapping ID: 12
 *
 * This processor:
 * 1. Imports ROOM_REVENUE amounts with _REV suffix mapping
 * 2. Imports NIGHTS as stats with _STATS suffix mapping
 * 3. Creates a hardcoded total stats entry for D0010_A960099
 *
 * Market codes are suffixed with _WD (weekday) or _WE (weekend) based on the date:
 * - Friday & Saturday = Weekend (_WE)
 * - Other days = Weekday (_WD)
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
import { parseFile } from '../utils/fileParser';
import * as db from '../../../local_db';

/**
 * Opera Room Segment Import Processor
 */
export class OperaRoomSegImportProcessor extends BaseImportProcessor {
  /**
   * Hardcoded target for total stats
   */
  private readonly TOTAL_STATS_ACCOUNT = 'A960099';
  private readonly TOTAL_STATS_DEPARTMENT = 'D0010';

  /**
   * STEP 1: DEFINE YOUR METADATA
   */
  metadata: ImportProcessorMetadata = {
    // Unique identifier
    id: 'opera_room_seg_import',

    // Display name shown in the UI
    name: 'Opera Room Segment Import',

    // Detailed description
    description: 'Import Opera room segment data with mapping ID 12. Processes room revenue and nights data by market code with weekday/weekend differentiation.',

    // Category for grouping in UI
    category: 'Opera',

    // File formats this processor can handle
    supportedFormats: ['txt', 'csv', 'xlsx'],

    // Whether this import is required for system operation
    required: true,

    // Processing order
    order: 11,

    // Required columns
    requiredColumns: [
      'BUSINESS_DATE',
      'MARKET_CODE',
      'NIGHTS',
      'ROOM_REVENUE'
    ],

    // Optional columns
    optionalColumns: [],

    // Validation rules shown to users
    validationRules: [
      'File must contain all required columns: BUSINESS_DATE, MARKET_CODE, NIGHTS, ROOM_REVENUE',
      'Rows with empty NIGHTS and ROOM_REVENUE will be skipped (metadata rows)',
      'BUSINESS_DATE must be valid dates within the selected import month',
      'Market codes are suffixed with _WD (weekday) or _WE (weekend) based on the date'
    ],

    // Tags for filtering/searching
    tags: ['opera', 'room', 'segment', 'revenue', 'stats', 'financial'],

    // Version of this processor
    version: '1.0.0'
  };

  /**
   * Override file parsing to use tab delimiter for text-based files (txt/csv).
   * Opera exports tab-delimited data, so we force '\t' for non-Excel formats.
   */
  protected async getParsedFile(
    filePath: string,
    fileType: string,
    options?: ImportOptions
  ): Promise<ParsedFile> {
    const ext = fileType.toLowerCase().replace('.', '');
    if (ext === 'txt' || ext === 'csv') {
      return parseFile(filePath, fileType, {
        delimiter: '\t',
        encoding: options?.encoding,
        limit: options?.previewRows,
        relaxColumnCount: true
      });
    }
    return super.getParsedFile(filePath, fileType, options);
  }

  /**
   * STEP 2: CUSTOMIZE VALIDATION
   */
  async validate(filePath: string, fileType: string, options?: ImportOptions): Promise<ValidationResult> {
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

      // Validate dates are within selected month
      const expectedYear = options?.custom?.year;
      const expectedMonth = options?.custom?.month;

      if (!expectedYear || !expectedMonth) {
        errors.push('Import period (year and month) must be selected before validating');
        return {
          isValid: false,
          rowCount: parsed.rowCount,
          columnCount: parsed.columns.length,
          detectedColumns: parsed.columns,
          errors,
          fileInfo: {
            size: 0,
            encoding: 'utf-8',
            hasHeaders: true
          }
        };
      }

      // Check dates in the file
      let validDateCount = 0;
      let invalidDateCount = 0;
      let skippedMetadataRows = 0;

      for (const row of parsed.data) {
        const nights = row.NIGHTS;
        const revenue = row.ROOM_REVENUE;

        // Skip rows with no NIGHTS and no ROOM_REVENUE (metadata rows)
        if ((nights === null || nights === undefined || nights === '') &&
            (revenue === null || revenue === undefined || revenue === '')) {
          skippedMetadataRows++;
          continue;
        }

        const businessDate = row.BUSINESS_DATE;
        const parsedDate = this.parseExcelDate(businessDate);

        if (!parsedDate) {
          invalidDateCount++;
          continue;
        }

        const dateMonth = parsedDate.getMonth() + 1;
        const dateYear = parsedDate.getFullYear();

        if (dateYear === expectedYear && dateMonth === expectedMonth) {
          validDateCount++;
        } else {
          invalidDateCount++;
        }
      }

      if (validDateCount === 0) {
        errors.push(`No valid dates found for the selected period (${expectedMonth}/${expectedYear})`);
      }

      if (invalidDateCount > 0) {
        warnings.push(`${invalidDateCount} row(s) have dates outside the selected period and will be skipped`);
      }

      if (skippedMetadataRows > 0) {
        warnings.push(`${skippedMetadataRows} metadata row(s) (empty NIGHTS and ROOM_REVENUE) will be skipped`);
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
          `File validated successfully - ${validDateCount} valid data rows detected`,
          `Import period: ${expectedMonth}/${expectedYear}`,
          ...warnings
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
   * Parse Excel date (can be Date object, string DD/MM/YYYY, DD-MMM-YY, or Excel serial number)
   */
  private parseExcelDate(dateField: any): Date | null {
    if (!dateField) return null;

    if (dateField instanceof Date) {
      return dateField;
    }

    if (typeof dateField === 'string') {
      // Try DD/MM/YYYY format
      const dateMatch = dateField.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (dateMatch) {
        const day = parseInt(dateMatch[1], 10);
        const month = parseInt(dateMatch[2], 10) - 1; // 0-indexed
        const year = parseInt(dateMatch[3], 10);
        return new Date(year, month, day);
      }

      // Try DD-MMM-YY format (e.g. 01-FEB-26)
      const monthNames: Record<string, number> = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
      };
      const shortDateMatch = dateField.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
      if (shortDateMatch) {
        const day = parseInt(shortDateMatch[1], 10);
        const monthIdx = monthNames[shortDateMatch[2].toUpperCase()];
        const shortYear = parseInt(shortDateMatch[3], 10);
        if (monthIdx !== undefined) {
          const year = shortYear >= 50 ? 1900 + shortYear : 2000 + shortYear;
          return new Date(year, monthIdx, day);
        }
      }

      return null;
    }

    if (typeof dateField === 'number') {
      // Excel serial date number
      const excelDate = new Date((dateField - 25569) * 86400 * 1000);
      return excelDate;
    }

    return null;
  }

  /**
   * Determine if date is weekend (Friday or Saturday)
   */
  private isWeekend(date: Date): boolean {
    const dayOfWeek = date.getDay();
    // 5 = Friday, 6 = Saturday
    return dayOfWeek === 5 || dayOfWeek === 6;
  }

  /**
   * Build the mapping key from market code and date
   * Format: {MARKET_CODE}_{WD|WE}_{REV|STATS}
   */
  private buildMappingKey(marketCode: string, date: Date, type: 'REV' | 'STATS'): string {
    const weekendSuffix = this.isWeekend(date) ? 'WE' : 'WD';
    return `${marketCode}_${weekendSuffix}_${type}`;
  }

  /**
   * STEP 3: CUSTOMIZE PROCESSING
   */
  protected async processRows(parsed: ParsedFile, options?: ImportOptions): Promise<ImportResult> {
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

      // Generate import batch ID
      const now = new Date();
      const batchId = `opera_room_seg_${now.toISOString().replace(/[:.]/g, '-')}`;

      // Step 2: Get hotel currency from metadata
      const currency = await this.getHotelCurrency(ou);
      if (!currency) {
        warnings.push('Hotel currency not found, defaulting to USD');
      }
      const finalCurrency = currency || 'USD';

      // Step 3: Aggregate and map rows
      const { aggregatedData, totalNights } = await this.aggregateAndMapRows(
        parsed.data,
        year,
        month,
        ou,
        finalCurrency,
        batchId
      );

      // Step 4: Add total stats entry (hardcoded D0010_A960099)
      // Stats are stored in the amount column - stat accounts are identified by account code
      const periodCombo = `${year}-${String(month).padStart(2, '0')}`;
      const totalStatsEntry = {
        dep_acc_combo_id: `${this.TOTAL_STATS_DEPARTMENT}_${this.TOTAL_STATS_ACCOUNT}`,
        month,
        year,
        period_combo: periodCombo,
        scenario: 'ACT',
        amount: totalNights,
        currency: finalCurrency,
        ou,
        department: this.TOTAL_STATS_DEPARTMENT,
        account: this.TOTAL_STATS_ACCOUNT,
        version: 'MAIN',
        source_account: 'TOTAL_NIGHTS',
        source_department: 'hardcoded',
        source_description: 'Total Room Nights',
        mapping_status: 'mapped',
        import_batch_id: batchId
      };
      aggregatedData.push(totalStatsEntry);

      // Step 5: Batch insert into staging table
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
          mappingId: 12,
          message: `Opera room segment import completed successfully`,
          mappingStats: {
            total: processedRows,
            mapped: mappedRows,
            unmapped: unmappedRows,
            unmappedPercentage: processedRows > 0 ? ((unmappedRows / processedRows) * 100).toFixed(2) + '%' : '0%'
          },
          unmappedAccounts: unmappedAccounts.length > 0 ? unmappedAccounts : undefined,
          totalNights,
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

  /**
   * Aggregate rows by mapped combo and process room segment data
   * Creates 2 staging entries per valid row:
   * - {MARKET_CODE}_{WD|WE}_REV for ROOM_REVENUE
   * - {MARKET_CODE}_{WD|WE}_STATS for NIGHTS
   */
  private async aggregateAndMapRows(
    rows: any[],
    year: number,
    month: number,
    ou: string,
    currency: string,
    batchId: string
  ): Promise<{ aggregatedData: any[]; totalNights: number }> {
    // Get all mappings for config_id = 12
    const mappings = await db.getMappings(12);

    // Build a lookup map for faster access using source_account
    const mappingLookup = new Map<string, any>();
    for (const mapping of mappings) {
      if (mapping.source_account && mapping.is_active) {
        mappingLookup.set(mapping.source_account, mapping);
      }
    }

    // Aggregate data by combo key
    const aggregationMap = new Map<string, any>();
    let totalNights = 0;
    const periodCombo = `${year}-${String(month).padStart(2, '0')}`;

    for (const row of rows) {
      const nights = row.NIGHTS;
      const revenue = row.ROOM_REVENUE;

      // Skip rows with no NIGHTS and no ROOM_REVENUE (metadata rows)
      if ((nights === null || nights === undefined || nights === '') &&
          (revenue === null || revenue === undefined || revenue === '')) {
        continue;
      }

      const businessDate = row.BUSINESS_DATE;
      const parsedDate = this.parseExcelDate(businessDate);

      if (!parsedDate) {
        continue;
      }

      // Check if date is within selected period
      const dateMonth = parsedDate.getMonth() + 1;
      const dateYear = parsedDate.getFullYear();

      if (dateYear !== year || dateMonth !== month) {
        continue;
      }

      const marketCode = row.MARKET_CODE?.trim();
      if (!marketCode) {
        continue;
      }

      const nightsValue = parseFloat(nights) || 0;
      const revenueValue = parseFloat(revenue) || 0;

      // Accumulate total nights for the hardcoded stats entry
      totalNights += nightsValue;

      // Process ROOM_REVENUE with _REV suffix
      // Negate revenue: Opera sends positive values, but GL convention stores revenue as negative (credit balance)
      if (revenueValue !== 0) {
        const revKey = this.buildMappingKey(marketCode, parsedDate, 'REV');
        this.addToAggregation(
          aggregationMap,
          mappingLookup,
          revKey,
          -revenueValue,
          year,
          month,
          periodCombo,
          ou,
          currency,
          batchId
        );
      }

      // Process NIGHTS with _STATS suffix
      if (nightsValue !== 0) {
        const statsKey = this.buildMappingKey(marketCode, parsedDate, 'STATS');
        this.addToAggregation(
          aggregationMap,
          mappingLookup,
          statsKey,
          nightsValue,
          year,
          month,
          periodCombo,
          ou,
          currency,
          batchId
        );
      }
    }

    const aggregatedData = Array.from(aggregationMap.values());
    return { aggregatedData, totalNights };
  }

  /**
   * Add a value to the aggregation map
   */
  private addToAggregation(
    aggregationMap: Map<string, any>,
    mappingLookup: Map<string, any>,
    sourceAccount: string,
    amount: number,
    year: number,
    month: number,
    periodCombo: string,
    ou: string,
    currency: string,
    batchId: string
  ): void {
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

    // Create aggregation key: combo_id + source_account
    const aggKey = `${comboId || 'UNMAPPED'}_${sourceAccount}`;

    if (aggregationMap.has(aggKey)) {
      // Add to existing aggregate
      const existing = aggregationMap.get(aggKey);
      existing.amount += amount;
    } else {
      // Create new aggregate entry
      aggregationMap.set(aggKey, {
        dep_acc_combo_id: comboId || 'UNMAPPED',
        month,
        year,
        period_combo: periodCombo,
        scenario: 'ACT',
        amount,
        currency,
        ou,
        department: targetDepartment,
        account: targetAccount,
        version: 'MAIN',
        source_account: sourceAccount,
        source_department: null,
        source_description: sourceAccount,
        mapping_status: mappingStatus,
        import_batch_id: batchId
      });
    }
  }

  /**
   * STEP 4: ROW VALIDATION (OPTIONAL)
   */
  async validateRow(row: any, rowIndex: number): Promise<true | string> {
    return true;
  }

  /**
   * STEP 5: ROW TRANSFORMATION (OPTIONAL)
   */
  async transformRow(row: any, rowIndex: number): Promise<any | null> {
    return row;
  }

  /**
   * STEP 6: PRE-IMPORT HOOK (OPTIONAL)
   */
  async preImport(filePath: string, options?: ImportOptions): Promise<void> {
    await super.preImport(filePath, options);

    // Delete any existing staging data that matches the accounts we're about to import
    await this.clearMatchingStagingData();
  }

  /**
   * Clear staging data where staging.source_account matches mapping.source_department from config 12
   * This prevents duplicate data when re-importing
   */
  private async clearMatchingStagingData(): Promise<void> {
    try {
      // Get all mappings for config_id = 12
      const mappings = await db.getMappings(12);

      // Extract unique source_department values from the mapping table
      const sourceDepartments = mappings
        .filter(m => m.source_department && m.is_active)
        .map(m => m.source_department)
        .filter((value, index, self) => self.indexOf(value) === index);

      // Also clear the hardcoded total stats entry
      const accountsToClear = [...sourceDepartments, 'TOTAL_NIGHTS'];

      if (accountsToClear.length === 0) {
        return;
      }

      // Delete staging rows where source_account matches
      await db.deleteStagingBySourceAccounts(accountsToClear);
    } catch (error) {
      console.error(`[${this.metadata.id}] Error clearing matching staging data:`, error);
      // Don't throw - allow import to continue even if cleanup fails
    }
  }

  /**
   * STEP 7: POST-IMPORT HOOK (OPTIONAL)
   */
  async postImport(result: ImportResult, options?: ImportOptions): Promise<void> {
    await super.postImport(result, options);
  }
}
