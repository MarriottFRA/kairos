/**
 * The payroll bridge's account matrix: the column tree over the payroll
 * accounts, built from each account's map path (L12 → L14 → L18 → L21 →
 * the account), and the column layout for a given set of expanded groups.
 *
 * Three rules keep the tree from filling up with empty or repeated headers:
 *   - blank levels are already skipped in the path (bridgeAccountPath), so
 *     Paid Time Off goes straight to its accounts;
 *   - a group whose only child is another group takes that child's children
 *     (it keeps its own label);
 *   - a group with a single account is not expandable — its one column is
 *     the account.
 *
 * An expanded group lays out its children and then a subtotal column; a
 * collapsed one is a single column summing everything under it. The page
 * and the Excel export share this, so the file's outline groups are the
 * page's tree. Pure — no React, no ExcelJS.
 */

import { BRIDGE_TREE_LEVELS, BridgeAccount, BridgeDepartment, BridgeCell } from "./bridge";

/** "Account" on the depth selector: every group expanded. */
export const ACCOUNT_DEPTH = 99;
export const BRIDGE_DEPTHS: readonly number[] = [...BRIDGE_TREE_LEVELS, ACCOUNT_DEPTH];
export const DEFAULT_BRIDGE_DEPTH = 14;

export const depthLabel = (depth: number): string => (depth === ACCOUNT_DEPTH ? "Account" : `L${depth}`);

export interface BridgeTreeNode {
  /** Stable across reloads and filters: the label path of a group, the code of an account. */
  key: string;
  /** Short and field-safe, unique within one tree. */
  id: string;
  label: string;
  /** The map level of a group's label; ACCOUNT_DEPTH for an account. */
  level: number;
  /** The account code of a leaf; null for a group. */
  account: string | null;
  /** Every account under the node (the leaf's own, for a leaf), left to right. */
  accounts: string[];
  children: BridgeTreeNode[];
}

export const isExpandable = (node: BridgeTreeNode): boolean => node.account === null && node.children.length > 1;

export function buildAccountTree(accounts: readonly Pick<BridgeAccount, "code" | "name" | "path">[]): BridgeTreeNode[] {
  const roots: BridgeTreeNode[] = [];
  const groups = new Map<string, BridgeTreeNode>();
  // Code order, so groups come out in the order of their first account —
  // wages (51…) before benefits (56…), the way the chart of accounts reads.
  for (const account of [...accounts].sort((a, b) => a.code.localeCompare(b.code))) {
    let siblings = roots;
    let key = "";
    for (const step of account.path) {
      key = `${key}›${step.label}`;
      let group = groups.get(key);
      if (!group) {
        group = { key: `g:${key.slice(1)}`, id: "", label: step.label, level: step.level, account: null, accounts: [], children: [] };
        groups.set(key, group);
        siblings.push(group);
      }
      siblings = group.children;
    }
    siblings.push({
      key: `a:${account.code}`,
      id: "",
      label: account.name ?? account.code,
      level: ACCOUNT_DEPTH,
      account: account.code,
      accounts: [account.code],
      children: [],
    });
  }

  let next = 0;
  const finish = (node: BridgeTreeNode) => {
    for (const child of node.children) finish(child);
    while (node.children.length === 1 && node.children[0].account === null) node.children = node.children[0].children;
    if (node.account === null) node.accounts = node.children.flatMap((c) => c.accounts);
  };
  const number = (node: BridgeTreeNode) => {
    node.id = `n${next++}`;
    for (const child of node.children) number(child);
  };
  for (const root of roots) finish(root);
  for (const root of roots) number(root);
  return roots;
}

/** The groups the depth selector opens: every expandable group above the depth. */
export function expandedForDepth(tree: readonly BridgeTreeNode[], depth: number): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly BridgeTreeNode[]) => {
    for (const node of nodes) {
      if (isExpandable(node) && node.level < depth) out.add(node.key);
      walk(node.children);
    }
  };
  walk(tree);
  return out;
}

export type BridgeColumnKind = "account" | "group" | "subtotal";

export interface BridgeMatrixColumn {
  node: BridgeTreeNode;
  kind: BridgeColumnKind;
  /** The expanded groups above the column, outermost first (a subtotal's
   *  own group included, so it sits under that group's header). */
  parents: BridgeTreeNode[];
  /** Excel's column outline level: how many groups this column hides under.
   *  A subtotal is one level above the columns it totals. */
  outlineLevel: number;
  /** "Total <group>" for a subtotal, the node's label otherwise. */
  label: string;
}

export type BridgeLayoutItem =
  | { type: "column"; column: BridgeMatrixColumn }
  | { type: "group"; node: BridgeTreeNode; items: BridgeLayoutItem[] };

export interface BridgeMatrixLayout {
  /** Nested the way the headers nest. */
  items: BridgeLayoutItem[];
  /** The same columns, left to right. */
  columns: BridgeMatrixColumn[];
}

export function layoutMatrix(tree: readonly BridgeTreeNode[], expanded: ReadonlySet<string>): BridgeMatrixLayout {
  const columns: BridgeMatrixColumn[] = [];
  const column = (node: BridgeTreeNode, kind: BridgeColumnKind, parents: BridgeTreeNode[], outlineLevel: number): BridgeLayoutItem => {
    const out: BridgeMatrixColumn = {
      node,
      kind,
      parents,
      outlineLevel,
      label: kind === "subtotal" ? `Total ${node.label}` : node.label,
    };
    columns.push(out);
    return { type: "column", column: out };
  };
  const walk = (nodes: readonly BridgeTreeNode[], parents: BridgeTreeNode[]): BridgeLayoutItem[] =>
    nodes.map((node) => {
      if (node.account !== null) return column(node, "account", parents, parents.length);
      if (!isExpandable(node) || !expanded.has(node.key)) return column(node, "group", parents, parents.length);
      const inside = [...parents, node];
      const items = walk(node.children, inside);
      items.push(column(node, "subtotal", inside, parents.length));
      return { type: "group", node, items };
    });
  return { items: walk(tree, []), columns };
}

/** Every expandable group, for the full-depth layout the export writes. */
export function allExpanded(tree: readonly BridgeTreeNode[]): Set<string> {
  return expandedForDepth(tree, Infinity);
}

/** Account → year total over a row's (or a department's) cells. */
export function amountsOf(cells: readonly BridgeCell[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const cell of cells) out.set(cell.account, (out.get(cell.account) ?? 0) + cell.total);
  return out;
}

export function sumAccounts(amounts: ReadonlyMap<string, number>, accounts: readonly string[]): number {
  let sum = 0;
  for (const account of accounts) sum += amounts.get(account) ?? 0;
  return sum;
}

/** The payroll accounts with a value somewhere in these departments — the
 *  matrix only has columns for what the current filter actually shows. */
export function activePayrollAccounts(
  accounts: readonly BridgeAccount[],
  departments: readonly BridgeDepartment[]
): BridgeAccount[] {
  const used = new Set<string>();
  for (const department of departments) {
    for (const row of department.rows) {
      for (const cell of row.cells) if (cell.bucket === "payroll" && cell.total !== 0) used.add(cell.account);
    }
  }
  return accounts.filter((a) => a.bucket === "payroll" && used.has(a.code));
}
