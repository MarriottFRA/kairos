/**
 * defineReport — assemble a definition from catalog groups plus its own
 * atoms, measures, params and rows.
 *
 * Groups are pulled in transitively through `requires`. Ids merge by value:
 * the same atom reached through two groups is one atom; the same id with a
 * DIFFERENT body is an authoring error and throws here, at module load,
 * naming the id — a definition must not quietly get the wrong "revenue". A
 * definition's own entries never override a catalog entry either; a variant
 * gets its own id.
 *
 * The result is plain data, so it JSON round-trips like a hand-written one.
 */

import type { CatalogGroup } from "../catalog";
import { ReportDefinitionError } from "../compile";
import type { Atom, Measure, ReportDefinition, ReportParam, ReportRow } from "../types";

export interface ReportSpec {
  id: string;
  name: string;
  description?: string;
  use?: CatalogGroup[];
  atoms?: Atom[];
  measures?: Measure[];
  params?: ReportParam[];
  rows: ReportRow[];
}

/** A body's identity for the "same id, same thing?" test: key-sorted JSON. */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

function collectGroups(groups: readonly CatalogGroup[] | undefined): CatalogGroup[] {
  const out: CatalogGroup[] = [];
  const seen = new Set<string>();
  const visit = (group: CatalogGroup) => {
    if (seen.has(group.id)) return;
    seen.add(group.id);
    for (const required of group.requires ?? []) visit(required);
    out.push(group);
  };
  for (const group of groups ?? []) visit(group);
  return out;
}

export function defineReport(spec: ReportSpec): ReportDefinition {
  const problems: string[] = [];
  const atoms = new Map<string, Atom>();
  const measures = new Map<string, Measure>();
  const params = new Map<string, ReportParam>();

  const merge = <T extends { id: string }>(
    into: Map<string, T>,
    items: readonly T[] | undefined,
    what: string,
    origin: string
  ) => {
    for (const item of items ?? []) {
      const existing = into.get(item.id);
      if (!existing) {
        into.set(item.id, item);
      } else if (fingerprint(existing) !== fingerprint(item)) {
        problems.push(`${what} "${item.id}" from ${origin} differs from the one already included`);
      }
    }
  };

  for (const group of collectGroups(spec.use)) {
    merge(atoms, group.atoms, "atom", `catalog group "${group.id}"`);
    merge(measures, group.measures, "measure", `catalog group "${group.id}"`);
    merge(params, group.params, "param", `catalog group "${group.id}"`);
  }
  merge(atoms, spec.atoms, "atom", "the definition");
  merge(measures, spec.measures, "measure", "the definition");
  merge(params, spec.params, "param", "the definition");

  if (problems.length > 0) throw new ReportDefinitionError(spec.id, problems);

  const definition: ReportDefinition = {
    id: spec.id,
    name: spec.name,
    version: 1,
    atoms: [...atoms.values()],
    measures: [...measures.values()],
    rows: spec.rows,
  };
  if (spec.description) definition.description = spec.description;
  if (params.size > 0) definition.params = [...params.values()];
  return definition;
}

/** Row shorthands for the definitions. */
export const header = (label: string, indent = 0): ReportRow =>
  indent ? { type: "header", label, indent } : { type: "header", label };
export const spacer = (): ReportRow => ({ type: "spacer" });
export const line = (measureId: string, label?: string, indent?: number): ReportRow => {
  const row: Extract<ReportRow, { type: "measure" }> = { type: "measure", measureId };
  if (label) row.label = label;
  if (indent) row.indent = indent;
  return row;
};
