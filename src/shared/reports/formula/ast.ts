/**
 * The formula AST. Produced once by the parser, walked by the evaluator and
 * the dependency graph. Small on purpose: numbers, references, unary minus,
 * the four binary operators, and function calls.
 */

export type BinaryOp = "+" | "-" | "*" | "/";

export type FormulaNode =
  | { kind: "num"; value: number }
  | { kind: "ref"; id: string }
  | { kind: "neg"; operand: FormulaNode }
  | { kind: "bin"; op: BinaryOp; left: FormulaNode; right: FormulaNode }
  | { kind: "call"; fn: string; args: FormulaNode[] };

/** Every identifier a formula reads — atoms and measures alike. Function
 *  names are not references. */
export function collectRefs(node: FormulaNode, into: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case "num":
      break;
    case "ref":
      into.add(node.id);
      break;
    case "neg":
      collectRefs(node.operand, into);
      break;
    case "bin":
      collectRefs(node.left, into);
      collectRefs(node.right, into);
      break;
    case "call":
      for (const arg of node.args) collectRefs(arg, into);
      break;
  }
  return into;
}
