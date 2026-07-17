/**
 * Protea Payroll Tab — row configuration
 *
 * Built programmatically off PAYROLL_DEPTS (per-department rows) and a
 * caller-supplied list of dynamically-discovered burden lines (the actual
 * base_accounts that have data in the source). Adding a department is
 * still a one-line edit to proteaPayrollMeasures.ts; adding a burden line
 * needs no code change — post a non-zero amount to an account that sits in
 * Lodging Operations × (level_12 'Associate Benefits' OR a repointed NOT
 * BENEFITS account) and it appears automatically.
 *
 * Sign convention:
 *   Payroll sub-measures (Associate Wages, A631208, burden accounts) have
 *   NO negate:true in the calculation engine, so the engine returns the raw
 *   stored amount. Expense accounts are stored as positive debits in this
 *   codebase (verified by payroll_pct_rooms_sales_protea returning a
 *   positive percentage of revenue without inversion), so we leave
 *   invertSign off on every row here. Same convention applies to the
 *   headcount accounts (A972540, A988111), which are positive stats.
 */

import { PLRow } from '../../types/plReportTypes';
import { PAYROLL_DEPTS } from './proteaPayrollMeasures';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface BurdenLineInput {
  /** base_account (e.g. 'A560324') */
  account: string;
  /** display label (account_description_detail_level_max) */
  name: string;
}

// ----------------------------------------------------------------------------
// Helpers — keep the config compact and let juniors slot rows in by editing
// the source-of-truth tables in proteaPayrollMeasures.ts, not this file.
// ----------------------------------------------------------------------------

const blank: PLRow = { type: 'header', label: '', indentLevel: 0 };
const sectionTitle = (label: string): PLRow =>
  ({ type: 'header', label, indentLevel: 0 });
const subHeader = (label: string): PLRow =>
  ({ type: 'header', label, indentLevel: 0 });
const total = (label: string, measureId: string): PLRow =>
  ({ type: 'header', label, measureId, formatting: 'number', indentLevel: 0 });

const deptRows = (suffix: 'assoc_wages' | 'contracts' | 'assoc_count' | 'contract_count'): PLRow[] =>
  PAYROLL_DEPTS.map(d => ({
    type: 'measure',
    label: d.label,
    measureId: `payroll_${d.key}_${suffix}`,
    formatting: 'number',
    indentLevel: 1,
  }));

const deptStaffSummaryRows = (): PLRow[] =>
  PAYROLL_DEPTS.map(d => ({
    type: 'measure',
    label: d.label,
    measureId: `payroll_${d.key}_staff_summary`,
    formatting: 'number',
    indentLevel: 1,
  }));

const burdenLineRows = (burdenLines: readonly BurdenLineInput[]): PLRow[] =>
  burdenLines.map(line => ({
    type: 'measure',
    label: line.name,
    measureId: `payroll_burden_acct_${line.account}`,
    formatting: 'number',
    indentLevel: 1,
  }));

// ----------------------------------------------------------------------------
// Row config
// ----------------------------------------------------------------------------

export function buildProteaPayrollPLRowConfig(
  burdenLines: readonly BurdenLineInput[]
): PLRow[] {
  return [
  // ===== SALARIES =====
  sectionTitle('SALARIES'),
  blank,

  subHeader('Perm. & Fixed Term'),
  ...deptRows('assoc_wages'),
  total('Total Perm. & Fixed Term', 'payroll_lodging_assoc_wages'),
  blank,

  subHeader('Contracts'),
  ...deptRows('contracts'),
  total('Total Contracts', 'payroll_lodging_contracts'),
  blank,

  total('Total Salaries/Casuals/Incentives', 'payroll_lodging_salaries_total'),
  blank,

  // ===== PAYROLL BURDEN =====
  // Burden lines are discovered dynamically (see proteaReportPackService).
  // The catch-all 'Other' row was removed when this section went dynamic —
  // every account contributing to the total is now visible by name.
  subHeader('PAYROLL BURDEN'),
  ...burdenLineRows(burdenLines),
  total('Total Payroll Burden', 'payroll_total_burden'),
  blank,

  // ===== STAFF EXPENSES SUMMARY (Salaries + Payroll Burden + Contracts) =====
  // Per-dept rows = Total Payroll (level_9) + 3 NOT BENEFITS (repointed)
  // + A631208 Contracts. Contracts sit outside the payroll hierarchy in
  // source data, so the section title and total label call them out.
  sectionTitle('STAFF EXPENSES SUMMARY (Salaries + Payroll Burden + Contracts)'),
  blank,
  subHeader('Salaries'),
  ...deptStaffSummaryRows(),
  blank,
  total('Total Staff Expenses (incl. Contracts)', 'payroll_lodging_staff_summary'),
  blank,

  // ===== EMPLOYEE NUMBERS =====
  sectionTitle('EMPLOYEE NUMBERS INCLUDING CONTRACTS'),
  blank,

  subHeader('Perm. & Fixed Term'),
  ...deptRows('assoc_count'),
  total('Total Perm. & Fixed Term Employees', 'payroll_lodging_assoc_count'),
  blank,

  subHeader('Casuals'),
  ...deptRows('contract_count'),
  total('Total Casuals', 'payroll_lodging_contract_count'),

  total('Total STAFF', 'payroll_lodging_total_staff'),
  blank,

  // ===== KPIs =====
  sectionTitle('Percentage of Total Revenue'),
  { type: 'measure', label: 'Total Staff Expenses',  measureId: 'payroll_kpi_staff_exp_pct_rev',    formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Salaries & Casuals',    measureId: 'payroll_kpi_salaries_pct_rev',     formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Direct Labour Cost',    measureId: 'payroll_kpi_direct_labour_pct_rev',formatting: 'percentage', indentLevel: 1 },
  { type: 'measure', label: 'Payroll Burden',        measureId: 'payroll_kpi_burden_pct_rev',       formatting: 'percentage', indentLevel: 1 },
  blank,

  sectionTitle('Percentage of Salaries'),
  { type: 'measure', label: 'Total Payroll Burden - as % of salaries EXCL Contractors', measureId: 'payroll_kpi_burden_pct_salaries_excl_contractors', formatting: 'percentage', indentLevel: 1 },
  blank,

  sectionTitle('Other'),
  { type: 'measure', label: 'STAFF ratio - Number of STAFF per Room available', measureId: 'payroll_kpi_staff_per_room_avail', formatting: 'ratio', indentLevel: 1 },
  blank,

  sectionTitle('Per Room Night Sold'),
  { type: 'measure', label: 'Total Salaries',        measureId: 'payroll_kpi_salaries_per_room_sold',  formatting: 'ratio', indentLevel: 1 },
  { type: 'measure', label: 'Total Payroll Burden',  measureId: 'payroll_kpi_burden_per_room_sold',    formatting: 'ratio', indentLevel: 1 },
  { type: 'measure', label: 'Contract expense',      measureId: 'payroll_kpi_contracts_per_room_sold', formatting: 'ratio', indentLevel: 1 },
  ];
}
