/**
 * Staffing statistics — a SAMPLE definition over the staffing accounts the
 * engine posts by itself (heads by grade, hours worked, position count). No
 * maps needed: every atom is a base or prefix filter, so it runs on an install
 * that has never synced the mapping tables.
 */

import {
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE,
  POSITION_COUNT_ACCOUNT,
} from "../../positions/systemAccounts";
import type { ReportDefinition } from "../types";

const HEADCOUNT_ACCOUNTS = [...new Set(Object.values(HEADCOUNT_ACCOUNT_BY_JOB_TYPE))];

export const STAFFING_STATS: ReportDefinition = {
  id: "staffing_stats",
  name: "Staffing statistics",
  description:
    "Heads by grade, hours worked and hours per head, from the engine's staffing accounts.",
  version: 1,
  atoms: [
    {
      id: "position_count",
      filters: [{ kind: "acc_base", codes: [POSITION_COUNT_ACCOUNT] }],
    },
    {
      id: "graded_heads",
      label: "Heads on a graded headcount account",
      filters: [{ kind: "acc_base", codes: HEADCOUNT_ACCOUNTS }],
    },
    {
      id: "hours",
      label: "Hours (A988 family less the headcount accounts)",
      filters: [
        { kind: "acc_prefix", prefixes: ["A988"] },
        { kind: "acc_base_not_in", codes: HEADCOUNT_ACCOUNTS },
      ],
    },
  ],
  measures: [
    { id: "position_count_line", formula: "position_count", format: "number" },
    { id: "graded_heads_line", formula: "graded_heads", format: "number" },
    { id: "hours_line", formula: "hours", format: "number" },
    { id: "hours_per_head", formula: "div(hours, position_count)", format: "ratio" },
  ],
  rows: [
    { type: "header", label: "HEADS" },
    { type: "measure", measureId: "position_count_line", label: "Position count", indent: 1 },
    { type: "measure", measureId: "graded_heads_line", label: "Graded heads", indent: 1 },
    { type: "spacer" },
    { type: "header", label: "HOURS" },
    { type: "measure", measureId: "hours_line", label: "Hours", indent: 1 },
    { type: "measure", measureId: "hours_per_head", label: "Hours per head", indent: 1 },
  ],
};
