/**
 * Staffing statistics — the staffing accounts the engine posts by itself
 * (heads by grade, hours worked, position count), read from the scenario's
 * own results whatever column they sit in: every atom is PINNED to Kairos.
 * No maps needed: base and prefix filters only, so it runs on an install
 * that has never synced the mapping tables.
 */

import {
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE,
  POSITION_COUNT_ACCOUNT,
} from "../../positions/systemAccounts";
import type { Atom } from "../types";
import { defineReport, header, line, spacer } from "./defineReport";

const HEADCOUNT_ACCOUNTS = [...new Set(Object.values(HEADCOUNT_ACCOUNT_BY_JOB_TYPE))];
const KAIROS: Atom["source"] = { source: "kairos", pinned: true };

export const STAFFING_STATS = defineReport({
  id: "staffing_stats",
  name: "Staffing statistics",
  description:
    "Heads by grade, hours worked and hours per head, from the engine's staffing accounts.",
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
