/**
 * The VM: executes a compiled plan's instruction stream.
 * -----------------------------------------------------------
 * One interpreter loop over parallel typed arrays; monthly vectors are written
 * straight into the persistent line matrix. A single scratch Float64Array is
 * reused across positions, so the hot loop allocates nothing.
 *
 * This file reads ONLY typed arrays off the plan — no CostComponentDefinition,
 * no string, no Map. Everything that needed a definition (which lines the count
 * multiplier scales) is resolved at compile time into a typed array. Keep it
 * that way: it is what lets the whole state be handed to a Worker, and what
 * keeps V8 from deoptimizing this function on a polymorphic object access.
 *
 * IMPORTANT: every arithmetic expression here mirrors reference.ts term for
 * term and in the same association order — the parity tests assert
 * bit-identical output. If you change a formula, change reference.ts first
 * (it is the spec) and keep the two in lockstep.
 */

import { CompiledPlan } from "./compile";
import {
  FLAG_INCREASE_AWARE,
  Op,
  SCRATCH_ACC,
  SCRATCH_ACC2,
  SCRATCH_DAYRATE,
  SCRATCH_GROSS,
  SCRATCH_INC,
  SCRATCH_INCMONTH,
  SCRATCH_MANUAL,
  SCRATCH_SIZE,
  SCRATCH_TWD,
  SCRATCH_TWD2,
  SCRATCH_TWM,
  SCRATCH_VAC,
  SCRATCH_VACDAYS,
} from "./opcodes";
import { MONTHS } from "./types";

export function createScratch(): Float64Array {
  return new Float64Array(SCRATCH_SIZE);
}

/** Total contribution for a cumulative base of `x` under the bracket table
 *  stored at paramPool[ofs..] as `count` (upTo, rate) pairs. */
function ssTax(pool: Float64Array, ofs: number, count: number, x: number): number {
  let total = 0;
  let prev = 0;
  for (let b = 0; b < count; b++) {
    const upTo = pool[ofs + 2 * b];
    const rate = pool[ofs + 2 * b + 1];
    const hi = Math.min(x, upTo);
    if (hi > prev) total += (hi - prev) * rate;
    if (upTo >= x) break;
    prev = upTo;
  }
  return total;
}

/** Runs position p's instruction range, writing its lines into `values`. */
// Hoisted opcode constants: `case Op.X:` would re-load the property for every
// comparison on every instruction; plain consts compile to register compares.
const OP_DERIVE = Op.DERIVE;
const OP_BASE_SALARY = Op.BASE_SALARY;
const OP_BASE_SALARY_HOURLY = Op.BASE_SALARY_HOURLY;
const OP_VACATION = Op.VACATION;
const OP_BASE_DEDUCT = Op.BASE_DEDUCT;
const OP_ACCRUAL = Op.ACCRUAL;
const OP_BANK_HOLIDAY = Op.BANK_HOLIDAY;
const OP_ACC_CLEAR = Op.ACC_CLEAR;
const OP_ACC_ADD_GROSS = Op.ACC_ADD_GROSS;
const OP_ACC_ADD_LINE = Op.ACC_ADD_LINE;
const OP_ACC_ADD_DAYS = Op.ACC_ADD_DAYS;
const OP_ACC_ADD_SERVICE = Op.ACC_ADD_SERVICE;
const OP_ACC_ADD_VAC = Op.ACC_ADD_VAC;
const OP_PCT_OF_ACC = Op.PCT_OF_ACC;
const OP_PCT_OF_ACC_M = Op.PCT_OF_ACC_M;
const OP_WEIGHT_BY_ACC = Op.WEIGHT_BY_ACC;
const OP_FLAT_ACTIVE = Op.FLAT_ACTIVE;
const OP_FLAT_DAY = Op.FLAT_DAY;
const OP_DIRECT = Op.DIRECT;
const OP_DIRECT_ABS = Op.DIRECT_ABS;
const OP_SOCIAL_SEC = Op.SOCIAL_SEC;
const OP_STAT_HC = Op.STAT_HC;
const OP_STAT_FTE = Op.STAT_FTE;
const OP_STAT_HOURS = Op.STAT_HOURS;
const OP_STAT_HOURS_PAID = Op.STAT_HOURS_PAID;
const OP_ACC_PUSH = Op.ACC_PUSH;
const OP_COMBINE_ACC = Op.COMBINE_ACC;

export function executePosition(
  plan: CompiledPlan,
  values: Float64Array,
  scratch: Float64Array,
  p: number
): void {
  const { op, outLine, arg0, paramOfs, paramPool, seasonality, daysPerMonth, realDays, holidayDays } = plan;
  const posOfs = p * MONTHS;
  const end = plan.positionInstrStart[p + 1];

  for (let i = plan.positionInstrStart[p]; i < end; i++) {
    // NOTE: out is only valid for ops that write a line — scratch-only ops
    // carry the LINE_NONE sentinel, and multiplying that would push the index
    // out of V8's small-integer range and deoptimize every array access in
    // this function. Do not hoist this above the switch.
    const pp = paramOfs[i];

    switch (op[i]) {
      case OP_DERIVE: {
        const meritPct = paramPool[pp];
        const manualYearly = paramPool[pp + 1];
        const rawMonth = Math.trunc(paramPool[pp + 2]);
        const incMonth = rawMonth >= 1 && rawMonth <= MONTHS ? rawMonth - 1 : MONTHS;

        let twm = 0;
        let twd = 0;
        let twd2 = 0;
        let activeFromIncrease = 0;
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          if (s !== 0) {
            twm += s;
            twd += daysPerMonth[posOfs + m] * s;
            twd2 += realDays[m] * s;
            if (m >= incMonth) activeFromIncrease += s;
          }
          scratch[SCRATCH_INC + m] = m >= incMonth ? 1 + meritPct : 1;
        }
        scratch[SCRATCH_TWM] = twm;
        scratch[SCRATCH_TWD] = twd;
        scratch[SCRATCH_TWD2] = twd2;
        scratch[SCRATCH_MANUAL] =
          activeFromIncrease === 0 ? 0 : manualYearly / activeFromIncrease;
        scratch[SCRATCH_INCMONTH] = incMonth;
        break;
      }

      case OP_BASE_SALARY: {
        const out = outLine[i] * MONTHS;
        const base = paramPool[pp];
        const twm = scratch[SCRATCH_TWM];
        const twd = scratch[SCRATCH_TWD];
        const manualMonthly = scratch[SCRATCH_MANUAL];
        const incMonth = scratch[SCRATCH_INCMONTH];
        // Per-working-day base pay (pre-increase) — what one vacation/accrual day
        // is worth. twd = 0 only when the position never works, and then no
        // vacation is emitted anyway, so a guard keeps it finite.
        scratch[SCRATCH_DAYRATE] = twd > 0 ? (base * twm) / twd : 0;
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          let gross = 0;
          if (s !== 0) {
            const daySpread =
              (base * twm / twd) * daysPerMonth[posOfs + m] * s * scratch[SCRATCH_INC + m];
            const manual = m >= incMonth ? manualMonthly * s : 0;
            gross = daySpread + manual + paramPool[pp + 1 + m] * s;
          }
          scratch[SCRATCH_GROSS + m] = gross;
          values[out + m] = gross;
        }
        break;
      }

      case OP_BASE_SALARY_HOURLY: {
        const out = outLine[i] * MONTHS;
        const coeff = paramPool[pp];
        const manualMonthly = scratch[SCRATCH_MANUAL];
        const incMonth = scratch[SCRATCH_INCMONTH];
        // Hourly per-day pay is the coeff itself (rate·contract hours) — no
        // twm/twd normalization, matching how the hourly base spreads.
        scratch[SCRATCH_DAYRATE] = coeff;
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          let gross = 0;
          if (s !== 0) {
            const daySpread = coeff * realDays[m] * s * scratch[SCRATCH_INC + m];
            const manual = m >= incMonth ? manualMonthly * s : 0;
            gross = daySpread + manual + paramPool[pp + 1 + m] * s;
          }
          scratch[SCRATCH_GROSS + m] = gross;
          values[out + m] = gross;
        }
        break;
      }

      case OP_VACATION: {
        const vacationDays = paramPool[pp];
        const dayRate = scratch[SCRATCH_DAYRATE];
        // Weights are normalized by their own total (see reference.vacationDaysTaken),
        // so the year's leave sums to vacationDays whatever the raw weights total.
        // Days are kept alongside the priced series: ACCRUAL provisions for the
        // same days, and deriving both legs from one series is what makes the
        // accrual line net to zero.
        let weightTotal = 0;
        for (let m = 0; m < MONTHS; m++) weightTotal += paramPool[pp + 1 + m];
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          const takenDays =
            s === 0 || weightTotal === 0
              ? 0
              : vacationDays * paramPool[pp + 1 + m] / weightTotal * s;
          scratch[SCRATCH_VACDAYS + m] = takenDays;
          scratch[SCRATCH_VAC + m] = takenDays * dayRate * scratch[SCRATCH_INC + m];
        }
        break;
      }

      case OP_BASE_DEDUCT: {
        const out = outLine[i] * MONTHS;
        for (let m = 0; m < MONTHS; m++) values[out + m] -= scratch[SCRATCH_VAC + m];
        break;
      }

      case OP_ACCRUAL: {
        // Liability roll-forward in days — mirrors reference.holidayAccrual term
        // for term. accrualDays is an on/off guard only; the earning leg is
        // derived from the taken-days series so the year telescopes to zero.
        const out = outLine[i] * MONTHS;
        const accrualDays = paramPool[pp];
        const dayRate = scratch[SCRATCH_DAYRATE];
        const twm = scratch[SCRATCH_TWM];
        let totalTaken = 0;
        for (let m = 0; m < MONTHS; m++) totalTaken += scratch[SCRATCH_VACDAYS + m];
        let balance = 0;
        let prevRate = 0;
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          if (accrualDays === 0 || s === 0 || twm === 0) {
            values[out + m] = 0;
            continue;
          }
          const rate = dayRate * scratch[SCRATCH_INC + m];
          const opening = balance;
          balance += totalTaken * s / twm - scratch[SCRATCH_VACDAYS + m];
          values[out + m] = balance * rate - opening * prevRate;
          prevRate = rate;
        }
        break;
      }

      case OP_BANK_HOLIDAY: {
        const out = outLine[i] * MONTHS;
        const combinedMult = paramPool[pp];
        const dayRate = scratch[SCRATCH_DAYRATE];
        const increaseAware = (arg0[i] & FLAG_INCREASE_AWARE) !== 0;
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          values[out + m] =
            combinedMult === 0 || s === 0
              ? 0
              : combinedMult * dayRate * holidayDays[m] * s *
                (increaseAware ? scratch[SCRATCH_INC + m] : 1);
        }
        break;
      }

      case OP_ACC_CLEAR: {
        for (let m = 0; m < MONTHS; m++) scratch[SCRATCH_ACC + m] = 0;
        break;
      }

      case OP_ACC_ADD_GROSS: {
        for (let m = 0; m < MONTHS; m++) scratch[SCRATCH_ACC + m] += scratch[SCRATCH_GROSS + m];
        break;
      }

      case OP_ACC_ADD_LINE: {
        const src = arg0[i] * MONTHS;
        for (let m = 0; m < MONTHS; m++) scratch[SCRATCH_ACC + m] += values[src + m];
        break;
      }

      case OP_ACC_ADD_DAYS: {
        // arg0 = 1 → productive-days calendar; 2 → public-holiday count;
        // 0 → the position's pay basis.
        if (arg0[i] === 1) {
          for (let m = 0; m < MONTHS; m++) {
            scratch[SCRATCH_ACC + m] += realDays[m] * seasonality[posOfs + m];
          }
        } else if (arg0[i] === 2) {
          for (let m = 0; m < MONTHS; m++) {
            scratch[SCRATCH_ACC + m] += holidayDays[m] * seasonality[posOfs + m];
          }
        } else {
          for (let m = 0; m < MONTHS; m++) {
            scratch[SCRATCH_ACC + m] +=
              daysPerMonth[posOfs + m] * seasonality[posOfs + m];
          }
        }
        break;
      }

      case OP_ACC_ADD_SERVICE: {
        // Length of service in calendar days, already resolved to the right
        // series (month increment or running total) at compile time — see the
        // SERVICE branch in compile.emitSelector, which also applies the
        // inactive-month gate — nothing left to scale here.
        for (let m = 0; m < MONTHS; m++) {
          scratch[SCRATCH_ACC + m] += paramPool[pp + m];
        }
        break;
      }

      case OP_ACC_ADD_VAC: {
        for (let m = 0; m < MONTHS; m++) {
          scratch[SCRATCH_ACC + m] += scratch[SCRATCH_VAC + m];
        }
        break;
      }

      case OP_PCT_OF_ACC: {
        const out = outLine[i] * MONTHS;
        const rate = paramPool[pp];
        for (let m = 0; m < MONTHS; m++) values[out + m] = rate * scratch[SCRATCH_ACC + m];
        break;
      }

      case OP_PCT_OF_ACC_M: {
        const out = outLine[i] * MONTHS;
        for (let m = 0; m < MONTHS; m++) {
          values[out + m] = paramPool[pp + m] * scratch[SCRATCH_ACC + m];
        }
        break;
      }

      case OP_WEIGHT_BY_ACC: {
        const out = outLine[i] * MONTHS;
        const yearly = paramPool[pp];
        let baseTotal = 0;
        for (let m = 0; m < MONTHS; m++) baseTotal += scratch[SCRATCH_ACC + m];
        if (yearly !== 0 && baseTotal !== 0) {
          for (let m = 0; m < MONTHS; m++) {
            values[out + m] = (yearly / baseTotal) * scratch[SCRATCH_ACC + m];
          }
        } else {
          for (let m = 0; m < MONTHS; m++) values[out + m] = 0;
        }
        break;
      }

      case OP_FLAT_ACTIVE: {
        const out = outLine[i] * MONTHS;
        const yearly = paramPool[pp];
        const increaseAware = (arg0[i] & FLAG_INCREASE_AWARE) !== 0;
        const twm = scratch[SCRATCH_TWM];
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          values[out + m] =
            yearly !== 0 && s !== 0
              ? (yearly / twm) * s * (increaseAware ? scratch[SCRATCH_INC + m] : 1)
              : 0;
        }
        break;
      }

      case OP_FLAT_DAY: {
        const out = outLine[i] * MONTHS;
        const yearly = paramPool[pp];
        const increaseAware = (arg0[i] & FLAG_INCREASE_AWARE) !== 0;
        const twd = scratch[SCRATCH_TWD];
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          values[out + m] =
            yearly !== 0 && s !== 0
              ? (yearly / twd) * daysPerMonth[posOfs + m] * s *
                (increaseAware ? scratch[SCRATCH_INC + m] : 1)
              : 0;
        }
        break;
      }

      case OP_DIRECT: {
        const out = outLine[i] * MONTHS;
        const increaseAware = (arg0[i] & FLAG_INCREASE_AWARE) !== 0;
        for (let m = 0; m < MONTHS; m++) {
          values[out + m] =
            paramPool[pp + m] * seasonality[posOfs + m] *
            (increaseAware ? scratch[SCRATCH_INC + m] : 1);
        }
        break;
      }

      case OP_DIRECT_ABS: {
        // Absolute pass-through: the KPI series is already resolved to per-month
        // figures at load time, so no seasonality/increase scaling here. (The
        // count-multiplier pass below also skips DIRECT_ABS lines.)
        const out = outLine[i] * MONTHS;
        for (let m = 0; m < MONTHS; m++) {
          values[out + m] = paramPool[pp + m];
        }
        break;
      }

      case OP_SOCIAL_SEC: {
        const out = outLine[i] * MONTHS;
        const monthlyCap = paramPool[pp];
        const yearlyCap = paramPool[pp + 1];
        const bracketCount = paramPool[pp + 2];
        const perPeriod = paramPool[pp + 3] === 1;
        const resetIdx = paramPool[pp + 4] - 1; // 0-based tax-year start month
        const openingBase = paramPool[pp + 5];
        const bracketOfs = pp + 6;
        if (perPeriod) {
          // Each month stands alone: no carry-over, no yearly cap.
          for (let m = 0; m < MONTHS; m++) {
            const monthBase = Math.min(scratch[SCRATCH_ACC + m], monthlyCap);
            values[out + m] = ssTax(paramPool, bracketOfs, bracketCount, monthBase);
          }
        } else {
          // Cumulative: seed from the prior-year opening base, reset at the
          // tax-year boundary. A January start (resetIdx 0) resets at m=0, so the
          // opening base is discarded — identical to the pre-2c engine.
          let cumPrev = openingBase;
          let taxPrev = ssTax(paramPool, bracketOfs, bracketCount, openingBase);
          for (let m = 0; m < MONTHS; m++) {
            if (m === resetIdx) {
              cumPrev = 0;
              taxPrev = 0;
            }
            const monthBase = Math.min(scratch[SCRATCH_ACC + m], monthlyCap);
            const cum = Math.min(cumPrev + monthBase, yearlyCap);
            const taxCum = ssTax(paramPool, bracketOfs, bracketCount, cum);
            values[out + m] = taxCum - taxPrev;
            cumPrev = cum;
            taxPrev = taxCum;
          }
        }
        break;
      }

      case OP_STAT_HC: {
        const out = outLine[i] * MONTHS;
        const headcount = paramPool[pp];
        for (let m = 0; m < MONTHS; m++) {
          values[out + m] = seasonality[posOfs + m] > 0 ? headcount : 0;
        }
        break;
      }

      case OP_STAT_FTE: {
        const out = outLine[i] * MONTHS;
        const fte = paramPool[pp];
        for (let m = 0; m < MONTHS; m++) values[out + m] = fte * seasonality[posOfs + m];
        break;
      }

      case OP_STAT_HOURS: {
        const out = outLine[i] * MONTHS;
        const totalHours = paramPool[pp];
        const vacationHours = paramPool[pp + 1];
        const twd2 = scratch[SCRATCH_TWD2];
        // Weights normalized by their total (see reference.hoursWorked), so the
        // hours taken back out equal the vacation hours added in.
        let weightTotal = 0;
        for (let m = 0; m < MONTHS; m++) weightTotal += paramPool[pp + 2 + m];
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          if (totalHours === 0 || s === 0) {
            values[out + m] = 0;
          } else {
            const spread = (totalHours / twd2) * realDays[m] * s;
            const vacOut =
              weightTotal === 0 ? 0 : vacationHours * paramPool[pp + 2 + m] / weightTotal * s;
            values[out + m] = spread - vacOut;
          }
        }
        break;
      }

      case OP_ACC_PUSH: {
        for (let m = 0; m < MONTHS; m++) scratch[SCRATCH_ACC2 + m] = scratch[SCRATCH_ACC + m];
        break;
      }

      case OP_COMBINE_ACC: {
        // acc2 is the LEFT operand (saved by ACC_PUSH), acc the right.
        // Mirrors the COMBINE branch of reference.resolveBase term for term.
        const out = outLine[i] * MONTHS;
        const rate = paramPool[pp];
        const combineOp = paramPool[pp + 1];
        for (let m = 0; m < MONTHS; m++) {
          const l = scratch[SCRATCH_ACC2 + m];
          const r = scratch[SCRATCH_ACC + m];
          let v = 0;
          if (combineOp === 0) v = l + r;
          else if (combineOp === 1) v = l - r;
          else if (combineOp === 2) v = l * r;
          else v = r === 0 ? 0 : l / r;
          values[out + m] = rate * v;
        }
        break;
      }

      case OP_STAT_HOURS_PAID: {
        // STAT_HOURS without the vacation take-out — see reference.hoursPaid.
        const out = outLine[i] * MONTHS;
        const totalHours = paramPool[pp];
        const twd2 = scratch[SCRATCH_TWD2];
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          if (totalHours === 0 || s === 0) {
            values[out + m] = 0;
          } else {
            values[out + m] = (totalHours / twd2) * realDays[m] * s;
          }
        }
        break;
      }
    }
  }

  // Count × cluster-weight multiplier: this row stands for `posHeadcount[p]`
  // identical positions, of which this hotel carries `posWeight[p]` (its
  // hotel-cluster share). Every line was computed as a single unit first — so
  // per-person effects like the social-security caps land correctly on the
  // FULL salary — then the slice is booked count × weight over here. The
  // HEADCOUNT stat is exempt from BOTH (it already emits the count itself,
  // and a shared person still counts as one head wherever they sit); KPI
  // lines are absolute (whole-line amount), not per-head, so they stay exempt
  // too, as do ratios (countExempt).
  //
  // Which defs are exempt is resolved at compile time into `countScaled` — the
  // three predicates are definition-derived, and reading them off objects here
  // was the only place this function touched anything but a typed array.
  // Mirrors referencePosition, which keeps the predicates in full; keep the two
  // in lockstep.
  const coeff = plan.posHeadcount[p] * plan.posWeight[p];
  if (coeff !== 1) {
    const countScaled = plan.countScaled;
    const defCount = countScaled.length;
    for (let di = 0; di < defCount; di++) {
      if (countScaled[di] === 0) continue;
      const lineOfs = (p * defCount + di) * MONTHS;
      for (let m = 0; m < MONTHS; m++) values[lineOfs + m] *= coeff;
    }
  }
}

export function executeAll(plan: CompiledPlan, values: Float64Array, scratch: Float64Array): void {
  const positionCount = plan.positionIds.length;
  for (let p = 0; p < positionCount; p++) executePosition(plan, values, scratch, p);
}
