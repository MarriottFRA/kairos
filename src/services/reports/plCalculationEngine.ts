import {
  PeriodRange,
  PLCalculationResult,
  BaseQueryResult,
  QueryBuildResult,
  ScenarioType,
  MeasureFilter,
  MeasureContext,
  PLRow
} from '../../types/plReportTypes';
import { SUB_MEASURES, MEASURES } from './plMeasureDefinitions';
import { PL_ROW_CONFIG } from './plRowConfig';
import { SUMMARY_PL_ROW_CONFIG } from './summaryPLRowConfig';
import { F90_PL_ROW_CONFIG } from './f90PLRowConfig';

// ============================================================================
// CALCULATION ENGINE FOR CUSTOM P&L REPORT
// Orchestrates SQL query generation, data fetching, and measure evaluation
// ============================================================================

/** Balance sheet accounts (A1xxx, A2xxx) are permanently excluded from all P&L reports.
 *  This is a fundamental accounting convention — these prefixes will never contain P&L data. */
const EXCLUDE_BALANCE_SHEET_SQL = "cd.account NOT LIKE 'A1%' AND cd.account NOT LIKE 'A2%'";

export function generatePeriods(range: PeriodRange): string[] {
  const periods: string[] = [];
  let year = range.startYear;
  let month = range.startMonth;

  while (true) {
    periods.push(`${year}-${String(month).padStart(2, '0')}`);

    if (year === range.endYear && month === range.endMonth) {
      break;
    }

    month++;
    if (month > 12) {
      month = 1;
      year++;
    }

    if (periods.length > 24) {
      throw new Error('Period range exceeds 24 months');
    }
  }

  return periods;
}

export function generateLYPeriods(periods: string[]): string[] {
  return periods.map(period => {
    const [year, month] = period.split('-');
    const lyYear = parseInt(year) - 1;
    return `${lyYear}-${month}`;
  });
}

// ============================================================================
// SQL QUERY BUILDER
// Constructs optimized queries with conditional aggregations
// ============================================================================

function buildFilterCondition(filter: MeasureFilter): string {
  const { type, level, value } = filter;

  if (type === 'dept_level') {
    const column = `dm.level_${level}`;
    if (Array.isArray(value)) {
      return `${column} IN (${value.map(() => '?').join(', ')})`;
    }
    return `${column} = ?`;
  }

  if (type === 'dept_base') {
    if (Array.isArray(value)) {
      return `dm.base_department IN (${value.map(() => '?').join(', ')})`;
    }
    return `dm.base_department = ?`;
  }

  // Inverse of dept_base — exclude a known set (e.g. F&B EXCLUDING banqueting).
  // NULL departments are excluded too so unmapped rows don't slip through.
  if (type === 'dept_base_not_in') {
    const values = Array.isArray(value) ? value : [value];
    const placeholders = values.map(() => '?').join(', ');
    return `(dm.base_department NOT IN (${placeholders}) AND dm.base_department IS NOT NULL)`;
  }

  if (type === 'acc_level') {
    const column = `am.level_${level}`;
    if (Array.isArray(value)) {
      return `${column} IN (${value.map(() => '?').join(', ')})`;
    }
    return `${column} = ?`;
  }

  // Catch-all: account level NOT IN the known set, OR unmapped (NULL).
  // Added for F90 Abnormal Items atom so it mirrors INVEST FACTOR OWNER SUMMARY's
  // catch-all behaviour (classifyAccountsByLevel20 in proteaShared.ts).
  if (type === 'acc_level_not_in') {
    const column = `am.level_${level}`;
    const values = Array.isArray(value) ? value : [value];
    const placeholders = values.map(() => '?').join(', ');
    return `(${column} NOT IN (${placeholders}) OR ${column} IS NULL)`;
  }

  if (type === 'acc_base') {
    if (Array.isArray(value)) {
      return `am.base_account IN (${value.map(() => '?').join(', ')})`;
    }
    return `am.base_account = ?`;
  }

  if (type === 'acc_prefix') {
    if (Array.isArray(value)) {
      return `(${value.map(() => `am.base_account LIKE ?`).join(' OR ')})`;
    }
    return `am.base_account LIKE ?`;
  }

  return '1=1';
}

function getFilterValues(filter: MeasureFilter): any[] {
  if (filter.type === 'acc_prefix') {
    if (Array.isArray(filter.value)) {
      return filter.value.map(v => `${v}%`);
    }
    return [`${filter.value}%`];
  }
  if (Array.isArray(filter.value)) {
    return filter.value;
  }
  return [filter.value];
}

export function buildScenarioQuery(
  scenario: ScenarioType,
  periods: string[],
  ou?: string,
  version: string = 'MAIN'
): QueryBuildResult {
  const subMeasureIds = Object.keys(SUB_MEASURES);
  const params: any[] = [];

  // Build SELECT clauses and collect filter params separately
  const filterParams: any[] = [];
  const selectClauses: string[] = subMeasureIds.map(subMeasureId => {
    const subMeasure = SUB_MEASURES[subMeasureId];
    const conditions = subMeasure.filters.map(filter => buildFilterCondition(filter));
    const whereClause = conditions.join(' AND ');

    subMeasure.filters.forEach(filter => {
      filterParams.push(...getFilterValues(filter));
    });

    const multiplier = subMeasure.negate ? '-1' : '1';

    return `SUM(CASE WHEN ${whereClause} THEN cd.amount * ${multiplier} ELSE 0 END) AS ${subMeasureId}`;
  });

  // Push params in the order they appear in the SQL
  const latestStagingPeriod = periods[periods.length - 1];
  params.push(latestStagingPeriod);
  params.push(version);

  periods.forEach(p => params.push(p));
  if (ou) {
    params.push(ou);
  }

  periods.forEach(p => params.push(p));
  if (ou) {
    params.push(ou);
  }

  // Now add all the filter params for the CASE WHEN clauses
  params.push(...filterParams);

  const sql = `
    WITH combined_data AS (
      SELECT
        COALESCE(fds.dep_acc_combo_id, fd.dep_acc_combo_id) AS combo,
        COALESCE(fds.department, fd.department) AS department,
        COALESCE(fds.account, fd.account) AS account,
        COALESCE(fds.amount, fd.amount) AS amount,
        COALESCE(fds.period_combo, fd.period_combo) AS period_combo
      FROM financial_data fd
      LEFT JOIN financial_data_staging fds
        ON fd.dep_acc_combo_id = fds.dep_acc_combo_id
        AND fds.period_combo = ?
        AND fd.period_combo = fds.period_combo
        AND fds.scenario = '${scenario}'
        AND fds.ou = fd.ou
        AND fds.version = fd.version
      WHERE fd.scenario = '${scenario}'
        AND fd.version = ?
        AND fd.period_combo IN (${periods.map(() => '?').join(', ')})
        ${ou ? 'AND fd.ou = ?' : ''}

      UNION ALL

      SELECT
        fds.dep_acc_combo_id AS combo,
        fds.department,
        fds.account,
        fds.amount,
        fds.period_combo
      FROM financial_data_staging fds
      WHERE fds.scenario = '${scenario}'
        AND fds.period_combo IN (${periods.map(() => '?').join(', ')})
        ${ou ? 'AND fds.ou = ?' : ''}
    )
    SELECT
      ${selectClauses.join(',\n      ')}
    FROM combined_data cd
    LEFT JOIN department_maps dm ON cd.department = dm.base_department
    LEFT JOIN account_maps am ON cd.account = am.base_account
    WHERE ${EXCLUDE_BALANCE_SHEET_SQL}
  `;

  return { sql, params };
}

// ============================================================================
// MEASURE EVALUATION
// Calculates final measures from base query results
// ============================================================================

function evaluateSubMeasures(queryResult: BaseQueryResult): Record<string, number> {
  const result: Record<string, number> = {};

  Object.keys(SUB_MEASURES).forEach(subMeasureId => {
    result[subMeasureId] = queryResult[subMeasureId] || 0;
  });

  return result;
}

function evaluateMeasure(
  measureId: string,
  subMeasures: Record<string, number>,
  scenario: ScenarioType,
  periodDays?: number
): number {
  const measure = MEASURES[measureId];
  if (!measure) return 0;

  const context: MeasureContext = { subMeasures, scenario, periodDays };

  if (measure.type === 'simple') {
    const subMeasureId = measure.subMeasures?.[0];
    return subMeasureId ? (subMeasures[subMeasureId] || 0) : 0;
  }

  if (measure.type === 'calculated' && measure.evaluator) {
    return measure.evaluator(context);
  }

  return 0;
}

// ============================================================================
// VARIANCE CALCULATIONS
// ============================================================================

function calculateVariance(actual: number, comparison: number): number {
  return actual - comparison;
}

function calculateVariancePercent(actual: number, comparison: number): number {
  if (comparison === 0) return 0;
  return ((actual - comparison) / Math.abs(comparison)) * 100;
}

// ============================================================================
// MAIN CALCULATION FUNCTION
// Exported for use by database query handler
// ============================================================================

export function calculatePLRows(
  actualsData: BaseQueryResult,
  budgetData: BaseQueryResult,
  lyData: BaseQueryResult,
  periodDays?: number
): PLCalculationResult[] {
  const actualsSubMeasures = evaluateSubMeasures(actualsData);
  const budgetSubMeasures = evaluateSubMeasures(budgetData);
  const lySubMeasures = evaluateSubMeasures(lyData);

  const results: PLCalculationResult[] = [];
  let rowId = 1;

  PL_ROW_CONFIG.forEach(rowConfig => {
    if (rowConfig.type === 'header') {
      results.push({
        rowId: rowId++,
        type: 'header',
        label: rowConfig.label,
        indentLevel: rowConfig.indentLevel || 0,
        actuals: null,
        budget: null,
        vs_bud: null,
        vs_bud_pct: null,
        ly: null,
        vs_ly: null,
        vs_ly_pct: null,
        formatting: 'number'
      });
      return;
    }

    const measureId = rowConfig.measureId;
    if (!measureId) return;

    const actuals = evaluateMeasure(measureId, actualsSubMeasures, 'ACT', periodDays);
    const budget = evaluateMeasure(measureId, budgetSubMeasures, 'BUD', periodDays);
    const ly = evaluateMeasure(measureId, lySubMeasures, 'PY1', periodDays);

    const vs_bud = calculateVariance(actuals, budget);
    const vs_bud_pct = calculateVariancePercent(actuals, budget);
    const vs_ly = calculateVariance(actuals, ly);
    const vs_ly_pct = calculateVariancePercent(actuals, ly);

    results.push({
      rowId: rowId++,
      type: 'measure',
      label: rowConfig.label,
      indentLevel: rowConfig.indentLevel || 0,
      actuals,
      budget,
      vs_bud,
      vs_bud_pct,
      ly,
      vs_ly,
      vs_ly_pct,
      formatting: rowConfig.formatting || 'number'
    });
  });

  return results;
}

// ============================================================================
// CALCULATE SUMMARY P&L ROWS
// Uses the SUMMARY_PL_ROW_CONFIG instead of PL_ROW_CONFIG
// ============================================================================

export function calculateSummaryPLRows(
  actualsData: BaseQueryResult,
  budgetData: BaseQueryResult,
  lyData: BaseQueryResult,
  periodDays?: number
): PLCalculationResult[] {
  const actualsSubMeasures = evaluateSubMeasures(actualsData);
  const budgetSubMeasures = evaluateSubMeasures(budgetData);
  const lySubMeasures = evaluateSubMeasures(lyData);

  const results: PLCalculationResult[] = [];
  let rowId = 1;

  SUMMARY_PL_ROW_CONFIG.forEach(rowConfig => {
    const measureId = rowConfig.measureId;

    // If no measureId, it's a spacing row - add it with null values
    if (!measureId) {
      results.push({
        rowId: rowId++,
        type: rowConfig.type,
        label: rowConfig.label,
        indentLevel: rowConfig.indentLevel || 0,
        actuals: null,
        budget: null,
        vs_bud: null,
        vs_bud_pct: null,
        ly: null,
        vs_ly: null,
        vs_ly_pct: null,
        formatting: rowConfig.formatting || 'number'
      });
      return;
    }

    // Has measureId - calculate values regardless of type (header or measure)
    // Note: unlike F90, data values are NOT sign-flipped here — expense
    // sub-measures carry no negate flag and are already positive debits.
    // invertSign on a row signals variance-colour inversion only (set via
    // invertVariance on the result so the UI can colour accordingly).
    const actuals = evaluateMeasure(measureId, actualsSubMeasures, 'ACT', periodDays);
    const budget = evaluateMeasure(measureId, budgetSubMeasures, 'BUD', periodDays);
    const ly = evaluateMeasure(measureId, lySubMeasures, 'PY1', periodDays);

    const vs_bud = calculateVariance(actuals, budget);
    const vs_bud_pct = calculateVariancePercent(actuals, budget);
    const vs_ly = calculateVariance(actuals, ly);
    const vs_ly_pct = calculateVariancePercent(actuals, ly);

    results.push({
      rowId: rowId++,
      type: rowConfig.type,
      label: rowConfig.label,
      indentLevel: rowConfig.indentLevel || 0,
      actuals,
      budget,
      vs_bud,
      vs_bud_pct,
      ly,
      vs_ly,
      vs_ly_pct,
      formatting: rowConfig.formatting || 'number',
      invertVariance: !!rowConfig.invertSign
    });
  });

  return results;
}

// ============================================================================
// CALCULATE F90 P&L ROWS
// Uses the F90_PL_ROW_CONFIG instead of PL_ROW_CONFIG
// ============================================================================

// ============================================================================
// PROTEA REPORT: ACCOUNT MOVEMENT MUTATION
// Shifts insurance (A730xxx) and audit (A745xxx) accounts from D0480/D0490/
// D0690/D0691 into Admin & General (D0410) at the report level.  Mutates the
// raw query result object IN-PLACE so that all downstream measure evaluators
// automatically cascade the adjusted values.
// ============================================================================

export function applyProteaAccountMovement(queryResult: any): void {
  // A730/A745 insurance/audit movement from all owner departments
  const moved0480 = Number(queryResult.protea_moved_accounts_d0480_act) || 0;
  const moved0490 = Number(queryResult.protea_moved_accounts_d0490_act) || 0;
  const moved0690 = Number(queryResult.protea_moved_accounts_d0690_act) || 0;
  const moved0691 = Number(queryResult.protea_moved_accounts_d0691_act) || 0;

  const totalMoved = moved0480 + moved0490 + moved0690 + moved0691;

  // Shift into UOE / Admin & General (increases expense, decreases profit)
  queryResult.admin_general_dept_expense_act = (Number(queryResult.admin_general_dept_expense_act) || 0) + totalMoved;
  queryResult.total_undist_op_exp_act = (Number(queryResult.total_undist_op_exp_act) || 0) + totalMoved;
  queryResult.total_profit_act = (Number(queryResult.total_profit_act) || 0) + totalMoved;

  // Remove from source department aggregates (below-the-line)
  queryResult.f90_d0480_all_act = (Number(queryResult.f90_d0480_all_act) || 0) - moved0480;
  queryResult.f90_d0490_all_act = (Number(queryResult.f90_d0490_all_act) || 0) - moved0490;
  queryResult.f90_d0690_all_act = (Number(queryResult.f90_d0690_all_act) || 0) - moved0690;
  queryResult.f90_d0691_all_act = (Number(queryResult.f90_d0691_all_act) || 0) - moved0691;
}

export function calculateF90PLRows(
  actualsData: BaseQueryResult,
  budgetData: BaseQueryResult,
  lyData: BaseQueryResult,
  rowConfig: PLRow[] = F90_PL_ROW_CONFIG,
  skipFilter: boolean = false,
  periodDays?: number
): PLCalculationResult[] {
  const actualsSubMeasures = evaluateSubMeasures(actualsData);
  const budgetSubMeasures = evaluateSubMeasures(budgetData);
  const lySubMeasures = evaluateSubMeasures(lyData);

  const results: PLCalculationResult[] = [];
  let rowId = 1;

  rowConfig.forEach(row => {
    const measureId = row.measureId;

    // If no measureId, it's a spacing row - add it with null values
    if (!measureId) {
      results.push({
        rowId: rowId++,
        type: row.type,
        label: row.label,
        indentLevel: row.indentLevel || 0,
        actuals: null,
        budget: null,
        vs_bud: null,
        vs_bud_pct: null,
        ly: null,
        vs_ly: null,
        vs_ly_pct: null,
        formatting: row.formatting || 'number'
      });
      return;
    }

    // Has measureId - calculate values regardless of type (header or measure)
    // Apply sign inversion for revenue (credits) and expense (debits) lines
    const sign = row.invertSign ? -1 : 1;
    const actuals = evaluateMeasure(measureId, actualsSubMeasures, 'ACT', periodDays) * sign;
    const budget = evaluateMeasure(measureId, budgetSubMeasures, 'BUD', periodDays) * sign;
    const ly = evaluateMeasure(measureId, lySubMeasures, 'PY1', periodDays) * sign;

    const vs_bud = calculateVariance(actuals, budget);
    const vs_bud_pct = calculateVariancePercent(actuals, budget);
    const vs_ly = calculateVariance(actuals, ly);
    const vs_ly_pct = calculateVariancePercent(actuals, ly);

    results.push({
      rowId: rowId++,
      type: row.type,
      label: row.label,
      indentLevel: row.indentLevel || 0,
      actuals,
      budget,
      vs_bud,
      vs_bud_pct,
      ly,
      vs_ly,
      vs_ly_pct,
      formatting: row.formatting || 'number',
      invertVariance: !!row.invertSign
    });
  });

  return skipFilter ? results : filterZeroRows(results);
}

// ============================================================================
// ZERO-ROW FILTER
// Removes measure rows where actuals, budget, and LY are all zero.
// Preserves totals (headers with values) and cleans up orphaned section
// headers and spacing rows so smaller hotels don't see empty rows.
// ============================================================================

function filterZeroRows(rows: PLCalculationResult[]): PLCalculationResult[] {
  // Step 1: Identify which measure rows have non-zero data
  const rowHasData = rows.map(row =>
    row.type === 'measure' &&
    ((row.actuals !== null && row.actuals !== 0) ||
     (row.budget !== null && row.budget !== 0) ||
     (row.ly !== null && row.ly !== 0))
  );

  // Step 2: Decide which rows to keep
  const keep = rows.map((row, i) => {
    // Measure rows: only keep if they have data
    if (row.type === 'measure') return rowHasData[i];

    // Total/calculated headers (have actual values): always keep
    if (row.type === 'header' && row.actuals !== null) return true;

    // Spacing rows: tentatively keep (cleaned up in step 3)
    if (row.type === 'header' && !row.label) return true;

    // Section label headers (no values): keep only if any child measures have data
    if (row.type === 'header' && row.label && row.actuals === null) {
      for (let j = i + 1; j < rows.length; j++) {
        // Stop at next section header at same or lower indent level
        if (rows[j].type === 'header' && rows[j].label &&
            rows[j].actuals === null && rows[j].indentLevel <= row.indentLevel) {
          break;
        }
        if (rowHasData[j]) return true;
      }
      return false;
    }

    return true;
  });

  let filtered = rows.filter((_, i) => keep[i]);

  // Step 3: Clean up spacing — remove leading, trailing, and consecutive empty rows
  filtered = filtered.filter((row, i, arr) => {
    if (row.type !== 'header' || row.label !== '') return true;
    if (i === 0 || i === arr.length - 1) return false;
    if (arr[i - 1].type === 'header' && arr[i - 1].label === '') return false;
    return true;
  });

  // Re-number row IDs
  filtered.forEach((row, i) => { row.rowId = i + 1; });

  return filtered;
}

// ============================================================================
// CROSS-DATASET ZERO FILTER
// Filters multiple datasets simultaneously so all period columns (month, range,
// monthly breakdowns) suppress the same rows. A row is removed only when it is
// zero across every scenario in every dataset. rowIds are renumbered using a
// single shared map so alignment by rowId is preserved across all datasets.
// ============================================================================

export function filterZeroRowsAcrossDatasets(
  datasets: PLCalculationResult[][]
): PLCalculationResult[][] {
  if (datasets.length === 0 || datasets.every(d => d.length === 0)) return datasets;

  // Use the longest dataset as the structural reference
  const reference = datasets.reduce((a, b) => a.length >= b.length ? a : b);

  // Mark a rowId as having data if ANY dataset has non-zero actuals/budget/ly for it
  const rowIdHasData = new Map<number, boolean>();
  for (const row of reference) rowIdHasData.set(row.rowId, false);

  for (const dataset of datasets) {
    for (const row of dataset) {
      if (row.type === 'measure') {
        const hasData = (row.actuals !== null && row.actuals !== 0) ||
                        (row.budget !== null && row.budget !== 0) ||
                        (row.ly !== null && row.ly !== 0);
        if (hasData) rowIdHasData.set(row.rowId, true);
      }
    }
  }

  // Apply the identical keep/remove decision to every dataset
  const filteredDatasets = datasets.map(dataset => {
    const keep = dataset.map(row => {
      if (row.type === 'measure') return rowIdHasData.get(row.rowId) ?? true;
      if (row.type === 'header' && row.actuals !== null) return true;
      if (row.type === 'header' && !row.label) return true;
      if (row.type === 'header' && row.label && row.actuals === null) {
        const refIdx = reference.findIndex(r => r.rowId === row.rowId);
        if (refIdx === -1) return true;
        for (let j = refIdx + 1; j < reference.length; j++) {
          const refRow = reference[j];
          if (refRow.type === 'header' && refRow.label &&
              refRow.actuals === null && refRow.indentLevel <= row.indentLevel) break;
          if (rowIdHasData.get(refRow.rowId)) return true;
        }
        return false;
      }
      return true;
    });

    let filtered = dataset.filter((_, i) => keep[i]);

    filtered = filtered.filter((row, i, arr) => {
      if (row.type !== 'header' || row.label !== '') return true;
      if (i === 0 || i === arr.length - 1) return false;
      if (arr[i - 1].type === 'header' && arr[i - 1].label === '') return false;
      return true;
    });

    return filtered;
  });

  // Build a single renumber map from the first filtered dataset and apply to all
  const renumberMap = new Map<number, number>();
  filteredDatasets[0].forEach((row, i) => renumberMap.set(row.rowId, i + 1));

  for (const dataset of filteredDatasets) {
    for (const row of dataset) {
      const newId = renumberMap.get(row.rowId);
      if (newId !== undefined) row.rowId = newId;
    }
  }

  return filteredDatasets;
}
