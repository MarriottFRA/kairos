/**
 * Naive reference implementation of the spread math — the executable spec.
 * -----------------------------------------------------------
 * Deliberately written with plain objects, plain loops and no shared state,
 * mirroring the legacy VBA section by section. It is NOT used at runtime:
 * tests assert that the compiled VM produces bit-identical results to this
 * file on both hand-written and randomized inputs, which keeps the VM's
 * offset arithmetic honest and doubles as living documentation of the math.
 *
 * If a semantic question ever comes up, THIS file is the answer; the VM is
 * merely a fast encoding of it.
 */

import {
  BaseSelector,
  CalendarContext,
  ComponentValue,
  CostComponentDefinition,
  MONTHS,
  Position,
  SocialSecurityScheme,
} from "./types";

export interface ReferencePositionResult {
  /** Monthly values per emitting component definition id. */
  lines: Map<string, number[]>;
  /** Gross base salary (pre vacation deduction) — the series % bases use. */
  grossBase: number[];
  vacation: number[];
}

interface DerivedTotals {
  twm: number;
  twd: number;
  twd2: number;
  /** 0-based first increase month; 12 = no increase. */
  incMonth: number;
  incMul: number[];
  manualMonthly: number;
}

function derive(position: Position, calendar: CalendarContext, days: number[]): DerivedTotals {
  const seas = position.seasonality;
  const rawMonth = Math.trunc(position.increaseMonth);
  const incMonth = rawMonth >= 1 && rawMonth <= MONTHS ? rawMonth - 1 : MONTHS;

  let twm = 0;
  let twd = 0;
  let twd2 = 0;
  let activeFromIncrease = 0;
  for (let m = 0; m < MONTHS; m++) {
    if (seas[m] !== 0) {
      twm += seas[m];
      twd += days[m] * seas[m];
      twd2 += calendar.realDays[m] * seas[m];
      if (m >= incMonth) activeFromIncrease += seas[m];
    }
  }

  const incMul: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    incMul.push(m >= incMonth ? 1 + position.meritIncreasePct : 1);
  }

  const manualMonthly =
    activeFromIncrease === 0 ? 0 : position.manualYearlyIncrease / activeFromIncrease;

  return { twm, twd, twd2, incMonth, incMul, manualMonthly };
}

function grossBaseSalary(position: Position, days: number[], d: DerivedTotals): number[] {
  const seas = position.seasonality;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (seas[m] === 0) {
      out.push(0);
      continue;
    }
    const daySpread =
      (position.monthlyBaseSalary * d.twm / d.twd) * days[m] * seas[m] * d.incMul[m];
    const manual = m >= d.incMonth ? d.manualMonthly * seas[m] : 0;
    out.push(daySpread + manual + position.additionalMonthlyCosts[m] * seas[m]);
  }
  return out;
}

function vacationCost(position: Position, d: DerivedTotals): number[] {
  const seas = position.seasonality;
  // Seasonality already shrinks the year, so the daily rate is normalized back
  // to a full-year footing before the weights apply (VBA Section 2).
  const adjustedDailyPay =
    d.twm > 0 ? (position.dailyVacationCost / d.twm) * 12 : position.dailyVacationCost;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (seas[m] === 0) {
      out.push(0);
      continue;
    }
    out.push(
      position.vacationDays *
        position.vacationMonthlyWeights[m] *
        seas[m] *
        adjustedDailyPay *
        d.incMul[m]
    );
  }
  return out;
}

function holidayAccrual(position: Position, d: DerivedTotals, vacation: number[]): number[] {
  const seas = position.seasonality;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (position.accrualDaysPerMonth === 0 || seas[m] === 0) {
      out.push(0);
      continue;
    }
    out.push(
      position.accrualDaysPerMonth *
        position.accrualCostPerDay *
        seas[m] *
        d.incMul[m] -
        vacation[m]
    );
  }
  return out;
}

function socialSecurity(scheme: SocialSecurityScheme, base: number[]): number[] {
  const monthlyCap = scheme.monthlyCap ?? Infinity;
  const yearlyCap = scheme.yearlyCap ?? Infinity;

  // Total contribution on a cumulative base of x.
  const tax = (x: number): number => {
    let total = 0;
    let prev = 0;
    for (const bracket of scheme.brackets) {
      const upTo = bracket.upTo ?? Infinity;
      const hi = Math.min(x, upTo);
      if (hi > prev) total += (hi - prev) * bracket.rate;
      if (upTo >= x) break;
      prev = upTo;
    }
    return total;
  };

  const out: number[] = [];
  let cumPrev = 0;
  for (let m = 0; m < MONTHS; m++) {
    const monthBase = Math.min(base[m], monthlyCap);
    const cum = Math.min(cumPrev + monthBase, yearlyCap);
    out.push(tax(cum) - tax(cumPrev));
    cumPrev = cum;
  }
  return out;
}

function hoursWorked(position: Position, calendar: CalendarContext, d: DerivedTotals): number[] {
  const seas = position.seasonality;
  const vacationHours = position.vacationDays * position.dailyContractHours;
  // Vacation hours are added back to the yearly total, spread by days, then
  // taken out again following the vacation weights (VBA Section 22).
  const totalHours = position.yearlyHoursWorked + vacationHours;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (totalHours === 0 || seas[m] === 0) {
      out.push(0);
      continue;
    }
    const spread = (totalHours / d.twd2) * calendar.realDays[m] * seas[m];
    const vacOut = vacationHours * position.vacationMonthlyWeights[m] * seas[m];
    out.push(spread - vacOut);
  }
  return out;
}

/**
 * Compute every component line for one position, in dependency order (the
 * caller passes definitions already filtered to the scenario; order in the
 * array does not matter — bases are resolved by recursion).
 */
export function referencePosition(
  position: Position,
  calendar: CalendarContext,
  definitions: CostComponentDefinition[],
  ssSchemes: SocialSecurityScheme[],
  componentValues: ComponentValue[]
): ReferencePositionResult {
  const seas = position.seasonality;
  const days = Array.from(
    position.payType === "HOURLY" ? calendar.realDays : calendar.flatDays
  );
  const d = derive(position, calendar, days);

  const gross = grossBaseSalary(position, days, d);
  const vacation = vacationCost(position, d);

  const valueByDef = new Map<string, ComponentValue>();
  for (const value of componentValues) {
    if (value.positionId === position.id) valueByDef.set(value.componentDefId, value);
  }
  const defById = new Map(definitions.map((def) => [def.id as string, def]));
  const schemeById = new Map(ssSchemes.map((scheme) => [scheme.id as string, scheme]));

  const lines = new Map<string, number[]>();

  const resolveBase = (selector: BaseSelector | undefined): number[] => {
    const base = new Array(MONTHS).fill(0);
    if (!selector || selector.kind === "BASE_SALARY") {
      for (let m = 0; m < MONTHS; m++) base[m] = gross[m];
      return base;
    }
    for (const id of selector.componentIds) {
      const def = defById.get(id);
      if (!def) continue;
      const series = def.kind === "BASE_SALARY" ? gross : computeLine(def);
      for (let m = 0; m < MONTHS; m++) base[m] += series[m];
    }
    return base;
  };

  const computeLine = (def: CostComponentDefinition): number[] => {
    const existing = lines.get(def.id);
    if (existing) return existing;
    let out: number[];

    switch (def.kind) {
      case "BASE_SALARY": {
        out = gross.map((value, m) => value - vacation[m]);
        break;
      }
      case "HOLIDAY_ACCRUAL": {
        out = holidayAccrual(position, d, vacation);
        break;
      }
      case "SOCIAL_SECURITY": {
        const scheme = schemeById.get(def.ssSchemeId as string);
        if (!scheme) throw new Error(`reference: missing scheme for ${def.label}`);
        out = socialSecurity(scheme, resolveBase(def.baseSelector));
        break;
      }
      case "STAT": {
        out = new Array(MONTHS).fill(0);
        for (let m = 0; m < MONTHS; m++) {
          if (def.statKind === "HEADCOUNT") out[m] = seas[m] > 0 ? position.headcount : 0;
          else if (def.statKind === "FTE") out[m] = position.fte * seas[m];
        }
        if (def.statKind === "HOURS") out = hoursWorked(position, calendar, d);
        break;
      }
      case "SPREAD": {
        const value = valueByDef.get(def.id);
        out = new Array(MONTHS).fill(0);
        const applyIncrease = def.increaseAware;

        switch (def.spreadMethod) {
          case "PERCENT_OF": {
            const rate = value?.rate ?? 0;
            const base = resolveBase(def.baseSelector);
            for (let m = 0; m < MONTHS; m++) out[m] = rate * base[m];
            break;
          }
          case "WEIGHTED_BY_BASE": {
            const yearly = value?.yearlyValue ?? 0;
            const base = resolveBase(def.baseSelector);
            const baseTotal = base.reduce((sum, v) => sum + v, 0);
            if (yearly !== 0 && baseTotal !== 0) {
              for (let m = 0; m < MONTHS; m++) out[m] = (yearly / baseTotal) * base[m];
            }
            break;
          }
          case "FLAT_PER_ACTIVE_MONTH":
          case "QTY_TIMES_RATE": {
            const yearly =
              def.spreadMethod === "QTY_TIMES_RATE"
                ? (value?.qty ?? 0) * (value?.unitRate ?? 0)
                : value?.yearlyValue ?? 0;
            if (yearly !== 0) {
              for (let m = 0; m < MONTHS; m++) {
                if (seas[m] !== 0) {
                  out[m] = (yearly / d.twm) * seas[m] * (applyIncrease ? d.incMul[m] : 1);
                }
              }
            }
            break;
          }
          case "FLAT_PER_DAY": {
            const yearly = value?.yearlyValue ?? 0;
            if (yearly !== 0) {
              for (let m = 0; m < MONTHS; m++) {
                if (seas[m] !== 0) {
                  out[m] =
                    (yearly / d.twd) * days[m] * seas[m] * (applyIncrease ? d.incMul[m] : 1);
                }
              }
            }
            break;
          }
          case "DIRECT_MONTHLY": {
            const monthly = value?.monthlyValues ?? new Array(MONTHS).fill(0);
            for (let m = 0; m < MONTHS; m++) {
              out[m] = monthly[m] * seas[m] * (applyIncrease ? d.incMul[m] : 1);
            }
            break;
          }
          default:
            throw new Error(`reference: unsupported spread method ${def.spreadMethod}`);
        }
        break;
      }
      default:
        throw new Error(`reference: unsupported component kind ${def.kind}`);
    }

    lines.set(def.id, out);
    return out;
  };

  for (const def of definitions) computeLine(def);

  return { lines, grossBase: gross, vacation };
}
