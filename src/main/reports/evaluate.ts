/**
 * Evaluate a built-in report for (hotel, scenario) — the main-process glue
 * between the shared engine and the two stores.
 *
 * The scenario row (plaintext) gives the year; the results cache (encrypted)
 * gives the Kairos values; the mapping tables and the budget import
 * (plaintext) give the map index and the BST values. Each is built lazily
 * and only when the compiled report reaches an atom that needs it, and each
 * is memoised on its own stamp (see cache.ts), so a second evaluation of the
 * same scenario is the engine alone.
 *
 * Staleness is the Results page's own test — the fingerprint compare — so a
 * report and the page can never disagree about whether the numbers are
 * current.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { findReportDefinition, listReportDefinitions } from "../../shared/reports/definitions";
import { evaluateReport } from "../../shared/reports/engine";
import type {
  ReportBstInfo,
  ReportDefinitionSummary,
  ReportsEvaluateResponse,
} from "../../shared/reports/ipc";
import { UNAVAILABLE_MAP_INDEX } from "../../shared/reports/sources";
import type { ReportWarning } from "../../shared/reports/types";
import type { OuScope } from "../positions/ouScope";
import { computeFingerprint } from "../positions/outputsRepo";
import { prepared } from "../positions/stmtCache";
import { BstOverride, getBstSource } from "./bstSource";
import { getMapIndex, readMappingVersion } from "./mapsIndex";
import { getResultsSource } from "./resultsSource";

type Db = InstanceType<typeof Database>;

export interface ReportDbs {
  localDb: Db;
  secureDb: Db;
}

export interface EvaluateOptions {
  bst?: BstOverride;
}

function scenarioYear(localDb: Db, scope: OuScope, scenarioId: string): number {
  const row = prepared(
    localDb,
    `SELECT year FROM scenarios WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(scenarioId, scope.ou) as { year: number } | undefined;
  if (!row) throw new Error("The scenario does not exist for this hotel.");
  return Number(row.year);
}

export function evaluateReportForScenario(
  dbs: ReportDbs,
  scope: OuScope,
  scenarioId: string,
  definitionId: string,
  options: EvaluateOptions = {}
): ReportsEvaluateResponse {
  const compiled = findReportDefinition(definitionId);
  if (!compiled) throw new Error(`Unknown report "${definitionId}".`);

  const { localDb, secureDb } = dbs;
  const year = scenarioYear(localDb, scope, scenarioId);

  const loadStart = performance.now();
  const results = getResultsSource(secureDb, scope, scenarioId);
  const needsMaps = [...compiled.atomsUsed].some((id) => compiled.atoms.get(id)!.usesMaps);
  const maps = needsMaps ? getMapIndex(localDb) : UNAVAILABLE_MAP_INDEX;
  const loadMs = performance.now() - loadStart;

  const bst: ReportBstInfo[] = [];
  const bstInfoKeys = new Set<string>();
  const warnings: ReportWarning[] = compiled.sourceKinds.has("kairos") ? [...results.warnings] : [];

  const evaluateStart = performance.now();
  const report = evaluateReport(compiled, {
    maps,
    warnings,
    getSource: (ref, warn) => {
      if (ref.source === "kairos") return results.source;
      const load = getBstSource(localDb, scope.ou, year, ref, options.bst);
      if (load.warning) warn(load.warning);
      if (load.info) {
        const key = `${load.info.importId}|${load.info.bucketIndex}`;
        if (!bstInfoKeys.has(key)) {
          bstInfoKeys.add(key);
          bst.push(load.info);
        }
      }
      return load.source;
    },
  });
  const evaluateMs = performance.now() - evaluateStart;

  const run = results.run
    ? {
        computedAt: results.run.computedAt,
        stale:
          results.predatesCache ||
          computeFingerprint(localDb, secureDb, scope, scenarioId) !== results.run.fingerprint,
      }
    : null;

  return {
    ...report,
    scenarioId,
    year,
    run,
    mappingVersion: readMappingVersion(localDb),
    bst,
    timings: { loadMs, evaluateMs },
  };
}

export function listReportDefinitionSummaries(): ReportDefinitionSummary[] {
  return listReportDefinitions().map((compiled) => ({
    id: compiled.definition.id,
    name: compiled.definition.name,
    description: compiled.definition.description ?? "",
    sources: [...compiled.sourceKinds],
  }));
}
