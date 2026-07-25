/**
 * Outputs repository — the persisted engine results (encrypted store).
 *
 * Recalculate is clear-then-insert in ONE transaction (the budget-import /
 * KPI-cache overwrite idiom): at most one live run per (ou, scenario), and a
 * new run always replaces the last wholesale. Lines keep the per-(position,
 * component) grain for future drill-down; the Results read aggregates them to
 * dept×account here.
 *
 * Staleness is a fingerprint compare. The fingerprint concatenates cheap
 * MAX(updated_at)/COUNT probes over every input source — positions, block
 * inputs, buyouts (encrypted) and definitions, block configs, base refs, SS
 * schemes, the calendar year, the KPI cache and the current budget import
 * (plaintext). Any drift ⇒ the stored run shows the "out of date" chip.
 * Probes are individually defensive: a table missing in a minimal test DB
 * reads as an empty part rather than throwing.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { OutputAggRowDto, OutputsResponse } from "../../shared/positions/ipc";
import { OuScope } from "./ouScope";
import { prepared } from "./stmtCache";

type Db = InstanceType<typeof Database>;

const MONTHS = 12;

export interface OutputLineWrite {
  positionId: string;
  componentDefId: string;
  label: string;
  dept: string;
  account: string;
  months: number[];
  total: number;
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

function probe(db: Db, sql: string, ...params: unknown[]): string {
  try {
    const row = prepared(db, sql).get(...params) as
      | Record<string, unknown>
      | undefined;
    if (!row) return "";
    return Object.values(row)
      .map((value) => String(value ?? ""))
      .join(",");
  } catch {
    return ""; // table absent (minimal test DB) — reads as an empty source
  }
}

/**
 * Fingerprint every input source of a budget run for (ou, scenario). Cheap:
 * a handful of indexed single-row aggregates. Same function computes the
 * stored stamp (at recalc) and the comparison (at read).
 */
export function computeFingerprint(
  structureDb: Db,
  valuesDb: Db,
  scope: OuScope,
  scenarioId: string
): string {
  const scenario = probe(
    structureDb,
    `SELECT year, updated_at FROM scenarios WHERE id = ? AND ou = ?`,
    scenarioId,
    scope.ou
  );
  const year = scenario.split(",")[0] ?? "";
  const bareOu = scope.ou.replace(/^OU/, "");

  const parts = [
    scenario,
    probe(
      valuesDb,
      `SELECT MAX(updated_at), COUNT(*) FROM positions
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`,
      scope.ou,
      scenarioId
    ),
    probe(
      valuesDb,
      `SELECT MAX(updated_at), COUNT(*) FROM component_values
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`,
      scope.ou,
      scenarioId
    ),
    probe(
      valuesDb,
      `SELECT MAX(updated_at), COUNT(*) FROM buyout_rows
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`,
      scope.ou,
      scenarioId
    ),
    probe(
      structureDb,
      `SELECT MAX(updated_at), COUNT(*) FROM cost_component_definitions
        WHERE ou = ? AND deleted_at IS NULL`,
      scope.ou
    ),
    probe(
      structureDb,
      `SELECT MAX(updated_at), COUNT(*) FROM block_configs
        WHERE ou = ? AND deleted_at IS NULL`,
      scope.ou
    ),
    probe(
      structureDb,
      `SELECT COUNT(*) FROM component_base_refs r
         JOIN cost_component_definitions d ON d.id = r.component_def_id
        WHERE d.ou = ?`,
      scope.ou
    ),
    probe(
      structureDb,
      `SELECT MAX(updated_at), COUNT(*) FROM ss_schemes
        WHERE ou = ? AND deleted_at IS NULL`,
      scope.ou
    ),
    // Calendars were saved under either OU form (see the scenario-input
    // handler); the year comes from the scenario row probed above.
    probe(
      structureDb,
      `SELECT MAX(updated_at) FROM calendar_years
        WHERE ou IN (?, ?) AND year = ?`,
      scope.ou,
      bareOu,
      year
    ),
    probe(
      structureDb,
      `SELECT MAX(computed_at), COUNT(*) FROM kpi_driver_values WHERE ou = ?`,
      scope.ou
    ),
    probe(
      structureDb,
      `SELECT id, committed_at FROM budget_imports
        WHERE ou = ? ORDER BY committed_at DESC LIMIT 1`,
      scope.ou
    ),
    // Hotel clusters (cross-OU reference data, no ou filter): the repo stamps
    // hotel_clusters.updated_at on EVERY save — members are rewritten in the
    // same transaction — so head-stamp+count covers renames, membership and
    // weight edits; the members probe is belt and braces for weight drift.
    // Assignment/override edits live on positions and are caught above.
    probe(
      structureDb,
      `SELECT MAX(updated_at), COUNT(*) FROM hotel_clusters
        WHERE deleted_at IS NULL`
    ),
    probe(
      structureDb,
      `SELECT COUNT(*), COALESCE(SUM(weight), 0) FROM hotel_cluster_members`
    ),
  ];
  return parts.join("§");
}

// ---------------------------------------------------------------------------
// Write (Recalculate)
// ---------------------------------------------------------------------------

export function writeRun(
  db: Db,
  scope: OuScope,
  scenarioId: string,
  run: { fingerprint: string; computedAt: string; positionCount: number },
  lines: OutputLineWrite[]
): void {
  db.transaction(() => {
    prepared(
      db,
      `DELETE FROM engine_output_lines WHERE ou = ? AND scenario_id = ?`
    ).run(scope.ou, scenarioId);
    prepared(
      db,
      `INSERT INTO engine_runs (ou, scenario_id, fingerprint, computed_at, line_count, position_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ou, scenario_id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         computed_at = excluded.computed_at,
         line_count = excluded.line_count,
         position_count = excluded.position_count`
    ).run(scope.ou, scenarioId, run.fingerprint, run.computedAt, lines.length, run.positionCount);

    const insert = prepared(
      db,
      `INSERT INTO engine_output_lines
         (ou, scenario_id, position_id, component_def_id, label, dept, account, monthly_values, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const line of lines) {
      insert.run(
        scope.ou,
        scenarioId,
        line.positionId,
        line.componentDefId,
        line.label,
        line.dept,
        line.account,
        JSON.stringify(line.months),
        line.total
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// Read (Results page)
// ---------------------------------------------------------------------------

/** Legacy convention carried from the workbook: accounts starting "9" are
 *  statistics (counts/hours), everything else currency. Display-only. */
function isStatsAccount(account: string): boolean {
  return account.startsWith("9");
}

export function readOutputs(
  structureDb: Db,
  valuesDb: Db,
  scope: OuScope,
  scenarioId: string
): OutputsResponse {
  const runRow = prepared(
    valuesDb,
    `SELECT fingerprint, computed_at, line_count, position_count
       FROM engine_runs WHERE ou = ? AND scenario_id = ?`
  ).get(scope.ou, scenarioId) as
    | { fingerprint: string; computed_at: string; line_count: number; position_count: number }
    | undefined;

  if (!runRow) return { run: null, stale: false, rows: [] };

  const lineRows = prepared(
    valuesDb,
    `SELECT dept, account, monthly_values, total
       FROM engine_output_lines
      WHERE ou = ? AND scenario_id = ?`
  ).all(scope.ou, scenarioId) as Array<{
    dept: string;
    account: string;
    monthly_values: string;
    total: number;
  }>;

  const byKey = new Map<string, OutputAggRowDto>();
  for (const line of lineRows) {
    const key = `${line.dept}|${line.account}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        dept: line.dept,
        account: line.account,
        isStats: isStatsAccount(line.account),
        months: new Array(MONTHS).fill(0),
        total: 0,
      };
      byKey.set(key, row);
    }
    let months: number[] = [];
    try {
      months = JSON.parse(line.monthly_values) as number[];
    } catch {
      months = [];
    }
    for (let m = 0; m < MONTHS; m++) row.months[m] += Number(months[m]) || 0;
    row.total += line.total;
  }

  const rows = [...byKey.values()].sort(
    (a, b) => a.dept.localeCompare(b.dept) || a.account.localeCompare(b.account)
  );

  const currentFingerprint = computeFingerprint(structureDb, valuesDb, scope, scenarioId);

  return {
    run: {
      computedAt: runRow.computed_at,
      lineCount: runRow.line_count,
      positionCount: runRow.position_count,
    },
    stale: currentFingerprint !== runRow.fingerprint,
    rows,
  };
}
