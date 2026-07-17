import { PLRow } from '../../types/plReportTypes';
import { ROOMS_KPI_ROW_CONFIG } from './roomsKpiRowConfig';

// ============================================================================
// SUMMARY P&L ROW CONFIGURATION
// Defines the structure and ordering of the Summary P&L report
//
// SIGN CONVENTION NOTES:
// - Revenue/profit sub-measures use negate:true in plMeasureDefinitions, which
//   converts negative DB credits to positive display values.  No invertSign
//   is needed for these rows — values are already positive.
// - Expense sub-measures do NOT use negate:true; they are positive DB debits
//   that come through as positive values.  Again, no data sign change needed.
// - invertSign:true on expense rows here does NOT invert the displayed value
//   (unlike F90).  It is used solely as a signal so the engine can set
//   invertVariance:true, which tells the UI to colour positive variances RED
//   (over-spend vs budget/LY is bad from a management perspective).
// ============================================================================

export const SUMMARY_PL_ROW_CONFIG: PLRow[] = [
  // KEY METRICS - BOLD
  { type: 'header', label: 'Occupancy', measureId: 'occupancy_rooms', formatting: 'percentage', indentLevel: 0 },
  { type: 'header', label: 'ADR Rate', measureId: 'adr_act_sy', formatting: 'number', indentLevel: 0 },
  { type: 'header', label: 'RevPAR', measureId: 'rev_par_act_sy', formatting: 'number', indentLevel: 0 },

  // SPACING
  { type: 'header', label: '', indentLevel: 0 },

  // TOTAL SALES - BOLD
  { type: 'header', label: 'Total Sales', measureId: 'total_revenue_act_sy', formatting: 'number', indentLevel: 0 },

  // SPACING
  { type: 'header', label: '', indentLevel: 0 },

  // GROSS OPERATING PROFIT - BOLD
  { type: 'header', label: 'Gross Operating Profit', measureId: 'total_profit_act_sy', formatting: 'number', indentLevel: 0 },
  { type: 'header', label: 'Gross Operating Profit Margin', measureId: 'total_profit_pct_revenue_sy', formatting: 'percentage', indentLevel: 0 },
  { type: 'header', label: 'Total Flow Through (vs LY)', measureId: 'flow_thru_act_sy', formatting: 'percentage', indentLevel: 0 },

  // SPACING
  { type: 'header', label: '', indentLevel: 0 },

  // DEPARTMENTAL DETAILS - INDENTED
  { type: 'measure', label: 'Rooms Sales', measureId: 'total_rooms_revenue_act_sy_measure', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Rooms Dept Profit', measureId: 'rooms_dept_profit_act_sy_measure', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Rooms Dept Profit %', measureId: 'rooms_dept_profit_pct_revenue_act_sy', formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'F&B Sales', measureId: 'total_fb_revenue_act_sy_measure', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'F&B Dept Profit', measureId: 'fb_profit_sy', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'F&B Dept Profit %', measureId: 'fb_profit_pct_revenue_act_sy', formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Other Sales', measureId: 'other_revenue_act_sy_measure', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Other Dept Profit', measureId: 'other_profit_act_sy_measure', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Other Dept Profit %', measureId: 'other_profit_pct_revenue_act_sy', formatting: 'percentage', indentLevel: 1 },

  // DEPARTMENT PROFIT - BOLD
  { type: 'header', label: 'Department Profit', measureId: 'dep_profit_act_sy', formatting: 'number', indentLevel: 0 },
  { type: 'header', label: 'Department Profit %', measureId: 'dep_profit_pct_revenue_act_sy', formatting: 'percentage', indentLevel: 0 },

  // SPACING
  { type: 'header', label: '', indentLevel: 0 },

  // UOE DETAILS - INDENTED (debit-balance: invertSign signals variance inversion, not data flip)
  { type: 'measure', label: 'Administrative & General w/o CC', measureId: 'admin_wo_cc_act_sy', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Credit Card Expense (CC)', measureId: 'cc_expense_act_sy_measure', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'IT & Telephone', measureId: 'it_and_telecom_act_sy_measure', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Energy, Water & Waste', measureId: 'utilities_act_sy_measure', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Property Operation & Maintenance', measureId: 'pom_act_sy_measure', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Sales & Marketing', measureId: 'sales_act_sy_measure', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Other UOE', measureId: 'other_uoe_act_sy_measure', formatting: 'number', indentLevel: 1, invertSign: true },

  // SPACING
  { type: 'header', label: '', indentLevel: 0 },

  // TOTALS - BOLD (expense/cost rows: invertSign signals variance inversion only)
  { type: 'header', label: 'Total UOE', measureId: 'total_uoe_act_sy', formatting: 'number', indentLevel: 0, invertSign: true },
  { type: 'header', label: 'Total Payroll', measureId: 'total_payroll_act_sy_measure', formatting: 'number', indentLevel: 0, invertSign: true },
  { type: 'header', label: 'Payroll % per Total Revenue', measureId: 'payroll_pct_revenue_act_sy', formatting: 'percentage', indentLevel: 0, invertSign: true },
  { type: 'header', label: 'Travel Agent Commission Cost', measureId: 'ta_commission_act_sy_measure', formatting: 'number', indentLevel: 0, invertSign: true },
  { type: 'header', label: 'Room CPOR', measureId: 'cpsr_act', formatting: 'number', indentLevel: 0, invertSign: true },
  // Net Operating Income — credit-balance (higher = good), no invertSign
  { type: 'header', label: 'Net Operating Income', measureId: 'noi_act_sy', formatting: 'number', indentLevel: 0 },

  // SPACING
  { type: 'header', label: '', indentLevel: 0 },

  // Rooms & Reservation Summary KPI block (shared mapping table — also used by
  // F90 P&L and Marriott Excel Export). All measures are engine-driven so
  // adding/removing a KPI is a one-line edit in roomsKpiRowConfig.ts.
  ...ROOMS_KPI_ROW_CONFIG,
];
