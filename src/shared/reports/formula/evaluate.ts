/**
 * Formula evaluator: an AST and a way to look identifiers up → a Vec13.
 *
 * Every reference is resolved through `lookup`, which the engine backs with
 * its per-evaluation memo — so a measure referenced by three others is
 * computed once. The evaluator itself is stateless.
 */

import type { FormulaNode } from "./ast";
import { FUNCTIONS } from "./functions";
import * as vec from "../vec";
import type { Vec13 } from "../vec";

export type RefLookup = (id: string) => Vec13;

export function evaluateFormula(node: FormulaNode, lookup: RefLookup): Vec13 {
  switch (node.kind) {
    case "num":
      return vec.scalar(node.value);
    case "ref":
      return lookup(node.id);
    case "neg":
      return vec.neg(evaluateFormula(node.operand, lookup));
    case "bin": {
      const left = evaluateFormula(node.left, lookup);
      const right = evaluateFormula(node.right, lookup);
      switch (node.op) {
        case "+":
          return vec.add(left, right);
        case "-":
          return vec.sub(left, right);
        case "*":
          return vec.mul(left, right);
        case "/":
          return vec.div(left, right);
      }
      break;
    }
    case "call": {
      const fn = FUNCTIONS[node.fn];
      if (!fn) throw new Error(`Unknown function "${node.fn}"`);
      return fn.apply(node.args.map((arg) => evaluateFormula(arg, lookup)));
    }
  }
  throw new Error("Unreachable formula node");
}
