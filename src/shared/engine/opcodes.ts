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
 *                Also sets dayRate = base·twm/twd (per-working-day base pay,
 *                pre-increase) for VACATION/ACCRUAL to value a day off.
 *                Writes gross[] to scratch AND the (still-gross) line.
 *  BASE_SALARY_HOURLY  params: coeff (= hourlyRate·dailyContractHours), addl[12]
 *                Alternate base derivation for hourly-paid staff. Spreads over
 *                realDays (net productive days), not the pay-type day basis, and
 *                skips the twm/twd normalization (coeff is an actual per-day pay):
 *                gross[m] = coeff·realDays[m]·seas[m]·inc[m]
 *                           + manualMonthly·seas[m]·[m≥M] + addl[m]·seas[m]
 *                Sets dayRate = coeff (the hourly per-day pay). Emitted instead
 *                of BASE_SALARY when a position has hourlyRate>0. Writes gross[]
 *                identically, so VACATION/BASE_DEDUCT are unchanged.
 *  VACATION      params: vacationDays, weights[12]
 *                vacDays[m] = vacDays·weight[m]/Σweight·seas[m]   (days taken)
 *                vac[m]     = vacDays[m]·dayRate·inc[m]           (priced)
 *                dayRate is the per-working-day base pay set by the base op, so a
 *                vacation day costs exactly what a worked day costs on the base
 *                line — and inc[m] makes it pricier when weighted post-increase.
 *                Writes BOTH scratch vectors — no line. ACCRUAL provisions for
 *                the same days this prices, so both read one series.
 *  BASE_DEDUCT   line[m] -= vac[m]  (nets vacation out of the base line;
 *                gross scratch stays intact for downstream bases)
 *  ACCRUAL       params: accrualDaysPerMonth (on/off guard only — the earning
 *                leg is derived, see below)
 *                Liability roll-forward carried in DAYS. Earns Σ vacDays[] evenly
 *                across worked months (seas[m]/twm) and releases vacDays[m]:
 *                  bal[m]  = bal[m−1] + ΣvacDays·seas[m]/twm − vacDays[m]
 *                  line[m] = bal[m]·r[m] − bal[m−1]·r[m−1],  r[m] = dayRate·inc[m]
 *                which expands to earn·r[m] + bal[m−1]·(r[m]−r[m−1]) − taken·r[m]
 *                — the middle term remeasures the standing balance when merit
 *                steps. Closing balance is 0 by construction, so the year
 *                TELESCOPES to exactly 0 for any weights/seasonality/merit.
 *                Inactive months emit 0 WITHOUT advancing r[m−1], so an
 *                off-season merit step revalues at the next worked month.
 *  BANK_HOLIDAY  params: combinedMult (= staffFraction·premiumMultiplier, or 0
 *                for staff whose base already pays the holiday — non-hourly)
 *                line[m] = combinedMult·dayRate·holidayDays[m]·seas[m]·inc[m]
 *                (0 if combinedMult = 0 or seas = 0). arg0 bit0: increase-aware.
 *                Values a worked public holiday at the same per-working-day base
 *                pay as a vacation/accrual day; holidayDays is the plan-level
 *                per-month bank-holiday count. Scratch-free — reads dayRate/inc.
 *  ACC_CLEAR     acc[m] = 0
 *  ACC_ADD_GROSS acc[m] += gross[m]   (the base-salary series, pre-deduction)
 *  ACC_ADD_LINE  arg0 = source line index; acc[m] += values[line][m]
 *  ACC_ADD_DAYS  arg0 = 0: acc[m] += daysPerMonth[p][m]·seas[m] (the position's
 *                pay-type day basis); arg0 = 1: acc[m] += realDays[m]·seas[m]
 *                (productive-days calendar); arg0 = 2: acc[m] +=
 *                holidayDays[m]·seas[m] (public-holiday count). The CALENDAR
 *                base selector — "multiplier of days in month" blocks.
 *  ACC_ADD_SERVICE  params: series[12]; acc[m] += series[m]
 *                The SERVICE base selector — length of service in pure calendar
 *                days since the hiring date. arg0 = 0: the month's own days;
 *                arg0 = 1: the running total to date (prior years included).
 *                Both forms are per-position constants resolved by the loaders
 *                (shared/positions/serviceDays.ts) and folded into params at
 *                compile time, so the VM just adds them. Whole calendar days,
 *                never × seasonality — but an inactive month is gated to zero
 *                upstream, so a position out of the plan still costs nothing.
 *                arg0 is carried for the disassembler's benefit only.
 *  ACC_ADD_VAC   acc[m] += vac[m] (the vacation-cost scratch set by VACATION).
 *                The VACATION base selector; topo-depends on BASE_SALARY.
 *  PCT_OF_ACC    params: rate; line[m] = rate·acc[m]
 *  PCT_OF_ACC_M  params: rate[12]; line[m] = rate[m]·acc[m]
 *                PCT_OF_ACC with a month-varying rate — emitted instead of the
 *                scalar form when a ComponentValue carries monthlyRates (rate
 *                rules with a days-in-position term that flips mid-year). The
 *                rates are resolved by the loaders and folded into params at
 *                compile time, so the VM just multiplies (the ACC_ADD_SERVICE
 *                pattern). Never paired with a COMBINE base.
 *  WEIGHT_BY_ACC params: yearly; line[m] = yearly·acc[m]/Σacc  (0 if Σacc = 0)
 *  FLAT_ACTIVE   params: yearly; line[m] = yearly/twm·seas[m]  (0 months with seas 0)
 *                arg0 bit0: multiply by inc[m] (increase-aware component)
 *  FLAT_DAY      params: yearly; line[m] = yearly/twd·days[m]·seas[m]
 *                arg0 bit0: multiply by inc[m]
 *  DIRECT        params: v[12]; line[m] = v[m]·seas[m]
 *                arg0 bit0: multiply by inc[m]
 *  DIRECT_ABS    params: v[12]; line[m] = v[m]
 *                Absolute pass-through — NO seasonality, NO increase, NOT
 *                headcount-scaled. Used for KPI-driven blocks, whose values are
 *                already resolved to absolute monthly figures at load time.
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
 *  STAT_HOURS_PAID  params: totalHours (yearly worked + vacation hours)
 *                line[m] = totalHours/twd2·realDays[m]·seas[m]  (0 if seas 0)
 *                STAT_HOURS without the vacation take-out — hours PAID rather
 *                than hours at work, so it needs no weights.
 *  ACC_PUSH      acc2[m] = acc[m]   (saves the accumulator as a COMBINE's LEFT
 *                operand; the next ACC_CLEAR then builds the right operand in
 *                acc, so every existing ACC_ADD_* op is reused unchanged)
 *  COMBINE_ACC   params: rate, opIndex (index into COMBINE_OPS: 0 ADD, 1 SUB,
 *                2 MUL, 3 DIV)
 *                line[m] = rate · f(acc2[m], acc[m]), left operand FIRST.
 *                DIV yields 0 where acc[m] = 0 (see BaseSelector.COMBINE).
 *  COLLAPSE_LINE params: w[12]
 *                total = Σ line[m]; line[m] = w[m]·total — a line POST-op,
 *                emitted immediately after its def's normal emission when the
 *                def carries collapseMonths ("13th month lands in June").
 *                The weights are resolved at compile time per position by
 *                collapseWeights (even split over the chosen ACTIVE months;
 *                all-zero when none is active, dropping the cost), so the VM
 *                just sums and multiplies. Reads/writes only its own line —
 *                no scratch. Runs before the count × cluster-weight tail,
 *                with which it commutes.
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
  BASE_SALARY_HOURLY: 17,
  BANK_HOLIDAY: 18,
  DIRECT_ABS: 19,
  ACC_ADD_DAYS: 20,
  ACC_ADD_VAC: 21,
  STAT_HOURS_PAID: 22,
  ACC_PUSH: 23,
  COMBINE_ACC: 24,
  ACC_ADD_SERVICE: 25,
  PCT_OF_ACC_M: 26,
  COLLAPSE_LINE: 27,
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
export const SCRATCH_DAYRATE = 53; // per-working-day base pay, pre-increase (set by a base op)
export const SCRATCH_VACDAYS = 54; // days of leave taken[12] — the unpriced VACATION series
export const SCRATCH_ACC2 = 66; //   saved accumulator[12] — a COMBINE's LEFT operand
export const SCRATCH_SIZE = 78;
