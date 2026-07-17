// Data Import Types - Clean, modular type definitions for the import system

export enum ImportStatus {
  Pending = 'pending',
  Validating = 'validating',
  Processing = 'processing',
  Complete = 'complete',
  Failed = 'failed'
}

export interface ImportColumn {
  name: string;
  required: boolean;
  mappedTo?: string;
  dataType?: 'string' | 'number' | 'date' | 'boolean';
}

export interface ImportFile {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  fileTypes: string[]; // ['xls', 'xlsx', 'csv']
  status: ImportStatus;
  file?: File;
  fileName?: string;
  rowCount?: number;
  columns?: ImportColumn[];
  progress?: number;
  error?: string;
  required: boolean;
  order: number;
  requiredColumns?: string[];
  optionalColumns?: string[];
  validationRules?: string[];
}

export interface ImportSession {
  id: string;
  hotelId: string;
  hotelName: string;
  imports: ImportFile[];
  startTime?: Date;
  endTime?: Date;
  status: 'idle' | 'importing' | 'compiling' | 'complete' | 'failed';
}

export interface HotelConfig {
  id: string;
  name: string;
  defaultImportType: string;
  availableImports: string[];
}

export interface DataImportState {
  currentSession?: ImportSession;
  selectedHotel?: HotelConfig;
  isProcessing: boolean;
  canCompile: boolean;
}

// IPC Channel definitions
export const DATA_IMPORT_CHANNELS = {
  VALIDATE_FILE: 'dataImport:validateFile',
  IMPORT_FILE: 'dataImport:importFile',
  GET_FILE_PREVIEW: 'dataImport:getFilePreview',
  COMPILE_DATA: 'dataImport:compileData',
  GET_IMPORT_STATUS: 'dataImport:getImportStatus'
} as const;