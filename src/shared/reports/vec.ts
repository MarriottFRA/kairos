/**
 * Vec13 — twelve months and a total, the one value type the report engine
 * computes with.
 *
 * Slots 0..11 are Jan..Dec, slot 12 is the Total. Every operation is
 * elementwise across all thirteen, which is the property the whole engine
 * rests on: a ratio's Total is the ratio of the totals, not the sum of twelve
 * monthly ratios. The three functions that break the symmetry on purpose —
 * cum, dec and retotal — say so in their comments.
 *
 * Float64Array rather than number[]: the report engine sums thousands of
 * these per evaluation and a typed array is both faster and fixed-length by
 * construction.
 */

export type Vec13 = Float64Array;

export const MONTHS = 12;
export const TOTAL = 12;
export const SLOTS = 13;

/** A divisor smaller than this reads as zero: the safe divide answers 0. */
export const DIVIDE_EPSILON = 1e-12;

export function zero(): Vec13 {
  return new Float64Array(SLOTS);
}

/** A vector every slot of which is `value` — how a numeric literal enters a
 *  formula. */
export function scalar(value: number): Vec13 {
  return new Float64Array(SLOTS).fill(value);
}

/** Twelve months → a Vec13 whose Total is their sum. */
export function fromMonths(months: ArrayLike<number>): Vec13 {
  const out = zero();
  let total = 0;
  for (let m = 0; m < MONTHS; m++) {
    const value = Number(months[m]) || 0;
    out[m] = value;
    total += value;
  }
  out[TOTAL] = total;
  return out;
}

/** A param as it enters a formula: a number fills every slot; a series keeps
 *  its months, with the Total the sum of them unless one is given. */
export function fromParam(value: number | { months: ArrayLike<number>; total?: number }): Vec13 {
  if (typeof value === "number") return scalar(Number.isFinite(value) ? value : 0);
  const out = fromMonths(value.months);
  if (value.total !== undefined && Number.isFinite(value.total)) out[TOTAL] = value.total;
  return out;
}

export function toArray(vec: Vec13): number[] {
  return Array.from(vec);
}

export function copy(vec: Vec13): Vec13 {
  return new Float64Array(vec);
}

/** target += source, in place. The hot loop of atom summation. */
export function addInto(target: Vec13, source: Vec13): void {
  for (let i = 0; i < SLOTS; i++) target[i] += source[i];
}

export function add(a: Vec13, b: Vec13): Vec13 {
  const out = zero();
  for (let i = 0; i < SLOTS; i++) out[i] = a[i] + b[i];
  return out;
}

export function sub(a: Vec13, b: Vec13): Vec13 {
  const out = zero();
  for (let i = 0; i < SLOTS; i++) out[i] = a[i] - b[i];
  return out;
}

/** Elementwise. Total = total(a) × total(b): right for a ratio scaled by a
 *  constant, wrong for rate × volume — wrap that in retotal(). */
export function mul(a: Vec13, b: Vec13): Vec13 {
  const out = zero();
  for (let i = 0; i < SLOTS; i++) out[i] = a[i] * b[i];
  return out;
}

/** Safe divide: a slot whose divisor is (near) zero reads 0, never NaN or
 *  Infinity — a blank denominator is an empty report line, not a broken one. */
export function div(a: Vec13, b: Vec13): Vec13 {
  const out = zero();
  for (let i = 0; i < SLOTS; i++) {
    out[i] = Math.abs(b[i]) < DIVIDE_EPSILON ? 0 : a[i] / b[i];
  }
  return out;
}

/** 100 × a / b, safe. */
export function pct(a: Vec13, b: Vec13): Vec13 {
  const out = div(a, b);
  for (let i = 0; i < SLOTS; i++) out[i] *= 100;
  return out;
}

export function neg(a: Vec13): Vec13 {
  const out = zero();
  for (let i = 0; i < SLOTS; i++) out[i] = -a[i];
  return out;
}

export function abs(a: Vec13): Vec13 {
  const out = zero();
  for (let i = 0; i < SLOTS; i++) out[i] = Math.abs(a[i]);
  return out;
}

export function min(vecs: Vec13[]): Vec13 {
  const out = scalar(Infinity);
  for (const vec of vecs) for (let i = 0; i < SLOTS; i++) out[i] = Math.min(out[i], vec[i]);
  return vecs.length === 0 ? zero() : out;
}

export function max(vecs: Vec13[]): Vec13 {
  const out = scalar(-Infinity);
  for (const vec of vecs) for (let i = 0; i < SLOTS; i++) out[i] = Math.max(out[i], vec[i]);
  return vecs.length === 0 ? zero() : out;
}

/**
 * Running sum over the months: slot m = Σ months 0..m. Total = the December
 * value, because a cumulative series' year figure is where it ends up, not a
 * sum of running sums. This is how a LEVEL-encoded row (January-plus-changes)
 * reads back as levels.
 */
export function cum(a: Vec13): Vec13 {
  const out = zero();
  let running = 0;
  for (let m = 0; m < MONTHS; m++) {
    running += a[m];
    out[m] = running;
  }
  out[TOTAL] = running;
  return out;
}

/** Every slot = the December value (a year-end level, broadcast). */
export function dec(a: Vec13): Vec13 {
  return scalar(a[MONTHS - 1]);
}

/** Every slot = the Total (broadcast, e.g. a year figure as a monthly divisor). */
export function total(a: Vec13): Vec13 {
  return scalar(a[TOTAL]);
}

/** Every slot = Total ÷ 12. */
export function avg(a: Vec13): Vec13 {
  return scalar(a[TOTAL] / MONTHS);
}

/** Months as they are, Total re-summed from them. For rate × volume products
 *  and anything else whose Total should be the sum of its months. */
export function retotal(a: Vec13): Vec13 {
  const out = copy(a);
  let sum = 0;
  for (let m = 0; m < MONTHS; m++) sum += a[m];
  out[TOTAL] = sum;
  return out;
}

/** Months as they are, Total = their mean. The year figure of a LEVEL read as
 *  a full-time equivalent: a head on the books all year is 1 in every month
 *  and 1 for the year, one there for six months is 0.5 for the year — not
 *  the December level (cum) and not twelve heads (retotal). */
export function mean(a: Vec13): Vec13 {
  const out = retotal(a);
  out[TOTAL] /= MONTHS;
  return out;
}
