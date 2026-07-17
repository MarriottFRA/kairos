/**
 * Protea Payroll Tab — measure registry
 *
 * Programmatically generates the sub-measures + measures consumed by the
 * Payroll worksheet (proteaPayrollPLRowConfig.ts).
 *
 * Naming convention (search-friendly):
 *   payroll_<dept>_assoc_wages_act     ← sub-measure: dept × level_12 Associate Wages
 *   payroll_<dept>_contracts_act       ← sub-measure: dept × base_account A631208
 *   payroll_<dept>_assoc_count_act     ← sub-measure: dept × A972540 (perm headcount)
 *   payroll_<dept>_contract_count_act  ← sub-measure: dept × A988111 (contract headcount)
 *   payroll_<dept>_<x>                 ← simple measure wrapping the _act sub-measure
 *
 * Lodging-Operations-scope sub-measures are keyed with dept='lodging'.
 *
 * Reuses existing per-department `total_<key>_payroll_protea` measures where
 * they exist (rooms, fb registered manually in plMeasureDefinitions.ts;
 * ag, pom, sm registered via registerPctOfRevenueQuartet there). Adds the
 * missing departments (other_ops, util, it) and Lodging Operations.
 *
 * The "NOT BENEFITS ACCOUNT" repointed accounts (A610112, A652101, A632007)
 * are sourced via PROTEA_PAYROLL_REPOINT_ACCOUNTS so adding/removing a
 * repoint in proteaMovements.ts cascades through automatically — DO NOT
 * hardcode this list anywhere in this file.
 */

import { SubMeasure, Measure, MeasureContext } from '../../types/plReportTypes';
import { PROTEA_PAYROLL_REPOINT_ACCOUNTS } from './proteaMovements';

// ----------------------------------------------------------------------------
// Department config — single source of truth for every per-dept row
// ----------------------------------------------------------------------------

export interface PayrollDept {
  /** stable measure-id key */
  key: string;
  /** display label for the row */
  label: string;
  /** level_7 value(s) matching account_maps. Array values OR-match across level_7. */
  level7: string | string[];
}

export const PAYROLL_DEPTS: readonly PayrollDept[] = [
  { key: 'rooms',    label: 'Rooms and Reservations',           level7: 'Rooms and Reservation' },
  { key: 'fb',       label: 'Food & Beverage',                  level7: 'Total Food & Beverage' },
  // IT is folded into Administrative & General by OR-matching both level_7 values.
  { key: 'ag',       label: 'Administrative & General',         level7: ['Administrative & General', 'Information & Telecom Systems'] },
  { key: 'mkt',      label: 'Sales & Marketing',                level7: 'Sales & Marketing and Convention Service' },
  { key: 'pom',      label: 'Property Operations & Maintenance',level7: 'Property Operation & Maintenance' },
  { key: 'other_ops',label: 'Other Operated Departments',       level7: 'Other Operated Departments' },
  { key: 'util',     label: 'Utilities',                        level7: 'Utilities Dept' },
] as const;

export const LODGING_LEVEL2 = 'Lodging Operations';

/**
 * Per-department key → existing `total_<key>_payroll_protea` measure id.
 * Used by the STAFF EXPENSES SUMMARY 'Salaries' rows.
 *
 * 'rooms' and 'fb' are registered manually in plMeasureDefinitions.ts.
 * 'ag', 'pom', 'sm' are registered there via registerPctOfRevenueQuartet —
 * note 'mkt' in this file maps to 'sm' there (Sales & Marketing).
 * 'other_ops', 'util' are registered below in this file.
 *
 * For 'ag' the Payroll-tab consumer (addStaffSummaryMeasure) overrides the
 * sub-measures to fold IT in — see payroll_tab_ag_payroll_act below.
 */
export const PROTEA_PAYROLL_DEPT_TO_PROTEA_MEASURE: Record<string, string> = {
  rooms:     'total_rooms_payroll_protea',
  fb:        'total_fb_payroll_protea',
  ag:        'total_ag_payroll_protea',
  mkt:       'total_sm_payroll_protea',
  pom:       'total_pom_payroll_protea',
  other_ops: 'total_other_ops_payroll_protea',
  util:      'total_util_payroll_protea',
};

// ----------------------------------------------------------------------------
// Payroll Burden line items — dynamic.
//
// The set of burden lines is discovered at report-build time from the data
// itself (see db.getProteaPayrollBurdenAccounts): every base_account in
// scope Lodging Operations × (level_12 'Associate Benefits' OR the 3
// repointed NOT BENEFITS accounts) that has any non-zero ACT/BUD/LY across
// the displayed periods. The previous static 15-line list + 'Other'
// catch-all has been removed — Total Payroll Burden still resolves via the
// engine-level `payroll_total_burden` (Associate Benefits + NOT BENEFITS
// aggregates), so adding/removing a discovered line never alters the total.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Builders
// ----------------------------------------------------------------------------

const SUB: Record<string, SubMeasure> = {};
const MEA: Record<string, Measure> = {};

/** Per-department sub-measure: dept_level=7 + acc_base=accountList. */
function addDeptAccountSub(id: string, level7: string | string[], account: string | string[]): void {
  SUB[id] = {
    id,
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: level7 },
      { type: 'acc_base', value: account },
    ],
  };
}

/** Per-department sub-measure: dept_level=7 + acc_level=12 Associate Wages. */
function addDeptAssocWagesSub(id: string, level7: string | string[]): void {
  SUB[id] = {
    id,
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 7, value: level7 },
      { type: 'acc_level', level: 12, value: 'Associate Wages' },
    ],
  };
}

/** Lodging Ops sub-measure: dept_level=2 + acc_base=accountList. */
function addLodgingAccountSub(id: string, account: string | string[]): void {
  SUB[id] = {
    id,
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: 2, value: LODGING_LEVEL2 },
      { type: 'acc_base', value: account },
    ],
  };
}

/** Simple passthrough measure → wraps a single sub-measure. */
function addSimple(id: string, subId: string): void {
  MEA[id] = { id, type: 'simple', subMeasures: [subId] };
}

// ----------------------------------------------------------------------------
// 1) Per-department × Associate Wages  (Salaries → Perm. & Fixed Term section)
//    Per-department × A631208           (Salaries → Contracts section)
//    Per-department × A972540           (Employee Numbers → Perm. & Fixed Term)
//    Per-department × A988111           (Employee Numbers → Casuals)
// ----------------------------------------------------------------------------

for (const d of PAYROLL_DEPTS) {
  const wagesSub    = `payroll_${d.key}_assoc_wages_act`;
  const contractSub = `payroll_${d.key}_contracts_act`;
  const headSub     = `payroll_${d.key}_assoc_count_act`;
  const casualSub   = `payroll_${d.key}_contract_count_act`;

  addDeptAssocWagesSub(wagesSub, d.level7);
  addDeptAccountSub(contractSub, d.level7, 'A631208');
  addDeptAccountSub(headSub,     d.level7, 'A972540');
  addDeptAccountSub(casualSub,   d.level7, 'A988111');

  addSimple(`payroll_${d.key}_assoc_wages`,    wagesSub);
  addSimple(`payroll_${d.key}_contracts`,      contractSub);
  addSimple(`payroll_${d.key}_assoc_count`,    headSub);
  addSimple(`payroll_${d.key}_contract_count`, casualSub);
}

// ----------------------------------------------------------------------------
// 2) Lodging Operations totals — Salaries section
// ----------------------------------------------------------------------------

// Total Perm. & Fixed Term Wages (Lodging Ops × Associate Wages level_12)
SUB['payroll_lodging_assoc_wages_act'] = {
  id: 'payroll_lodging_assoc_wages_act',
  formula: 'CALCULATE',
  filters: [
    { type: 'dept_level', level: 2, value: LODGING_LEVEL2 },
    { type: 'acc_level', level: 12, value: 'Associate Wages' },
  ],
};
addSimple('payroll_lodging_assoc_wages', 'payroll_lodging_assoc_wages_act');

// Total Contracts (Lodging Ops × A631208)
addLodgingAccountSub('payroll_lodging_contracts_act', 'A631208');
addSimple('payroll_lodging_contracts', 'payroll_lodging_contracts_act');

// Total Salaries/Casuals/Incentives = Wages + Contracts at Lodging Ops level
MEA['payroll_lodging_salaries_total'] = {
  id: 'payroll_lodging_salaries_total',
  type: 'calculated',
  subMeasures: ['payroll_lodging_assoc_wages_act', 'payroll_lodging_contracts_act'],
  evaluator: (ctx: MeasureContext) =>
    (ctx.subMeasures.payroll_lodging_assoc_wages_act || 0)
    + (ctx.subMeasures.payroll_lodging_contracts_act || 0),
};

// ----------------------------------------------------------------------------
// 3) Payroll Burden — individual line items are registered DYNAMICALLY at
//    report-build time via registerProteaBurdenLineMeasures() below. The
//    aggregate sub-measures (Associate Benefits + NOT BENEFITS) used by
//    payroll_total_burden and all KPIs are registered here statically so the
//    total + KPI surface is independent of which lines happen to have data.
// ----------------------------------------------------------------------------

// Canonical level_12 Associate Benefits aggregate at Lodging Ops scope
SUB['payroll_lodging_assoc_benefits_act'] = {
  id: 'payroll_lodging_assoc_benefits_act',
  formula: 'CALCULATE',
  filters: [
    { type: 'dept_level', level: 2, value: LODGING_LEVEL2 },
    { type: 'acc_level', level: 12, value: 'Associate Benefits' },
  ],
};

// Sum of the 3 NOT BENEFITS (repointed) accounts at Lodging Ops scope
SUB['payroll_lodging_not_benefits_act'] = {
  id: 'payroll_lodging_not_benefits_act',
  formula: 'CALCULATE',
  filters: [
    { type: 'dept_level', level: 2, value: LODGING_LEVEL2 },
    { type: 'acc_base', value: PROTEA_PAYROLL_REPOINT_ACCOUNTS },
  ],
};

// Total Payroll Burden = Associate Benefits + the 3 NOT BENEFITS accounts.
// Spec-corrected per user: the 3 repointed accounts count toward the burden
// total even though they sit outside level_12 Associate Benefits.
MEA['payroll_total_burden'] = {
  id: 'payroll_total_burden',
  type: 'calculated',
  subMeasures: ['payroll_lodging_assoc_benefits_act', 'payroll_lodging_not_benefits_act'],
  evaluator: (ctx: MeasureContext) =>
    (ctx.subMeasures.payroll_lodging_assoc_benefits_act || 0)
    + (ctx.subMeasures.payroll_lodging_not_benefits_act || 0),
};

// ----------------------------------------------------------------------------
// 4) STAFF EXPENSES SUMMARY — per-department & Lodging Ops _protea totals
//    for the departments NOT already registered in plMeasureDefinitions.ts.
//    (rooms, fb, ag, pom, sm are already present there.)
// ----------------------------------------------------------------------------

function registerPayrollProtea(key: string, deptLevel: number, deptValue: string | string[]): void {
  const payrollSub  = `total_${key}_payroll_act`;
  const movementSub = `${key}_payroll_movement_act`;

  SUB[payrollSub] = {
    id: payrollSub,
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: deptLevel, value: deptValue },
      { type: 'acc_level', level: 9, value: 'Total Payroll' },
    ],
  };
  SUB[movementSub] = {
    id: movementSub,
    formula: 'CALCULATE',
    filters: [
      { type: 'dept_level', level: deptLevel, value: deptValue },
      { type: 'acc_base', value: PROTEA_PAYROLL_REPOINT_ACCOUNTS },
    ],
  };
  MEA[`total_${key}_payroll`] = { id: `total_${key}_payroll`, type: 'simple', subMeasures: [payrollSub] };
  MEA[`total_${key}_payroll_protea`] = {
    id: `total_${key}_payroll_protea`,
    type: 'calculated',
    subMeasures: [payrollSub, movementSub],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures[payrollSub] || 0) + (ctx.subMeasures[movementSub] || 0),
  };
}

registerPayrollProtea('other_ops', 7, 'Other Operated Departments');
registerPayrollProtea('util',      7, 'Utilities Dept');
registerPayrollProtea('lodging',   2, LODGING_LEVEL2);

// Payroll-tab-local AG+IT merged sub-measures. The shared `total_ag_payroll_act`
// (registered in plMeasureDefinitions.ts via registerPctOfRevenueQuartet) only
// filters on 'Administrative & General' level_7 and is consumed by F90 P&L /
// SY scenario tabs — we must not pollute it. Instead these tab-local atoms
// fold IT into AG ONLY for the Payroll tab's Staff Expenses Summary.
const AG_IT_LEVEL7: readonly string[] = ['Administrative & General', 'Information & Telecom Systems'];
SUB['payroll_tab_ag_payroll_act'] = {
  id: 'payroll_tab_ag_payroll_act',
  formula: 'CALCULATE',
  filters: [
    { type: 'dept_level', level: 7, value: [...AG_IT_LEVEL7] },
    { type: 'acc_level', level: 9, value: 'Total Payroll' },
  ],
};
SUB['payroll_tab_ag_movement_act'] = {
  id: 'payroll_tab_ag_movement_act',
  formula: 'CALCULATE',
  filters: [
    { type: 'dept_level', level: 7, value: [...AG_IT_LEVEL7] },
    { type: 'acc_base', value: PROTEA_PAYROLL_REPOINT_ACCOUNTS },
  ],
};

// Staff-summary measure per dept (and Lodging Ops) = Total Payroll (incl.
// repointed NOT BENEFITS accounts) + A631208 Contracts. Contracts sit
// outside level_9 Total Payroll in the source hierarchy, so they have to be
// added here explicitly. This measure is consumed ONLY by the Payroll tab's
// STAFF EXPENSES SUMMARY section — do not reuse it for KPI calculations
// without confirming the denominator definition.
// Payroll-tab dept key → atoms key registered in plMeasureDefinitions.ts.
// Most dept keys match 1:1; 'mkt' is the Payroll-tab label for the group
// that plMeasureDefinitions registers under 'sm' (Sales & Marketing) via
// registerPctOfRevenueQuartet. Keep this in sync with that registration.
const STAFF_SUMMARY_ATOMS_KEY: Record<string, string> = { mkt: 'sm' };

function addStaffSummaryMeasure(key: string, proteaMeasureId: string, contractsSubId: string): void {
  // The protea measure is itself calculated from two sub-measures; we depend
  // on those atoms directly so the engine has everything in one context.
  // For 'ag' we point at the Payroll-tab-local atoms that fold IT into AG;
  // other reports' AG measures stay untouched.
  const atomsKey   = STAFF_SUMMARY_ATOMS_KEY[key] ?? key;
  const payrollSub  = key === 'ag' ? 'payroll_tab_ag_payroll_act'   : `total_${atomsKey}_payroll_act`;
  const movementSub = key === 'ag' ? 'payroll_tab_ag_movement_act' : `${atomsKey}_payroll_movement_act`;
  MEA[`payroll_${key}_staff_summary`] = {
    id: `payroll_${key}_staff_summary`,
    type: 'calculated',
    subMeasures: [payrollSub, movementSub, contractsSubId],
    evaluator: (ctx: MeasureContext) =>
      (ctx.subMeasures[payrollSub] || 0)
      + (ctx.subMeasures[movementSub] || 0)
      + (ctx.subMeasures[contractsSubId] || 0),
  };
  // proteaMeasureId is kept as a parameter for cross-reference / future
  // hardening (e.g. if the engine ever materialises calculated measures into
  // the sub-measures context); currently unused at evaluator time.
  void proteaMeasureId;
}

for (const d of PAYROLL_DEPTS) {
  addStaffSummaryMeasure(
    d.key,
    PROTEA_PAYROLL_DEPT_TO_PROTEA_MEASURE[d.key],
    `payroll_${d.key}_contracts_act`
  );
}
addStaffSummaryMeasure('lodging', 'total_lodging_payroll_protea', 'payroll_lodging_contracts_act');

// ----------------------------------------------------------------------------
// 5) Employee Numbers — Lodging Ops totals + Total STAFF combined
// ----------------------------------------------------------------------------

addLodgingAccountSub('payroll_lodging_assoc_count_act',    'A972540');
addLodgingAccountSub('payroll_lodging_contract_count_act', 'A988111');
// Total STAFF combined sum — multi-account base filter (proven pattern).
addLodgingAccountSub('payroll_lodging_total_staff_act',    ['A972540', 'A988111']);

addSimple('payroll_lodging_assoc_count',    'payroll_lodging_assoc_count_act');
addSimple('payroll_lodging_contract_count', 'payroll_lodging_contract_count_act');
addSimple('payroll_lodging_total_staff',    'payroll_lodging_total_staff_act');

// ----------------------------------------------------------------------------
// 6) Payroll KPIs — bottom-of-page % and per-room-night ratios
//
// These reuse Lodging-Ops payroll atoms registered above plus three
// cross-page atoms registered in plMeasureDefinitions.ts:
//   total_revenue_act    — Lodging Ops × level_6 Revenue (negate=true → +)
//   total_rooms_act      — level_10 Rooms × A960101 (rooms available)
//   sold_rooms_act       — level_10 Rooms × A960103 (rooms sold)
// The engine only flattens SubMeasure atoms into ctx.subMeasures (not other
// Measure aggregates), so each KPI declares its leaf atoms directly and
// recomposes the small sums inline — mirrors payroll_total_burden above.
// ----------------------------------------------------------------------------

const safeDiv = (n: number, d: number): number => (d === 0 ? 0 : n / d);

// % of Total Revenue ---------------------------------------------------------

// Total Staff Expenses (incl. Contracts) % of Revenue.
// Numerator atoms mirror payroll_lodging_staff_summary at line 384.
MEA['payroll_kpi_staff_exp_pct_rev'] = {
  id: 'payroll_kpi_staff_exp_pct_rev',
  type: 'calculated',
  subMeasures: [
    'total_lodging_payroll_act',
    'lodging_payroll_movement_act',
    'payroll_lodging_contracts_act',
    'total_revenue_act',
  ],
  evaluator: (ctx: MeasureContext) => {
    const staff = (ctx.subMeasures.total_lodging_payroll_act || 0)
      + (ctx.subMeasures.lodging_payroll_movement_act || 0)
      + (ctx.subMeasures.payroll_lodging_contracts_act || 0);
    return safeDiv(staff, ctx.subMeasures.total_revenue_act || 0) * 100;
  },
};

// Salaries/Casuals/Incentives % of Revenue (wages + A631208 contracts).
MEA['payroll_kpi_salaries_pct_rev'] = {
  id: 'payroll_kpi_salaries_pct_rev',
  type: 'calculated',
  subMeasures: [
    'payroll_lodging_assoc_wages_act',
    'payroll_lodging_contracts_act',
    'total_revenue_act',
  ],
  evaluator: (ctx: MeasureContext) => {
    const sal = (ctx.subMeasures.payroll_lodging_assoc_wages_act || 0)
      + (ctx.subMeasures.payroll_lodging_contracts_act || 0);
    return safeDiv(sal, ctx.subMeasures.total_revenue_act || 0) * 100;
  },
};

// Direct Labour Cost % of Revenue = (Perm. & Fixed Term + Total Payroll Burden)
// / Revenue. Per spec: EXCLUDES contracts and casuals/incentives.
MEA['payroll_kpi_direct_labour_pct_rev'] = {
  id: 'payroll_kpi_direct_labour_pct_rev',
  type: 'calculated',
  subMeasures: [
    'payroll_lodging_assoc_wages_act',
    'payroll_lodging_assoc_benefits_act',
    'payroll_lodging_not_benefits_act',
    'total_revenue_act',
  ],
  evaluator: (ctx: MeasureContext) => {
    const dl = (ctx.subMeasures.payroll_lodging_assoc_wages_act || 0)
      + (ctx.subMeasures.payroll_lodging_assoc_benefits_act || 0)
      + (ctx.subMeasures.payroll_lodging_not_benefits_act || 0);
    return safeDiv(dl, ctx.subMeasures.total_revenue_act || 0) * 100;
  },
};

// Payroll Burden % of Revenue.
MEA['payroll_kpi_burden_pct_rev'] = {
  id: 'payroll_kpi_burden_pct_rev',
  type: 'calculated',
  subMeasures: [
    'payroll_lodging_assoc_benefits_act',
    'payroll_lodging_not_benefits_act',
    'total_revenue_act',
  ],
  evaluator: (ctx: MeasureContext) => {
    const burden = (ctx.subMeasures.payroll_lodging_assoc_benefits_act || 0)
      + (ctx.subMeasures.payroll_lodging_not_benefits_act || 0);
    return safeDiv(burden, ctx.subMeasures.total_revenue_act || 0) * 100;
  },
};

// % of Salaries -------------------------------------------------------------

// Total Payroll Burden as % of Perm. & Fixed Term wages (EXCL contractors).
MEA['payroll_kpi_burden_pct_salaries_excl_contractors'] = {
  id: 'payroll_kpi_burden_pct_salaries_excl_contractors',
  type: 'calculated',
  subMeasures: [
    'payroll_lodging_assoc_benefits_act',
    'payroll_lodging_not_benefits_act',
    'payroll_lodging_assoc_wages_act',
  ],
  evaluator: (ctx: MeasureContext) => {
    const burden = (ctx.subMeasures.payroll_lodging_assoc_benefits_act || 0)
      + (ctx.subMeasures.payroll_lodging_not_benefits_act || 0);
    return safeDiv(burden, ctx.subMeasures.payroll_lodging_assoc_wages_act || 0) * 100;
  },
};

// Other ratios --------------------------------------------------------------

// STAFF per Room available = Total STAFF / (rooms available per day).
// Rooms per day = total_rooms_act ÷ periodDays so the ratio is comparable
// across single-month vs multi-month custom ranges. Mirrors rooms_available_per_day.
MEA['payroll_kpi_staff_per_room_avail'] = {
  id: 'payroll_kpi_staff_per_room_avail',
  type: 'calculated',
  subMeasures: ['payroll_lodging_total_staff_act', 'total_rooms_act'],
  evaluator: (ctx: MeasureContext) => {
    const roomsPerDay = safeDiv(ctx.subMeasures.total_rooms_act || 0, ctx.periodDays || 0);
    return safeDiv(ctx.subMeasures.payroll_lodging_total_staff_act || 0, roomsPerDay);
  },
};

// Per Room Night Sold -------------------------------------------------------

// Total Salaries/Casuals/Incentives ÷ rooms sold.
MEA['payroll_kpi_salaries_per_room_sold'] = {
  id: 'payroll_kpi_salaries_per_room_sold',
  type: 'calculated',
  subMeasures: [
    'payroll_lodging_assoc_wages_act',
    'payroll_lodging_contracts_act',
    'sold_rooms_act',
  ],
  evaluator: (ctx: MeasureContext) => {
    const sal = (ctx.subMeasures.payroll_lodging_assoc_wages_act || 0)
      + (ctx.subMeasures.payroll_lodging_contracts_act || 0);
    return safeDiv(sal, ctx.subMeasures.sold_rooms_act || 0);
  },
};

// Total Payroll Burden ÷ rooms sold.
MEA['payroll_kpi_burden_per_room_sold'] = {
  id: 'payroll_kpi_burden_per_room_sold',
  type: 'calculated',
  subMeasures: [
    'payroll_lodging_assoc_benefits_act',
    'payroll_lodging_not_benefits_act',
    'sold_rooms_act',
  ],
  evaluator: (ctx: MeasureContext) => {
    const burden = (ctx.subMeasures.payroll_lodging_assoc_benefits_act || 0)
      + (ctx.subMeasures.payroll_lodging_not_benefits_act || 0);
    return safeDiv(burden, ctx.subMeasures.sold_rooms_act || 0);
  },
};

// Contract expense (A631208) ÷ rooms sold.
MEA['payroll_kpi_contracts_per_room_sold'] = {
  id: 'payroll_kpi_contracts_per_room_sold',
  type: 'calculated',
  subMeasures: ['payroll_lodging_contracts_act', 'sold_rooms_act'],
  evaluator: (ctx: MeasureContext) => safeDiv(
    ctx.subMeasures.payroll_lodging_contracts_act || 0,
    ctx.subMeasures.sold_rooms_act || 0,
  ),
};

// ----------------------------------------------------------------------------
// 7) Dynamic burden-line registration
//
// Per-account burden sub-measures (`payroll_burden_acct_<base>_act`) and
// their simple wrappers are registered at report-build time from the list
// of accounts discovered in the source data (see proteaReportPackService
// → db.getProteaPayrollBurdenAccounts). IDs are stable per GL code, so
// repeated calls for the same OU/period are idempotent and the engine
// registries stay bounded across a session.
//
// Sign convention: identical to the other Lodging-Ops sub-measures here —
// no invertSign; payroll expenses are stored as positive debits.
// ----------------------------------------------------------------------------

export function registerProteaBurdenLineMeasures(
  accounts: readonly string[],
  subReg: Record<string, SubMeasure>,
  meaReg: Record<string, Measure>
): void {
  for (const base of accounts) {
    const subId = `payroll_burden_acct_${base}_act`;
    const meaId = `payroll_burden_acct_${base}`;
    if (subReg[subId]) continue;
    subReg[subId] = {
      id: subId,
      formula: 'CALCULATE',
      filters: [
        { type: 'dept_level', level: 2, value: LODGING_LEVEL2 },
        { type: 'acc_base', value: base },
      ],
    };
    meaReg[meaId] = { id: meaId, type: 'simple', subMeasures: [subId] };
  }
}

// ----------------------------------------------------------------------------
// Exports — consumed by plMeasureDefinitions.ts (Object.assign at end-of-file)
// ----------------------------------------------------------------------------

export const PROTEA_PAYROLL_SUB_MEASURES: Record<string, SubMeasure> = SUB;
export const PROTEA_PAYROLL_MEASURES: Record<string, Measure> = MEA;
