/**
 * Page Configuration Types
 * ========================
 *
 * These types define the JSON structure for dynamically generated pages.
 * Pages can be configured entirely via JSON without code changes.
 */

export interface PageHeaderConfig {
  title: string;
  subtitle?: string;
  icon: string; 
  gradient: {
    from: string;
    to: string;
  };
  stats?: Array<{
    label: string;
    value: string | number;
    color?: 'primary' | 'secondary' | 'success' | 'error' | 'warning' | 'info';
    dynamic?: boolean; // If true, value will be calculated dynamically
  }>;
}

export interface ImportCardConfig {
  id: string;
  displayName: string;
  description: string;
  icon?: string; 
  category: string;
  fileTypes: string[]; // e.g., ['xlsx', 'csv', 'xls']
  required: boolean;
  order: number;

  // Validation config
  requiredColumns?: string[];
  optionalColumns?: string[];
  validationRules?: string[];

  // Processing config
  preprocessor?: string;
  processor?: string;
  postprocessor?: string;
}

export interface ActionButtonConfig {
  id: string;
  label: string;
  icon?: string;
  variant: 'primary' | 'secondary';
  action: 'startImport' | 'restart' | 'export' | 'custom';
  disabled?: {
    condition: 'noFiles' | 'processing' | 'requiredMissing' | 'sessionStarted';
  };
  gradient?: {
    from: string;
    to: string;
  };
}

export interface InfoSectionConfig {
  severity: 'info' | 'warning' | 'error' | 'success';
  title: string;
  items: string[];
}

export interface DataImportPageConfig {
  header: PageHeaderConfig;
  importCards: ImportCardConfig[];
  actions: ActionButtonConfig[];
  infoSection: InfoSectionConfig;

  // Import behavior
  importMode: 'sequential' | 'parallel' | 'batch';
  enableCompilation?: boolean; // Whether to blend data after imports
  compilationMessage?: string;
}
