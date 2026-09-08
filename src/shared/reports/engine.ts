/**
 * The report engine: a compiled report + value sources + the map index → rows.
 *
 * One pass, in dependency order, with a memo per evaluation: every atom is
 * summed once and every measure computed once however many rows or other
 * measures read it. Twelve months and the total come out of the same pass —
 * there is no per-month re-run, which is the whole difference from the
 * PS Loader engine this replaces.
 *
 * Sources are fetched lazily through the context, so a report that never
 * names the BST never opens the budget import, and the context decides how
 * to cache what it built.
 */

import { sumAtom } from "./atoms";
import type { CompiledReport } from "./compile";
import { evaluateFormula } from "./formula/evaluate";
import type { MapIndex, ValueSource } from "./sources";
import type {
  EvaluatedReport,
  EvaluatedRow,
  ReportWarning,
  ValueSourceRef,
} from "./types";
import * as vec from "./vec";
import type { Vec13 } from "./vec";

export interface EvaluationContext {
  /** The source an atom reads; null when that source is unavailable (the
   *  context has already recorded why through `warn`). */
  getSource(ref: ValueSourceRef, warn: (warning: ReportWarning) => void): ValueSource | null;
  maps: MapIndex;
  /** Warnings the context already knows about (results predate the cache…). */
  warnings?: readonly ReportWarning[];
}

function dedupe(warnings: Iterable<ReportWarning>): ReportWarning[] {
  const seen = new Set<string>();
  const out: ReportWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.atomId ?? ""}|${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
  }
  return out;
}

export function evaluateReport(
  compiled: CompiledReport,
  context: EvaluationContext
): EvaluatedReport {
  const warnings: ReportWarning[] = [...(context.warnings ?? []), ...context.maps.warnings];
  const warn = (warning: ReportWarning) => {
    warnings.push(warning);
  };

  const sources = new Map<string, ValueSource | null>();
  const sourceFor = (ref: ValueSourceRef): ValueSource | null => {
    const key = JSON.stringify(ref);
    if (!sources.has(key)) sources.set(key, context.getSource(ref, warn));
    return sources.get(key) ?? null;
  };

  const values = new Map<string, Vec13>();

  // Atoms first: each summed exactly once.
  for (const atomId of compiled.atomsUsed) {
    const atom = compiled.atoms.get(atomId)!;
    const source = sourceFor(atom.source);
    values.set(atomId, source ? sumAtom(atom, source, context.maps, warn) : vec.zero());
  }

  // Then measures, in an order where every reference is already there.
  const lookup = (id: string): Vec13 => {
    const value = values.get(id);
    if (!value) throw new Error(`Report engine: "${id}" evaluated out of order`);
    return value;
  };
  for (const measureId of compiled.order) {
    values.set(measureId, evaluateFormula(compiled.measures.get(measureId)!.ast, lookup));
  }

  const measureById = new Map(compiled.definition.measures.map((m) => [m.id, m]));
  const rows: EvaluatedRow[] = compiled.definition.rows.map((row): EvaluatedRow => {
    switch (row.type) {
      case "header":
        return { type: "header", label: row.label, indent: row.indent ?? 0, values: null };
      case "spacer":
        return { type: "spacer", label: "", indent: 0, values: null };
      case "measure": {
        const measure = measureById.get(row.measureId);
        return {
          type: "measure",
          measureId: row.measureId,
          label: row.label ?? measure?.label ?? row.measureId,
          indent: row.indent ?? 0,
          format: row.format ?? measure?.format ?? "number",
          invertSign: row.invertSign === true,
          values: vec.toArray(lookup(row.measureId)),
        };
      }
    }
  });

  const atoms: Record<string, number[]> = {};
  for (const atomId of compiled.atomsUsed) atoms[atomId] = vec.toArray(values.get(atomId)!);

  return {
    definitionId: compiled.definition.id,
    rows,
    warnings: dedupe(warnings),
    atoms,
  };
}
