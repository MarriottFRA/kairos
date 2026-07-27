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
import {
  baseSalaryDefId,
  holidayAccrualDefId,
  systemStatDefId,
  vacationCostDefId,
} from "../blocks/ipc";
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
import { FullTimeReference } from "../positionDefaults";
import { ACCOUNT_FIELD_KEYS } from "./fields";
import { POSITION_COUNT_ACCOUNT } from "./systemAccounts";

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
// FTE — derived from the contract, measured against the hotel's full-timer
// ---------------------------------------------------------------------------

/** The three Contract day-count columns FTE reads. POSITION_EXTRA fields, so
 *  they arrive in a stored position's `extraValues` or on a live grid row —
 *  the same two shapes readPositionAccounts serves. */
export const FTE_CONTRACT_KEYS = {
  yearlyDays: "contractYearlyDays",
  daysOff: "contractDaysOff",
  pubHolidays: "contractPubHolidays",
} as const;

export interface ContractDays {
  yearlyDays: number;
  daysOff: number;
  pubHolidays: number;
}

function dayValue(source: Record<string, unknown>, key: string): number {
  const num = Number(source[key]);
  return Number.isFinite(num) ? num : 0;
}

/** Read a position's contract day counts out of a flat key/value bag. One
 *  reader for both engine-input assemblies, exactly like readPositionAccounts. */
export function readContractDays(source: Record<string, unknown>): ContractDays {
  return {
    yearlyDays: dayValue(source, FTE_CONTRACT_KEYS.yearlyDays),
    daysOff: dayValue(source, FTE_CONTRACT_KEYS.daysOff),
    pubHolidays: dayValue(source, FTE_CONTRACT_KEYS.pubHolidays),
  };
}

/**
 * A position's FTE — how much of one full-time contract it is worth. Derived,
 * never entered (VBA Associate Details column P):
 *
 *   hours worked   (Yearly Days − Vacation − Days Off − Public Holidays)
 *                  × Daily Hours ÷ 12 × Working Months
 *   ─────────────  ────────────────────────────────────────────────────────
 *   full-timer's   (FT productive days − Vacation) × (FT weekly hours ÷ 5)
 *
 * Two things about this are deliberate and easy to "fix" wrongly:
 *
 * - Vacation is subtracted on BOTH sides, so a generous entitlement does not
 *   depress a post's FTE — a full-timer with 30 days off is still one FTE. It
 *   is the row's own vacation on both sides, which is what makes the ratio
 *   collapse to 1.00 for anyone on the hotel's standard contract.
 * - The ÷12 × Working Months prorate is what makes a six-month seasonal post
 *   read 0.50. The engine then spreads that figure across the active months by
 *   the same seasonality vector (STAT_FTE), so the yearly total is the FTE and
 *   the monthly line is the FTE while working.
 *
 * A row with NO Yearly Days at all falls back to the full-time productive year
 * rather than reading 0. Those three columns arrived with the hotel-year safe
 * defaults, so rows written before them are simply blank — and "this post has
 * no contract" is not what a blank means there; treating it as one would zero
 * the FTE of every pre-existing position, and with it every FTE-based pool
 * share and staffing stat. A row that states its own Yearly Days is always
 * taken at its word, blank Days Off and Public Holidays included.
 *
 * Returns 0 when the yardstick is unusable (no defaults loaded, zero-hour
 * full-time week) rather than dividing by zero — the grid shows a blank/0 cell
 * until the hotel-year defaults are there.
 */
export function deriveFte(
  position: Pick<Position, "vacationDays" | "dailyContractHours" | "seasonality">,
  contract: ContractDays,
  reference: FullTimeReference
): number {
  const stated = contract.yearlyDays > 0;
  const productiveDays = stated
    ? contract.yearlyDays - contract.daysOff - contract.pubHolidays
    : reference.productiveDays;

  const workedDays = productiveDays - position.vacationDays;
  if (workedDays <= 0 || position.dailyContractHours <= 0) return 0;

  let workingMonths = 0;
  for (let m = 0; m < MONTHS; m++) workingMonths += position.seasonality[m] ?? 0;

  const worked =
    ((workedDays * position.dailyContractHours) / MONTHS) * workingMonths;

  const fullTimeDays = reference.productiveDays - position.vacationDays;
  const fullTime = fullTimeDays * reference.dailyHours;
  return fullTime > 0 ? worked / fullTime : 0;
}

/** deriveFte straight off a flat bag of contract values — the form both engine
 *  paths and the grid actually hold. */
export function resolveFte(
  position: Pick<Position, "vacationDays" | "dailyContractHours" | "seasonality">,
  source: Record<string, unknown>,
  reference: FullTimeReference
): number {
  return deriveFte(position, readContractDays(source), reference);
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

// ---------------------------------------------------------------------------
// Per-position posting accounts → the system definitions
// ---------------------------------------------------------------------------

/**
 * The posting accounts a position carries on its own row, one per permanent
 * system head (see blocks/repo.ensureSystemDefs, which seeds those heads with a
 * BLANK account precisely so the row can supply it).
 *
 * Each is optional and may be blank. Blank does NOT suppress the calculation:
 * the line still computes and stays available as a base for other blocks; it is
 * only excluded from the output projection (see outputLines). That is the
 * workbook's "Blank" contract — compute everything, post what has an account.
 */
export interface PositionAccounts {
  /** Base salary, net of vacation taken. */
  salary?: string;
  /** The per-row headcount stat (distinct from the pinned position-count head,
   *  which always posts to POSITION_COUNT_ACCOUNT whatever this says). */
  headcount?: string;
  /** Hours worked stat. */
  hours?: string;
  /** Vacation accrual movement. */
  accrual?: string;
  /** Vacation cost actually taken — the amount BASE_DEDUCT nets out of salary. */
  benefits?: string;
}

function accountValue(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read a position's posting accounts out of a flat key/value bag — either a
 * stored position's `extraValues` or a live grid row, which carry the same keys.
 *
 * One reader for both engine-input assemblies: that is what stops the persisted
 * run and the grid's live sim from reading different fields (liveSimParity pins
 * them, but only behaviour they actually share can be pinned).
 */
export function readPositionAccounts(
  source: Record<string, unknown>
): PositionAccounts {
  return {
    salary: accountValue(source, ACCOUNT_FIELD_KEYS.salary),
    headcount: accountValue(source, ACCOUNT_FIELD_KEYS.headcount),
    hours: accountValue(source, ACCOUNT_FIELD_KEYS.hours),
    accrual: accountValue(source, ACCOUNT_FIELD_KEYS.accrual),
    benefits: accountValue(source, ACCOUNT_FIELD_KEYS.benefits),
  };
}

/**
 * Attach each position's own posting accounts to the system definitions.
 *
 * This is the step whose absence meant Results only ever showed the pinned
 * position-count account: the grid's five account columns were stored on the
 * position and read by nothing, so every system head compiled with the blank
 * account it was seeded with and was dropped from the output.
 *
 * Implemented as synthesized ComponentValue rows rather than new fields on
 * Position because the compiler already resolves a per-row account override that
 * way (`value?.accountCode ?? def.accountCode`), and for BASE_SALARY / STAT /
 * HOLIDAY_ACCRUAL definitions the ComponentValue is consulted for NOTHING ELSE.
 * So this changes only the dept×account key a line aggregates under, never a
 * value — with the single deliberate exception of the vacation-cost head, which
 * needs `rate: 1` because it is a PERCENT_OF spread over the vacation series.
 *
 * Returns a NEW array. Existing rows are preserved (shallow-cloned where an
 * account merges onto them) — never appended alongside, because compile keys
 * values by `positionId|componentDefId` and a duplicate would silently win or
 * lose depending on order.
 */
export function applyPositionAccounts(
  ou: string,
  componentValues: ComponentValue[],
  accountsByPosition: Map<string, PositionAccounts>
): ComponentValue[] {
  if (accountsByPosition.size === 0) return componentValues;

  // defId → the patch that def needs. `rate` is only for the vacation-cost head.
  const patchFor = (
    accounts: PositionAccounts
  ): Array<{ defId: string; accountCode: string; rate?: number }> => [
    { defId: baseSalaryDefId(ou), accountCode: accounts.salary ?? "" },
    {
      defId: systemStatDefId(ou, "HEADCOUNT"),
      // The pinned position-count head already books every head to
      // POSITION_COUNT_ACCOUNT. Letting the per-row headcount pick the SAME
      // account would intern both lines onto one dept|account key, and the
      // outputs read SUMS lines sharing a key — reporting double the heads.
      // Drop the override instead, so this line simply does not post.
      accountCode:
        (accounts.headcount ?? "").trim().toUpperCase() === POSITION_COUNT_ACCOUNT
          ? ""
          : accounts.headcount ?? "",
    },
    { defId: systemStatDefId(ou, "HOURS"), accountCode: accounts.hours ?? "" },
    { defId: holidayAccrualDefId(ou), accountCode: accounts.accrual ?? "" },
    // rate 1 = "100% of the vacation series", i.e. the leave actually taken.
    // Unconditional: the line must compute even with no account, so that a
    // block using it as a base sees the same number the persisted run does.
    { defId: vacationCostDefId(ou), accountCode: accounts.benefits ?? "", rate: 1 },
  ];

  const out: ComponentValue[] = [];
  const merged = new Set<string>();
  const byKey = new Map<string, ComponentValue>();
  for (const value of componentValues) {
    byKey.set(`${value.positionId as string}|${value.componentDefId as string}`, value);
  }

  for (const [positionId, accounts] of accountsByPosition) {
    for (const patch of patchFor(accounts)) {
      const key = `${positionId}|${patch.defId}`;
      const existing = byKey.get(key);
      if (existing) {
        merged.add(key);
        out.push({
          ...existing,
          accountCode: patch.accountCode,
          rate: patch.rate ?? existing.rate,
        });
        continue;
      }
      // A blank account with nothing else to carry needs no row at all: the
      // compiler falls back to the definition's own account, which for every
      // head here is equally blank. Skipping keeps ~4 objects per position out of
      // the plan in the common "no accounts picked yet" case.
      if (!patch.accountCode && patch.rate === undefined) continue;
      out.push({
        positionId: positionId as ComponentValue["positionId"],
        componentDefId: patch.defId as ComponentDefId,
        accountCode: patch.accountCode,
        rate: patch.rate,
        updatedAt: "",
        deletedAt: null,
      });
    }
  }

  for (const value of componentValues) {
    const key = `${value.positionId as string}|${value.componentDefId as string}`;
    if (!merged.has(key)) out.push(value);
  }
  return out;
}
