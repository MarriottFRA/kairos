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
import { accountAllowed } from "../../shared/positions/fields";
import {
  accountVariants,
  bareAccount,
  bareDept,
  comboKeyOf,
  deptVariants,
  displayAccount,
  displayDept,
} from "../../shared/positions/comboKey";
import { listAccounts, listDepartments } from "../mappingTables/repo";
import {
  OutputAggRowDto,
  OutputLineDto,
  OutputSource,
  OutputValueKind,
  OutputsResponse,
} from "../../shared/positions/ipc";
import { STATS_ACCOUNT_FILTER } from "../../shared/positions/systemAccounts";
import { AllocationDto } from "../../shared/allocations/ipc";
import {
  DepartmentAgg,
  computeAllocationColumn,
} from "../../shared/allocations/compute";
import {
  isRateDriven,
  manualMonthlyAmounts,
} from "../../shared/manualInput/rowMath";
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
  /** Which of the four origins produced this line. Defaults to ENGINE. */
  source?: OutputSource;
  /** The originating row's id (manual row, allocation, buyout). */
  sourceRef?: string;
  /** Small JSON-serializable blob the Results inspector renders as-is. */
  detail?: Record<string, unknown>;
}

/** Sum a 12-month vector. */
function sumMonths(months: number[]): number {
  let total = 0;
  for (const value of months) total += value;
  return total;
}

/**
 * Level series → change series. The BST's contract for a cumulative statistic.
 *
 * Headcount, position count and allocation splits are LEVELS, not monthly
 * amounts: "5 heads" is one fact about the year, not five heads earned twelve
 * times. The BST stores them as movements and reads the running SUM, so a level
 * of 5 all year is loaded once, in January, and the other eleven months are 0 —
 * exactly what the legacy budget generated. A mid-year starter loads its 5 in
 * the month it comes online; a September leaver loads a −5 there. Sum the row up
 * to any month and you get that month's level back, which is what makes this
 * safe: nothing is lost, it is only encoded the way the target reads it.
 *
 * Posting the level in every month instead — what Kairos did until now — reads
 * downstream as 5, 10, 15, … heads, because the BST adds the months up.
 *
 * The epsilon squashes float noise between two nominally equal months into a
 * true 0, so a flat series really is January-only rather than January plus
 * eleven values at the fifteenth decimal.
 */
/**
 * Which definitions produce a LEVEL rather than a monthly amount, and therefore
 * get delta-encoded on the way out.
 *
 * Both permanent heads qualify (the per-row Headcount and the pinned Position
 * Count) and so does any STAT/HEADCOUNT block a user builds — they are all the
 * same kind of number. Hours and FTE are NOT: hours genuinely accrue month by
 * month. Resolved from the definitions rather than by hard-coded id, so a new
 * headcount block is covered the day it is created.
 */
export function cumulativeStatDefIds(
  definitions: Array<{ id: unknown; kind: string; statKind?: string }>
): Set<string> {
  return new Set(
    definitions
      .filter((def) => def.kind === "STAT" && def.statKind === "HEADCOUNT")
      .map((def) => def.id as string)
  );
}

export function toMonthlyDeltas(months: readonly number[]): number[] {
  const out = new Array<number>(MONTHS).fill(0);
  let previous = 0;
  for (let m = 0; m < MONTHS; m++) {
    const level = Number(months[m]) || 0;
    const delta = level - previous;
    out[m] = Math.abs(delta) < 1e-9 ? 0 : delta;
    previous = level;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Projection (simulation → output lines)
// ---------------------------------------------------------------------------

/** The minimum of the engine's SimulationResult this projection needs — kept
 *  structural so the projection has no dependency on the engine module. */
interface ProjectableResult {
  positionLines(id: never): Array<{
    component: { id: unknown; label: string };
    dept: string;
    account: string;
    months: ArrayLike<number> & Iterable<number>;
  }>;
}

export interface OutputProjection {
  lines: OutputLineWrite[];
  /** Component label → how many position lines it had dropped for want of an
   *  account. Surfaced on the Results page so the amount does not just vanish. */
  unpostedByLabel: Record<string, number>;
  /** Active positions all of whose posted lines came out zero — no salary or
   *  hours entered, or Count 0. */
  allZeroPositions: number;
}

/**
 * Turn a simulation into the lines that get PERSISTED, applying the workbook's
 * "Blank" contract: a line with no posting account is computed (and stays
 * available as a base for other components) but is never output.
 *
 * Lives here, beside the write it feeds, rather than inline in the IPC handler
 * that used to own it — it is a domain rule about what an output IS, and every
 * consumer of stored outputs must agree on it.
 *
 * `cumulativeDefIds` names the definitions whose lines are LEVELS rather than
 * monthly amounts (the headcount stats) and are therefore delta-encoded on the
 * way out — see toMonthlyDeltas. Passed in rather than read off the line because
 * the engine result carries only a component's id and label, and because the
 * engine has no business knowing how its numbers are stored: it emits the level
 * in every active month, exactly as before, and this projection re-expresses it.
 */
export function projectOutputLines(
  result: ProjectableResult,
  positions: Array<{ id: unknown }>,
  cumulativeDefIds: ReadonlySet<string> = new Set()
): OutputProjection {
  const lines: OutputLineWrite[] = [];
  const unpostedByLabel: Record<string, number> = {};
  let allZeroPositions = 0;

  for (const position of positions) {
    let nonZero = 0;
    for (const line of result.positionLines(position.id as never)) {
      if (!line.account) {
        unpostedByLabel[line.component.label] =
          (unpostedByLabel[line.component.label] ?? 0) + 1;
        continue;
      }
      const levels = Array.from(line.months);
      // The diagnostic asks "did this position produce any number at all", so it
      // reads the LEVELS. A full-year headcount delta-encodes to a January value
      // and eleven zeroes, and a leaver's nets to zero over the year — neither
      // means the position was empty.
      if (Math.abs(sumMonths(levels)) > 1e-9) nonZero++;

      const months = cumulativeDefIds.has(line.component.id as string)
        ? toMonthlyDeltas(levels)
        : levels;
      const total = sumMonths(months);
      lines.push({
        positionId: position.id as string,
        componentDefId: line.component.id as string,
        label: line.component.label,
        dept: line.dept,
        account: line.account,
        months,
        total,
        source: "ENGINE",
        sourceRef: position.id as string,
      });
    }
    if (nonZero === 0) allZeroPositions++;
  }

  return { lines, unpostedByLabel, allZeroPositions };
}

// ---------------------------------------------------------------------------
// Projection — the three non-engine sources
// ---------------------------------------------------------------------------
//
// These live beside projectOutputLines for the same reason it lives here: they
// are domain rules about what a persisted output IS, and every consumer of
// stored outputs (the Results page, the BST push) has to agree on them. None of
// them touch the engine — it computes position spread, which is all it should
// do. All three obey the same "Blank" contract: no account, no output line.
//
// The synthetic ids keep the (ou, scenario, position_id, component_def_id)
// primary key unique across sources; see the DDL comment in schema.ts.

/**
 * Buyouts — manual dept × account overrides that bypass the engine entirely.
 *
 * These were the one source already wired end to end EXCEPT for this step: the
 * compiler interns them and aggregate() sums them into the in-memory agg matrix,
 * but projectOutputLines only walks positionLines(), and a buyout has no
 * position. So the amounts were read, compiled, fingerprinted and
 * scenario-cloned, then silently dropped on the way to storage — invisible on
 * the Results page and absent from the BST push.
 *
 * Nothing is computed here: a buyout IS its twelve monthly values. Reading them
 * from the ScenarioInput rather than from SimulationResult is what keeps this
 * fix out of the engine.
 */
export function projectBuyoutLines(
  buyouts: Array<{
    id: string;
    departmentCode: string;
    accountCode: string;
    monthlyValues: number[];
    deletedAt?: string | null;
  }>
): OutputLineWrite[] {
  const lines: OutputLineWrite[] = [];

  for (const row of buyouts) {
    if (row.deletedAt) continue;
    if (!row.accountCode) continue; // Blank contract
    const months = Array.from({ length: MONTHS }, (_, m) =>
      Number(row.monthlyValues?.[m]) || 0
    );
    lines.push({
      positionId: `buyout:${row.id}`,
      componentDefId: "buyout",
      label: "Buyout",
      dept: row.departmentCode,
      account: row.accountCode,
      months,
      total: sumMonths(months),
      source: "BUYOUT",
      sourceRef: row.id,
      detail: {},
    });
  }

  return lines;
}

/**
 * Manual input — hand-entered lines that never came from the engine or the
 * budget pull.
 *
 * A row can post twice: the dollar side to its cost account and the operational
 * units to its stats account. Either account may be blank, and each side is
 * skipped independently — a row that only tracks covers with no cost is legal.
 *
 * The dollar amounts come from the shared rule (shared/manualInput/rowMath.ts),
 * the same one the Manual Input grid displays, so the page and the budget can
 * never disagree about what a row is worth.
 */
export function projectManualLines(
  rows: Array<{
    id: string;
    description: string;
    departmentCode: string;
    costAccount: string;
    statsAccount: string;
    rate: number | null;
    stats: number[];
    amounts: number[];
  }>
): OutputLineWrite[] {
  const lines: OutputLineWrite[] = [];

  for (const row of rows) {
    const label = row.description?.trim() || "Manual input";
    const rateDriven = isRateDriven(row.rate);

    if (row.costAccount) {
      const months = manualMonthlyAmounts(row);
      lines.push({
        positionId: `manual:${row.id}`,
        componentDefId: "manual:cost",
        label,
        dept: row.departmentCode,
        account: row.costAccount,
        months,
        total: sumMonths(months),
        source: "MANUAL",
        sourceRef: row.id,
        detail: {
          description: row.description,
          side: "cost",
          rateDriven,
          rate: rateDriven ? row.rate : null,
        },
      });
    }

    if (row.statsAccount) {
      const months = Array.from({ length: MONTHS }, (_, m) =>
        Number(row.stats?.[m]) || 0
      );
      lines.push({
        positionId: `manual:${row.id}`,
        componentDefId: "manual:stats",
        label,
        dept: row.departmentCode,
        account: row.statsAccount,
        months,
        total: sumMonths(months),
        source: "MANUAL",
        sourceRef: row.id,
        detail: { description: row.description, side: "stats", rateDriven },
      });
    }
  }

  return lines;
}

/**
 * Allocations — the departments × allocations spread, posted as statistics.
 *
 * One line per department per allocation, carrying the percentage as a PLAIN
 * NUMBER — 15.23 for a 15.23% share, so a department's splits add up to 100 —
 * in January only. That is how the BST holds a split: a level, loaded once, with
 * later changes arriving as adjustment entries (a share moving 5 → 4 is loaded
 * as −1 in the month it moves). A budget has no such changes, so the other
 * eleven months are 0. See toMonthlyDeltas.
 *
 * Excluded departments post an explicit 0 rather than being omitted. A missing
 * row and a zero share look identical downstream, but only one of them says
 * "this department was considered and deliberately given nothing".
 *
 * The percentages come from computeAllocationColumn untouched — the Allocations
 * page and the Results page must show the same split.
 */
export function projectAllocationLines(
  allocations: Array<
    Pick<AllocationDto, "id" | "name" | "spreadBase" | "excludedDepartments" | "injectAccount">
  >,
  departments: DepartmentAgg[]
): OutputLineWrite[] {
  const lines: OutputLineWrite[] = [];

  for (const allocation of allocations) {
    if (!allocation.injectAccount) continue; // Blank contract
    const column = computeAllocationColumn(allocation, departments);
    const excluded = new Set(allocation.excludedDepartments);

    for (const dept of departments) {
      const percent = column.get(dept.departmentCode) ?? 0;
      // Same rule the headcount stats go through, applied to a series that is
      // flat by construction: the whole share lands in January.
      const months = toMonthlyDeltas(new Array<number>(MONTHS).fill(percent));
      lines.push({
        positionId: `alloc:${allocation.id}`,
        // One line per department, so the department code is what makes this
        // row unique within the allocation under the composite primary key.
        componentDefId: `alloc:${dept.departmentCode}`,
        label: allocation.name,
        dept: dept.departmentCode,
        account: allocation.injectAccount,
        months,
        total: sumMonths(months),
        source: "ALLOCATION",
        sourceRef: allocation.id,
        detail: {
          spreadBase: allocation.spreadBase,
          percent: column.get(dept.departmentCode) ?? 0,
          excluded: excluded.has(dept.departmentCode),
        },
      });
    }
  }

  return lines;
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
    // Manual input and allocations post into the output too, so an edit to
    // either has to age the run — without these probes the numbers would change
    // underneath a run still claiming to be current. Appended rather than
    // slotted in beside their thematic neighbours: the join order IS the stamp,
    // so inserting mid-list would invalidate every stored run for nothing.
    probe(
      valuesDb,
      `SELECT MAX(updated_at), COUNT(*) FROM manual_input_rows
        WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`,
      scope.ou,
      scenarioId
    ),
    probe(
      structureDb,
      `SELECT MAX(updated_at), COUNT(*) FROM allocations
        WHERE ou = ? AND deleted_at IS NULL`,
      scope.ou
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
         (ou, scenario_id, position_id, component_def_id, label, dept, account,
          monthly_values, total, source, source_ref, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        line.total,
        line.source ?? "ENGINE",
        line.sourceRef ?? "",
        JSON.stringify(line.detail ?? {})
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// Read (Results page)
// ---------------------------------------------------------------------------

/** Convention carried from the workbook: stats accounts (counts/hours/FTE) are
 *  the A9… range, everything else is currency. Display-only — it drives the
 *  Results page's Costs/Statistics toggle. Resolved through the shared filter
 *  and matcher, so it cannot drift from what the account pickers offer. */
function isStatsAccount(account: string): boolean {
  return accountAllowed(account, STATS_ACCOUNT_FILTER);
}

/** Display order for a row's source chips — engine first, then the hand-made
 *  sources in the order a user meets them in the app. */
const SOURCE_ORDER: readonly OutputSource[] = [
  "ENGINE",
  "MANUAL",
  "ALLOCATION",
  "BUYOUT",
];

const SOURCE_SET: ReadonlySet<string> = new Set(SOURCE_ORDER);

/** Rows written before the provenance columns existed carry '' — they are all
 *  engine lines, which is what the column DEFAULT says too. */
function normalizeSource(value: unknown): OutputSource {
  const source = String(value ?? "");
  return SOURCE_SET.has(source) ? (source as OutputSource) : "ENGINE";
}

/**
 * How the Results grid should read this row's numbers.
 *
 * An allocation split is a share out of 100, so "percent" tells the grid to
 * render it with a % sign rather than as money. A row is only a percent if EVERY
 * line in it is one: the moment a real statistic shares the account, the numbers
 * are ordinary counts again and pretending otherwise would hide the collision.
 */
function resolveValueKind(
  isStats: boolean,
  sources: ReadonlySet<OutputSource>
): OutputValueKind {
  if (sources.size === 1 && sources.has("ALLOCATION")) return "percent";
  return isStats ? "count" : "currency";
}

/** How many block names one row will carry. A row that names twenty blocks
 *  answers nothing, and the inspector is where the full list belongs. */
export const BLOCK_LABEL_CAP = 12;

/**
 * Code → description for accounts and departments, keyed on the CANONICAL code.
 *
 * Keyed bare (the comboKeyOf normalisation) because the output table holds
 * whatever spelling each source wrote — a typed "988112" has to find the
 * mapping table's "A988112" row, exactly as it already finds its way into the
 * same aggregation row.
 *
 * Fail-soft by design: mapping tables are a downloaded cache, so a fresh
 * install that has never synced has no account_maps table at all. A result row
 * is still correct without a description, and refusing to load the whole
 * Results page over a missing nicety would be the wrong trade.
 */
function nameLookup(db: Db): {
  accounts: Map<string, string>;
  departments: Map<string, string>;
} {
  const empty = { accounts: new Map<string, string>(), departments: new Map<string, string>() };
  try {
    return {
      accounts: new Map(listAccounts(db).map((row) => [bareAccount(row.code), row.name])),
      departments: new Map(listDepartments(db).map((row) => [bareDept(row.code), row.name])),
    };
  } catch {
    return empty;
  }
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

  // `label` carries the block name for engine lines — the per-block grain the
  // aggregation below throws away. It has always been on disk; selecting it is
  // the whole cost of naming a row's blocks (no recalculation, no engine).
  const lineRows = prepared(
    valuesDb,
    `SELECT dept, account, monthly_values, total, source, label
       FROM engine_output_lines
      WHERE ou = ? AND scenario_id = ?`
  ).all(scope.ou, scenarioId) as Array<{
    dept: string;
    account: string;
    monthly_values: string;
    total: number;
    source: string;
    label: string | null;
  }>;

  const names = nameLookup(structureDb);
  const byKey = new Map<string, OutputAggRowDto>();
  const sourcesByKey = new Map<string, Set<OutputSource>>();
  /** Per row: block label → summed |contribution|, so the chips can be ordered
   *  by what actually drives the number rather than by insertion. */
  const blocksByKey = new Map<string, Map<string, number>>();
  for (const line of lineRows) {
    // Keyed on the canonical combo, not the raw strings: "D0410" and a typed
    // "0410" are one row on this page because they are one row in the BST.
    const key = comboKeyOf(line.dept, line.account);
    const account = displayAccount(line.account);
    let row = byKey.get(key);
    if (!row) {
      row = {
        dept: displayDept(line.dept),
        account,
        accountName: names.accounts.get(bareAccount(line.account)) ?? "",
        departmentName: names.departments.get(bareDept(line.dept)) ?? "",
        isStats: isStatsAccount(account),
        months: new Array(MONTHS).fill(0),
        total: 0,
        sources: [],
        blockLabels: [],
        valueKind: "currency",
      };
      byKey.set(key, row);
      sourcesByKey.set(key, new Set());
      blocksByKey.set(key, new Map());
    }
    const source = normalizeSource(line.source);
    sourcesByKey.get(key)!.add(source);
    const label = (line.label ?? "").trim();
    if (source === "ENGINE" && label) {
      const blocks = blocksByKey.get(key)!;
      blocks.set(label, (blocks.get(label) ?? 0) + Math.abs(line.total));
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

  for (const [key, row] of byKey) {
    const sources = sourcesByKey.get(key)!;
    row.sources = SOURCE_ORDER.filter((source) => sources.has(source));
    row.blockLabels = [...blocksByKey.get(key)!.entries()]
      // Biggest driver first, name as the tie-break so a row's chips are stable
      // between reads (two blocks contributing zero must not swap places).
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, BLOCK_LABEL_CAP)
      .map(([label]) => label);
    row.valueKind = resolveValueKind(row.isStats, sources);
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

// ---------------------------------------------------------------------------
// Read (Results inspector)
// ---------------------------------------------------------------------------

/**
 * What a line should be CALLED in the inspector, in the user's terms.
 *
 * Engine lines resolve to the job title, falling back to the standard title and
 * then the classification code — "Front Desk Agent" answers "where did this
 * number come from" in a way a position UUID never will.
 *
 * Job Title is safe to show and is NOT an employee name. It lives in the
 * position_pii table purely as storage; the field catalog is explicit that it
 * "describes the post, not the person" and is never masked in the grid either.
 * first_name / last_name are deliberately not selected by the query below — the
 * inspector answers which POST produced a number, not which person.
 */
function resolveDisplayName(row: {
  source: string;
  label: string;
  title: string | null;
  extra_values: string | null;
  job_type_code: string | null;
}): string {
  if (normalizeSource(row.source) !== "ENGINE") return row.label;

  const title = (row.title ?? "").trim();
  if (title) return title;

  try {
    const extras = JSON.parse(row.extra_values ?? "{}") as Record<string, unknown>;
    const standard = String(extras.standardJobTitle ?? "").trim();
    if (standard) return standard;
  } catch {
    // A malformed blob is not worth failing a drill-down over.
  }

  return (row.job_type_code ?? "").trim() || "Position";
}

/**
 * The lines behind one dept×account row — what the Results inspector renders.
 *
 * This is the drill-down the output table was always shaped for: it keeps the
 * per-(source row, component) grain and readOutputs is the thing that throws it
 * away. No recalculation and no engine involvement; the answer is already on
 * disk from the last run.
 *
 * engine_output_lines, positions and position_pii all live in the encrypted
 * store, so one query resolves the job title and the Count — no second round
 * trip and no PII channel. The joins are LEFT because the non-engine sources
 * have synthetic position ids that match nothing, which is correct: their name
 * comes from the line's own label.
 *
 * Lines are returned largest-contribution first, so the answer to "why is this
 * number big" is the first row.
 *
 * dept/account arrive canonical (readOutputs merged the spellings away), so the
 * match is against both spellings of each code — otherwise a row assembled from
 * a typed "0410" would drill down to nothing.
 */
export function readOutputLines(
  valuesDb: Db,
  scope: OuScope,
  scenarioId: string,
  dept: string,
  account: string,
  /** 0-based month to rank by; omit to rank by the year total. */
  month?: number
): OutputLineDto[] {
  const rows = prepared(
    valuesDb,
    `SELECT l.source, l.source_ref, l.label, l.monthly_values, l.total, l.detail,
            p.job_type_code, p.headcount, pii.title, pii.extra_values
       FROM engine_output_lines l
       LEFT JOIN positions    p   ON p.id = l.position_id
       LEFT JOIN position_pii pii ON pii.position_id = l.position_id
      WHERE l.ou = ? AND l.scenario_id = ?
        AND UPPER(TRIM(l.dept)) IN (?, ?)
        AND UPPER(TRIM(l.account)) IN (?, ?)`
  ).all(
    scope.ou,
    scenarioId,
    ...deptVariants(dept),
    ...accountVariants(account)
  ) as Array<{
    source: string;
    source_ref: string;
    label: string;
    monthly_values: string;
    total: number;
    detail: string;
    job_type_code: string | null;
    headcount: number | null;
    title: string | null;
    extra_values: string | null;
  }>;

  const lines: OutputLineDto[] = rows.map((row) => {
    let months: number[] = [];
    try {
      months = JSON.parse(row.monthly_values) as number[];
    } catch {
      months = [];
    }
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(row.detail || "{}") as Record<string, unknown>;
    } catch {
      detail = {};
    }

    return {
      source: normalizeSource(row.source),
      sourceRef: row.source_ref ?? "",
      label: row.label,
      months: Array.from({ length: MONTHS }, (_, m) => Number(months[m]) || 0),
      total: row.total,
      displayName: resolveDisplayName(row),
      headcount: row.headcount === null ? null : Number(row.headcount),
      detail,
    };
  });

  const weight = (line: OutputLineDto) =>
    month === undefined ? line.total : line.months[month] ?? 0;

  // Biggest contribution first; ties fall back to the name so the order is
  // stable between reads (SQLite does not promise one).
  return lines.sort(
    (a, b) =>
      Math.abs(weight(b)) - Math.abs(weight(a)) ||
      a.displayName.localeCompare(b.displayName)
  );
}
