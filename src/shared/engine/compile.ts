/**
 * Compiler: ScenarioInput → CompiledPlan.
 * -----------------------------------------------------------
 * Runs once per structural change (definitions / positions added, removed or
 * re-parameterized). It validates the input, orders components by dependency,
 * interns every dept×account string to an aggregate-row index, packs position
 * inputs into struct-of-arrays Float64Arrays, and emits the flat instruction
 * program described in opcodes.ts. After this, execution touches no strings,
 * no objects and allocates nothing.
 *
 * Determinism: positions are sorted by id, definitions by (sortOrder, id),
 * and the topological sort breaks ties in that same order — identical inputs
 * always produce an identical plan and therefore bit-identical results.
 */

import {
  FLAG_INCREASE_AWARE,
  LINE_NONE,
  Op,
} from "./opcodes";
import {
  AggregateKey,
  CompileError,
  ComponentValue,
  CostComponentDefinition,
  MONTHS,
  Position,
  PositionId,
  ScenarioId,
  ScenarioInput,
  SocialSecurityScheme,
  SS_MAX_BRACKETS,
  StatKey,
} from "./types";

export interface CompiledPlan {
  scenarioId: ScenarioId;

  // ---- interned dimensions ----
  aggKeys: AggregateKey[];
  statKeys: StatKey[];
  positionIds: PositionId[];
  positionIndex: Map<string, number>;
  /** Emission (topological) order. Every def emits exactly one line per
   *  position: line = p × componentDefs.length + defIndex. */
  componentDefs: CostComponentDefinition[];

  // ---- line matrix layout ----
  lineCount: number;
  lineAggRow: Uint32Array;

  // ---- instruction stream ----
  op: Uint8Array;
  outLine: Uint32Array;
  arg0: Uint32Array;
  paramOfs: Uint32Array;
  paramPool: Float64Array;
  /** Length P+1: instruction range of position p. */
  positionInstrStart: Uint32Array;

  // ---- packed per-position inputs ----
  seasonality: Float64Array; // P×12
  daysPerMonth: Float64Array; // P×12, pay-type basis resolved
  realDays: Float64Array; // 12 (HOURS-stat basis)
  holidayDays: Float64Array; // 12 (BANK_HOLIDAY count basis)
  posHeadcount: Float64Array; // P
  posFte: Float64Array; // P
  /** Hotel-cluster share per position (1 = fully owned). Applied with the
   *  count in the multiplier pass; HEADCOUNT stays unweighted. */
  posWeight: Float64Array; // P
  positionStatRow: Uint32Array; // P → statKeys index

  // ---- buyouts (bypass the VM, merged during aggregation) ----
  buyoutAggRow: Uint32Array;
  buyoutValues: Float64Array; // B×12
}

export type CompileResult = { plan: CompiledPlan } | { errors: CompileError[] };

// ---------------------------------------------------------------------------

// STAT lines (hours worked, headcount, FTE) are ordinary lines in the value
// matrix, so ACC_ADD_LINE can feed them to a % base like any spread — they
// power "multiplier of hours" blocks.
const BASE_REFERENCEABLE = new Set([
  "BASE_SALARY",
  "SPREAD",
  "SOCIAL_SECURITY",
  "STAT",
]);

function compareDefs(a: CostComponentDefinition, b: CostComponentDefinition): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function validate(
  definitions: CostComponentDefinition[],
  schemeById: Map<string, SocialSecurityScheme>,
  positions: Position[]
): CompileError[] {
  const errors: CompileError[] = [];
  const defById = new Map(definitions.map((def) => [def.id as string, def]));

  const baseDefs = definitions.filter((def) => def.kind === "BASE_SALARY");
  if (baseDefs.length === 0) {
    errors.push({
      code: "MISSING_BASE",
      message: "Exactly one BASE_SALARY component definition is required.",
    });
  } else if (baseDefs.length > 1) {
    errors.push({
      code: "MULTIPLE_BASE",
      message: "Only one BASE_SALARY component definition is allowed.",
      refs: baseDefs.map((def) => def.id),
    });
  }

  const accrualDefs = definitions.filter((def) => def.kind === "HOLIDAY_ACCRUAL");
  if (accrualDefs.length > 1) {
    errors.push({
      code: "MULTIPLE_ACCRUAL",
      message: "Only one HOLIDAY_ACCRUAL component definition is allowed.",
      refs: accrualDefs.map((def) => def.id),
    });
  }

  const bankHolidayDefs = definitions.filter((def) => def.kind === "BANK_HOLIDAY");
  if (bankHolidayDefs.length > 1) {
    errors.push({
      code: "MULTIPLE_BANK_HOLIDAY",
      message: "Only one BANK_HOLIDAY component definition is allowed.",
      refs: bankHolidayDefs.map((def) => def.id),
    });
  }

  for (const def of definitions) {
    if (def.kind === "SPREAD") {
      if (!def.spreadMethod) {
        errors.push({
          code: "MISSING_SPREAD_METHOD",
          message: `Spread component "${def.label}" has no spread method.`,
          refs: [def.id],
        });
      } else if (def.spreadMethod === "REVENUE_WEIGHTED") {
        errors.push({
          code: "UNSUPPORTED_METHOD",
          message: `"${def.label}": REVENUE_WEIGHTED is reserved and not yet supported.`,
          refs: [def.id],
        });
      }
    }
    if (def.kind === "STAT" && !def.statKind) {
      errors.push({
        code: "MISSING_STAT_KIND",
        message: `Stat component "${def.label}" has no stat kind.`,
        refs: [def.id],
      });
    }
    if (def.kind === "SOCIAL_SECURITY") {
      const scheme = def.ssSchemeId ? schemeById.get(def.ssSchemeId) : undefined;
      if (!scheme) {
        errors.push({
          code: "MISSING_SCHEME",
          message: `Social security component "${def.label}" references a missing scheme.`,
          refs: [def.id, def.ssSchemeId ?? "(none)"],
        });
      } else {
        const schemeErrors = validateScheme(scheme);
        if (schemeErrors) errors.push(schemeErrors);
      }
    }
    const baseComponentIds =
      def.baseSelector?.kind === "COMPONENTS" || def.baseSelector?.kind === "SS_BASE"
        ? def.baseSelector.componentIds
        : null;
    if (baseComponentIds) {
      for (const refId of baseComponentIds) {
        const target = defById.get(refId);
        if (!target) {
          errors.push({
            code: "MISSING_DEF",
            message: `"${def.label}" includes an unknown component in its base.`,
            refs: [def.id, refId],
          });
        } else if (!BASE_REFERENCEABLE.has(target.kind)) {
          errors.push({
            code: "INVALID_BASE_REF",
            message: `"${def.label}" cannot include ${target.kind} component "${target.label}" in its base.`,
            refs: [def.id, refId],
          });
        }
      }
    }
  }

  for (const position of positions) {
    const vectors: Array<[string, number[]]> = [
      ["seasonality", position.seasonality],
      ["additionalMonthlyCosts", position.additionalMonthlyCosts],
      ["vacationMonthlyWeights", position.vacationMonthlyWeights],
    ];
    for (const [name, vector] of vectors) {
      if (!Array.isArray(vector) || vector.length !== MONTHS) {
        errors.push({
          code: "INVALID_POSITION",
          message: `Position ${position.id}: ${name} must have ${MONTHS} entries.`,
          refs: [position.id],
        });
      }
    }
    // The loaders' resolver guarantees a sane weight; reject junk here so a
    // loader bug fails loudly instead of silently zeroing (≤ 0) or inflating
    // (> 1) every line.
    const weight = position.hotelClusterWeight;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      errors.push({
        code: "INVALID_POSITION",
        message: `Position ${position.id}: hotelClusterWeight must be a number in (0, 1].`,
        refs: [position.id],
      });
    }
  }

  return errors;
}

function validateScheme(scheme: SocialSecurityScheme): CompileError | null {
  const brackets = scheme.brackets;
  if (brackets.length === 0 || brackets.length > SS_MAX_BRACKETS) {
    return {
      code: "INVALID_SCHEME",
      message: `Scheme "${scheme.label}" must have 1-${SS_MAX_BRACKETS} brackets.`,
      refs: [scheme.id],
    };
  }
  let prev = 0;
  for (let i = 0; i < brackets.length; i++) {
    const upTo = brackets[i].upTo;
    if (upTo === null) {
      if (i !== brackets.length - 1) {
        return {
          code: "INVALID_SCHEME",
          message: `Scheme "${scheme.label}": only the last bracket may be unbounded.`,
          refs: [scheme.id],
        };
      }
    } else {
      if (upTo <= prev) {
        return {
          code: "INVALID_SCHEME",
          message: `Scheme "${scheme.label}": bracket bounds must be strictly ascending.`,
          refs: [scheme.id],
        };
      }
      prev = upTo;
    }
  }
  return null;
}

/**
 * Kahn topological sort over the component dependency DAG. Dependencies:
 * PERCENT_OF / WEIGHTED_BY_BASE / SOCIAL_SECURITY depend on their base
 * components (default base = BASE_SALARY); HOLIDAY_ACCRUAL and BANK_HOLIDAY
 * depend on BASE_SALARY (they read the per-working-day base pay it derives).
 * Ready nodes are taken in (sortOrder, id) order → deterministic output.
 */
function topoSort(
  definitions: CostComponentDefinition[]
): { order: CostComponentDefinition[] } | { cycle: CostComponentDefinition[] } {
  const sorted = [...definitions].sort(compareDefs);
  const indexById = new Map(sorted.map((def, index) => [def.id as string, index]));
  const baseIndex = sorted.findIndex((def) => def.kind === "BASE_SALARY");

  const dependsOn: number[][] = sorted.map((): number[] => []);
  for (let i = 0; i < sorted.length; i++) {
    const def = sorted[i];
    const usesBase =
      def.kind === "HOLIDAY_ACCRUAL" ||
      def.kind === "BANK_HOLIDAY" ||
      def.kind === "SOCIAL_SECURITY" ||
      (def.kind === "SPREAD" &&
        (def.spreadMethod === "PERCENT_OF" || def.spreadMethod === "WEIGHTED_BY_BASE"));
    if (!usesBase) continue;

    const selector =
      def.kind !== "HOLIDAY_ACCRUAL" && def.kind !== "BANK_HOLIDAY"
        ? def.baseSelector
        : undefined;
    if (selector?.kind === "COMPONENTS") {
      for (const refId of selector.componentIds) {
        const refIndex = indexById.get(refId);
        if (refIndex !== undefined && refIndex !== i) dependsOn[i].push(refIndex);
      }
    } else if (selector?.kind === "SS_BASE") {
      // Net base + vacation scratch are both produced by the BASE_SALARY block,
      // so always depend on it; then on each custom component line.
      if (baseIndex >= 0 && baseIndex !== i) dependsOn[i].push(baseIndex);
      for (const refId of selector.componentIds) {
        const refIndex = indexById.get(refId);
        if (refIndex !== undefined && refIndex !== i) dependsOn[i].push(refIndex);
      }
    } else if (baseIndex >= 0 && baseIndex !== i) {
      dependsOn[i].push(baseIndex);
    }
  }

  const indegree = sorted.map((_, i) => dependsOn[i].length);
  const dependents: number[][] = sorted.map((): number[] => []);
  for (let i = 0; i < sorted.length; i++) {
    for (const dep of dependsOn[i]) dependents[dep].push(i);
  }

  const order: CostComponentDefinition[] = [];
  const done = new Array<boolean>(sorted.length).fill(false);
  for (;;) {
    let next = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (!done[i] && indegree[i] === 0) {
        next = i;
        break;
      }
    }
    if (next === -1) break;
    done[next] = true;
    order.push(sorted[next]);
    for (const dependent of dependents[next]) indegree[dependent]--;
  }

  if (order.length !== sorted.length) {
    return { cycle: sorted.filter((_, i) => !done[i]) };
  }
  return { order };
}

// ---------------------------------------------------------------------------

/** Growable instruction/param buffers used during emission. */
class Emitter {
  op: number[] = [];
  outLine: number[] = [];
  arg0: number[] = [];
  paramOfs: number[] = [];
  paramPool: number[] = [];

  emit(op: number, outLine: number, arg0: number, params: number[]): void {
    this.op.push(op);
    this.outLine.push(outLine);
    this.arg0.push(arg0);
    this.paramOfs.push(this.paramPool.length);
    for (const param of params) this.paramPool.push(param);
  }
}

/** Interns `dept|account` pairs to dense row indices, insertion-ordered. */
class KeyInterner<K> {
  keys: K[] = [];
  private map = new Map<string, number>();

  intern(id: string, key: K): number {
    let row = this.map.get(id);
    if (row === undefined) {
      row = this.keys.length;
      this.map.set(id, row);
      this.keys.push(key);
    }
    return row;
  }
}

export function compile(input: ScenarioInput): CompileResult {
  const definitions = input.definitions.filter((def) => def.deletedAt === null);
  const positions = [...input.positions.filter((p) => p.deletedAt === null)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const buyouts = input.buyouts.filter((row) => row.deletedAt === null);
  const schemeById = new Map(
    input.ssSchemes.filter((s) => s.deletedAt === null).map((s) => [s.id as string, s])
  );

  const errors = validate(definitions, schemeById, positions);
  if (errors.length > 0) return { errors };

  const topo = topoSort(definitions);
  if ("cycle" in topo) {
    return {
      errors: [
        {
          code: "CYCLE",
          message: `Component base references form a cycle: ${topo.cycle
            .map((def) => def.label)
            .join(" → ")}.`,
          refs: topo.cycle.map((def) => def.id),
        },
      ],
    };
  }
  const componentDefs = topo.order;
  const defCount = componentDefs.length;
  const defIndexById = new Map(componentDefs.map((def, index) => [def.id as string, index]));
  const baseDefIndex = componentDefs.findIndex((def) => def.kind === "BASE_SALARY");
  const positionCount = positions.length;

  // ---- per-(position, component) values, keyed for O(1) lookup ----
  const valueByKey = new Map<string, ComponentValue>();
  for (const value of input.componentValues) {
    if (value.deletedAt === null) {
      valueByKey.set(`${value.positionId}|${value.componentDefId}`, value);
    }
  }

  // ---- interning ----
  const aggInterner = new KeyInterner<AggregateKey>();
  const statInterner = new KeyInterner<StatKey>();

  const lineAggRow = new Uint32Array(positionCount * defCount);
  const positionStatRow = new Uint32Array(positionCount);

  // ---- packed inputs ----
  const seasonality = new Float64Array(positionCount * MONTHS);
  const daysPerMonth = new Float64Array(positionCount * MONTHS);
  const posHeadcount = new Float64Array(positionCount);
  const posFte = new Float64Array(positionCount);
  const posWeight = new Float64Array(positionCount);

  const emitter = new Emitter();
  const positionInstrStart = new Uint32Array(positionCount + 1);

  /** Emits ACC_CLEAR + ACC_ADD_* ops realizing a base selector for position p. */
  const emitAccumulator = (
    def: CostComponentDefinition,
    lineBase: number
  ): void => {
    emitter.emit(Op.ACC_CLEAR, LINE_NONE, 0, []);
    const selector = def.baseSelector;
    if (!selector || selector.kind === "BASE_SALARY") {
      emitter.emit(Op.ACC_ADD_GROSS, LINE_NONE, 0, []);
      return;
    }
    if (selector.kind === "CALENDAR") {
      emitter.emit(
        Op.ACC_ADD_DAYS,
        LINE_NONE,
        selector.series === "REAL_DAYS" ? 1 : 0,
        []
      );
      return;
    }
    if (selector.kind === "VACATION") {
      emitter.emit(Op.ACC_ADD_VAC, LINE_NONE, 0, []);
      return;
    }
    if (selector.kind === "SS_BASE") {
      // Emit net base → vacation → components, matching reference.ts order. The
      // NET base line is the BASE_SALARY def's output (post-BASE_DEDUCT), read
      // via ACC_ADD_LINE — not ACC_ADD_GROSS, which would re-add vacation.
      if (selector.includeBaseSalary && baseDefIndex >= 0) {
        emitter.emit(Op.ACC_ADD_LINE, LINE_NONE, lineBase + baseDefIndex, []);
      }
      if (selector.includeVacation) {
        emitter.emit(Op.ACC_ADD_VAC, LINE_NONE, 0, []);
      }
      for (const refId of selector.componentIds) {
        const refIndex = defIndexById.get(refId);
        if (refIndex === undefined) continue; // validated above; defensive
        emitter.emit(Op.ACC_ADD_LINE, LINE_NONE, lineBase + refIndex, []);
      }
      return;
    }
    for (const refId of selector.componentIds) {
      const refIndex = defIndexById.get(refId);
      if (refIndex === undefined) continue; // validated above; defensive
      if (componentDefs[refIndex].kind === "BASE_SALARY") {
        emitter.emit(Op.ACC_ADD_GROSS, LINE_NONE, 0, []);
      } else {
        emitter.emit(Op.ACC_ADD_LINE, LINE_NONE, lineBase + refIndex, []);
      }
    }
  };

  for (let p = 0; p < positionCount; p++) {
    const position = positions[p];
    positionInstrStart[p] = emitter.op.length;

    const days = position.payType === "HOURLY" ? input.calendar.realDays : input.calendar.flatDays;
    for (let m = 0; m < MONTHS; m++) {
      seasonality[p * MONTHS + m] = position.seasonality[m];
      daysPerMonth[p * MONTHS + m] = days[m];
    }
    posHeadcount[p] = position.headcount;
    posFte[p] = position.fte;
    // Verbatim — no clamping (validate() rejects junk; a silent clamp here
    // would desync from the reference implementation).
    posWeight[p] = position.hotelClusterWeight;
    positionStatRow[p] = statInterner.intern(
      `${position.cluster}|${position.jobTypeCode}`,
      { cluster: position.cluster, jobTypeCode: position.jobTypeCode }
    );

    const lineBase = p * defCount;

    emitter.emit(Op.DERIVE, LINE_NONE, 0, [
      position.meritIncreasePct,
      position.manualYearlyIncrease,
      position.increaseMonth,
    ]);

    for (let di = 0; di < defCount; di++) {
      const def = componentDefs[di];
      const line = lineBase + di;
      const value = valueByKey.get(`${position.id}|${def.id}`);

      const dept =
        def.departmentMode === "FIXED" && def.fixedDepartment
          ? def.fixedDepartment
          : position.departmentCode;
      // Per-row account override ("unlocked" blocks): the aggregation key is
      // interned at compile time, so an override is purely a key change — the
      // VM and every line value are untouched.
      const account = value?.accountCode ?? def.accountCode;
      lineAggRow[line] = aggInterner.intern(`${dept}|${account}`, {
        dept,
        account,
      });

      const increaseFlag = def.increaseAware ? FLAG_INCREASE_AWARE : 0;

      switch (def.kind) {
        case "BASE_SALARY": {
          // Hourly-rate positions derive the base from rate × contract hours,
          // spread over realDays (net productive days); the coefficient is
          // pre-multiplied here so the VM mirrors the reference bit-for-bit.
          // Presence of hourlyRate is the discriminator — the two salary inputs
          // are mutually exclusive (enforced in the grid), so hourlyRate wins.
          if (position.hourlyRate > 0) {
            emitter.emit(Op.BASE_SALARY_HOURLY, line, 0, [
              position.hourlyRate * position.dailyContractHours,
              ...position.additionalMonthlyCosts,
            ]);
          } else {
            emitter.emit(Op.BASE_SALARY, line, 0, [
              position.monthlyBaseSalary,
              ...position.additionalMonthlyCosts,
            ]);
          }
          emitter.emit(Op.VACATION, LINE_NONE, 0, [
            position.vacationDays,
            ...position.vacationMonthlyWeights,
          ]);
          emitter.emit(Op.BASE_DEDUCT, line, 0, []);
          break;
        }
        case "HOLIDAY_ACCRUAL": {
          emitter.emit(Op.ACCRUAL, line, 0, [position.accrualDaysPerMonth]);
          break;
        }
        case "BANK_HOLIDAY": {
          // The staff-fraction × premium is folded into one coefficient here.
          // Hourly-wage staff only (hourlyRate > 0) — their base excludes the
          // holiday day, so a worked holiday is fully additional; for everyone
          // else the coefficient is 0, so the line is a branchless zero.
          const combinedMult =
            position.hourlyRate > 0
              ? (def.bankHolidayStaffFraction ?? 0) * (def.bankHolidayPremiumMultiplier ?? 0)
              : 0;
          emitter.emit(Op.BANK_HOLIDAY, line, increaseFlag, [combinedMult]);
          break;
        }
        case "SOCIAL_SECURITY": {
          const scheme = schemeById.get(def.ssSchemeId as string)!;
          emitAccumulator(def, lineBase);
          const params = [
            scheme.monthlyCap ?? Infinity,
            scheme.yearlyCap ?? Infinity,
            scheme.brackets.length,
            // 2c: accumulation mode + tax-year reset + prior-year opening base.
            // Defaults (CUMULATIVE, month 1, opening 0) reproduce the pre-2c run.
            scheme.accumulationMode === "PER_PERIOD" ? 1 : 0,
            scheme.taxYearStartMonth ?? 1,
            value?.ssOpeningBase ?? 0,
          ];
          for (let b = 0; b < SS_MAX_BRACKETS; b++) {
            const bracket = scheme.brackets[b];
            params.push(bracket ? bracket.upTo ?? Infinity : Infinity);
            params.push(bracket ? bracket.rate : 0);
          }
          emitter.emit(Op.SOCIAL_SEC, line, 0, params);
          break;
        }
        case "STAT": {
          if (def.statKind === "HEADCOUNT") {
            emitter.emit(Op.STAT_HC, line, 0, [position.headcount]);
          } else if (def.statKind === "FTE") {
            emitter.emit(Op.STAT_FTE, line, 0, [position.fte]);
          } else {
            const vacationHours = position.vacationDays * position.dailyContractHours;
            emitter.emit(Op.STAT_HOURS, line, 0, [
              position.yearlyHoursWorked + vacationHours,
              vacationHours,
              ...position.vacationMonthlyWeights,
            ]);
          }
          break;
        }
        case "SPREAD": {
          switch (def.spreadMethod) {
            case "PERCENT_OF": {
              emitAccumulator(def, lineBase);
              emitter.emit(Op.PCT_OF_ACC, line, 0, [value?.rate ?? 0]);
              break;
            }
            case "WEIGHTED_BY_BASE": {
              emitAccumulator(def, lineBase);
              emitter.emit(Op.WEIGHT_BY_ACC, line, 0, [value?.yearlyValue ?? 0]);
              break;
            }
            case "FLAT_PER_ACTIVE_MONTH": {
              emitter.emit(Op.FLAT_ACTIVE, line, increaseFlag, [value?.yearlyValue ?? 0]);
              break;
            }
            case "QTY_TIMES_RATE": {
              emitter.emit(Op.FLAT_ACTIVE, line, increaseFlag, [
                (value?.qty ?? 0) * (value?.unitRate ?? 0),
              ]);
              break;
            }
            case "FLAT_PER_DAY": {
              emitter.emit(Op.FLAT_DAY, line, increaseFlag, [value?.yearlyValue ?? 0]);
              break;
            }
            case "DIRECT_MONTHLY": {
              const monthly = value?.monthlyValues ?? [];
              const params = new Array<number>(MONTHS);
              for (let m = 0; m < MONTHS; m++) params[m] = monthly[m] ?? 0;
              emitter.emit(Op.DIRECT, line, increaseFlag, params);
              break;
            }
            case "FLAT_MONTHLY": {
              // Per-month amount (yearlyValue slot) lowered to DIRECT with a
              // constant vector — DIRECT's seas/inc handling matches the spec.
              const amount = value?.yearlyValue ?? 0;
              emitter.emit(
                Op.DIRECT,
                line,
                increaseFlag,
                new Array<number>(MONTHS).fill(amount)
              );
              break;
            }
            case "VACATION_WEIGHTED": {
              // Yearly × normalized vacation weights precomputed per position,
              // lowered to DIRECT (which applies seasonality + increase).
              const yearly = value?.yearlyValue ?? 0;
              const weights = position.vacationMonthlyWeights;
              let weightTotal = 0;
              for (let m = 0; m < MONTHS; m++) weightTotal += weights[m];
              const params = new Array<number>(MONTHS).fill(0);
              if (yearly !== 0 && weightTotal !== 0) {
                for (let m = 0; m < MONTHS; m++) {
                  params[m] = yearly * weights[m] / weightTotal;
                }
              }
              emitter.emit(Op.DIRECT, line, increaseFlag, params);
              break;
            }
            case "DIRECT_ABS": {
              // Absolute pass-through for KPI-driven blocks: the loader has
              // already folded the KPI series × per-position multiplier into
              // monthlyValues, so emit them verbatim (no seasonality/increase).
              const monthly = value?.monthlyValues ?? [];
              const params = new Array<number>(MONTHS);
              for (let m = 0; m < MONTHS; m++) params[m] = monthly[m] ?? 0;
              emitter.emit(Op.DIRECT_ABS, line, 0, params);
              break;
            }
          }
          break;
        }
      }
    }
  }
  positionInstrStart[positionCount] = emitter.op.length;

  // ---- buyouts ----
  const buyoutAggRow = new Uint32Array(buyouts.length);
  const buyoutValues = new Float64Array(buyouts.length * MONTHS);
  for (let b = 0; b < buyouts.length; b++) {
    const row = buyouts[b];
    buyoutAggRow[b] = aggInterner.intern(`${row.departmentCode}|${row.accountCode}`, {
      dept: row.departmentCode,
      account: row.accountCode,
    });
    for (let m = 0; m < MONTHS; m++) {
      buyoutValues[b * MONTHS + m] = row.monthlyValues[m] ?? 0;
    }
  }

  const plan: CompiledPlan = {
    scenarioId: input.scenario.id,
    aggKeys: aggInterner.keys,
    statKeys: statInterner.keys,
    positionIds: positions.map((position) => position.id),
    positionIndex: new Map(positions.map((position, index) => [position.id as string, index])),
    componentDefs,
    lineCount: positionCount * defCount,
    lineAggRow,
    op: Uint8Array.from(emitter.op),
    outLine: Uint32Array.from(emitter.outLine),
    arg0: Uint32Array.from(emitter.arg0),
    paramOfs: Uint32Array.from(emitter.paramOfs),
    paramPool: Float64Array.from(emitter.paramPool),
    positionInstrStart,
    seasonality,
    daysPerMonth,
    realDays: Float64Array.from(input.calendar.realDays),
    holidayDays: Float64Array.from(input.calendar.holidayDays),
    posHeadcount,
    posFte,
    posWeight,
    positionStatRow,
    buyoutAggRow,
    buyoutValues,
  };
  return { plan };
}
