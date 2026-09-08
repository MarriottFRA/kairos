/**
 * The scenario's results cache as a ValueSource, held in memory per run.
 *
 * The stamp is the run's computed_at plus the cache's own (written_at, count)
 * — a Recalculate moves the first, a cleanup rebuild moves the second, a
 * purge empties the third — so a stale in-memory copy cannot survive any of
 * the three. A run that predates the cache (secure v8) is aggregated from its
 * lines on the fly, exactly as readOutputs does, and NOT memoised: the next
 * Recalculate writes the cache and the fast path takes over.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { EMPTY_VALUE_SOURCE, ValueSource, buildValueSource } from "../../shared/reports/sources";
import type { ReportWarning } from "../../shared/reports/types";
import type { OuScope } from "../positions/ouScope";
import {
  ResultsCacheRow,
  aggregateResultRows,
  readLinesForAggregation,
  readResultsCache,
  readResultsCacheStamp,
} from "../positions/resultsCache";
import { prepared } from "../positions/stmtCache";
import { memo } from "./cache";

type Db = InstanceType<typeof Database>;

export interface ResultsRun {
  computedAt: string;
  fingerprint: string;
}

export interface ResultsSourceLoad {
  /** Null when the scenario was never calculated. */
  run: ResultsRun | null;
  source: ValueSource;
  warnings: ReportWarning[];
  /** True when the rows were aggregated from lines because the cache is empty. */
  predatesCache: boolean;
}

function toInputs(rows: readonly ResultsCacheRow[]) {
  return rows.map((row) => ({
    dept: row.dept,
    account: row.account,
    months: row.months,
    total: row.total,
    encoding: row.encoding,
  }));
}

export function readRun(secureDb: Db, scope: OuScope, scenarioId: string): ResultsRun | null {
  const row = prepared(
    secureDb,
    `SELECT computed_at, fingerprint FROM engine_runs WHERE ou = ? AND scenario_id = ?`
  ).get(scope.ou, scenarioId) as { computed_at: string; fingerprint: string } | undefined;
  return row ? { computedAt: row.computed_at, fingerprint: row.fingerprint } : null;
}

export function getResultsSource(
  secureDb: Db,
  scope: OuScope,
  scenarioId: string
): ResultsSourceLoad {
  const run = readRun(secureDb, scope, scenarioId);
  if (!run) {
    return {
      run: null,
      source: EMPTY_VALUE_SOURCE,
      predatesCache: false,
      warnings: [
        {
          code: "NO_RESULTS",
          message: "This scenario has not been calculated yet — open Results and Recalculate.",
        },
      ],
    };
  }

  const cacheStamp = readResultsCacheStamp(secureDb, scope, scenarioId);
  if (cacheStamp.count > 0) {
    // The fingerprint is in the stamp too: two runs in one millisecond share a
    // computed_at, but not the inputs they were computed from.
    const key = `${run.computedAt}|${run.fingerprint}|${cacheStamp.writtenAt}|${cacheStamp.count}`;
    const source = memo(secureDb, `reports:results:${scope.ou}:${scenarioId}`, key, () =>
      buildValueSource("kairos", toInputs(readResultsCache(secureDb, scope, scenarioId)))
    );
    return { run, source, predatesCache: false, warnings: [] };
  }

  const lines = readLinesForAggregation(secureDb, scope, scenarioId);
  if (lines.length === 0) {
    return {
      run,
      source: EMPTY_VALUE_SOURCE,
      predatesCache: false,
      warnings: [
        {
          code: "NO_RESULTS",
          message:
            "This scenario's results are not on this machine — Recalculate to produce them.",
        },
      ],
    };
  }
  return {
    run,
    source: buildValueSource("kairos", toInputs(aggregateResultRows(lines))),
    predatesCache: true,
    warnings: [
      {
        code: "RESULTS_PREDATE_CACHE",
        message:
          "These results were calculated before this version of Kairos; level statistics may read as movements. Recalculate to refresh.",
      },
    ],
  };
}
