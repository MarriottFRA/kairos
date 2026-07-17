import { PLRow } from '../../types/plReportTypes';
import { ROOMS_KPI_ROW_CONFIG } from './roomsKpiRowConfig';

// ============================================================================
// F90 P&L ROW CONFIGURATION (MARRIOTT)
// Defines the structure and ordering of the F90 P&L report
//
// SIGN CONVENTION RULES:
// - Credit-balance accounts (revenue, profit, EBITDA, GOP): sub-measures already
//   have negate:true which converts the negative DB credit to a positive display
//   value.  Do NOT add invertSign here — that would double-negate back to negative.
// - Debit-balance accounts (operating expenses, management fees): stored as
//   positive debits in the DB.  Sub-measures have negate:true which flips them
//   negative, so invertSign:true IS needed here to restore a positive display value.
// ============================================================================

export const F90_PL_ROW_CONFIG: PLRow[] = [
  // Sales Section — credit-balance accounts, no invertSign needed
  { type: 'header', label: 'SALES', indentLevel: 0 },
  { type: 'measure', label: 'Rooms and Reservations', measureId: 'rooms_reservations_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Gift Shops', measureId: 'gift_shop_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Restaurants and Rooms Service', measureId: 'restaurants_room_service_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Lounges', measureId: 'lounges_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Audio Visual', measureId: 'audio_visual_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Banquets', measureId: 'banquets_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Total F&B', measureId: 'total_fb_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Leisure & Recreation', measureId: 'leisure_recreation_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Golf', measureId: 'golf_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Spa', measureId: 'spa_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Casino', measureId: 'casino_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Miscellaneous Income', measureId: 'misc_income_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Drycleaning - In House', measureId: 'drycleaning_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Garage', measureId: 'garage_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Guest Communications', measureId: 'guest_communications_revenue', formatting: 'number', indentLevel: 1 },
  { type: 'header', label: 'Total Other Departments Sales', measureId: 'total_other_dept_sales', formatting: 'number', indentLevel: 1 },
  { type: 'header', label: 'TOTAL SALES', measureId: 'total_sales', formatting: 'number', indentLevel: 0 },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // Department Profit Section — net of revenue credits and expense debits; the net
  // is a credit when profitable, so negate:true in the sub-measure already gives a
  // positive value.  No invertSign needed.
  { type: 'header', label: 'DEPARTMENT PROFIT', indentLevel: 0 },
  { type: 'measure', label: 'Rooms and Reservations', measureId: 'rooms_reservations_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Gift Shops', measureId: 'gift_shop_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Restaurants and Rooms Service', measureId: 'restaurants_room_service_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Lounges', measureId: 'lounges_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Audio Visual', measureId: 'audio_visual_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Banquets', measureId: 'banquets_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Total F&B', measureId: 'total_fb_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Leisure & Recreation', measureId: 'leisure_recreation_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Golf', measureId: 'golf_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Spa', measureId: 'spa_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Casino', measureId: 'casino_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Miscellaneous Income', measureId: 'misc_income_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Drycleaning - In House', measureId: 'drycleaning_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Garage', measureId: 'garage_profit', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Guest Communications', measureId: 'guest_communications_profit', formatting: 'number', indentLevel: 1 },
  { type: 'header', label: 'Total Other Departments Profit', measureId: 'total_other_dept_profit', formatting: 'number', indentLevel: 1 },
  { type: 'header', label: 'TOTAL DEPT PROFIT', measureId: 'total_dept_profit', formatting: 'number', indentLevel: 0 },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // Undistributed Operating Expenses — debit-balance accounts stored as positive in
  // the DB.  negate:true in the sub-measure flips them negative, so invertSign:true
  // IS required here to restore a positive display value.
  { type: 'header', label: 'UNDISTRIBUTED OPERATING EXPENSES', indentLevel: 0 },
  { type: 'measure', label: 'Administrative and General', measureId: 'admin_general_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Human Resources', measureId: 'human_resources_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Loss Prevention', measureId: 'loss_prevention_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Accounting', measureId: 'accounting_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'ADMINISTRATIVE & GENERAL', measureId: 'admin_general_dept_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Information & Telecom Systems', measureId: 'info_telecom_systems_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Utilities', measureId: 'utilities_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Property Operation & Maint', measureId: 'property_operation_maint_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Sales & Marketing', measureId: 'sales_marketing_expense', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'header', label: 'TOTAL UNDISTRIBUTED OP EXP', measureId: 'total_undist_op_exp', formatting: 'number', indentLevel: 0, invertSign: true },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // Gross Operating Profit — credit-balance account, no invertSign needed
  { type: 'header', label: 'GROSS OPERATING PROFIT', measureId: 'gross_operating_profit', formatting: 'number', indentLevel: 0 },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // Management Fees — debit-balance accounts (same as expenses), invertSign:true needed
  { type: 'header', label: 'MANAGEMENT FEES', indentLevel: 0 },
  { type: 'measure', label: 'Base Management Fee', measureId: 'base_mgmt_fee', formatting: 'number', indentLevel: 1, invertSign: true },
  { type: 'measure', label: 'Incentive Management Fee', measureId: 'incentive_mgmt_fee', formatting: 'number', indentLevel: 1, invertSign: true },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // EBITDA — credit-balance account, no invertSign needed
  { type: 'header', label: 'EBITDA', measureId: 'ebitda', formatting: 'number', indentLevel: 0 },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // Net Due To/(From) Owner — credit-balance account, no invertSign needed
  { type: 'measure', label: 'NET DUE TO/(FROM) OWNER', measureId: 'net_due_owner', formatting: 'number', indentLevel: 0 },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // Key Statistics
  { type: 'header', label: 'KEY STATISTICS', indentLevel: 0 },
  { type: 'measure', label: 'Total Rooms', measureId: 'total_rooms', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Rooms SOLD', measureId: 'sold_rooms', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Total Occupancy', measureId: 'occupancy_rooms_act_sy', formatting: 'percentage', indentLevel: 1 },
  // ADR and RevPAR are derived from revenue sub-measures (already positive after negate:true),
  // so no invertSign needed.
  { type: 'measure', label: 'Average Rate', measureId: 'adr_act_sy', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Room REVPAR', measureId: 'rev_par_act_sy', formatting: 'number', indentLevel: 1 },
  { type: 'measure', label: 'Total REVPAR', measureId: 'all_rev_par_act_sy', formatting: 'number', indentLevel: 1 },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // Cost of Sales Percentages — ratios, no sign inversion needed
  { type: 'measure', label: '% Food COS', measureId: 'food_cost_pct_sales', formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: '% Beverage COS', measureId: 'bev_cost_pct_sales', formatting: 'percentage', indentLevel: 1 },

  // Spacing
  { type: 'header', label: '', indentLevel: 0 },

  // Rooms & Reservation Summary KPI block (shared mapping table — also used by
  // Summary P&L and Marriott Excel Export). Engine-driven: edits flow from
  // roomsKpiRowConfig.ts to all three reports automatically.
  ...ROOMS_KPI_ROW_CONFIG,
];
