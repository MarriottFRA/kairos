/**
 * A definition that reads only Kairos' own staffing accounts — base and
 * prefix filters, every atom PINNED to Kairos, no maps — so the engine and
 * the evaluate paths can be exercised on an install that has never synced
 * the mapping tables. It was the built-in "Staffing statistics" report until
 * that became the own-path report (main/positions/staffingStatistics.ts);
 * the tests kept it because nothing else in the registry is maps-free.
 */

import {
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE,
  POSITION_COUNT_ACCOUNT,
} from "../../../positions/systemAccounts";
import type { Atom } from "../../types";
import { defineReport, header, line, spacer } from "../../definitions/defineReport";

const HEADCOUNT_ACCOUNTS = [...new Set(Object.values(HEADCOUNT_ACCOUNT_BY_JOB_TYPE))];
const KAIROS: Atom["source"] = { source: "kairos", pinned: true };

export const MAPS_FREE_STAFFING = defineReport({
  id: "maps_free_staffing",
  name: "Maps-free staffing (test fixture)",
  description: "Heads by grade, hours worked and hours per head, from the engine's staffing accounts.",
  atoms: [
    {
      id: "position_count",
      source: KAIROS,
      filters: [{ kind: "acc_base", codes: [POSITION_COUNT_ACCOUNT] }],
    },
    {
      id: "graded_heads",
      label: "Heads on a graded headcount account",
      source: KAIROS,
      filters: [{ kind: "acc_base", codes: HEADCOUNT_ACCOUNTS }],
    },
    {
      id: "hours",
      label: "Hours (A988 family less the headcount accounts)",
      source: KAIROS,
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
    header("HEADS"),
    line("position_count_line", "Position count", 1),
    line("graded_heads_line", "Graded heads", 1),
    spacer(),
    header("HOURS"),
    line("hours_line", "Hours", 1),
    line("hours_per_head", "Hours per head", 1),
  ],
});
