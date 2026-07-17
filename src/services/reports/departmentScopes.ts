/**
 * Department Scopes — small leaf module holding department-classification
 * constants that need to be referenced from BOTH the SQL/measure layer
 * (plMeasureDefinitions.ts → engine queries) AND the report renderers
 * (proteaShared.ts → grouping/visual splits).
 *
 * Keeping these here avoids the circular import that would result from
 * having plMeasureDefinitions import from proteaShared (which itself
 * imports from local_db, which dynamically imports plMeasureDefinitions
 * via plCalculationEngine).
 *
 * Pure data, no other imports — safe to import from anywhere.
 */

/** F&B sub-departments classified as banqueting. Used to:
 *   - Scope F&B KPI numerators that should EXCLUDE banqueting (e.g. per-meal
 *     covers and spend for restaurants/lounges only) via the engine's
 *     dept_base_not_in filter.
 *   - Scope dedicated banqueting KPI rollups (dept_base IN this list).
 *   - Drive the Protea Pack's optional "Total Banqueting" group split
 *     (includeBanquetingBreakdown toggle in proteaShared.ts).
 *
 * Source of truth — both engine and renderer derive from this one list.
 */
export const BANQUETING_DEPARTMENT_CODES: readonly string[] =
  ['D0230', 'D0231', 'D0232', 'D0233'] as const;
