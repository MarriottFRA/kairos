/**
 * What the pack needs to know about codes: their labels at the grouping
 * levels and their names. `MapIndex` satisfies this; a test passes literals.
 */

import type { MapIndex } from "../sources";
import {
  DETAIL_GROUP_LEVEL,
  LEDGER_CATEGORY_ORDER,
  LedgerCategory,
  PACK_ACCOUNT_GROUP_LEVEL,
  PACK_GROUP_LEVEL,
  PACK_GROUP_ORDER,
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

/** Where a group sits in the pack's order: PS Loader's list first, other
 *  labels after it, the unmapped bucket last. */
export function groupRank(label: string): number {
  const index = PACK_GROUP_ORDER.indexOf(label);
  if (index >= 0) return index;
  return label === UNMAPPED_GROUP ? Number.MAX_SAFE_INTEGER : PACK_GROUP_ORDER.length;
}

export const UNMAPPED_DETAIL_KEY = "__unmapped";

export interface DetailGroupRef {
  key: string;
  label: string;
  /** The level_7 label behind it, for ordering and for naming duplicates apart. */
  parent: string | null;
  rank: number;
}

/** A department's detail group: its level_10 label, else its level_7 one, else unmapped. */
export function detailGroupOf(labels: Pick<PackLabels, "deptLabel">, dept: string): DetailGroupRef {
  const l10 = labels.deptLabel(dept, DETAIL_GROUP_LEVEL);
  const l7 = labels.deptLabel(dept, PACK_GROUP_LEVEL);
  const label = l10 ?? l7;
  if (label === null) return { key: UNMAPPED_DETAIL_KEY, label: UNMAPPED_GROUP, parent: null, rank: Number.MAX_SAFE_INTEGER };
  return { key: `${l7 ?? ""}|${label}`, label, parent: l7, rank: groupRank(l7 ?? label) };
}

/** Level_7 order, then the level_7 label, then the group's own label. */
export function compareDetailGroups(a: DetailGroupRef, b: DetailGroupRef): number {
  return a.rank - b.rank || (a.parent ?? "").localeCompare(b.parent ?? "") || a.label.localeCompare(b.label);
}

/** Display names by key: a level_10 label found under two level_7 parents
 *  (the real map has "Other Profit Departments" under two) gets its parent
 *  appended, so the two groups read apart. */
export function detailGroupNames(refs: Iterable<DetailGroupRef>): Map<string, string> {
  const unique = new Map<string, DetailGroupRef>();
  for (const ref of refs) unique.set(ref.key, ref);
  const counts = new Map<string, number>();
  for (const ref of unique.values()) counts.set(ref.label, (counts.get(ref.label) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const ref of unique.values()) {
    const clash = (counts.get(ref.label) ?? 0) > 1 && ref.parent && ref.parent !== ref.label;
    names.set(ref.key, clash ? `${ref.label} (${ref.parent})` : ref.label);
  }
  return names;
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
