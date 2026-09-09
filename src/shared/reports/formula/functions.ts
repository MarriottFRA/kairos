/**
 * The functions a formula may call. All elementwise over the thirteen slots
 * unless the comment says otherwise (cum, dec, total, avg, retotal, mean —
 * the ones that deliberately relate months to the total).
 *
 * Names here are RESERVED: a definition may not use one as an atom or measure
 * id, and the parser refuses a bare function name used as a reference.
 */

import * as vec from "../vec";
import type { Vec13 } from "../vec";

export interface FormulaFunction {
  /** Exact argument count, or a minimum for variadic functions. */
  arity: number;
  variadic?: boolean;
  apply(args: Vec13[]): Vec13;
  description: string;
}

export const FUNCTIONS: Readonly<Record<string, FormulaFunction>> = {
  div: {
    arity: 2,
    apply: ([a, b]) => vec.div(a, b),
    description: "a ÷ b, 0 where b is 0 (same as the / operator)",
  },
  pct: {
    arity: 2,
    apply: ([a, b]) => vec.pct(a, b),
    description: "100 × a ÷ b, 0 where b is 0",
  },
  abs: { arity: 1, apply: ([a]) => vec.abs(a), description: "|a|" },
  neg: { arity: 1, apply: ([a]) => vec.neg(a), description: "−a" },
  min: {
    arity: 1,
    variadic: true,
    apply: (args) => vec.min(args),
    description: "the smallest of the arguments, slot by slot",
  },
  max: {
    arity: 1,
    variadic: true,
    apply: (args) => vec.max(args),
    description: "the largest of the arguments, slot by slot",
  },
  cum: {
    arity: 1,
    apply: ([a]) => vec.cum(a),
    description: "running sum over the months; Total = December",
  },
  dec: {
    arity: 1,
    apply: ([a]) => vec.dec(a),
    description: "the December value in every slot",
  },
  total: {
    arity: 1,
    apply: ([a]) => vec.total(a),
    description: "the Total in every slot",
  },
  avg: {
    arity: 1,
    apply: ([a]) => vec.avg(a),
    description: "Total ÷ 12 in every slot",
  },
  retotal: {
    arity: 1,
    apply: ([a]) => vec.retotal(a),
    description: "months as they are, Total re-summed from them",
  },
  mean: {
    arity: 1,
    apply: ([a]) => vec.mean(a),
    description: "months as they are, Total = the mean of the months (a level's year figure)",
  },
};

export const FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(FUNCTIONS));

/** null when the call is well-formed, else the message to raise. */
export function functionArityError(name: string, argCount: number): string | null {
  const fn = FUNCTIONS[name];
  if (!fn) return `Unknown function "${name}"`;
  if (fn.variadic) {
    return argCount >= fn.arity
      ? null
      : `${name}() needs at least ${fn.arity} argument${fn.arity === 1 ? "" : "s"}`;
  }
  return argCount === fn.arity
    ? null
    : `${name}() takes ${fn.arity} argument${fn.arity === 1 ? "" : "s"}, got ${argCount}`;
}
