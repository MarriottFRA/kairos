/**
 * Payroll summary — a SAMPLE definition, here to exercise the engine end to
 * end and to show the shape a real report takes. The account selections are
 * PLACEHOLDERS: the real lists (which accounts are salaries, which are
 * benefits, what "total revenue" is in the BST) come from the user, and the
 * BST revenue sign is an open question — a credit may be stored negative, in
 * which case `bst_total_revenue` wants `negate: true`.
 *
 * Every row goes through a measure, even one that shows an atom as-is, so
 * every line on a report is a formula and the drill-down is uniform.
 */

import { POSITION_COUNT_ACCOUNT } from "../../positions/systemAccounts";
import type { ReportDefinition } from "../types";

export const PAYROLL_SUMMARY: ReportDefinition = {
  id: "payroll_summary",
  name: "Payroll summary",
  description:
    "Wages, benefits and total payroll for the hotel, with payroll per head and payroll as a share of the BST's total revenue.",
  version: 1,
  atoms: [
    {
      id: "payroll_all",
      label: "All payroll accounts (placeholder: A5 prefix)",
      filters: [{ kind: "acc_prefix", prefixes: ["A5"] }],
    },
    {
      id: "benefits",
      label: "Benefits (placeholder: A56 prefix)",
      filters: [{ kind: "acc_prefix", prefixes: ["A56"] }],
    },
    {
      id: "headcount",
      label: "Position count",
      filters: [{ kind: "acc_base", codes: [POSITION_COUNT_ACCOUNT] }],
    },
    {
      id: "bst_total_revenue",
      label: "Total revenue (BST budget; placeholder: level 6 'Revenue')",
      source: { source: "bst", bucket: { type: "BUDGET" } },
      // Sign is an open question: if the BST stores revenue as a negative
      // credit, this atom needs negate: true.
      filters: [{ kind: "acc_level", level: 6, values: ["Revenue"] }],
    },
  ],
  measures: [
    { id: "wages_and_salaries", formula: "payroll_all - benefits", format: "currency" },
    { id: "benefits_line", formula: "benefits", format: "currency" },
    { id: "total_payroll", formula: "wages_and_salaries + benefits_line", format: "currency" },
    { id: "headcount_line", formula: "headcount", format: "number" },
    { id: "payroll_per_head", formula: "div(total_payroll, headcount)", format: "currency" },
    {
      id: "payroll_pct_revenue",
      formula: "pct(total_payroll, bst_total_revenue)",
      format: "percent",
    },
  ],
  rows: [
    { type: "header", label: "PAYROLL" },
    { type: "measure", measureId: "wages_and_salaries", label: "Wages & salaries", indent: 1 },
    { type: "measure", measureId: "benefits_line", label: "Benefits", indent: 1 },
    { type: "measure", measureId: "total_payroll", label: "Total payroll" },
    { type: "spacer" },
    { type: "header", label: "RATIOS" },
    { type: "measure", measureId: "headcount_line", label: "Position count", indent: 1 },
    { type: "measure", measureId: "payroll_per_head", label: "Payroll per head", indent: 1 },
    { type: "measure", measureId: "payroll_pct_revenue", label: "Payroll % of revenue", indent: 1 },
  ],
};
