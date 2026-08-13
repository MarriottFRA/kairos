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
  bankHolidayCoefficient,
  BaseSelector,
  CALENDAR_SERIES_ARG,
  COMBINE_OPS,
  CompileError,
  ComponentDefId,
  ComponentValue,
  CostComponentDefinition,
  MONTHS,
  Position,
  PositionId,
  ScenarioId,
  ScenarioInput,
  SERVICE_MODE_ARG,
  serviceSeries,
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
  /** Per definition: 1 when the count × cluster-weight pass scales its line, 0
   *  when it is exempt (the HEADCOUNT stat, DIRECT_ABS lines, ratios). The
   *  compiled form of the predicates at the end of reference.referencePosition
   *  — resolved here so the VM never touches a CostComponentDefinition. */
  countScaled: Uint8Array;

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

/**
 * Every component id a base selector references, recursing through COMBINE.
 *
 * Validation, the topological sort and the delete guards all need the FULL ref
 * set — reading `selector.componentIds` directly would miss a compound's sides
 * and let a dangling ref or a cycle through.
 */
export function collectBaseRefIds(
  selector: BaseSelector | undefined,
  out: ComponentDefId[] = []
): ComponentDefId[] {
  if (!selector) return out;
  if (selector.kind === "COMBINE") {
    collectBaseRefIds(selector.left, out);
    collectBaseRefIds(selector.right, out);
    return out;
  }
  if (selector.kind === "COMPONENTS" || selector.kind === "SS_BASE") {
    for (const id of selector.componentIds) out.push(id);
  }
  return out;
}

/**
 * True when the selector needs a topo edge to the BASE_SALARY def.
 *
 * Everything except a pure COMPONENTS list gets one: BASE_SALARY and VACATION
 * read its scratch directly, SS_BASE reads its net line, and CALENDAR/SERVICE
 * are given one conservatively (they need no series, but BASE_SALARY is a
 * source node so the edge only pins ordering — kept to preserve the pre-COMBINE
 * emission order). A COMBINE inherits the need from either side.
 */
function selectorNeedsBaseSalary(selector: BaseSelector | undefined): boolean {
  if (!selector) return true; // default base = base salary
  if (selector.kind === "COMPONENTS") return false;
  if (selector.kind === "COMBINE") {
    return (
      selectorNeedsBaseSalary(selector.left) ||
      selectorNeedsBaseSalary(selector.right)
    );
  }
  return true;
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
    // The VM saves exactly one operand vector (Op.ACC_PUSH), so a compound may
    // not nest. The type is recursive so this cap can be lifted without
    // touching stored data — see BaseSelector.COMBINE.
    if (def.baseSelector?.kind === "COMBINE") {
      const { left, right } = def.baseSelector;
      if (left.kind === "COMBINE" || right.kind === "COMBINE") {
        errors.push({
          code: "INVALID_BASE_REF",
          message: `"${def.label}": a combined base cannot contain another combined base.`,
          refs: [def.id],
        });
      }
    }
    for (const refId of collectBaseRefIds(def.baseSelector)) {
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

  // Three named checks rather than a [name, vector] tuple array: that array,
  // plus its three inner tuples, was four allocations per position — 20k at 5k
  // positions, to validate something that is almost always fine.
  const checkVector = (position: Position, name: string, vector: number[]): void => {
    if (!Array.isArray(vector) || vector.length !== MONTHS) {
      errors.push({
        code: "INVALID_POSITION",
        message: `Position ${position.id}: ${name} must have ${MONTHS} entries.`,
        refs: [position.id],
      });
    }
  };

  for (const position of positions) {
    checkVector(position, "seasonality", position.seasonality);
    checkVector(position, "additionalMonthlyCosts", position.additionalMonthlyCosts);
    checkVector(position, "vacationMonthlyWeights", position.vacationMonthlyWeights);
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
    // SS_BASE reads the net base line and the vacation scratch, both produced
    // by BASE_SALARY; COMBINE inherits the need from whichever side wants it;
    // a bare BASE_SALARY/VACATION/absent selector wants it directly. Only a
    // pure COMPONENTS or CALENDAR selector needs no base edge.
    if (selectorNeedsBaseSalary(selector) && baseIndex >= 0 && baseIndex !== i) {
      dependsOn[i].push(baseIndex);
    }
    // Every referenced line, including both sides of a compound.
    for (const refId of collectBaseRefIds(selector)) {
      const refIndex = indexById.get(refId);
      if (refIndex !== undefined && refIndex !== i) dependsOn[i].push(refIndex);
    }
    // Block-valued rule multipliers: any line a position's rateDefId may pick
    // must be computed first. Dependency edges only — see ruleRateDefIds.
    for (const refId of def.ruleRateDefIds ?? []) {
      const refIndex = indexById.get(refId as string);
      if (refIndex !== undefined && refIndex !== i) dependsOn[i].push(refIndex);
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

/**
 * Instruction/param buffers used during emission.
 *
 * Plain `number[]` rather than typed arrays because the final sizes are not
 * known until the last instruction is emitted — but they ARE known after the
 * first pack of a given structure, and a plan is re-packed on every edit. So
 * the caller passes the previous run's sizes as capacity hints and the arrays
 * are allocated once at the right length instead of doubling their way there
 * (~2.7M pushes at 5k positions, each a bounds check plus an occasional realloc
 * and copy of the whole buffer).
 *
 * The hints are advisory in both directions: too small and it appends as
 * before, too large and the tail is trimmed. Getting one wrong costs
 * performance, never correctness.
 */
class Emitter {
  op: number[];
  outLine: number[];
  arg0: number[];
  paramOfs: number[];
  paramPool: number[];
  /** Write cursors — `length` on a pre-sized array is the capacity, not the
   *  number of instructions emitted, so the counts are tracked explicitly. */
  private n = 0;
  private p = 0;

  constructor(instructionHint = 0, paramHint = 0) {
    this.op = new Array<number>(instructionHint);
    this.outLine = new Array<number>(instructionHint);
    this.arg0 = new Array<number>(instructionHint);
    this.paramOfs = new Array<number>(instructionHint);
    this.paramPool = new Array<number>(paramHint);
  }

  /** Instructions emitted so far — what positionInstrStart records. */
  get length(): number {
    return this.n;
  }

  /** Cuts the buffers back to what was actually emitted, so an over-generous
   *  hint cannot leave `undefined` holes for TypedArray.from to read as NaN. */
  finish(): void {
    this.op.length = this.n;
    this.outLine.length = this.n;
    this.arg0.length = this.n;
    this.paramOfs.length = this.n;
    this.paramPool.length = this.p;
  }

  emit(op: number, outLine: number, arg0: number, params: number[]): void {
    const i = this.n++;
    this.op[i] = op;
    this.outLine[i] = outLine;
    this.arg0[i] = arg0;
    this.paramOfs[i] = this.p;
    for (const param of params) this.paramPool[this.p++] = param;
  }

  /**
   * Emits an instruction and reserves `count` param slots, returning the offset
   * to write them at — so a twelve-month vector goes straight into the pool
   * instead of through a throwaway array.
   *
   * `emit` stays for the small fixed-arity ops, where a `[rate]` literal reads
   * better than an offset and a pair of indexed writes. Used only where the
   * array was ≥ 12 long, or was being built with a spread or a `.fill()` — at
   * those sites this deletes the temporary AND reads more directly.
   *
   * The layout contract is unchanged: paramOfs[i] is instruction i's first
   * param, and paramOfs[i+1] − paramOfs[i] is its arity. Reserving before
   * writing preserves both, which is what emission.test asserts by slicing
   * paramPool between consecutive offsets.
   */
  emitInto(op: number, outLine: number, arg0: number, count: number): number {
    const i = this.n++;
    this.op[i] = op;
    this.outLine[i] = outLine;
    this.arg0[i] = arg0;
    const offset = this.p;
    this.paramOfs[i] = offset;
    // Zero-filled, not left holey: several callers write only the slots they
    // need (VACATION_WEIGHTED's "no spread" case) and rely on the rest reading 0.
    for (let k = 0; k < count; k++) this.paramPool[this.p++] = 0;
    return offset;
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

/** Interns strings to small integer ids. One per dimension (departments,
 *  accounts), so the pair interner below can key on two numbers. */
class StringInterner {
  private ids = new Map<string, number>();

  idOf(value: string): number {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = this.ids.size;
      this.ids.set(value, id);
    }
    return id;
  }
}

/**
 * Interns (dept, account) PAIRS to dense aggregate-row indices.
 *
 * Same contract as KeyInterner — `keys` stays insertion-ordered, and that order
 * is the row index every `lineAggRow` entry points at — but keyed on two
 * pre-interned integers instead of a `${dept}|${account}` template string. That
 * string, plus the `{dept, account}` object literal that had to be built even
 * when the interner HIT, was one allocation pair per line: 140k of each per
 * compile at 5k positions.
 *
 * Nested maps rather than a `deptId * K + acctId` composite deliberately. The
 * composite measured 0.07 ms faster over 140k lookups and needs a stride
 * constant that, if account cardinality ever exceeded it, would silently
 * collide — booking two different dept×account pairs onto one row. That is
 * money in the wrong account to save nothing.
 */
class AggRowInterner {
  keys: AggregateKey[] = [];
  private byDept = new Map<number, Map<number, number>>();

  intern(deptId: number, acctId: number, dept: string, account: string): number {
    let byAcct = this.byDept.get(deptId);
    if (byAcct === undefined) {
      byAcct = new Map();
      this.byDept.set(deptId, byAcct);
    }
    let row = byAcct.get(acctId);
    if (row === undefined) {
      row = this.keys.length;
      byAcct.set(acctId, row);
      this.keys.push({ dept, account }); // allocated on a MISS only
    }
    return row;
  }
}

/**
 * The half of a compiled plan that does NOT depend on any edited number.
 *
 * Validation, the topological order, the interned dept×account and cluster×job
 * dimensions, and which aggregate row each line books to — none of it moves
 * when a user retypes a salary. `packPlan` produces everything that does.
 *
 * Held across edits by the renderer (see shared/positions/liveSim), guarded by
 * `structureKey`. Treat every field as FROZEN once built: a plan produced by
 * packPlan aliases `aggKeys`, `statKeys`, `lineAggRow`, `positionStatRow` and
 * `countScaled` rather than copying them, so mutating one here would reach back
 * into every plan already handed out.
 */
export interface PlanStructure {
  componentDefs: CostComponentDefinition[];
  defCount: number;
  defIndexById: Map<string, number>;
  baseDefIndex: number;
  /** Position ids in the plan's canonical (sorted) order. */
  positionIds: PositionId[];
  positionIndex: Map<string, number>;
  positionCount: number;
  schemeById: Map<string, SocialSecurityScheme>;
  aggKeys: AggregateKey[];
  statKeys: StatKey[];
  lineAggRow: Uint32Array;
  positionStatRow: Uint32Array;
  countScaled: Uint8Array;
  buyoutAggRow: Uint32Array;
  buyoutCount: number;
  /**
   * What the last pack of this structure emitted, as capacity hints for the
   * next one.
   *
   * Mutated by packPlan — the one field here that is not frozen. Purely a
   * performance hint: the emitter grows past a low hint and trims a high one,
   * so a wrong value costs a reallocation and never a wrong number. The
   * instruction count can legitimately differ between packs of the SAME
   * structure, because whether a position is hourly picks between BASE_SALARY
   * and BASE_SALARY_HOURLY — same arity, but nothing here relies on that.
   */
  lastEmitSizes: { instructions: number; params: number };
}

export type StructureResult = { structure: PlanStructure } | { errors: CompileError[] };

/** Positions in the plan's canonical order: soft-deleted dropped, then sorted
 *  by id so the line matrix's layout never depends on query order. */
function planPositions(input: ScenarioInput): Position[] {
  return [...input.positions.filter((p) => p.deletedAt === null)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
}

/**
 * Phase A — everything that is a pure function of the plan's SHAPE.
 *
 * Split out so a value-only edit can reuse it (see structureKey and the cache in
 * shared/positions/liveSim). `compile` calls this and `packPlan` back to back,
 * and so does the cached path — there is exactly one code path that produces a
 * plan, which is what stops the fast route and the full route from drifting.
 */
export function compileStructure(input: ScenarioInput): StructureResult {
  const definitions = input.definitions.filter((def) => def.deletedAt === null);
  const positions = planPositions(input);
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

  const positionIndex = new Map<string, number>();
  for (let p = 0; p < positionCount; p++) positionIndex.set(positions[p].id as string, p);

  /**
   * Line → its per-row department / account override, for the lines that have
   * one.
   *
   * SPARSE on purpose. This phase needs nothing from a component value except
   * whether it redirects the line somewhere — and overrides are the exception,
   * not the rule (an "unlocked" block, or a MULTIPLIER in PER_ROW mode). The
   * dense P × D array packPlan builds would be a second 1.1 MB allocation and a
   * second full pass at 5k positions, to carry information almost every entry
   * does not have.
   *
   * Same two `undefined` guards as packPlan's index, and for the same reason: a
   * value can name a position or a definition that is not in the plan, and with
   * an index rather than a string key that would write at a WRONG line. Single
   * forward pass, so duplicates keep last-write-wins.
   */
  const overrideByLine = new Map<number, ComponentValue>();
  for (const value of input.componentValues) {
    if (value.deletedAt !== null) continue;
    if (value.departmentCode === undefined && value.accountCode === undefined) continue;
    const p = positionIndex.get(value.positionId as string);
    if (p === undefined) continue;
    const di = defIndexById.get(value.componentDefId as string);
    if (di === undefined) continue;
    overrideByLine.set(p * defCount + di, value);
  }

  // ---- interning ----
  const aggInterner = new AggRowInterner();
  const statInterner = new KeyInterner<StatKey>();
  const deptStrings = new StringInterner();
  const acctStrings = new StringInterner();

  // Each definition's account, and its FIXED department when it has one, as
  // interned ids — hoisted out of the position × definition loop, where they
  // were re-resolved P times each. `-1` means "this def does not pin a
  // department", which keeps the `departmentMode === "FIXED" && fixedDepartment`
  // second conjunct: a FIXED def with a blank department still falls through to
  // the position's own.
  /**
   * Which definitions the count × cluster-weight pass scales — 1 = scale.
   *
   * All three predicates are definition-derived, so resolving them once here
   * lets the VM's tail loop read a typed array instead of dereferencing a
   * CostComponentDefinition per position. That removes the LAST object access
   * from execute.ts, which is what makes its "one loop over typed arrays"
   * claim literally true and the plan genuinely worker-transferable.
   *
   * Compile time is the right moment, not execute time: injectKpiSeries
   * (shared/positions/engineInput) rewrites spreadMethod to DIRECT_ABS BEFORE
   * compile is called, so the answer is already final here.
   *
   * The predicates themselves live in reference.ts (the count × weight pass at
   * the end of referencePosition) — that is the spec, this is its compiled
   * form, and reference-parity is what proves the two agree.
   */
  const countScaled = new Uint8Array(defCount);
  for (let di = 0; di < defCount; di++) {
    const def = componentDefs[di];
    const exempt =
      (def.kind === "STAT" && def.statKind === "HEADCOUNT") ||
      def.spreadMethod === "DIRECT_ABS" ||
      def.countExempt === true;
    countScaled[di] = exempt ? 0 : 1;
  }

  const defAcctId = new Int32Array(defCount);
  const defAcct: string[] = new Array(defCount);
  const defFixedDeptId = new Int32Array(defCount);
  const defFixedDept: string[] = new Array(defCount);
  for (let di = 0; di < defCount; di++) {
    const def = componentDefs[di];
    defAcct[di] = def.accountCode;
    defAcctId[di] = acctStrings.idOf(def.accountCode);
    const fixed =
      def.departmentMode === "FIXED" && def.fixedDepartment ? def.fixedDepartment : null;
    defFixedDept[di] = fixed ?? "";
    defFixedDeptId[di] = fixed === null ? -1 : deptStrings.idOf(fixed);
  }

  const lineAggRow = new Uint32Array(positionCount * defCount);
  const positionStatRow = new Uint32Array(positionCount);

  // ---- the interned dimensions ----
  // One pass over (position, definition) resolving nothing but WHERE each line
  // books. Insertion order is the row index, so this traversal order — positions
  // by id, definitions in topological order, buyouts last — IS the contract that
  // compile.test's "interns aggregate keys in traversal order" pins.
  for (let p = 0; p < positionCount; p++) {
    const position = positions[p];
    positionStatRow[p] = statInterner.intern(
      `${position.cluster}|${position.jobTypeCode}`,
      { cluster: position.cluster, jobTypeCode: position.jobTypeCode }
    );
    // The position's own department, resolved once rather than once per
    // definition — most lines book to it.
    const posDept = position.departmentCode;
    const posDeptId = deptStrings.idOf(posDept);
    const lineBase = p * defCount;

    for (let di = 0; di < defCount; di++) {
      // Almost always undefined — see overrideByLine.
      const value = overrideByLine.size === 0 ? undefined : overrideByLine.get(lineBase + di);

      // Per-row department and account overrides (a MULTIPLIER block in
      // PER_ROW mode, an "unlocked" block): the aggregation key is interned at
      // compile time, so an override is purely a key change — the VM and every
      // line value are untouched, and nothing is added to the hot loop.
      // A stored departmentCode only reaches here for a block actually in
      // PER_ROW mode (engineInput.resolveBlockValues drops it otherwise), so
      // switching the block back makes every line book to the fallback again.
      //
      // The `!= null` tests are the old `??` chain, kept exactly: an override of
      // "" is a value and WINS, where a truthiness test would let it fall
      // through to the definition. In the common case (no override) this is two
      // array reads and no string work at all.
      let dept: string;
      let deptId: number;
      const deptOverride = value?.departmentCode;
      if (deptOverride != null) {
        dept = deptOverride;
        deptId = deptStrings.idOf(deptOverride);
      } else if (defFixedDeptId[di] >= 0) {
        dept = defFixedDept[di];
        deptId = defFixedDeptId[di];
      } else {
        dept = posDept;
        deptId = posDeptId;
      }

      let account: string;
      let acctId: number;
      const acctOverride = value?.accountCode;
      if (acctOverride != null) {
        account = acctOverride;
        acctId = acctStrings.idOf(acctOverride);
      } else {
        account = defAcct[di];
        acctId = defAcctId[di];
      }

      lineAggRow[lineBase + di] = aggInterner.intern(deptId, acctId, dept, account);
    }
  }

  // Buyouts intern LAST, so a buyout-only dept×account pair lands at the end of
  // aggKeys exactly where it always did.
  const buyoutAggRow = new Uint32Array(buyouts.length);
  for (let b = 0; b < buyouts.length; b++) {
    const row = buyouts[b];
    buyoutAggRow[b] = aggInterner.intern(
      deptStrings.idOf(row.departmentCode),
      acctStrings.idOf(row.accountCode),
      row.departmentCode,
      row.accountCode
    );
  }

  return {
    structure: {
      componentDefs,
      defCount,
      defIndexById,
      baseDefIndex,
      positionIds: positions.map((position) => position.id),
      positionIndex,
      positionCount,
      schemeById,
      aggKeys: aggInterner.keys,
      statKeys: statInterner.keys,
      lineAggRow,
      positionStatRow,
      countScaled,
      buyoutAggRow,
      buyoutCount: buyouts.length,
      lastEmitSizes: { instructions: 0, params: 0 },
    },
  };
}

/**
 * Phase B — everything that DOES depend on the edited numbers.
 *
 * The single writer of `paramPool` and of every packed per-position array. Both
 * the full compile and the cached fast path call this and nothing else, so the
 * two cannot compute a different number: there is one copy of the arithmetic.
 *
 * `structure` must have been built from an input with the same SHAPE — same
 * definitions, same position ids in the same order, same departments, clusters,
 * job types and per-row overrides. `structureKey` is what decides that, and in
 * dev `assertRepackable` re-derives the whole structure and compares.
 */
export function packPlan(input: ScenarioInput, structure: PlanStructure): CompiledPlan {
  const {
    componentDefs,
    defCount,
    defIndexById,
    baseDefIndex,
    positionIndex,
    positionCount,
    schemeById,
  } = structure;
  const positions = planPositions(input);
  const buyouts = input.buyouts.filter((row) => row.deletedAt === null);

  // Values, dense by line — see the note in compileStructure. Rebuilt here
  // rather than carried on the structure: these ARE the edited numbers.
  const cellValue = new Array<ComponentValue | undefined>(positionCount * defCount).fill(
    undefined
  );
  for (const value of input.componentValues) {
    if (value.deletedAt !== null) continue;
    const p = positionIndex.get(value.positionId as string);
    if (p === undefined) continue;
    const di = defIndexById.get(value.componentDefId as string);
    if (di === undefined) continue;
    cellValue[p * defCount + di] = value;
  }

  // ---- packed inputs ----
  const seasonality = new Float64Array(positionCount * MONTHS);
  const daysPerMonth = new Float64Array(positionCount * MONTHS);
  const posHeadcount = new Float64Array(positionCount);
  const posFte = new Float64Array(positionCount);
  const posWeight = new Float64Array(positionCount);

  // Sized from the previous pack of this same structure — see lastEmitSizes.
  const emitter = new Emitter(
    structure.lastEmitSizes.instructions,
    structure.lastEmitSizes.params
  );
  const positionInstrStart = new Uint32Array(positionCount + 1);

  /** Emits ACC_CLEAR + ACC_ADD_* ops realizing a base selector for position p.
   *  `position` is that position — SERVICE folds its per-position series into
   *  params here, the way the STAT ops fold headcount/FTE/hours. */
  const emitSelector = (
    selector: BaseSelector | undefined,
    lineBase: number,
    position: Position
  ): void => {
    if (selector?.kind === "COMBINE") {
      // Depth-1 (validated): build the LEFT operand in the accumulator, park it
      // in acc2, then build the right one the same way. Nothing new is needed
      // for the operands themselves — every ACC_ADD_* op is reused as-is, each
      // recursion emitting its own ACC_CLEAR.
      emitSelector(selector.left, lineBase, position);
      emitter.emit(Op.ACC_PUSH, LINE_NONE, 0, []);
      emitSelector(selector.right, lineBase, position);
      return;
    }
    emitter.emit(Op.ACC_CLEAR, LINE_NONE, 0, []);
    if (!selector || selector.kind === "BASE_SALARY") {
      emitter.emit(Op.ACC_ADD_GROSS, LINE_NONE, 0, []);
      return;
    }
    if (selector.kind === "CALENDAR") {
      emitter.emit(
        Op.ACC_ADD_DAYS,
        LINE_NONE,
        CALENDAR_SERIES_ARG[selector.series] ?? 0,
        []
      );
      return;
    }
    if (selector.kind === "SERVICE") {
      // Length of service, in calendar days since the hiring date. The loaders
      // already resolved the date into per-month counts, so the whole series is
      // a per-position constant — resolve MONTH vs TOTAL here and hand the VM
      // twelve numbers to add. arg0 carries the mode for the disassembler only.
      emitter.emit(
        Op.ACC_ADD_SERVICE,
        LINE_NONE,
        SERVICE_MODE_ARG[selector.mode] ?? 0,
        serviceSeries(position, selector.mode)
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

  const emitAccumulator = (
    def: CostComponentDefinition,
    lineBase: number,
    position: Position
  ): void => emitSelector(def.baseSelector, lineBase, position);

  for (let p = 0; p < positionCount; p++) {
    const position = positions[p];
    positionInstrStart[p] = emitter.length;

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

    const lineBase = p * defCount;

    emitter.emit(Op.DERIVE, LINE_NONE, 0, [
      position.meritIncreasePct,
      position.manualYearlyIncrease,
      position.increaseMonth,
    ]);

    for (let di = 0; di < defCount; di++) {
      const def = componentDefs[di];
      const line = lineBase + di;
      const value = cellValue[line];

      // NOTE: where this line BOOKS (its aggregate row, including any per-row
      // department or account override) was resolved in compileStructure — it
      // does not depend on any edited number, which is exactly why this phase
      // can be re-run on its own.

      const increaseFlag = def.increaseAware ? FLAG_INCREASE_AWARE : 0;

      switch (def.kind) {
        case "BASE_SALARY": {
          // Hourly-rate positions derive the base from rate × contract hours,
          // spread over realDays (net productive days); the coefficient is
          // pre-multiplied here so the VM mirrors the reference bit-for-bit.
          // Presence of hourlyRate is the discriminator — the two salary inputs
          // are mutually exclusive (enforced in the grid), so hourlyRate wins.
          const baseOp = position.hourlyRate > 0 ? Op.BASE_SALARY_HOURLY : Op.BASE_SALARY;
          const baseAt = emitter.emitInto(baseOp, line, 0, 1 + MONTHS);
          emitter.paramPool[baseAt] =
            position.hourlyRate > 0
              ? position.hourlyRate * position.dailyContractHours
              : position.monthlyBaseSalary;
          for (let m = 0; m < MONTHS; m++) {
            emitter.paramPool[baseAt + 1 + m] = position.additionalMonthlyCosts[m];
          }

          const vacAt = emitter.emitInto(Op.VACATION, LINE_NONE, 0, 1 + MONTHS);
          emitter.paramPool[vacAt] = position.vacationDays;
          for (let m = 0; m < MONTHS; m++) {
            emitter.paramPool[vacAt + 1 + m] = position.vacationMonthlyWeights[m];
          }

          emitter.emit(Op.BASE_DEDUCT, line, 0, []);
          break;
        }
        case "HOLIDAY_ACCRUAL": {
          emitter.emit(Op.ACCRUAL, line, 0, [position.accrualDaysPerMonth]);
          break;
        }
        case "BANK_HOLIDAY": {
          // Every knob — coverage (hotel-wide or the position's department),
          // pay rate, who it applies to, whether the day is paid regardless —
          // folds into one coefficient here, shared with reference.ts. An
          // ineligible position gets 0, so the line is a branchless zero.
          const combinedMult = bankHolidayCoefficient(def, position);
          emitter.emit(Op.BANK_HOLIDAY, line, increaseFlag, [combinedMult]);
          break;
        }
        case "SOCIAL_SECURITY": {
          const scheme = schemeById.get(def.ssSchemeId as string)!;
          emitAccumulator(def, lineBase, position);
          // Always 6 scalars + SS_MAX_BRACKETS × (upTo, rate) — the bracket
          // table is PADDED to a fixed width so every SOCIAL_SEC instruction has
          // the same arity whatever the scheme.
          const ssAt = emitter.emitInto(Op.SOCIAL_SEC, line, 0, 6 + 2 * SS_MAX_BRACKETS);
          const pool = emitter.paramPool;
          pool[ssAt] = scheme.monthlyCap ?? Infinity;
          pool[ssAt + 1] = scheme.yearlyCap ?? Infinity;
          pool[ssAt + 2] = scheme.brackets.length;
          // 2c: accumulation mode + tax-year reset + prior-year opening base.
          // Defaults (CUMULATIVE, month 1, opening 0) reproduce the pre-2c run.
          pool[ssAt + 3] = scheme.accumulationMode === "PER_PERIOD" ? 1 : 0;
          pool[ssAt + 4] = scheme.taxYearStartMonth ?? 1;
          pool[ssAt + 5] = value?.ssOpeningBase ?? 0;
          for (let b = 0; b < SS_MAX_BRACKETS; b++) {
            const bracket = scheme.brackets[b];
            pool[ssAt + 6 + 2 * b] = bracket ? bracket.upTo ?? Infinity : Infinity;
            pool[ssAt + 7 + 2 * b] = bracket ? bracket.rate : 0;
          }
          break;
        }
        case "STAT": {
          if (def.statKind === "HEADCOUNT") {
            emitter.emit(Op.STAT_HC, line, 0, [position.headcount]);
          } else if (def.statKind === "FTE") {
            emitter.emit(Op.STAT_FTE, line, 0, [position.fte]);
          } else if (def.statKind === "HOURS_PAID") {
            // Worked + vacation, spread by days and NOT taken back out — so it
            // needs no weights. See reference.hoursPaid.
            emitter.emit(Op.STAT_HOURS_PAID, line, 0, [
              position.yearlyHoursWorked +
                position.vacationDays * position.dailyContractHours,
            ]);
          } else {
            const vacationHours = position.vacationDays * position.dailyContractHours;
            const hoursAt = emitter.emitInto(Op.STAT_HOURS, line, 0, 2 + MONTHS);
            emitter.paramPool[hoursAt] = position.yearlyHoursWorked + vacationHours;
            emitter.paramPool[hoursAt + 1] = vacationHours;
            for (let m = 0; m < MONTHS; m++) {
              emitter.paramPool[hoursAt + 2 + m] = position.vacationMonthlyWeights[m];
            }
          }
          break;
        }
        case "SPREAD": {
          switch (def.spreadMethod) {
            case "PERCENT_OF": {
              emitAccumulator(def, lineBase, position);
              if (def.baseSelector?.kind === "COMBINE") {
                // The accumulator pair now holds (left, right); COMBINE_ACC
                // applies the operation and the rate in one go. A pinned
                // selector rate wins over the per-row value (see the type).
                emitter.emit(Op.COMBINE_ACC, line, 0, [
                  def.baseSelector.rate ?? value?.rate ?? 0,
                  COMBINE_OPS.indexOf(def.baseSelector.op),
                ]);
              } else if (
                value?.rateDefId &&
                defIndexById.get(value.rateDefId) !== undefined
              ) {
                // Block-valued multiplier (see ComponentValue.rateDefId):
                // line = base × that line, built from the existing compound
                // machinery — park the base in acc2, load the rate line into
                // acc, multiply with a pinned rate of 1. The topo sort already
                // ordered the rate line first (ruleRateDefIds).
                emitter.emit(Op.ACC_PUSH, LINE_NONE, 0, []);
                emitter.emit(Op.ACC_CLEAR, LINE_NONE, 0, []);
                emitter.emit(
                  Op.ACC_ADD_LINE,
                  LINE_NONE,
                  lineBase + defIndexById.get(value.rateDefId)!,
                  []
                );
                emitter.emit(Op.COMBINE_ACC, line, 0, [1, COMBINE_OPS.indexOf("MUL")]);
              } else if (value?.rateDefId) {
                // The referenced definition no longer exists — a zero series,
                // exactly what reference.ts computes for the same input.
                emitter.emit(Op.PCT_OF_ACC, line, 0, [0]);
              } else if (value?.monthlyRates) {
                // Month-varying rate (see ComponentValue.monthlyRates) — the
                // twelve rates fold into params, the VM just multiplies.
                const rates = value.monthlyRates;
                const ofs = emitter.emitInto(Op.PCT_OF_ACC_M, line, 0, MONTHS);
                for (let m = 0; m < MONTHS; m++) {
                  emitter.paramPool[ofs + m] = rates[m] ?? 0;
                }
              } else {
                emitter.emit(Op.PCT_OF_ACC, line, 0, [value?.rate ?? 0]);
              }
              break;
            }
            case "WEIGHTED_BY_BASE": {
              emitAccumulator(def, lineBase, position);
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
              const at = emitter.emitInto(Op.DIRECT, line, increaseFlag, MONTHS);
              for (let m = 0; m < MONTHS; m++) emitter.paramPool[at + m] = monthly[m] ?? 0;
              break;
            }
            case "FLAT_MONTHLY": {
              // Per-month amount (yearlyValue slot) lowered to DIRECT with a
              // constant vector — DIRECT's seas/inc handling matches the spec.
              const amount = value?.yearlyValue ?? 0;
              const at = emitter.emitInto(Op.DIRECT, line, increaseFlag, MONTHS);
              for (let m = 0; m < MONTHS; m++) emitter.paramPool[at + m] = amount;
              break;
            }
            case "VACATION_WEIGHTED": {
              // Yearly × normalized vacation weights precomputed per position,
              // lowered to DIRECT (which applies seasonality + increase).
              const yearly = value?.yearlyValue ?? 0;
              const weights = position.vacationMonthlyWeights;
              let weightTotal = 0;
              for (let m = 0; m < MONTHS; m++) weightTotal += weights[m];
              const at = emitter.emitInto(Op.DIRECT, line, increaseFlag, MONTHS);
              // emitInto zero-fills, so the "no spread" case needs no else.
              if (yearly !== 0 && weightTotal !== 0) {
                for (let m = 0; m < MONTHS; m++) {
                  emitter.paramPool[at + m] = yearly * weights[m] / weightTotal;
                }
              }
              break;
            }
            case "DIRECT_ABS": {
              // Absolute pass-through for KPI-driven blocks: the loader has
              // already folded the KPI series × per-position multiplier into
              // monthlyValues, so emit them verbatim (no seasonality/increase).
              const monthly = value?.monthlyValues ?? [];
              const at = emitter.emitInto(Op.DIRECT_ABS, line, 0, MONTHS);
              for (let m = 0; m < MONTHS; m++) emitter.paramPool[at + m] = monthly[m] ?? 0;
              break;
            }
          }
          break;
        }
      }
    }
  }
  positionInstrStart[positionCount] = emitter.length;
  emitter.finish();
  structure.lastEmitSizes.instructions = emitter.op.length;
  structure.lastEmitSizes.params = emitter.paramPool.length;

  // ---- buyouts ----
  // Their aggregate rows were interned by compileStructure; only the amounts
  // are value-side.
  const buyoutValues = new Float64Array(buyouts.length * MONTHS);
  for (let b = 0; b < buyouts.length; b++) {
    const row = buyouts[b];
    for (let m = 0; m < MONTHS; m++) {
      buyoutValues[b * MONTHS + m] = row.monthlyValues[m] ?? 0;
    }
  }

  // The dimension arrays are ALIASED from the structure, not copied — they are
  // identical for every plan built on it, and copying 560 KB of lineAggRow per
  // repack would give back much of what the cache saves. Nothing mutates them
  // after compileStructure returns.
  const plan: CompiledPlan = {
    scenarioId: input.scenario.id,
    aggKeys: structure.aggKeys,
    statKeys: structure.statKeys,
    positionIds: structure.positionIds,
    positionIndex,
    componentDefs,
    countScaled: structure.countScaled,
    lineCount: positionCount * defCount,
    lineAggRow: structure.lineAggRow,
    // `TypedArray.from(number[])` looks like the slow path and is not: V8 has a
    // fast path for it over a packed array, while `new Float64Array(arr)` takes
    // the generic array-like constructor. Measured on V8 24.6, 1M doubles:
    // .from 0.93 ms vs constructor 3.51 ms; 375k smis: .from 0.22 ms vs 1.18 ms.
    // Switching these to `new` is a ~3 ms REGRESSION at 5k positions. Left here
    // so the next reader doesn't "fix" it.
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
    positionStatRow: structure.positionStatRow,
    buyoutAggRow: structure.buyoutAggRow,
    buyoutValues,
  };
  return plan;
}

/**
 * Compile a scenario into an executable plan.
 *
 * The two phases back to back. Callers that hold a cached structure call
 * `compileStructure` once and `packPlan` per edit instead — same functions,
 * same order, so a cached plan and a freshly compiled one are bit-identical by
 * construction rather than by agreement. `__tests__/repackParity.test.ts` holds
 * that claim to fuzzed edits.
 */
export function compile(input: ScenarioInput): CompileResult {
  const built = compileStructure(input);
  if ("errors" in built) return { errors: built.errors };
  return { plan: packPlan(input, built.structure) };
}
