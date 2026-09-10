/**
 * The bridge's account matrix, on labels copied from a real account map:
 * groups in chart-of-accounts order, blank levels skipped, single-child
 * chains merged, single-account groups not expandable, the depth selector's
 * expansion, the column layout (subtotal after the children, Excel outline
 * levels), and the sums a column reads.
 */

import { describe, expect, it } from "vitest";
import type { BridgeAccount, BridgeAccountStep, BridgeCell, BridgeDepartment } from "../bridge";
import {
  ACCOUNT_DEPTH,
  BridgeTreeNode,
  activePayrollAccounts,
  allExpanded,
  amountsOf,
  buildAccountTree,
  expandedForDepth,
  isExpandable,
  layoutMatrix,
  sumAccounts,
} from "../bridgeMatrix";

const AW = { level: 12, label: "Associate Wages" };
const AB = { level: 12, label: "Associate Benefits" };
const WS = { level: 14, label: "Wages & Salaries" };
const THW = { level: 18, label: "Total Hourly Wages excl Overtime" };

const account = (code: string, name: string, ...path: BridgeAccountStep[]): BridgeAccount => ({
  code,
  name,
  bucket: "payroll",
  path,
});

const ACCOUNTS: BridgeAccount[] = [
  account("560320", "560320 - Fica Tax Expense", AB, { level: 14, label: "Tax Expense" }),
  account("510005", "510005 - Wage Dept 05", AW, WS, THW, { level: 21, label: "Hourly Wages" }),
  account("520201", "520201 - Buyout Labor", AW, WS, THW, { level: 21, label: "Contract Buyout Lbr" }),
  account("511001", "511001 - Overtime Premium", AW, WS, { level: 18, label: "Hrly Overtime Prem" }),
  account("511002", "511002 - Overtime Premium - Night", AW, WS, { level: 18, label: "Hrly Overtime Prem" }),
  account("520001", "520001 - Mgmt Salaries", AW, WS, { level: 18, label: "Mgmt Salaries" }),
  account("510503", "510503 - Service Charge Distribution", AW, { level: 14, label: "Service Charge Distribution" }),
  account("560303", "560303 - Vacation Leave", AB, { level: 14, label: "Paid Time Off" }),
  account("560307", "560307 - Sick Leave", AB, { level: 14, label: "Paid Time Off" }),
];

const labels = (nodes: readonly BridgeTreeNode[]) => nodes.map((n) => n.label);
const search = (nodes: readonly BridgeTreeNode[], label: string): BridgeTreeNode | null => {
  for (const node of nodes) {
    if (node.label === label) return node;
    const inner = search(node.children, label);
    if (inner) return inner;
  }
  return null;
};
const find = (nodes: readonly BridgeTreeNode[], label: string): BridgeTreeNode => {
  const node = search(nodes, label);
  if (!node) throw new Error(`no ${label}`);
  return node;
};

describe("buildAccountTree", () => {
  const tree = buildAccountTree(ACCOUNTS);

  it("orders groups by their first account, wages before benefits", () => {
    expect(labels(tree)).toEqual(["Associate Wages", "Associate Benefits"]);
    expect(labels(tree[0].children)).toEqual(["Wages & Salaries", "Service Charge Distribution"]);
    expect(labels(find(tree, "Wages & Salaries").children)).toEqual([
      "Total Hourly Wages excl Overtime",
      "Hrly Overtime Prem",
      "Mgmt Salaries",
    ]);
  });

  it("goes straight from a group to its accounts when the deeper levels are blank", () => {
    expect(labels(find(tree, "Paid Time Off").children)).toEqual(["560303 - Vacation Leave", "560307 - Sick Leave"]);
    expect(find(tree, "Paid Time Off").accounts).toEqual(["560303", "560307"]);
  });

  it("does not offer to expand a group holding a single account", () => {
    expect(isExpandable(find(tree, "Service Charge Distribution"))).toBe(false);
    expect(isExpandable(find(tree, "Mgmt Salaries"))).toBe(false);
    expect(isExpandable(find(tree, "Total Hourly Wages excl Overtime"))).toBe(true);
    // Left to right, the way the columns lay out — not code order.
    expect(find(tree, "Associate Wages").accounts).toEqual(["510005", "520201", "511001", "511002", "520001", "510503"]);
  });

  it("merges a group whose only child is another group", () => {
    const only = buildAccountTree(ACCOUNTS.filter((a) => a.code !== "520201"));
    const thw = find(only, "Total Hourly Wages excl Overtime");
    // "Hourly Wages" (L21) was its only child: the account now sits right under it.
    expect(labels(thw.children)).toEqual(["510005 - Wage Dept 05"]);
    expect(isExpandable(thw)).toBe(false);
  });

  it("keys groups by label path so an expansion survives a reload", () => {
    const again = buildAccountTree([...ACCOUNTS].reverse());
    expect(find(again, "Paid Time Off").key).toBe(find(tree, "Paid Time Off").key);
    expect(find(tree, "Paid Time Off").key).toBe("g:Associate Benefits›Paid Time Off");
  });
});

describe("expandedForDepth + layoutMatrix", () => {
  const tree = buildAccountTree(ACCOUNTS);
  const keyOf = (label: string) => find(tree, label).key;

  it("opens every expandable group above the chosen level", () => {
    expect(expandedForDepth(tree, 12).size).toBe(0);
    expect([...expandedForDepth(tree, 14)]).toEqual([keyOf("Associate Wages"), keyOf("Associate Benefits")]);
    expect(expandedForDepth(tree, 18)).toEqual(
      new Set([keyOf("Associate Wages"), keyOf("Wages & Salaries"), keyOf("Associate Benefits"), keyOf("Paid Time Off")])
    );
    expect(expandedForDepth(tree, ACCOUNT_DEPTH)).toEqual(allExpanded(tree));
  });

  it("lays an expanded group out as its children then its subtotal", () => {
    const { columns, items } = layoutMatrix(tree, expandedForDepth(tree, 14));
    expect(columns.map((c) => [c.label, c.kind, c.outlineLevel])).toEqual([
      ["Wages & Salaries", "group", 1],
      ["Service Charge Distribution", "group", 1],
      ["Total Associate Wages", "subtotal", 0],
      ["Paid Time Off", "group", 1],
      ["Tax Expense", "group", 1],
      ["Total Associate Benefits", "subtotal", 0],
    ]);
    expect(items.map((i) => (i.type === "group" ? i.node.label : i.column.label))).toEqual([
      "Associate Wages",
      "Associate Benefits",
    ]);
  });

  it("collapsed to L12 is one column per top group", () => {
    expect(layoutMatrix(tree, new Set()).columns.map((c) => [c.label, c.kind])).toEqual([
      ["Associate Wages", "group"],
      ["Associate Benefits", "group"],
    ]);
  });

  it("at full depth, nests the accounts under every group above them", () => {
    const { columns } = layoutMatrix(tree, allExpanded(tree));
    const night = columns.find((c) => c.node.account === "511002")!;
    expect(night.kind).toBe("account");
    expect(night.parents.map((p) => p.label)).toEqual(["Associate Wages", "Wages & Salaries", "Hrly Overtime Prem"]);
    expect(night.outlineLevel).toBe(3);
    // A single-account group stays one column, named for the group.
    expect(columns.find((c) => c.node.label === "Mgmt Salaries")!.kind).toBe("group");
    expect(columns.at(-1)!.label).toBe("Total Associate Benefits");
  });
});

describe("matrix sums", () => {
  it("sums a column's accounts from a row's cells", () => {
    const tree = buildAccountTree(ACCOUNTS);
    const cells: BridgeCell[] = [
      { account: "511001", bucket: "payroll", months: [], total: 100, encoding: "AMOUNT" },
      { account: "511002", bucket: "payroll", months: [], total: 50, encoding: "AMOUNT" },
      { account: "560303", bucket: "payroll", months: [], total: 7, encoding: "AMOUNT" },
    ];
    const amounts = amountsOf(cells);
    expect(sumAccounts(amounts, find(tree, "Hrly Overtime Prem").accounts)).toBe(150);
    expect(sumAccounts(amounts, find(tree, "Associate Wages").accounts)).toBe(150);
    expect(sumAccounts(amounts, find(tree, "Associate Benefits").accounts)).toBe(7);
  });

  it("gives columns only to payroll accounts with a value under the filter", () => {
    const department = {
      code: "0010",
      name: "Rooms",
      totals: [],
      rows: [
        {
          cells: [
            { account: "511001", bucket: "payroll", months: [], total: 100, encoding: "AMOUNT" },
            { account: "560303", bucket: "payroll", months: [], total: 0, encoding: "AMOUNT" },
            { account: "988308", bucket: "hours", months: [], total: 40, encoding: "AMOUNT" },
          ],
        },
      ],
    } as unknown as BridgeDepartment;
    const hours: BridgeAccount = { code: "988308", name: "Hours", bucket: "hours", path: [] };
    expect(activePayrollAccounts([...ACCOUNTS, hours], [department]).map((a) => a.code)).toEqual(["511001"]);
  });
});
