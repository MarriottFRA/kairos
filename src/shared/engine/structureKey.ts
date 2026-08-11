/**
 * "Can this compiled structure be reused?" — the one question, answered as a string.
 * -----------------------------------------------------------
 * compileStructure() produces the half of a plan that does not depend on any
 * edited number: the topological order, the interned dept×account and
 * cluster×job dimensions, and which aggregate row every line books to. Reusing
 * it across edits is what makes a value-only edit cheap.
 *
 * Reusing it when it is NOT valid is the worst bug this codebase could have: no
 * error, no crash, just a line booked to the wrong department for the rest of
 * the session. So this file exists to answer one question, and everything about
 * it is chosen to fail loudly rather than plausibly.
 *
 * WHY A STRING, NOT A HASH. A 64-bit hash of these inputs would collide roughly
 * never — and "roughly never" is not a property you want guarding which account
 * money lands in, because a collision does not throw, it silently returns the
 * wrong plan. A canonical string compared with === has no such failure mode. It
 * is a few tens of kilobytes and microseconds to compare.
 *
 * WHY THE SEPARATORS MATTER. Every field is joined with an explicit delimiter,
 * never concatenated. Without one, department "10" + cluster "10" and
 * department "1" + cluster "010" produce the same key — reintroducing exactly
 * the silent collision the string form exists to avoid. The delimiters are
 * control characters because they cannot occur in a department code, an account
 * code or an id, and they are built with String.fromCharCode rather than typed
 * as literals so this file stays plain ASCII: a literal \x01 in the source is
 * invisible in a diff, makes grep treat the file as binary, and is one careless
 * edit away from becoming an empty string that silently breaks the delimiting.
 *
 * WHY DEFINITIONS AND SCHEMES ARE SERIALIZED WHOLE. Every other field here is
 * enumerated deliberately, but definitions are not: they are stringified in
 * full, every key, sorted. Enumerating them would mean this file has to be
 * updated every time someone adds a field to CostComponentDefinition that the
 * compiler reads — and forgetting is silent. Whole-object serialization is
 * slightly more conservative (a label edit busts the cache) and cannot be
 * forgotten. There are tens of definitions, not thousands.
 *
 * WHAT IS DELIBERATELY ABSENT: the calendar, every amount, rate, seasonality
 * vector and buyout amount. Those feed packPlan, which runs on every edit
 * regardless. If you find yourself adding one, stop and check whether you have
 * actually moved value-dependent work into compileStructure — that, not the
 * key, is the thing to fix.
 *
 * If you add a value-dependent branch to compileStructure, add it here too. The
 * fuzz test in __tests__/repackParity.test.ts is what catches you if you don't.
 */

import type { PlanStructure } from "./compile";
import type { ScenarioInput } from "./types";

/** Between fields of one record. */
const FIELD = String.fromCharCode(1);
/** Between records within a section. */
const RECORD = String.fromCharCode(2);
/** Between sections. */
const SECTION = String.fromCharCode(3);
/** Stands in for an absent optional, distinct from an empty string. */
const ABSENT = String.fromCharCode(4);

/** JSON with object keys sorted at every depth, so two equal objects always
 *  serialize identically whatever order their keys were built in. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/**
 * Everything compileStructure(input) depends on, as a canonical string.
 *
 * Cost is O(definitions + positions + componentValues) — one pass, no per-line
 * work — so it stays small next to the pack it is deciding whether to skip.
 */
export function structureKey(input: ScenarioInput): string {
  const sections: string[] = [];

  // Definitions and schemes: whole, sorted by id so input order cannot matter
  // (topoSort re-sorts them anyway).
  const defs = input.definitions
    .filter((def) => def.deletedAt === null)
    .slice()
    .sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
  sections.push(`D${stable(defs)}`);

  const schemes = input.ssSchemes
    .filter((scheme) => scheme.deletedAt === null)
    .slice()
    .sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
  sections.push(`S${stable(schemes)}`);

  // Positions, in the plan's own canonical order — the id sequence IS the line
  // matrix layout, so both membership and order matter. Per position, only the
  // fields compileStructure reads:
  //   departmentCode / cluster / jobTypeCode  → the interned dimensions
  //   hotelClusterWeight + the three vector lengths → what validate() checks
  const positions = input.positions
    .filter((position) => position.deletedAt === null)
    .slice()
    .sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
  const positionParts = positions.map((position) =>
    [
      position.id as string,
      position.departmentCode,
      position.cluster,
      position.jobTypeCode,
      position.hotelClusterWeight,
      position.seasonality?.length ?? -1,
      position.additionalMonthlyCosts?.length ?? -1,
      position.vacationMonthlyWeights?.length ?? -1,
    ].join(FIELD)
  );
  sections.push(`P${positionParts.join(RECORD)}`);

  // Per-row department / account overrides — the only component-value fields
  // that move an aggregate key. Sorted, because aggKeys' order follows the
  // (position, definition) traversal, never the order values arrive in.
  const overrides: string[] = [];
  for (const value of input.componentValues) {
    if (value.deletedAt !== null) continue;
    if (value.departmentCode === undefined && value.accountCode === undefined) continue;
    overrides.push(
      [
        value.positionId as string,
        value.componentDefId as string,
        value.departmentCode ?? ABSENT,
        value.accountCode ?? ABSENT,
      ].join(FIELD)
    );
  }
  overrides.sort();
  sections.push(`O${overrides.join(RECORD)}`);

  // Buyouts: their dept×account pairs append to aggKeys, in row order.
  const buyoutParts = input.buyouts
    .filter((row) => row.deletedAt === null)
    .map((row) => [row.departmentCode, row.accountCode].join(FIELD));
  sections.push(`B${buyoutParts.join(RECORD)}`);

  return sections.join(SECTION);
}

/**
 * Dev-only: prove a reused structure really is the one a fresh compile would
 * build, and say exactly what diverged if it is not.
 *
 * Returns null when they agree. Deliberately compares the OUTPUT rather than
 * re-deriving the key: a key that misses a field is precisely the bug this is
 * here to catch, so checking the key against itself would prove nothing.
 */
export function describeStructureDrift(
  cached: PlanStructure,
  fresh: PlanStructure
): string | null {
  if (cached.defCount !== fresh.defCount) {
    return `defCount ${cached.defCount} → ${fresh.defCount}`;
  }
  if (cached.positionCount !== fresh.positionCount) {
    return `positionCount ${cached.positionCount} → ${fresh.positionCount}`;
  }
  if (cached.buyoutCount !== fresh.buyoutCount) {
    return `buyoutCount ${cached.buyoutCount} → ${fresh.buyoutCount}`;
  }
  for (let i = 0; i < fresh.componentDefs.length; i++) {
    if ((cached.componentDefs[i]?.id as string) !== (fresh.componentDefs[i].id as string)) {
      return `emission order at ${i}: ${String(cached.componentDefs[i]?.id)} → ${String(
        fresh.componentDefs[i].id
      )}`;
    }
  }
  for (let i = 0; i < fresh.positionIds.length; i++) {
    if ((cached.positionIds[i] as string) !== (fresh.positionIds[i] as string)) {
      return `position order at ${i}: ${String(cached.positionIds[i])} → ${String(
        fresh.positionIds[i]
      )}`;
    }
  }
  if (cached.aggKeys.length !== fresh.aggKeys.length) {
    return `aggKeys length ${cached.aggKeys.length} → ${fresh.aggKeys.length}`;
  }
  for (let i = 0; i < fresh.aggKeys.length; i++) {
    const a = cached.aggKeys[i];
    const b = fresh.aggKeys[i];
    if (a.dept !== b.dept || a.account !== b.account) {
      return `aggKeys[${i}] ${a.dept}|${a.account} → ${b.dept}|${b.account}`;
    }
  }
  if (cached.statKeys.length !== fresh.statKeys.length) {
    return `statKeys length ${cached.statKeys.length} → ${fresh.statKeys.length}`;
  }
  for (let i = 0; i < fresh.statKeys.length; i++) {
    const a = cached.statKeys[i];
    const b = fresh.statKeys[i];
    if (a.cluster !== b.cluster || a.jobTypeCode !== b.jobTypeCode) {
      return `statKeys[${i}] ${a.cluster}|${a.jobTypeCode} → ${b.cluster}|${b.jobTypeCode}`;
    }
  }
  // The one that actually moves money: which aggregate row each line books to.
  for (let i = 0; i < fresh.lineAggRow.length; i++) {
    if (cached.lineAggRow[i] !== fresh.lineAggRow[i]) {
      const p = Math.floor(i / fresh.defCount);
      const di = i % fresh.defCount;
      return `line ${i} (position ${String(fresh.positionIds[p])}, def ${String(
        fresh.componentDefs[di].id
      )}) books to row ${cached.lineAggRow[i]} but should book to ${fresh.lineAggRow[i]}`;
    }
  }
  for (let i = 0; i < fresh.positionStatRow.length; i++) {
    if (cached.positionStatRow[i] !== fresh.positionStatRow[i]) {
      return `positionStatRow[${i}] ${cached.positionStatRow[i]} → ${fresh.positionStatRow[i]}`;
    }
  }
  for (let i = 0; i < fresh.countScaled.length; i++) {
    if (cached.countScaled[i] !== fresh.countScaled[i]) {
      return `countScaled[${i}] ${cached.countScaled[i]} → ${fresh.countScaled[i]}`;
    }
  }
  for (let i = 0; i < fresh.buyoutAggRow.length; i++) {
    if (cached.buyoutAggRow[i] !== fresh.buyoutAggRow[i]) {
      return `buyoutAggRow[${i}] ${cached.buyoutAggRow[i]} → ${fresh.buyoutAggRow[i]}`;
    }
  }
  return null;
}
