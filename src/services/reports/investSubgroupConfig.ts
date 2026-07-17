// ============================================================================
// INVEST FACTOR OWNER — SHARED SUBGROUP CONFIGURATION
// Single source of truth for account classification used by both the Invest
// Factor Owner summary tab (proteaReportPackService / proteaBudgetPackService)
// and the F90 P&L measures (plMeasureDefinitions).
//
// Accounts are assigned by:
//   level_13 hierarchy (Management Fees) → level_20 mapping table → catch-all.
//
// The level_20 column in account_maps defines each account's subgroup.
// This eliminates hardcoded account lists, prefix patterns, and dept filters.
// ============================================================================

export interface InvestSubgroupDef {
  name: string;              // Display name in the report
  level20Value?: string;     // Lookup value in account_maps.level_20
  useLevel13?: string;       // Match level_13 value (for Management Fees)
  isCatchAll?: boolean;      // Captures all unmatched accounts (Abnormal Items)
}

/** Subgroup definitions — array order defines display order in the Invest tab. */
export const INVEST_CUSTOM_SUBGROUPS: InvestSubgroupDef[] = [
  { name: 'Fixed Expenses',                   level20Value: 'Fixed Expenses' },
  { name: 'Management Fees',                  useLevel13: 'Managed Fees' },
  { name: 'Depreciation',                     level20Value: 'Depreciation' },
  { name: 'Owners Expense',                   level20Value: 'Owner Expense' },
  { name: 'Net Interest (Income) / Expense',   level20Value: 'Interest' },
  { name: 'Refurbishment Fund',               level20Value: 'Refurbishment Fund' },
  { name: 'Tax',                              level20Value: 'Tax' },
  { name: 'Deferred Tax',                     level20Value: 'Deferred Tax' },
  { name: 'Dividends',                        level20Value: 'Dividends' },
  { name: 'Abnormal Items',                   level20Value: 'Abnormal Items', isCatchAll: true },
];

// Owner departments scoped by the Invest Factor Owner group and by every F90
// level_20 atom. Keep in sync with the filters on f90_*_l20_act sub-measures
// in plMeasureDefinitions.ts.
export const OWNER_DEPARTMENTS: string[] = ['D0480', 'D0490', 'D0690', 'D0691'];

// Known level_20 values — all non-catch-all buckets. Used by the F90 Abnormal
// Items atom (acc_level_not_in filter) so the "catch-all" scope in SQL stays
// in lock-step with classifyAccountsByLevel20's catch-all fallback. Adding or
// renaming a bucket here propagates to INVEST and F90 automatically.
export const KNOWN_LEVEL_20_VALUES: string[] = INVEST_CUSTOM_SUBGROUPS
  .filter(sg => sg.level20Value && !sg.isCatchAll)
  .map(sg => sg.level20Value as string);
