/**
 * Atoms — from a filter list to a summed Vec13.
 *
 * An atom is resolved in two steps. First each side (department, account) is
 * reduced to either "every code" or a set of bare codes, by intersecting its
 * filters: base and prefix filters resolve against the SOURCE's own codes and
 * never touch the maps; level filters ask the MapIndex for the codes under a
 * label. Then the entries are walked along the cheaper side and their report
 * vectors summed. A base-only atom on both sides is a handful of direct
 * lookups — the fast path the report definitions should prefer wherever the
 * accounts are known.
 *
 * `*_level_not_in` is the residual filter: it keeps every code NOT under the
 * given labels, INCLUDING codes the maps do not know, so an "everything else"
 * line never silently drops an unmapped account.
 */

import { bareAccount, bareDept } from "../positions/comboKey";
import { MAP_LEVEL_COUNT } from "../mappingTables/types";
import type { MapIndex, ValueSource } from "./sources";
import type { Atom, AtomFilter, ReportWarning, ValueSourceRef } from "./types";
import * as vec from "./vec";
import type { Vec13 } from "./vec";

export type Side = "dept" | "account";

export type NormalizedFilter =
  | { kind: "base"; codes: ReadonlySet<string> }
  | { kind: "base_not_in"; codes: ReadonlySet<string> }
  | { kind: "prefix"; prefixes: readonly string[] }
  | { kind: "level"; level: number; values: readonly string[] }
  | { kind: "level_not_in"; level: number; values: readonly string[] };

export interface NormalizedAtom {
  id: string;
  source: ValueSourceRef;
  dept: NormalizedFilter[];
  account: NormalizedFilter[];
  negate: boolean;
  /** True when any filter is a level filter — the atom needs the maps. */
  usesMaps: boolean;
}

export class AtomDefinitionError extends Error {
  constructor(
    public readonly atomId: string,
    message: string
  ) {
    super(`Atom "${atomId}": ${message}`);
    this.name = "AtomDefinitionError";
  }
}

function sideOf(kind: AtomFilter["kind"]): Side {
  return kind.startsWith("dept_") ? "dept" : "account";
}

function nonEmptyStrings(atomId: string, what: string, values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new AtomDefinitionError(atomId, `${what} must be a non-empty list`);
  }
  const out = values.map((value) => String(value ?? "").trim()).filter((v) => v);
  if (out.length === 0) {
    throw new AtomDefinitionError(atomId, `${what} must hold at least one non-blank value`);
  }
  return out;
}

function normalizeFilter(atomId: string, filter: AtomFilter): NormalizedFilter {
  const side = sideOf(filter.kind);
  const bare = side === "dept" ? bareDept : bareAccount;
  switch (filter.kind) {
    case "dept_base":
    case "acc_base":
      return { kind: "base", codes: new Set(nonEmptyStrings(atomId, "codes", filter.codes).map(bare)) };
    case "dept_base_not_in":
    case "acc_base_not_in":
      return {
        kind: "base_not_in",
        codes: new Set(nonEmptyStrings(atomId, "codes", filter.codes).map(bare)),
      };
    case "dept_prefix":
    case "acc_prefix":
      return {
        kind: "prefix",
        prefixes: nonEmptyStrings(atomId, "prefixes", filter.prefixes).map(bare),
      };
    case "dept_level":
    case "acc_level":
    case "dept_level_not_in":
    case "acc_level_not_in": {
      const level = filter.level;
      if (!Number.isInteger(level) || level < 0 || level >= MAP_LEVEL_COUNT) {
        throw new AtomDefinitionError(
          atomId,
          `level must be an integer between 0 and ${MAP_LEVEL_COUNT - 1}`
        );
      }
      const values = nonEmptyStrings(atomId, "values", filter.values);
      return filter.kind.endsWith("_not_in")
        ? { kind: "level_not_in", level, values }
        : { kind: "level", level, values };
    }
    default:
      throw new AtomDefinitionError(atomId, `unknown filter kind "${(filter as { kind: string }).kind}"`);
  }
}

export function normalizeAtom(atom: Atom): NormalizedAtom {
  if (!Array.isArray(atom.filters)) {
    throw new AtomDefinitionError(atom.id, "filters must be a list");
  }
  const out: NormalizedAtom = {
    id: atom.id,
    source: atom.source ?? { source: "kairos" },
    dept: [],
    account: [],
    negate: atom.negate === true,
    usesMaps: false,
  };
  for (const filter of atom.filters) {
    const normalized = normalizeFilter(atom.id, filter);
    if (normalized.kind === "level" || normalized.kind === "level_not_in") out.usesMaps = true;
    (sideOf(filter.kind) === "dept" ? out.dept : out.account).push(normalized);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** "all" or the bare codes one side of the atom admits. */
export type SideSelection = "all" | ReadonlySet<string>;

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<string>();
  for (const code of small) if (large.has(code)) out.add(code);
  return out;
}

function complement(universe: ReadonlySet<string>, excluded: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const code of universe) if (!excluded.has(code)) out.add(code);
  return out;
}

export function resolveSide(
  atomId: string,
  side: Side,
  filters: readonly NormalizedFilter[],
  source: ValueSource,
  maps: MapIndex,
  warn: (warning: ReportWarning) => void
): SideSelection {
  if (filters.length === 0) return "all";
  const universe = side === "dept" ? source.deptCodes : source.accountCodes;
  const atLevel = side === "dept" ? maps.deptCodes : maps.accountCodes;

  let selection: ReadonlySet<string> | null = null;
  const narrow = (codes: ReadonlySet<string>) => {
    selection = selection === null ? codes : intersect(selection, codes);
  };

  for (const filter of filters) {
    switch (filter.kind) {
      case "base":
        narrow(filter.codes);
        break;
      case "base_not_in":
        narrow(complement(universe, filter.codes));
        break;
      case "prefix": {
        const out = new Set<string>();
        for (const code of universe) {
          for (const prefix of filter.prefixes) {
            if (code.startsWith(prefix)) {
              out.add(code);
              break;
            }
          }
        }
        narrow(out);
        break;
      }
      case "level":
        if (!maps.available) {
          warn(mapsUnavailable(atomId));
          narrow(new Set());
        } else {
          narrow(atLevel(filter.level, filter.values));
        }
        break;
      case "level_not_in":
        if (!maps.available) {
          // Nothing is mapped, so nothing is under the label: everything stays.
          warn(mapsUnavailable(atomId));
          narrow(universe);
        } else {
          narrow(complement(universe, atLevel(filter.level, filter.values)));
        }
        break;
    }
  }
  return selection ?? "all";
}

function mapsUnavailable(atomId: string): ReportWarning {
  return {
    code: "MAPS_UNAVAILABLE",
    atomId,
    message: `Atom "${atomId}" filters on a map level, but the mapping tables have not been synced on this machine.`,
  };
}

// ---------------------------------------------------------------------------
// Summation
// ---------------------------------------------------------------------------

/**
 * Sum the entries an atom selects. Walks the cheaper side: a base-only atom
 * on both sides is |dept codes| × |account codes| direct lookups; one-sided
 * selections walk that side's index; no filters at all walks every entry.
 */
export function sumAtom(
  atom: NormalizedAtom,
  source: ValueSource,
  maps: MapIndex,
  warn: (warning: ReportWarning) => void
): Vec13 {
  const depts = resolveSide(atom.id, "dept", atom.dept, source, maps, warn);
  const accounts = resolveSide(atom.id, "account", atom.account, source, maps, warn);

  const out = vec.zero();
  let mixed = false;
  const take = (entry: { reportVec: Vec13; encoding: string }) => {
    if (entry.encoding === "MIXED") mixed = true;
    vec.addInto(out, entry.reportVec);
  };

  if (depts === "all" && accounts === "all") {
    for (const entry of source.entries) take(entry);
  } else if (accounts === "all") {
    for (const dept of depts as ReadonlySet<string>) {
      const entries = source.byDept.get(dept);
      if (entries) for (const entry of entries) take(entry);
    }
  } else if (depts === "all") {
    for (const account of accounts) {
      const entries = source.byAccount.get(account);
      if (entries) for (const entry of entries) take(entry);
    }
  } else {
    const deptSet = depts as ReadonlySet<string>;
    // Walk whichever side has fewer entries behind it; the other side is a
    // set test. Small × small degenerates to direct lookups, as intended.
    let deptEntries = 0;
    for (const dept of deptSet) deptEntries += source.byDept.get(dept)?.length ?? 0;
    let accountEntries = 0;
    for (const account of accounts) accountEntries += source.byAccount.get(account)?.length ?? 0;
    if (deptEntries <= accountEntries) {
      for (const dept of deptSet) {
        const entries = source.byDept.get(dept);
        if (!entries) continue;
        for (const entry of entries) if (accounts.has(entry.account)) take(entry);
      }
    } else {
      for (const account of accounts) {
        const entries = source.byAccount.get(account);
        if (!entries) continue;
        for (const entry of entries) if (deptSet.has(entry.dept)) take(entry);
      }
    }
  }

  if (mixed) {
    warn({
      code: "MIXED_ENCODING",
      atomId: atom.id,
      message: `Atom "${atom.id}" sums a row that mixes level and amount lines; it was read as amounts.`,
    });
  }
  return atom.negate ? vec.neg(out) : out;
}
