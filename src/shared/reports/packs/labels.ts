/**
 * What the pack needs to know about codes: their labels at the grouping
 * levels and their names. `MapIndex` satisfies this; a test passes literals.
 */

import type { MapIndex } from "../sources";
import {
  LEDGER_CATEGORY_ORDER,
  LedgerCategory,
  PACK_ACCOUNT_GROUP_LEVEL,
  PACK_GROUP_LEVEL,
  UNMAPPED_ACCOUNT_GROUP,
  UNMAPPED_GROUP,
} from "./constants";

export interface PackLabels {
  deptLabel(code: string, level: number): string | null;
  accountLabel(code: string, level: number): string | null;
  deptName(code: string): string | null;
  accountName(code: string): string | null;
}

export function packLabelsOf(maps: MapIndex): PackLabels {
  return {
    deptLabel: (code, level) => maps.labelAt("dept", code, level),
    accountLabel: (code, level) => maps.labelAt("account", code, level),
    deptName: (code) => maps.name("dept", code),
    accountName: (code) => maps.name("account", code),
  };
}

/** The pack's group for a department: its level_7 label, or the unmapped bucket. */
export function groupOf(labels: PackLabels, dept: string): string {
  return labels.deptLabel(dept, PACK_GROUP_LEVEL) ?? UNMAPPED_GROUP;
}

/** The ledger's sub-group for an account: its level_12 label, or the residual. */
export function accountGroupOf(labels: PackLabels, account: string): string {
  return labels.accountLabel(account, PACK_ACCOUNT_GROUP_LEVEL) ?? UNMAPPED_ACCOUNT_GROUP;
}

/**
 * PS Loader's category CASE, in its order of precedence:
 *   level_6 Revenue → Revenue; level_9 Cost Of Sales → Cost of Sales;
 *   level_9 Total Payroll → Payroll; a 9… account → Stats;
 *   level_4 Profit Amount (not revenue) → Controllables; else Other.
 */
export function categoryOf(labels: PackLabels, account: string): LedgerCategory {
  if (labels.accountLabel(account, 6) === "Revenue") return "Revenue";
  const l9 = labels.accountLabel(account, 9);
  if (l9 === "Cost Of Sales") return "Cost of Sales";
  if (l9 === "Total Payroll") return "Payroll";
  if (account.startsWith("9")) return "Stats";
  if (labels.accountLabel(account, 4) === "Profit Amount") return "Controllables";
  return "Other";
}

export const categoryRank = (category: LedgerCategory): number => LEDGER_CATEGORY_ORDER.indexOf(category);
