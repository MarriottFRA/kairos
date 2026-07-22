/**
 * Instruction set of the simulation VM.
 * -----------------------------------------------------------
 * The compiler turns component definitions + position values into a flat
 * program over parallel typed arrays; execute.ts runs it in one interpreter
 * loop. One instruction = one entry in each of:
 *
 *   op[i]       : Uint8Array   — opcode (this enum)
 *   outLine[i]  : Uint32Array  — absolute line index the result is written to
 *                                (LINE_NONE when the op writes scratch only)
 *   arg0[i]     : Uint32Array  — op-specific operand (see table below)
 *   paramOfs[i] : Uint32Array  — offset of the op's scalars in paramPool
 *
 * Instructions are grouped per position: plan.positionInstrStart[p] ..
 * plan.positionInstrStart[p+1] is position p's program. Per-position inputs
 * (seasonality, day basis) live in packed P×12 arrays, not in paramPool.
 *
 * Scratch is a single Float64Array reused across positions (zero allocation
 * in the hot loop) — layout below. The "accumulator" is the 12-slot vector
 * that PERCENT_OF / WEIGHTED_BY_BASE / SOCIAL_SECURITY bases are summed into
 * via ACC_* ops before the consuming op runs.
 *
 * Opcode reference (m = month 0..11, seas/days = position vectors,
 * inc[m] = merit-increase factor, twm/twd/twd2 = derived totals):
 *
 *  DERIVE        params: meritPct, manualYearly, increaseMonth(1-based; >12 = none)
 *                Computes twm = Σ seas, twd = Σ days·seas, twd2 = Σ realDays·seas,
 *                inc[m] = m ≥ M ? 1+meritPct : 1, and manualMonthly =
 *                manualYearly / Σ seas[m≥M]. Must be the first op of a position.
 *  BASE_SALARY   params: monthlyBase, addl[12]
 *                gross[m] = base·twm/twd·days[m]·seas[m]·inc[m]
 *                           + manualMonthly·seas[m]·[m≥M] + addl[m]·seas[m]
 *                Writes gross[] to scratch AND the (still-gross) line.
 *  VACATION      params: vacationDays, dailyVacationCost, weights[12]
 *                vac[m] = vacDays·weight[m]·seas[m]·(dailyCost·12/twm)·inc[m]
 *                Scratch only — no line.
 *  BASE_DEDUCT   line[m] -= vac[m]  (nets vacation out of the base line;
 *                gross scratch stays intact for downstream bases)
 *  ACCRUAL       params: accrualDaysPerMonth, accrualCostPerDay
 *                line[m] = days·cost·seas[m]·inc[m] − vac[m]   (0 if days = 0)
 *  ACC_CLEAR     acc[m] = 0
 *  ACC_ADD_GROSS acc[m] += gross[m]   (the base-salary series, pre-deduction)
 *  ACC_ADD_LINE  arg0 = source line index; acc[m] += values[line][m]
 *  PCT_OF_ACC    params: rate; line[m] = rate·acc[m]
 *  WEIGHT_BY_ACC params: yearly; line[m] = yearly·acc[m]/Σacc  (0 if Σacc = 0)
 *  FLAT_ACTIVE   params: yearly; line[m] = yearly/twm·seas[m]  (0 months with seas 0)
 *                arg0 bit0: multiply by inc[m] (increase-aware component)
 *  FLAT_DAY      params: yearly; line[m] = yearly/twd·days[m]·seas[m]
 *                arg0 bit0: multiply by inc[m]
 *  DIRECT        params: v[12]; line[m] = v[m]·seas[m]
 *                arg0 bit0: multiply by inc[m]
 *  SOCIAL_SEC    params: monthlyCap, yearlyCap (Infinity = uncapped),
 *                bracketCount, then SS_MAX_BRACKETS × (upTo, rate) pairs
 *                (upTo = Infinity for the unbounded bracket and for padding).
 *                Cumulative-tax-difference over the accumulator:
 *                  base = min(acc[m], monthlyCap); cum = min(cumPrev+base, yearlyCap)
 *                  line[m] = tax(cum) − tax(cumPrev); cumPrev = cum
 *  STAT_HC       params: headcount; line[m] = seas[m] > 0 ? headcount : 0
 *  STAT_FTE      params: fte; line[m] = fte·seas[m]
 *  STAT_HOURS    params: totalHours (yearly worked + vacation hours),
 *                vacationHours, weights[12]
 *                line[m] = totalHours/twd2·realDays[m]·seas[m]
 *                          − vacationHours·weight[m]·seas[m]   (0 if seas 0)
 */

export const Op = {
  DERIVE: 0,
  BASE_SALARY: 1,
  VACATION: 2,
  BASE_DEDUCT: 3,
  ACCRUAL: 4,
  ACC_CLEAR: 5,
  ACC_ADD_GROSS: 6,
  ACC_ADD_LINE: 7,
  PCT_OF_ACC: 8,
  WEIGHT_BY_ACC: 9,
  FLAT_ACTIVE: 10,
  FLAT_DAY: 11,
  DIRECT: 12,
  SOCIAL_SEC: 13,
  STAT_HC: 14,
  STAT_FTE: 15,
  STAT_HOURS: 16,
} as const;

export type OpCode = (typeof Op)[keyof typeof Op];

export const OP_NAMES: Record<OpCode, string> = Object.fromEntries(
  Object.entries(Op).map(([name, code]) => [code, name])
) as Record<OpCode, string>;

/** outLine sentinel for scratch-only instructions. */
export const LINE_NONE = 0xffffffff;

/** arg0 flag bit: multiply the spread by the increase factor. */
export const FLAG_INCREASE_AWARE = 1;

// ---------------------------------------------------------------------------
// Scratch layout (one Float64Array shared across positions)
// ---------------------------------------------------------------------------

export const SCRATCH_INC = 0; //   inc[12] — merit increase factor per month
export const SCRATCH_GROSS = 12; //  gross base salary[12]
export const SCRATCH_VAC = 24; //    vacation cost[12]
export const SCRATCH_ACC = 36; //    base accumulator[12]
export const SCRATCH_TWM = 48; //    total working months
export const SCRATCH_TWD = 49; //    total working days (position's day basis)
export const SCRATCH_TWD2 = 50; //   total working days (real-days basis)
export const SCRATCH_MANUAL = 51; // manualMonthly (manual increase per active month)
export const SCRATCH_INCMONTH = 52; // increaseMonth, 0-based (12 = none)
export const SCRATCH_SIZE = 53;
