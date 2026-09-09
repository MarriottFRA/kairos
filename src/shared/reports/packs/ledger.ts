/**
 * A ledger page: every account a set of departments carries, laid out as
 * category → level_12 sub-group → account, with subtotals at each level,
 * Department Profit and GOP % — PS Loader's department sheet.
 *
 * Generated per page from the sources' own combos, so a BST-only account
 * gets a row beside a Kairos-only one. One atom per account
 * (dept_base + acc_base — the direct-lookup fast path, no map walk at
 * evaluation time); the subtotals are measures that SUM those atoms, so a
 * subtotal ties to exactly the rows above it and an account the maps do not
 * know still lands in a group ("Other accounts") rather than vanishing.
 *
 * A generated definition is an ordinary ReportDefinition: the same engine
 * evaluates it, the same drill-down explains it, the same writer exports it.
 */

import type { ReportDefinition, ReportRow } from "../types";
import { header, line, spacer } from "../definitions/defineReport";
import { LEDGER_CATEGORY_ORDER, LedgerCategory, UNMAPPED_ACCOUNT_GROUP } from "./constants";
import { PackLabels, accountGroupOf, categoryOf } from "./labels";

export interface LedgerPageSpec {
  id: string;
  name: string;
  description?: string;
  /** Bare department codes the page sums over. */
  depts: string[];
  /** Bare account codes present for those departments (any source). */
  accounts: string[];
  labels: PackLabels;
}

interface AccountLine {
  code: string;
  name: string;
  category: LedgerCategory;
  group: string;
}

const ident = (code: string) => code.replace(/[^A-Za-z0-9_]/g, "_");
const atomIdOf = (code: string) => `a_${ident(code)}`;
const measureIdOf = (code: string) => `m_${ident(code)}`;

function sumFormula(ids: string[]): string {
  return ids.length === 0 ? "0" : ids.join(" + ");
}

export function buildLedgerDefinition(spec: LedgerPageSpec): ReportDefinition {
  const { labels } = spec;
  const lines: AccountLine[] = [...new Set(spec.accounts)].map((code) => ({
    code,
    name: labels.accountName(code) ?? code,
    category: categoryOf(labels, code),
    group: accountGroupOf(labels, code),
  }));

  const atoms: ReportDefinition["atoms"] = [];
  const measures: ReportDefinition["measures"] = [];
  const rows: ReportRow[] = [];
  const categoryTotals = new Map<LedgerCategory, string>();

  for (const category of LEDGER_CATEGORY_ORDER) {
    const inCategory = lines.filter((l) => l.category === category);
    if (inCategory.length === 0) continue;
    const isStats = category === "Stats";
    const format = isStats ? "number" : "currency";
    const polarity = category === "Revenue" || isStats ? undefined : ("cost" as const);
    const catId = `cat_${ident(category)}`;

    rows.push(header(category.toUpperCase()));

    // Sub-groups by level_12, named ones first, the residual last.
    const groups = new Map<string, AccountLine[]>();
    for (const l of inCategory) {
      let list = groups.get(l.group);
      if (!list) groups.set(l.group, (list = []));
      list.push(l);
    }
    const groupNames = [...groups.keys()].sort((a, b) =>
      a === UNMAPPED_ACCOUNT_GROUP ? 1 : b === UNMAPPED_ACCOUNT_GROUP ? -1 : a.localeCompare(b)
    );
    const subGrouped = !isStats && groupNames.length > 1;
    const groupTotalIds: string[] = [];

    groupNames.forEach((groupName, groupIndex) => {
      const members = groups.get(groupName)!.sort((a, b) => a.code.localeCompare(b.code));
      if (subGrouped) rows.push(header(groupName, 1));
      const memberIds: string[] = [];
      for (const l of members) {
        const atomId = atomIdOf(l.code);
        const measureId = measureIdOf(l.code);
        atoms.push({
          id: atomId,
          label: `${l.code} ${l.name}`,
          filters: [
            { kind: "dept_base", codes: spec.depts },
            { kind: "acc_base", codes: [l.code] },
          ],
        });
        measures.push(polarity ? { id: measureId, formula: atomId, format, polarity } : { id: measureId, formula: atomId, format });
        memberIds.push(measureId);
        rows.push(line(measureId, `${l.code} · ${l.name}`, subGrouped ? 2 : 1));
      }
      if (subGrouped) {
        const groupId = `${catId}_g${groupIndex}`;
        measures.push(
          polarity
            ? { id: groupId, formula: sumFormula(memberIds), format, polarity }
            : { id: groupId, formula: sumFormula(memberIds), format }
        );
        groupTotalIds.push(groupId);
        rows.push(line(groupId, `Total ${groupName}`, 1));
      } else {
        groupTotalIds.push(...memberIds);
      }
    });

    measures.push(
      polarity
        ? { id: catId, formula: sumFormula(groupTotalIds), format, polarity }
        : { id: catId, formula: sumFormula(groupTotalIds), format }
    );
    categoryTotals.set(category, catId);
    rows.push(line(catId, `Total ${category}`));
    rows.push(spacer());
  }

  const revenue = categoryTotals.get("Revenue");
  const costIds = (["Cost of Sales", "Payroll", "Controllables", "Other"] as LedgerCategory[])
    .map((c) => categoryTotals.get(c))
    .filter((id): id is string => !!id);
  if (revenue) {
    measures.push({ id: "department_profit", formula: `${revenue} - (${sumFormula(costIds)})`, format: "currency" });
    measures.push({ id: "gop_pct", formula: `pct(department_profit, ${revenue})`, format: "percent" });
    rows.push(line("department_profit", "Department Profit"));
    rows.push(line("gop_pct", "GOP %"));
  } else if (costIds.length > 0) {
    measures.push({ id: "total_expenses", formula: sumFormula(costIds), format: "currency", polarity: "cost" });
    rows.push(line("total_expenses", "Total"));
  }

  const definition: ReportDefinition = {
    id: spec.id,
    name: spec.name,
    version: 1,
    atoms,
    measures,
    rows,
  };
  if (spec.description) definition.description = spec.description;
  return definition;
}
