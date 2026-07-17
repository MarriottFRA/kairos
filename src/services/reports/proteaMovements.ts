/**
 * Protea Movements — single source of truth for account-level reclassifications
 * applied only on the Protea data path.
 *
 * Two consumers must stay in sync from this one list:
 *   1. local_db.ts buildProteaCategoryClauses() — drives the SQL CASE that
 *      reassigns the displayed category for repointed accounts.
 *   2. plMeasureDefinitions.ts movement sub-measures — drives the engine
 *      arithmetic that builds Protea-aware totals (e.g. _protea variants of
 *      payroll / controllables) so KPIs match what the report displays.
 *
 * Adding a new repoint here cascades automatically to both consumers — no
 * other edits required.
 */

export type RepointTargetCategory =
  | 'Revenue'
  | 'Cost of Sales'
  | 'Payroll'
  | 'Controllables'
  | 'Stats'
  | 'Other';

export interface ProteaCategoryRepoint {
  account: string;
  targetCategory: RepointTargetCategory;
}

export const PROTEA_CATEGORY_REPOINTS: ProteaCategoryRepoint[] = [
  { account: 'A610112', targetCategory: 'Payroll' },
  { account: 'A652101', targetCategory: 'Payroll' },
  { account: 'A632007', targetCategory: 'Payroll' },
];

export const PROTEA_CATEGORY_SORT_ORDER: Record<RepointTargetCategory, number> = {
  'Revenue': 1,
  'Cost of Sales': 2,
  'Payroll': 3,
  'Controllables': 4,
  'Other': 5,
  'Stats': 6,
};

/** Accounts repointed into a given category. Used by measure definitions to
 *  build the "movement" sub-measure for that category. */
export function proteaRepointAccountsForCategory(
  category: RepointTargetCategory
): string[] {
  return PROTEA_CATEGORY_REPOINTS
    .filter(r => r.targetCategory === category)
    .map(r => r.account);
}

/** Convenience export — accounts repointed into Payroll. */
export const PROTEA_PAYROLL_REPOINT_ACCOUNTS: string[] =
  proteaRepointAccountsForCategory('Payroll');
