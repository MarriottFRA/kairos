/**
 * The work week as a report reads it off a value source.
 *
 * Kairos posts the hotel's EFFECTIVE week (shared/positions/effectiveWeek.ts:
 * the contract week scaled by the days a full-timer actually works) to the
 * budget as a statistic on department D0410, account A988112 (outputsRepo's
 * setup line) — posted in JANUARY ONLY, the way the level-valued statistics
 * are written: one fact about the year, not forty hours earned twelve times.
 * The BST holds the pull the same way. So the figure for the year is the
 * January value of the stored series, whichever source holds it; a series
 * whose January is blank but a later month is not (a setting entered
 * mid-year) reads the first month that carries it.
 *
 * Null when the source has no such row or the row is all zeros — the
 * caller falls back (evaluate.ts: the scenario year's figure, then the
 * effective week derived from the scenario's positions, then the setup
 * alone).
 */

import { bareAccount, bareDept } from "../positions/comboKey";
import {
  WEEKLY_HOURS_STAT_ACCOUNT,
  WEEKLY_HOURS_STAT_DEPARTMENT,
} from "../positions/systemAccounts";
import type { EffectiveWeekDerivation } from "../positions/effectiveWeek";
import type { ValueSource } from "./sources";
import type { ParamValue } from "./types";
import { MONTHS } from "./vec";

export const WEEKLY_HOURS_DEPT = bareDept(WEEKLY_HOURS_STAT_DEPARTMENT);
export const WEEKLY_HOURS_ACCOUNT = bareAccount(WEEKLY_HOURS_STAT_ACCOUNT);

export function readWeeklyHours(source: ValueSource | null | undefined): number | null {
  const entry = source?.get(WEEKLY_HOURS_DEPT, WEEKLY_HOURS_ACCOUNT);
  if (!entry) return null;
  for (let m = 0; m < MONTHS; m++) {
    const value = entry.vec[m];
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** The param shape: the week in every month AND in the Total, so that
 *  `weekly_hours * fte_weeks` is weekly × weeks in every slot. */
export function weeklyHoursParam(weekly: number): ParamValue {
  return { months: new Array<number>(MONTHS).fill(weekly), total: weekly };
}

/** Where a column's weekly hours came from — shown on the reconciliation
 *  report so a surprising FTE can be traced to its divisor. */
export type WeeklyHoursOrigin = "column" | "scenario_bst" | "scenario_results" | "derived" | "setup" | "override";

export const WEEKLY_HOURS_ORIGIN_LABELS: Record<WeeklyHoursOrigin, string> = {
  column: "the column's own D0410 / A988112 row",
  scenario_bst: "the scenario year's BST budget (D0410 / A988112)",
  scenario_results: "the scenario's results (D0410 / A988112)",
  derived: "the scenario's positions — derived, not yet posted",
  setup: "the hotel-year setup alone (no positions to average)",
  override: "a value typed for this report",
};

/** What a column resolved: the week and where it was read. */
export interface WeeklyHoursInfo {
  value: number;
  origin: WeeklyHoursOrigin;
  /** The working, when the week was derived here rather than read. */
  derivation?: EffectiveWeekDerivation;
}
