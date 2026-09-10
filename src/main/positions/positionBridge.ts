/**
 * The payroll bridge read: every engine output line of a scenario, grouped
 * by the position (or the non-engine source) that produced it, per
 * department, with department totals that tie to the results cache.
 *
 * Three things keep the tie-out exact:
 *   - the department is the LINE's department, not the position's — a
 *     multiplier block can post to another department, and the cache is
 *     keyed by the line;
 *   - totals are summed in rowid order, the order aggregateResultRows walks,
 *     because float sums are order-sensitive;
 *   - non-engine lines (manual input, allocations, buyouts, setup) are rows of
 *     their own, so nothing the cache holds is missing from the page.
 *
 * Positions deleted after the run still have lines until the next
 * recalculation; they are shown, flagged. Only the PII title is read (the
 * policy readOutputLines set); a name never crosses this boundary.
 *
 * The compared scenario is the same read again, matched by lineage_id — the
 * key a clone carries forward — and never on a blank one.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { bareAccount, bareDept, deptVariants } from "../../shared/positions/comboKey";
import type { OutputEncoding } from "../../shared/positions/ipc";
import {
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE,
  POSITION_COUNT_ACCOUNT,
} from "../../shared/positions/systemAccounts";
import {
  BridgeBucket,
  BridgeCell,
  BridgeDepartment,
  BridgeRow,
  BridgeAccountStep,
  PositionBridgeResponse,
  bridgeAccountPath,
  classifyBridgeAccount,
} from "../../shared/reports/bridge";
import type { ReportRunInfo } from "../../shared/reports/ipc";
import { getBstSource } from "../reports/bstSource";
import { getMapIndex } from "../reports/mapsIndex";
import { getResultsSource } from "../reports/resultsSource";
import { computeFingerprint } from "./outputsRepo";
import type { OuScope } from "./ouScope";
import { normalizeEncoding, normalizeSource } from "./resultsCache";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

const MONTHS = 12;

const HEAD_ACCOUNTS: ReadonlySet<string> = new Set(
  [POSITION_COUNT_ACCOUNT, ...Object.values(HEADCOUNT_ACCOUNT_BY_JOB_TYPE)].map(bareAccount)
);

interface LineRecord {
  position_id: string;
  component_def_id: string;
  source: string;
  source_ref: string;
  label: string;
  dept: string;
  account: string;
  monthly_values: string;
  total: number;
  encoding: string;
  lineage_id: string | null;
  job_type_code: string | null;
  pay_type: string | null;
  headcount: number | null;
  fte: number | null;
  active: number | null;
  cluster_name_snapshot: string | null;
  deleted_at: string | null;
  title: string | null;
}

function readLines(secureDb: Db, scope: OuScope, scenarioId: string, dept?: string): LineRecord[] {
  const deptClause = dept ? `AND UPPER(TRIM(l.dept)) IN (?, ?)` : "";
  const params: unknown[] = [scope.ou, scenarioId];
  if (dept) params.push(...deptVariants(dept));
  return prepared(
    secureDb,
    `SELECT l.position_id, l.component_def_id, l.source, l.source_ref, l.label, l.dept, l.account,
            l.monthly_values, l.total, l.encoding,
            p.lineage_id, p.job_type_code, p.pay_type, p.headcount, p.fte, p.active,
            p.cluster_name_snapshot, p.deleted_at, pii.title
       FROM engine_output_lines l
       LEFT JOIN positions    p   ON p.id = l.position_id
       LEFT JOIN position_pii pii ON pii.position_id = l.position_id
      WHERE l.ou = ? AND l.scenario_id = ? ${deptClause}
      ORDER BY l.rowid`
  ).all(...params) as LineRecord[];
}

function parseMonths(raw: string): number[] {
  let months: number[] = [];
  try {
    months = JSON.parse(raw) as number[];
  } catch {
    months = [];
  }
  return Array.from({ length: MONTHS }, (_, m) => Number(months[m]) || 0);
}

function addCell(cells: BridgeCell[], account: string, bucket: BridgeBucket, months: number[], total: number, encoding: OutputEncoding) {
  let cell = cells.find((c) => c.account === account);
  if (!cell) {
    cell = { account, bucket, months: new Array<number>(MONTHS).fill(0), total: 0, encoding };
    cells.push(cell);
  }
  for (let m = 0; m < MONTHS; m++) cell.months[m] += months[m];
  cell.total += total;
  if (cell.encoding !== encoding) cell.encoding = "AMOUNT";
}

interface Classifier {
  bucketOf(account: string): BridgeBucket;
  nameOf(account: string): string | null;
  pathOf(account: string): BridgeAccountStep[];
  deptName(dept: string): string | null;
}

function classifier(localDb: Db): Classifier {
  const maps = getMapIndex(localDb);
  const cache = new Map<string, BridgeBucket>();
  return {
    pathOf: (account) =>
      bridgeAccountPath(account, {
        accountLabel: (code, level) => maps.labelAt("account", code, level),
        hasAccount: (code) => maps.hasAccount(code),
      }),
    bucketOf: (account) => {
      let bucket = cache.get(account);
      if (!bucket) {
        bucket = classifyBridgeAccount(
          account,
          { accountLabel: (code, level) => maps.labelAt("account", code, level) },
          HEAD_ACCOUNTS
        );
        cache.set(account, bucket);
      }
      return bucket;
    },
    nameOf: (account) => maps.name("account", account),
    deptName: (dept) => maps.name("dept", dept),
  };
}

function groupLines(records: LineRecord[], classify: Classifier): BridgeDepartment[] {
  const departments = new Map<string, BridgeDepartment>();
  const rowsByKey = new Map<string, BridgeRow>();

  for (const record of records) {
    const dept = bareDept(record.dept);
    const account = bareAccount(record.account);
    const source = normalizeSource(record.source);
    const encoding = normalizeEncoding(record.encoding);
    const months = parseMonths(record.monthly_values);
    const total = Number(record.total) || 0;
    const bucket = classify.bucketOf(account);

    let department = departments.get(dept);
    if (!department) {
      department = { code: dept, name: classify.deptName(dept) ?? dept, rows: [], totals: [] };
      departments.set(dept, department);
    }
    addCell(department.totals, account, bucket, months, total, encoding);

    const isPosition = source === "ENGINE" && record.job_type_code !== null;
    const key = isPosition
      ? `${dept}|pos:${record.position_id}`
      : `${dept}|${source}:${record.source_ref}:${record.label}`;
    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        key,
        source,
        positionId: isPosition ? record.position_id : null,
        lineageId: isPosition && record.lineage_id ? record.lineage_id : null,
        title: isPosition ? record.title ?? null : null,
        jobTypeCode: isPosition ? record.job_type_code : null,
        payType: isPosition ? record.pay_type : null,
        headcount: isPosition && record.headcount !== null ? Number(record.headcount) : null,
        fte: isPosition && record.fte !== null ? Number(record.fte) : null,
        clusterName: isPosition ? record.cluster_name_snapshot ?? null : null,
        active: isPosition ? record.active !== 0 : true,
        deleted: isPosition ? record.deleted_at !== null : false,
        label: isPosition ? (record.title ?? record.job_type_code ?? "") : record.label,
        cells: [],
        lines: [],
      };
      rowsByKey.set(key, row);
      department.rows.push(row);
    }
    addCell(row.cells, account, bucket, months, total, encoding);
    row.lines.push({ account, label: record.label, months, total, encoding });
  }

  const out = [...departments.values()].sort((a, b) => a.code.localeCompare(b.code));
  for (const department of out) {
    department.rows.sort(
      (a, b) =>
        Number(a.source !== "ENGINE") - Number(b.source !== "ENGINE") ||
        Math.abs(b.cells.reduce((s, c) => s + c.total, 0)) - Math.abs(a.cells.reduce((s, c) => s + c.total, 0)) ||
        a.label.localeCompare(b.label)
    );
    for (const cell of department.totals) cell.months = cell.months.map((m) => Number(m.toFixed(9)));
  }
  return out;
}

/** The scenario's year; throws when the hotel has no such scenario. */
export function scenarioYear(localDb: Db, scope: OuScope, scenarioId: string): number {
  const row = prepared(
    localDb,
    `SELECT year FROM scenarios WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(scenarioId, scope.ou) as { year: number } | undefined;
  if (!row) throw new Error("The scenario does not exist for this hotel.");
  return Number(row.year);
}

/** When the scenario was last calculated and whether its inputs moved since —
 *  null before any run. Shared with the staffing overview. */
export function readRunInfo(dbs: { localDb: Db; secureDb: Db }, scope: OuScope, scenarioId: string): ReportRunInfo | null {
  const results = getResultsSource(dbs.secureDb, scope, scenarioId);
  if (!results.run) return null;
  return {
    computedAt: results.run.computedAt,
    stale:
      results.predatesCache ||
      computeFingerprint(dbs.localDb, dbs.secureDb, scope, scenarioId) !== results.run.fingerprint,
  };
}

export function readPositionBridge(
  dbs: { localDb: Db; secureDb: Db },
  scope: OuScope,
  scenarioId: string,
  options: { dept?: string; compareScenarioId?: string } = {}
): PositionBridgeResponse {
  const { localDb, secureDb } = dbs;
  const year = scenarioYear(localDb, scope, scenarioId);
  const classify = classifier(localDb);
  const departments = groupLines(readLines(secureDb, scope, scenarioId, options.dept), classify);

  const accountCodes = new Set<string>();
  for (const department of departments) for (const cell of department.totals) accountCodes.add(cell.account);

  // What the BST holds for the same combos — the reconciliation strip.
  const bstLoad = getBstSource(localDb, scope.ou, year, { source: "bst", bucket: { type: "BUDGET" } });
  const byDept: Record<string, Record<string, number>> = {};
  if (bstLoad.source) {
    for (const department of departments) {
      const totals: Record<string, number> = {};
      for (const cell of department.totals) {
        const entry = bstLoad.source.get(department.code, cell.account);
        if (entry) totals[cell.account] = entry.reportVec[12];
      }
      byDept[department.code] = totals;
    }
  }

  let compare: PositionBridgeResponse["compare"] = null;
  if (options.compareScenarioId && options.compareScenarioId !== scenarioId) {
    const compareYear = scenarioYear(localDb, scope, options.compareScenarioId);
    compare = {
      scenarioId: options.compareScenarioId,
      year: compareYear,
      departments: groupLines(readLines(secureDb, scope, options.compareScenarioId, options.dept), classify),
    };
    for (const department of compare.departments) for (const cell of department.totals) accountCodes.add(cell.account);
  }

  return {
    scenarioId,
    year,
    run: readRunInfo(dbs, scope, scenarioId),
    departments,
    accounts: [...accountCodes].sort().map((code) => {
      const bucket = classify.bucketOf(code);
      return { code, name: classify.nameOf(code), bucket, path: bucket === "payroll" ? classify.pathOf(code) : [] };
    }),
    bst: {
      available: !!bstLoad.source,
      bucket: bstLoad.info ? `${bstLoad.info.bucketType ?? ""} ${bstLoad.info.year ?? ""}`.trim() : null,
      byDept,
    },
    compare,
  };
}
