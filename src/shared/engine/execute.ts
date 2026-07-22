/**
 * The VM: executes a compiled plan's instruction stream.
 * -----------------------------------------------------------
 * One interpreter loop over parallel typed arrays; monthly vectors are written
 * straight into the persistent line matrix. A single scratch Float64Array is
 * reused across positions, so the hot loop allocates nothing.
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
  SCRATCH_GROSS,
  SCRATCH_INC,
  SCRATCH_INCMONTH,
  SCRATCH_MANUAL,
  SCRATCH_SIZE,
  SCRATCH_TWD,
  SCRATCH_TWD2,
  SCRATCH_TWM,
  SCRATCH_VAC,
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
const OP_VACATION = Op.VACATION;
const OP_BASE_DEDUCT = Op.BASE_DEDUCT;
const OP_ACCRUAL = Op.ACCRUAL;
const OP_ACC_CLEAR = Op.ACC_CLEAR;
const OP_ACC_ADD_GROSS = Op.ACC_ADD_GROSS;
const OP_ACC_ADD_LINE = Op.ACC_ADD_LINE;
const OP_PCT_OF_ACC = Op.PCT_OF_ACC;
const OP_WEIGHT_BY_ACC = Op.WEIGHT_BY_ACC;
const OP_FLAT_ACTIVE = Op.FLAT_ACTIVE;
const OP_FLAT_DAY = Op.FLAT_DAY;
const OP_DIRECT = Op.DIRECT;
const OP_SOCIAL_SEC = Op.SOCIAL_SEC;
const OP_STAT_HC = Op.STAT_HC;
const OP_STAT_FTE = Op.STAT_FTE;
const OP_STAT_HOURS = Op.STAT_HOURS;

export function executePosition(
  plan: CompiledPlan,
  values: Float64Array,
  scratch: Float64Array,
  p: number
): void {
  const { op, outLine, arg0, paramOfs, paramPool, seasonality, daysPerMonth, realDays } = plan;
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

      case OP_VACATION: {
        const vacationDays = paramPool[pp];
        const dailyCost = paramPool[pp + 1];
        const twm = scratch[SCRATCH_TWM];
        const adjustedDailyPay = twm > 0 ? (dailyCost / twm) * 12 : dailyCost;
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          scratch[SCRATCH_VAC + m] =
            s === 0
              ? 0
              : vacationDays * paramPool[pp + 2 + m] * s * adjustedDailyPay *
                scratch[SCRATCH_INC + m];
        }
        break;
      }

      case OP_BASE_DEDUCT: {
        const out = outLine[i] * MONTHS;
        for (let m = 0; m < MONTHS; m++) values[out + m] -= scratch[SCRATCH_VAC + m];
        break;
      }

      case OP_ACCRUAL: {
        const out = outLine[i] * MONTHS;
        const accrualDays = paramPool[pp];
        const costPerDay = paramPool[pp + 1];
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          values[out + m] =
            accrualDays === 0 || s === 0
              ? 0
              : accrualDays * costPerDay * s * scratch[SCRATCH_INC + m] -
                scratch[SCRATCH_VAC + m];
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

      case OP_PCT_OF_ACC: {
        const out = outLine[i] * MONTHS;
        const rate = paramPool[pp];
        for (let m = 0; m < MONTHS; m++) values[out + m] = rate * scratch[SCRATCH_ACC + m];
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

      case OP_SOCIAL_SEC: {
        const out = outLine[i] * MONTHS;
        const monthlyCap = paramPool[pp];
        const yearlyCap = paramPool[pp + 1];
        const bracketCount = paramPool[pp + 2];
        const bracketOfs = pp + 3;
        let cumPrev = 0;
        let taxPrev = 0;
        for (let m = 0; m < MONTHS; m++) {
          const monthBase = Math.min(scratch[SCRATCH_ACC + m], monthlyCap);
          const cum = Math.min(cumPrev + monthBase, yearlyCap);
          const taxCum = ssTax(paramPool, bracketOfs, bracketCount, cum);
          values[out + m] = taxCum - taxPrev;
          cumPrev = cum;
          taxPrev = taxCum;
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
        for (let m = 0; m < MONTHS; m++) {
          const s = seasonality[posOfs + m];
          if (totalHours === 0 || s === 0) {
            values[out + m] = 0;
          } else {
            const spread = (totalHours / twd2) * realDays[m] * s;
            const vacOut = vacationHours * paramPool[pp + 2 + m] * s;
            values[out + m] = spread - vacOut;
          }
        }
        break;
      }
    }
  }
}

export function executeAll(plan: CompiledPlan, values: Float64Array, scratch: Float64Array): void {
  const positionCount = plan.positionIds.length;
  for (let p = 0; p < positionCount; p++) executePosition(plan, values, scratch, p);
}
