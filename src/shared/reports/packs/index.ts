/**
 * The budget pack: which pages it has and how each is built, from the
 * hotel's own combos and the mapping tables. Main supplies the universe
 * (department → accounts, across every column's source) and the labels;
 * this module turns them into page specs and definitions. Nothing here
 * touches a database, so a test can build a whole pack from literals.
 *
 * Page order (PS Loader's): Summary, Summary reporting, Hotel total, then per
 * level_7 group its summary ledger followed by its departments.
 */

import type { ReportDefinition } from "../types";
import { EXCLUDED_DEPARTMENTS, PACK_GROUP_ORDER, UNMAPPED_GROUP } from "./constants";
import { PackLabels, groupOf } from "./labels";
import { buildLedgerDefinition } from "./ledger";
import { buildSummaryDefinition } from "./summary";
import { buildSummaryReportingDefinition } from "./summaryReporting";

export * from "./constants";
export * from "./labels";
export { buildLedgerDefinition } from "./ledger";
export { buildSummaryDefinition } from "./summary";
export { buildSummaryReportingDefinition } from "./summaryReporting";

export type PackPageKind = "summary" | "summary_reporting" | "total" | "group" | "department";

/** The page the Reports rail opens directly as "Summary reporting". */
export const SUMMARY_REPORTING_PAGE_ID = "summary_reporting";

export interface PackPage {
  id: string;
  kind: PackPageKind;
  title: string;
  /** The level_7 group this page belongs to (group and department pages). */
  group: string | null;
  /** Bare department codes the page covers. */
  depts: string[];
}

export interface PackDepartment {
  code: string;
  name: string;
  group: string;
}

/** Department → the bare accounts it carries in any of the columns' sources. */
export type PackUniverse = ReadonlyMap<string, ReadonlySet<string>>;

export interface PackLayout {
  pages: PackPage[];
  departments: PackDepartment[];
  groups: string[];
}

/** Where a group sits in the pack's order: PS Loader's list first, other
 *  labels after it, the unmapped bucket last. */
export function groupRank(label: string): number {
  const index = PACK_GROUP_ORDER.indexOf(label);
  if (index >= 0) return index;
  return label === UNMAPPED_GROUP ? Number.MAX_SAFE_INTEGER : PACK_GROUP_ORDER.length;
}

/** The pack's pages for a universe, in presentation order. */
export function layoutPack(universe: PackUniverse, labels: PackLabels): PackLayout {
  const departments: PackDepartment[] = [...universe.keys()]
    .filter((code) => !EXCLUDED_DEPARTMENTS.has(code))
    .map((code) => ({ code, name: labels.deptName(code) ?? code, group: groupOf(labels, code) }))
    .sort(
      (a, b) =>
        groupRank(a.group) - groupRank(b.group) ||
        a.group.localeCompare(b.group) ||
        a.name.localeCompare(b.name) ||
        a.code.localeCompare(b.code)
    );
  const groups = [...new Set(departments.map((d) => d.group))];

  const pages: PackPage[] = [
    { id: "summary", kind: "summary", title: "Summary", group: null, depts: departments.map((d) => d.code) },
    {
      id: SUMMARY_REPORTING_PAGE_ID,
      kind: "summary_reporting",
      title: "Summary reporting",
      group: null,
      depts: departments.map((d) => d.code),
    },
    { id: "total", kind: "total", title: "Hotel total", group: null, depts: departments.map((d) => d.code) },
  ];
  for (const group of groups) {
    const members = departments.filter((d) => d.group === group);
    pages.push({
      id: `group:${group}`,
      kind: "group",
      title: `${group} summary`,
      group,
      depts: members.map((d) => d.code),
    });
    for (const dept of members) {
      pages.push({ id: `dept:${dept.code}`, kind: "department", title: `${dept.code} · ${dept.name}`, group, depts: [dept.code] });
    }
  }
  return { pages, departments, groups };
}

/** The definition behind one page. */
export function buildPackPageDefinition(
  page: PackPage,
  layout: PackLayout,
  universe: PackUniverse,
  labels: PackLabels
): ReportDefinition {
  const groups = () =>
    layout.groups.map((group) => ({
      label: group,
      depts: layout.departments.filter((d) => d.group === group).map((d) => d.code),
    }));
  if (page.kind === "summary") {
    return buildSummaryDefinition({
      id: "pack_summary",
      name: "Budget pack — summary",
      description: "Revenue, payroll, expenses, profit, hours and FTE by department group.",
      groups: groups(),
    });
  }
  if (page.kind === "summary_reporting") {
    return buildSummaryReportingDefinition({
      id: "pack_summary_reporting",
      name: "Summary reporting",
      description: "Hotel stats and sales, then heads, hours and payroll per department group.",
      groups: groups(),
    });
  }
  const accounts = new Set<string>();
  for (const dept of page.depts) for (const account of universe.get(dept) ?? []) accounts.add(account);
  return buildLedgerDefinition({
    id: `pack_${page.id.replace(/[^A-Za-z0-9_]/g, "_")}`,
    name: page.kind === "total" ? "Budget pack — hotel total" : `Budget pack — ${page.title}`,
    depts: page.depts,
    accounts: [...accounts].sort(),
    labels,
  });
}
