/**
 * Naive reference implementation of the spread math — the executable spec.
 * -----------------------------------------------------------
 * Deliberately written with plain objects, plain loops and no shared state,
 * mirroring the legacy VBA section by section. The full spread is exercised
 * only by tests: they assert the compiled VM produces bit-identical results to
 * this file on hand-written and randomized inputs, keeping the VM's offset
 * arithmetic honest and doubling as living documentation of the math.
 *
 * The one runtime consumer is `referenceVacation` below — the Positions grid's
 * simulated Vacation Cost column reads it to value a position's leave without
 * running the whole component graph. It is the SAME valuation the budget run
 * applies (the VM deducts this vacation into the base line), kept honest by the
 * same parity tests, so the grid and the budget can never disagree.
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
  /** Per-working-day base pay, pre-increase — what one vacation/accrual day is
   *  worth. Monthly: base·twm/twd; hourly: rate·contractHours (the coeff). */
  dayRate: number;
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

  // Per-working-day base pay a vacation/accrual day is valued at. Hourly staff
  // use the raw per-day coeff; monthly staff use the seasonally-normalized rate
  // twd = 0 only when the position never works (then no vacation is emitted).
  const dayRate =
    position.hourlyRate > 0
      ? position.hourlyRate * position.dailyContractHours
      : twd > 0
        ? (position.monthlyBaseSalary * twm) / twd
        : 0;

  return { twm, twd, twd2, incMonth, incMul, manualMonthly, dayRate };
}

function grossBaseSalary(
  position: Position,
  calendar: CalendarContext,
  days: number[],
  d: DerivedTotals
): number[] {
  const seas = position.seasonality;
  // Two derivation modes (mutually exclusive inputs). Hourly: the base is
  // rate × contract hours × the month's net productive days — an actual
  // hours-worked figure, so it spreads over realDays and skips the twm/twd
  // day-normalization the monthly path uses. Vacation is netted downstream
  // (BASE_DEDUCT) in both modes, unchanged.
  const hourly = position.hourlyRate > 0;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (seas[m] === 0) {
      out.push(0);
      continue;
    }
    const daySpread = hourly
      ? position.hourlyRate *
        position.dailyContractHours *
        calendar.realDays[m] *
        seas[m] *
        d.incMul[m]
      : (position.monthlyBaseSalary * d.twm / d.twd) * days[m] * seas[m] * d.incMul[m];
    const manual = m >= d.incMonth ? d.manualMonthly * seas[m] : 0;
    out.push(daySpread + manual + position.additionalMonthlyCosts[m] * seas[m]);
  }
  return out;
}

function vacationCost(position: Position, d: DerivedTotals): number[] {
  const seas = position.seasonality;
  const weights = position.vacationMonthlyWeights;
  // The weights are treated as relative proportions: they are normalized by their
  // own total so the year's leave always sums to `vacationDays`, whatever the raw
  // weights add up to (the grid reddens a total ≠ 1 but the math self-corrects).
  // Total 1 divides exactly, so a tidy sum-to-1 set is unchanged. Total 0 means no
  // weighted month, so no vacation is placed.
  let weightTotal = 0;
  for (let m = 0; m < MONTHS; m++) weightTotal += weights[m];
  // A vacation day costs one working day of base pay (d.dayRate), weighted into
  // months by the vacation weights and priced with the merit factor of the month
  // it falls in — so leave weighted after the increase is dearer than before it.
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (seas[m] === 0 || weightTotal === 0) {
      out.push(0);
      continue;
    }
    out.push(
      position.vacationDays *
        weights[m] /
        weightTotal *
        seas[m] *
        d.dayRate *
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
        d.dayRate *
        seas[m] *
        d.incMul[m] -
        vacation[m]
    );
  }
  return out;
}

function bankHoliday(
  position: Position,
  calendar: CalendarContext,
  d: DerivedTotals,
  combinedMult: number,
  increaseAware: boolean
): number[] {
  const seas = position.seasonality;
  // A worked public holiday costs one working day of base pay (d.dayRate), scaled
  // by how many staff work it × the premium rate (combinedMult), for each holiday
  // in the month. Hourly-wage staff only — for everyone else combinedMult is 0
  // (their base already pays the day), so the line is zero. Priced with the merit
  // factor of the month it falls in when the component is increase-aware.
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (combinedMult === 0 || seas[m] === 0) {
      out.push(0);
      continue;
    }
    out.push(
      combinedMult *
        d.dayRate *
        calendar.holidayDays[m] *
        seas[m] *
        (increaseAware ? d.incMul[m] : 1)
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
  const weights = position.vacationMonthlyWeights;
  const vacationHours = position.vacationDays * position.dailyContractHours;
  // Vacation hours are added back to the yearly total, spread by days, then
  // taken out again following the vacation weights (VBA Section 22). The weights
  // are normalized by their total (as in vacationCost), so drifted weights remove
  // exactly the added-back hours; total 0 removes none.
  let weightTotal = 0;
  for (let m = 0; m < MONTHS; m++) weightTotal += weights[m];
  const totalHours = position.yearlyHoursWorked + vacationHours;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (totalHours === 0 || seas[m] === 0) {
      out.push(0);
      continue;
    }
    const spread = (totalHours / d.twd2) * calendar.realDays[m] * seas[m];
    const vacOut =
      weightTotal === 0 ? 0 : vacationHours * weights[m] / weightTotal * seas[m];
    out.push(spread - vacOut);
  }
  return out;
}

/**
 * Per-position vacation cost, month by month — the grid's simulated Vacation
 * Cost column. Needs only the position and the calendar (day basis + net days),
 * not the component graph, so it is far cheaper than a full referencePosition().
 * Identical to the vacation the budget run deducts from the base line.
 */
export function referenceVacation(
  position: Position,
  calendar: CalendarContext
): number[] {
  const days = Array.from(
    position.payType === "HOURLY" ? calendar.realDays : calendar.flatDays
  );
  return vacationCost(position, derive(position, calendar, days));
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

  const gross = grossBaseSalary(position, calendar, days, d);
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
    if (selector.kind === "CALENDAR") {
      // Day-count base: PAY_DAYS is the position's own pay-type basis (the
      // `days` array), REAL_DAYS always the productive-days calendar. Both ×
      // seasonality, so inactive months contribute nothing.
      const series = selector.series === "REAL_DAYS" ? calendar.realDays : days;
      for (let m = 0; m < MONTHS; m++) base[m] = series[m] * seas[m];
      return base;
    }
    if (selector.kind === "VACATION") {
      // The vacation-cost series — the same values BASE_DEDUCT nets out of
      // the salary line (seasonality and merit increase already applied).
      for (let m = 0; m < MONTHS; m++) base[m] = vacation[m];
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
      case "BANK_HOLIDAY": {
        // Hourly-wage staff only (hourlyRate > 0): their base literally excludes
        // the holiday day, so working it is fully additional. For everyone else
        // the multiplier collapses to 0 and the line is zero.
        const combinedMult =
          position.hourlyRate > 0
            ? (def.bankHolidayStaffFraction ?? 0) * (def.bankHolidayPremiumMultiplier ?? 0)
            : 0;
        out = bankHoliday(position, calendar, d, combinedMult, def.increaseAware);
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
          case "FLAT_MONTHLY": {
            // A single per-month amount (carried in the yearlyValue slot)
            // booked each active month — total = amount × totalWorkingMonths.
            const amount = value?.yearlyValue ?? 0;
            for (let m = 0; m < MONTHS; m++) {
              out[m] = amount * seas[m] * (applyIncrease ? d.incMul[m] : 1);
            }
            break;
          }
          case "VACATION_WEIGHTED": {
            // Yearly value distributed by the position's vacation weights,
            // normalized by their own total exactly like vacationCost — so a
            // drifted weight set still books exactly the yearly value.
            const yearly = value?.yearlyValue ?? 0;
            const weights = position.vacationMonthlyWeights;
            let weightTotal = 0;
            for (let m = 0; m < MONTHS; m++) weightTotal += weights[m];
            if (yearly !== 0 && weightTotal !== 0) {
              for (let m = 0; m < MONTHS; m++) {
                out[m] =
                  yearly * weights[m] / weightTotal * seas[m] *
                  (applyIncrease ? d.incMul[m] : 1);
              }
            }
            break;
          }
          case "DIRECT_ABS": {
            // Absolute pass-through — no seasonality, no increase. The KPI
            // series (× per-position multiplier) is already resolved to
            // per-month figures at load time.
            const monthly = value?.monthlyValues ?? new Array(MONTHS).fill(0);
            for (let m = 0; m < MONTHS; m++) out[m] = monthly[m];
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

  // Count multiplier — mirror of execute.ts. The row represents `headcount`
  // identical positions: compute every line as a single unit first (so the
  // social-security caps apply per person), then book it C times over. The
  // HEADCOUNT stat already carries the count, so it stays as-is.
  const count = position.headcount;
  if (count !== 1) {
    for (const def of definitions) {
      if (def.kind === "STAT" && def.statKind === "HEADCOUNT") continue;
      // KPI-driven lines are absolute (whole-line amount), not per-head.
      if (def.spreadMethod === "DIRECT_ABS") continue;
      const series = lines.get(def.id);
      if (series) for (let m = 0; m < MONTHS; m++) series[m] *= count;
    }
  }

  return { lines, grossBase: gross, vacation };
}
