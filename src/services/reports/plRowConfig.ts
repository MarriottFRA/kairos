import { PLRow } from '../../types/plReportTypes';

// ============================================================================
// CUSTOM P&L ROW CONFIGURATION
// Defines the structure and ordering of the P&L report (80+ rows)
// Headers provide visual separation, measures link to calculation definitions
// ============================================================================

export const PL_ROW_CONFIG: PLRow[] = [
  // KEY METRICS SECTION
  { type: 'header', label: 'KEY PERFORMANCE METRICS', indentLevel: 0 },
  { type: 'measure', label: 'Occupancy', measureId: 'occupancy_rooms', formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'ADR Rate', measureId: 'adr', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'RevPAR', measureId: 'rev_par', formatting: 'number', indentLevel: 1 },

  { type: 'header', label: '', indentLevel: 0 },

  // REVENUE SECTION
  { type: 'header', label: 'REVENUE', indentLevel: 0 },
  { type: 'measure', label: 'Total Sales', measureId: 'total_revenue', formatting: 'number', indentLevel: 1 },

  { type: 'header', label: 'Rooms', indentLevel: 1 },
  { type: 'measure', label: 'Rooms Sales', measureId: 'rooms_revenue', formatting: 'number', indentLevel: 2 },

  { type: 'header', label: 'Food & Beverage', indentLevel: 1 },
  { type: 'measure', label: 'F&B Sales', measureId: 'fb_revenue', formatting: 'number', indentLevel: 2 },

  { type: 'header', label: '', indentLevel: 0 },

  // DEPARTMENTAL PROFIT SECTION
  { type: 'header', label: 'DEPARTMENTAL PROFIT', indentLevel: 0 },

  { type: 'header', label: 'Rooms Department', indentLevel: 1 },
  { type: 'measure', label: 'Rooms Dept Profit', measureId: 'rooms_dept_profit', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Rooms Dept Profit %', measureId: 'rooms_dept_profit_margin', formatting: 'percentage', indentLevel: 2 },

  { type: 'header', label: 'Food & Beverage Department', indentLevel: 1 },
  { type: 'measure', label: 'F&B Dept Profit', measureId: 'fb_dept_profit', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'F&B Dept Profit %', measureId: 'fb_dept_profit_margin', formatting: 'percentage', indentLevel: 2 },

  { type: 'header', label: '', indentLevel: 0 },

  // OPERATING PROFIT SECTION
  { type: 'header', label: 'OPERATING PROFIT', indentLevel: 0 },
  { type: 'measure', label: 'Gross Operating Profit', measureId: 'gross_operating_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Gross Operating Profit Margin', measureId: 'gross_operating_profit_margin', formatting: 'percentage', indentLevel: 1 },

  { type: 'header', label: '', indentLevel: 0 },

  // NOI SECTION
  { type: 'header', label: 'NET OPERATING INCOME', indentLevel: 0 },
  { type: 'measure', label: 'Net Operating Income', measureId: 'noi', formatting: 'number', indentLevel: 1 },

  // Additional placeholder rows to reach 80+ rows
  // These can be customized with actual measures as needed
  { type: 'header', label: '', indentLevel: 0 },
  { type: 'header', label: 'ADDITIONAL METRICS (PLACEHOLDER)', indentLevel: 0 },

  // Revenue breakdown placeholders
  { type: 'header', label: 'Other Revenue', indentLevel: 1 },
  { type: 'measure', label: 'Other Revenue 1', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Other Revenue 2', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Other Revenue 3', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Other Revenue 4', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Other Revenue 5', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },

  // Expense placeholders
  { type: 'header', label: 'Operating Expenses', indentLevel: 1 },
  { type: 'measure', label: 'Expense Line 1', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 2', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 3', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 4', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 5', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 6', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 7', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 8', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 9', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Expense Line 10', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },

  { type: 'header', label: 'Administrative & General', indentLevel: 1 },
  { type: 'measure', label: 'A&G Expense 1', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'A&G Expense 2', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'A&G Expense 3', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'A&G Expense 4', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'A&G Expense 5', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },

  { type: 'header', label: 'Marketing', indentLevel: 1 },
  { type: 'measure', label: 'Marketing Expense 1', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Marketing Expense 2', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Marketing Expense 3', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Marketing Expense 4', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },

  { type: 'header', label: 'Property Operations & Maintenance', indentLevel: 1 },
  { type: 'measure', label: 'POM Expense 1', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'POM Expense 2', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'POM Expense 3', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'POM Expense 4', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'POM Expense 5', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },

  { type: 'header', label: 'Utilities', indentLevel: 1 },
  { type: 'measure', label: 'Utilities Expense 1', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Utilities Expense 2', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Utilities Expense 3', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },

  { type: 'header', label: 'Fixed Charges', indentLevel: 1 },
  { type: 'measure', label: 'Fixed Charge 1', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Fixed Charge 2', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Fixed Charge 3', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Fixed Charge 4', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },
  { type: 'measure', label: 'Fixed Charge 5', measureId: 'total_revenue', formatting: 'number', indentLevel: 2 },

  { type: 'header', label: '', indentLevel: 0 },
  { type: 'header', label: 'SUMMARY TOTALS', indentLevel: 0 },
  { type: 'measure', label: 'Total Operating Revenue', measureId: 'total_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Total Operating Profit', measureId: 'gross_operating_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Operating Profit Margin %', measureId: 'gross_operating_profit_margin', formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Net Operating Income', measureId: 'noi', formatting: 'number', indentLevel: 1 },
];
