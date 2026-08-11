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
  bankHolidayCoefficient,
  BaseSelector,
  CalendarContext,
  ComponentValue,
  CostComponentDefinition,
  MONTHS,
  Position,
  serviceSeries,
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

/**
 * Days of leave TAKEN each month — the vacation weights as relative proportions,
 * normalized by their own total so the year's leave always sums to
 * `vacationDays`, whatever the raw weights add up to (the grid reddens a total
 * ≠ 1 but the math self-corrects). Total 1 divides exactly, so a tidy sum-to-1
 * set is unchanged. Total 0 means no weighted month, so no vacation is placed.
 *
 * Split out from `vacationCost` because the accrual provisions for the same
 * days it prices — deriving both legs from ONE day series is what makes the
 * accrual line net to zero (see `holidayAccrual`).
 */
function vacationDaysTaken(position: Position): number[] {
  const seas = position.seasonality;
  const weights = position.vacationMonthlyWeights;
  let weightTotal = 0;
  for (let m = 0; m < MONTHS; m++) weightTotal += weights[m];
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    out.push(
      seas[m] === 0 || weightTotal === 0
        ? 0
        : position.vacationDays * weights[m] / weightTotal * seas[m]
    );
  }
  return out;
}

function vacationCost(position: Position, d: DerivedTotals, takenDays: number[]): number[] {
  // A vacation day costs one working day of base pay (d.dayRate), priced with the
  // merit factor of the month it falls in — so leave weighted after the increase
  // is dearer than before it.
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) out.push(takenDays[m] * d.dayRate * d.incMul[m]);
  return out;
}

/**
 * Holiday accrual as a liability ROLL-FORWARD, carried in days.
 *
 * The provision is earned evenly across the months the position actually works
 * (`seas[m]/twm`, not a flat 1/12 — a 9-month post earns its entitlement in 9
 * months, and provisioning in a month with no salary would have nothing to
 * provision against), and released in the months leave is taken. Both legs come
 * from the SAME `takenDays` series, so the year always accrues exactly what it
 * releases.
 *
 * Each month's charge is the movement in the liability:
 *
 *   accrual[m] = earned[m]·r[m]            — this month's days at this month's price
 *              + balance[m−1]·(r[m]−r[m−1]) — remeasure the standing balance
 *              − taken[m]·r[m]              — release at this month's price
 *
 * which is exactly `balance[m]·r[m] − balance[m−1]·r[m−1]` (the form coded
 * below). The year therefore TELESCOPES to zero: the closing balance is zero, so
 * Σ accrual = 0 for any weights, any seasonality and any number of merit steps,
 * and it is immune to rounding in the entered weights. The old formula compared
 * a hardcoded 1/12 against the normalized weights, so it drifted on all three.
 *
 * The release leg is priced at the taking month's rate, so it still cancels the
 * BASE_DEDUCT exactly; the merit revaluation surfaces in the month the rate
 * steps, not the month the holiday happens to be taken.
 *
 * Inactive months are skipped WITHOUT advancing the previous rate, so a merit
 * step landing in an off-season month revalues at the next worked month rather
 * than posting a line where the position is dormant.
 *
 * `accrualDaysPerMonth` survives only as an on/off guard — the app derives it as
 * vacationDays/12, and the roll-forward computes the earning leg itself.
 */
function holidayAccrual(position: Position, d: DerivedTotals, takenDays: number[]): number[] {
  const seas = position.seasonality;
  const out: number[] = [];
  let totalTaken = 0;
  for (let m = 0; m < MONTHS; m++) totalTaken += takenDays[m];

  let balance = 0;
  let prevRate = 0;
  for (let m = 0; m < MONTHS; m++) {
    if (position.accrualDaysPerMonth === 0 || seas[m] === 0 || d.twm === 0) {
      out.push(0);
      continue;
    }
    const rate = d.dayRate * d.incMul[m];
    const opening = balance;
    balance += totalTaken * seas[m] / d.twm - takenDays[m];
    out.push(balance * rate - opening * prevRate);
    prevRate = rate;
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
  // A public holiday costs one working day of base pay (d.dayRate) × the
  // position's coefficient (see bankHolidayCoefficient — coverage, pay rate,
  // eligibility and holiday-pay treatment all folded into one number), for each
  // holiday in the month. An ineligible position has a coefficient of 0, so the
  // line is zero. Priced with the merit factor of the month it falls in when the
  // component is increase-aware.
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

function socialSecurity(
  scheme: SocialSecurityScheme,
  base: number[],
  openingBase: number
): number[] {
  const monthlyCap = scheme.monthlyCap ?? Infinity;
  const yearlyCap = scheme.yearlyCap ?? Infinity;
  const perPeriod = scheme.accumulationMode === "PER_PERIOD";
  const resetIdx = (scheme.taxYearStartMonth ?? 1) - 1; // 0-based tax-year start

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
  if (perPeriod) {
    // Each month stands alone: no carry-over, no yearly cap.
    for (let m = 0; m < MONTHS; m++) {
      out.push(tax(Math.min(base[m], monthlyCap)));
    }
    return out;
  }
  // Cumulative: seed from the prior-year opening base, reset at the tax-year
  // boundary. A January start (resetIdx 0) resets at m=0 → opening base
  // discarded, identical to the pre-2c engine.
  let cumPrev = openingBase;
  for (let m = 0; m < MONTHS; m++) {
    if (m === resetIdx) cumPrev = 0;
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
 * Hours PAID — the same day-spread total as hoursWorked, but WITHOUT taking the
 * vacation hours back out again. So it answers "hours the position is paid for",
 * where hoursWorked answers "hours actually at work".
 *
 * Deliberately worked + vacation and nothing else: both terms are already on the
 * engine Position, so this needs no new inputs. It therefore excludes public
 * holidays and reads slightly lower than the grid's "Manhours Paid" column,
 * which is (contractYearlyDays − contractDaysOff) × dailyHours — those contract
 * fields are POSITION_EXTRA and never reach the engine.
 */
function hoursPaid(
  position: Position,
  calendar: CalendarContext,
  d: DerivedTotals
): number[] {
  const seas = position.seasonality;
  const totalHours =
    position.yearlyHoursWorked + position.vacationDays * position.dailyContractHours;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    if (totalHours === 0 || seas[m] === 0) {
      out.push(0);
      continue;
    }
    out.push((totalHours / d.twd2) * calendar.realDays[m] * seas[m]);
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
  return vacationCost(position, derive(position, calendar, days), vacationDaysTaken(position));
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
  const takenDays = vacationDaysTaken(position);
  const vacation = vacationCost(position, d, takenDays);

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
      // `days` array), REAL_DAYS always the productive-days calendar,
      // HOLIDAY_DAYS the public-holiday count. All × seasonality, so inactive
      // months contribute nothing.
      const series =
        selector.series === "REAL_DAYS"
          ? calendar.realDays
          : selector.series === "HOLIDAY_DAYS"
            ? calendar.holidayDays
            : days;
      for (let m = 0; m < MONTHS; m++) base[m] = series[m] * seas[m];
      return base;
    }
    if (selector.kind === "SERVICE") {
      // Length of service in calendar days since the hiring date — the month's
      // own days (MONTH) or the running total including prior years (TOTAL).
      // Whole days, seasonality-gated rather than seasonality-scaled — see
      // serviceSeries. Mirror of the ACC_ADD_SERVICE emission in compile.ts.
      const series = serviceSeries(position, selector.mode);
      for (let m = 0; m < MONTHS; m++) base[m] = series[m];
      return base;
    }
    if (selector.kind === "VACATION") {
      // The vacation-cost series — the same values BASE_DEDUCT nets out of
      // the salary line (seasonality and merit increase already applied).
      for (let m = 0; m < MONTHS; m++) base[m] = vacation[m];
      return base;
    }
    if (selector.kind === "SS_BASE") {
      // The Social-Security base: NET base salary (gross − vacation) and/or the
      // vacation series and/or other component lines. Ticking both flags sums to
      // gross. Custom ids are never the base-salary def, so computeLine is safe.
      for (let m = 0; m < MONTHS; m++) {
        if (selector.includeBaseSalary) base[m] += gross[m] - vacation[m];
        if (selector.includeVacation) base[m] += vacation[m];
      }
      for (const id of selector.componentIds) {
        const def = defById.get(id);
        if (!def) continue;
        const series = computeLine(def);
        for (let m = 0; m < MONTHS; m++) base[m] += series[m];
      }
      return base;
    }
    if (selector.kind === "COMBINE") {
      // The compound base: two selectors and an arithmetic operation between
      // them. Division by a zero month yields 0 (see BaseSelector.COMBINE) —
      // the same guard WEIGHTED_BY_BASE uses for a zero base total.
      const left = resolveBase(selector.left);
      const right = resolveBase(selector.right);
      for (let m = 0; m < MONTHS; m++) {
        switch (selector.op) {
          case "ADD":
            base[m] = left[m] + right[m];
            break;
          case "SUB":
            base[m] = left[m] - right[m];
            break;
          case "MUL":
            base[m] = left[m] * right[m];
            break;
          case "DIV":
            base[m] = right[m] === 0 ? 0 : left[m] / right[m];
            break;
        }
      }
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
        out = holidayAccrual(position, d, takenDays);
        break;
      }
      case "BANK_HOLIDAY": {
        // Same helper the compiler uses — the whole point of the parity test is
        // that these two agree, which they cannot if the rule lives twice.
        const combinedMult = bankHolidayCoefficient(def, position);
        out = bankHoliday(position, calendar, d, combinedMult, def.increaseAware);
        break;
      }
      case "SOCIAL_SECURITY": {
        const scheme = schemeById.get(def.ssSchemeId as string);
        if (!scheme) throw new Error(`reference: missing scheme for ${def.label}`);
        out = socialSecurity(
          scheme,
          resolveBase(def.baseSelector),
          valueByDef.get(def.id as string)?.ssOpeningBase ?? 0
        );
        break;
      }
      case "STAT": {
        out = new Array(MONTHS).fill(0);
        for (let m = 0; m < MONTHS; m++) {
          if (def.statKind === "HEADCOUNT") out[m] = seas[m] > 0 ? position.headcount : 0;
          else if (def.statKind === "FTE") out[m] = position.fte * seas[m];
        }
        if (def.statKind === "HOURS") out = hoursWorked(position, calendar, d);
        else if (def.statKind === "HOURS_PAID") out = hoursPaid(position, calendar, d);
        break;
      }
      case "SPREAD": {
        const value = valueByDef.get(def.id);
        out = new Array(MONTHS).fill(0);
        const applyIncrease = def.increaseAware;

        switch (def.spreadMethod) {
          case "PERCENT_OF": {
            // A compound base may pin its own rate — see BaseSelector.COMBINE.
            const rate =
              def.baseSelector?.kind === "COMBINE" &&
              def.baseSelector.rate !== undefined
                ? def.baseSelector.rate
                : value?.rate ?? 0;
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

  // Count × cluster-weight multiplier — mirror of execute.ts. The row
  // represents `headcount` identical positions, of which this hotel carries
  // `hotelClusterWeight` (its hotel-cluster share): compute every line as a
  // single unit first (so the social-security caps apply per person on the
  // FULL salary), then book it count × weight over. The HEADCOUNT stat
  // already carries the count and a shared person still counts as one head,
  // so it stays as-is; KPI-driven lines are absolute (whole-line amount),
  // not per-head, and stay exempt too.
  const coeff = position.headcount * position.hotelClusterWeight;
  if (coeff !== 1) {
    for (const def of definitions) {
      if (def.kind === "STAT" && def.statKind === "HEADCOUNT") continue;
      if (def.spreadMethod === "DIRECT_ABS") continue;
      // Ratios opt out: already a per-person figure, and the same figure however
      // many identical people the row stands for. See countExempt.
      if (def.countExempt) continue;
      const series = lines.get(def.id);
      if (series) for (let m = 0; m < MONTHS; m++) series[m] *= coeff;
    }
  }

  return { lines, grossBase: gross, vacation };
}
