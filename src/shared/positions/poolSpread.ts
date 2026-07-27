/**
 * Pooled-cost spread — the maths behind a POOL_SPREAD block.
 *
 * Every other block type computes each position independently from that
 * position's own inputs. This one inverts it: the block owns ONE pot per month
 * (a KPI series, or twelve typed amounts) and divides it among the positions
 * that are eligible that month. Gratuities are the driving case — total F&B
 * revenue × a percentage, shared out across the service staff.
 *
 *   share_i[m] = pot[m] × w_i[m] / Σ_j w_j[m]
 *   w_i[m]     = basis_i × headcount_i × hotelClusterWeight_i × seasonality_i[m]
 *
 * Two consequences are the point of the design, not side effects:
 *   - The pot is CONSERVED: the shares sum to exactly pot[m]. Zeroing someone's
 *     working months redistributes their share, it does not shrink the total.
 *   - Seasonality participates as a fraction, so a half-active month takes half
 *     a share and an inactive one drops out.
 *
 * headcount and the cluster weight are folded into the weight here rather than
 * left to the engine because the compiled definition is DIRECT_ABS, which the
 * VM's count-multiplier post-pass deliberately skips (see execute.ts). Applying
 * them in both places would multiply twice and break conservation.
 *
 * Pure and shared: called from BOTH loadScenarioInput and runLiveSim so the
 * grid's live totals and the persisted run can never disagree (liveSimParity
 * pins them).
 */

import { BlockDto, PoolEligibilityMode, PoolSpreadBase } from "../blocks/ipc";
import { KPI_EXPLICIT_DEPT_KEY } from "../kpiDrivers/ipc";
import { ComponentValue, MONTHS, Position } from "../engine/types";
import type { KpiSeriesSlice } from "./engineInput";

/** One block's resolved pot + division rules, ready to spread. */
export interface PoolSpreadSpec {
  /** The block's compiled cost definition — the key values are stored under. */
  costDefId: string;
  /** The pot to divide, Jan..Dec, already resolved from KPI or manual entry. */
  pot: number[];
  spreadBase: PoolSpreadBase;
  eligibilityMode: PoolEligibilityMode;
  /** RULE only: department codes; empty means every department. */
  departments: string[];
  /** RULE only: job-type codes; empty means every classification. */
  jobTypes: string[];
}

/** What one position's share is proportional to, before headcount/cluster/season.
 *  Negative inputs are clamped away — a negative weight would flip the sign of
 *  someone else's share and could cancel the divisor to near zero. */
export function poolBasisValue(
  base: PoolSpreadBase,
  position: Position
): number {
  const value = (() => {
    switch (base) {
      case "HEADCOUNT":
        // Weighted by headcount below like every other basis, so the raw
        // per-head figure here is 1 — the result is share-per-person.
        return 1;
      case "FTE":
        return position.fte;
      case "MANHOURS_WORKED":
        // Already resolved (derived or overridden) by both loaders.
        return position.yearlyHoursWorked;
      case "BASE_SALARY":
        return position.monthlyBaseSalary;
      case "VACATION_DAYS":
        return position.vacationDays;
      case "FLAT":
        // Equal per ROW rather than per person: undo the headcount weighting
        // that every other basis wants.
        return position.headcount !== 0 ? 1 / position.headcount : 0;
    }
  })();
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Whether a position shares this block's pot at all.
 *
 * RULE derives it from the block config — an empty filter list means "every
 * one of these", so a rule with neither list set includes the whole hotel. The
 * per-row tick box is ignored (and rendered locked) in this mode: the config
 * wins, so eligibility can never silently disagree with what it states.
 * MANUAL uses the tick alone.
 */
export function isPoolEligible(
  spec: Pick<PoolSpreadSpec, "eligibilityMode" | "departments" | "jobTypes">,
  position: Pick<Position, "departmentCode" | "jobTypeCode">,
  ticked: boolean
): boolean {
  if (spec.eligibilityMode !== "RULE") return ticked;
  if (
    spec.departments.length > 0 &&
    !spec.departments.includes(position.departmentCode)
  ) {
    return false;
  }
  if (
    spec.jobTypes.length > 0 &&
    !spec.jobTypes.includes(position.jobTypeCode)
  ) {
    return false;
  }
  return true;
}

/** Twelve zeros — a pot/share vector that books nothing. */
function zeroMonths(): number[] {
  return new Array<number>(MONTHS).fill(0);
}

function finite(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Resolve a POOL_SPREAD block's pot for the year.
 *
 * KPI: the driver's cached series, which already has the driver's multiplier
 * baked in. An EXPLICIT driver has the single '*' series; a POSITION-mode
 * driver has one per department, and a pool is a hotel-level pot, so those are
 * summed. MANUAL: the twelve typed amounts.
 */
export function resolvePoolPot(
  block: BlockDto,
  seriesByDriverId: (driverId: string) => KpiSeriesSlice[]
): number[] {
  if ((block.poolSource ?? "KPI") === "MANUAL") {
    const amounts = block.poolMonthlyAmounts ?? [];
    return Array.from({ length: MONTHS }, (_unused, m) => finite(amounts[m]));
  }

  const driverId = String(block.poolKpiDriverId ?? "").trim();
  if (!driverId) return zeroMonths();
  const series = seriesByDriverId(driverId);
  if (series.length === 0) return zeroMonths();

  const explicit = series.find((s) => s.deptKey === KPI_EXPLICIT_DEPT_KEY);
  if (explicit) {
    return Array.from({ length: MONTHS }, (_unused, m) =>
      finite(explicit.values[m])
    );
  }
  const pot = zeroMonths();
  for (const slice of series) {
    for (let m = 0; m < MONTHS; m++) pot[m] += finite(slice.values[m]);
  }
  return pot;
}

/** Every POOL_SPREAD block in the OU, resolved into a spec. Shared so both
 *  loaders assemble the specs identically from the same BlockDto list. */
export function buildPoolSpecs(
  blocks: BlockDto[],
  seriesByDriverId: (driverId: string) => KpiSeriesSlice[]
): PoolSpreadSpec[] {
  return blocks
    .filter((block) => block.blockType === "POOL_SPREAD")
    .map((block) => ({
      costDefId: block.costDefId,
      pot: resolvePoolPot(block, seriesByDriverId),
      spreadBase: block.poolSpreadBase ?? "HEADCOUNT",
      eligibilityMode: block.poolEligibilityMode ?? "MANUAL",
      departments: block.poolDepartments ?? [],
      jobTypes: block.poolJobTypes ?? [],
    }));
}

/**
 * Divide each spec's pot across its eligible positions and write the resulting
 * per-month shares into ComponentValue.monthlyValues, ready for the DIRECT_ABS
 * definition to book verbatim.
 *
 * Returns a NEW array. Unlike injectKpiSeries this cannot simply mutate: under
 * a RULE an eligible position usually has no stored component_values row at all
 * (nobody ticked anything), so entries have to be synthesized. Stored rows are
 * cloned rather than replaced, preserving the per-row account override an
 * unlocked block carries.
 *
 * A month whose eligible weights total zero — nobody eligible, or everyone out
 * of season — books nothing at all. The pot is simply not spread; it is not
 * redistributed elsewhere and no line is emitted.
 */
export function applyPoolSpread(
  specs: PoolSpreadSpec[],
  positions: Position[],
  componentValues: ComponentValue[]
): ComponentValue[] {
  if (specs.length === 0) return componentValues;

  const byKey = new Map<string, ComponentValue>();
  for (const value of componentValues) {
    byKey.set(`${value.positionId}|${value.componentDefId}`, value);
  }

  // Cloned entries replace their originals in place; synthesized ones append,
  // so the caller's ordering is otherwise untouched.
  const replacements = new Map<string, ComponentValue>();
  const additions: ComponentValue[] = [];

  for (const spec of specs) {
    const eligible: Array<{ position: Position; basis: number }> = [];
    for (const position of positions) {
      const stored = byKey.get(`${position.id}|${spec.costDefId}`);
      // The tick box persists into the (otherwise unused for this block type)
      // rate slot — see blockRows.ts. Anything above zero counts as ticked.
      const ticked = (stored?.rate ?? 0) > 0;
      if (!isPoolEligible(spec, position, ticked)) continue;
      eligible.push({
        position,
        basis:
          poolBasisValue(spec.spreadBase, position) *
          Math.max(0, position.headcount) *
          Math.max(0, position.hotelClusterWeight),
      });
    }
    if (eligible.length === 0) continue;

    const shares = eligible.map(() => zeroMonths());
    for (let m = 0; m < MONTHS; m++) {
      const pot = finite(spec.pot[m]);
      if (pot === 0) continue;
      let total = 0;
      const weights = eligible.map(({ position, basis }) => {
        const weight = basis * Math.max(0, finite(position.seasonality[m]));
        total += weight;
        return weight;
      });
      if (total <= 0) continue; // nothing eligible this month — book nothing
      for (let i = 0; i < eligible.length; i++) {
        shares[i][m] = (pot * weights[i]) / total;
      }
    }

    eligible.forEach(({ position }, index) => {
      const key = `${position.id}|${spec.costDefId}`;
      const stored = replacements.get(key) ?? byKey.get(key);
      if (stored) {
        replacements.set(key, { ...stored, monthlyValues: shares[index] });
      } else {
        additions.push({
          positionId: position.id,
          componentDefId: spec.costDefId as ComponentValue["componentDefId"],
          monthlyValues: shares[index],
          updatedAt: "",
          // compile keys values on a strict `deletedAt === null`, so an
          // undefined here would silently drop the whole line.
          deletedAt: null,
        });
      }
    });
  }

  const poolDefIds = new Set(specs.map((spec) => spec.costDefId));
  const out = componentValues.map((value) => {
    const replacement = replacements.get(
      `${value.positionId}|${value.componentDefId}`
    );
    if (replacement) return replacement;
    // A stored row for a pool def whose position is NOT eligible: keep the row
    // (it may carry an account override) but make sure it books nothing, so a
    // value left behind by an earlier configuration can't leak into the run.
    if (poolDefIds.has(value.componentDefId as string)) {
      return { ...value, monthlyValues: zeroMonths() };
    }
    return value;
  });
  return [...out, ...additions];
}
