/**
 * Compile a report definition: parse every formula once, normalise every atom,
 * check every reference, and plan the evaluation. A compiled report is
 * immutable and reusable across evaluations; the built-in definitions are
 * compiled at module load.
 *
 * Every fault a definition can have is reported at once, with the id it
 * belongs to, so a definition that is being authored fails with one complete
 * list rather than one error per attempt.
 */

import { AtomDefinitionError, NormalizedAtom, normalizeAtom } from "./atoms";
import { collectRefs } from "./formula/ast";
import { FUNCTION_NAMES } from "./formula/functions";
import { parseFormula } from "./formula/parser";
import { FormulaSyntaxError } from "./formula/tokenizer";
import { CompiledMeasure, ReportGraphError, planEvaluation } from "./graph";
import type { ParamValue, ReportDefinition, ReportParam, ValueSourceKind } from "./types";

export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** null when the value is a well-formed ParamValue, else what is wrong. */
export function paramValueProblem(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : "must be finite";
  if (!value || typeof value !== "object") return "must be a number or { months, total? }";
  const { months, total } = value as { months?: unknown; total?: unknown };
  if (!Array.isArray(months) || months.length !== 12 || !months.every((m) => Number.isFinite(m))) {
    return "months must be twelve finite numbers";
  }
  if (total !== undefined && !Number.isFinite(total)) return "total must be a finite number";
  return null;
}

export function isParamValue(value: unknown): value is ParamValue {
  return paramValueProblem(value) === null;
}

export class ReportDefinitionError extends Error {
  constructor(
    public readonly definitionId: string,
    public readonly problems: readonly string[]
  ) {
    super(
      `Report definition "${definitionId}" is invalid:\n  - ${problems.join("\n  - ")}`
    );
    this.name = "ReportDefinitionError";
  }
}

export interface CompiledReport {
  definition: ReportDefinition;
  atoms: ReadonlyMap<string, NormalizedAtom>;
  measures: ReadonlyMap<string, CompiledMeasure>;
  /** The measures the rows show, in row order, deduplicated. */
  roots: readonly string[];
  /** Measures in dependency order. */
  order: readonly string[];
  /** Atoms the rows reach. */
  atomsUsed: ReadonlySet<string>;
  /** Which kinds of value source the reached atoms read. */
  sourceKinds: ReadonlySet<ValueSourceKind>;
  params: ReadonlyMap<string, ReportParam>;
  /** Params the rows reach. */
  paramsUsed: ReadonlySet<string>;
}

/** Every problem with a definition, or an empty list. Never throws. */
export function validateDefinition(definition: ReportDefinition): string[] {
  try {
    compileDefinition(definition);
    return [];
  } catch (error) {
    if (error instanceof ReportDefinitionError) return [...error.problems];
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function compileDefinition(definition: ReportDefinition): CompiledReport {
  const problems: string[] = [];
  const seen = new Set<string>();

  const checkId = (id: unknown, what: string): string | null => {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      problems.push(`${what} id ${JSON.stringify(id)} must match ${ID_PATTERN}`);
      return null;
    }
    if (FUNCTION_NAMES.has(id)) {
      problems.push(`${what} id "${id}" is a function name and is reserved`);
      return null;
    }
    if (seen.has(id)) {
      problems.push(`id "${id}" is used more than once`);
      return null;
    }
    seen.add(id);
    return id;
  };

  const atoms = new Map<string, NormalizedAtom>();
  for (const atom of definition.atoms ?? []) {
    const id = checkId(atom?.id, "atom");
    if (!id) continue;
    try {
      atoms.set(id, normalizeAtom(atom));
    } catch (error) {
      problems.push(
        error instanceof AtomDefinitionError ? error.message : `atom "${id}": ${String(error)}`
      );
    }
  }

  const params = new Map<string, ReportParam>();
  for (const param of definition.params ?? []) {
    const id = checkId(param?.id, "param");
    if (!id) continue;
    const problem = paramValueProblem(param.default);
    if (problem) {
      problems.push(`param "${id}": default ${problem}`);
      continue;
    }
    params.set(id, param);
  }

  const measures = new Map<string, CompiledMeasure>();
  for (const measure of definition.measures ?? []) {
    const id = checkId(measure?.id, "measure");
    if (!id) continue;
    try {
      const ast = parseFormula(String(measure.formula ?? ""));
      measures.set(id, { id, ast, refs: collectRefs(ast) });
    } catch (error) {
      problems.push(
        `measure "${id}": ${error instanceof FormulaSyntaxError ? error.message : String(error)}`
      );
    }
  }

  for (const measure of measures.values()) {
    for (const ref of measure.refs) {
      if (!atoms.has(ref) && !measures.has(ref) && !params.has(ref)) {
        problems.push(`measure "${measure.id}" references unknown id "${ref}"`);
      }
    }
  }

  const roots: string[] = [];
  const rootSet = new Set<string>();
  (definition.rows ?? []).forEach((row, index) => {
    if (row.type !== "measure") return;
    if (!measures.has(row.measureId)) {
      problems.push(`row ${index + 1} references unknown measure "${row.measureId}"`);
      return;
    }
    if (!rootSet.has(row.measureId)) {
      rootSet.add(row.measureId);
      roots.push(row.measureId);
    }
  });

  if (problems.length > 0) {
    throw new ReportDefinitionError(String(definition?.id ?? "?"), problems);
  }

  let plan;
  try {
    plan = planEvaluation(measures, new Set([...atoms.keys(), ...params.keys()]), roots);
  } catch (error) {
    throw new ReportDefinitionError(definition.id, [
      error instanceof ReportGraphError ? error.message : String(error),
    ]);
  }

  const atomsUsed = new Set<string>();
  const paramsUsed = new Set<string>();
  for (const leaf of plan.leaves) (atoms.has(leaf) ? atomsUsed : paramsUsed).add(leaf);

  const sourceKinds = new Set<ValueSourceKind>();
  for (const atomId of atomsUsed) sourceKinds.add(atoms.get(atomId)!.source.source);

  return {
    definition,
    atoms,
    measures,
    roots,
    order: plan.order,
    atomsUsed,
    sourceKinds,
    params,
    paramsUsed,
  };
}
