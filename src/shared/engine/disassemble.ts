/**
 * Disassembler — renders one position's compiled instruction range as
 * readable text. This is the debugging companion to the VM: when a number
 * looks wrong, disassemble the position and read the actual params the
 * interpreter saw instead of decoding paramPool offsets by hand.
 *
 *   console.log(disassemble(plan, positionId));
 */

import { CompiledPlan } from "./compile";
import { LINE_NONE, Op, OP_NAMES, OpCode } from "./opcodes";
import { MONTHS, PositionId, SS_MAX_BRACKETS } from "./types";

function fmt(value: number): string {
  if (value === Infinity) return "∞";
  return Number.isInteger(value) ? String(value) : value.toPrecision(6);
}

function fmtVector(pool: Float64Array, ofs: number, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(fmt(pool[ofs + i]));
  return `[${parts.join(", ")}]`;
}

export function disassemble(plan: CompiledPlan, positionId: PositionId): string {
  const p = plan.positionIndex.get(positionId);
  if (p === undefined) return `position ${positionId} not found in plan`;

  const defCount = plan.componentDefs.length;
  const lineBase = p * defCount;

  const describeLine = (line: number): string => {
    if (line === LINE_NONE) return "scratch";
    const def = plan.componentDefs[line - lineBase];
    const key = plan.aggKeys[plan.lineAggRow[line]];
    const label = def ? def.label : `line ${line}`;
    return `"${label}" → ${key.dept}|${key.account}`;
  };

  const rows: string[] = [
    `position ${positionId} (index ${p})`,
    `  seasonality ${fmtVector(plan.seasonality, p * MONTHS, MONTHS)}`,
    `  dayBasis    ${fmtVector(plan.daysPerMonth, p * MONTHS, MONTHS)}`,
  ];

  const end = plan.positionInstrStart[p + 1];
  for (let i = plan.positionInstrStart[p]; i < end; i++) {
    const code = plan.op[i] as OpCode;
    const pp = plan.paramOfs[i];
    const pool = plan.paramPool;
    let detail = "";

    switch (code) {
      case Op.DERIVE:
        detail = `meritPct=${fmt(pool[pp])} manualYearly=${fmt(pool[pp + 1])} increaseMonth=${fmt(pool[pp + 2])}`;
        break;
      case Op.BASE_SALARY:
        detail = `monthlyBase=${fmt(pool[pp])} addl=${fmtVector(pool, pp + 1, MONTHS)}`;
        break;
      case Op.BASE_SALARY_HOURLY:
        detail = `coeff=${fmt(pool[pp])} addl=${fmtVector(pool, pp + 1, MONTHS)}`;
        break;
      case Op.VACATION:
        detail = `vacationDays=${fmt(pool[pp])} weights=${fmtVector(pool, pp + 1, MONTHS)}`;
        break;
      case Op.ACCRUAL:
        detail = `daysPerMonth=${fmt(pool[pp])}`;
        break;
      case Op.BANK_HOLIDAY:
        detail = `combinedMult=${fmt(pool[pp])}${plan.arg0[i] & 1 ? " +increase" : ""}`;
        break;
      case Op.ACC_ADD_LINE:
        detail = `src=${describeLine(plan.arg0[i])}`;
        break;
      case Op.ACC_ADD_DAYS:
        detail = `series=${plan.arg0[i] === 1 ? "realDays" : "payBasisDays"}`;
        break;
      case Op.PCT_OF_ACC:
        detail = `rate=${fmt(pool[pp])}`;
        break;
      case Op.WEIGHT_BY_ACC:
      case Op.FLAT_ACTIVE:
      case Op.FLAT_DAY:
        detail = `yearly=${fmt(pool[pp])}${plan.arg0[i] & 1 ? " +increase" : ""}`;
        break;
      case Op.DIRECT:
        detail = `monthly=${fmtVector(pool, pp, MONTHS)}${plan.arg0[i] & 1 ? " +increase" : ""}`;
        break;
      case Op.DIRECT_ABS:
        detail = `abs=${fmtVector(pool, pp, MONTHS)}`;
        break;
      case Op.SOCIAL_SEC: {
        const count = pool[pp + 2];
        const mode = pool[pp + 3] === 1 ? "perPeriod" : "cumulative";
        const startMonth = pool[pp + 4];
        const openingBase = pool[pp + 5];
        const brackets: string[] = [];
        for (let b = 0; b < Math.min(count, SS_MAX_BRACKETS); b++) {
          brackets.push(`≤${fmt(pool[pp + 6 + 2 * b])}@${fmt(pool[pp + 7 + 2 * b])}`);
        }
        detail =
          `monthlyCap=${fmt(pool[pp])} yearlyCap=${fmt(pool[pp + 1])} ` +
          `${mode} startMonth=${fmt(startMonth)} opening=${fmt(openingBase)} ` +
          `brackets=[${brackets.join(", ")}]`;
        break;
      }
      case Op.STAT_HC:
        detail = `headcount=${fmt(pool[pp])}`;
        break;
      case Op.STAT_FTE:
        detail = `fte=${fmt(pool[pp])}`;
        break;
      case Op.STAT_HOURS:
        detail = `totalHours=${fmt(pool[pp])} vacationHours=${fmt(pool[pp + 1])} weights=${fmtVector(pool, pp + 2, MONTHS)}`;
        break;
    }

    rows.push(
      `  [${String(i).padStart(5)}] ${OP_NAMES[code].padEnd(13)} out=${describeLine(plan.outLine[i])}${detail ? "  " + detail : ""}`
    );
  }

  return rows.join("\n");
}
