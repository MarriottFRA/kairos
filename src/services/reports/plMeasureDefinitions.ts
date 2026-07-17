import { SubMeasure, Measure, MeasureContext, MeasureFilter } from '../../types/plReportTypes';
import { KNOWN_LEVEL_20_VALUES, OWNER_DEPARTMENTS } from './investSubgroupConfig';
import { PROTEA_PAYROLL_REPOINT_ACCOUNTS } from './proteaMovements';
import { BANQUETING_DEPARTMENT_CODES } from './departmentScopes';
import { PROTEA_PAYROLL_SUB_MEASURES, PROTEA_PAYROLL_MEASURES } from './proteaPayrollMeasures';

// Mutable copy for measure filters (engine expects string[] not readonly[]).
const BANQ_DEPTS = [...BANQUETING_DEPARTMENT_CODES];

// ============================================================================
// CRITICAL — F90 BELOW-THE-LINE VALUES ARE OVERWRITTEN AT RENDER TIME.
//
// The F90 rows for Fixed Expenses, TOTAL MANAGEMENT FEES, Depreciation,
// Owners Expense, Net Interest, Refurbishment Fund, Abnormal Items, Tax,
// Deferred Tax, Dividends — and the five subtotals (HOTEL PROFIT BEFORE MGT
// FEES, ... BEFORE DEPR INT OWNER EXP, ... BEFORE TAX, ... BEFORE DIVIDENDS,
// NET PROFIT/(LOSS)) — do NOT come from the measure engine in production.
//
// In addF90Sheet / createBudgetF90Worksheet, we call:
//   computeInvestFactorOwnerSubgroupTotals(...)          // from proteaShared.ts
//   applyInvestSubgroupOverridesToF90Rows(rows, totals)  // from proteaShared.ts
// which runs the EXACT SAME data query and classifier INVEST FACTOR OWNER
// SUMMARY uses, and overwrites the row values. That is what guarantees
// F90 === INVEST — the alternative (re-implementing the classifier with
// atom/SQL filters in this file) has repeatedly drifted and is no longer
// trusted.
//
// The calculated measures below for f90_abnormal_items, f90_income_before_nonop,
// f90_profit_before_tax, f90_net_profit, f90_profit_after_dividends etc. are
// kept only so the measure engine has something to evaluate during its initial
// pass; their numeric output is replaced before rendering. If you are chasing
// an F90-vs-INVEST mismatch, look in proteaShared.ts
// (computeInvestFactorOwnerSubgroupTotals / applyInvestSubgroupOverridesToF90Rows),
// NOT in the measure definitions below.
// ============================================================================

// ============================================================================
// SUB-MEASURE DEFINITIONS
// Base calculations that aggregate financial data with specific filters
// ============================================================================

export const SUB_MEASURES: Record<string, SubMeasure> = {
  // Rooms Statistics
  sold_rooms_act: {
    id: 'sold_rooms_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 10, value: 'Rooms' },
      { type: 'acc_base', value: 'A960103' }
    ]
  },

  total_rooms_act: {
    id: 'total_rooms_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 10, value: 'Rooms' },
      { type: 'acc_base', value: 'A960101' }
    ]
  },

  // Revenue Measures
  total_rooms_revenue_act: {
    id: 'total_rooms_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 5, value: 'ROOMS_and_RESERVATION' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  total_revenue_act: {
    id: 'total_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  total_fb_revenue_act: {
    id: 'total_fb_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 5, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // Profit Measures
  total_profit_act: {
    id: 'total_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  rooms_dept_profit_act: {
    id: 'rooms_dept_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  fb_profit_act: {
    id: 'fb_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // NOI Components
  lodging_ops_ebitda_act: {
    id: 'lodging_ops_ebitda_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'dept_level', level: 2, value: 'Lodging Operations' }
    ]
  },

  total_hotel_ebitda_act: {
    id: 'total_hotel_ebitda_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_level', level: 1, value: 'NOI' },
      { type: 'dept_level', level: 2, value: 'NOI' }
    ]
  },

  replacement_reserve_act: {
    id: 'replacement_reserve_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_base', value: ['A701110', 'A701111', 'A759372'] },
      { type: 'dept_base', value: 'D0480' }
    ]
  },

  // Same Year (SY) Scenario - Rooms Statistics
  sold_rooms_act_sy: {
    id: 'sold_rooms_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 10, value: 'Rooms' },
      { type: 'acc_base', value: 'A960103' }
    ]
  },

  total_rooms_act_sy: {
    id: 'total_rooms_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 10, value: 'Rooms' },
      { type: 'acc_base', value: 'A960101' }
    ]
  },

  // Same Year (SY) Scenario - Revenue
  total_rooms_revenue_act_sy: {
    id: 'total_rooms_revenue_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 5, value: 'ROOMS_and_RESERVATION' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  total_revenue_act_sy: {
    id: 'total_revenue_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // Same Year (SY) Scenario - Profit
  total_profit_act_sy: {
    id: 'total_profit_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  rooms_dept_profit_act_sy: {
    id: 'rooms_dept_profit_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // Same Year (SY) Scenario - F&B
  total_fb_revenue_act_sy: {
    id: 'total_fb_revenue_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 5, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  fb_profit_act_sy: {
    id: 'fb_profit_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // Same Year (SY) Scenario - Other Operated Departments
  other_revenue_act_sy: {
    id: 'other_revenue_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 5, value: 'Other Operated Departments' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  other_profit_act_sy: {
    id: 'other_profit_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 5, value: 'Other Operated Departments' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // Same Year (SY) Scenario - Administrative & General
  admin_act_sy: {
    id: 'admin_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Administrative & General' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  cc_expense_act_sy: {
    id: 'cc_expense_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_level', level: 14, value: 'Credit Card Expense' }
    ]
  },

  it_and_telecom_act_sy: {
    id: 'it_and_telecom_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Information & Telecom Systems' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  utilities_act_sy: {
    id: 'utilities_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Utilities Dept' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  pom_act_sy: {
    id: 'pom_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Property Operation & Maintenance' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  sales_act_sy: {
    id: 'sales_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Sales & Marketing and Convention Service' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  other_uoe_act_sy: {
    id: 'other_uoe_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Other UOE' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // TODO: Replace this hardcoded department list with hierarchy-based filters
  // (e.g., dept_level + acc_level as used by total_payroll_expenses_act_sy below).
  // This list will silently go stale when departments are added or removed.
  total_payroll_act_sy: {
    id: 'total_payroll_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_level', level: 9, value: 'Total Payroll' },
      { type: 'dept_base', value: ['D0010', 'D0011', 'D0012', 'D0013', 'D0015', 'D0020', 'D0040', 'D0041', 'D0080', 'D0100', 'D0102', 'D0103', 'D0110', 'D0120', 'D0128', 'D0140', 'D0141', 'D0160', 'D0170', 'D0171', 'D0172', 'D0180', 'D0190', 'D0191', 'D0192', 'D0199', 'D0200', 'D0210', 'D0211', 'D0212', 'D0213', 'D0214', 'D0217', 'D0220', 'D0221', 'D0222', 'D0223', 'D0224', 'D0225', 'D0226', 'D0227', 'D0229', 'D0230', 'D0238', 'D0240', 'D0241', 'D0251', 'D0252', 'D0253', 'D0254', 'D0255', 'D0261', 'D0262', 'D0265', 'D0266', 'D0270', 'D0272', 'D0282', 'D0286', 'D0330', 'D0385', 'D0387', 'D0400', 'D0410', 'D0411', 'D0412', 'D0430', 'D0431', 'D0440', 'D0448', 'D0470', 'D0471', 'D0475', 'D0478'] }
    ]
  },

  total_payroll_expenses_act_sy: {
    id: 'total_payroll_expenses_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      // Note: Original spec excluded "Payroll Cost Allocation" but filter system doesn't support exclusion
      { type: 'acc_level', level: 9, value: 'Total Payroll' }
    ]
  },

  ta_commission_act_sy: {
    id: 'ta_commission_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_level', level: 15, value: 'TA Commissions' },
      { type: 'dept_level', level: 2, value: ['Lodging Operations'] }
    ]
  },

  rooms_expense_act_sy: {
    id: 'rooms_expense_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_level', level: 6, value: 'Total Expenses' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' }
    ]
  },

  rooms_sold_act_sy: {
    id: 'rooms_sold_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_level', level: 6, value: 'Rooms Sold' }
    ]
  },

  // Prior Year 1 (PY1) Scenario - Revenue
  total_revenue_act_py1: {
    id: 'total_revenue_act_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // Prior Year 1 (PY1) Scenario - Profit
  total_profit_act_py1: {
    id: 'total_profit_act_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // Same Year (SY) Scenario - NOI Components
  lodging_ops_ebitda_act_sy: {
    id: 'lodging_ops_ebitda_act_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'dept_level', level: 2, value: 'Lodging Operations' }
    ]
  },

  total_hotel_ebitda_act_sy: {
    id: 'total_hotel_ebitda_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_level', level: 1, value: 'NOI' },
      { type: 'dept_level', level: 2, value: 'NOI' }
    ]
  },

  replacement_reserve_act_sy: {
    id: 'replacement_reserve_act_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'acc_base', value: ['A701110', 'A701111', 'A759372'] },
      { type: 'dept_base', value: 'D0480' }
    ]
  },

  // F90 P&L - Rooms and Reservations Revenue
  rooms_reservations_revenue_act: {
    id: 'rooms_reservations_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  rooms_reservations_revenue_sy: {
    id: 'rooms_reservations_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  rooms_reservations_revenue_py1: {
    id: 'rooms_reservations_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Gift Shop Revenue
  gift_shop_revenue_act: {
    id: 'gift_shop_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Gift Shop' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  gift_shop_revenue_sy: {
    id: 'gift_shop_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Gift Shop' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  gift_shop_revenue_py1: {
    id: 'gift_shop_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Gift Shop' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Restaurants and Room Service Revenue
  restaurants_room_service_revenue_act: {
    id: 'restaurants_room_service_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Restaurants and Room Service' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  restaurants_room_service_revenue_sy: {
    id: 'restaurants_room_service_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Restaurants and Room Service' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  restaurants_room_service_revenue_py1: {
    id: 'restaurants_room_service_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Restaurants and Room Service' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Lounges Revenue
  lounges_revenue_act: {
    id: 'lounges_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Lounge' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  lounges_revenue_sy: {
    id: 'lounges_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Lounge' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  lounges_revenue_py1: {
    id: 'lounges_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Lounge' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Audio Visual Revenue
  audio_visual_revenue_act: {
    id: 'audio_visual_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Audio Visual' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  audio_visual_revenue_sy: {
    id: 'audio_visual_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Audio Visual' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  audio_visual_revenue_py1: {
    id: 'audio_visual_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Audio Visual' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Banquets Revenue
  banquets_revenue_act: {
    id: 'banquets_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Banquet' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  banquets_revenue_sy: {
    id: 'banquets_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Banquet' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  banquets_revenue_py1: {
    id: 'banquets_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Banquet' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Banquet Food Revenue (for excl-banqueting calculations)
  banq_food_rev_act: {
    id: 'banq_food_rev_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Banquet' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 9, value: 'Food Revenue' }
    ]
  },

  // F90 P&L - Banquet Beverage Revenue (for excl-banqueting calculations)
  banq_bev_rev_act: {
    id: 'banq_bev_rev_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Banquet' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 9, value: 'Beverage Revenue' }
    ]
  },

  // F90 P&L - Leisure & Recreation Revenue
  leisure_recreation_revenue_act: {
    id: 'leisure_recreation_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Recreation Center' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  leisure_recreation_revenue_sy: {
    id: 'leisure_recreation_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Recreation Center' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  leisure_recreation_revenue_py1: {
    id: 'leisure_recreation_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Recreation Center' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Golf Revenue
  golf_revenue_act: {
    id: 'golf_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Golf' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  golf_revenue_sy: {
    id: 'golf_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Golf' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  golf_revenue_py1: {
    id: 'golf_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Golf' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Spa Revenue
  spa_revenue_act: {
    id: 'spa_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Spa' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  spa_revenue_sy: {
    id: 'spa_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Spa' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  spa_revenue_py1: {
    id: 'spa_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Spa' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Casino Revenue
  casino_revenue_act: {
    id: 'casino_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Casino' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  casino_revenue_sy: {
    id: 'casino_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Casino' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  casino_revenue_py1: {
    id: 'casino_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Casino' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Miscellaneous Income Revenue
  misc_income_revenue_act: {
    id: 'misc_income_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  misc_income_revenue_sy: {
    id: 'misc_income_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  misc_income_revenue_py1: {
    id: 'misc_income_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Drycleaning Revenue
  drycleaning_revenue_act: {
    id: 'drycleaning_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Dry Cleaning' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  drycleaning_revenue_sy: {
    id: 'drycleaning_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Dry Cleaning' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  drycleaning_revenue_py1: {
    id: 'drycleaning_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Dry Cleaning' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Garage Revenue
  garage_revenue_act: {
    id: 'garage_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Garage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  garage_revenue_sy: {
    id: 'garage_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Garage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  garage_revenue_py1: {
    id: 'garage_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Garage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Guest Communications Revenue
  guest_communications_revenue_act: {
    id: 'guest_communications_revenue_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Guest Communications' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  guest_communications_revenue_sy: {
    id: 'guest_communications_revenue_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Guest Communications' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  guest_communications_revenue_py1: {
    id: 'guest_communications_revenue_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Guest Communications' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Total Other Departments Sales (Other Profit Departments + Dry Cleaning)
  total_other_dept_sales_act: {
    id: 'total_other_dept_sales_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: ['Other Operated Departments', 'Payroll Cost Allocation'] },
      { type: 'dept_level', level: 10, value: ['Other Profit Departments', 'Dry Cleaning'] },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  total_other_dept_sales_sy: {
    id: 'total_other_dept_sales_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: ['Other Operated Departments', 'Payroll Cost Allocation'] },
      { type: 'dept_level', level: 10, value: ['Other Profit Departments', 'Dry Cleaning'] },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  total_other_dept_sales_py1: {
    id: 'total_other_dept_sales_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: ['Other Operated Departments', 'Payroll Cost Allocation'] },
      { type: 'dept_level', level: 10, value: ['Other Profit Departments', 'Dry Cleaning'] },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Total Sales (Operating Departments)
  total_sales_act: {
    id: 'total_sales_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  total_sales_sy: {
    id: 'total_sales_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  total_sales_py1: {
    id: 'total_sales_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Revenue' }
    ]
  },

  // F90 P&L - Rooms and Reservations Profit
  rooms_reservations_profit_act: {
    id: 'rooms_reservations_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  rooms_reservations_profit_sy: {
    id: 'rooms_reservations_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  rooms_reservations_profit_py1: {
    id: 'rooms_reservations_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Gift Shop Profit
  gift_shop_profit_act: {
    id: 'gift_shop_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Gift Shop' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  gift_shop_profit_sy: {
    id: 'gift_shop_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Gift Shop' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  gift_shop_profit_py1: {
    id: 'gift_shop_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Gift Shop' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Restaurants and Room Service Profit
  restaurants_room_service_profit_act: {
    id: 'restaurants_room_service_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Restaurants and Room Service' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  restaurants_room_service_profit_sy: {
    id: 'restaurants_room_service_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Restaurants and Room Service' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  restaurants_room_service_profit_py1: {
    id: 'restaurants_room_service_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Restaurants and Room Service' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Lounges Profit
  lounges_profit_act: {
    id: 'lounges_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Lounge' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  lounges_profit_sy: {
    id: 'lounges_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Lounge' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  lounges_profit_py1: {
    id: 'lounges_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 11, value: 'Lounge' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Audio Visual Profit
  audio_visual_profit_act: {
    id: 'audio_visual_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Audio Visual' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  audio_visual_profit_sy: {
    id: 'audio_visual_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Audio Visual' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  audio_visual_profit_py1: {
    id: 'audio_visual_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Audio Visual' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Banquets Profit
  banquets_profit_act: {
    id: 'banquets_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Banquet' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  banquets_profit_sy: {
    id: 'banquets_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Banquet' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  banquets_profit_py1: {
    id: 'banquets_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 12, value: 'Banquet' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Food Cost (for % Food COS calculation)
  food_cost_act: {
    id: 'food_cost_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 12, value: 'Food Cost' }
    ]
  },

  food_cost_sy: {
    id: 'food_cost_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 12, value: 'Food Cost' }
    ]
  },

  food_cost_py1: {
    id: 'food_cost_py1',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 12, value: 'Food Cost' }
    ]
  },

  // F90 P&L - Food Revenue (for % Food COS calculation)
  food_rev_act: {
    id: 'food_rev_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 9, value: 'Food Revenue' }
    ]
  },

  food_rev_sy: {
    id: 'food_rev_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 9, value: 'Food Revenue' }
    ]
  },

  food_rev_py1: {
    id: 'food_rev_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 9, value: 'Food Revenue' }
    ]
  },

  // F90 P&L - Beverage Cost (for % Beverage COS calculation)
  bev_cost_act: {
    id: 'bev_cost_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 12, value: 'Beverage Cost' }
    ]
  },

  bev_cost_sy: {
    id: 'bev_cost_sy',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 12, value: 'Beverage Cost' }
    ]
  },

  bev_cost_py1: {
    id: 'bev_cost_py1',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 12, value: 'Beverage Cost' }
    ]
  },

  // F90 P&L - Beverage Revenue (for % Beverage COS calculation)
  bev_rev_act: {
    id: 'bev_rev_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 9, value: 'Beverage Revenue' }
    ]
  },

  bev_rev_sy: {
    id: 'bev_rev_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 9, value: 'Beverage Revenue' }
    ]
  },

  bev_rev_py1: {
    id: 'bev_rev_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 9, value: 'Beverage Revenue' }
    ]
  },

  // F90 P&L - Total F&B Profit
  total_fb_profit_act: {
    id: 'total_fb_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 5, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  total_fb_profit_sy: {
    id: 'total_fb_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 5, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  total_fb_profit_py1: {
    id: 'total_fb_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 5, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Leisure & Recreation Profit
  leisure_recreation_profit_act: {
    id: 'leisure_recreation_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Recreation Center' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  leisure_recreation_profit_sy: {
    id: 'leisure_recreation_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Recreation Center' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  leisure_recreation_profit_py1: {
    id: 'leisure_recreation_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Recreation Center' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Golf Profit
  golf_profit_act: {
    id: 'golf_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Golf' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  golf_profit_sy: {
    id: 'golf_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Golf' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  golf_profit_py1: {
    id: 'golf_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Golf' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Spa Profit
  spa_profit_act: {
    id: 'spa_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Spa' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  spa_profit_sy: {
    id: 'spa_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Spa' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  spa_profit_py1: {
    id: 'spa_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Spa' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Casino Profit
  casino_profit_act: {
    id: 'casino_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Casino' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  casino_profit_sy: {
    id: 'casino_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Casino' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  casino_profit_py1: {
    id: 'casino_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Casino' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Miscellaneous Income Profit
  misc_income_profit_act: {
    id: 'misc_income_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  misc_income_profit_sy: {
    id: 'misc_income_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  misc_income_profit_py1: {
    id: 'misc_income_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Drycleaning Profit (In House)
  drycleaning_profit_act: {
    id: 'drycleaning_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Dry Cleaning' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  drycleaning_profit_sy: {
    id: 'drycleaning_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Dry Cleaning' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  drycleaning_profit_py1: {
    id: 'drycleaning_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Dry Cleaning' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Garage Profit
  garage_profit_act: {
    id: 'garage_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Garage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  garage_profit_sy: {
    id: 'garage_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Garage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  garage_profit_py1: {
    id: 'garage_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 12, value: 'Garage' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Guest Communications Profit
  guest_communications_profit_act: {
    id: 'guest_communications_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'dept_level', level: 12, value: 'Guest Communications' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  guest_communications_profit_sy: {
    id: 'guest_communications_profit_sy',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'dept_level', level: 12, value: 'Guest Communications' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  guest_communications_profit_py1: {
    id: 'guest_communications_profit_py1',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: 'Other Operated Departments' },
      { type: 'dept_level', level: 10, value: 'Miscellaneous Income' },
      { type: 'dept_level', level: 12, value: 'Guest Communications' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Total Other Departments Profit (Other Profit Departments + Dry Cleaning)
  total_other_dept_profit_act: {
    id: 'total_other_dept_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'dept_level', level: 7, value: ['Other Operated Departments', 'Payroll Cost Allocation'] },
      { type: 'dept_level', level: 10, value: ['Other Profit Departments', 'Dry Cleaning'] },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Total Department Profit
  total_dept_profit_act: {
    id: 'total_dept_profit_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Operating Departments' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' }
    ]
  },

  // F90 P&L - Administrative and General Expense
  admin_general_expense_act: {
    id: 'admin_general_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_base', value: 'D0410' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Human Resources Expense
  human_resources_expense_act: {
    id: 'human_resources_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_base', value: 'D0411' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Loss Prevention Expense
  loss_prevention_expense_act: {
    id: 'loss_prevention_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_base', value: 'D0412' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Accounting Expense
  accounting_expense_act: {
    id: 'accounting_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_level', level: 10, value: 'Accounting' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Administrative & General Expense (Dept Level 7)
  admin_general_dept_expense_act: {
    id: 'admin_general_dept_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_level', level: 7, value: 'Administrative & General' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Information & Telecom Systems Expense
  info_telecom_systems_expense_act: {
    id: 'info_telecom_systems_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_level', level: 7, value: 'Information & Telecom Systems' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Utilities Expense
  utilities_expense_act: {
    id: 'utilities_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_level', level: 7, value: 'Utilities Dept' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Property Operation & Maintenance Expense
  property_operation_maint_expense_act: {
    id: 'property_operation_maint_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_level', level: 7, value: 'Property Operation & Maintenance' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Sales & Marketing Expense
  sales_marketing_expense_act: {
    id: 'sales_marketing_expense_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'dept_level', level: 7, value: 'Sales & Marketing and Convention Service' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Total Undistributed Operating Expenses
  total_undist_op_exp_act: {
    id: 'total_undist_op_exp_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 2, value: 'Lodging Operations' },
      { type: 'dept_level', level: 4, value: 'Undistributed Operating Expenses' },
      { type: 'acc_level', level: 1, value: 'EBITDA' },
      { type: 'acc_level', level: 6, value: 'Total Expenses' }
    ]
  },

  // F90 P&L - Base Management Fee
  base_mgmt_fee_act: {
    id: 'base_mgmt_fee_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 10, value: 'Invest Factor NonOp' },
      { type: 'acc_base', value: ['A701120', 'A701121'] }
    ]
  },

  // F90 P&L - Incentive Management Fee
  // Note: accounts 701125/701126 are on department D0490, which has a different
  // level_10 value than D0480 ('Invest Factor NonOp'). Use dept_base to target directly.
  incentive_mgmt_fee_act: {
    id: 'incentive_mgmt_fee_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0490' },
      { type: 'acc_base', value: ['A701125', 'A701126'] }
    ]
  },

  // F90 P&L - EBITDA
  ebitda_act: {
    id: 'ebitda_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'acc_level', level: 1, value: 'EBITDA' }
    ]
  },

  // F90 P&L - Net Due To/(From) Owner
  net_due_owner_act: {
    id: 'net_due_owner_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_level', level: 10, value: 'Invest Factor NonOp' },
      { type: 'acc_base', value: ['A700304', 'A701601', 'A701602', 'A701603'] }
    ]
  },

  // ============================================================================
  // F90 KPI Sub-Measures — Detailed management fees, non-op, owner, depreciation
  // ============================================================================

  // Base Management Fee (D0480 - Lease Expenses / Base Fees)
  f90_base_mgmt_fee_act: {
    id: 'f90_base_mgmt_fee_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0480' },
      { type: 'acc_level', level: 13, value: 'Managed Fees' },
      { type: 'acc_level', level: 14, value: 'Lease Expenses' },
      { type: 'acc_level', level: 15, value: 'Base Fees' }
    ]
  },

  // Base Royalty Fee (D0490 - Lease Expenses / Incentive Fees)
  f90_base_royalty_fee_act: {
    id: 'f90_base_royalty_fee_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0490' },
      { type: 'acc_level', level: 13, value: 'Managed Fees' },
      { type: 'acc_level', level: 14, value: 'Lease Expenses' },
      { type: 'acc_level', level: 15, value: 'Incentive Fees' }
    ]
  },

  // Incentive Fee (D0480 - Royalty Costs / Base Fees)
  f90_incentive_fee_act: {
    id: 'f90_incentive_fee_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0480' },
      { type: 'acc_level', level: 13, value: 'Managed Fees' },
      { type: 'acc_level', level: 14, value: 'Royalty Costs' },
      { type: 'acc_level', level: 15, value: 'Base Fees' }
    ]
  },

  // D0480 All Accounts (for exclusion-based NON-OP calculation)
  f90_d0480_all_act: {
    id: 'f90_d0480_all_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0480' },
      { type: 'acc_level', level: 1, value: 'EBITDA' }
    ]
  },

  // D0490 All Accounts (for exclusion-based OWNER EXPENSE calculation)
  f90_d0490_all_act: {
    id: 'f90_d0490_all_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0490' },
      { type: 'acc_level', level: 1, value: 'EBITDA' }
    ]
  },

  // Replacement Reserve — D0480, A701110 only
  f90_replacement_reserve_act: {
    id: 'f90_replacement_reserve_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0480' },
      { type: 'acc_base', value: 'A701110' }
    ]
  },

  // D0690 All Accounts — Owner Depreciation & Amortization
  f90_d0690_all_act: {
    id: 'f90_d0690_all_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0690' },
      { type: 'acc_level', level: 1, value: 'EBITDA' }
    ]
  },

  // D0691 All Accounts — Owner Interest & Income Tax
  f90_d0691_all_act: {
    id: 'f90_d0691_all_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0691' },
      { type: 'acc_level', level: 1, value: 'EBITDA' }
    ]
  },

  // ============================================================================
  // LEVEL 20 — INVEST FACTOR OWNER SUBGROUP SUB-MEASURES
  // Each subgroup is a single filter across all 4 owner departments.
  // Replaces the old prefix/overlap/extra account pattern.
  // ============================================================================

  // Fixed Expenses (debit-balance: stored positive, no negate)
  f90_fixed_expenses_l20_act: {
    id: 'f90_fixed_expenses_l20_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_base', value: ['D0480', 'D0490', 'D0690', 'D0691'] },
      { type: 'acc_level', level: 20, value: 'Fixed Expenses' }
    ]
  },

  // Depreciation
  f90_depreciation_l20_act: {
    id: 'f90_depreciation_l20_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: ['D0480', 'D0490', 'D0690', 'D0691'] },
      { type: 'acc_level', level: 20, value: 'Depreciation' }
    ]
  },

  // Owner Expense
  f90_owner_expense_l20_act: {
    id: 'f90_owner_expense_l20_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: ['D0480', 'D0490', 'D0690', 'D0691'] },
      { type: 'acc_level', level: 20, value: 'Owner Expense' }
    ]
  },

  // Interest
  f90_interest_l20_act: {
    id: 'f90_interest_l20_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: ['D0480', 'D0490', 'D0690', 'D0691'] },
      { type: 'acc_level', level: 20, value: 'Interest' }
    ]
  },

  // Refurbishment Fund
  f90_refurbishment_fund_l20_act: {
    id: 'f90_refurbishment_fund_l20_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: ['D0480', 'D0490', 'D0690', 'D0691'] },
      { type: 'acc_level', level: 20, value: 'Refurbishment Fund' }
    ]
  },

  // Tax
  f90_tax_l20_act: {
    id: 'f90_tax_l20_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: ['D0480', 'D0490', 'D0690', 'D0691'] },
      { type: 'acc_level', level: 20, value: 'Tax' }
    ]
  },

  // Deferred Tax
  f90_deferred_tax_l20_act: {
    id: 'f90_deferred_tax_l20_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: ['D0480', 'D0490', 'D0690', 'D0691'] },
      { type: 'acc_level', level: 20, value: 'Deferred Tax' }
    ]
  },

  // Dividends
  f90_dividends_l20_act: {
    id: 'f90_dividends_l20_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: ['D0480', 'D0490', 'D0690', 'D0691'] },
      { type: 'acc_level', level: 20, value: 'Dividends' }
    ]
  },

  // Abnormal Items atom — MUST match INVEST FACTOR OWNER SUMMARY's catch-all
  // behaviour in proteaShared.ts::classifyAccountsByLevel20. Catches both
  // level_20='Abnormal Items' AND any owner-dept account with an unmapped /
  // unrecognised level_20 value (including NULL). KNOWN_LEVEL_20_VALUES is
  // imported from investSubgroupConfig.ts so this filter stays in lock-step
  // with the INVEST classifier — editing either requires editing both files.
  f90_abnormal_items_l20_act: {
    id: 'f90_abnormal_items_l20_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: OWNER_DEPARTMENTS },
      { type: 'acc_level_not_in', level: 20, value: KNOWN_LEVEL_20_VALUES }
    ]
  },

  // ============================================================================
  // PROTEA ACCOUNT MOVEMENT — A730/A745 insurance/audit sub-measures per dept
  // Used by applyProteaAccountMovement() to shift costs into Admin & General
  // ============================================================================

  protea_moved_accounts_d0480_act: {
    id: 'protea_moved_accounts_d0480_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0480' },
      { type: 'acc_prefix', value: ['A730', 'A745'] }
    ]
  },

  protea_moved_accounts_d0490_act: {
    id: 'protea_moved_accounts_d0490_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0490' },
      { type: 'acc_prefix', value: ['A730', 'A745'] }
    ]
  },

  protea_moved_accounts_d0690_act: {
    id: 'protea_moved_accounts_d0690_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0690' },
      { type: 'acc_prefix', value: ['A730', 'A745'] }
    ]
  },

  protea_moved_accounts_d0691_act: {
    id: 'protea_moved_accounts_d0691_act',
    formula: 'CALCULATE',
    negate: true,
    filters: [
      { type: 'dept_base', value: 'D0691' },
      { type: 'acc_prefix', value: ['A730', 'A745'] }
    ]
  },

  // ==========================================================================
  // ROOMS & RESERVATION SUMMARY KPIs — sub-measures
  //
  // Conventions:
  //  - Stats accounts (A960xxx) and the canonical Rooms Revenue measure
  //    (rooms_reservations_revenue_act, defined earlier) are NOT touched by
  //    any Protea movement, so values match in Protea and non-Protea reports.
  //  - "_protea" variants only exist for sub-totals that diverge between
  //    report families (Payroll / Controllables) due to category repoints in
  //    PROTEA_CATEGORY_REPOINTS (proteaMovements.ts).
  // ==========================================================================

  // Bed Nights Sold (A960005) — Rooms scope
  bed_nights_sold_act: {
    id: 'bed_nights_sold_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 10, value: 'Rooms' },
      { type: 'acc_base', value: 'A960005' }
    ]
  },

  // Bed Nights Available (A960004) — Rooms scope
  bed_nights_avail_act: {
    id: 'bed_nights_avail_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 10, value: 'Rooms' },
      { type: 'acc_base', value: 'A960004' }
    ]
  },

  // Travel Agent Commission (A608201) — Rooms scope, isolated for RevPAR after TAC
  rooms_tac_act: {
    id: 'rooms_tac_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 10, value: 'Rooms' },
      { type: 'acc_base', value: 'A608201' }
    ]
  },

  // Rooms-scope Total Payroll (canonical hierarchy — does NOT include the
  // Protea-repointed accounts; see PROTEA_PAYROLL_REPOINT_ACCOUNTS below).
  total_rooms_payroll_act: {
    id: 'total_rooms_payroll_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 9, value: 'Total Payroll' }
    ]
  },

  // Rooms-scope Controllables (canonical hierarchy). Mirrors the
  // STANDARD_CATEGORY_CASE in local_db.ts: any expense (level_4 = 'Profit
  // Amount', level_6 != 'Revenue') that is NOT Payroll and NOT Cost of Sales.
  total_rooms_controllables_act: {
    id: 'total_rooms_controllables_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' },
      { type: 'acc_level_not_in', level: 6, value: ['Revenue'] },
      { type: 'acc_level_not_in', level: 9, value: ['Total Payroll', 'Cost Of Sales'] }
    ]
  },

  // Protea movement bucket — ONLY the accounts Protea repoints into Payroll.
  // Account list is sourced from PROTEA_CATEGORY_REPOINTS (proteaMovements.ts);
  // adding entries there cascades automatically into the _protea totals below.
  rooms_payroll_movement_act: {
    id: 'rooms_payroll_movement_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Rooms and Reservation' },
      { type: 'acc_base', value: PROTEA_PAYROLL_REPOINT_ACCOUNTS }
    ]
  },

  // ==========================================================================
  // ROOMS — Per-account expense buckets used by the "Per Room Night
  // Sold" and "Operating Equipment Usage" KPI groups.
  //
  // Scoping note:
  //   - Numerators (these expense accounts) are scoped to dept_level 7 =
  //     'Rooms and Reservation' so they reflect the report's Rooms group.
  //   - The denominator for cents-per-room is sold_rooms_act (above), which
  //     uses dept_level 10 = 'Rooms' — this is the hotel-Rooms sold-rooms
  //     statistic, intentionally NOT pinned to a specific department, so the
  //     ratio is meaningful regardless of which Rooms-group rendering scope
  //     the report is in.
  // ==========================================================================
  rooms_flatware_act:            { id: 'rooms_flatware_act',            formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A610102' }] },
  rooms_linen_act:               { id: 'rooms_linen_act',               formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A610105' }] },
  rooms_glassware_act:           { id: 'rooms_glassware_act',           formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A610402' }] },
  rooms_smalls_act:              { id: 'rooms_smalls_act',              formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A610125' }] },
  rooms_cleaning_supplies_act:   { id: 'rooms_cleaning_supplies_act',   formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A610106' }] },
  rooms_guest_supplies_act:      { id: 'rooms_guest_supplies_act',      formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A610201' }] },
  rooms_paper_supplies_act:      { id: 'rooms_paper_supplies_act',      formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A610104' }] },
  rooms_printing_stationery_act: { id: 'rooms_printing_stationery_act', formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A606101' }] },
  rooms_laundry_act:             { id: 'rooms_laundry_act',             formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Rooms and Reservation' }, { type: 'acc_base', value: 'A602406' }] },

  // ==========================================================================
  // F&B — Covers & Average Food Spend (per-meal customer counts and revenue)
  //
  // Scoping rules (per spec):
  //   - Per-meal Customers/Revenue (Breakfast/Lunch/Dinner) cover ALL F&B
  //     departments EXCLUDING the banqueting depts. Implemented via
  //     dept_level 7 = 'Total Food & Beverage' AND dept_base_not_in
  //     [BANQ_DEPTS]. Banqueting depts come from departmentScopes.ts.
  //   - Banqueting Customer / Banqueting Revenue cover ONLY the banqueting
  //     depts. Implemented via dept_base = [BANQ_DEPTS]. Account scope is
  //     "all 914 / all 314" via acc_prefix.
  //   - Revenue accounts (3xxxxx) carry credit balances → negate:true so
  //     the engine returns positive display values, matching existing
  //     total_fb_revenue_act et al.
  // ==========================================================================
  fb_nonbanq_breakfast_customers_act: { id: 'fb_nonbanq_breakfast_customers_act', formula: 'CALCULATE',
    filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'dept_base_not_in', value: BANQ_DEPTS }, { type: 'acc_base', value: 'A914011' }] },
  fb_nonbanq_lunch_customers_act:     { id: 'fb_nonbanq_lunch_customers_act',     formula: 'CALCULATE',
    filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'dept_base_not_in', value: BANQ_DEPTS }, { type: 'acc_base', value: 'A914012' }] },
  fb_nonbanq_dinner_customers_act:    { id: 'fb_nonbanq_dinner_customers_act',    formula: 'CALCULATE',
    filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'dept_base_not_in', value: BANQ_DEPTS }, { type: 'acc_base', value: 'A914013' }] },
  fb_nonbanq_late_snack_customers_act: { id: 'fb_nonbanq_late_snack_customers_act', formula: 'CALCULATE',
    filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'dept_base_not_in', value: BANQ_DEPTS }, { type: 'acc_base', value: 'A914014' }] },

  fb_nonbanq_breakfast_revenue_act: { id: 'fb_nonbanq_breakfast_revenue_act', formula: 'CALCULATE', negate: true,
    filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'dept_base_not_in', value: BANQ_DEPTS }, { type: 'acc_base', value: 'A314011' }] },
  fb_nonbanq_lunch_revenue_act:     { id: 'fb_nonbanq_lunch_revenue_act',     formula: 'CALCULATE', negate: true,
    filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'dept_base_not_in', value: BANQ_DEPTS }, { type: 'acc_base', value: 'A314012' }] },
  fb_nonbanq_dinner_revenue_act:    { id: 'fb_nonbanq_dinner_revenue_act',    formula: 'CALCULATE', negate: true,
    filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'dept_base_not_in', value: BANQ_DEPTS }, { type: 'acc_base', value: 'A314013' }] },
  // Late Snack revenue numerator is a SUM of A314014 (Late Snack) + A314017
  // (Coffee Break) — combined per business request since Coffee Break has
  // no dedicated customer-count account and is grouped with Late Snack
  // operationally. Customer denominator stays A914014 alone (see
  // fb_nonbanq_late_snack_customers_act).
  //
  // Scope follows the same non-banqueting filter as the other meal revenue
  // sub-measures above. If Avg Late Snack Spend renders as 0 when customers
  // > 0, that's a data-alignment signal: revenue is being posted into a
  // banqueting dept (commonly D0231 / D0233) while customer counts post in
  // non-banqueting depts. Fix the postings, not this filter.
  fb_nonbanq_late_snack_revenue_act: { id: 'fb_nonbanq_late_snack_revenue_act', formula: 'CALCULATE', negate: true,
    filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'dept_base_not_in', value: BANQ_DEPTS }, { type: 'acc_base', value: ['A314014', 'A314017'] }] },

  banq_customers_act: { id: 'banq_customers_act', formula: 'CALCULATE',
    filters: [{ type: 'dept_base', value: BANQ_DEPTS }, { type: 'acc_prefix', value: 'A9140' }] },
  banq_revenue_act:   { id: 'banq_revenue_act',   formula: 'CALCULATE', negate: true,
    filters: [{ type: 'dept_base', value: BANQ_DEPTS }, { type: 'acc_prefix', value: 'A314' }] },

  // ==========================================================================
  // F&B — Cost Per Cover, Operating Equipment Usage, % of F&B Sales
  //
  // Numerator scoping: dept_level 7 = 'Total Food & Beverage' so values
  // aggregate every F&B sub-department (kitchen, restaurants, banqueting,
  // etc.) — matches the F&B group summary's rendering scope.
  //
  // Denominator scoping:
  //   - Cost Per Cover divides by fb_total_covers_act (all A914xxx in
  //     F&B, INCLUDING banqueting per spec — different from the per-meal
  //     Average Food Spend KPIs above which split banqueting out).
  //   - % of F&B Sales divides by total_fb_revenue_act (existing measure).
  //
  // Protea note: a movement sub-measure scoped to F&B is included so the
  // _protea variants of payroll/controllables stay correct if the
  // PROTEA_CATEGORY_REPOINTS accounts (currently A610112, A652101) ever
  // post into F&B departments. Today they may not, in which case the
  // movement evaluates to 0 and _protea matches canonical — safe.
  // ==========================================================================

  // Per-account F&B atoms (used by Cost Per Cover and Op Equipment Usage)
  fb_flatware_act:               { id: 'fb_flatware_act',               formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A610102' }] },
  fb_china_act:                  { id: 'fb_china_act',                  formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A610100' }] },
  fb_kitchen_utensils_act:       { id: 'fb_kitchen_utensils_act',       formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A635150' }] },
  fb_linen_act:                  { id: 'fb_linen_act',                  formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A610105' }] },
  fb_glassware_act:              { id: 'fb_glassware_act',              formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A610402' }] },
  fb_smalls_act:                 { id: 'fb_smalls_act',                 formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A610125' }] },
  fb_cleaning_supplies_act:      { id: 'fb_cleaning_supplies_act',      formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A610106' }] },
  fb_guest_supplies_act:         { id: 'fb_guest_supplies_act',         formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A610201' }] },
  fb_paper_supplies_act:         { id: 'fb_paper_supplies_act',         formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A610104' }] },
  fb_printing_stationery_act:    { id: 'fb_printing_stationery_act',    formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A606101' }] },
  fb_laundry_act:                { id: 'fb_laundry_act',                formula: 'CALCULATE', filters: [{ type: 'dept_level', level: 7, value: 'Total Food & Beverage' }, { type: 'acc_base', value: 'A602406' }] },

  // Cost Per Cover denominator: every A914xxx customer-count account in F&B
  // (banqueting depts INCLUDED per spec — total covers across all F&B).
  fb_total_covers_act: {
    id: 'fb_total_covers_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_prefix', value: 'A914' }
    ]
  },

  // F&B-scope Total Payroll (canonical hierarchy, mirrors total_rooms_payroll_act).
  total_fb_payroll_act: {
    id: 'total_fb_payroll_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 9, value: 'Total Payroll' }
    ]
  },

  // F&B-scope Controllables (canonical hierarchy, mirrors
  // total_rooms_controllables_act — same residual definition: expense
  // amount, not Revenue, not Payroll, not COS).
  total_fb_controllables_act: {
    id: 'total_fb_controllables_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_level', level: 4, value: 'Profit Amount' },
      { type: 'acc_level_not_in', level: 6, value: ['Revenue'] },
      { type: 'acc_level_not_in', level: 9, value: ['Total Payroll', 'Cost Of Sales'] }
    ]
  },

  // F&B-scope movement bucket — same repoint list as Rooms; sourced from
  // PROTEA_CATEGORY_REPOINTS so adding accounts there cascades automatically.
  fb_payroll_movement_act: {
    id: 'fb_payroll_movement_act',
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: 'Total Food & Beverage' },
      { type: 'acc_base', value: PROTEA_PAYROLL_REPOINT_ACCOUNTS }
    ]
  }
};

// ============================================================================
// MEASURE DEFINITIONS
// Final calculations that combine sub-measures with formulas
// ============================================================================

function evaluateDivide(numerator: number, denominator: number, defaultValue: number = 0): number {
  if (denominator === 0) return defaultValue;
  return numerator / denominator;
}

export const MEASURES: Record<string, Measure> = {
  // Key Metrics
  occupancy_rooms: {
    id: 'occupancy_rooms',
    type: 'calculated',
    subMeasures: ['sold_rooms_act', 'total_rooms_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.sold_rooms_act || 0,
        ctx.subMeasures.total_rooms_act || 0,
        0
      ) * 100;
    }
  },

  adr: {
    id: 'adr',
    type: 'calculated',
    subMeasures: ['total_rooms_revenue_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_rooms_revenue_act || 0,
        ctx.subMeasures.sold_rooms_act || 0,
        0
      );
    }
  },

  rev_par: {
    id: 'rev_par',
    type: 'calculated',
    subMeasures: ['total_rooms_revenue_act', 'total_rooms_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_rooms_revenue_act || 0,
        ctx.subMeasures.total_rooms_act || 0,
        0
      );
    }
  },

  adr_act_sy: {
    id: 'adr_act_sy',
    type: 'calculated',
    subMeasures: ['total_rooms_revenue_act_sy', 'sold_rooms_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_rooms_revenue_act_sy || 0,
        ctx.subMeasures.sold_rooms_act_sy || 0,
        0
      );
    }
  },

  rev_par_act_sy: {
    id: 'rev_par_act_sy',
    type: 'calculated',
    subMeasures: ['total_rooms_revenue_act_sy', 'total_rooms_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_rooms_revenue_act_sy || 0,
        ctx.subMeasures.total_rooms_act_sy || 0,
        0
      );
    }
  },

  occupancy_rooms_act_sy: {
    id: 'occupancy_rooms_act_sy',
    type: 'calculated',
    subMeasures: ['sold_rooms_act_sy', 'total_rooms_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.sold_rooms_act_sy || 0,
        ctx.subMeasures.total_rooms_act_sy || 0,
        0
      ) * 100;
    }
  },

  all_rev_par_act_sy: {
    id: 'all_rev_par_act_sy',
    type: 'calculated',
    subMeasures: ['total_revenue_act_sy', 'total_rooms_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_revenue_act_sy || 0,
        ctx.subMeasures.total_rooms_act_sy || 0,
        0
      );
    }
  },

  total_revenue_act_sy: {
    id: 'total_revenue_act_sy',
    type: 'simple',
    subMeasures: ['total_revenue_act_sy']
  },

  total_profit_act_sy: {
    id: 'total_profit_act_sy',
    type: 'simple',
    subMeasures: ['total_profit_act_sy']
  },

  total_profit_pct_revenue_sy: {
    id: 'total_profit_pct_revenue_sy',
    type: 'calculated',
    subMeasures: ['total_profit_act_sy', 'total_revenue_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_profit_act_sy || 0,
        ctx.subMeasures.total_revenue_act_sy || 0,
        0
      ) * 100;
    }
  },

  flow_thru_act_sy: {
    id: 'flow_thru_act_sy',
    type: 'calculated',
    subMeasures: ['total_revenue_act_sy', 'total_revenue_act_py1', 'total_profit_act_sy', 'total_profit_act_py1'],
    evaluator: (ctx: MeasureContext) => {
      const revChange = (ctx.subMeasures.total_revenue_act_sy || 0) - (ctx.subMeasures.total_revenue_act_py1 || 0);
      const profitChange = (ctx.subMeasures.total_profit_act_sy || 0) - (ctx.subMeasures.total_profit_act_py1 || 0);
      const ratio = evaluateDivide(profitChange, revChange, 0);

      // SWITCH logic from DAX formula
      if (revChange === 0) return 0; // BLANK() -> 0
      if (revChange > 0) return ratio * 100;
      if (profitChange < 0) return (1 - ratio) * 100;
      return Math.abs(1 - ratio) * 100;
    }
  },

  noi_act_sy: {
    id: 'noi_act_sy',
    type: 'calculated',
    subMeasures: ['lodging_ops_ebitda_act_sy', 'total_hotel_ebitda_act_sy', 'replacement_reserve_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      const lodging = ctx.subMeasures.lodging_ops_ebitda_act_sy || 0;
      const hotel = ctx.subMeasures.total_hotel_ebitda_act_sy || 0;
      const reserve = ctx.subMeasures.replacement_reserve_act_sy || 0;
      return lodging + hotel - reserve;
    }
  },

  total_rooms_revenue_act_sy_measure: {
    id: 'total_rooms_revenue_act_sy_measure',
    type: 'simple',
    subMeasures: ['total_rooms_revenue_act_sy']
  },

  rooms_dept_profit_act_sy_measure: {
    id: 'rooms_dept_profit_act_sy_measure',
    type: 'simple',
    subMeasures: ['rooms_dept_profit_act_sy']
  },

  rooms_dept_profit_pct_revenue_act_sy: {
    id: 'rooms_dept_profit_pct_revenue_act_sy',
    type: 'calculated',
    subMeasures: ['rooms_dept_profit_act_sy', 'total_rooms_revenue_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.rooms_dept_profit_act_sy || 0,
        ctx.subMeasures.total_rooms_revenue_act_sy || 0,
        0
      ) * 100;
    }
  },

  total_fb_revenue_act_sy_measure: {
    id: 'total_fb_revenue_act_sy_measure',
    type: 'simple',
    subMeasures: ['total_fb_revenue_act_sy']
  },

  fb_profit_sy: {
    id: 'fb_profit_sy',
    type: 'simple',
    subMeasures: ['fb_profit_act_sy']
  },

  fb_profit_pct_revenue_act_sy: {
    id: 'fb_profit_pct_revenue_act_sy',
    type: 'calculated',
    subMeasures: ['fb_profit_act_sy', 'total_fb_revenue_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.fb_profit_act_sy || 0,
        ctx.subMeasures.total_fb_revenue_act_sy || 0,
        0
      ) * 100;
    }
  },

  other_revenue_act_sy_measure: {
    id: 'other_revenue_act_sy_measure',
    type: 'simple',
    subMeasures: ['other_revenue_act_sy']
  },

  other_profit_act_sy_measure: {
    id: 'other_profit_act_sy_measure',
    type: 'simple',
    subMeasures: ['other_profit_act_sy']
  },

  other_profit_pct_revenue_act_sy: {
    id: 'other_profit_pct_revenue_act_sy',
    type: 'calculated',
    subMeasures: ['other_profit_act_sy', 'other_revenue_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.other_profit_act_sy || 0,
        ctx.subMeasures.other_revenue_act_sy || 0,
        0
      ) * 100;
    }
  },

  dep_profit_act_sy: {
    id: 'dep_profit_act_sy',
    type: 'calculated',
    subMeasures: ['rooms_dept_profit_act_sy', 'fb_profit_act_sy', 'other_profit_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      const rooms = ctx.subMeasures.rooms_dept_profit_act_sy || 0;
      const fb = ctx.subMeasures.fb_profit_act_sy || 0;
      const other = ctx.subMeasures.other_profit_act_sy || 0;
      return rooms + fb + other;
    }
  },

  dep_profit_pct_revenue_act_sy: {
    id: 'dep_profit_pct_revenue_act_sy',
    type: 'calculated',
    subMeasures: ['dep_profit_act_sy', 'total_rooms_revenue_act_sy', 'total_fb_revenue_act_sy', 'other_revenue_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      const profit = ctx.subMeasures.dep_profit_act_sy || 0;
      const roomsRev = ctx.subMeasures.total_rooms_revenue_act_sy || 0;
      const fbRev = ctx.subMeasures.total_fb_revenue_act_sy || 0;
      const otherRev = ctx.subMeasures.other_revenue_act_sy || 0;
      const totalDepRevenue = roomsRev + fbRev + otherRev;
      return evaluateDivide(profit, totalDepRevenue, 0) * 100;
    }
  },

  admin_wo_cc_act_sy: {
    id: 'admin_wo_cc_act_sy',
    type: 'calculated',
    subMeasures: ['admin_act_sy', 'cc_expense_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      const admin = ctx.subMeasures.admin_act_sy || 0;
      const cc = ctx.subMeasures.cc_expense_act_sy || 0;
      return admin - cc;
    }
  },

  cc_expense_act_sy_measure: {
    id: 'cc_expense_act_sy_measure',
    type: 'simple',
    subMeasures: ['cc_expense_act_sy']
  },

  it_and_telecom_act_sy_measure: {
    id: 'it_and_telecom_act_sy_measure',
    type: 'simple',
    subMeasures: ['it_and_telecom_act_sy']
  },

  utilities_act_sy_measure: {
    id: 'utilities_act_sy_measure',
    type: 'simple',
    subMeasures: ['utilities_act_sy']
  },

  pom_act_sy_measure: {
    id: 'pom_act_sy_measure',
    type: 'simple',
    subMeasures: ['pom_act_sy']
  },

  sales_act_sy_measure: {
    id: 'sales_act_sy_measure',
    type: 'simple',
    subMeasures: ['sales_act_sy']
  },

  other_uoe_act_sy_measure: {
    id: 'other_uoe_act_sy_measure',
    type: 'simple',
    subMeasures: ['other_uoe_act_sy']
  },

  total_uoe_act_sy: {
    id: 'total_uoe_act_sy',
    type: 'calculated',
    subMeasures: ['admin_act_sy', 'it_and_telecom_act_sy', 'utilities_act_sy', 'pom_act_sy', 'sales_act_sy', 'other_uoe_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      const admin = ctx.subMeasures.admin_act_sy || 0;
      const it = ctx.subMeasures.it_and_telecom_act_sy || 0;
      const utilities = ctx.subMeasures.utilities_act_sy || 0;
      const pom = ctx.subMeasures.pom_act_sy || 0;
      const sales = ctx.subMeasures.sales_act_sy || 0;
      const otherUoe = ctx.subMeasures.other_uoe_act_sy || 0;
      return admin + it + utilities + pom + sales + otherUoe;
    }
  },

  total_payroll_act_sy_measure: {
    id: 'total_payroll_act_sy_measure',
    type: 'simple',
    subMeasures: ['total_payroll_act_sy']
  },

  payroll_pct_revenue_act_sy: {
    id: 'payroll_pct_revenue_act_sy',
    type: 'calculated',
    subMeasures: ['total_payroll_expenses_act_sy', 'total_revenue_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_payroll_expenses_act_sy || 0,
        ctx.subMeasures.total_revenue_act_sy || 0,
        0
      ) * 100;
    }
  },

  ta_commission_act_sy_measure: {
    id: 'ta_commission_act_sy_measure',
    type: 'simple',
    subMeasures: ['ta_commission_act_sy']
  },

  cpsr_act: {
    id: 'cpsr_act',
    type: 'calculated',
    subMeasures: ['rooms_expense_act_sy', 'rooms_sold_act_sy'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.rooms_expense_act_sy || 0,
        ctx.subMeasures.rooms_sold_act_sy || 0,
        0
      );
    }
  },

  // Revenue
  total_revenue: {
    id: 'total_revenue',
    type: 'simple',
    subMeasures: ['total_revenue_act']
  },

  rooms_revenue: {
    id: 'rooms_revenue',
    type: 'simple',
    subMeasures: ['total_rooms_revenue_act']
  },

  fb_revenue: {
    id: 'fb_revenue',
    type: 'simple',
    subMeasures: ['total_fb_revenue_act']
  },

  // Profit
  gross_operating_profit: {
    id: 'gross_operating_profit',
    type: 'simple',
    subMeasures: ['total_profit_act']
  },

  gross_operating_profit_margin: {
    id: 'gross_operating_profit_margin',
    type: 'calculated',
    subMeasures: ['total_profit_act', 'total_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_profit_act || 0,
        ctx.subMeasures.total_revenue_act || 0,
        0
      ) * 100;
    }
  },

  rooms_dept_profit: {
    id: 'rooms_dept_profit',
    type: 'simple',
    subMeasures: ['rooms_dept_profit_act']
  },

  rooms_dept_profit_margin: {
    id: 'rooms_dept_profit_margin',
    type: 'calculated',
    subMeasures: ['rooms_dept_profit_act', 'total_rooms_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.rooms_dept_profit_act || 0,
        ctx.subMeasures.total_rooms_revenue_act || 0,
        0
      ) * 100;
    }
  },

  fb_dept_profit: {
    id: 'fb_dept_profit',
    type: 'simple',
    subMeasures: ['fb_profit_act']
  },

  fb_dept_profit_margin: {
    id: 'fb_dept_profit_margin',
    type: 'calculated',
    subMeasures: ['fb_profit_act', 'total_fb_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.fb_profit_act || 0,
        ctx.subMeasures.total_fb_revenue_act || 0,
        0
      ) * 100;
    }
  },

  // NOI
  noi: {
    id: 'noi',
    type: 'calculated',
    subMeasures: ['lodging_ops_ebitda_act', 'total_hotel_ebitda_act', 'replacement_reserve_act'],
    evaluator: (ctx: MeasureContext) => {
      const lodging = ctx.subMeasures.lodging_ops_ebitda_act || 0;
      const hotel = ctx.subMeasures.total_hotel_ebitda_act || 0;
      const reserve = ctx.subMeasures.replacement_reserve_act || 0;
      return lodging + hotel - reserve;
    }
  },

  // F90 P&L - Rooms and Reservations Revenue
  rooms_reservations_revenue: {
    id: 'rooms_reservations_revenue',
    type: 'simple',
    subMeasures: ['rooms_reservations_revenue_act']
  },

  // F90 P&L - Gift Shop Revenue
  gift_shop_revenue: {
    id: 'gift_shop_revenue',
    type: 'simple',
    subMeasures: ['gift_shop_revenue_act']
  },

  // F90 P&L - Restaurants and Room Service Revenue
  restaurants_room_service_revenue: {
    id: 'restaurants_room_service_revenue',
    type: 'simple',
    subMeasures: ['restaurants_room_service_revenue_act']
  },

  // F90 P&L - Lounges Revenue
  lounges_revenue: {
    id: 'lounges_revenue',
    type: 'simple',
    subMeasures: ['lounges_revenue_act']
  },

  // F90 P&L - Audio Visual Revenue
  audio_visual_revenue: {
    id: 'audio_visual_revenue',
    type: 'simple',
    subMeasures: ['audio_visual_revenue_act']
  },

  // F90 P&L - Banquets Revenue
  banquets_revenue: {
    id: 'banquets_revenue',
    type: 'simple',
    subMeasures: ['banquets_revenue_act']
  },

  // F90 P&L - Total F&B Revenue (uses existing sub-measures)
  total_fb_revenue: {
    id: 'total_fb_revenue',
    type: 'simple',
    subMeasures: ['total_fb_revenue_act']
  },

  // F90 P&L - Leisure & Recreation Revenue
  leisure_recreation_revenue: {
    id: 'leisure_recreation_revenue',
    type: 'simple',
    subMeasures: ['leisure_recreation_revenue_act']
  },

  // F90 P&L - Golf Revenue
  golf_revenue: {
    id: 'golf_revenue',
    type: 'simple',
    subMeasures: ['golf_revenue_act']
  },

  // F90 P&L - Spa Revenue
  spa_revenue: {
    id: 'spa_revenue',
    type: 'simple',
    subMeasures: ['spa_revenue_act']
  },

  // F90 P&L - Casino Revenue
  casino_revenue: {
    id: 'casino_revenue',
    type: 'simple',
    subMeasures: ['casino_revenue_act']
  },

  // F90 P&L - Miscellaneous Income Revenue
  misc_income_revenue: {
    id: 'misc_income_revenue',
    type: 'simple',
    subMeasures: ['misc_income_revenue_act']
  },

  // F90 P&L - Drycleaning Revenue
  drycleaning_revenue: {
    id: 'drycleaning_revenue',
    type: 'simple',
    subMeasures: ['drycleaning_revenue_act']
  },

  // F90 P&L - Garage Revenue
  garage_revenue: {
    id: 'garage_revenue',
    type: 'simple',
    subMeasures: ['garage_revenue_act']
  },

  // F90 P&L - Guest Communications Revenue
  guest_communications_revenue: {
    id: 'guest_communications_revenue',
    type: 'simple',
    subMeasures: ['guest_communications_revenue_act']
  },

  // F90 P&L - Total Other Departments Sales
  total_other_dept_sales: {
    id: 'total_other_dept_sales',
    type: 'simple',
    subMeasures: ['total_other_dept_sales_act']
  },

  // F90 P&L - Food Revenue (all F&B departments)
  food_revenue: {
    id: 'food_revenue',
    type: 'simple',
    subMeasures: ['food_rev_act']
  },

  // F90 P&L - Beverage Revenue (all F&B departments)
  beverage_revenue: {
    id: 'beverage_revenue',
    type: 'simple',
    subMeasures: ['bev_rev_act']
  },

  // F90 P&L - Sundry F&B Revenue (Total F&B minus Food minus Beverage)
  sundry_fb_revenue: {
    id: 'sundry_fb_revenue',
    type: 'calculated',
    subMeasures: ['total_fb_revenue_act', 'food_rev_act', 'bev_rev_act'],
    evaluator: (ctx: MeasureContext) => {
      return (ctx.subMeasures.total_fb_revenue_act || 0)
        - (ctx.subMeasures.food_rev_act || 0)
        - (ctx.subMeasures.bev_rev_act || 0);
    }
  },

  // F90 P&L - Food Revenue excluding Banqueting
  food_revenue_excl_banq: {
    id: 'food_revenue_excl_banq',
    type: 'calculated',
    subMeasures: ['food_rev_act', 'banq_food_rev_act'],
    evaluator: (ctx: MeasureContext) => {
      return (ctx.subMeasures.food_rev_act || 0)
        - (ctx.subMeasures.banq_food_rev_act || 0);
    }
  },

  // F90 P&L - Beverage Revenue excluding Banqueting
  beverage_revenue_excl_banq: {
    id: 'beverage_revenue_excl_banq',
    type: 'calculated',
    subMeasures: ['bev_rev_act', 'banq_bev_rev_act'],
    evaluator: (ctx: MeasureContext) => {
      return (ctx.subMeasures.bev_rev_act || 0)
        - (ctx.subMeasures.banq_bev_rev_act || 0);
    }
  },

  // F90 P&L - Sundry F&B Revenue excluding Banqueting
  // Original sundry = total_fb - food - bev; banquet sundry = banquets - banq_food - banq_bev
  sundry_fb_revenue_excl_banq: {
    id: 'sundry_fb_revenue_excl_banq',
    type: 'calculated',
    subMeasures: ['total_fb_revenue_act', 'food_rev_act', 'bev_rev_act', 'banquets_revenue_act', 'banq_food_rev_act', 'banq_bev_rev_act'],
    evaluator: (ctx: MeasureContext) => {
      const originalSundry = (ctx.subMeasures.total_fb_revenue_act || 0)
        - (ctx.subMeasures.food_rev_act || 0)
        - (ctx.subMeasures.bev_rev_act || 0);
      const banqSundry = (ctx.subMeasures.banquets_revenue_act || 0)
        - (ctx.subMeasures.banq_food_rev_act || 0)
        - (ctx.subMeasures.banq_bev_rev_act || 0);
      return originalSundry - banqSundry;
    }
  },

  // F90 P&L - Total Sales
  total_sales: {
    id: 'total_sales',
    type: 'simple',
    subMeasures: ['total_sales_act']
  },

  // F90 P&L - Rooms and Reservations Profit
  rooms_reservations_profit: {
    id: 'rooms_reservations_profit',
    type: 'simple',
    subMeasures: ['rooms_reservations_profit_act']
  },

  // F90 P&L - Gift Shop Profit
  gift_shop_profit: {
    id: 'gift_shop_profit',
    type: 'simple',
    subMeasures: ['gift_shop_profit_act']
  },

  // F90 P&L - Restaurants and Room Service Profit
  restaurants_room_service_profit: {
    id: 'restaurants_room_service_profit',
    type: 'simple',
    subMeasures: ['restaurants_room_service_profit_act']
  },

  // F90 P&L - Lounges Profit
  lounges_profit: {
    id: 'lounges_profit',
    type: 'simple',
    subMeasures: ['lounges_profit_act']
  },

  // F90 P&L - Audio Visual Profit
  audio_visual_profit: {
    id: 'audio_visual_profit',
    type: 'simple',
    subMeasures: ['audio_visual_profit_act']
  },

  // F90 P&L - Banquets Profit
  banquets_profit: {
    id: 'banquets_profit',
    type: 'simple',
    subMeasures: ['banquets_profit_act']
  },

  // F90 P&L - % Food COS
  food_cost_pct_sales: {
    id: 'food_cost_pct_sales',
    type: 'calculated',
    subMeasures: ['food_cost_act', 'food_rev_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.food_cost_act || 0,
        ctx.subMeasures.food_rev_act || 0,
        0
      ) * 100;
    }
  },

  // F90 P&L - % Beverage COS
  bev_cost_pct_sales: {
    id: 'bev_cost_pct_sales',
    type: 'calculated',
    subMeasures: ['bev_cost_act', 'bev_rev_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.bev_cost_act || 0,
        ctx.subMeasures.bev_rev_act || 0,
        0
      ) * 100;
    }
  },

  // F90 P&L - GOP %
  gop_pct: {
    id: 'gop_pct',
    type: 'calculated',
    subMeasures: ['total_profit_act', 'total_sales_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_profit_act || 0,
        ctx.subMeasures.total_sales_act || 0,
        0
      ) * 100;
    }
  },

  // F90 P&L - Rooms Department Profit %
  rooms_dept_profit_pct: {
    id: 'rooms_dept_profit_pct',
    type: 'calculated',
    subMeasures: ['rooms_reservations_profit_act', 'rooms_reservations_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.rooms_reservations_profit_act || 0,
        ctx.subMeasures.rooms_reservations_revenue_act || 0,
        0
      ) * 100;
    }
  },

  // F90 P&L - F&B Department Profit %
  fb_dept_profit_pct: {
    id: 'fb_dept_profit_pct',
    type: 'calculated',
    subMeasures: ['total_fb_profit_act', 'total_fb_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_fb_profit_act || 0,
        ctx.subMeasures.total_fb_revenue_act || 0,
        0
      ) * 100;
    }
  },

  // F&B Revenue as % of Total Revenue
  fb_revenue_pct_total: {
    id: 'fb_revenue_pct_total',
    type: 'calculated',
    subMeasures: ['total_fb_revenue_act', 'total_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_fb_revenue_act || 0,
        ctx.subMeasures.total_revenue_act || 0,
        0
      ) * 100;
    }
  },

  // F90 P&L - Total F&B Profit
  total_fb_profit: {
    id: 'total_fb_profit',
    type: 'simple',
    subMeasures: ['total_fb_profit_act']
  },

  // F90 P&L - Total F&B Profit excluding Banqueting
  total_fb_profit_excl_banq: {
    id: 'total_fb_profit_excl_banq',
    type: 'calculated',
    subMeasures: ['total_fb_profit_act', 'banquets_profit_act'],
    evaluator: (ctx: MeasureContext) => {
      return (ctx.subMeasures.total_fb_profit_act || 0)
        - (ctx.subMeasures.banquets_profit_act || 0);
    }
  },

  // F90 P&L - Leisure & Recreation Profit
  leisure_recreation_profit: {
    id: 'leisure_recreation_profit',
    type: 'simple',
    subMeasures: ['leisure_recreation_profit_act']
  },

  // F90 P&L - Golf Profit
  golf_profit: {
    id: 'golf_profit',
    type: 'simple',
    subMeasures: ['golf_profit_act']
  },

  // F90 P&L - Spa Profit
  spa_profit: {
    id: 'spa_profit',
    type: 'simple',
    subMeasures: ['spa_profit_act']
  },

  // F90 P&L - Casino Profit
  casino_profit: {
    id: 'casino_profit',
    type: 'simple',
    subMeasures: ['casino_profit_act']
  },

  // F90 P&L - Miscellaneous Income Profit
  misc_income_profit: {
    id: 'misc_income_profit',
    type: 'simple',
    subMeasures: ['misc_income_profit_act']
  },

  // F90 P&L - Drycleaning Profit (In House)
  drycleaning_profit: {
    id: 'drycleaning_profit',
    type: 'simple',
    subMeasures: ['drycleaning_profit_act']
  },

  // F90 P&L - Garage Profit
  garage_profit: {
    id: 'garage_profit',
    type: 'simple',
    subMeasures: ['garage_profit_act']
  },

  // F90 P&L - Guest Communications Profit
  guest_communications_profit: {
    id: 'guest_communications_profit',
    type: 'simple',
    subMeasures: ['guest_communications_profit_act']
  },

  // F90 P&L - Total Other Departments Profit
  total_other_dept_profit: {
    id: 'total_other_dept_profit',
    type: 'simple',
    subMeasures: ['total_other_dept_profit_act']
  },

  // F90 P&L - Total Department Profit
  total_dept_profit: {
    id: 'total_dept_profit',
    type: 'simple',
    subMeasures: ['total_dept_profit_act']
  },

  // F90 P&L - Administrative and General Expense
  admin_general_expense: {
    id: 'admin_general_expense',
    type: 'simple',
    subMeasures: ['admin_general_expense_act']
  },

  // F90 P&L - Human Resources Expense
  human_resources_expense: {
    id: 'human_resources_expense',
    type: 'simple',
    subMeasures: ['human_resources_expense_act']
  },

  // F90 P&L - Loss Prevention Expense
  loss_prevention_expense: {
    id: 'loss_prevention_expense',
    type: 'simple',
    subMeasures: ['loss_prevention_expense_act']
  },

  // F90 P&L - Accounting Expense
  accounting_expense: {
    id: 'accounting_expense',
    type: 'simple',
    subMeasures: ['accounting_expense_act']
  },

  // F90 P&L - Administrative & General Expense (Dept Level 7)
  admin_general_dept_expense: {
    id: 'admin_general_dept_expense',
    type: 'simple',
    subMeasures: ['admin_general_dept_expense_act']
  },

  // F90 P&L - Information & Telecom Systems Expense
  info_telecom_systems_expense: {
    id: 'info_telecom_systems_expense',
    type: 'simple',
    subMeasures: ['info_telecom_systems_expense_act']
  },

  // F90 P&L - Admin & General + IT combined
  admin_general_and_it_expense: {
    id: 'admin_general_and_it_expense',
    type: 'calculated',
    subMeasures: ['admin_general_dept_expense_act', 'info_telecom_systems_expense_act'],
    evaluator: (ctx: MeasureContext) => {
      return (ctx.subMeasures.admin_general_dept_expense_act || 0)
        + (ctx.subMeasures.info_telecom_systems_expense_act || 0);
    }
  },

  // F90 P&L - Utilities Expense
  utilities_expense: {
    id: 'utilities_expense',
    type: 'simple',
    subMeasures: ['utilities_expense_act']
  },

  // F90 P&L - Property Operation & Maintenance Expense
  property_operation_maint_expense: {
    id: 'property_operation_maint_expense',
    type: 'simple',
    subMeasures: ['property_operation_maint_expense_act']
  },

  // F90 P&L - Sales & Marketing Expense
  sales_marketing_expense: {
    id: 'sales_marketing_expense',
    type: 'simple',
    subMeasures: ['sales_marketing_expense_act']
  },

  // F90 P&L - Total Undistributed Operating Expenses
  total_undist_op_exp: {
    id: 'total_undist_op_exp',
    type: 'simple',
    subMeasures: ['total_undist_op_exp_act']
  },

  // F90 P&L - Base Management Fee
  base_mgmt_fee: {
    id: 'base_mgmt_fee',
    type: 'simple',
    subMeasures: ['base_mgmt_fee_act']
  },

  // F90 P&L - Incentive Management Fee
  incentive_mgmt_fee: {
    id: 'incentive_mgmt_fee',
    type: 'simple',
    subMeasures: ['incentive_mgmt_fee_act']
  },

  // F90 P&L - EBITDA
  ebitda: {
    id: 'ebitda',
    type: 'simple',
    subMeasures: ['ebitda_act']
  },

  // F90 P&L - Net Due To/(From) Owner
  net_due_owner: {
    id: 'net_due_owner',
    type: 'simple',
    subMeasures: ['net_due_owner_act']
  },

  // F90 P&L - Total Rooms (Statistic)
  total_rooms: {
    id: 'total_rooms',
    type: 'simple',
    subMeasures: ['total_rooms_act']
  },

  // F90 P&L - Rooms Sold (Statistic)
  sold_rooms: {
    id: 'sold_rooms',
    type: 'simple',
    subMeasures: ['sold_rooms_act']
  },

  // ============================================================================
  // F90 KPI Measures — Detailed management fees, non-op, owner, depreciation
  // ============================================================================

  // Simple wrappers
  f90_base_mgmt_fee: {
    id: 'f90_base_mgmt_fee',
    type: 'simple',
    subMeasures: ['f90_base_mgmt_fee_act']
  },

  f90_base_royalty_fee: {
    id: 'f90_base_royalty_fee',
    type: 'simple',
    subMeasures: ['f90_base_royalty_fee_act']
  },

  f90_incentive_fee: {
    id: 'f90_incentive_fee',
    type: 'simple',
    subMeasures: ['f90_incentive_fee_act']
  },

  f90_repl_reserve: {
    id: 'f90_repl_reserve',
    type: 'simple',
    subMeasures: ['f90_replacement_reserve_act']
  },

  f90_owner_depr_amort: {
    id: 'f90_owner_depr_amort',
    type: 'simple',
    subMeasures: ['f90_d0690_all_act']
  },

  f90_owner_interest_income_tax: {
    id: 'f90_owner_interest_income_tax',
    type: 'simple',
    subMeasures: ['f90_d0691_all_act']
  },

  // Calculated measures
  f90_total_mgmt_fees: {
    id: 'f90_total_mgmt_fees',
    type: 'calculated',
    subMeasures: ['f90_base_mgmt_fee_act', 'f90_base_royalty_fee_act', 'f90_incentive_fee_act'],
    evaluator: (ctx: MeasureContext) => {
      const baseMgmt = ctx.subMeasures.f90_base_mgmt_fee_act || 0;
      const baseRoyalty = ctx.subMeasures.f90_base_royalty_fee_act || 0;
      const incentive = ctx.subMeasures.f90_incentive_fee_act || 0;
      return baseMgmt + baseRoyalty + incentive;
    }
  },

  // F90 SUBTOTAL — HOTEL PROFIT/(LOSS) BEFORE DEPR, INT AND OWNER EXP.
  // Composition of atoms (see file header for the architecture rule):
  //   MCP − Fixed Expenses − Total Mgmt Fees
  // `total_profit_act` (MCP) is negate:true (positive). Fee atoms are negate:true
  // and arrive negative, so adding them subtracts. `f90_fixed_expenses_l20_act`
  // has no negate (raw positive debit) so it must be subtracted.
  f90_income_before_nonop: {
    id: 'f90_income_before_nonop',
    type: 'calculated',
    subMeasures: ['total_profit_act', 'f90_fixed_expenses_l20_act',
      'f90_base_mgmt_fee_act', 'f90_base_royalty_fee_act', 'f90_incentive_fee_act'],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures.total_profit_act || 0)
      - (ctx.subMeasures.f90_fixed_expenses_l20_act || 0)
      + (ctx.subMeasures.f90_base_mgmt_fee_act || 0)
      + (ctx.subMeasures.f90_base_royalty_fee_act || 0)
      + (ctx.subMeasures.f90_incentive_fee_act || 0),
  },

  f90_nonop_inc_exp: {
    id: 'f90_nonop_inc_exp',
    type: 'calculated',
    subMeasures: ['f90_d0480_all_act', 'f90_base_mgmt_fee_act', 'f90_incentive_fee_act', 'f90_replacement_reserve_act'],
    evaluator: (ctx: MeasureContext) => {
      const d0480All = ctx.subMeasures.f90_d0480_all_act || 0;
      const baseMgmt = ctx.subMeasures.f90_base_mgmt_fee_act || 0;
      const incentive = ctx.subMeasures.f90_incentive_fee_act || 0;
      const replReserve = ctx.subMeasures.f90_replacement_reserve_act || 0;
      return d0480All - baseMgmt - incentive - replReserve;
    }
  },

  f90_ebitda_excl_owner: {
    id: 'f90_ebitda_excl_owner',
    type: 'calculated',
    subMeasures: [
      'total_profit_act', 'f90_base_mgmt_fee_act', 'f90_base_royalty_fee_act',
      'f90_incentive_fee_act', 'f90_d0480_all_act', 'f90_replacement_reserve_act'
    ],
    evaluator: (ctx: MeasureContext) => {
      const gop = ctx.subMeasures.total_profit_act || 0;
      const baseMgmt = ctx.subMeasures.f90_base_mgmt_fee_act || 0;
      const baseRoyalty = ctx.subMeasures.f90_base_royalty_fee_act || 0;
      const incentive = ctx.subMeasures.f90_incentive_fee_act || 0;
      const incomeBeforeNonOp = gop + baseMgmt + baseRoyalty + incentive;

      const d0480All = ctx.subMeasures.f90_d0480_all_act || 0;
      const replReserve = ctx.subMeasures.f90_replacement_reserve_act || 0;
      const nonOp = d0480All - baseMgmt - incentive - replReserve;

      return incomeBeforeNonOp + nonOp;
    }
  },

  f90_owner_expense: {
    id: 'f90_owner_expense',
    type: 'calculated',
    subMeasures: ['f90_d0490_all_act', 'f90_base_royalty_fee_act'],
    evaluator: (ctx: MeasureContext) => {
      const d0490All = ctx.subMeasures.f90_d0490_all_act || 0;
      const royaltyFee = ctx.subMeasures.f90_base_royalty_fee_act || 0;
      return d0490All - royaltyFee;
    }
  },

  f90_ebitda: {
    id: 'f90_ebitda',
    type: 'calculated',
    subMeasures: [
      'total_profit_act', 'f90_base_mgmt_fee_act', 'f90_base_royalty_fee_act',
      'f90_incentive_fee_act', 'f90_d0480_all_act', 'f90_replacement_reserve_act',
      'f90_d0490_all_act'
    ],
    evaluator: (ctx: MeasureContext) => {
      const gop = ctx.subMeasures.total_profit_act || 0;
      const baseMgmt = ctx.subMeasures.f90_base_mgmt_fee_act || 0;
      const baseRoyalty = ctx.subMeasures.f90_base_royalty_fee_act || 0;
      const incentive = ctx.subMeasures.f90_incentive_fee_act || 0;
      const incomeBeforeNonOp = gop + baseMgmt + baseRoyalty + incentive;

      const d0480All = ctx.subMeasures.f90_d0480_all_act || 0;
      const replReserve = ctx.subMeasures.f90_replacement_reserve_act || 0;
      const nonOp = d0480All - baseMgmt - incentive - replReserve;
      const ebitdaExclOwner = incomeBeforeNonOp + nonOp;

      const d0490All = ctx.subMeasures.f90_d0490_all_act || 0;
      const ownerExpense = d0490All - baseRoyalty;

      return ebitdaExclOwner + ownerExpense;
    }
  },

  f90_ebitda_less_repl_reserve: {
    id: 'f90_ebitda_less_repl_reserve',
    type: 'calculated',
    subMeasures: [
      'total_profit_act', 'f90_base_mgmt_fee_act', 'f90_base_royalty_fee_act',
      'f90_incentive_fee_act', 'f90_d0480_all_act', 'f90_replacement_reserve_act',
      'f90_d0490_all_act'
    ],
    evaluator: (ctx: MeasureContext) => {
      const gop = ctx.subMeasures.total_profit_act || 0;
      const baseMgmt = ctx.subMeasures.f90_base_mgmt_fee_act || 0;
      const baseRoyalty = ctx.subMeasures.f90_base_royalty_fee_act || 0;
      const incentive = ctx.subMeasures.f90_incentive_fee_act || 0;
      const incomeBeforeNonOp = gop + baseMgmt + baseRoyalty + incentive;

      const d0480All = ctx.subMeasures.f90_d0480_all_act || 0;
      const replReserve = ctx.subMeasures.f90_replacement_reserve_act || 0;
      const nonOp = d0480All - baseMgmt - incentive - replReserve;
      const ebitdaExclOwner = incomeBeforeNonOp + nonOp;

      const d0490All = ctx.subMeasures.f90_d0490_all_act || 0;
      const ownerExpense = d0490All - baseRoyalty;
      const ebitda = ebitdaExclOwner + ownerExpense;

      return ebitda + replReserve;
    }
  },

  f90_total_mgr_profit_contrib: {
    id: 'f90_total_mgr_profit_contrib',
    type: 'calculated',
    subMeasures: [
      'total_profit_act', 'f90_base_mgmt_fee_act', 'f90_base_royalty_fee_act',
      'f90_incentive_fee_act', 'f90_d0480_all_act', 'f90_replacement_reserve_act',
      'f90_d0490_all_act', 'f90_d0690_all_act', 'f90_d0691_all_act'
    ],
    evaluator: (ctx: MeasureContext) => {
      const gop = ctx.subMeasures.total_profit_act || 0;
      const baseMgmt = ctx.subMeasures.f90_base_mgmt_fee_act || 0;
      const baseRoyalty = ctx.subMeasures.f90_base_royalty_fee_act || 0;
      const incentive = ctx.subMeasures.f90_incentive_fee_act || 0;
      const incomeBeforeNonOp = gop + baseMgmt + baseRoyalty + incentive;

      const d0480All = ctx.subMeasures.f90_d0480_all_act || 0;
      const replReserve = ctx.subMeasures.f90_replacement_reserve_act || 0;
      const nonOp = d0480All - baseMgmt - incentive - replReserve;
      const ebitdaExclOwner = incomeBeforeNonOp + nonOp;

      const d0490All = ctx.subMeasures.f90_d0490_all_act || 0;
      const ownerExpense = d0490All - baseRoyalty;
      const ebitda = ebitdaExclOwner + ownerExpense;
      const ebitdaLessReserve = ebitda + replReserve;

      const ownerDepr = ctx.subMeasures.f90_d0690_all_act || 0;
      const ownerInterestTax = ctx.subMeasures.f90_d0691_all_act || 0;
      return ebitdaLessReserve + ownerDepr + ownerInterestTax;
    }
  },

  // F90 P&L - Fixed Expenses (level_20 = 'Fixed Expenses' across all owner departments)
  fixed_expenses: {
    id: 'fixed_expenses',
    type: 'simple',
    subMeasures: ['f90_fixed_expenses_l20_act']
  },

  // F90 P&L - Hotel Profit Before Mgt Fees (MCP minus Fixed Expenses)
  hotel_profit_before_mgt_fees: {
    id: 'hotel_profit_before_mgt_fees',
    type: 'calculated',
    subMeasures: ['total_profit_act', 'f90_fixed_expenses_l20_act'],
    evaluator: (ctx: MeasureContext) => {
      return (ctx.subMeasures.total_profit_act || 0) - (ctx.subMeasures.f90_fixed_expenses_l20_act || 0);
    }
  },

  // F90 P&L - Depreciation (level_20 = 'Depreciation')
  f90_depreciation: {
    id: 'f90_depreciation',
    type: 'simple',
    subMeasures: ['f90_depreciation_l20_act']
  },

  // F90 P&L - Owners Expense (level_20 = 'Owner Expense')
  f90_protea_owner_expense: {
    id: 'f90_protea_owner_expense',
    type: 'simple',
    subMeasures: ['f90_owner_expense_l20_act']
  },

  // F90 P&L - Interest (level_20 = 'Interest')
  f90_interest: {
    id: 'f90_interest',
    type: 'simple',
    subMeasures: ['f90_interest_l20_act']
  },

  // F90 P&L - Refurbishment Fund (level_20 = 'Refurbishment Fund')
  f90_refurbishment_fund: {
    id: 'f90_refurbishment_fund',
    type: 'simple',
    subMeasures: ['f90_refurbishment_fund_l20_act']
  },

  // F90 DISPLAY — Abnormal Items. Thin wrapper over the level_20 catch-all atom,
  // so it matches INVEST FACTOR OWNER SUMMARY's Abnormal Items subgroup exactly.
  f90_abnormal_items: {
    id: 'f90_abnormal_items',
    type: 'simple',
    subMeasures: ['f90_abnormal_items_l20_act']
  },

  // F90 SUBTOTAL — HOTEL PROFIT/(LOSS) BEFORE TAX.
  // Composition: HOTEL PROFIT BEFORE DEPR INT OWNER EXP − Depreciation − Owner Exp
  //              + Net Interest − Refurbishment Fund − Abnormal Items.
  // All level_20 expense atoms below are negate:true so they arrive negative;
  // adding them subtracts. f90_interest_l20_act is net interest income/expense
  // displayed without invertSign, so add it as-is.
  f90_profit_before_tax: {
    id: 'f90_profit_before_tax',
    type: 'calculated',
    subMeasures: [
      'f90_income_before_nonop',
      'f90_depreciation_l20_act', 'f90_owner_expense_l20_act',
      'f90_interest_l20_act', 'f90_refurbishment_fund_l20_act',
      'f90_abnormal_items_l20_act'
    ],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures.f90_income_before_nonop || 0)
      + (ctx.subMeasures.f90_depreciation_l20_act || 0)
      + (ctx.subMeasures.f90_owner_expense_l20_act || 0)
      + (ctx.subMeasures.f90_interest_l20_act || 0)
      + (ctx.subMeasures.f90_refurbishment_fund_l20_act || 0)
      + (ctx.subMeasures.f90_abnormal_items_l20_act || 0),
  },

  // F90 P&L - Tax (level_20 = 'Tax')
  f90_tax: {
    id: 'f90_tax',
    type: 'simple',
    subMeasures: ['f90_tax_l20_act']
  },

  // F90 P&L - Deferred Tax (level_20 = 'Deferred Tax')
  f90_deferred_tax: {
    id: 'f90_deferred_tax',
    type: 'simple',
    subMeasures: ['f90_deferred_tax_l20_act']
  },

  // F90 SUBTOTAL — HOTEL PROFIT/(LOSS) BEFORE DIVIDENDS (measure id kept as
  // f90_net_profit for backward compat; the row label in proteaF90PLRowConfig
  // is the display source of truth). Composition: PROFIT BEFORE TAX − Tax −
  // Deferred Tax. Tax atoms are negate:true → arrive negative → add subtracts.
  f90_net_profit: {
    id: 'f90_net_profit',
    type: 'calculated',
    subMeasures: ['f90_profit_before_tax', 'f90_tax_l20_act', 'f90_deferred_tax_l20_act'],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures.f90_profit_before_tax || 0)
      + (ctx.subMeasures.f90_tax_l20_act || 0)
      + (ctx.subMeasures.f90_deferred_tax_l20_act || 0),
  },

  // F90 DISPLAY — Dividends.
  f90_dividends: {
    id: 'f90_dividends',
    type: 'simple',
    subMeasures: ['f90_dividends_l20_act']
  },

  // F90 SUBTOTAL — NET PROFIT/(LOSS) (measure id kept as f90_profit_after_dividends
  // for backward compat). Composition: HOTEL PROFIT BEFORE DIVIDENDS − Dividends.
  // f90_dividends_l20_act is negate:true → arrives negative → add subtracts.
  f90_profit_after_dividends: {
    id: 'f90_profit_after_dividends',
    type: 'calculated',
    subMeasures: ['f90_net_profit', 'f90_dividends_l20_act'],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures.f90_net_profit || 0)
      + (ctx.subMeasures.f90_dividends_l20_act || 0),
  },

  // Protea Report: Original GOP % (pre-movement, before insurance/audit accounts shift to Admin & General)
  // After applyProteaAccountMovement() mutates total_profit_act, this reverses the adjustment to recover the original GOP.
  protea_original_gop_pct: {
    id: 'protea_original_gop_pct',
    type: 'calculated',
    subMeasures: ['total_profit_act',
      'protea_moved_accounts_d0480_act', 'protea_moved_accounts_d0490_act',
      'protea_moved_accounts_d0690_act', 'protea_moved_accounts_d0691_act',
      'total_sales_act'],
    evaluator: (ctx: MeasureContext) => {
      const adjustedMcp = ctx.subMeasures.total_profit_act || 0;
      const moved = (ctx.subMeasures.protea_moved_accounts_d0480_act || 0)
        + (ctx.subMeasures.protea_moved_accounts_d0490_act || 0)
        + (ctx.subMeasures.protea_moved_accounts_d0690_act || 0)
        + (ctx.subMeasures.protea_moved_accounts_d0691_act || 0);
      const originalGop = adjustedMcp - moved;
      return evaluateDivide(originalGop, ctx.subMeasures.total_sales_act || 0, 0) * 100;
    }
  },

  // ==========================================================================
  // ROOMS & RESERVATION SUMMARY KPIs — calculated measures
  //
  // Pattern note (Protea-divergent KPIs):
  //   Whenever a KPI references a subtotal that the Protea path moves
  //   accounts in or out of, define TWO measures with identical labels but
  //   different IDs — `<kpi>` (canonical / non-Protea) and `<kpi>_protea`
  //   (Protea-aware via the movement sub-measure). Non-Protea row configs
  //   reference the canonical ID; the Protea ROOMS_KPI_CONFIG references the
  //   `_protea` ID. See plan: "Pattern: KPIs whose totals diverge between
  //   Protea and non-Protea".
  // ==========================================================================

  rev_par_after_tac: {
    id: 'rev_par_after_tac',
    type: 'calculated',
    subMeasures: ['total_rooms_revenue_act', 'rooms_tac_act', 'total_rooms_act'],
    evaluator: (ctx: MeasureContext) => {
      const revenue = ctx.subMeasures.total_rooms_revenue_act || 0;
      const tac = ctx.subMeasures.rooms_tac_act || 0;
      return evaluateDivide(revenue - tac, ctx.subMeasures.total_rooms_act || 0, 0);
    }
  },

  bed_nights_sold: {
    id: 'bed_nights_sold',
    type: 'simple',
    subMeasures: ['bed_nights_sold_act']
  },

  bed_nights_avail: {
    id: 'bed_nights_avail',
    type: 'simple',
    subMeasures: ['bed_nights_avail_act']
  },

  avg_bed_occupancy_pct: {
    id: 'avg_bed_occupancy_pct',
    type: 'calculated',
    subMeasures: ['bed_nights_sold_act', 'bed_nights_avail_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.bed_nights_sold_act || 0,
        ctx.subMeasures.bed_nights_avail_act || 0,
        0
      ) * 100;
    }
  },

  avg_guest_rate: {
    id: 'avg_guest_rate',
    type: 'calculated',
    subMeasures: ['total_rooms_revenue_act', 'bed_nights_sold_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_rooms_revenue_act || 0,
        ctx.subMeasures.bed_nights_sold_act || 0,
        0
      );
    }
  },

  double_occupancy_pct: {
    id: 'double_occupancy_pct',
    type: 'calculated',
    subMeasures: ['bed_nights_sold_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) => {
      const beds = ctx.subMeasures.bed_nights_sold_act || 0;
      const rooms = ctx.subMeasures.sold_rooms_act || 0;
      return evaluateDivide(beds - rooms, rooms, 0) * 100;
    }
  },

  rooms_available_per_day: {
    id: 'rooms_available_per_day',
    type: 'calculated',
    subMeasures: ['total_rooms_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_rooms_act || 0,
        ctx.periodDays || 0,
        0
      );
    }
  },

  bed_available_per_day: {
    id: 'bed_available_per_day',
    type: 'calculated',
    subMeasures: ['bed_nights_avail_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.bed_nights_avail_act || 0,
        ctx.periodDays || 0,
        0
      );
    }
  },

  // --- Protea-divergent: Payroll & Controllables totals + percent-of-sales ---

  total_rooms_payroll: {
    id: 'total_rooms_payroll',
    type: 'simple',
    subMeasures: ['total_rooms_payroll_act']
  },

  total_rooms_payroll_protea: {
    id: 'total_rooms_payroll_protea',
    type: 'calculated',
    subMeasures: ['total_rooms_payroll_act', 'rooms_payroll_movement_act'],
    evaluator: (ctx: MeasureContext) => {
      return (ctx.subMeasures.total_rooms_payroll_act || 0)
        + (ctx.subMeasures.rooms_payroll_movement_act || 0);
    }
  },

  total_rooms_controllables: {
    id: 'total_rooms_controllables',
    type: 'simple',
    subMeasures: ['total_rooms_controllables_act']
  },

  total_rooms_controllables_protea: {
    id: 'total_rooms_controllables_protea',
    type: 'calculated',
    subMeasures: ['total_rooms_controllables_act', 'rooms_payroll_movement_act'],
    evaluator: (ctx: MeasureContext) => {
      return (ctx.subMeasures.total_rooms_controllables_act || 0)
        - (ctx.subMeasures.rooms_payroll_movement_act || 0);
    }
  },

  payroll_pct_rooms_sales: {
    id: 'payroll_pct_rooms_sales',
    type: 'calculated',
    subMeasures: ['total_rooms_payroll_act', 'total_rooms_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_rooms_payroll_act || 0,
        ctx.subMeasures.total_rooms_revenue_act || 0,
        0
      ) * 100;
    }
  },

  payroll_pct_rooms_sales_protea: {
    id: 'payroll_pct_rooms_sales_protea',
    type: 'calculated',
    subMeasures: ['total_rooms_payroll_act', 'rooms_payroll_movement_act', 'total_rooms_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      const payroll = (ctx.subMeasures.total_rooms_payroll_act || 0)
        + (ctx.subMeasures.rooms_payroll_movement_act || 0);
      return evaluateDivide(
        payroll,
        ctx.subMeasures.total_rooms_revenue_act || 0,
        0
      ) * 100;
    }
  },

  other_exp_pct_rooms_sales: {
    id: 'other_exp_pct_rooms_sales',
    type: 'calculated',
    subMeasures: ['total_rooms_controllables_act', 'total_rooms_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      return evaluateDivide(
        ctx.subMeasures.total_rooms_controllables_act || 0,
        ctx.subMeasures.total_rooms_revenue_act || 0,
        0
      ) * 100;
    }
  },

  other_exp_pct_rooms_sales_protea: {
    id: 'other_exp_pct_rooms_sales_protea',
    type: 'calculated',
    subMeasures: ['total_rooms_controllables_act', 'rooms_payroll_movement_act', 'total_rooms_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      const controllables = (ctx.subMeasures.total_rooms_controllables_act || 0)
        - (ctx.subMeasures.rooms_payroll_movement_act || 0);
      return evaluateDivide(
        controllables,
        ctx.subMeasures.total_rooms_revenue_act || 0,
        0
      ) * 100;
    }
  },

  // --- Per Room Night Sold (Rooms-scope expense ÷ sold rooms) ---
  // Values are dollars-per-sold-room (NOT multiplied by 100). Denominator is
  // sold_rooms_act — hotel-Rooms scope, intentionally NOT pinned to a specific
  // department so the ratio stays meaningful regardless of which Rooms-group
  // rendering scope the report is in.
  //
  // Operating Supplies = sum of the four Operating Equipment Usage atoms
  // (Flatware + Linen + Glassware + Smalls). Same accounts feed the per-item
  // breakdown rows below — Operating Supplies is a roll-up of those.
  prns_operating_supplies: {
    id: 'prns_operating_supplies',
    type: 'calculated',
    subMeasures: ['rooms_flatware_act', 'rooms_linen_act', 'rooms_glassware_act', 'rooms_smalls_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) => {
      const opEquip = (ctx.subMeasures.rooms_flatware_act || 0)
        + (ctx.subMeasures.rooms_linen_act || 0)
        + (ctx.subMeasures.rooms_glassware_act || 0)
        + (ctx.subMeasures.rooms_smalls_act || 0);
      return evaluateDivide(opEquip, ctx.subMeasures.sold_rooms_act || 0, 0);
    }
  },
  prns_cleaning_supplies: {
    id: 'prns_cleaning_supplies',
    type: 'calculated',
    subMeasures: ['rooms_cleaning_supplies_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_cleaning_supplies_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },
  prns_guest_supplies: {
    id: 'prns_guest_supplies',
    type: 'calculated',
    subMeasures: ['rooms_guest_supplies_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_guest_supplies_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },
  prns_paper_supplies: {
    id: 'prns_paper_supplies',
    type: 'calculated',
    subMeasures: ['rooms_paper_supplies_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_paper_supplies_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },
  prns_printing_stationery: {
    id: 'prns_printing_stationery',
    type: 'calculated',
    subMeasures: ['rooms_printing_stationery_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_printing_stationery_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },
  prns_laundry: {
    id: 'prns_laundry',
    type: 'calculated',
    subMeasures: ['rooms_laundry_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_laundry_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },

  // --- Operating Equipment Usage per Room Night Sold ---
  // Per-item breakdown of the same accounts that roll up into prns_operating_supplies.
  // Each row = item expense ÷ sold rooms (dollars per sold room, NOT multiplied).
  prns_flatware: {
    id: 'prns_flatware',
    type: 'calculated',
    subMeasures: ['rooms_flatware_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_flatware_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },
  prns_linen: {
    id: 'prns_linen',
    type: 'calculated',
    subMeasures: ['rooms_linen_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_linen_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },
  prns_glassware: {
    id: 'prns_glassware',
    type: 'calculated',
    subMeasures: ['rooms_glassware_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_glassware_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },
  prns_smalls: {
    id: 'prns_smalls',
    type: 'calculated',
    subMeasures: ['rooms_smalls_act', 'sold_rooms_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.rooms_smalls_act || 0, ctx.subMeasures.sold_rooms_act || 0, 0)
  },

  // --- F&B Covers (per-meal customer counts) ---
  fb_breakfast_customers: { id: 'fb_breakfast_customers', type: 'simple', subMeasures: ['fb_nonbanq_breakfast_customers_act'] },
  fb_lunch_customers:     { id: 'fb_lunch_customers',     type: 'simple', subMeasures: ['fb_nonbanq_lunch_customers_act']     },
  fb_dinner_customers:    { id: 'fb_dinner_customers',    type: 'simple', subMeasures: ['fb_nonbanq_dinner_customers_act']    },
  fb_late_snack_customers:{ id: 'fb_late_snack_customers',type: 'simple', subMeasures: ['fb_nonbanq_late_snack_customers_act']},
  banq_customers:         { id: 'banq_customers',         type: 'simple', subMeasures: ['banq_customers_act']                 },

  // --- F&B Average Food Spend (per-meal revenue ÷ per-meal customers) ---
  avg_breakfast_spend: {
    id: 'avg_breakfast_spend',
    type: 'calculated',
    subMeasures: ['fb_nonbanq_breakfast_revenue_act', 'fb_nonbanq_breakfast_customers_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.fb_nonbanq_breakfast_revenue_act || 0,
      ctx.subMeasures.fb_nonbanq_breakfast_customers_act || 0,
      0
    )
  },
  avg_lunch_spend: {
    id: 'avg_lunch_spend',
    type: 'calculated',
    subMeasures: ['fb_nonbanq_lunch_revenue_act', 'fb_nonbanq_lunch_customers_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.fb_nonbanq_lunch_revenue_act || 0,
      ctx.subMeasures.fb_nonbanq_lunch_customers_act || 0,
      0
    )
  },
  avg_dinner_spend: {
    id: 'avg_dinner_spend',
    type: 'calculated',
    subMeasures: ['fb_nonbanq_dinner_revenue_act', 'fb_nonbanq_dinner_customers_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.fb_nonbanq_dinner_revenue_act || 0,
      ctx.subMeasures.fb_nonbanq_dinner_customers_act || 0,
      0
    )
  },
  avg_late_snack_spend: {
    id: 'avg_late_snack_spend',
    type: 'calculated',
    subMeasures: ['fb_nonbanq_late_snack_revenue_act', 'fb_nonbanq_late_snack_customers_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.fb_nonbanq_late_snack_revenue_act || 0,
      ctx.subMeasures.fb_nonbanq_late_snack_customers_act || 0,
      0
    )
  },
  avg_banq_spend: {
    id: 'avg_banq_spend',
    type: 'calculated',
    subMeasures: ['banq_revenue_act', 'banq_customers_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.banq_revenue_act || 0,
      ctx.subMeasures.banq_customers_act || 0,
      0
    )
  },

  // --- Covers as % of Bed Nights Sold ---
  // Numerator = per-meal customer count (already non-banq for the first
  // three; banqueting for the fourth). Denominator = bed nights sold,
  // sourced from the Rooms department (reused from sold_rooms? No — bed
  // nights = A960005, distinct from sold rooms A960103). Reuses the
  // existing bed_nights_sold_act sub-measure (Rooms scope, not pinned to
  // any specific dept — same hotel-wide stat regardless of which group
  // summary is rendering it).
  breakfast_pct_bed_nights: {
    id: 'breakfast_pct_bed_nights',
    type: 'calculated',
    subMeasures: ['fb_nonbanq_breakfast_customers_act', 'bed_nights_sold_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.fb_nonbanq_breakfast_customers_act || 0,
      ctx.subMeasures.bed_nights_sold_act || 0,
      0
    ) * 100
  },
  lunch_pct_bed_nights: {
    id: 'lunch_pct_bed_nights',
    type: 'calculated',
    subMeasures: ['fb_nonbanq_lunch_customers_act', 'bed_nights_sold_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.fb_nonbanq_lunch_customers_act || 0,
      ctx.subMeasures.bed_nights_sold_act || 0,
      0
    ) * 100
  },
  dinner_pct_bed_nights: {
    id: 'dinner_pct_bed_nights',
    type: 'calculated',
    subMeasures: ['fb_nonbanq_dinner_customers_act', 'bed_nights_sold_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.fb_nonbanq_dinner_customers_act || 0,
      ctx.subMeasures.bed_nights_sold_act || 0,
      0
    ) * 100
  },
  late_snack_pct_bed_nights: {
    id: 'late_snack_pct_bed_nights',
    type: 'calculated',
    subMeasures: ['fb_nonbanq_late_snack_customers_act', 'bed_nights_sold_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.fb_nonbanq_late_snack_customers_act || 0,
      ctx.subMeasures.bed_nights_sold_act || 0,
      0
    ) * 100
  },
  banq_pct_bed_nights: {
    id: 'banq_pct_bed_nights',
    type: 'calculated',
    subMeasures: ['banq_customers_act', 'bed_nights_sold_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.banq_customers_act || 0,
      ctx.subMeasures.bed_nights_sold_act || 0,
      0
    ) * 100
  },

  // --- Cost Per Cover (dollars-per-cover, NOT multiplied by 100 — label
  //     says "Cost" not "Cents", so display as currency-style 2-decimal). ---
  cpc_operating_supplies: {
    id: 'cpc_operating_supplies',
    type: 'calculated',
    subMeasures: ['fb_flatware_act', 'fb_china_act', 'fb_kitchen_utensils_act', 'fb_linen_act', 'fb_glassware_act', 'fb_smalls_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) => {
      const opEquip = (ctx.subMeasures.fb_flatware_act || 0)
        + (ctx.subMeasures.fb_china_act || 0)
        + (ctx.subMeasures.fb_kitchen_utensils_act || 0)
        + (ctx.subMeasures.fb_linen_act || 0)
        + (ctx.subMeasures.fb_glassware_act || 0)
        + (ctx.subMeasures.fb_smalls_act || 0);
      return evaluateDivide(opEquip, ctx.subMeasures.fb_total_covers_act || 0, 0);
    }
  },
  cpc_cleaning_supplies: {
    id: 'cpc_cleaning_supplies',
    type: 'calculated',
    subMeasures: ['fb_cleaning_supplies_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_cleaning_supplies_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_guest_supplies: {
    id: 'cpc_guest_supplies',
    type: 'calculated',
    subMeasures: ['fb_guest_supplies_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_guest_supplies_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_paper_supplies: {
    id: 'cpc_paper_supplies',
    type: 'calculated',
    subMeasures: ['fb_paper_supplies_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_paper_supplies_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_printing_stationery: {
    id: 'cpc_printing_stationery',
    type: 'calculated',
    subMeasures: ['fb_printing_stationery_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_printing_stationery_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_laundry: {
    id: 'cpc_laundry',
    type: 'calculated',
    subMeasures: ['fb_laundry_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_laundry_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },

  // --- Operating Equipment Usage per Cover ---
  // Per-item breakdown of the same atoms that roll up into cpc_operating_supplies.
  // Each row = item expense ÷ fb_total_covers_act (dollars per cover).
  cpc_flatware: {
    id: 'cpc_flatware',
    type: 'calculated',
    subMeasures: ['fb_flatware_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_flatware_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_china: {
    id: 'cpc_china',
    type: 'calculated',
    subMeasures: ['fb_china_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_china_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_kitchen_utensils: {
    id: 'cpc_kitchen_utensils',
    type: 'calculated',
    subMeasures: ['fb_kitchen_utensils_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_kitchen_utensils_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_linen: {
    id: 'cpc_linen',
    type: 'calculated',
    subMeasures: ['fb_linen_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_linen_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_glassware: {
    id: 'cpc_glassware',
    type: 'calculated',
    subMeasures: ['fb_glassware_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_glassware_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },
  cpc_smalls: {
    id: 'cpc_smalls',
    type: 'calculated',
    subMeasures: ['fb_smalls_act', 'fb_total_covers_act'],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures.fb_smalls_act || 0, ctx.subMeasures.fb_total_covers_act || 0, 0)
  },

  // --- Percentage of F&B Sales (canonical + Protea-aware variants) ---
  total_fb_payroll: { id: 'total_fb_payroll', type: 'simple', subMeasures: ['total_fb_payroll_act'] },
  total_fb_payroll_protea: {
    id: 'total_fb_payroll_protea',
    type: 'calculated',
    subMeasures: ['total_fb_payroll_act', 'fb_payroll_movement_act'],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures.total_fb_payroll_act || 0) + (ctx.subMeasures.fb_payroll_movement_act || 0)
  },
  total_fb_controllables: { id: 'total_fb_controllables', type: 'simple', subMeasures: ['total_fb_controllables_act'] },
  total_fb_controllables_protea: {
    id: 'total_fb_controllables_protea',
    type: 'calculated',
    subMeasures: ['total_fb_controllables_act', 'fb_payroll_movement_act'],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures.total_fb_controllables_act || 0) - (ctx.subMeasures.fb_payroll_movement_act || 0)
  },
  payroll_pct_fb_sales: {
    id: 'payroll_pct_fb_sales',
    type: 'calculated',
    subMeasures: ['total_fb_payroll_act', 'total_fb_revenue_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.total_fb_payroll_act || 0,
      ctx.subMeasures.total_fb_revenue_act || 0,
      0
    ) * 100
  },
  payroll_pct_fb_sales_protea: {
    id: 'payroll_pct_fb_sales_protea',
    type: 'calculated',
    subMeasures: ['total_fb_payroll_act', 'fb_payroll_movement_act', 'total_fb_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      const payroll = (ctx.subMeasures.total_fb_payroll_act || 0) + (ctx.subMeasures.fb_payroll_movement_act || 0);
      return evaluateDivide(payroll, ctx.subMeasures.total_fb_revenue_act || 0, 0) * 100;
    }
  },
  other_exp_pct_fb_sales: {
    id: 'other_exp_pct_fb_sales',
    type: 'calculated',
    subMeasures: ['total_fb_controllables_act', 'total_fb_revenue_act'],
    evaluator: (ctx: MeasureContext) => evaluateDivide(
      ctx.subMeasures.total_fb_controllables_act || 0,
      ctx.subMeasures.total_fb_revenue_act || 0,
      0
    ) * 100
  },
  other_exp_pct_fb_sales_protea: {
    id: 'other_exp_pct_fb_sales_protea',
    type: 'calculated',
    subMeasures: ['total_fb_controllables_act', 'fb_payroll_movement_act', 'total_fb_revenue_act'],
    evaluator: (ctx: MeasureContext) => {
      const controllables = (ctx.subMeasures.total_fb_controllables_act || 0) - (ctx.subMeasures.fb_payroll_movement_act || 0);
      return evaluateDivide(controllables, ctx.subMeasures.total_fb_revenue_act || 0, 0) * 100;
    }
  }
};

// ============================================================================
// "<group> Payroll/Other-Expenses as % of Hotel Revenue" — measure factory
//
// Generates the 3 sub-measures + 8 calculated measures needed for one group's
// pair of percent-of-revenue KPIs (Payroll + Other Expenses), in canonical
// AND Protea-aware variants. Used by Administrative & General, Property
// Operation & Maintenance, and Sales & Marketing — each group gets the same
// shape, only the dept-scope filter changes.
//
// Adding a new group is one factory call: registerPctOfRevenueQuartet({
//   key: 'newGroupKey',
//   deptFilter: { type: 'dept_level', level: 7, value: '<group label>' },
// }).
//
// Generated measure IDs follow this naming convention (search-friendly):
//   total_<key>_payroll_act              ← canonical sub-measure (Payroll)
//   total_<key>_controllables_act        ← canonical sub-measure (Controllables)
//   <key>_payroll_movement_act           ← Protea movement bucket sub-measure
//   total_<key>_payroll                  ← canonical measure (passthrough)
//   total_<key>_payroll_protea           ← Protea-aware (canonical + movement)
//   total_<key>_controllables            ← canonical measure (passthrough)
//   total_<key>_controllables_protea     ← Protea-aware (canonical − movement)
//   payroll_pct_revenue_<key>            ← KPI (canonical / hotel revenue × 100)
//   payroll_pct_revenue_<key>_protea     ← KPI (Protea-aware / hotel revenue × 100)
//   other_exp_pct_revenue_<key>          ← KPI (canonical / hotel revenue × 100)
//   other_exp_pct_revenue_<key>_protea   ← KPI (Protea-aware / hotel revenue × 100)
//
// Hotel-wide revenue denominator is `total_revenue_act` (existing measure;
// already negate:true so values come through positive).
//
// Protea movement: same PROTEA_PAYROLL_REPOINT_ACCOUNTS list as Rooms/F&B.
// If the repointed accounts don't post into a given group, the movement
// evaluates to 0 and the _protea variant matches canonical — safe.
// ============================================================================

const PCT_OF_REVENUE_DENOMINATOR_SUB_ID = 'total_revenue_act';

function registerPctOfRevenueQuartet(opts: {
  key: string;
  deptFilter: MeasureFilter;
}): void {
  const { key, deptFilter } = opts;
  const payrollSub        = `total_${key}_payroll_act`;
  const controllablesSub  = `total_${key}_controllables_act`;
  const movementSub       = `${key}_payroll_movement_act`;
  const denom             = PCT_OF_REVENUE_DENOMINATOR_SUB_ID;

  // --- Sub-measures ---
  SUB_MEASURES[payrollSub] = {
    id: payrollSub, formula: 'CALCULATE',
    filters: [deptFilter, { type: 'acc_level', level: 9, value: 'Total Payroll' }]
  };
  SUB_MEASURES[controllablesSub] = {
    id: controllablesSub, formula: 'CALCULATE',
    filters: [
      deptFilter,
      { type: 'acc_level', level: 4, value: 'Profit Amount' },
      { type: 'acc_level_not_in', level: 6, value: ['Revenue'] },
      { type: 'acc_level_not_in', level: 9, value: ['Total Payroll', 'Cost Of Sales'] }
    ]
  };
  SUB_MEASURES[movementSub] = {
    id: movementSub, formula: 'CALCULATE',
    filters: [deptFilter, { type: 'acc_base', value: PROTEA_PAYROLL_REPOINT_ACCOUNTS }]
  };

  // --- Calculated measures ---
  MEASURES[`total_${key}_payroll`] = { id: `total_${key}_payroll`, type: 'simple', subMeasures: [payrollSub] };
  MEASURES[`total_${key}_payroll_protea`] = {
    id: `total_${key}_payroll_protea`, type: 'calculated',
    subMeasures: [payrollSub, movementSub],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures[payrollSub] || 0) + (ctx.subMeasures[movementSub] || 0)
  };
  MEASURES[`total_${key}_controllables`] = { id: `total_${key}_controllables`, type: 'simple', subMeasures: [controllablesSub] };
  MEASURES[`total_${key}_controllables_protea`] = {
    id: `total_${key}_controllables_protea`, type: 'calculated',
    subMeasures: [controllablesSub, movementSub],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures[controllablesSub] || 0) - (ctx.subMeasures[movementSub] || 0)
  };
  MEASURES[`payroll_pct_revenue_${key}`] = {
    id: `payroll_pct_revenue_${key}`, type: 'calculated',
    subMeasures: [payrollSub, denom],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures[payrollSub] || 0, ctx.subMeasures[denom] || 0, 0) * 100
  };
  MEASURES[`payroll_pct_revenue_${key}_protea`] = {
    id: `payroll_pct_revenue_${key}_protea`, type: 'calculated',
    subMeasures: [payrollSub, movementSub, denom],
    evaluator: (ctx: MeasureContext) => {
      const payroll = (ctx.subMeasures[payrollSub] || 0) + (ctx.subMeasures[movementSub] || 0);
      return evaluateDivide(payroll, ctx.subMeasures[denom] || 0, 0) * 100;
    }
  };
  MEASURES[`other_exp_pct_revenue_${key}`] = {
    id: `other_exp_pct_revenue_${key}`, type: 'calculated',
    subMeasures: [controllablesSub, denom],
    evaluator: (ctx: MeasureContext) =>
      evaluateDivide(ctx.subMeasures[controllablesSub] || 0, ctx.subMeasures[denom] || 0, 0) * 100
  };
  MEASURES[`other_exp_pct_revenue_${key}_protea`] = {
    id: `other_exp_pct_revenue_${key}_protea`, type: 'calculated',
    subMeasures: [controllablesSub, movementSub, denom],
    evaluator: (ctx: MeasureContext) => {
      const controllables = (ctx.subMeasures[controllablesSub] || 0) - (ctx.subMeasures[movementSub] || 0);
      return evaluateDivide(controllables, ctx.subMeasures[denom] || 0, 0) * 100;
    }
  };
}

// Register the three undistributed-operating-expense groups. Add a row here
// (and a matching entry in proteaShared.ts PCT_OF_REVENUE_KPI_GROUPS) to
// enable the KPI block on a new group summary sheet.
registerPctOfRevenueQuartet({
  key: 'ag',
  deptFilter: { type: 'dept_level', level: 7, value: 'Administrative & General' }
});
registerPctOfRevenueQuartet({
  key: 'pom',
  deptFilter: { type: 'dept_level', level: 7, value: 'Property Operation & Maintenance' }
});
registerPctOfRevenueQuartet({
  key: 'sm',
  deptFilter: { type: 'dept_level', level: 7, value: 'Sales & Marketing and Convention Service' }
});

// Merge the Protea Payroll tab's sub-measures and measures. Defined in their
// own module so the per-department / per-account boilerplate stays compact
// and so the Payroll tab can evolve without churning this file. Order matters:
// must run AFTER the manual rooms/fb _protea definitions and AFTER the three
// registerPctOfRevenueQuartet calls above so the registry is fully populated
// before downstream consumers (calculation engine init) read it.
Object.assign(SUB_MEASURES, PROTEA_PAYROLL_SUB_MEASURES);
Object.assign(MEASURES, PROTEA_PAYROLL_MEASURES);
