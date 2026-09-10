/**
 * The "plan" source: a scenario's results laid over its BST bucket, plus the
 * drift between the two — what the user would push, and how far the BST is
 * from it.
 *
 * Both halves are memoised elsewhere (resultsSource.ts, bstSource.ts); this
 * module memoises the merge on their two stamps and on the clear rule set
 * (prefixes AND exceptions), because those decide what the overlay removes.
 * The rules come from the saved push configuration (bstPush/config.ts), read
 * by the IPC handler and passed in — never from the renderer's request, so a
 * report can never apply rules the user did not save. See
 * shared/reports/sources.ts for the overlay rules themselves.
 *
 * A hotel with no BST import gets the cache alone (with the BST warning) and
 * no drift: there is nothing to compare against, and the page says so.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { ClearRuleSet, compileClearRules } from "../../shared/bstPush/ipc";
import type { ReportBstInfo } from "../../shared/reports/ipc";
import {
  PlanDrift,
  ValueSource,
  comparePlanToBst,
  hasDrift,
  overlaySource,
} from "../../shared/reports/sources";
import type { ComboEntry, ReportWarning, ValueSourceRef } from "../../shared/reports/types";
import type { OuScope } from "../positions/ouScope";
import { BstOverride, getBstSource } from "./bstSource";
import { memo } from "./cache";
import { ResultsSourceLoad, getResultsSource, resultsSourceStamp } from "./resultsSource";

type Db = InstanceType<typeof Database>;
type BstRef = Extract<ValueSourceRef, { source: "bst" }>;

export interface PlanSourceLoad {
  source: ValueSource;
  /** Null when there is no BST to compare against. */
  drift: PlanDrift | null;
  /** The bucket the overlay sits on; null without an import. */
  bst: ReportBstInfo | null;
  warnings: ReportWarning[];
  results: ResultsSourceLoad;
}

/** What the overlay takes from the cache: every row but an allocation share
 *  (the push guards those `skip`). */
export const ownsEntry = (entry: ComboEntry): boolean => entry.valueKind !== "percent";

/** The push's own verdict, exceptions included: a kept account is not this tool's to overlay. */
export function clearsAccountWith(clearRules: ClearRuleSet) {
  return compileClearRules(clearRules).clears;
}

/** The part of the memo stamp the rule set contributes — order-insensitive. */
function clearRulesStamp(clearRules: ClearRuleSet): string {
  return `${[...clearRules.prefixes].sort().join(",")}!${[...clearRules.excludes].sort().join(",")}`;
}

export function driftWarning(drift: PlanDrift): ReportWarning {
  const parts: string[] = [];
  if (drift.differing) parts.push(`${drift.differing} changed`);
  if (drift.onlyInPlan) parts.push(`${drift.onlyInPlan} not yet in the BST`);
  if (drift.onlyInBst) parts.push(`${drift.onlyInBst} the push would clear`);
  return {
    code: "PLAN_NOT_PUSHED",
    message: `The BST does not hold this plan yet (${parts.join(", ")}) — push before reporting.`,
  };
}

export function getPlanSource(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  year: number,
  ref: BstRef,
  clearRules: ClearRuleSet,
  override?: BstOverride
): PlanSourceLoad {
  const results = getResultsSource(dbs.secureDb, scope, scenarioId);
  const bst = getBstSource(dbs.localDb, scope.ou, year, ref, override);
  if (!bst.source || !bst.info) {
    return {
      source: results.source,
      drift: null,
      bst: null,
      warnings: [...results.warnings, ...(bst.warning ? [bst.warning] : [])],
      results,
    };
  }

  const info = bst.info;
  const bucket = bst.source;
  const stamp = `${resultsSourceStamp(dbs.secureDb, scope, scenarioId)}|${info.importId}|${info.bucketIndex}|${clearRulesStamp(clearRules)}`;
  const merged = memo(
    dbs.secureDb,
    `reports:plan:${scope.ou}:${scenarioId}:${info.bucketIndex}`,
    stamp,
    () => {
      const clears = clearsAccountWith(clearRules);
      return {
        source: overlaySource(`plan:${scenarioId}`, bucket, results.source, ownsEntry, clears),
        drift: comparePlanToBst(results.source, bucket, ownsEntry, clears),
      };
    }
  );

  const warnings = [...results.warnings];
  if (hasDrift(merged.drift)) warnings.push(driftWarning(merged.drift));
  return { source: merged.source, drift: merged.drift, bst: info, warnings, results };
}

/**
 * The drift alone, for a column that reads the raw BST bucket: the nudge
 * belongs on the default view too, since that is where a user who never
 * pushed would be looking.
 */
export function getPlanDrift(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  year: number,
  ref: BstRef,
  clearRules: ClearRuleSet,
  override?: BstOverride
): PlanDrift | null {
  return getPlanSource(dbs, scope, scenarioId, year, ref, clearRules, override).drift;
}
