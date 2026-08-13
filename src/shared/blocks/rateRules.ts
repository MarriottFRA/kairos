/**
 * Rate rules — user-defined if/then logic for the MULTIPLIER block.
 * -----------------------------------------------------------
 * An ordered list of `IF <terms> THEN <multiplier>` rules plus an `otherwise`
 * multiplier; the first rule whose terms ALL hold wins (OR is expressed by
 * adding another rule). A term compares one source — a field-catalog key, an
 * engine scalar, a KPI series, or the position's length of service — against
 * a constant. A rule's multiplier is either a typed number or ANOTHER BLOCK's
 * monthly value (`rateBlockId` — "pay the base × whatever block X computes").
 *
 * Evaluation happens OUTSIDE the engine, at engine-input build time in both
 * loaders (applyRateRules in engineInput.ts), and produces the per-position
 * multiplier the block's PERCENT_OF def applies to its base:
 *
 *   - constant per position     → ComponentValue.rate        (Op.PCT_OF_ACC)
 *   - flips inside the year     → ComponentValue.monthlyRates (Op.PCT_OF_ACC_M)
 *   - another block's value     → ComponentValue.rateDefId   (base × that line,
 *     emitted with the existing ACC_PUSH/COMBINE_ACC pair — see compile.ts)
 *
 * Only DAYS_IN_POSITION and KPI terms can flip inside the year. A config that
 * mixes month-varying terms WITH block outputs cannot be represented (the
 * engine value carries either twelve numbers or one line reference, never a
 * per-month choice of line), so validation rejects it and `normalizeRateRules`
 * strips the block outputs from any such config that arrives sideways — the
 * two loaders normalize identically, so budgets cannot diverge.
 *
 * PERFORMANCE CONTRACT: rules are structured data, not a text formula — there
 * is nothing to parse. `bindRateRules` runs ONCE per block per recalc and does
 * every string trim / number coercion / date parse / KPI-series fetch of the
 * CONSTANTS there; the per-position hot path is property reads and
 * comparisons, zero allocation (the one exception: the cumulative service
 * vector, built once per position only when a month-varying term exists).
 *
 * WHAT A TERM MAY REFERENCE, and why:
 *   - POSITION_EXTRA catalog fields (system or user u_* columns): both loaders
 *     have the extra-values bag in hand.
 *   - PII_CORE / PII_EXTRA catalog fields: the live row carries them, and the
 *     main loader merges them into the rules bag (applyRateRules callers).
 *     Only the DERIVED NUMBER ever reaches the engine — ScenarioInput stays
 *     PII-free, the same discipline as hiring dates → service days.
 *   - The ENGINE scalars in RATE_RULE_ENGINE_FIELDS: present verbatim on the
 *     subject in BOTH loaders. `cluster` is deliberately absent — the row
 *     stores the cluster ID while Position carries the resolved display name,
 *     a parity trap not worth spending on.
 *   - KPI: the driver's cached series (EXPLICIT '*' first, else the
 *     position's own department) — resolved at bind time from the same source
 *     both loaders already use for KPI bases. Month-varying.
 *   - DAYS_IN_POSITION: cumulative calendar service days at the END of each
 *     month (serviceDaysOpening + running perMonth sum) — the serviceDays.ts
 *     contract, so no hiring date reads as zero service. Month-varying.
 *   - COMPUTED fields are rejected at save: they exist only in the renderer.
 *   - Another block's COMPUTED VALUE cannot be a condition source (only a
 *     multiplier output): the value does not exist until the engine runs.
 *
 * BLANK SEMANTICS: a value that is missing, empty, or uncoercible for the
 * term's data type reads as blank — IS_BLANK matches, every other operator
 * fails. This is also the (deliberate) behavior when a referenced field has
 * been deleted from the catalog or a KPI has no series.
 *
 * TEXT ORDERING (GT/GTE/LT/LTE on text): when BOTH sides coerce to finite
 * numbers the comparison is numeric ("9" < "10"); otherwise it is
 * case-insensitive CODEPOINT order — deliberately not localeCompare, whose
 * answer varies by machine locale and would let two machines compute
 * different budgets from the same plan.
 */

import { MONTHS } from "../engine/types";
import { KPI_EXPLICIT_DEPT_KEY } from "../kpiDrivers/ipc";
import type { FieldDataType } from "../positions/fields";
import { parseIsoDayUtc } from "../positions/serviceDays";

// ---------------------------------------------------------------------------
// Config shape (persisted inside the block's config JSON blob)
// ---------------------------------------------------------------------------

export type RateRuleOperator =
  | "EQ"
  | "NEQ"
  | "IN"
  | "GT"
  | "GTE"
  | "LT"
  | "LTE"
  | "IS_BLANK"
  | "NOT_BLANK";

export type RateRuleSource =
  | {
      kind: "FIELD";
      /** Field-catalog key (POSITION_EXTRA / PII_*) or a RATE_RULE_ENGINE_FIELDS key. */
      fieldKey: string;
      /**
       * The field's data type, denormalized at save time so evaluation needs
       * no catalog. Safe because a field's type is fixed at creation; the
       * repo re-checks it against the catalog on every save.
       */
      dataType: FieldDataType;
    }
  | { kind: "DAYS_IN_POSITION" }
  | { kind: "KPI"; kpiDriverId: string };

export interface RateRuleTerm {
  source: RateRuleSource;
  op: RateRuleOperator;
  /**
   * The comparison constant: string for TEXT/ENUM/ACCOUNT_CODE/DATE
   * ("YYYY-MM-DD"), number for numeric types, KPI and DAYS_IN_POSITION,
   * boolean for BOOLEAN, an array for IN. Absent for IS_BLANK / NOT_BLANK.
   */
  value?: string | number | boolean | Array<string | number>;
}

/** Terms are AND-combined: every one must hold for the rule to match. */
export interface RateRule {
  when: RateRuleTerm[];
  /** The typed multiplier — ignored when `rateBlockId` is set. */
  rate: number;
  /** Use this block's monthly value as the multiplier instead of `rate`. */
  rateBlockId?: string;
}

/** First matching rule wins; no match falls through to `otherwise`. */
export interface RateRulesConfig {
  rules: RateRule[];
  otherwise: number;
  /** Like RateRule.rateBlockId, for the fall-through. */
  otherwiseBlockId?: string;
}

// ---------------------------------------------------------------------------
// Operator + source tables (shared by the dialog and validateInput)
// ---------------------------------------------------------------------------

const TEXT_OPS: readonly RateRuleOperator[] = [
  "EQ", "NEQ", "IN", "GT", "GTE", "LT", "LTE", "IS_BLANK", "NOT_BLANK",
];
const NUMERIC_OPS: readonly RateRuleOperator[] = [
  "EQ", "NEQ", "GT", "GTE", "LT", "LTE", "IS_BLANK", "NOT_BLANK",
];
const DATE_OPS: readonly RateRuleOperator[] = [
  "EQ", "GT", "GTE", "LT", "LTE", "IS_BLANK", "NOT_BLANK",
];

/** Legal operators per data type. DAYS_IN_POSITION and KPI are keyed
 *  separately — always numbers; days can never be blank (no hiring date =
 *  zero days), a KPI with no series simply never matches. */
export const RATE_RULE_OPERATORS: Readonly<
  Record<FieldDataType | "DAYS_IN_POSITION" | "KPI", readonly RateRuleOperator[]>
> = {
  TEXT: TEXT_OPS,
  ENUM: TEXT_OPS,
  ACCOUNT_CODE: TEXT_OPS,
  NUMBER: NUMERIC_OPS,
  INTEGER: NUMERIC_OPS,
  PERCENT: NUMERIC_OPS,
  DATE: DATE_OPS,
  BOOLEAN: ["EQ", "IS_BLANK", "NOT_BLANK"],
  DAYS_IN_POSITION: ["EQ", "GT", "GTE", "LT", "LTE"],
  KPI: ["EQ", "NEQ", "GT", "GTE", "LT", "LTE"],
};

/** The operator-table key for a term's source. */
export function ruleSourceType(
  source: RateRuleSource
): FieldDataType | "DAYS_IN_POSITION" | "KPI" {
  if (source.kind === "FIELD") return source.dataType;
  return source.kind;
}

/** Operators that carry no comparison constant. */
export function operatorNeedsValue(op: RateRuleOperator): boolean {
  return op !== "IS_BLANK" && op !== "NOT_BLANK";
}

/**
 * The engine scalars a term may reference besides catalog fields — the string
 * dimensions present verbatim on the subject in BOTH loaders. Deliberately a
 * closed list; see the header for why `cluster` is not on it.
 */
export const RATE_RULE_ENGINE_FIELDS: ReadonlyArray<{
  key: string;
  label: string;
  dataType: FieldDataType;
}> = [
  { key: "departmentCode", label: "Department code", dataType: "TEXT" },
  { key: "jobTypeCode", label: "Job type", dataType: "TEXT" },
  { key: "payType", label: "Pay type", dataType: "TEXT" },
];

export const RATE_RULE_ENGINE_KEYS: ReadonlySet<string> = new Set(
  RATE_RULE_ENGINE_FIELDS.map((field) => field.key)
);

/** Every FIELD key a config references (validation, delete guards, UI chips). */
export function rateRulesFieldKeys(config: RateRulesConfig): string[] {
  const keys = new Set<string>();
  for (const rule of config.rules) {
    for (const term of rule.when) {
      if (term.source.kind === "FIELD") keys.add(term.source.fieldKey);
    }
  }
  return [...keys];
}

/** Every BLOCK id a config uses as a multiplier output (cycle walk, delete
 *  guard, dependency injection). */
export function rateRulesBlockIds(config: RateRulesConfig): string[] {
  const ids = new Set<string>();
  for (const rule of config.rules) {
    if (rule.rateBlockId) ids.add(rule.rateBlockId);
  }
  if (config.otherwiseBlockId) ids.add(config.otherwiseBlockId);
  return [...ids];
}

/** True when any term can flip inside the year (DAYS_IN_POSITION or KPI) —
 *  the sources that force the monthly opcode. */
export function rateRulesMonthVarying(config: RateRulesConfig): boolean {
  return config.rules.some((rule) =>
    rule.when.some(
      (term) => term.source.kind === "DAYS_IN_POSITION" || term.source.kind === "KPI"
    )
  );
}

/** True when any outcome is a block reference. Mutually exclusive with
 *  month-varying terms — see the header. */
export function rateRulesHaveBlockOutputs(config: RateRulesConfig): boolean {
  return rateRulesBlockIds(config).length > 0;
}

// ---------------------------------------------------------------------------
// Evaluation subject — what a loader hands over per position
// ---------------------------------------------------------------------------

export interface RateRuleSubject {
  /** The merged extra-values (+ PII) bag (main loader) or the flat grid row
   *  (live sim) — FIELD terms for catalog keys read `bag[fieldKey]`. */
  bag: Record<string, unknown>;
  /** ENGINE keys read these explicit scalars, NEVER the bag, so the two
   *  loaders cannot drift on where a dimension lives. KPI terms also resolve
   *  their POSITION-mode series by departmentCode. */
  departmentCode?: string;
  jobTypeCode?: string;
  payType?: string;
  /** Length of service (serviceDaysFor output); absent = zero service. */
  serviceDaysPerMonth?: number[];
  serviceDaysOpening?: number;
}

export type RateRuleResult =
  | { rate: number }
  | { monthlyRates: number[] }
  | { rateBlockId: string };

/** One resolved KPI series (structurally KpiSeriesSlice — typed locally so
 *  this module never imports engineInput, which imports it back). */
export interface RateRuleKpiSlice {
  deptKey: string;
  values: number[];
}

/** How bindRateRules reaches KPI series. Absent (or returning []) reads every
 *  KPI term as blank — the loaders always supply it; only ad-hoc callers
 *  (tests, the grid display helper) may run without KPI data. */
export interface RateRuleBindContext {
  kpiSeries?: (driverId: string) => RateRuleKpiSlice[];
}

// ---------------------------------------------------------------------------
// Bind once per block per recalc, evaluate per position
// ---------------------------------------------------------------------------

/** cum = cumulative service days at end-of-month, built lazily per subject. */
type BoundTerm = (subject: RateRuleSubject, cum: number[] | null, month: number) => boolean;

type RuleOutcome = { rate: number } | { rateBlockId: string };

export interface BoundRateRules {
  monthVarying: boolean;
  rules: Array<{ terms: BoundTerm[]; outcome: RuleOutcome }>;
  otherwise: RuleOutcome;
}

function isBlankRaw(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
}

/** Trimmed, case-insensitive string form — the accountAllowed discipline. */
function normText(raw: unknown): string {
  return String(raw).trim().toLowerCase();
}

/** Boolean coercion: true/false, 1/0 and "true"/"false" cells all count. */
function readBool(raw: unknown): boolean | null {
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  if (typeof raw === "string") {
    const norm = raw.trim().toLowerCase();
    if (norm === "true") return true;
    if (norm === "false") return false;
  }
  return null;
}

function readFieldRaw(subject: RateRuleSubject, key: string): unknown {
  switch (key) {
    case "departmentCode":
      return subject.departmentCode;
    case "jobTypeCode":
      return subject.jobTypeCode;
    case "payType":
      return subject.payType;
    default:
      return subject.bag[key];
  }
}

function compareNumbers(actual: number, op: RateRuleOperator, expected: number): boolean {
  switch (op) {
    case "EQ":
      return actual === expected;
    case "NEQ":
      return actual !== expected;
    case "GT":
      return actual > expected;
    case "GTE":
      return actual >= expected;
    case "LT":
      return actual < expected;
    case "LTE":
      return actual <= expected;
    default:
      return false;
  }
}

/** Text ordering: numeric when both sides are numbers, else case-insensitive
 *  codepoint order (NOT localeCompare — see the header). */
function compareText(actual: string, op: RateRuleOperator, expected: string): boolean {
  const actualNum = Number(actual);
  const expectedNum = Number(expected);
  if (
    actual.trim() !== "" &&
    expected.trim() !== "" &&
    Number.isFinite(actualNum) &&
    Number.isFinite(expectedNum)
  ) {
    return compareNumbers(actualNum, op, expectedNum);
  }
  const cmp = actual < expected ? -1 : actual > expected ? 1 : 0;
  return compareNumbers(cmp, op, 0);
}

function bindTerm(term: RateRuleTerm, ctx: RateRuleBindContext): BoundTerm {
  const { op } = term;

  if (term.source.kind === "DAYS_IN_POSITION") {
    const expected = typeof term.value === "number" ? term.value : Number(term.value);
    return (_subject, cum, month) =>
      compareNumbers(cum ? cum[month] : 0, op, expected);
  }

  if (term.source.kind === "KPI") {
    // Series fetched ONCE at bind — the per-position closure is two map reads
    // and a compare. EXPLICIT drivers publish one '*' series; POSITION-mode
    // drivers one per department (the injectKpiSeries resolution order).
    const expected = typeof term.value === "number" ? term.value : Number(term.value);
    const slices = ctx.kpiSeries?.(term.source.kpiDriverId) ?? [];
    const byDept = new Map<string, number[]>();
    for (const slice of slices) byDept.set(slice.deptKey, slice.values);
    const explicit = byDept.get(KPI_EXPLICIT_DEPT_KEY);
    return (subject, _cum, month) => {
      const series = explicit ?? byDept.get(subject.departmentCode ?? "");
      if (!series) return false; // no data reads as blank — never matches
      return compareNumbers(series[month] ?? 0, op, expected);
    };
  }

  const key = term.source.fieldKey;

  if (op === "IS_BLANK" || op === "NOT_BLANK") {
    const wantBlank = op === "IS_BLANK";
    return (subject) => isBlankRaw(readFieldRaw(subject, key)) === wantBlank;
  }

  switch (term.source.dataType) {
    case "NUMBER":
    case "INTEGER":
    case "PERCENT": {
      const expected = Number(term.value);
      return (subject) => {
        const raw = readFieldRaw(subject, key);
        if (isBlankRaw(raw)) return false;
        const actual = Number(raw);
        if (!Number.isFinite(actual)) return false;
        return compareNumbers(actual, op, expected);
      };
    }
    case "DATE": {
      const expected = parseIsoDayUtc(typeof term.value === "string" ? term.value : null);
      return (subject) => {
        if (expected === null) return false;
        const raw = readFieldRaw(subject, key);
        const actual = parseIsoDayUtc(typeof raw === "string" ? raw : null);
        if (actual === null) return false;
        return compareNumbers(actual, op, expected);
      };
    }
    case "BOOLEAN": {
      const expected = term.value === true;
      return (subject) => {
        const actual = readBool(readFieldRaw(subject, key));
        return actual === null ? false : actual === expected;
      };
    }
    // TEXT / ENUM / ACCOUNT_CODE — trimmed, case-insensitive.
    default: {
      if (op === "IN") {
        const expected = new Set(
          (Array.isArray(term.value) ? term.value : []).map(normText)
        );
        return (subject) => {
          const raw = readFieldRaw(subject, key);
          if (isBlankRaw(raw)) return false;
          return expected.has(normText(raw));
        };
      }
      if (op === "GT" || op === "GTE" || op === "LT" || op === "LTE") {
        const expected = normText(term.value ?? "");
        return (subject) => {
          const raw = readFieldRaw(subject, key);
          if (isBlankRaw(raw)) return false;
          return compareText(normText(raw), op, expected);
        };
      }
      const expected = normText(term.value ?? "");
      const wantEqual = op === "EQ";
      return (subject) => {
        const raw = readFieldRaw(subject, key);
        if (isBlankRaw(raw)) return false;
        return (normText(raw) === expected) === wantEqual;
      };
    }
  }
}

function ruleOutcome(rate: number, rateBlockId: string | undefined): RuleOutcome {
  return rateBlockId ? { rateBlockId } : { rate };
}

/** All constant coercion (and KPI series fetching) happens here, once per
 *  block per recalc. Callers pass configs that came through
 *  `normalizeRateRules`, which guarantees month-varying terms and block
 *  outputs never coexist. */
export function bindRateRules(
  config: RateRulesConfig,
  ctx: RateRuleBindContext = {}
): BoundRateRules {
  return {
    monthVarying: rateRulesMonthVarying(config),
    rules: config.rules.map((rule) => ({
      terms: rule.when.map((term) => bindTerm(term, ctx)),
      outcome: ruleOutcome(rule.rate, rule.rateBlockId),
    })),
    otherwise: ruleOutcome(config.otherwise, config.otherwiseBlockId),
  };
}

/** Cumulative calendar service days at the END of each month. */
function cumulativeService(subject: RateRuleSubject): number[] {
  const cum = new Array<number>(MONTHS);
  const perMonth = subject.serviceDaysPerMonth;
  let running = subject.serviceDaysOpening ?? 0;
  for (let m = 0; m < MONTHS; m++) {
    running += perMonth?.[m] ?? 0;
    cum[m] = running;
  }
  return cum;
}

function firstMatch(
  bound: BoundRateRules,
  subject: RateRuleSubject,
  cum: number[] | null,
  month: number
): RuleOutcome {
  outer: for (const rule of bound.rules) {
    for (const term of rule.terms) {
      if (!term(subject, cum, month)) continue outer;
    }
    return rule.outcome;
  }
  return bound.otherwise;
}

/**
 * Resolve one position's multiplier. Returns a scalar whenever the twelve
 * months agree (including every config without a month-varying term), so the
 * caller can stay on the scalar ComponentValue.rate / Op.PCT_OF_ACC path. A
 * block outcome only ever arrives from the non-month-varying path (normalize
 * guarantees the combination cannot exist).
 */
export function evaluateBoundRules(
  bound: BoundRateRules,
  subject: RateRuleSubject
): RateRuleResult {
  if (!bound.monthVarying) {
    const outcome = firstMatch(bound, subject, null, 0);
    return "rateBlockId" in outcome ? { rateBlockId: outcome.rateBlockId } : { rate: outcome.rate };
  }
  const cum = cumulativeService(subject);
  const monthlyRates = new Array<number>(MONTHS);
  let constant = true;
  for (let m = 0; m < MONTHS; m++) {
    const outcome = firstMatch(bound, subject, cum, m);
    // Month-varying configs carry no block outcomes (normalize strips them),
    // but a hand-edited blob could — read its rate field, defaulting 0.
    monthlyRates[m] = "rateBlockId" in outcome ? 0 : outcome.rate;
    if (m > 0 && monthlyRates[m] !== monthlyRates[0]) constant = false;
  }
  return constant ? { rate: monthlyRates[0] } : { monthlyRates };
}

/** One-shot convenience for tests and one-off evaluation. */
export function evaluateRateRules(
  config: RateRulesConfig,
  subject: RateRuleSubject,
  ctx: RateRuleBindContext = {}
): RateRuleResult {
  return evaluateBoundRules(bindRateRules(config, ctx), subject);
}

// ---------------------------------------------------------------------------
// Normalization (read/write hygiene for a JSON blob that syncs)
// ---------------------------------------------------------------------------

const OPERATORS: ReadonlySet<string> = new Set([
  "EQ", "NEQ", "IN", "GT", "GTE", "LT", "LTE", "IS_BLANK", "NOT_BLANK",
]);
const DATA_TYPES: ReadonlySet<string> = new Set([
  "TEXT", "NUMBER", "INTEGER", "DATE", "PERCENT", "ENUM", "ACCOUNT_CODE", "BOOLEAN",
]);

function normalizeTerm(raw: unknown): RateRuleTerm | null {
  if (typeof raw !== "object" || raw === null) return null;
  const term = raw as Record<string, unknown>;
  const op = term.op;
  if (typeof op !== "string" || !OPERATORS.has(op)) return null;

  const source = term.source as Record<string, unknown> | undefined;
  if (typeof source !== "object" || source === null) return null;

  let normSource: RateRuleSource;
  if (source.kind === "DAYS_IN_POSITION") {
    normSource = { kind: "DAYS_IN_POSITION" };
  } else if (
    source.kind === "KPI" &&
    typeof source.kpiDriverId === "string" &&
    source.kpiDriverId.trim() !== ""
  ) {
    normSource = { kind: "KPI", kpiDriverId: source.kpiDriverId.trim() };
  } else if (
    source.kind === "FIELD" &&
    typeof source.fieldKey === "string" &&
    source.fieldKey.trim() !== "" &&
    typeof source.dataType === "string" &&
    DATA_TYPES.has(source.dataType)
  ) {
    normSource = {
      kind: "FIELD",
      fieldKey: source.fieldKey.trim(),
      dataType: source.dataType as FieldDataType,
    };
  } else {
    return null;
  }

  if (!RATE_RULE_OPERATORS[ruleSourceType(normSource)].includes(op as RateRuleOperator)) {
    return null;
  }

  if (!operatorNeedsValue(op as RateRuleOperator)) {
    return { source: normSource, op: op as RateRuleOperator };
  }

  let value = term.value;
  if (op === "IN") {
    if (!Array.isArray(value)) return null;
    const list = value.filter(
      (entry): entry is string | number =>
        typeof entry === "string" ? entry.trim() !== "" : typeof entry === "number"
    );
    if (list.length === 0) return null;
    value = list;
  } else if (typeof value === "string") {
    value = value.trim();
    if (value === "") return null;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
  } else if (typeof value !== "boolean") {
    return null;
  }

  return { source: normSource, op: op as RateRuleOperator, value: value as RateRuleTerm["value"] };
}

/**
 * Coerce an untrusted blob (synced doc, hand-edited config) into a well-formed
 * RateRulesConfig, or undefined when there is nothing usable. Malformed terms
 * void their whole RULE (a rule missing one condition must not silently match
 * more rows); malformed rates read as 0; block outputs are stripped when the
 * config also carries month-varying terms (the unrepresentable combination —
 * see the header). Both loaders read configs through this, so a bad blob
 * normalizes the same way everywhere.
 */
export function normalizeRateRules(raw: unknown): RateRulesConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const config = raw as Record<string, unknown>;
  if (!Array.isArray(config.rules)) return undefined;

  const rules: RateRule[] = [];
  for (const entry of config.rules) {
    if (typeof entry !== "object" || entry === null) continue;
    const rule = entry as Record<string, unknown>;
    if (!Array.isArray(rule.when)) continue;
    const when: RateRuleTerm[] = [];
    let broken = false;
    for (const rawTerm of rule.when) {
      const term = normalizeTerm(rawTerm);
      if (!term) {
        broken = true;
        break;
      }
      when.push(term);
    }
    if (broken) continue;
    const rate = typeof rule.rate === "number" && Number.isFinite(rule.rate) ? rule.rate : 0;
    const rateBlockId =
      typeof rule.rateBlockId === "string" && rule.rateBlockId.trim() !== ""
        ? rule.rateBlockId.trim()
        : undefined;
    rules.push(rateBlockId ? { when, rate, rateBlockId } : { when, rate });
  }

  const otherwise =
    typeof config.otherwise === "number" && Number.isFinite(config.otherwise)
      ? config.otherwise
      : 0;
  const otherwiseBlockId =
    typeof config.otherwiseBlockId === "string" && config.otherwiseBlockId.trim() !== ""
      ? config.otherwiseBlockId.trim()
      : undefined;

  const normalized: RateRulesConfig = otherwiseBlockId
    ? { rules, otherwise, otherwiseBlockId }
    : { rules, otherwise };

  if (rateRulesMonthVarying(normalized) && rateRulesHaveBlockOutputs(normalized)) {
    // Unrepresentable — keep the month variation, drop the block outputs.
    return {
      rules: normalized.rules.map(({ when, rate }) => ({ when, rate })),
      otherwise: normalized.otherwise,
    };
  }
  return normalized;
}
