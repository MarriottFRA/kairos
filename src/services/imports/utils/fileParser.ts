/**
 * File Parser Utilities
 * ====================
 *
 * Centralized file parsing utilities for CSV, Excel, and other formats.
 * These utilities handle the low-level file reading and parsing operations.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { ParsedFile } from '../core/interfaces';

/**
 * File parser options
 */
export interface FileParserOptions {
  /** CSV delimiter (default: ',') */
  delimiter?: string;

  /** File encoding (default: 'utf-8') */
  encoding?: BufferEncoding;

  /** Excel sheet name to read */
  sheetName?: string;

  /** Maximum number of rows to read (for preview) */
  limit?: number;

  /** Whether file has headers (default: true) */
  hasHeaders?: boolean;

  /** Skip empty lines in CSV (default: true) */
  skipEmptyLines?: boolean;

  /** Trim whitespace from values (default: true) */
  trim?: boolean;

  /** Date format for parsing dates */
  dateFormat?: string;

  /** Custom column mapping */
  columnMapping?: Record<string, string>;

  /** Skip records with inconsistent column counts instead of throwing (e.g. report footer rows) */
  relaxColumnCount?: boolean;
}

/**
 * Parse a CSV file
 * @param filePath Path to the CSV file
 * @param options Parser options
 * @returns Parsed file data
 */
export async function parseCSVFile(
  filePath: string,
  options: FileParserOptions = {}
): Promise<ParsedFile> {
  // console.log(`[FileParser] Parsing CSV file: ${filePath}`);
  try {
    // Read file content
    const fileContent = await fs.readFile(filePath, options.encoding || 'utf-8');

    // Check if file is empty
    if (!fileContent || fileContent.trim().length === 0) {
      return {
        data: [],
        rowCount: 0,
        columns: [],
        metadata: {
          delimiter: options.delimiter || ',',
          encoding: options.encoding || 'utf-8',
          hasHeaders: options.hasHeaders !== false
        }
      };
    }

    // Parse CSV options
    const parseOptions: any = {
      columns: options.hasHeaders !== false, // Use first row as headers by default
      skip_empty_lines: options.skipEmptyLines !== false,
      trim: options.trim !== false,
      delimiter: options.delimiter || ',',
      relax_quotes: true,
      skip_records_with_error: options.relaxColumnCount || false
    };

    // Add row limit if specified
    if (options.limit && options.limit > 0) {
      parseOptions.to = options.limit + (options.hasHeaders !== false ? 1 : 0);
    }

    // Parse CSV
    const records = parse(fileContent, parseOptions);

    // Handle empty result
    if (!records || records.length === 0) {
      return {
        data: [],
        rowCount: 0,
        columns: [],
        metadata: {
          delimiter: options.delimiter || ',',
          encoding: options.encoding || 'utf-8',
          hasHeaders: options.hasHeaders !== false
        }
      };
    }

    // Get column names
    let columns: string[] = [];
    if (options.hasHeaders !== false && records.length > 0) {
      columns = Object.keys(records[0]);
    } else if (Array.isArray(records[0])) {
      // No headers, create generic column names
      columns = records[0].map((_: any, index: number) => `Column${index + 1}`);
    }

    // Apply column mapping if provided
    if (options.columnMapping && columns.length > 0) {
      const mappedRecords = records.map((row: any) => {
        const mapped: any = {};
        for (const [oldName, newName] of Object.entries(options.columnMapping!)) {
          if (oldName in row) {
            mapped[newName] = row[oldName];
          }
        }
        // Include unmapped columns
        for (const key in row) {
          if (!options.columnMapping![key]) {
            mapped[key] = row[key];
          }
        }
        return mapped;
      });
      records.splice(0, records.length, ...mappedRecords);

      // Update column names
      columns = columns.map(col => options.columnMapping![col] || col);
    }

    // console.log(`[FileParser] Parsed ${records.length} rows with ${columns.length} columns`);
    return {
      data: records,
      rowCount: records.length,
      columns: columns,
      metadata: {
        delimiter: options.delimiter || ',',
        encoding: options.encoding || 'utf-8',
        hasHeaders: options.hasHeaders !== false
      }
    };
  } catch (error) {
    console.error('[FileParser] Error parsing CSV file:', error);
    throw new Error(`Failed to parse CSV file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Parse an Excel file (.xlsx or .xls)
 * @param filePath Path to the Excel file
 * @param options Parser options
 * @returns Parsed file data
 */
export async function parseExcelFile(
  filePath: string,
  options: FileParserOptions = {}
): Promise<ParsedFile> {
  // console.log(`[FileParser] Parsing Excel file: ${filePath}`);
  try {
    // Read file as buffer
    const fileBuffer = await fs.readFile(filePath);

    // Parse workbook
    const workbook = XLSX.read(fileBuffer, {
      type: 'buffer',
      cellDates: true,
      cellNF: false,
      cellText: false
    });

    // Get sheet name
    let sheetName = options.sheetName;
    if (!sheetName) {
      // Use first sheet if not specified
      sheetName = workbook.SheetNames[0];
      // console.log(`[FileParser] Using first sheet: ${sheetName}`);
    }

    // Validate sheet exists
    if (!workbook.Sheets[sheetName]) {
      throw new Error(`Sheet '${sheetName}' not found. Available sheets: ${workbook.SheetNames.join(', ')}`);
    }

    const sheet = workbook.Sheets[sheetName];

    // Convert to JSON
    const jsonData = XLSX.utils.sheet_to_json(sheet, {
      header: options.hasHeaders === false ? 1 : undefined,
      defval: '', // Default value for empty cells
      blankrows: false, // Skip blank rows
      dateNF: options.dateFormat
    });

    // Apply row limit if specified
    let data = jsonData;
    if (options.limit && options.limit > 0) {
      data = jsonData.slice(0, options.limit);
    }

    // Get column names
    let columns: string[] = [];
    if (data.length > 0) {
      if (options.hasHeaders !== false) {
        columns = Object.keys(data[0]);
      } else {
        // Generate column names for headerless data
        const firstRow = data[0] as any;
        columns = Object.keys(firstRow).map((_, index) => `Column${index + 1}`);
      }
    }

    // Apply column mapping if provided
    if (options.columnMapping && data.length > 0) {
      data = data.map((row: any) => {
        const mapped: any = {};
        for (const [oldName, newName] of Object.entries(options.columnMapping!)) {
          if (oldName in row) {
            mapped[newName] = row[oldName];
          }
        }
        // Include unmapped columns
        for (const key in row) {
          if (!options.columnMapping![key]) {
            mapped[key] = row[key];
          }
        }
        return mapped;
      });

      // Update column names
      columns = columns.map(col => options.columnMapping![col] || col);
    }

    // console.log(`[FileParser] Parsed ${data.length} rows with ${columns.length} columns from sheet '${sheetName}'`);
    return {
      data: data,
      rowCount: data.length,
      columns: columns,
      metadata: {
        sheetName: sheetName,
        encoding: 'binary',
        hasHeaders: options.hasHeaders !== false
      }
    };
  } catch (error) {
    console.error('[FileParser] Error parsing Excel file:', error);
    throw new Error(`Failed to parse Excel file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Parse a JSON file
 * @param filePath Path to the JSON file
 * @param options Parser options
 * @returns Parsed file data
 */
export async function parseJSONFile(
  filePath: string,
  options: FileParserOptions = {}
): Promise<ParsedFile> {
  // console.log(`[FileParser] Parsing JSON file: ${filePath}`);
  try {
    // Read file content
    const fileContent = await fs.readFile(filePath, options.encoding || 'utf-8');

    // Parse JSON
    const jsonData = JSON.parse(fileContent);

    // Ensure data is an array
    let data = Array.isArray(jsonData) ? jsonData : [jsonData];

    // Apply row limit if specified
    if (options.limit && options.limit > 0) {
      data = data.slice(0, options.limit);
    }

    // Get column names from first object
    const columns = data.length > 0 ? Object.keys(data[0]) : [];

    // console.log(`[FileParser] Parsed ${data.length} rows with ${columns.length} columns`);
    return {
      data: data,
      rowCount: data.length,
      columns: columns,
      metadata: {
        encoding: options.encoding || 'utf-8',
        hasHeaders: true
      }
    };
  } catch (error) {
    console.error('[FileParser] Error parsing JSON file:', error);
    throw new Error(`Failed to parse JSON file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Generic file parser that handles multiple formats
 * @param filePath Path to the file
 * @param fileType File extension (csv, xls, xlsx, json)
 * @param options Parser options
 * @returns Parsed file data
 */
export async function parseFile(
  filePath: string,
  fileType: string,
  options: FileParserOptions = {}
): Promise<ParsedFile> {
  // Normalize file type
  const ext = fileType.toLowerCase().replace('.', '');

  // console.log(`[FileParser] Parsing file with type: ${ext}`);
  switch (ext) {
    case 'csv':
    case 'txt':
      return parseCSVFile(filePath, options);

    case 'xls':
    case 'xlsx':
    case 'xlsm':
    case 'xlsb':
      return parseExcelFile(filePath, options);

    case 'json':
      return parseJSONFile(filePath, options);

    default:
      throw new Error(`Unsupported file type: ${fileType}. Supported formats: CSV, Excel (XLS/XLSX), JSON`);
  }
}

/**
 * Get file type from file path
 * @param filePath Path to the file
 * @returns File extension without dot
 */
export function getFileType(filePath: string): string {
  return path.extname(filePath).substring(1).toLowerCase();
}

/**
 * Check if file type is supported
 * @param fileType File type to check
 * @returns True if supported
 */
export function isSupportedFileType(fileType: string): boolean {
  const supported = ['csv', 'txt', 'xls', 'xlsx', 'xlsm', 'xlsb', 'json'];
  return supported.includes(fileType.toLowerCase().replace('.', ''));
}

/**
 * Get file info without parsing the entire file
 * @param filePath Path to the file
 * @returns File information
 */
export async function getFileInfo(filePath: string): Promise<{
  exists: boolean;
  size: number;
  type: string;
  readable: boolean;
  path: string;
  name: string;
}> {
  try {
    const stats = await fs.stat(filePath);
    const type = getFileType(filePath);

    return {
      exists: true,
      size: stats.size,
      type: type,
      readable: stats.isFile(),
      path: filePath,
      name: path.basename(filePath)
    };
  } catch (error) {
    return {
      exists: false,
      size: 0,
      type: '',
      readable: false,
      path: filePath,
      name: path.basename(filePath)
    };
  }
}

/**
 * Count rows in a file without loading all data into memory
 * Useful for large files
 * @param filePath Path to the file
 * @param fileType File type
 * @returns Row count
 */
export async function countFileRows(
  filePath: string,
  fileType: string
): Promise<number> {
  const ext = fileType.toLowerCase().replace('.', '');

  try {
    if (ext === 'csv' || ext === 'txt') {
      // For CSV, count lines
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const lines = fileContent.split('\n').filter(line => line.trim().length > 0);
      // Subtract 1 for header row if present
      return Math.max(0, lines.length - 1);
    } else {
      // For other formats, parse and count
      const parsed = await parseFile(filePath, fileType, { limit: undefined });
      return parsed.rowCount;
    }
  } catch (error) {
    console.error(`[FileParser] Error counting rows:`, error);
    return 0;
  }
}

/**
 * Stream parse large CSV files
 * For files too large to load into memory
 * @param filePath Path to the CSV file
 * @param onRow Callback for each row
 * @param options Parser options
 */
export async function streamParseCSV(
  filePath: string,
  onRow: (row: any, index: number) => Promise<void>,
  options: FileParserOptions = {}
): Promise<number> {
  // console.log(`[FileParser] Stream parsing CSV file: ${filePath}`);
  return new Promise((resolve, reject) => {
    const parser = require('csv-parse');
    const stream = fsSync.createReadStream(filePath);
    let rowCount = 0;
    let headerRow = true;

    const parserStream = parser.parse({
      columns: options.hasHeaders !== false,
      skip_empty_lines: options.skipEmptyLines !== false,
      trim: options.trim !== false,
      delimiter: options.delimiter || ','
    });

    parserStream.on('data', async (row: any) => {
      if (headerRow && options.hasHeaders !== false) {
        headerRow = false;
        return;
      }

      try {
        await onRow(row, rowCount);
        rowCount++;

        if (options.limit && rowCount >= options.limit) {
          stream.destroy();
          parserStream.destroy();
        }
      } catch (error) {
        console.error(`[FileParser] Error processing row ${rowCount}:`, error);
        stream.destroy();
        parserStream.destroy();
        reject(error);
      }
    });

    parserStream.on('end', () => {
      // console.log(`[FileParser] Stream parsing complete: ${rowCount} rows`);
      resolve(rowCount);
    });

    parserStream.on('error', (error: Error) => {
      console.error('[FileParser] Stream parsing error:', error);
      reject(error);
    });

    stream.pipe(parserStream);
  });
}

/**
 * Validate file before parsing
 * @param filePath Path to the file
 * @returns Validation result
 */
export async function validateFile(filePath: string): Promise<{
  valid: boolean;
  error?: string;
  fileType?: string;
  size?: number;
}> {
  try {
    // Check if file exists
    const fileInfo = await getFileInfo(filePath);
    if (!fileInfo.exists) {
      return { valid: false, error: 'File does not exist' };
    }

    // Check if readable
    if (!fileInfo.readable) {
      return { valid: false, error: 'File is not readable' };
    }

    // Check file size (max 500MB by default)
    const maxSize = 500 * 1024 * 1024;
    if (fileInfo.size > maxSize) {
      return {
        valid: false,
        error: `File too large (${Math.round(fileInfo.size / 1024 / 1024)}MB). Maximum size is ${maxSize / 1024 / 1024}MB`
      };
    }

    // Check if file type is supported
    if (!isSupportedFileType(fileInfo.type)) {
      return {
        valid: false,
        error: `Unsupported file type: ${fileInfo.type}`
      };
    }

    return {
      valid: true,
      fileType: fileInfo.type,
      size: fileInfo.size
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error'
    };
  }
}