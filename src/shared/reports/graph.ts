/**
 * The dependency graph of a report: which measures the rows need, in what
 * order they can be computed, and which atoms that reaches.
 *
 * Measures may reference measures, so this is a DFS from the rows' measures
 * with three-colour marking: a grey node met again is a cycle, and the error
 * names the path so the definition can be fixed. Only what the rows reach is
 * returned — an atom no row needs is never resolved, which is what keeps a
 * two-line KPI block from paying for a ninety-line P&L's atoms.
 */

import type { FormulaNode } from "./formula/ast";

export interface CompiledMeasure {
  id: string;
  ast: FormulaNode;
  refs: ReadonlySet<string>;
}

export class ReportGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportGraphError";
  }
}

export interface EvaluationPlan {
  /** Measures in dependency order: every reference precedes its referrer. */
  order: string[];
  /** Atoms reached from the roots. */
  atoms: Set<string>;
}

export function planEvaluation(
  measures: ReadonlyMap<string, CompiledMeasure>,
  atomIds: ReadonlySet<string>,
  roots: Iterable<string>
): EvaluationPlan {
  const order: string[] = [];
  const atoms = new Set<string>();
  const state = new Map<string, "grey" | "black">();
  const path: string[] = [];

  const visit = (id: string): void => {
    if (atomIds.has(id)) {
      atoms.add(id);
      return;
    }
    const measure = measures.get(id);
    if (!measure) {
      const from = path.length > 0 ? ` (referenced by "${path[path.length - 1]}")` : "";
      throw new ReportGraphError(`Unknown measure or atom "${id}"${from}`);
    }
    const mark = state.get(id);
    if (mark === "black") return;
    if (mark === "grey") {
      const start = path.indexOf(id);
      throw new ReportGraphError(
        `Circular measure reference: ${[...path.slice(start), id].join(" → ")}`
      );
    }
    state.set(id, "grey");
    path.push(id);
    for (const ref of measure.refs) visit(ref);
    path.pop();
    state.set(id, "black");
    order.push(id);
  };

  for (const root of roots) visit(root);
  return { order, atoms };
}
