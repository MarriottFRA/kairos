/**
 * Shared engine-input resolution — the pieces of ScenarioInput assembly that
 * BOTH the main-process loader (loadScenarioInput) and the renderer live
 * simulation (liveSim) must apply identically. Everything here is pure: DB
 * reads stay with the callers, which feed plain data in.
 *
 * Keeping one implementation is the anti-divergence guarantee: the grid's
 * live block totals and the persisted budget run can never disagree, because
 * they resolve KPI series, dual-block values and the synthetic bank-holiday
 * definition through the same functions (and the VM itself is shared).
 */

import { CalendarYear } from "../calendar";
import { KPI_EXPLICIT_DEPT_KEY } from "../kpiDrivers/ipc";
import {
  CalendarContext,
  ComponentDefId,
  ComponentValue,
  CostComponentDefinition,
  MONTHS,
  Position,
  SocialSecurityScheme,
} from "../engine/types";

/**
 * The bank-holiday premium is configured on the calendar (per hotel-year).
 * When switched on with a GL account and non-zero knobs, the engine needs a
 * component to route the cost through — materialized here rather than
 * persisted. Returns null (no line, no cost) when off or under-configured.
 */
export function buildBankHolidayDefinition(
  ou: string,
  calendar: CalendarYear
): CostComponentDefinition | null {
  if (!calendar.bankHolidayEnabled) return null;
  const account = (calendar.bankHolidayAccount ?? "").trim();
  const staffFraction = calendar.bankHolidayStaffFraction ?? 0;
  const premiumMultiplier = calendar.bankHolidayPremiumMultiplier ?? 0;
  if (!account || staffFraction <= 0 || premiumMultiplier <= 0) return null;

  return {
    id: `bank-holiday:${ou}` as ComponentDefId,
    ou,
    kind: "BANK_HOLIDAY",
    label: "Bank Holiday Premium",
    accountCode: account,
    departmentMode: "POSITION",
    // Valued exactly like a vacation/accrual day, which are unconditionally
    // increase-aware — a holiday worked after a merit rise costs more.
    increaseAware: true,
    // Emit after the user's components; ordering does not affect the math (topo
    // sort still places it after BASE_SALARY, whose day rate it reads).
    sortOrder: Number.MAX_SAFE_INTEGER,
    bankHolidayStaffFraction: staffFraction,
    bankHolidayPremiumMultiplier: premiumMultiplier,
    updatedAt: calendar.updatedAt ?? "",
    deletedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Manhours Worked — auto-derived from the calendar, override-aware
// ---------------------------------------------------------------------------

/**
 * Calendar-derived yearly worked hours (net of vacation):
 *   (Σ realDays − vacationDays) × dailyContractHours, floored at 0.
 *
 * `realDays` is the calendar's net productive days per month (calendar days −
 * public holidays − weekends). The engine's HOURS stat adds the vacation hours
 * back and removes them again by the vacation weights (VBA Section 22), so a
 * net-of-vacation yearly total lands the hours in the right months.
 */
export function deriveYearlyHoursWorked(
  position: Pick<Position, "vacationDays" | "dailyContractHours">,
  calendar: Pick<CalendarContext, "realDays">
): number {
  let productiveDays = 0;
  for (let m = 0; m < MONTHS; m++) productiveDays += calendar.realDays[m];
  const workedDays = productiveDays - position.vacationDays;
  return workedDays > 0 ? workedDays * position.dailyContractHours : 0;
}

/**
 * The worked-hours figure to feed the engine. A positive stored value is a
 * manual override entered on the grid; unset (≤ 0) falls back to the
 * calendar-derived value so a freshly added row still spreads hours. Both
 * engine-input paths call this with the same calendar → identical results
 * (pinned by liveSimParity).
 */
export function resolveYearlyHoursWorked(
  storedYearlyHoursWorked: number,
  position: Pick<Position, "vacationDays" | "dailyContractHours">,
  calendar: Pick<CalendarContext, "realDays">
): number {
  return storedYearlyHoursWorked > 0
    ? storedYearlyHoursWorked
    : deriveYearlyHoursWorked(position, calendar);
}

// ---------------------------------------------------------------------------
// Social Security / NI — materialize the contributory base at engine load
// ---------------------------------------------------------------------------

/** The scheme facts applySocialSecurityBase needs (a slice of SocialSecurityScheme). */
export type SsBaseScheme = Pick<
  SocialSecurityScheme,
  "id" | "includeBaseSalary" | "includeVacation" | "baseComponentIds"
>;

/**
 * Fill each SOCIAL_SECURITY definition's contributory base from ITS OWN scheme's
 * base membership, rather than materializing it in the DB (which would force a
 * cross-block recompile whenever membership changed). Each scheme independently
 * chooses net Base Salary, Vacation, and any custom-block lines — so multiple SS
 * schemes (one grid column each) can have different bases. Defaults both flags on
 * when a scheme is missing or leaves them unset, so an unconfigured base reads as
 * gross base salary (today's behaviour). Called by BOTH engine-input paths before
 * compile — the same anti-divergence guarantee as injectKpiSeries. Mutates the SS
 * defs in place (callers pass loader-owned copies).
 */
export function applySocialSecurityBase(
  definitions: CostComponentDefinition[],
  schemes: SsBaseScheme[]
): void {
  const ssDefs = definitions.filter((def) => def.kind === "SOCIAL_SECURITY");
  if (ssDefs.length === 0) return;

  const schemeById = new Map(schemes.map((scheme) => [scheme.id as string, scheme]));
  const defIds = new Set(definitions.map((def) => def.id as string));

  for (const def of ssDefs) {
    const scheme = def.ssSchemeId ? schemeById.get(def.ssSchemeId as string) : undefined;
    const componentIds = (scheme?.baseComponentIds ?? []).filter((id) =>
      defIds.has(id as string)
    ) as ComponentDefId[];
    def.baseSelector = {
      kind: "SS_BASE",
      includeBaseSalary: scheme?.includeBaseSalary ?? true,
      includeVacation: scheme?.includeVacation ?? true,
      componentIds,
    };
  }
}

/** One resolved KPI series (the deptKey/values slice of KpiDriverSeries). */
export interface KpiSeriesSlice {
  /** '*' for an EXPLICIT driver's single series, else a department code. */
  deptKey: string;
  values: number[];
}

/**
 * Resolve KPI-driven definitions into absolute monthly values before compile.
 *
 * A def with `kpiDriverId` is rewritten to spreadMethod "DIRECT_ABS" and, for
 * each position that carries a multiplier (ComponentValue.rate), its
 * monthlyValues are set to the KPI's precalculated series × that multiplier.
 * The series is picked EXPLICIT-first ('*' key = one shared series) then by
 * the position's own department. Positions with no multiplier row get no
 * injection — a zero line, matching the "missing value = zero" contract.
 * Mutates `definitions` entries and `componentValues` entries in place (the
 * callers pass loader-owned copies).
 */
export function injectKpiSeries(
  definitions: CostComponentDefinition[],
  positions: Position[],
  componentValues: ComponentValue[],
  seriesByDriverId: (driverId: string) => KpiSeriesSlice[]
): void {
  const kpiDefs = definitions.filter((def) => def.kpiDriverId);
  if (kpiDefs.length === 0) return;

  const valueByKey = new Map<string, ComponentValue>();
  for (const cv of componentValues) {
    valueByKey.set(`${cv.positionId}|${cv.componentDefId}`, cv);
  }

  for (const def of kpiDefs) {
    // Force the absolute path regardless of how the def was persisted; the VM
    // reads only monthlyValues for DIRECT_ABS, ignoring seasonality/increase.
    def.spreadMethod = "DIRECT_ABS";
    def.increaseAware = false;

    const series = seriesByDriverId(def.kpiDriverId as string);
    const byDept = new Map<string, number[]>();
    for (const s of series) byDept.set(s.deptKey, s.values);
    const explicit = byDept.get(KPI_EXPLICIT_DEPT_KEY);

    for (const position of positions) {
      const value = valueByKey.get(`${position.id}|${def.id}`);
      if (!value) continue; // no multiplier -> zero line, nothing to inject
      const multiplier = value.rate ?? 0;
      const resolved = explicit ?? byDept.get(position.departmentCode);
      const monthly = new Array<number>(MONTHS).fill(0);
      if (resolved) {
        for (let m = 0; m < MONTHS; m++) monthly[m] = resolved[m] * multiplier;
      }
      value.monthlyValues = monthly;
    }
  }
}

const STAT_SUFFIX = ":stat";
const COST_SUFFIX = ":cost";

/** A block's account-lock configuration — whether stored per-row account
 *  overrides apply (unlocked) or the block's default always wins (locked). */
export interface BlockAccountPolicy {
  costDefId: string;
  accountLocked: boolean;
  statsAccountLocked: boolean;
}

/**
 * Resolve block values before compile:
 *
 *   1. Account-lock policy: a stored per-row account override only survives
 *      while its block is "unlocked" — re-locking a block makes every line
 *      post to the configured default again (the stored override is kept in
 *      the DB so unlocking restores it, but it must not compile).
 *   2. Dual-output ("Count × Rate") blocks: ONE stored row per position,
 *      under the cost definition, holding qty + unitRate. Both compiled
 *      definitions read the yearlyValue slot, so this synthesizes
 *      cost = qty × unitRate and a fresh stat value with yearlyValue = qty
 *      (carrying the per-row stats account when unlocked).
 *
 * Dual pairs are recognized by the deterministic `<blockId>:cost` /
 * `<blockId>:stat` id convention the blocks repo mints. Returns a NEW array;
 * entries are shallow-cloned where they change. With no `policies`, stored
 * overrides pass through untouched.
 */
export function resolveBlockValues(
  definitions: CostComponentDefinition[],
  componentValues: ComponentValue[],
  policies?: BlockAccountPolicy[]
): ComponentValue[] {
  const policyByDef = new Map(
    (policies ?? []).map((policy) => [policy.costDefId, policy])
  );
  const defIds = new Set(definitions.map((def) => def.id as string));
  const dualCostIds = new Set<string>();
  for (const id of defIds) {
    if (id.endsWith(STAT_SUFFIX)) {
      const costId = id.slice(0, -STAT_SUFFIX.length) + COST_SUFFIX;
      if (defIds.has(costId)) dualCostIds.add(costId);
    }
  }

  const out: ComponentValue[] = [];
  for (const value of componentValues) {
    const defId = value.componentDefId as string;
    const policy = policyByDef.get(defId);
    const account =
      policy?.accountLocked ? undefined : value.accountCode ?? undefined;
    const statsAccount =
      policy?.statsAccountLocked ? undefined : value.statsAccountCode ?? undefined;

    if (!dualCostIds.has(defId)) {
      if (account === value.accountCode) out.push(value);
      else out.push({ ...value, accountCode: account });
      continue;
    }
    const qty = value.qty ?? 0;
    const statDefId = defId.slice(0, -COST_SUFFIX.length) + STAT_SUFFIX;
    out.push({
      ...value,
      yearlyValue: qty * (value.unitRate ?? 0),
      accountCode: account,
    });
    out.push({
      positionId: value.positionId,
      componentDefId: statDefId as ComponentDefId,
      yearlyValue: qty,
      accountCode: statsAccount,
      updatedAt: value.updatedAt,
      deletedAt: null,
    });
  }
  return out;
}
