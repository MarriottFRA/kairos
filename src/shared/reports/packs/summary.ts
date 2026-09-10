/**
 * The pack's summary page: the hotel, then one block per department group
 * (level_10, else level_7 — layoutPack), each with the same KPI set — revenue, payroll, other expenses,
 * department profit, hours, FTE, heads, payroll % of revenue, payroll per
 * FTE. The page a DOF reads first; the ledgers behind it are for the
 * questions it raises.
 *
 * Groups come from the maps at build time and are pinned as department code
 * lists (the direct-lookup path), so an unmapped department still appears,
 * in its own block at the end. Account selection stays on the map levels —
 * the workbook's definitions — so the same KPI means the same thing here and
 * on the Summary P&L.
 */

import { ACC, CODES, accBase, accLevel, accNotLevel, deptBase } from "../catalog/helpers";
import { FTE_HOURS_FILTERS, FTE_HOURS_MEASURE, MANAGER_FTE_ACCOUNTS, STAFFING, fteFormula } from "../catalog/staffing";
import { header, line, spacer } from "../definitions/defineReport";
import type { Atom, Measure, ReportDefinition, ReportRow } from "../types";

export interface SummaryGroupSpec {
  label: string;
  /** Bare department codes in the group. */
  depts: string[];
}

export interface SummaryPageSpec {
  id: string;
  name: string;
  description?: string;
  groups: SummaryGroupSpec[];
}

const KPI_ROWS: Array<{ key: string; label: string; indent: number }> = [
  { key: "revenue", label: "Revenue", indent: 1 },
  { key: "payroll", label: "Total payroll", indent: 1 },
  { key: "other", label: "Other expenses", indent: 1 },
  { key: "profit", label: "Department profit", indent: 0 },
  { key: "hours", label: "Hours", indent: 1 },
  { key: "fte", label: "FTE", indent: 1 },
  { key: "heads", label: "Heads", indent: 1 },
  { key: "payroll_pct", label: "Payroll % of revenue", indent: 1 },
  { key: "payroll_per_fte", label: "Payroll per FTE", indent: 1 },
];

function blockFor(prefix: string, label: string, depts: string[]): { atoms: Atom[]; measures: Measure[]; rows: ReportRow[] } {
  const scope = deptBase(...depts);
  const id = (key: string) => `${prefix}_${key}`;
  const atoms: Atom[] = [
    { id: id("revenue_a"), label: `${label}: revenue`, filters: [scope, accLevel(6, ACC.revenue)] },
    { id: id("payroll_a"), label: `${label}: total payroll`, filters: [scope, accLevel(9, ACC.totalPayroll)] },
    {
      id: id("other_a"),
      label: `${label}: other expenses (Profit Amount, less Revenue and Total Payroll)`,
      filters: [scope, accLevel(4, ACC.profitAmount), accNotLevel(6, ACC.revenue), accNotLevel(9, ACC.totalPayroll)],
    },
    {
      id: id("hours_a"),
      label: `${label}: manhours`,
      filters: [scope, accLevel(1, ACC.statistics), accLevel(4, ACC.totalManhours)],
    },
    { id: id("heads_a"), label: `${label}: position count`, filters: [scope, accBase(CODES.positionCount)] },
    // FTE as the staffing catalog defines it: manager heads plus the hours
    // that drive FTE ÷ the hours of a full-timer.
    { id: id("mgr_heads_a"), label: `${label}: manager heads`, filters: [scope, accBase(...MANAGER_FTE_ACCOUNTS)] },
    { id: id("fte_hours_a"), label: `${label}: hours driving FTE`, filters: [scope, ...FTE_HOURS_FILTERS] },
  ];
  const measures: Measure[] = [
    { id: id("revenue"), formula: id("revenue_a"), format: "currency" },
    { id: id("payroll"), formula: id("payroll_a"), format: "currency", polarity: "cost" },
    { id: id("other"), formula: id("other_a"), format: "currency", polarity: "cost" },
    { id: id("profit"), formula: `${id("revenue")} - ${id("payroll")} - ${id("other")}`, format: "currency" },
    { id: id("hours"), formula: id("hours_a"), format: "number", polarity: "cost" },
    { id: id("fte"), formula: fteFormula(id("mgr_heads_a"), id("fte_hours_a")), format: "ratio", polarity: "cost" },
    { id: id("heads"), formula: id("heads_a"), format: "number", polarity: "cost" },
    { id: id("payroll_pct"), formula: `pct(${id("payroll")}, ${id("revenue")})`, format: "percent", polarity: "cost" },
    { id: id("payroll_per_fte"), formula: `div(${id("payroll")}, ${id("fte")}) * annualise`, format: "rate", polarity: "cost" },
  ];
  const rows: ReportRow[] = [header(label.toUpperCase()), ...KPI_ROWS.map((k) => line(id(k.key), k.label, k.indent)), spacer()];
  return { atoms, measures, rows };
}

export function buildSummaryDefinition(spec: SummaryPageSpec): ReportDefinition {
  const atoms: Atom[] = [];
  // The hours of one full-timer, shared by every block's FTE line.
  const measures: Measure[] = [FTE_HOURS_MEASURE];
  const rows: ReportRow[] = [];

  const all = [...new Set(spec.groups.flatMap((g) => g.depts))];
  if (all.length > 0) {
    const hotel = blockFor("hotel", "Hotel", all);
    atoms.push(...hotel.atoms);
    measures.push(...hotel.measures);
    rows.push(...hotel.rows);
  }
  spec.groups.forEach((group, index) => {
    if (group.depts.length === 0) return;
    const block = blockFor(`g${index}`, group.label, group.depts);
    atoms.push(...block.atoms);
    measures.push(...block.measures);
    rows.push(...block.rows);
  });

  const definition: ReportDefinition = {
    id: spec.id,
    name: spec.name,
    version: 1,
    atoms,
    measures,
    rows,
    params: STAFFING.params ?? [],
  };
  if (spec.description) definition.description = spec.description;
  return definition;
}
