// Type definitions for Custom P&L Report System

export type FilterType = 'dept_level' | 'dept_base' | 'dept_base_not_in' | 'acc_level' | 'acc_level_not_in' | 'acc_base' | 'acc_prefix';
export type ScenarioType = 'ACT' | 'BUD' | 'PY1';
export type FormattingType = 'currency' | 'percentage' | 'number' | 'ratio';
export type FormulaType = 'SUM' | 'COUNT' | 'CALCULATE';

export interface MeasureFilter {
  type: FilterType;
  level?: number;
  value: string | string[];
}

export interface SubMeasure {
  id: string;
  formula: FormulaType;
  filters: MeasureFilter[];
  negate?: boolean;
}

export interface Measure {
  id: string;
  type: 'simple' | 'calculated';
  subMeasures?: string[];
  formula?: string;
  evaluator?: (context: MeasureContext) => number;
}

export interface MeasureContext {
  subMeasures: Record<string, number>;
  scenario: ScenarioType;
  /** Calendar days in the period being evaluated. Optional — only the
   *  period-aware measures (e.g. rooms_available_per_day) read it. When
   *  absent, those measures safe-divide to 0. Computed via daysInPeriod
   *  in services/reports/periodUtils.ts. */
  periodDays?: number;
}

export interface PLRow {
  type: 'header' | 'measure';
  label: string;
  measureId?: string;
  indentLevel?: number;
  formatting?: FormattingType;
  invertSign?: boolean;
}

export interface PeriodRange {
  startMonth: number;
  startYear: number;
  endMonth: number;
  endYear: number;
}

export interface PLCalculationResult {
  rowId: number;
  type: 'header' | 'measure';
  label: string;
  indentLevel: number;
  actuals: number | null;
  budget: number | null;
  vs_bud: number | null;
  vs_bud_pct: number | null;
  ly: number | null;
  vs_ly: number | null;
  vs_ly_pct: number | null;
  formatting: FormattingType;
  invertVariance?: boolean;
}

export interface BaseQueryResult {
  [key: string]: number;
}

export interface QueryBuildResult {
  sql: string;
  params: any[];
}
