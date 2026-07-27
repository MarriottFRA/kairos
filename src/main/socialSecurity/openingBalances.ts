/**
 * NI/SS opening-balance pre-simulation.
 *
 * A cumulative scheme whose tax year does not start in January straddles the
 * prior calendar year: the simulation's Jan..(start-1) months must continue the
 * base that accrued from the tax-year start through last December. There is no
 * real prior-year data in the tool, so we reuse THIS year's positions with the
 * merit increase stripped (a close estimate), run the engine, and read off each
 * position's NI contributory base over the prior tax-year slice. The result is
 * written per (position, scheme) to component_values.ss_opening_base — a plain
 * input the main run seeds from and the user can override. Each SS block owns its
 * own opening base (keyed by its component def), so a recompute is scoped to the
 * one scheme being edited and never disturbs another scheme's values. A
 * per-period scheme or a January tax year has no opening base, so every position
 * is cleared to 0.
 *
 * The one PII touch: a narrow hiring_date read to zero the opening base for a
 * position first staffed in the simulation year (no prior-year accrual). Only
 * the year is used; no PII leaves this process.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { compile, simulate } from "../../shared/engine/simulate";
import { referenceVacation } from "../../shared/engine/reference";
import { MONTHS } from "../../shared/engine/types";
import {
  CalendarGetter,
  PositionDefaultsGetter,
  loadScenarioInput,
} from "../positions/loadScenarioInput";
import { OuScope } from "../positions/ouScope";
import { prepared } from "../positions/stmtCache";

type Db = InstanceType<typeof Database>;

/** Positions first staffed in (or after) the sim year — no prior-year accrual. */
function hiredInSimYear(
  valuesDb: Db,
  scope: OuScope,
  scenarioId: string,
  simYear: number
): Set<string> {
  const rows = prepared(
    valuesDb,
    `SELECT position_id, hiring_date FROM position_pii
      WHERE ou = ? AND scenario_id = ? AND deleted_at IS NULL`
  ).all(scope.ou, scenarioId) as Array<{ position_id: string; hiring_date: string | null }>;
  const set = new Set<string>();
  for (const row of rows) {
    if (!row.hiring_date) continue; // no date → assume already staffed
    const year = new Date(row.hiring_date).getFullYear();
    if (Number.isFinite(year) && year >= simYear) set.add(row.position_id);
  }
  return set;
}

/**
 * Recompute and persist one scheme's opening base for every position in the
 * scenario, keyed per (position, scheme) on component_values.ss_opening_base.
 * Returns how many rows were written. No-op-clears (writes 0) when the scheme is
 * per-period or January-start. Returns 0 without writing when the scheme has no
 * SOCIAL_SECURITY def (nothing to key the value on).
 */
export async function computeNiOpeningBalances(
  structureDb: Db,
  valuesDb: Db,
  scope: OuScope,
  scenarioId: string,
  ssSchemeId: string,
  getCalendarYear: CalendarGetter,
  now: string,
  getPositionDefaults?: PositionDefaultsGetter
): Promise<{ updated: number }> {
  const input = await loadScenarioInput(
    structureDb,
    valuesDb,
    scope,
    scenarioId,
    getCalendarYear,
    getPositionDefaults
  );

  // The SS def for THIS scheme (not merely the first) — its id keys the write.
  const ssDef = input.definitions.find(
    (def) => def.kind === "SOCIAL_SECURITY" && (def.ssSchemeId as string) === ssSchemeId
  );
  if (!ssDef) return { updated: 0 };
  const scheme = input.ssSchemes.find((s) => (s.id as string) === ssSchemeId);
  const startMonth = scheme?.taxYearStartMonth ?? 1;
  const cumulative = (scheme?.accumulationMode ?? "CUMULATIVE") === "CUMULATIVE";
  const seedable = !!scheme && cumulative && startMonth > 1;

  const openingByPos = new Map<string, number>();

  if (seedable && scheme) {
    const monthlyCap = scheme.monthlyCap ?? Infinity;
    const yearlyCap = scheme.yearlyCap ?? Infinity;
    // The SS base (SS_BASE selector, set by applySocialSecurityBase): the OUTPUT
    // lines to sum are the custom component ids plus, when includeBaseSalary, the
    // BASE_SALARY def (whose output line is already net of vacation). Vacation has
    // no output line, so it is added separately below via referenceVacation.
    const base = ssDef.baseSelector;
    const ssBase = base?.kind === "SS_BASE" ? base : undefined;
    const baseSalaryDefId = input.definitions.find((def) => def.kind === "BASE_SALARY")?.id;
    const includedIds = new Set<string>(
      (ssBase?.componentIds ?? []).map((id) => id as string)
    );
    if (ssBase?.includeBaseSalary && baseSalaryDefId) {
      includedIds.add(baseSalaryDefId as string);
    }
    const includeVacation = ssBase?.includeVacation ?? false;

    // Pre-sim: this year's data with raises stripped (no real prior year).
    const presimPositions = input.positions.map((position) => ({
      ...position,
      meritIncreasePct: 0,
      manualYearlyIncrease: 0,
    }));
    const compiled = compile({ ...input, positions: presimPositions });
    if ("errors" in compiled) {
      throw new Error(
        compiled.errors.map((entry) => entry.message).join(" ") ||
          "Cannot compute opening balances — the NI setup is invalid."
      );
    }
    const sim = simulate(compiled.plan);
    const hiredNew = hiredInSimYear(valuesDb, scope, scenarioId, input.scenario.year);

    for (const position of presimPositions) {
      const id = position.id as string;
      if (hiredNew.has(id)) {
        openingByPos.set(id, 0);
        continue;
      }
      // NI base per month = Σ of the included contributory-base component OUTPUT
      // lines (net base salary + custom lines), plus the vacation series when the
      // scheme includes it — mirroring the SS_BASE accumulator, which has no
      // output line of its own for vacation.
      const niBase = new Array(MONTHS).fill(0);
      for (const line of sim.positionLines(position.id)) {
        if (!includedIds.has(line.component.id as string)) continue;
        for (let m = 0; m < MONTHS; m++) niBase[m] += line.months[m];
      }
      if (includeVacation) {
        const vacation = referenceVacation(position, input.calendar);
        for (let m = 0; m < MONTHS; m++) niBase[m] += vacation[m];
      }
      // Cumulative capped base over the prior tax-year slice [startMonth..Dec].
      let sum = 0;
      for (let m = startMonth - 1; m < MONTHS; m++) sum += Math.min(niBase[m], monthlyCap);
      openingByPos.set(id, Math.min(sum, yearlyCap));
    }
  } else {
    // Not seedable: clear every position's opening base to 0.
    for (const position of input.positions) openingByPos.set(position.id as string, 0);
  }

  // Write per (position, scheme) into component_values, keyed by the scheme's SS
  // def. Ensure the row exists (mirrors positionsRepo.batchWrite's upsert idiom —
  // ou/scenario_id are inherited from the parent position), then set the value.
  const defId = ssDef.id as string;
  const ensureRow = prepared(
    valuesDb,
    `INSERT INTO component_values
       (position_id, component_def_id, ou, scenario_id, updated_at)
     SELECT id, ?, ou, scenario_id, ? FROM positions
      WHERE id = ? AND ou = ? AND scenario_id = ?
     ON CONFLICT(position_id, component_def_id) DO NOTHING`
  );
  const update = prepared(
    valuesDb,
    `UPDATE component_values
        SET ss_opening_base = ?, updated_at = ?, deleted_at = NULL
      WHERE position_id = ? AND component_def_id = ?
        AND ou = ? AND scenario_id = ?`
  );
  let updated = 0;
  valuesDb.transaction(() => {
    for (const [id, value] of openingByPos) {
      ensureRow.run(defId, now, id, scope.ou, scenarioId);
      const result = update.run(value, now, id, defId, scope.ou, scenarioId);
      updated += result.changes;
    }
  })();

  return { updated };
}
